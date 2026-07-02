import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { startRelay, type RelayHandle, type RelayOptions } from '../relay/server';
import {
  type ClientFrame,
  type RelayFrame,
  type SessionKey,
  createHelloFrame,
  initClientConn,
  reduceClientConn,
  canOfferClaim,
} from '../lib/relay-protocol';
import type { ConductorState } from '../lib/conductor-state';

// ── Relay service integration (discovery doc §10-3, amended by
// design-relay-cloud.md §4 D4) ────────────────────────────────────────────────
// Real sockets over loopback — the §7 failure matrix end-to-end. The relay
// never interprets ConductorState/Message, so identity-only stand-ins suffice
// (same trick as relay-protocol.test.ts): the relay's ONLY operations are
// field-wise SessionKey equality and verbatim rebroadcast.
//
// D4 grain: rooms are CREATED by an explicit create-hello (the relay mints the
// code; room == code) and joined by presenting that code. Epochs come off the
// ONE global grant counter (S5), so absolute values here count every create
// seed + grant since relay boot, across all rooms.

const KEY_A: SessionKey = { sessionId: 'show/chart-1', songRef: 'song-1', programHash: 'hash-1' };
const KEY_B: SessionKey = { sessionId: 'show/chart-2', songRef: 'song-2', programHash: 'hash-2' };
const SHOW_REF = 'graham/gig';

function fakeState(key: SessionKey): ConductorState {
  return { ...key, epoch: 1, seq: 0 } as unknown as ConductorState;
}
function fakeMsg(key: SessionKey) {
  return { ...key, epoch: 1, seq: 1, sentAt: 0, payload: { kind: 'advance' } };
}

// ── Test client ───────────────────────────────────────────────────────────────
class Client {
  private queue: RelayFrame[] = [];
  private waiters: Array<(f: RelayFrame) => void> = [];
  closed: Promise<number>;

  private constructor(private ws: WebSocket) {
    this.closed = new Promise((res) => ws.on('close', (code) => res(code)));
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as RelayFrame;
      const w = this.waiters.shift();
      if (w) w(frame);
      else this.queue.push(frame);
    });
  }

  static connect(port: number): Promise<Client> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const c = new Client(ws);
    return new Promise((res, rej) => {
      ws.on('open', () => res(c));
      ws.on('error', rej);
    });
  }

  send(frame: ClientFrame) {
    this.ws.send(JSON.stringify(frame));
  }

  // Next frame in arrival order (relay ordering is part of the contract).
  next(timeoutMs = 2000): Promise<RelayFrame> {
    const q = this.queue.shift();
    if (q) return Promise.resolve(q);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('timed out waiting for a frame')), timeoutMs);
      this.waiters.push((f) => {
        clearTimeout(t);
        res(f);
      });
    });
  }

  // Assert NOTHING arrives for `ms` (e.g. "the writer never receives it").
  async quiet(ms = 150): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
    expect(this.queue).toEqual([]);
  }

  kill() {
    this.ws.terminate(); // abrupt death (no close handshake still fires 'close' server-side)
  }
  close() {
    this.ws.close();
  }
}

// ── Harness ───────────────────────────────────────────────────────────────────
let relays: RelayHandle[] = [];
afterEach(async () => {
  for (const r of relays) await r.close();
  relays = [];
});

// Deterministic mint per relay instance: ROOM01, ROOM02, ... (the reducer
// re-rolls collisions, so a strictly-increasing mint is collision-free).
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

const HELLO = (room: string, code = room, label = 'dev'): ClientFrame => ({
  type: 'hello', intent: 'join', room, code, deviceLabel: label,
});

// D4 create: the relay mints the code; the QR renders from the response.
async function create(port: number, label = 'dev', showRef = SHOW_REF): Promise<{ c: Client; room: string }> {
  const c = await Client.connect(port);
  c.send(createHelloFrame(label, showRef));
  const f = await c.next();
  expect(f.type).toBe('joined');
  return { c, room: (f as { room: string }).room };
}

