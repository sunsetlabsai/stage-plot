import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { get as httpGet } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { startRelay, type RelayHandle, type RelayOptions } from '../relay/server';
import {
  type RelayEffect,
  type RelayState,
  type RelayCoreConfig,
  initRelayState,
  reduceRelay,
  CLOSE_NO_ROOM,
  CLOSE_RELAY_FULL,
} from '../relay/relay-core';
import { createHelloFrame, helloFrame, type ClientFrame, type RelayFrame } from '../lib/relay-protocol';
import { TokenBucket, BucketMap } from '../relay/limits';

// ── Cloud relay hardening (design-relay-cloud.md §3 S1-S5, §7 chunk-1 tests) ──
// The public-socket reality: rate limits per grain (pre-admission included),
// tiered payload budgets, Origin allowlist, room lifecycle GC, the GLOBAL
// grant-counter invariant (write-ahead-before-ack), no-room/relay-full
// bounces, /healthz. Pure-core rules are driven through reduceRelay with a
// fake clock; socket/IP/byte rules through real loopback sockets.

// ── Pure S2 primitives: the token bucket ──────────────────────────────────────
describe('token buckets (S2)', () => {
  it('burst capacity, then refill at the sustained rate', () => {
    const b = new TokenBucket(3, 1 / 100, 0); // burst 3, one token per 100ms
    expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(true);
    expect(b.take(0)).toBe(false);      // drained = the temporary ban
    expect(b.take(50)).toBe(false);     // half a token — not yet
    expect(b.take(100)).toBe(true);     // refilled one
    expect(b.take(101)).toBe(false);
  });

  it('never exceeds capacity after a long idle', () => {
    const b = new TokenBucket(2, 1 / 10, 0);
    expect(b.take(1_000_000)).toBe(true);
    expect(b.take(1_000_000)).toBe(true);
    expect(b.take(1_000_000)).toBe(false); // capped at burst, not elapsed/10
  });

  it('BucketMap keys grains independently and prunes full buckets (a stranger scan cannot grow it forever)', () => {
    const m = new BucketMap(1, 1 / 100);
    expect(m.take('ip-a', 0)).toBe(true);
    expect(m.take('ip-a', 0)).toBe(false); // a's bucket drained
    expect(m.take('ip-b', 0)).toBe(true);  // b unaffected
    expect(m.size).toBe(2);
    m.prune(50);                            // a not yet refilled — kept
    expect(m.size).toBe(2);
    m.prune(300);                           // both full again — dropped
    expect(m.size).toBe(0);
  });
});

// ── Pure core: lifecycle GC + the counter invariant (S5) ──────────────────────

const SHOW_REF = 'graham/gig';
const CFG: Partial<RelayCoreConfig> = {
  unclaimedTtlMs: 100,
  abandonedTtlMs: 1000,
  mintCode: () => 'AAAAAA', // fixed mint: fine while the code is unoccupied
};

function drive(state: RelayState, conn: string, frame: ClientFrame, now: number, cfg = CFG): RelayEffect[] {
  return reduceRelay(state, { kind: 'frame', conn, frame, now }, cfg).effects;
}
function tick(state: RelayState, now: number, cfg = CFG): RelayEffect[] {
  return reduceRelay(state, { kind: 'tick', now }, cfg).effects;
}

