import { describe, it, expect, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { startRelay, type RelayHandle } from '../relay/server';
import {
  createHelloFrame,
  helloFrame,
  initClientConn,
  sessionKeyOf,
  type SessionKey,
} from '../lib/relay-protocol';
import {
  type BindingInput,
  type RelayBinding,
  initRelayBinding,
  reduceBinding,
  relayFacts,
  shouldAdoptSnapshot,
} from '../lib/relay-binding';
import {
  initSession,
  dispatch,
  acceptBaton,
  type ConductorSession,
} from '../lib/conductor-session';
import { reduceConductor } from '../lib/conductor-state';
import { compileRoadmap, type CompiledRoadmap } from '../lib/roadmap-vm';

// ── Conductor 3b chunk 4: end-to-end over the REAL relay ─────────────────────
// (doc §10-4 gate). Real sockets on loopback, the real chunk-3 relay, the real
// chunk-3a reducer, and REAL ConductorSessions — a `Device` harness that runs
// the exact feed loop the hook runs (reduceBinding → execute effects → feed
// back outcomes). This is the multi-device convergence proof the pure matrices
// can't give: MD drives + late-join, MD-death failover to a new generation,
// and the §4.4 session switch, each converging bar-for-bar.

function compileOrThrow(ids: string[]): CompiledRoadmap {
  const c = compileRoadmap(ids.map((id) => ({ id })), []);
  if (!c.ok) throw new Error(`compile failed: ${c.error.reason}`);
  return c.compiled;
}

// One shared program hash string per program: every device loads the SAME chart
// from the same show file, so the loader-computed hash is identical by
// construction — a fixed string models that exactly.
const PH_A = 'hash-song-a';
const PH_B = 'hash-song-b';
const songA = () => initSession('chart-a::show', 'song-a', PH_A, compileOrThrow(['a1', 'a2', 'a3', 'a4']), 0);
const songB = () => initSession('chart-b::show', 'song-b', PH_B, compileOrThrow(['b1', 'b2', 'b3']), 0);

// ── The Device harness: the hook's feed loop, verbatim ───────────────────────
class Device {
  binding: RelayBinding = initRelayBinding();
  session: ConductorSession | null = null;
  switches: SessionKey[] = [];
  demotions: number[] = [];
  badFrames = 0;
  private ws: WebSocket | null = null;

  /** The hook's identity-init path: set the local session + feed local-ready.
   *  Mirrors the §4.4 epoch-inherit — a WRITER's fresh session is rebased onto
   *  the relay's grant (conn.epoch) before it is announced. */
  loadChart(session: ConductorSession) {
    this.session =
      this.binding.conn.phase === 'writer'
        ? { ...session, state: { ...session.state, epoch: this.binding.conn.epoch } }
        : session;
    this.feed({ kind: 'local-ready', key: sessionKeyOf(this.session.state) });
  }

  connect(port: number, label: string, room: string): Promise<void> {
    // The hook's (re)connect path: fresh conn machine, the localKey SURVIVES.
    // D4: room == code — the relay minted it at create time (see createRoom).
    this.binding = { conn: initClientConn(), localKey: this.binding.localKey };
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    this.ws = ws;
    ws.on('message', (data) => this.feed({ kind: 'raw-frame', raw: JSON.parse(String(data)) }));
    // The hook's onclose path: back to 'joining' (the self-drive floor opens).
    ws.on('close', () => {
      if (this.ws !== ws) return; // superseded socket
      this.binding = { conn: initClientConn(), localKey: this.binding.localKey };
    });
    return new Promise((res, rej) => {
      ws.on('open', () => {
        ws.send(JSON.stringify(helloFrame(room, room, label)));
        res();
      });
      ws.on('error', rej);
    });
  }

  requestClaim() {
    this.feed({ kind: 'request-claim' });
  }

  /** The hook's run() path: dispatch locally, fan out iff applied. */
  advance(now = Date.now()) {
    if (!this.session) throw new Error('no chart loaded');
    const res = dispatch(this.session, { kind: 'advance' }, now);
    if (res.outcome !== 'applied' || !res.msg) throw new Error(`advance ${res.outcome}`);
    this.session = res.session;
    this.feed({ kind: 'applied-msg', msg: res.msg });
  }

  kill() {
    this.ws?.terminate();
  }
  close() {
    this.ws?.close();
  }

  get facts() {
    return relayFacts(this.binding);
  }
  get state() {
    if (!this.session) throw new Error('no chart loaded');
    return this.session.state;
  }

  /** The hook's queue loop: reduce, execute effects, feed back outcomes. */
  private feed(first: BindingInput) {
    const queue: BindingInput[] = [first];
    while (queue.length > 0) {
      const input = queue.shift()!;
      const r = reduceBinding(this.binding, input);
      this.binding = r.binding;
      for (const eff of r.effects) {
        switch (eff.kind) {
          case 'send':
            this.ws?.send(JSON.stringify(eff.frame));
            break;
          case 'apply-mirror': {
            const s = this.session!; // localKey-gated: session exists
            const out = reduceConductor(s.compiled, s.programHash, s.state, eff.msg);
            if (out.status === 'applied') this.session = { ...s, state: out.state };
            queue.push({ kind: 'mirror-outcome', outcome: out.status });
            break;
          }
          case 'adopt-snapshot': {
            const s = this.session!; // key-gated on localKey
            if (shouldAdoptSnapshot(eff.stale, eff.state, s.state)) {
              this.session = { ...s, state: eff.state };
            }
            break;
          }
          case 'accept-baton': {
            const { session, claim } = acceptBaton(this.session!, eff.epoch, Date.now());
            this.session = session;
            queue.push({
              kind: 'baton-accepted',
              key: sessionKeyOf(session.state),
              state: session.state,
              claim,
            });
            break;
          }
          case 'serve-snapshot':
            queue.push({ kind: 'serve-state', requestId: eff.requestId, state: this.session!.state });
            break;
          case 'switch-session':
            this.switches.push(eff.session);
            break;
          case 'demoted':
            this.demotions.push(eff.epoch);
            break;
          case 'bad-frame':
            this.badFrames++;
            break;
        }
      }
    }
  }
}

// ── Harness ───────────────────────────────────────────────────────────────────
let relays: RelayHandle[] = [];
let devices: Device[] = [];
afterEach(async () => {
  for (const d of devices) d.close();
  devices = [];
  for (const r of relays) await r.close();
  relays = [];
});

async function relay(): Promise<RelayHandle> {
  const h = await startRelay({ port: 0 });
  relays.push(h);
  return h;
}

function device(): Device {
  const d = new Device();
  devices.push(d);
  return d;
}

async function until(what: string, pred: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** D4 create: mint the room out-of-band (a raw setup socket, closed after) and
 *  return the relay-minted code the Devices join. The create-mode client
 *  binding is chunk 2 — this harness stays on the shipped join path. */
function createRoom(port: number): Promise<string> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('error', rej);
    ws.on('open', () => ws.send(JSON.stringify(createHelloFrame('setup', 'graham/gig'))));
    ws.on('message', (data) => {
      const f = JSON.parse(String(data)) as { type: string; room?: string };
      if (f.type === 'joined' && typeof f.room === 'string') {
        ws.close();
        res(f.room);
      } else rej(new Error(`unexpected setup frame: ${f.type}`));
    });
  });
}

