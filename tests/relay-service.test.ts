import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { startRelay, type RelayHandle } from '../relay/server';
import {
  type ClientFrame,
  type RelayFrame,
  type SessionKey,
  initClientConn,
  reduceClientConn,
  canOfferClaim,
} from '../lib/relay-protocol';
import type { ConductorState } from '../lib/conductor-state';

// ── Chunk 3b-3: relay service integration (doc §10-3) ────────────────────────
// Real sockets over loopback — the §7 failure matrix end-to-end. The relay
// never interprets ConductorState/Message, so identity-only stand-ins suffice
// (same trick as relay-protocol.test.ts): the relay's ONLY operations are
// field-wise SessionKey equality and verbatim rebroadcast.

const KEY_A: SessionKey = { sessionId: 'show/chart-1', songRef: 'song-1', programHash: 'hash-1' };
const KEY_B: SessionKey = { sessionId: 'show/chart-2', songRef: 'song-2', programHash: 'hash-2' };

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

async function relay(opts: Partial<Parameters<typeof startRelay>[0]> = {}): Promise<RelayHandle> {
  const h = await startRelay({ port: 0, ...opts });
  relays.push(h);
  return h;
}

const HELLO = (room = 'gig', code = 'XYZW', label = 'dev'): ClientFrame => ({
  type: 'hello', room, code, deviceLabel: label,
});

async function join(port: number, room = 'gig', code = 'XYZW'): Promise<Client> {
  const c = await Client.connect(port);
  c.send(HELLO(room, code));
  const f = await c.next();
  expect(f.type).toBe('joined');
  return c;
}

// A joined writer: claim granted, session announced, snapshot uploaded (§4.1).
async function writerFor(port: number, key = KEY_A): Promise<{ md: Client; epoch: number }> {
  const md = await join(port);
  md.send({ type: 'claim-request' });
  const grant = await md.next();
  expect(grant.type).toBe('claim-grant');
  md.send({ type: 'session', session: key });
  md.send({ type: 'snapshot', state: fakeState(key) });
  return { md, epoch: (grant as { epoch: number }).epoch };
}

// ── Join / the door ───────────────────────────────────────────────────────────
describe('join (doc §3)', () => {
  it('first hello CREATES the room: joined { epoch 0, hasWriter false, activeSession null }', async () => {
    const h = await relay();
    const c = await Client.connect(h.port);
    c.send(HELLO());
    expect(await c.next()).toEqual({ type: 'joined', epoch: 0, hasWriter: false, activeSession: null, writerLabel: null });
  });

  it('right code admits a second device; WRONG code is bounced at the door (close 4001)', async () => {
    const h = await relay();
    await join(h.port);
    const ok = await Client.connect(h.port);
    ok.send(HELLO('gig', 'XYZW'));
    expect((await ok.next()).type).toBe('joined');
    const bad = await Client.connect(h.port);
    bad.send(HELLO('gig', 'STALE')); // last week's QR screenshot (D3)
    expect(await bad.closed).toBe(4001);
  });

  it('any frame before admission is bounced (the code check is the one door)', async () => {
    const h = await relay();
    const c = await Client.connect(h.port);
    c.send({ type: 'claim-request' });
    expect(await c.closed).toBe(4001);
  });

  it('a second hello on an admitted connection is bounced (own-sweep: no cross-room double-enrollment)', async () => {
    const h = await relay();
    const c = await join(h.port);
    c.send(HELLO('other-room', 'ABCD'));
    expect(await c.closed).toBe(4001);
  });

  it('a malformed hello (empty room / missing fields) mints no room — closed 4002 at the parse boundary', async () => {
    const h = await relay();
    const c = await Client.connect(h.port);
    c.send({ type: 'hello', room: '', code: 'XYZW', deviceLabel: 'dev' });
    expect(await c.closed).toBe(4002);
    // the empty name did not become a joinable room
    const probe = await Client.connect(h.port);
    probe.send({ type: 'hello', room: '', code: 'anything', deviceLabel: 'dev' } as ClientFrame);
    expect(await probe.closed).toBe(4002);
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
    const { md } = await writerFor(h.port);
    // unknown type
    const a = await join(h.port);
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
    const f = await join(h.port);
    md.send({ type: 'msg', msg: fakeMsg(KEY_A) as never });
    expect(await f.next()).toEqual({ type: 'msg', msg: fakeMsg(KEY_A) });
  });

  it('late joiner gets the live activeSession + hasWriter in joined (HIGH-1)', async () => {
    const h = await relay();
    await writerFor(h.port);
    const late = await Client.connect(h.port);
    late.send(HELLO());
    // §4.3: the late joiner learns WHO is conducting from the relay's own
    // member registry — 'dev' is the writer's hello deviceLabel.
    expect(await late.next()).toEqual({ type: 'joined', epoch: 1, hasWriter: true, activeSession: KEY_A, writerLabel: 'dev' });
  });
});