async function join(port: number, room: string, code = room, label = 'dev'): Promise<Client> {
  const c = await Client.connect(port);
  c.send(HELLO(room, code, label));
  const f = await c.next();
  expect(f.type).toBe('joined');
  return c;
}

// A creator-writer: room minted, claim granted, session announced, snapshot
// uploaded (§4.1). Counter: create = 1, grant = 2 (on a fresh relay).
async function writerFor(port: number, key = KEY_A): Promise<{ md: Client; room: string; epoch: number }> {
  const { c: md, room } = await create(port);
  md.send({ type: 'claim-request' });
  const grant = await md.next();
  expect(grant.type).toBe('claim-grant');
  md.send({ type: 'session', session: key });
  md.send({ type: 'snapshot', state: fakeState(key) });
  return { md, room, epoch: (grant as { epoch: number }).epoch };
}

// ── The door: create / join (cloud doc §4 D4) ─────────────────────────────────
describe('create/join (D4)', () => {
  it('create mints the room: joined { created, room, showRef } with the counter-seeded epoch', async () => {
    const h = await relay();
    const c = await Client.connect(h.port);
    c.send(createHelloFrame('dev', SHOW_REF));
    expect(await c.next()).toEqual({
      type: 'joined',
      epoch: 1, // ++grantCounter seeds the room (S5)
      hasWriter: false,
      activeSession: null,
      writerLabel: null,
      created: true,
      room: 'ROOM01',
      showRef: SHOW_REF,
    });
  });

  it('the minted code admits a joiner; an unknown room bounces no-room (4004) — a typo can never create a phantom room', async () => {
    const h = await relay();
    const { room } = await create(h.port);
    const ok = await Client.connect(h.port);
    ok.send(HELLO(room));
    const joined = await ok.next();
    expect(joined).toMatchObject({ type: 'joined', created: false, room, showRef: SHOW_REF });
    // the typo'd code: bounced honestly, and no room was minted for it
    const typo = await Client.connect(h.port);
    typo.send(HELLO('ZZZZZZ'));
    expect(await typo.closed).toBe(4004);
    const probe = await Client.connect(h.port);
    probe.send(HELLO('ZZZZZZ'));
    expect(await probe.closed).toBe(4004); // still no phantom room
  });

  it('a room/code mismatch on an EXISTING room is bounced 4001 (room == code)', async () => {
    const h = await relay();
    const { room } = await create(h.port);
    const bad = await Client.connect(h.port);
    bad.send(HELLO(room, 'STALE1')); // last week's QR screenshot
    expect(await bad.closed).toBe(4001);
  });

  it('any frame before admission is bounced (the hello is the one door)', async () => {
    const h = await relay();
    const c = await Client.connect(h.port);
    c.send({ type: 'claim-request' });
    expect(await c.closed).toBe(4001);
  });

  it('a second hello on an admitted connection is bounced (own-sweep: no cross-room double-enrollment)', async () => {
    const h = await relay();
    const { c } = await create(h.port);
    c.send(HELLO('ROOM01'));
    expect(await c.closed).toBe(4001);
  });

  it('malformed hellos close 4002 at the parse boundary: empty join room, intent-less legacy shape, create without showRef', async () => {
    const h = await relay();
    const a = await Client.connect(h.port);
    a.send({ type: 'hello', intent: 'join', room: '', code: 'XYZW', deviceLabel: 'dev' } as ClientFrame);
    expect(await a.closed).toBe(4002);
    const b = await Client.connect(h.port);
    b.send({ type: 'hello', room: 'gig', code: 'XYZW', deviceLabel: 'dev' } as unknown as ClientFrame);
    expect(await b.closed).toBe(4002); // pre-D4 client (version skew) — shipped rule 5
    const c = await Client.connect(h.port);
    c.send({ type: 'hello', intent: 'create', room: '', code: '', deviceLabel: 'dev' } as ClientFrame);
    expect(await c.closed).toBe(4002); // create requires the opaque showRef
  });

  it('non-JSON and shapeless payloads close 4002 (not our client)', async () => {
    const h = await relay();
    const c = await Client.connect(h.port);
    (c as unknown as { ws: { send(d: string): void } }).ws.send('not json');
    expect(await c.closed).toBe(4002);
    const c2 = await Client.connect(h.port);
    c2.send({ notype: true } as unknown as ClientFrame);
    expect(await c2.closed).toBe(4002);
  });

  it('an ADMITTED client sending an unknown type or a fieldless known type closes 4002 and cannot crash the relay (Codex R1 HIGH)', async () => {
    const h = await relay();
    const { md, room } = await writerFor(h.port);
    // unknown type
    const a = await join(h.port, room);
    a.send({ type: 'bogus' } as unknown as ClientFrame);
    expect(await a.closed).toBe(4002);
    // known types missing their required fields — each previously a crash path
    for (const bad of [
      { type: 'session' },                                  // sessionKeyEquals(undefined) deref
      { type: 'snapshot-request' },
      { type: 'msg' },
      { type: 'snapshot' },                                 // sessionKeyOf(undefined) deref
      { type: 'session', session: { sessionId: 1 } },       // non-string key field
      { type: 'snapshot', state: fakeState(KEY_A), requestId: 7 }, // non-string requestId
    ]) {
      const c = await Client.connect(h.port);
      c.send(bad as unknown as ClientFrame);
      expect(await c.closed).toBe(4002);
    }
    // the relay survived it all: the room still works end to end
    const f = await join(h.port, room);
    md.send({ type: 'msg', msg: fakeMsg(KEY_A) as never });
    expect(await f.next()).toEqual({ type: 'msg', msg: fakeMsg(KEY_A) });
  });

  it('late joiner gets the live activeSession + hasWriter + showRef in joined (HIGH-1)', async () => {
    const h = await relay();
    const { room } = await writerFor(h.port);
    const late = await Client.connect(h.port);
    late.send(HELLO(room));
    // §4.3: the late joiner learns WHO is conducting from the relay's own
    // member registry — 'dev' is the writer's hello deviceLabel.
    expect(await late.next()).toEqual({
      type: 'joined',
      epoch: 2, // create = 1, grant = 2
      hasWriter: true,
      activeSession: KEY_A,
      writerLabel: 'dev',
      created: false,
      room,
      showRef: SHOW_REF,
    });
  });
});

