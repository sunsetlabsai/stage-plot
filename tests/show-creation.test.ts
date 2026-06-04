import { describe, it, expect } from 'vitest';

// Test the slugify function used in the API route
// Mirrors app/api/shows/route.ts:slugify (no fallback version)
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// Mirrors dashboard slugBase helper
function slugBase(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

describe('slugify (API, no fallback)', () => {
  it('converts normal names', () => {
    expect(slugify('Friday at Roxy')).toBe('friday-at-roxy');
  });

  it('returns empty for punctuation-only', () => {
    expect(slugify('!!!')).toBe('');
  });

  it('returns empty for whitespace-only', () => {
    expect(slugify('   ')).toBe('');
  });

  it('strips leading/trailing hyphens', () => {
    expect(slugify('--hello--')).toBe('hello');
  });

  it('collapses multiple separators', () => {
    expect(slugify('foo   bar---baz')).toBe('foo-bar-baz');
  });

  it('handles unicode by stripping', () => {
    expect(slugify('café night')).toBe('caf-night');
  });
});

describe('slugBase (client, same logic)', () => {
  it('matches slugify behavior', () => {
    expect(slugBase('Friday at Roxy')).toBe('friday-at-roxy');
    expect(slugBase('!!!')).toBe('');
    expect(slugBase('   ')).toBe('');
  });
});

describe('API name validation logic', () => {
  // Simulates the validation flow in POST /api/shows
  function validateName(name: unknown): { ok: boolean; error?: string; trimmed?: string } {
    if (typeof name !== 'string' || !name) {
      return { ok: false, error: 'name must be a non-empty string' };
    }
    const trimmed = name.trim().slice(0, 100);
    if (!trimmed) {
      return { ok: false, error: 'Name is required' };
    }
    const base = slugify(trimmed);
    if (!base) {
      return { ok: false, error: 'Name must contain at least one letter or number' };
    }
    return { ok: true, trimmed };
  }

  it('rejects non-string name', () => {
    expect(validateName(42).ok).toBe(false);
    expect(validateName(null).ok).toBe(false);
    expect(validateName(undefined).ok).toBe(false);
    expect(validateName({}).ok).toBe(false);
  });

  it('rejects empty string', () => {
    expect(validateName('').ok).toBe(false);
  });

  it('rejects whitespace-only', () => {
    expect(validateName('   ').ok).toBe(false);
  });

  it('rejects punctuation-only', () => {
    expect(validateName('!!!').ok).toBe(false);
    expect(validateName('---').ok).toBe(false);
  });

  it('accepts valid names', () => {
    const result = validateName('Friday at Roxy');
    expect(result.ok).toBe(true);
    expect(result.trimmed).toBe('Friday at Roxy');
  });

  it('trims and truncates', () => {
    const long = 'a'.repeat(200);
    const result = validateName(long);
    expect(result.ok).toBe(true);
    expect(result.trimmed?.length).toBe(100);
  });

  it('trims leading/trailing whitespace', () => {
    const result = validateName('  hello  ');
    expect(result.ok).toBe(true);
    expect(result.trimmed).toBe('hello');
  });
});

describe('duplicate config cleaning', () => {
  it('strips charts from setlist items', () => {
    const sourceSetlist = [
      { id: '1', title: 'Song A', key: 'C', lead: 'Graham', charts: [{ url: 'http://old' }] },
      { id: '2', title: 'Song B', key: 'D', lead: 'Rachel' },
    ];

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const cleaned = sourceSetlist.map(({ charts, ...rest }) => rest);

    expect(cleaned[0]).not.toHaveProperty('charts');
    expect(cleaned[0]).toHaveProperty('title', 'Song A');
    expect(cleaned[1]).toHaveProperty('title', 'Song B');
  });
});