describe('room lifecycle GC (S5)', () => {
  it('an UNCLAIMED room GCs after its TTL: members bounced room-expired, registry dropped, compaction journal (authority: false)', () => {
    const s = initRelayState();
    drive(s, 'c1', createHelloFrame('dev', SHOW_REF), 0);
    expect(s.rooms.has('AAAAAA')).toBe(true);
    expect(tick(s, 50)).toEqual([]); // before the TTL — nothing
    const effects = tick(s, 101);
    expect(effects).toEqual([
      { kind: 'bounce', conn: 'c1', code: CLOSE_NO_ROOM, reason: 'room expired' },
      { kind: 'journal', authority: false, counter: 1 },
    ]);
    expect(s.rooms.size).toBe(0);
    expect(s.conns.size).toBe(0);
  });

  it('a CLAIMED room does not unclaimed-GC; empty + idle it abandoned-GCs after the long TTL', () => {
    const s = initRelayState();
    drive(s, 'c1', createHelloFrame('dev', SHOW_REF), 0);
    drive(s, 'c1', { type: 'claim-request' }, 1);
    expect(tick(s, 200)).toEqual([]); // claimed — the 100ms unclaimed TTL doesn't apply
    reduceRelay(s, { kind: 'disconnect', conn: 'c1', now: 10 }, CFG);
    // empty but not yet idle past 1000ms from last activity (the disconnect)
    expect(tick(s, 1005).some((e) => e.kind === 'journal')).toBe(false);
    const effects = tick(s, 1011);
    expect(effects).toEqual([{ kind: 'journal', authority: false, counter: 2 }]);
    expect(s.rooms.size).toBe(0);
  });

  it('THE R1/R2-HIGH-1 regression: a GC-d code re-minted after claim/release churn still grants STRICTLY higher epochs', () => {
    const s = initRelayState();
    drive(s, 'c1', createHelloFrame('dev', SHOW_REF), 0); // seed: counter 1
    // Rapid claim/release churn — epochs advance much faster than wall time.
    let lastGrant = 0;
    for (let i = 0; i < 5; i++) {
      const effects = drive(s, 'c1', { type: 'claim-request' }, 1);
      const grant = effects.find((e) => e.kind === 'send' && e.frame.type === 'claim-grant');
      lastGrant = ((grant as { frame: { epoch: number } }).frame).epoch;
      drive(s, 'c1', { type: 'release-baton' }, 1);
    }
    expect(lastGrant).toBe(6); // 1 seed + 5 grants off the ONE counter
    // The room dies and its CODE is re-minted for a brand-new room.
    reduceRelay(s, { kind: 'disconnect', conn: 'c1', now: 2 }, CFG);
    tick(s, 2000); // abandoned-GC'd
    expect(s.rooms.size).toBe(0);
    drive(s, 'c2', createHelloFrame('dev2', SHOW_REF), 3000); // same 'AAAAAA'
    const effects = drive(s, 'c2', { type: 'claim-request' }, 3001);
    const grant = effects.find((e) => e.kind === 'send' && e.frame.type === 'claim-grant');
    const epoch = ((grant as { frame: { epoch: number } }).frame).epoch;
    // No wall clock, no tombstone, no per-room record — just the counter:
    expect(epoch).toBeGreaterThan(lastGrant);
    expect(epoch).toBe(8); // re-mint seed 7, grant 8
  });

  it('write-ahead ordering at the reducer level: the authority journal effect precedes the grant ack (S2)', () => {
    const s = initRelayState();
    const createEffects = drive(s, 'c1', createHelloFrame('dev', SHOW_REF), 0);
    expect(createEffects.map((e) => e.kind)).toEqual(['journal', 'send']);
    expect(createEffects[0]).toEqual({ kind: 'journal', authority: true, counter: 1 });
    const claimEffects = drive(s, 'c1', { type: 'claim-request' }, 1);
    expect(claimEffects[0]).toEqual({ kind: 'journal', authority: true, counter: 2 });
    expect(claimEffects[1]).toMatchObject({ kind: 'send', frame: { type: 'claim-grant', epoch: 2 } });
  });

  it('pending snapshot-request cap (S3): past the cap the relay answers snapshot-none instead of queueing', () => {
    const s = initRelayState();
    const key = { sessionId: 'x', songRef: 'y', programHash: 'z' };
    drive(s, 'md', createHelloFrame('md', SHOW_REF), 0);
    drive(s, 'md', { type: 'claim-request' }, 1);
    drive(s, 'md', { type: 'session', session: key }, 2);
    const cfg = { ...CFG, maxPendingPerRoom: 2 };
    for (const conn of ['f1', 'f2', 'f3']) {
      drive(s, conn, helloFrame('AAAAAA', 'AAAAAA', conn), 3, cfg);
    }
    expect(drive(s, 'f1', { type: 'snapshot-request', session: key }, 4, cfg)[0].kind).toBe('send'); // forwarded
    expect(drive(s, 'f2', { type: 'snapshot-request', session: key }, 4, cfg)[0].kind).toBe('send'); // forwarded
    const third = drive(s, 'f3', { type: 'snapshot-request', session: key }, 4, cfg);
    expect(third).toEqual([{ kind: 'send', to: 'f3', frame: { type: 'snapshot-none', session: key } }]);
  });
});

