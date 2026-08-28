const BADGE_THRESHOLDS = {
  TRUSTED: 100,
  VERIFIED: 250,
  EXPERT: 500,
  ELITE: 1000,
};

import prisma from '../lib/prisma.js';
import { createModuleLogger } from '../config/logger.js';

const log = createModuleLogger('service.reputation');

// ── Error handling helpers ─────────────────────────────────────────────────────

/**
 * Matches `scheme://user:pass@host` credential segments so they can be
 * stripped from error messages before they ever reach an API response.
 * A Prisma connection failure (e.g. P1001) can otherwise echo the raw
 * DATABASE_URL — including its embedded credentials — straight back to
 * whatever calls this service.
 */
const CREDENTIALS_IN_URL_RE = /(\w+:\/\/)[^\s/@]+:[^\s/@]+@/gi;

/**
 * Strip anything that looks like embedded connection-string credentials
 * from an error message. Falls back to a generic message for non-string
 * input so callers never interpolate `undefined`/`null` into a response.
 *
 * @param {unknown} message
 * @returns {string}
 */
const sanitizeErrorMessage = (message) => {
  if (typeof message !== 'string' || message.length === 0) return 'Unknown error';
  return message.replace(CREDENTIALS_IN_URL_RE, '$1[redacted]@');
};

/**
 * Wrap a low-level failure (typically a Prisma error) in an Error that
 * names the operation and the non-sensitive identifiers involved, so the
 * caller sees something actionable instead of a generic "Internal error".
 * The full original error is always logged server-side for debugging;
 * only the sanitized message is exposed on the thrown Error.
 *
 * @param {string} operation - name of the service function that failed
 * @param {Record<string, unknown>} context - non-sensitive identifiers (address, escrowId, ...)
 * @param {unknown} err - the original error
 * @returns {Error}
 */
const wrapServiceError = (operation, context, err) => {
  log.error({ err, operation, context }, `${operation} failed`);
  const safeMessage = sanitizeErrorMessage(err?.message);
  const contextStr = Object.entries(context || {})
    .map(([key, val]) => `${key}=${val}`)
    .join(', ');
  const suffix = contextStr ? ` (${contextStr})` : '';
  return new Error(`${operation} failed${suffix}: ${safeMessage}`);
};

// ── Read Operations ──────────────────────────────────────────────────────────

const getReputationByAddress = async (address) => {
  try {
    const record = await prisma.reputationRecord.findUnique({
      where: { address },
    });
    return record || null;
  } catch (err) {
    throw wrapServiceError('getReputationByAddress', { address }, err);
  }
};

const getBadge = (score) => {
  const s = Number(score);
  if (s >= BADGE_THRESHOLDS.ELITE) return 'ELITE';
  if (s >= BADGE_THRESHOLDS.EXPERT) return 'EXPERT';
  if (s >= BADGE_THRESHOLDS.VERIFIED) return 'VERIFIED';
  if (s >= BADGE_THRESHOLDS.TRUSTED) return 'TRUSTED';
  return 'NEW';
};

const computeCompletionRate = (completed, disputed) => {
  const total = Number(completed) + Number(disputed);
  return total === 0 ? 0 : (Number(completed) / total) * 100;
};

const getLeaderboard = async (limit = 20, page = 1) => {
  try {
    const skip = (page - 1) * limit;
    return await prisma.reputationRecord.findMany({
      orderBy: { totalScore: 'desc' },
      take: limit,
      skip,
    });
  } catch (err) {
    throw wrapServiceError('getLeaderboard', { limit, page }, err);
  }
};

const getPercentileRank = async (address) => {
  try {
    const result = await prisma.$queryRaw`
      WITH Ranked AS (
        SELECT address, PERCENT_RANK() OVER (ORDER BY total_score ASC) as rank
        FROM reputation_records
      )
      SELECT rank FROM Ranked WHERE address = ${address}
    `;
    if (result.length > 0) {
      return Math.round(Number(result[0].rank) * 100);
    }
    return 0;
  } catch (err) {
    throw wrapServiceError('getPercentileRank', { address }, err);
  }
};

// ── Write Operations ────────────────────────────────────────────────────────

/**
 * Record escrow completion and update reputation.
 *
 * @param {string} address - Stellar address
 * @param {'client'|'freelancer'} role - Address role in escrow
 * @param {BigInt} escrowId - Escrow ID for idempotency
 * @param {string} tenantId - Tenant context
 */
const recordEscrowCompletion = async (address, role, escrowId, tenantId) => {
  try {
    // Score delta: +10 for freelancer, +5 for client
    const scoreDelta = role === 'freelancer' ? 10 : 5;

    // Upsert reputation event (idempotent on address, eventType, escrowId)
    await prisma.reputationEvent.upsert({
      where: {
        address_eventType_escrowId: {
          address,
          eventType: 'ESCROW_COMPLETED',
          escrowId,
        },
      },
      create: {
        address,
        eventType: 'ESCROW_COMPLETED',
        escrowId,
        scoreDelta,
        tenantId,
      },
      update: {}, // No-op on conflict (already recorded)
    });

    // Atomically increment completedEscrows and totalScore
    await prisma.reputationRecord.update({
      where: { address },
      data: {
        completedEscrows: { increment: 1 },
        totalScore: { increment: scoreDelta },
        lastUpdated: new Date(),
      },
    });
  } catch (err) {
    throw wrapServiceError('recordEscrowCompletion', { address, escrowId, role }, err);
  }
};

