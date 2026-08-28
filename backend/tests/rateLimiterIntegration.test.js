import { describe, expect, it, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { createPerUserRateLimiter, getUsageStore } from '../api/middleware/rateLimiter.js';

/**
 * Integration test for the rate limiter's happy-path request flow.
 *
 * Unlike backend/tests/rateLimiter.test.js (which unit-tests the sliding
 * window store, burst guard, and adaptive-load logic in isolation), this
 * test drives the real, unmocked middleware through a realistic Express
 * app end-to-end via supertest — black-box only, no reaching into the
 * internal store — the way an actual client's request sequence would
 * exercise it. rateLimiter.js has no external dependencies (no DB, no
 * network), so nothing needs mocking, and the whole flow runs
 * synchronously in-memory, well under the 5-second budget.
 */
function buildApp({ max = 3 } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const userId = req.headers['x-user-id'];
    if (userId) req.user = { id: userId };
    next();
  });
  app.use(createPerUserRateLimiter({ prefix: 'flow', max }));
  app.get('/api/escrows', (_req, res) => res.json({ escrows: [] }));
  app.post('/api/escrows', (_req, res) => res.status(201).json({ id: 'escrow_1' }));
  return app;
}

beforeEach(() => {
  getUsageStore().clear();
});

describe('rate limiter — end-to-end happy-path flow', () => {
  it('allows a user through the full request lifecycle up to their limit, then blocks, via real HTTP requests', async () => {
    const app = buildApp({ max: 3 });

    const first = await request(app).get('/api/escrows').set('x-user-id', 'flow-user-1');
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ escrows: [] });
    expect(first.headers['x-ratelimit-limit']).toBe('3');
    expect(first.headers['x-ratelimit-remaining']).toBe('2');

    const second = await request(app)
      .post('/api/escrows')
      .set('x-user-id', 'flow-user-1')
      .send({ amount: '100' });
    expect(second.status).toBe(201);
    expect(second.headers['x-ratelimit-remaining']).toBe('1');

    const third = await request(app).get('/api/escrows').set('x-user-id', 'flow-user-1');
    expect(third.status).toBe(200);
    expect(third.headers['x-ratelimit-remaining']).toBe('0');

    // Fourth request exceeds the limit — the flow terminates with 429
    const fourth = await request(app).get('/api/escrows').set('x-user-id', 'flow-user-1');
    expect(fourth.status).toBe(429);
    expect(fourth.body.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(fourth.headers['retry-after']).toBeDefined();
  });

  it('does not let one user exhausting their limit affect a different user on the same endpoint', async () => {
    const app = buildApp({ max: 1 });

    await request(app).get('/api/escrows').set('x-user-id', 'flow-user-a').expect(200);
    await request(app).get('/api/escrows').set('x-user-id', 'flow-user-a').expect(429);

    // A different user hitting the exact same route is unaffected
    await request(app).get('/api/escrows').set('x-user-id', 'flow-user-b').expect(200);
  });

  it('completes the full multi-request flow well within the 5-second budget', async () => {
    const app = buildApp({ max: 5 });
    const start = Date.now();

    for (let i = 0; i < 5; i++) {
      await request(app).get('/api/escrows').set('x-user-id', 'flow-user-timing').expect(200);
    }
    await request(app).get('/api/escrows').set('x-user-id', 'flow-user-timing').expect(429);

    expect(Date.now() - start).toBeLessThan(5000);
  });
});
