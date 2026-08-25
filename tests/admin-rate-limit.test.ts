import { describe, it, expect } from 'vitest';
import { checkRateLimit, getIp } from '../lib/admin-rate-limit';

// Use unique IPs per test to avoid module-level state leaking between tests.
// The rate limiter Map persists across imports (Vitest caches modules).

let testCounter = 0;
function uniqueIp(prefix: string) {
  return `${prefix}-${++testCounter}-${Date.now()}`;
}

describe('admin-rate-limit', () => {
  describe('checkRateLimit', () => {
    it('allows up to 5 requests per IP', () => {
      const ip = uniqueIp('allow');
      for (let i = 0; i < 5; i++) {
        expect(checkRateLimit(ip)).toBe(true);
      }
    });

    it('blocks the 6th request', () => {
      const ip = uniqueIp('block');
      for (let i = 0; i < 5; i++) {
        expect(checkRateLimit(ip)).toBe(true);
      }
      expect(checkRateLimit(ip)).toBe(false);
    });

    it('uses separate buckets per route', () => {
      const ip = uniqueIp('bucket');
      for (let i = 0; i < 5; i++) checkRateLimit(ip, 'owners');
      expect(checkRateLimit(ip, 'owners')).toBe(false);
      // Same IP, different bucket — still allowed
      expect(checkRateLimit(ip, 'settings')).toBe(true);
    });

    it('tracks IPs independently', () => {
      const ip1 = uniqueIp('indep-a');
      const ip2 = uniqueIp('indep-b');
      for (let i = 0; i < 5; i++) checkRateLimit(ip1);
      expect(checkRateLimit(ip1)).toBe(false);
      expect(checkRateLimit(ip2)).toBe(true);
    });
  });

  describe('getIp', () => {
    it('extracts first IP from x-forwarded-for', () => {
      const req = { headers: { get: (name: string) => name === 'x-forwarded-for' ? '1.2.3.4, 5.6.7.8' : null } };
      expect(getIp(req as never)).toBe('1.2.3.4');
    });

    it('returns unknown when no header', () => {
      const req = { headers: { get: () => null } };
      expect(getIp(req as never)).toBe('unknown');
    });
  });
});
