import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  resolveAgentModel,
  resolveKeyMode,
  DEFAULT_AGENT_MODEL,
  BYOA_MODEL_ENV,
  TRYIT_MODEL_ENV,
} from '@/lib/agent-key';

// design-ai-op-contract §8 / Q2 — the agent model becomes a configurable value.
//
// Graham: "We don't WANT to be wed to a single model version." §8 makes that a
// DESIGN criterion, not a preference: the op contract must be drivable by
// whatever model we point at, so the model has to be a value, not a code change.
//
// The property that matters most is NOT "a configured value is used" — it is
// "nothing a misconfiguration can do takes the AI down". A bad model id 404s
// every request, so the fallback is the load-bearing behaviour.

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of [BYOA_MODEL_ENV, TRYIT_MODEL_ENV]) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of [BYOA_MODEL_ENV, TRYIT_MODEL_ENV]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k]!;
  }
});

describe('resolveAgentModel — a configured value wins', () => {
  it('uses the configured model', () => {
    process.env[BYOA_MODEL_ENV] = 'claude-sonnet-5';
    expect(resolveAgentModel(BYOA_MODEL_ENV)).toBe('claude-sonnet-5');
  });

  it('★ accepts a model id of ANY shape — no naming convention is assumed', () => {
    // The distinguishing case for the whole change. A `claude-` prefix check
    // passes every other test here and re-couples us to a naming convention,
    // which is precisely what is being removed. This must keep working the day
    // a model family is named differently.
    process.env[BYOA_MODEL_ENV] = 'some-future-model-9';
    expect(resolveAgentModel(BYOA_MODEL_ENV)).toBe('some-future-model-9');
  });

  it('trims a pasted value', () => {
    process.env[BYOA_MODEL_ENV] = '  claude-opus-4-8\n';
    expect(resolveAgentModel(BYOA_MODEL_ENV)).toBe('claude-opus-4-8');
  });

  it('resolves the two env vars independently', () => {
    process.env[BYOA_MODEL_ENV] = 'model-for-byoa';
    process.env[TRYIT_MODEL_ENV] = 'model-for-tryit';

    expect(resolveAgentModel(BYOA_MODEL_ENV)).toBe('model-for-byoa');
    expect(resolveAgentModel(TRYIT_MODEL_ENV)).toBe('model-for-tryit');
  });
});

describe('★ resolveAgentModel — nothing can take the AI down', () => {
  it('falls back when nothing is configured', () => {
    delete process.env[BYOA_MODEL_ENV];
    expect(resolveAgentModel(BYOA_MODEL_ENV)).toBe(DEFAULT_AGENT_MODEL);
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a value with an inner space', 'claude sonnet 5'],
    ['an over-long string', 'x'.repeat(101)],
  ])('falls back on an unusable value: %s', (_label, value) => {
    // A fat-fingered env var would otherwise 404 every request. Falling back
    // keeps the app serving while the mistake stays visible and fixable.
    process.env[BYOA_MODEL_ENV] = value;
    expect(resolveAgentModel(BYOA_MODEL_ENV)).toBe(DEFAULT_AGENT_MODEL);
  });
});

describe('★ resolveKeyMode — BYOA still consults nothing external', () => {
  it('a caller-supplied key resolves its model with no I/O', async () => {
    // The property an existing test in agent-key.test.ts pins as
    // `expect(redis.getCalls).toBe(0)`. The first cut of this change resolved
    // the model through readAdminConfig and broke it — putting a Redis
    // round-trip, and during an outage a connect timeout, on the one path that
    // exists to work when our infrastructure does not. Asserted here too, from
    // the model's side, so the reason survives next to the thing it constrains.
    process.env[BYOA_MODEL_ENV] = 'claude-opus-4-8';

    const mode = await resolveKeyMode('sk-ant-user-key', '1.2.3.4', { consume: false });

    expect(mode.mode).toBe('byoa');
    expect(mode.mode === 'byoa' && mode.model).toBe('claude-opus-4-8');
  });

  it('and falls back to the default when unset', async () => {
    delete process.env[BYOA_MODEL_ENV];

    const mode = await resolveKeyMode('sk-ant-user-key', '1.2.3.4', { consume: false });

    expect(mode.mode === 'byoa' && mode.model).toBe(DEFAULT_AGENT_MODEL);
  });
});
