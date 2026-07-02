import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer, type IncomingMessage } from 'node:http';
import {
  readFileSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  existsSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomInt } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  type RelayEffect,
  type RelayInput,
  type RelayCoreConfig,
  type RelayRestore,
  HB_MS,
  HB_MISS,
  CODE_ALPHABET,
  CODE_LEN,
  initRelayState,
  reduceRelay,
} from './relay-core';
import { parseClientFrame } from '../lib/relay-protocol';
import { BucketMap, TokenBucket, HELLO_RATE, CREATE_RATE, FRAME_RATE, MAX_CONNS_PER_IP } from './limits';

// ── The relay service (the impure binding) ────────────────────────────────────
//
// (design-conductor-3b-discovery-failover.md §2/§9-1; design-relay-cloud.md
// §3/§5.) The tiny Node service: one wss star, journal file, one timer. ALL
// protocol decisions live in the pure core (relay-core.ts) — this file moves
// bytes AND polices the public door (cloud doc §3): rate limits, tiered payload
// budgets, Origin allowlist, `/healthz`. Those are properties of sockets/IPs/
// bytes, which the pure core never sees. `ws` is the single dependency.
//
// TLS: in production the PLATFORM terminates TLS on 443 and forwards here
// (cloud doc D2); `tls` paths remain for local-dev wss and integration tests.
// Without cert paths it serves plain ws.

export interface RelayOptions {
  port: number;                 // 0 = ephemeral (tests read the bound port)
  journalPath?: string;         // omit = in-memory only (no reboot promise)
  tls?: { certPath: string; keyPath: string };
  hbMs?: number;                // lease constants (test-shrinkable)
  hbMiss?: number;
  // Origin allowlist (S4): browsers send Origin; a MISSING Origin is allowed
  // (non-browser client — belt, not crypto). Empty list = allow all (tests).
  origins?: string[];
  // S2/S3 knobs (defaults from limits.ts / relay-core.ts; test-shrinkable):
  helloRate?: { capacity: number; refillPerMs: number };
  createRate?: { capacity: number; refillPerMs: number };
  frameRate?: { capacity: number; refillPerMs: number };
  maxConnsPerIp?: number;
  preAdmissionMaxBytes?: number;   // first-frame raw cap, checked BEFORE parse
  nonWriterMaxBytes?: number;      // admitted non-writer per-frame raw cap
  gcCoalesceMs?: number;           // compaction journal coalesce (S2: GC ONLY)
  // Pure-core lifecycle knobs, passed through:
  core?: Partial<Pick<RelayCoreConfig, 'unclaimedTtlMs' | 'abandonedTtlMs' | 'maxRooms' | 'maxPendingPerRoom' | 'mintCode'>>;
  // Trust proxy-set client-IP headers (fly-client-ip / x-forwarded-for) —
  // ONLY behind the platform proxy; a direct listener must never trust them.
  trustProxy?: boolean;
}

export interface RelayHandle {
  port: number;
  close(): Promise<void>;
}

// Socket-level close codes (the reducer's bounce codes live in relay-core.ts).
const CLOSE_BAD_FRAME = 4002;
const CLOSE_ORIGIN = 4005;
const CLOSE_RATE = 4008;
const CLOSE_TOO_BIG = 1009; // standard "message too big"

// S3 tier defaults (cloud doc §3): pre-admission ~1KB (a stranger can never
// make the relay parse snapshot-sized JSON); non-writer control frames small;
// writer gets the one generous budget via ws maxPayload.
const PRE_ADMISSION_MAX_BYTES = 1024;
const NON_WRITER_MAX_BYTES = 8 * 1024;
const WRITER_MAX_BYTES = 1024 * 1024; // ws maxPayload — the snapshot budget
const GC_COALESCE_MS = 1000;

// S5 defense-in-depth: counter slack added on unclean shutdown / legacy journal
// (covers a torn final write; gaps are free).
const COUNTER_SLACK = 1000;

// Crypto-backed code mint (S1 alphabet). Uniqueness is the reducer's lookup.
function cryptoMintCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LEN; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

// ── Journal v2 (S5) ───────────────────────────────────────────────────────────
// `{v:2, clean, counter, rooms:[{room, epoch, showRef}]}`. `counter` is THE
// integrity datum; rooms are droppable cache. `clean:true` is written only by
// a graceful close — any other state at read time adds COUNTER_SLACK.

type JournalV2 = {
  v: 2;
  clean: boolean;
  counter: number;
  rooms: Array<{ room: string; epoch: number; showRef: string | null }>;
};