/** Connect a device with song A loaded; wait until admitted. */
async function joinWithA(port: number, label: string, room: string): Promise<Device> {
  const d = device();
  d.loadChart(songA());
  await d.connect(port, label, room);
  await until(`${label} admitted`, () => d.facts.phase !== 'joining');
  return d;
}

/** joinWithA + claim the baton; wait until writer. */
async function mdWithA(port: number, room: string): Promise<Device> {
  const md = await joinWithA(port, 'MD', room);
  md.requestClaim();
  await until('MD granted', () => md.facts.phase === 'writer');
  return md;
}

describe('scenario 1: MD drives, a late follower converges (§4.1/§5)', () => {
  it('claim → announce/upload → advance; late join pulls, adopts, then mirrors live', async () => {
    const h = await relay();
    const room = await createRoom(h.port);
    const md = await mdWithA(h.port, room);

    // The grant sequence completed: the MD's session was reborn at the granted
    // epoch (relay-assigned) with seq 0, and it self-drives immediately.
    const grantedEpoch = md.binding.conn.epoch;
    expect(md.state.epoch).toBe(grantedEpoch);
    expect(md.state.seq).toBe(0);
    md.advance(1000); // → a1
    md.advance(1001); // → a2
    expect(md.state.current).toEqual({ barId: 'a2', pass: 1 });

    // Late follower: join → switch-session + pull → relay-served snapshot adopts.
    const f = await joinWithA(h.port, 'guitar', room);
    await until('follower adopts', () => f.state.seq === md.state.seq);
    expect(f.facts.phase).toBe('follower');
    expect(f.facts.chartMismatch).toBe(false);
    expect(f.state.current).toEqual({ barId: 'a2', pass: 1 });
    expect(f.state.epoch).toBe(grantedEpoch);

    // Live deltas now mirror bar-for-bar.
    md.advance(1002); // → a3
    await until('follower mirrors', () => f.state.seq === md.state.seq);
    expect(f.state.current).toEqual({ barId: 'a3', pass: 1 });
    expect(f.badFrames).toBe(0);
  });
});