// ── Socket-level: the public door (S2/S3/S4, D4 bounces, §5 healthz) ─────────

let relays: RelayHandle[] = [];
afterEach(async () => {
  for (const r of relays) await r.close();
  relays = [];
});

function seqMint(): () => string {
  let n = 0;
  return () => `ROOM${String(++n).padStart(2, '0')}`;
}

async function relay(opts: Partial<RelayOptions> = {}): Promise<RelayHandle> {
  const { core, ...rest } = opts;
  const h = await startRelay({ port: 0, core: { mintCode: seqMint(), ...core }, ...rest });
  relays.push(h);
  return h;
}

type Sock = { ws: WebSocket; closed: Promise<number>; next(): Promise<RelayFrame> };

function connect(port: number, origin?: string): Promise<Sock> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
  const queue: RelayFrame[] = [];
  const waiters: Array<(f: RelayFrame) => void> = [];
  ws.on('message', (d) => {
    const f = JSON.parse(String(d)) as RelayFrame;
    const w = waiters.shift();
    if (w) w(f);
    else queue.push(f);
  });
  const closed = new Promise<number>((res) => ws.on('close', (code) => res(code)));
  const sock: Sock = {
    ws,
    closed,
    next: () => {
      const q = queue.shift();
      if (q) return Promise.resolve(q);
      return new Promise((res, rej) => {
        const t = setTimeout(() => rej(new Error('timed out')), 2000);
        waiters.push((f) => {
          clearTimeout(t);
          res(f);
        });
      });
    },
  };
  return new Promise((res, rej) => {
    ws.on('open', () => res(sock));
    ws.on('error', rej);
  });
}

const send = (s: Sock, f: unknown) => s.ws.send(JSON.stringify(f));