/**
 * Record dispute resolution and update reputation.
 *
 * @param {string} address - Stellar address
 * @param {boolean} won - True if dispute won, false if lost
 * @param {BigInt} escrowId - Escrow ID for idempotency
 * @param {string} tenantId - Tenant context
 */
const recordDisputeOutcome = async (address, won, escrowId, tenantId) => {
  try {
    const scoreDelta = won ? 15 : -5;
    const eventType = won ? 'DISPUTE_WON' : 'DISPUTE_LOST';

    // Upsert reputation event (idempotent on address, eventType, escrowId)
    await prisma.reputationEvent.upsert({
      where: {
        address_eventType_escrowId: {
          address,
          eventType,
          escrowId,
        },
      },
      create: {
        address,
        eventType,
        escrowId,
        scoreDelta,
        tenantId,
      },
      update: {}, // No-op on conflict (already recorded)
    });

    // Atomically update: increment/decrement score, track disputesWon
    const data = {
      lastUpdated: new Date(),
    };

    if (won) {
      data.disputesWon = { increment: 1 };
      data.totalScore = { increment: 15 };
    } else {
      // Decrement score, floor at 0
      data.totalScore = { decrement: 5 };
    }

    const updated = await prisma.reputationRecord.update({
      where: { address },
      data,
    });

    // Floor totalScore at 0
    if (updated.totalScore < 0) {
      await prisma.reputationRecord.update({
        where: { address },
        data: { totalScore: 0 },
      });
    }
  } catch (err) {
    throw wrapServiceError('recordDisputeOutcome', { address, escrowId, won }, err);
  }
};

/**
 * Record escrow cancellation and penalty if at fault.
 *
 * @param {string} address - Stellar address
 * @param {boolean} wasAtFault - True if address was at fault for cancellation
 * @param {BigInt} escrowId - Escrow ID for idempotency
 * @param {string} tenantId - Tenant context
 */
const recordEscrowCancellation = async (address, wasAtFault, escrowId, tenantId) => {
  if (!wasAtFault) return;

  try {
    const scoreDelta = -8;

    // Upsert reputation event
    await prisma.reputationEvent.upsert({
      where: {
        address_eventType_escrowId: {
          address,
          eventType: 'CANCELLATION',
          escrowId,
        },
      },
      create: {
        address,
        eventType: 'CANCELLATION',
        escrowId,
        scoreDelta,
        tenantId,
      },
      update: {}, // No-op on conflict
    });

    // Decrement score, floor at 0
    const updated = await prisma.reputationRecord.update({
      where: { address },
      data: {
        totalScore: { decrement: 8 },
        lastUpdated: new Date(),
      },
    });

    if (updated.totalScore < 0) {
      await prisma.reputationRecord.update({
        where: { address },
        data: { totalScore: 0 },
      });
    }
  } catch (err) {
    throw wrapServiceError('recordEscrowCancellation', { address, escrowId, wasAtFault }, err);
  }
};

/**
 * Recalculate all reputation scores from event history.
 * Used for corrections after bugs or audits.
 *
 * @param {string} tenantId - Tenant context (optional, all if not specified)
 */
const recalculateFromEventHistory = async (tenantId) => {
  const where = tenantId ? { tenantId } : {};

  let addresses;
  try {
    // Get all unique addresses with events
    addresses = await prisma.reputationEvent.findMany({
      where,
      distinct: ['address'],
      select: { address: true },
    });
  } catch (err) {
    throw wrapServiceError('recalculateFromEventHistory.listAddresses', { tenantId: tenantId ?? 'all' }, err);
  }

  for (const { address } of addresses) {
    try {
      // Fetch all events for this address, sorted by creation time
      const events = await prisma.reputationEvent.findMany({
        where: { address },
        orderBy: { createdAt: 'asc' },
      });

      // Compute score from scratch
      let totalScore = 0;
      let completedEscrows = 0;
      let disputesWon = 0;

      for (const event of events) {
        totalScore += event.scoreDelta;
        if (event.eventType === 'ESCROW_COMPLETED') completedEscrows += 1;
        if (event.eventType === 'DISPUTE_WON') disputesWon += 1;
      }

      // Floor at 0
      totalScore = Math.max(0, totalScore);

      // Update record
      await prisma.reputationRecord.update({
        where: { address },
        data: {
          totalScore,
          completedEscrows,
          disputesWon,
          lastUpdated: new Date(),
        },
      });
    } catch (err) {
      throw wrapServiceError('recalculateFromEventHistory', { address, tenantId: tenantId ?? 'all' }, err);
    }
  }
};

export {
  BADGE_THRESHOLDS,
  computeCompletionRate,
  getBadge,
  getLeaderboard,
  getPercentileRank,
  getReputationByAddress,
  recordEscrowCompletion,
  recordDisputeOutcome,
  recordEscrowCancellation,
  recalculateFromEventHistory,
  sanitizeErrorMessage,
  wrapServiceError,
};

export default {
  getReputationByAddress,
  getBadge,
  computeCompletionRate,
  getLeaderboard,
  getPercentileRank,
  BADGE_THRESHOLDS,
  recordEscrowCompletion,
  recordDisputeOutcome,
  recordEscrowCancellation,
  recalculateFromEventHistory,
};