// ── Claim arbitration ─────────────────────────────────────────────────────────
describe('claim (doc §4.1)', () => {
  it('grants the next global-counter value on a free baton; a second claim is denied at that epoch (no tie exists)', async () => {
    const h = await relay();
    const { c: a, room } = await create(h.port); // counter → 1
    const b = await join(h.port, room);
    a.send({ type: 'claim-request' });
    expect(await a.next()).toEqual({ type: 'claim-grant', epoch: 2 });
    // §4.3: the grant is announced to everyone EXCEPT the grantee.
    expect(await b.next()).toEqual({ type: 'writer', label: 'dev' });
    b.send({ type: 'claim-request' });
    expect(await b.next()).toEqual({ type: 'claim-denied', epoch: 2 });
  });

  it('release-baton = INSTANT orphan (§4.1-5): conductor-lost to all (incl. the releaser); next claim = a strictly higher epoch, no wait', async () => {
    const h = await relay();
    const { md, room } = await writerFor(h.port); // counter → 2
    const b = await join(h.port, room); // joins after the announce — activeSession came in `joined`
    md.send({ type: 'release-baton' });
    expect(await b.next()).toEqual({ type: 'conductor-lost' }); // followers' hasWriter clears → claim affordance opens
    expect(await md.next()).toEqual({ type: 'conductor-lost' }); // ex-writer's machine fails safe (already demoted locally)
    b.send({ type: 'claim-request' });
    expect(await b.next()).toEqual({ type: 'claim-grant', epoch: 3 });
  });

  it('deliberate handoff is reachable THROUGH the client machine (Codex R1 HIGH-2): release → conductor-lost → canOfferClaim → grant', async () => {
    const h = await relay();
    const { md, room } = await writerFor(h.port);
    const f = await join(h.port, room);
    // Drive the REAL chunk-1 machine with the wire frames this follower saw.
    let conn = initClientConn();
    conn = reduceClientConn(conn, {
      kind: 'frame',
      frame: { type: 'joined', epoch: 2, hasWriter: true, activeSession: KEY_A, writerLabel: 'md' },
    }).conn;
    expect(canOfferClaim(conn)).toBe(false); // a writer exists — affordance closed
    md.send({ type: 'release-baton' });
    const lost = await f.next();
    conn = reduceClientConn(conn, { kind: 'frame', frame: lost }).conn;
    expect(canOfferClaim(conn)).toBe(true); // THE fix: the broadcast opens it
    // the user taps "Take the baton" — send exactly what the machine says to send
    const claim = reduceClientConn(conn, { kind: 'request-claim' });
    const send = claim.effects.find((e) => e.kind === 'send');
    expect(send).toBeDefined();
    f.send((send as { frame: ClientFrame }).frame);
    const grant = await f.next();
    expect(grant).toEqual({ type: 'claim-grant', epoch: 3 });
    conn = reduceClientConn(claim.conn, { kind: 'frame', frame: grant }).conn;
    expect(conn.phase).toBe('writer'); // handoff complete, end to end
  });
});