function readJournal(path: string | undefined): RelayRestore | undefined {
  if (!path || !existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (Array.isArray(parsed)) {
    // Legacy v1 (local-box era): an array of {room, roomCode, epoch}. Rooms
    // are dropped (room==code doesn't hold for slug-keyed rows — droppable
    // cache anyway); the counter floors at the highest epoch ever issued,
    // plus slack (v1 had no clean flag — treat as unclean).
    let max = 0;
    for (const r of parsed as Array<{ epoch?: number }>) {
      if (typeof r.epoch === 'number' && r.epoch > max) max = r.epoch;
    }
    return { counter: max + COUNTER_SLACK, rooms: [] };
  }
  const j = parsed as JournalV2;
  return {
    counter: j.counter + (j.clean === true ? 0 : COUNTER_SLACK),
    rooms: j.rooms ?? [],
  };
}

// Write-ahead durability (S2/S5, Codex R3 build note): "flushed durable" must
// be REAL — fsync the tmp file before the atomic rename, then fsync the
// directory so the rename itself survives a crash. Small file; sync is fine.
function fsyncWrite(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  try {
    const dfd = openSync(dirname(path), 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Directory fsync is best-effort (not permitted on some platforms); the
    // file itself is already durable.
  }
}

export function startRelay(opts: RelayOptions): Promise<RelayHandle> {
  let state = initRelayState(readJournal(opts.journalPath), Date.now());
  const leaseMs = (opts.hbMs ?? HB_MS) * (opts.hbMiss ?? HB_MISS);
  const coreCfg: Partial<RelayCoreConfig> = {
    leaseMs,
    mintCode: cryptoMintCode,
    ...opts.core,
  };

  const preAdmissionMax = opts.preAdmissionMaxBytes ?? PRE_ADMISSION_MAX_BYTES;
  const nonWriterMax = opts.nonWriterMaxBytes ?? NON_WRITER_MAX_BYTES;
  const gcCoalesceMs = opts.gcCoalesceMs ?? GC_COALESCE_MS;
  const origins = opts.origins ?? [];

  // S2 grains: per-IP hello/create buckets, per-conn frame bucket, per-IP
  // connection counter. Frame buckets die with the socket; IP maps prune.
  const helloRate = opts.helloRate ?? HELLO_RATE;
  const createRate = opts.createRate ?? CREATE_RATE;
  const frameRate = opts.frameRate ?? FRAME_RATE;
  const maxConnsPerIp = opts.maxConnsPerIp ?? MAX_CONNS_PER_IP;
  const helloBuckets = new BucketMap(helloRate.capacity, helloRate.refillPerMs);
  const createBuckets = new BucketMap(createRate.capacity, createRate.refillPerMs);
  const connsPerIp = new Map<string, number>();

  const sockets = new Map<string, WebSocket>();
  let nextConnId = 1;

  function clientIp(req: IncomingMessage): string {
    if (opts.trustProxy) {
      const fly = req.headers['fly-client-ip'];
      if (typeof fly === 'string' && fly !== '') return fly;
      const xff = req.headers['x-forwarded-for'];
      const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
      if (first) return first;
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  // ── Journal execution (S2 write policy) ──
  // authority=true → persist synchronously NOW, before any later effect in the
  // reduction is executed (write-ahead-before-ack: `run` executes effects in
  // order, and the reducer puts the journal effect before the grant's send).
  // authority=false (GC compaction) → coalesce.
  let compactionTimer: ReturnType<typeof setTimeout> | null = null;

  function serializeJournal(clean: boolean): string {
    const rooms: JournalV2['rooms'] = [];
    // Never-claimed rooms are droppable cache and are NOT persisted (Codex
    // chunk-1 MED-1): restore marks every journaled room claimed, so writing
    // unclaimed rooms would let a create-flood survive a restart under the 24h
    // abandoned TTL instead of the 15m unclaimed TTL. The counter (the actual
    // safety invariant) is always persisted; a dropped room's joiner gets 4004
    // and re-creates. Known bounded gap (LOW-2): a claimed room GC'd within
    // the compaction coalesce window before a crash can resurrect on restart —
    // epoch safety unaffected, it just re-expires a TTL later.
    for (const [room, r] of state.rooms) {
      if (r.claimed) rooms.push({ room, epoch: r.epoch, showRef: r.showRef });
    }
    const j: JournalV2 = { v: 2, clean, counter: state.grantCounter, rooms };
    return JSON.stringify(j);
  }

  function persistNow(clean = false): void {
    if (compactionTimer) {
      clearTimeout(compactionTimer);
      compactionTimer = null;
    }
    if (!opts.journalPath) return;
    fsyncWrite(opts.journalPath, serializeJournal(clean));
  }

  function persistCoalesced(): void {
    if (!opts.journalPath || compactionTimer) return;
    compactionTimer = setTimeout(() => {
      compactionTimer = null;
      persistNow();
    }, gcCoalesceMs);
    compactionTimer.unref?.();
  }

  function run(input: RelayInput) {
    const r = reduceRelay(state, input, coreCfg);
    state = r.state;
    for (const e of r.effects) execute(e);
  }

  function execute(e: RelayEffect) {
    switch (e.kind) {
      case 'send': {
        const ws = sockets.get(e.to);
        if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(e.frame));
        return;
      }
      case 'bounce': {
        sockets.get(e.conn)?.close(e.code, e.reason);
        return;
      }
      case 'journal':
        if (e.authority) persistNow();
        else persistCoalesced();
        return;
    }
  }

  const server = opts.tls
    ? createHttpsServer({ cert: readFileSync(opts.tls.certPath), key: readFileSync(opts.tls.keyPath) })
    : createHttpServer();

  // §5: platform liveness probe + the pre-gig human check in a browser.
  server.on('request', (req, res) => {
    if (req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server, maxPayload: WRITER_MAX_BYTES });

  wss.on('connection', (ws, req) => {
    // S4: Origin allowlist. Present-but-unlisted = a drive-by website in a
    // member's browser — close. Missing = non-browser client, allowed.
    const origin = req.headers.origin;
    if (origins.length > 0 && typeof origin === 'string' && !origins.includes(origin)) {
      ws.close(CLOSE_ORIGIN, 'origin not allowed');
      return;
    }

    // S2(d): per-IP concurrent-connection cap.
    const ip = clientIp(req);
    const ipConns = connsPerIp.get(ip) ?? 0;
    if (ipConns >= maxConnsPerIp) {
      ws.close(CLOSE_RATE, 'too many connections');
      return;
    }
    connsPerIp.set(ip, ipConns + 1);

    const conn = String(nextConnId++);
    sockets.set(conn, ws);
    // S2(c): per-connection frame bucket — applies from byte one (pre-admission
    // included), so a stranger can't even spam cheap frames.
    const frames = new TokenBucket(frameRate.capacity, frameRate.refillPerMs, Date.now());

    ws.on('message', (data, isBinary) => {
      const now = Date.now();
      if (!frames.take(now)) {
        ws.close(CLOSE_RATE, 'rate limit');
        return;
      }

      // S3 tiered budgets — raw length BEFORE parse, cheap-first. Tier by
      // admission state (read-only peek at the registry): a stranger's first
      // frame must fit the hello budget; an admitted follower sends only small
      // control frames; only writerConn may use the ws maxPayload headroom.
      const bytes = typeof data === 'string' ? Buffer.byteLength(data) : (data as Buffer).length;
      const roomName = state.conns.get(conn);
      const room = roomName === undefined ? undefined : state.rooms.get(roomName);
      const budget = room === undefined
        ? preAdmissionMax
        : room.writerConn === conn
          ? WRITER_MAX_BYTES
          : nonWriterMax;
      if (isBinary || bytes > budget) {
        ws.close(CLOSE_TOO_BIG, 'payload too large');
        return;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        ws.close(CLOSE_BAD_FRAME, 'bad frame'); // not JSON — not our client
        return;
      }
      // The socket is the trust boundary: full per-type shape validation BEFORE
      // the reducer (unknown types and fieldless known types close, never
      // crash). The pure core trusts its input types.
      const frame = parseClientFrame(raw);
      if (frame === null) {
        ws.close(CLOSE_BAD_FRAME, 'bad frame');
        return;
      }

      // S2(a)/(b): the door buckets. hello per IP; create per IP, tighter
      // (creating costs a journal write, guessing doesn't).
      if (frame.type === 'hello') {
        if (!helloBuckets.take(ip, now)) {
          ws.close(CLOSE_RATE, 'rate limit');
          return;
        }
        if (frame.intent === 'create' && !createBuckets.take(ip, now)) {
          ws.close(CLOSE_RATE, 'rate limit');
          return;
        }
      }

      run({ kind: 'frame', conn, frame, now });
    });

    ws.on('close', () => {
      sockets.delete(conn);
      const n = (connsPerIp.get(ip) ?? 1) - 1;
      if (n <= 0) connsPerIp.delete(ip);
      else connsPerIp.set(ip, n);
      run({ kind: 'disconnect', conn, now: Date.now() });
    });
  });

  // One timer: lease sweep + room GC (pure core) + IP-bucket pruning.
  const sweep = setInterval(() => {
    const now = Date.now();
    run({ kind: 'tick', now });
    helloBuckets.prune(now);
    createBuckets.prune(now);
  }, Math.max(50, (opts.hbMs ?? HB_MS) / 2));
  sweep.unref();

  return new Promise((resolve) => {
    server.listen(opts.port, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
      resolve({
        port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(sweep);
            for (const ws of sockets.values()) ws.terminate();
            // Graceful shutdown = clean journal (no slack on next boot).
            persistNow(true);
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}