describe('scenario 2: MD death → failover to a new generation (§4.2)', () => {
  it('orphan → follower claims → epoch+1 rebirth; the OTHER follower re-bases via the claim broadcast', async () => {
    const h = await relay();
    const room = await createRoom(h.port);
    const md = await mdWithA(h.port, room);
    const epoch1 = md.binding.conn.epoch;
    md.advance(1000);
    md.advance(1001); // both followers will converge on a2 first

    const f1 = await joinWithA(h.port, 'keys', room);
    const f2 = await joinWithA(h.port, 'bass', room);
    await until('both converged', () => f1.state.seq === 2 && f2.state.seq === 2);

    // The MD dies mid-song. Relay orphans the baton; honesty + claim affordance.
    md.kill();
    await until('orphan seen', () => f1.facts.conductorLost && f2.facts.conductorLost);
    expect(f1.facts.canClaim).toBe(true);

    // f1 takes the baton: acceptBaton carries its own state forward VERBATIM
    // (freshest mirror) into the new generation — epoch := granted, seq := 0.
    f1.requestClaim();
    await until('f1 is the writer', () => f1.facts.phase === 'writer');
    expect(f1.binding.conn.epoch).toBeGreaterThan(epoch1);
    expect(f1.state.epoch).toBe(f1.binding.conn.epoch);
    expect(f1.state.seq).toBe(0);
    expect(f1.state.current).toEqual({ barId: 'a2', pass: 1 }); // carried forward

    // f2 sees the claim broadcast → future epoch → needsSnapshot → pull → the
    // new MD's claim-time upload re-bases it into the new generation.
    await until('f2 re-based', () => f2.state.epoch === f1.state.epoch);
    expect(f2.state.current).toEqual({ barId: 'a2', pass: 1 });

    // ...and the new generation drives.
    f1.advance(2000); // → a3
    await until('f2 mirrors the new MD', () => f2.state.seq === f1.state.seq);
    expect(f2.state.current).toEqual({ barId: 'a3', pass: 1 });
  });
});

describe('scenario 3: session switch (§4.4)', () => {
  it('writer re-keys to song B (epoch inherited); the follower switches, loads, force re-pulls, converges', async () => {
    const h = await relay();
    const room = await createRoom(h.port);
    const md = await mdWithA(h.port, room);
    md.advance(1000);

    const f = await joinWithA(h.port, 'drums', room);
    await until('follower on song A', () => f.state.seq === md.state.seq);

    // Next song: the MD loads chart B. loadChart mirrors the hook's §4.4
    // epoch-inherit (fresh initSession rebased onto conn.epoch), and the
    // binding re-announces the new key.
    md.loadChart(songB());
    const keyB = sessionKeyOf(md.state);
    expect(md.state.epoch).toBe(md.binding.conn.epoch); // inherited, not 0
    expect(md.state.seq).toBe(0); // per-session restart

    // The follower's room moved: switch surfaced, honest mismatch until the
    // chart loads locally (its pull for B is answered by the live writer via
    // snapshot-needed → serve, but adoption is gated until local-ready).
    await until('follower sees the switch', () => f.switches.some((k) => k.songRef === 'song-b'));
    expect(f.facts.chartMismatch).toBe(true);

    // The follower loads chart B → local-ready ON the active key force
    // re-opens the pull → the writer serves → adopt → converged.
    f.loadChart(songB());
    await until('follower on song B', () => f.state.songRef === 'song-b' && f.state.epoch === md.state.epoch);
    expect(f.facts.chartMismatch).toBe(false);
    expect(sessionKeyOf(f.state)).toEqual(keyB);

    // And song B drives normally in the same generation.
    md.advance(2000); // → b1
    await until('follower mirrors song B', () => f.state.seq === md.state.seq);
    expect(f.state.current).toEqual({ barId: 'b1', pass: 1 });
    expect(f.badFrames).toBe(0);
  });
});

describe('scenario 4: a forked follower reconnects (Codex chunk-4 R1 HIGH)', () => {
  it('offline self-drive past the writer → rejoin pull → FRESH snapshot force-adopts → mirrors live', async () => {
    const h = await relay();
    const room = await createRoom(h.port);
    const md = await mdWithA(h.port, room);
    md.advance(1000); // → a1 (seq 1)

    const f = await joinWithA(h.port, 'cello', room);
    await until('follower converged', () => f.state.seq === 1);

    // Wi-Fi dies for the follower. The self-drive floor deliberately lets it
    // keep playing — it advances on a LOCAL FORK, minting seqs the writer
    // never saw, ending AHEAD of the writer's coordinates.
    f.kill();
    await until('follower offline', () => f.facts.phase === 'joining');
    f.advance(2000);
    f.advance(2001);
    f.advance(2002);
    expect(f.state.seq).toBe(4); // writer is at seq 1
    expect(f.state.current).toEqual({ barId: 'a4', pass: 1 });

    // Reconnect: joined → the mandatory rejoin pull → the LIVE writer's fresh
    // snapshot must win DESPITE lower coordinates (a fork is not freshness) —
    // forward-only here would strand the device with a frozen mirror.
    await f.connect(h.port, 'cello', room);
    await until(
      'fork crushed onto the writer',
      () => f.state.seq === md.state.seq && f.state.current?.barId === 'a1',
    );
    expect(f.state.epoch).toBe(md.state.epoch);

    // ...and the mirror is LIVE again, not silently ignoring deltas.
    md.advance(3000); // → a2
    await until('mirrors after rejoin', () => f.state.current?.barId === 'a2');
    expect(f.badFrames).toBe(0);
  });
});