// ── Writer enforcement (rule 2) ───────────────────────────────────────────────
describe('writer enforcement (doc §2/§4.2)', () => {
  it('writer msg fans out to every OTHER member (no echo to the sender)', async () => {
    const h = await relay();
    const { md, room } = await writerFor(h.port);
    const f1 = await join(h.port, room);
    const f2 = await join(h.port, room);
    md.send({ type: 'msg', msg: fakeMsg(KEY_A) as never });
    expect(await f1.next()).toEqual({ type: 'msg', msg: fakeMsg(KEY_A) });
    expect(await f2.next()).toEqual({ type: 'msg', msg: fakeMsg(KEY_A) });
    await md.quiet();
  });

  it.each(['msg', 'session', 'snapshot'] as const)(
    'a non-writer %s bounces with not-writer { epoch, activeSession } and reaches no follower',
    async (type) => {
      const h = await relay();
      const { md, room } = await writerFor(h.port);
      const zombie = await join(h.port, room);
      const frame: ClientFrame =
        type === 'msg'
          ? { type, msg: fakeMsg(KEY_A) as never }
          : type === 'session'
            ? { type, session: KEY_B }
            : { type, state: fakeState(KEY_B) };
      zombie.send(frame);
      expect(await zombie.next()).toEqual({ type: 'not-writer', epoch: 2, activeSession: KEY_A });
      await md.quiet();
    },
  );
});

// ── Session announce / switch (doc §4.4) ──────────────────────────────────────
describe('session switch (doc §4.4)', () => {
  it('the announce broadcasts verbatim to followers', async () => {
    const h = await relay();
    const { md, room } = await writerFor(h.port); // announced KEY_A pre-join
    const f = await join(h.port, room);
    md.send({ type: 'session', session: KEY_B });
    expect(await f.next()).toEqual({ type: 'session', session: KEY_B });
  });

  it('a switch DROPS the previous key\'s snapshot cache (orphan request for the old key → snapshot-none)', async () => {
    const h = await relay();
    const { md, room } = await writerFor(h.port, KEY_A); // uploads KEY_A snapshot
    const f = await join(h.port, room);
    md.send({ type: 'session', session: KEY_B });
    await f.next(); // session broadcast
    md.kill(); // orphan — no writer, so requests hit the cache path
    expect(await f.next()).toEqual({ type: 'conductor-lost' });
    f.send({ type: 'snapshot-request', session: KEY_A });
    expect(await f.next()).toEqual({ type: 'snapshot-none', session: KEY_A });
  });

  it('a pending forwarded request is answered snapshot-none at the switch (a request never hangs)', async () => {
    const h = await relay();
    const { md, room } = await writerFor(h.port, KEY_A);
    const f = await join(h.port, room);
    f.send({ type: 'snapshot-request', session: KEY_A }); // forwarded to md
    expect((await md.next()).type).toBe('snapshot-needed');
    md.send({ type: 'session', session: KEY_B }); // switch before answering
    expect(await f.next()).toEqual({ type: 'snapshot-none', session: KEY_A });
    expect(await f.next()).toEqual({ type: 'session', session: KEY_B });
  });
});

