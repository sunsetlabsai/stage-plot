import { describe, it, expect, beforeEach } from 'vitest';

// We test the pure functions directly — no HTTP layer needed
// The rate limiter uses module-level state, so we re-import each test

describe('admin-rate-limit', () => {
  let checkRateLimit: (ip: string) => boolean;
  let getIp: (request: { headers: { get: (name: string) => string | null } }) => string;
  let authenticate: (request: { headers: { get: (name: string) => string | null } }) => boolean;

  beforeEach(async () => {
    // Fresh import to reset module state
    const mod = await import('../lib/admin-rate-limit');
    checkRateLimit = mod.checkRateLimit;
    getIp = mod.getIp as unknown as typeof getIp;
    authenticate = mod.authenticate as unknown as typeof authenticate;
  });

  describe('checkRateLimit', () => {
    it('allows up to 5 requests per IP', () => {
      for (let i = 0; i < 5; i++) {
        expect(checkRateLimit('1.2.3.4')).toBe(true);
      }
    });

    it('blocks the 6th request', () => {
      for (let i = 0; i < 5; i++) checkRateLimit('1.2.3.4');
      expect(checkRateLimit('1.2.3.4')).toBe(false);
    });

    it('tracks IPs independently', () => {
      for (let i = 0; i < 5; i++) checkRateLimit('1.1.1.1');
      expect(checkRateLimit('1.1.1.1')).toBe(false);
      expect(checkRateLimit('2.2.2.2')).toBe(true);
    });
  });

  describe('getIp', () => {
    it('extracts first IP from x-forwarded-for', () => {
      const req = { headers: { get: (name: string) => name === 'x-forwarded-for' ? '1.2.3.4, 5.6.7.8' : null } };
      expect(getIp(req)).toBe('1.2.3.4');
    });

    it('returns unknown when no header', () => {
      const req = { headers: { get: () => null } };
      expect(getIp(req)).toBe('unknown');
    });
  });

  describe('authenticate', () => {
    const originalEnv = process.env.ADMIN_SECRET;

    it('returns true for matching secret', () => {
      process.env.ADMIN_SECRET = 'test-secret';
      const req = { headers: { get: (name: string) => name === 'authorization' ? 'Bearer test-secret' : null } };
      expect(authenticate(req)).toBe(true);
      process.env.ADMIN_SECRET = originalEnv;
    });

    it('returns false for wrong secret', () => {
      process.env.ADMIN_SECRET = 'test-secret';
      const req = { headers: { get: (name: string) => name === 'authorization' ? 'Bearer wrong' : null } };
      expect(authenticate(req)).toBe(false);
      process.env.ADMIN_SECRET = originalEnv;
    });

    it('returns false when no ADMIN_SECRET set', () => {
      delete process.env.ADMIN_SECRET;
      const req = { headers: { get: (name: string) => name === 'authorization' ? 'Bearer anything' : null } };
      expect(authenticate(req)).toBe(false);
      process.env.ADMIN_SECRET = originalEnv;
    });
  });
});
