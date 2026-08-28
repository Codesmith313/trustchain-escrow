import { jest, describe, expect, it, beforeEach } from '@jest/globals';

// ── Mock the Prisma client so we can force specific failures ──────────────────
const mockEventUpsert = jest.fn();
const mockEventFindMany = jest.fn();
const mockRecordUpdate = jest.fn();
const mockRecordFindUnique = jest.fn();
const mockRecordFindMany = jest.fn();

jest.unstable_mockModule('../lib/prisma.js', () => ({
  default: {
    reputationEvent: {
      upsert: (...args) => mockEventUpsert(...args),
      findMany: (...args) => mockEventFindMany(...args),
    },
    reputationRecord: {
      update: (...args) => mockRecordUpdate(...args),
      findUnique: (...args) => mockRecordFindUnique(...args),
      findMany: (...args) => mockRecordFindMany(...args),
    },
    $queryRaw: jest.fn(),
  },
}));

const {
  BADGE_THRESHOLDS,
  recordEscrowCompletion,
  recordDisputeOutcome,
  recordEscrowCancellation,
  recalculateFromEventHistory,
  sanitizeErrorMessage,
  wrapServiceError,
} = await import('../services/reputationService.js');

const ADDRESS = 'GA1234567890TESTADDRESS1234567890TESTADDRESS1234567';
const ESCROW_ID = 42n;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('BADGE_THRESHOLDS', () => {
  it('has the expected tier values', () => {
    expect(BADGE_THRESHOLDS.TRUSTED).toBe(100);
    expect(BADGE_THRESHOLDS.VERIFIED).toBe(250);
    expect(BADGE_THRESHOLDS.EXPERT).toBe(500);
    expect(BADGE_THRESHOLDS.ELITE).toBe(1000);
  });
});

describe('sanitizeErrorMessage', () => {
  it('redacts a connection string embedded in an error message', () => {
    const raw = "Can't reach database server at `postgres://dbuser:s3cr3t@db.internal:5432/app`";
    const sanitized = sanitizeErrorMessage(raw);
    expect(sanitized).not.toContain('s3cr3t');
    expect(sanitized).not.toContain('dbuser');
    expect(sanitized).toContain('[redacted]');
  });

  it('returns the original message when there is nothing to redact', () => {
    expect(sanitizeErrorMessage('Record not found')).toBe('Record not found');
  });

  it('falls back to a generic message for non-string input', () => {
    expect(sanitizeErrorMessage(undefined)).toBe('Unknown error');
  });
});

describe('wrapServiceError', () => {
  it('produces a message naming the operation and context', () => {
    const wrapped = wrapServiceError(
      'recordEscrowCompletion',
      { address: ADDRESS, escrowId: '42' },
      new Error('Record not found'),
    );
    expect(wrapped.message).toContain('recordEscrowCompletion');
    expect(wrapped.message).toContain(ADDRESS);
    expect(wrapped.message).toContain('Record not found');
  });

  it('redacts sensitive substrings from the underlying error', () => {
    const raw = new Error('connect ECONNREFUSED postgres://dbuser:s3cr3t@db.internal:5432/app');
    const wrapped = wrapServiceError('recordEscrowCompletion', { address: ADDRESS }, raw);
    expect(wrapped.message).not.toContain('s3cr3t');
  });
});

describe('recordEscrowCompletion — error handling', () => {
  it('resolves normally on the happy path (no behavior change)', async () => {
    mockEventUpsert.mockResolvedValue({});
    mockRecordUpdate.mockResolvedValue({ totalScore: 10 });
    await expect(
      recordEscrowCompletion(ADDRESS, 'freelancer', ESCROW_ID, 'tenant_1'),
    ).resolves.toBeUndefined();
  });

  it('throws a contextual error when the Prisma upsert fails', async () => {
    mockEventUpsert.mockRejectedValue(
      new Error('Unique constraint failed on the fields: (`address`,`eventType`,`escrowId`)'),
    );
    await expect(
      recordEscrowCompletion(ADDRESS, 'freelancer', ESCROW_ID, 'tenant_1'),
    ).rejects.toThrow(/recordEscrowCompletion/);
  });

  it('does not leak connection credentials when the database is unreachable', async () => {
    mockEventUpsert.mockRejectedValue(
      new Error("Can't reach database server at `postgres://dbuser:s3cr3t@db.internal:5432/app`"),
    );
    let caught;
    try {
      await recordEscrowCompletion(ADDRESS, 'freelancer', ESCROW_ID, 'tenant_1');
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.message).not.toContain('s3cr3t');
  });
});

describe('recordDisputeOutcome — error handling', () => {
  it('throws a contextual error when the Prisma update fails', async () => {
    mockEventUpsert.mockResolvedValue({});
    mockRecordUpdate.mockRejectedValue(new Error('Record to update not found'));
    await expect(
      recordDisputeOutcome(ADDRESS, true, ESCROW_ID, 'tenant_1'),
    ).rejects.toThrow(/recordDisputeOutcome/);
  });
});

describe('recordEscrowCancellation — error handling', () => {
  it('is a no-op and never touches Prisma when the address was not at fault', async () => {
    await recordEscrowCancellation(ADDRESS, false, ESCROW_ID, 'tenant_1');
    expect(mockEventUpsert).not.toHaveBeenCalled();
    expect(mockRecordUpdate).not.toHaveBeenCalled();
  });

  it('throws a contextual error when the Prisma update fails', async () => {
    mockEventUpsert.mockResolvedValue({});
    mockRecordUpdate.mockRejectedValue(new Error('Record to update not found'));
    await expect(
      recordEscrowCancellation(ADDRESS, true, ESCROW_ID, 'tenant_1'),
    ).rejects.toThrow(/recordEscrowCancellation/);
  });
});

describe('recalculateFromEventHistory — error handling', () => {
  it('throws a contextual error naming the failing address', async () => {
    mockEventFindMany.mockResolvedValueOnce([{ address: ADDRESS }]); // listAddresses
    mockEventFindMany.mockResolvedValueOnce([
      { scoreDelta: 5, eventType: 'ESCROW_COMPLETED', createdAt: new Date() },
    ]); // per-address events
    mockRecordUpdate.mockRejectedValue(new Error('Record to update not found'));
    await expect(recalculateFromEventHistory('tenant_1')).rejects.toThrow(
      /recalculateFromEventHistory/,
    );
  });

  it('throws a contextual error when listing addresses fails', async () => {
    mockEventFindMany.mockRejectedValueOnce(new Error('Connection terminated'));
    await expect(recalculateFromEventHistory('tenant_1')).rejects.toThrow(
      /recalculateFromEventHistory/,
    );
  });
});