// ── Snapshot service (doc §5) ─────────────────────────────────────────────────
describe('snapshot service (doc §5 D6)', () => {
  it('live writer + matching key: forward → writer serves → requester gets { stale: false }', async () => {
    const h = await relay();
    const { md, room } = await writerFor(h.port);
    const f = await join(h.port, room);
    const bystander = await join(h.port, room);
    f.send({ type: 'snapshot-request', session: KEY_A });
    const needed = await md.next();
    expect(needed).toMatchObject({ type: 'snapshot-needed', session: KEY_A });
    const requestId = (needed as { requestId: string }).requestId;
    md.send({ type: 'snapshot', requestId, state: fakeState(KEY_A) });
    expect(await f.next()).toEqual({ type: 'snapshot', state: fakeState(KEY_A), stale: false });
    await bystander.quiet(); // point-to-point, not fan-out
  });

  it('live writer + key OFF the active session: snapshot-none IMMEDIATELY, writer never bothered (Codex R3)', async () => {
    const h = await relay();
    const { md, room } = await writerFor(h.port, KEY_A);
    const f = await join(h.port, room);
    f.send({ type: 'snapshot-request', session: KEY_B });
    expect(await f.next()).toEqual({ type: 'snapshot-none', session: KEY_B });
    await md.quiet();
  });

  it('no writer + FULL-key cache match: served { stale: true } (join during orphan, §7)', async () => {
    const h = await relay();
    const { md, room } = await writerFor(h.port, KEY_A); // claim-time upload cached
    md.kill();
    const late = await join(h.port, room);
    late.send({ type: 'snapshot-request', session: KEY_A });
    expect(await late.next()).toEqual({ type: 'snapshot', state: fakeState(KEY_A), stale: true });
  });

  it.each([
    ['sessionId', { ...KEY_A, sessionId: 'other' }],
    ['songRef', { ...KEY_A, songRef: 'other' }],
    ['programHash', { ...KEY_A, programHash: 'other' }],
  ])('stale cache mismatching on %s ALONE → snapshot-none (Codex R2 HIGH: full-triple identity)', async (_field, key) => {
    const h = await relay();
    const { md, room } = await writerFor(h.port, KEY_A);
    md.kill();
    const late = await join(h.port, room);
    late.send({ type: 'snapshot-request', session: key });
    expect(await late.next()).toEqual({ type: 'snapshot-none', session: key });
  });

  it('a request pending when the writer dies is answered from the stale cache — never hangs (§5)', async () => {
    const h = await relay();
    const { md, room } = await writerFor(h.port, KEY_A);
    const f = await join(h.port, room);
    f.send({ type: 'snapshot-request', session: KEY_A });
    expect((await md.next()).type).toBe('snapshot-needed');
    md.kill(); // dies holding the forward
    expect(await f.next()).toEqual({ type: 'conductor-lost' });
    expect(await f.next()).toEqual({ type: 'snapshot', state: fakeState(KEY_A), stale: true });
  });
});