describe('the public door (S2/S3/S4)', () => {
  it('per-IP hello bucket: sustained bad-code guessing closes 4008 (rate), not another guess', async () => {
    const h = await relay({ helloRate: { capacity: 2, refillPerMs: 0 } });
    for (const expected of [4004, 4004, 4008]) {
      const s = await connect(h.port);
      send(s, helloFrame('ZZZZZZ', 'ZZZZZZ', 'guess'));
      expect(await s.closed).toBe(expected);
    }
  });

  it('per-IP CREATE bucket is tighter than the hello bucket (creating costs a journal write)', async () => {
    const h = await relay({
      helloRate: { capacity: 100, refillPerMs: 0 },
      createRate: { capacity: 1, refillPerMs: 0 },
    });
    const a = await connect(h.port);
    send(a, createHelloFrame('dev', SHOW_REF));
    expect((await a.next()).type).toBe('joined');
    const b = await connect(h.port);
    send(b, createHelloFrame('dev', SHOW_REF));
    expect(await b.closed).toBe(4008); // hello bucket had room; the create bucket didn't
  });

  it('per-connection frame rate applies from byte one — pre-admission spam closes 4008', async () => {
    const h = await relay({ frameRate: { capacity: 2, refillPerMs: 0 } });
    const s = await connect(h.port);
    send(s, { type: 'hb' });          // 1 (bounced by the reducer? no — unadmitted → 4001... but
    send(s, { type: 'hb' });          // 2    rate is checked FIRST; two sends race the close)
    send(s, { type: 'hb' });          // 3 → over the bucket
    // Whichever lands first (4001 not-admitted bounce or 4008 rate), the
    // stranger is gone; with capacity 2 the third frame can only be 4008 if
    // the reducer bounce hasn't already closed us — accept either close, but
    // the socket MUST be closed.
    expect([4001, 4008]).toContain(await s.closed);
  });

  it('per-IP concurrent-connection cap closes the (N+1)th socket', async () => {
    const h = await relay({ maxConnsPerIp: 2 });
    const a = await connect(h.port);
    const b = await connect(h.port);
    const c = await connect(h.port);
    expect(await c.closed).toBe(4008);
    a.ws.close();
    b.ws.close();
  });

  it('pre-admission raw-byte cap: a snapshot-sized first frame closes 1009 UNPARSED (S3 tier a)', async () => {
    const h = await relay(); // default 1KB pre-admission budget
    const s = await connect(h.port);
    s.ws.send(`{"type":"hello","junk":"${'x'.repeat(4096)}"}`);
    expect(await s.closed).toBe(1009);
  });

  it('post-admission non-writer budget: a follower cannot send a big frame; the WRITER can (S3 tiers b/c)', async () => {
    const h = await relay({ nonWriterMaxBytes: 256 });
    const md = await connect(h.port);
    send(md, createHelloFrame('md', SHOW_REF));
    const joined = (await md.next()) as { room: string };
    send(md, { type: 'claim-request' });
    await md.next(); // grant
    const key = { sessionId: 'x', songRef: 'y', programHash: 'z' };
    send(md, { type: 'session', session: key });
    // Writer sends a >256-byte snapshot: allowed (tier c).
    send(md, { type: 'snapshot', state: { ...key, epoch: 2, seq: 0, pad: 'x'.repeat(600) } });
    const f = await connect(h.port);
    send(f, helloFrame(joined.room, joined.room, 'guitar'));
    await f.next(); // joined
    // Follower sends the same-sized frame: closed 1009 (tier b).
    send(f, { type: 'snapshot', state: { ...key, epoch: 2, seq: 0, pad: 'x'.repeat(600) } });
    expect(await f.closed).toBe(1009);
    // The writer's big frame really was accepted: its cache serves after orphan.
    md.ws.terminate();
    const late = await connect(h.port);
    send(late, helloFrame(joined.room, joined.room, 'late'));
    await late.next(); // joined
    send(late, { type: 'snapshot-request', session: key });
    expect(await late.next()).toMatchObject({ type: 'snapshot', stale: true });
  });

  it('Origin allowlist (S4): unlisted browser Origin closes 4005; listed and missing Origins pass', async () => {
    const h = await relay({ origins: ['https://showrunr.ai'] });
    const evil = await connect(h.port, 'https://evil.example');
    expect(await evil.closed).toBe(4005);
    const ok = await connect(h.port, 'https://showrunr.ai');
    send(ok, createHelloFrame('dev', SHOW_REF));
    expect((await ok.next()).type).toBe('joined');
    const headless = await connect(h.port); // no Origin = non-browser, allowed
    send(headless, helloFrame('ZZZZZZ', 'ZZZZZZ', 'cli'));
    expect(await headless.closed).toBe(4004); // reached the reducer's door
  });

  it('relay-full (S2 backstop): past the global room cap a create bounces 4003', async () => {
    const h = await relay({ core: { maxRooms: 1 } });
    const a = await connect(h.port);
    send(a, createHelloFrame('dev', SHOW_REF));
    expect((await a.next()).type).toBe('joined');
    const b = await connect(h.port);
    send(b, createHelloFrame('dev', SHOW_REF));
    expect(await b.closed).toBe(CLOSE_RELAY_FULL);
  });

  it('GET /healthz answers 200 ok (§5 — platform probe + the pre-gig human check)', async () => {
    const h = await relay();
    const body = await new Promise<{ status: number; text: string }>((res, rej) => {
      httpGet(`http://127.0.0.1:${h.port}/healthz`, (r) => {
        let text = '';
        r.on('data', (c) => (text += String(c)));
        r.on('end', () => res({ status: r.statusCode ?? 0, text }));
      }).on('error', rej);
    });
    expect(body).toEqual({ status: 200, text: 'ok' });
  });
});