// ── Claim arbitration ─────────────────────────────────────────────────────────
describe('claim (doc §4.1)', () => {
  it('grants epoch+1 on a free baton; a second claim is denied at that epoch (no tie exists)', async () => {
    const h = await relay();
    const a = await join(h.port);
    const b = await join(h.port);
    a.send({ type: 'claim-request' });
    expect(await a.next()).toEqual({ type: 'claim-grant', epoch: 1 });
    // §4.3: the grant is announced to everyone EXCEPT the grantee.
    expect(await b.next()).toEqual({ type: 'writer', label: 'dev' });
    b.send({ type: 'claim-request' });
    expect(await b.next()).toEqual({ type: 'claim-denied', epoch: 1 });
  });

  it('release-baton = INSTANT orphan (§4.1-5): conductor-lost to all (incl. the releaser); next claim = epoch+1, no wait', async () => {
    const h = await relay();
    const { md } = await writerFor(h.port);
    const b = await join(h.port); // joins after the announce — activeSession came in `joined`
    md.send({ type: 'release-baton' });
    expect(await b.next()).toEqual({ type: 'conductor-lost' }); // followers' hasWriter clears → claim affordance opens
    expect(await md.next()).toEqual({ type: 'conductor-lost' }); // ex-writer's machine fails safe (already demoted locally)
    b.send({ type: 'claim-request' });
    expect(await b.next()).toEqual({ type: 'claim-grant', epoch: 2 });
  });

  it('deliberate handoff is reachable THROUGH the client machine (Codex R1 HIGH-2): release → conductor-lost → canOfferClaim → grant', async () => {
    const h = await relay();
    const { md } = await writerFor(h.port);
    const f = await join(h.port);
    // Drive the REAL chunk-1 machine with the wire frames this follower saw.
    let conn = initClientConn();
    conn = reduceClientConn(conn, {
      kind: 'frame',
      frame: { type: 'joined', epoch: 1, hasWriter: true, activeSession: KEY_A, writerLabel: 'md' },
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
    expect(grant).toEqual({ type: 'claim-grant', epoch: 2 });
    conn = reduceClientConn(claim.conn, { kind: 'frame', frame: grant }).conn;
    expect(conn.phase).toBe('writer'); // handoff complete, end to end
  });
});

// ── Writer enforcement (rule 2) ───────────────────────────────────────────────
describe('writer enforcement (doc §2/§4.2)', () => {
  it('writer msg fans out to every OTHER member (no echo to the sender)', async () => {
    const h = await relay();
    const { md } = await writerFor(h.port);
    const f1 = await join(h.port);
    const f2 = await join(h.port);
    md.send({ type: 'msg', msg: fakeMsg(KEY_A) as never });
    expect(await f1.next()).toEqual({ type: 'msg', msg: fakeMsg(KEY_A) });
    expect(await f2.next()).toEqual({ type: 'msg', msg: fakeMsg(KEY_A) });
    await md.quiet();
  });

  it.each(['msg', 'session', 'snapshot'] as const)(
    'a non-writer %s bounces with not-writer { epoch, activeSession } and reaches no follower',
    async (type) => {
      const h = await relay();
      const { md } = await writerFor(h.port);
      const zombie = await join(h.port);
      const frame: ClientFrame =
        type === 'msg'
          ? { type, msg: fakeMsg(KEY_A) as never }
          : type === 'session'
            ? { type, session: KEY_B }
            : { type, state: fakeState(KEY_B) };
      zombie.send(frame);
      expect(await zombie.next()).toEqual({ type: 'not-writer', epoch: 1, activeSession: KEY_A });
      await md.quiet();
    },
  );
});

// ── Session announce / switch (doc §4.4) ──────────────────────────────────────
describe('session switch (doc §4.4)', () => {
  it('the announce broadcasts verbatim to followers', async () => {
    const h = await relay();
    const { md } = await writerFor(h.port); // announced KEY_A pre-join
    const f = await join(h.port);
    md.send({ type: 'session', session: KEY_B });
    expect(await f.next()).toEqual({ type: 'session', session: KEY_B });
  });

  it('a switch DROPS the previous key\'s snapshot cache (orphan request for the old key → snapshot-none)', async () => {
    const h = await relay();
    const { md } = await writerFor(h.port, KEY_A); // uploads KEY_A snapshot
    const f = await join(h.port);
    md.send({ type: 'session', session: KEY_B });
    await f.next(); // session broadcast
    md.kill(); // orphan — no writer, so requests hit the cache path
    expect(await f.next()).toEqual({ type: 'conductor-lost' });
    f.send({ type: 'snapshot-request', session: KEY_A });
    expect(await f.next()).toEqual({ type: 'snapshot-none', session: KEY_A });
  });

  it('a pending forwarded request is answered snapshot-none at the switch (a request never hangs)', async () => {
    const h = await relay();
    const { md } = await writerFor(h.port, KEY_A);
    const f = await join(h.port);
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
    const { md } = await writerFor(h.port);
    const f = await join(h.port);
    const bystander = await join(h.port);
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
    const { md } = await writerFor(h.port, KEY_A);
    const f = await join(h.port);
    f.send({ type: 'snapshot-request', session: KEY_B });
    expect(await f.next()).toEqual({ type: 'snapshot-none', session: KEY_B });
    await md.quiet();
  });

  it('no writer + FULL-key cache match: served { stale: true } (join during orphan, §7)', async () => {
    const h = await relay();
    const { md } = await writerFor(h.port, KEY_A); // claim-time upload cached
    md.kill();
    const late = await join(h.port);
    late.send({ type: 'snapshot-request', session: KEY_A });
    expect(await late.next()).toEqual({ type: 'snapshot', state: fakeState(KEY_A), stale: true });
  });

  it.each([
    ['sessionId', { ...KEY_A, sessionId: 'other' }],
    ['songRef', { ...KEY_A, songRef: 'other' }],
    ['programHash', { ...KEY_A, programHash: 'other' }],
  ])('stale cache mismatching on %s ALONE → snapshot-none (Codex R2 HIGH: full-triple identity)', async (_field, key) => {
    const h = await relay();
    const { md } = await writerFor(h.port, KEY_A);
    md.kill();
    const late = await join(h.port);
    late.send({ type: 'snapshot-request', session: key });
    expect(await late.next()).toEqual({ type: 'snapshot-none', session: key });
  });

  it('a request pending when the writer dies is answered from the stale cache — never hangs (§5)', async () => {
    const h = await relay();
    const { md } = await writerFor(h.port, KEY_A);
    const f = await join(h.port);
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
    const { md } = await writerFor(h.port);
    const f = await join(h.port);
    md.kill();
    expect(await f.next()).toEqual({ type: 'conductor-lost' });
    const late = await Client.connect(h.port);
    late.send(HELLO());
    // §7 "Join during orphan": no writer, but the session identity survives the
    // orphan (only a reboot resets it) — the joiner can still pull the stale cache.
    expect(await late.next()).toEqual({ type: 'joined', epoch: 1, hasWriter: false, activeSession: KEY_A, writerLabel: null });
  });

  it('lease lapse (no hb) orphans the baton; hb traffic keeps it alive', async () => {
    const h = await relay({ hbMs: 40, hbMiss: 2 }); // lease 80ms, sweep ~50ms
    const { md } = await writerFor(h.port);
    const f = await join(h.port);
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
    // the room recovers: follower re-claims at epoch+1
    f.send({ type: 'claim-request' });
    expect(await f.next()).toEqual({ type: 'claim-grant', epoch: 2 });
  });
});

// ── Reboot / journal (rule 4, doc §7 "Relay box dies") ───────────────────────
describe('reboot-readmit (journal)', () => {
  it('same QR readmits after a reboot; epoch is never reused; activeSession restarts null; cache is lost', async () => {
    const dir = mkdtempSync(pathJoin(tmpdir(), 'relay-'));
    const journalPath = pathJoin(dir, 'journal.json');
    const h1 = await relay({ journalPath });
    await writerFor(h1.port, KEY_A); // room created, epoch 1, session + cache live
    await h1.close();
    relays = [];

    const h2 = await relay({ journalPath });
    // identity persists: same room + same code admit; liveness doesn't:
    // epoch preserved, hasWriter false, activeSession null (Codex R2 MED-1)
    const c = await Client.connect(h2.port);
    c.send(HELLO('gig', 'XYZW'));
    expect(await c.next()).toEqual({ type: 'joined', epoch: 1, hasWriter: false, activeSession: null, writerLabel: null });
    // the cache did not survive (deliberately not journaled)
    c.send({ type: 'snapshot-request', session: KEY_A });
    expect(await c.next()).toEqual({ type: 'snapshot-none', session: KEY_A });
    // epoch monotonic across the reboot: next claim = 2, not a reissued 1
    c.send({ type: 'claim-request' });
    expect(await c.next()).toEqual({ type: 'claim-grant', epoch: 2 });
    // and a stale code still bounces post-reboot
    const bad = await Client.connect(h2.port);
    bad.send(HELLO('gig', 'WRONG'));
    expect(await bad.closed).toBe(4001);
  });
});

// ── Room isolation ────────────────────────────────────────────────────────────
describe('room isolation (doc §2)', () => {
  it('two rooms on one relay do not collide: fan-out, claims, and codes are per-room', async () => {
    const h = await relay();
    const { md } = await writerFor(h.port); // room "gig"
    const other = await join(h.port, 'rehearsal', 'ABCD'); // different room, own code
    md.send({ type: 'msg', msg: fakeMsg(KEY_A) as never });
    await other.quiet(); // no cross-room delivery
    other.send({ type: 'claim-request' });
    expect(await other.next()).toEqual({ type: 'claim-grant', epoch: 1 }); // own epoch line
  });
});