// ── Failover (doc §4.2/§7) ────────────────────────────────────────────────────
describe('failover (doc §4.2)', () => {
  it('writer socket death = INSTANT orphan: conductor-lost to all; join-during-orphan sees hasWriter FALSE, session identity kept', async () => {
    const h = await relay();
    const { md, room } = await writerFor(h.port);
    const f = await join(h.port, room);
    md.kill();
    expect(await f.next()).toEqual({ type: 'conductor-lost' });
    const late = await Client.connect(h.port);
    late.send(HELLO(room));
    // §7 "Join during orphan": no writer, but the session identity survives the
    // orphan (only a reboot resets it) — the joiner can still pull the stale cache.
    expect(await late.next()).toEqual({
      type: 'joined',
      epoch: 2,
      hasWriter: false,
      activeSession: KEY_A,
      writerLabel: null,
      created: false,
      room,
      showRef: SHOW_REF,
    });
  });

  it('lease lapse (no hb) orphans the baton; hb traffic keeps it alive', async () => {
    const h = await relay({ hbMs: 40, hbMiss: 2 }); // lease 80ms, sweep ~50ms
    const { md, room } = await writerFor(h.port);
    const f = await join(h.port, room);
    // keep-alive: heartbeat for ~300ms — no orphan
    for (let i = 0; i < 6; i++) {
      md.send({ type: 'hb' });
      await new Promise((r) => setTimeout(r, 40));
    }
    await f.quiet(20);
    // now go silent (wedged device, socket open) → conductor-lost, incl. to the
    // lapsed writer's OWN connection (§4.2 — the client machine fails safe)
    expect(await f.next(2000)).toEqual({ type: 'conductor-lost' });
    expect(await md.next(2000)).toEqual({ type: 'conductor-lost' });
    // the room recovers: follower re-claims at a strictly higher epoch
    f.send({ type: 'claim-request' });
    expect(await f.next()).toEqual({ type: 'claim-grant', epoch: 3 });
  });
});

// ── Reboot / journal (rule 4 + S5, doc §7 "Relay dies") ───────────────────────
describe('reboot-readmit (journal)', () => {
  it('same code readmits after a clean reboot; the counter is never reused; activeSession restarts null; cache is lost', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'relay-'));
    const journalPath = pathJoin(dir, 'journal.json');
    const h1 = await relay({ journalPath });
    const { room } = await writerFor(h1.port, KEY_A); // create=1, grant=2, session + cache live
    await h1.close(); // graceful = clean journal (no counter slack on reboot)
    relays = [];

    const h2 = await relay({ journalPath });
    // identity persists: same room + same code admit; liveness doesn't:
    // epoch preserved, hasWriter false, activeSession null (Codex R2 MED-1)
    const c = await Client.connect(h2.port);
    c.send(HELLO(room));
    expect(await c.next()).toEqual({
      type: 'joined',
      epoch: 2,
      hasWriter: false,
      activeSession: null,
      writerLabel: null,
      created: false,
      room,
      showRef: SHOW_REF,
    });
    // the cache did not survive (deliberately not journaled)
    c.send({ type: 'snapshot-request', session: KEY_A });
    expect(await c.next()).toEqual({ type: 'snapshot-none', session: KEY_A });
    // counter monotonic across the clean reboot: next grant = 3, not a reissued 1
    c.send({ type: 'claim-request' });
    expect(await c.next()).toEqual({ type: 'claim-grant', epoch: 3 });
    // and a stale code still bounces post-reboot
    const bad = await Client.connect(h2.port);
    bad.send(HELLO(room, 'WRONG1'));
    expect(await bad.closed).toBe(4001);
  });
});

// ── Room isolation ────────────────────────────────────────────────────────────
describe('room isolation (doc §2)', () => {
  it('two rooms on one relay do not collide: fan-out and claims are per-room (epochs interleave off the ONE counter — S5)', async () => {
    const h = await relay();
    const { md } = await writerFor(h.port); // room 1: create=1, grant=2
    const { c: other } = await create(h.port); // room 2: create=3
    md.send({ type: 'msg', msg: fakeMsg(KEY_A) as never });
    await other.quiet(); // no cross-room delivery
    other.send({ type: 'claim-request' });
    // The grant comes off the GLOBAL counter (4 follows room 1's 2 and room
    // 2's create seed 3): ordering within a room is all the reducer needs.
    expect(await other.next()).toEqual({ type: 'claim-grant', epoch: 4 });
  });
});