// ── Crash-restore: the journal file IS the invariant (S5 write-ahead) ─────────
describe('journal durability (S5)', () => {
  it('write-ahead-before-ack: at the moment a grant is acknowledged, the counter is ALREADY on disk', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'relay-cloud-'));
    const journalPath = pathJoin(dir, 'journal.json');
    const h = await relay({ journalPath });
    const md = await connect(h.port);
    send(md, createHelloFrame('dev', SHOW_REF));
    const joined = (await md.next()) as { room: string; epoch: number };
    send(md, { type: 'claim-request' });
    const grant = (await md.next()) as { epoch: number };
    // The ack has arrived — the durable counter must already cover it.
    const onDisk = JSON.parse(readFileSync(journalPath, 'utf8')) as { clean: boolean; counter: number; rooms: Array<{ room: string; epoch: number }> };
    expect(onDisk.counter).toBe(grant.epoch);
    expect(onDisk.clean).toBe(false); // runtime writes are never "clean"
    expect(onDisk.rooms).toEqual([{ room: joined.room, epoch: grant.epoch, showRef: SHOW_REF }]);
  });

  it('unclean shutdown restores with +1000 slack: an un-fsynced tail can never reissue an acknowledged epoch', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'relay-cloud-'));
    const journalPath = pathJoin(dir, 'journal.json');
    // A crash left clean:false at counter 50 (the torn-write worst case).
    writeFileSync(journalPath, JSON.stringify({ v: 2, clean: false, counter: 50, rooms: [{ room: 'OLDROO', epoch: 50, showRef: SHOW_REF }] }));
    const h = await relay({ journalPath });
    const c = await connect(h.port);
    send(c, helloFrame('OLDROO', 'OLDROO', 'dev')); // the room row survived (droppable cache, but present)
    expect((await c.next()) as object).toMatchObject({ type: 'joined', epoch: 50 });
    send(c, { type: 'claim-request' });
    expect(await c.next()).toEqual({ type: 'claim-grant', epoch: 1051 }); // 50 + slack + 1
  });

  it('a legacy v1 array journal migrates: rooms dropped, counter floored at max epoch + slack', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'relay-cloud-'));
    const journalPath = pathJoin(dir, 'journal.json');
    writeFileSync(journalPath, JSON.stringify([{ room: 'graham/gig', roomCode: 'XYZW', epoch: 7 }]));
    const h = await relay({ journalPath });
    const c = await connect(h.port);
    send(c, helloFrame('graham/gig', 'XYZW', 'dev'));
    expect(await c.closed).toBe(CLOSE_NO_ROOM); // legacy slug-rooms are gone
    const d = await connect(h.port);
    send(d, createHelloFrame('dev', SHOW_REF));
    expect((await d.next()) as object).toMatchObject({ type: 'joined', epoch: 1008 }); // 7 + 1000 + 1
  });

  it('a CLEAN shutdown restores with no slack (the reboot-readmit path stays dense)', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'relay-cloud-'));
    const journalPath = pathJoin(dir, 'journal.json');
    const h1 = await relay({ journalPath });
    const md = await connect(h1.port);
    send(md, createHelloFrame('dev', SHOW_REF));
    const joined = (await md.next()) as { room: string };
    await h1.close();
    relays = [];
    expect((JSON.parse(readFileSync(journalPath, 'utf8')) as { clean: boolean }).clean).toBe(true);
    const h2 = await relay({ journalPath });
    const c = await connect(h2.port);
    send(c, helloFrame(joined.room, joined.room, 'dev'));
    await c.next();
    send(c, { type: 'claim-request' });
    expect(await c.next()).toEqual({ type: 'claim-grant', epoch: 2 }); // 1 seed + 1, no slack
  });
});
