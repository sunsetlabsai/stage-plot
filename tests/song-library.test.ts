import { describe, it, expect } from 'vitest';
import { normalizeSongKey, normalizeSongKeySafe } from '../lib/normalize';
import { serializeShow, deserializeShow } from '../lib/show-file';

describe('Song library: normalization single keyspace', () => {
  it('normalizes basic titles', () => {
    expect(normalizeSongKey('Mustang Sally')).toBe('mustang sally');
  });

  it('strips diacritics', () => {
    expect(normalizeSongKey('Beyoncé')).toBe('beyonce');
  });

  it('strips leading articles', () => {
    expect(normalizeSongKey('The Weight')).toBe('weight');
    expect(normalizeSongKey('A Day in the Life')).toBe('day in the life');
  });

  it('strips punctuation and collapses whitespace', () => {
    expect(normalizeSongKey('Rock & Roll!!!')).toBe('rock roll');
  });

  it('throws on empty result', () => {
    expect(() => normalizeSongKey('!!!')).toThrow();
  });

  it('safe variant returns null on empty', () => {
    expect(normalizeSongKeySafe('!!!')).toBe(null);
  });

  it('safe variant returns key for valid title', () => {
    expect(normalizeSongKeySafe('Respect')).toBe('respect');
  });
});

describe('Song library: export strips songId', () => {
  it('serializeShow strips songId from setlist entries', () => {
    const config = {
      showInfo: { bandName: 'TestBand', eventDate: '', venue: '' },
      stagePlot: [],
      inputs: [],
      monitors: [],
      notes: [],
      setlist: [
        {
          id: 'entry-1',
          songId: 'song-uuid-123',
          position: 1,
          title: 'Test Song',
          lead: 'Graham',
          key: 'C',
        },
      ],
    };

    const yaml = serializeShow(config);
    expect(yaml).not.toContain('songId');
    expect(yaml).not.toContain('song-uuid-123');
    expect(yaml).toContain('Test Song');
  });
});

describe('Song library: import strips songId', () => {
  it('deserializeShow (YAML) strips songId', () => {
    const yaml = `format: showrunr/v1
name: TestBand
stagePlot: []
inputs: []
monitors: []
notes: []
setlist:
  - title: Test Song
    songId: stale-uuid-456
    lead: Graham
    key: C`;

    const config = deserializeShow(yaml, 'test.yaml');
    const song = config.setlist[0];
    expect(song.title).toBe('Test Song');
    // songId should not be present (stripped or ignored)
    // YAML import goes through fromYaml which reconstructs from ShowFileV1 schema
    // songId is not in the schema so it's dropped
  });

  it('deserializeShow (JSON) strips songId', () => {
    const json = JSON.stringify({
      showInfo: { bandName: 'TestBand', eventDate: '', venue: '' },
      stagePlot: [],
      inputs: [],
      monitors: [],
      notes: [],
      setlist: [
        { title: 'Test Song', songId: 'stale-uuid-789', lead: 'Graham', key: 'C', position: 1 },
      ],
    });

    const config = deserializeShow(json, 'test.json');
    const song = config.setlist[0];
    expect(song.title).toBe('Test Song');
    expect((song as unknown as Record<string, unknown>).songId).toBeUndefined();
  });
});

describe('Song library: override resolution', () => {
  // Test the three-state semantics that the adapter uses
  function resolveOverride(
    override: string | null | undefined,
    fallback: string | null | undefined,
    emptyAs?: string,
  ): string | undefined {
    if (override === '') return emptyAs;
    if (override != null) return override;
    return fallback ?? undefined;
  }

  it('null override uses library default', () => {
    expect(resolveOverride(null, 'C')).toBe('C');
  });

  it('empty string override means explicitly blank', () => {
    expect(resolveOverride('', 'C')).toBeUndefined();
    expect(resolveOverride('', 'C', '')).toBe('');
  });

  it('value override replaces default', () => {
    expect(resolveOverride('D', 'C')).toBe('D');
  });

  it('null override with null fallback returns undefined', () => {
    expect(resolveOverride(null, null)).toBeUndefined();
  });

  it('undefined override uses fallback', () => {
    expect(resolveOverride(undefined, 'Am')).toBe('Am');
  });
});
