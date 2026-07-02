import { createServer as createHttpsServer } from 'node:https';
import { createServer as createHttpServer } from 'node:http';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { type RelayEffect, type RelayInput, HB_MS, HB_MISS, initRelayState, reduceRelay } from './relay-core';
import { parseClientFrame } from '../lib/relay-protocol';

// ── Conductor authority, chunk 3b-3: the relay service (the impure binding) ──
//
// (design-conductor-3b-discovery-failover.md §2/§9-1). The tiny Node service:
// one wss star, journal file, lease timer. ALL protocol decisions live in the
// pure core (relay-core.ts) — this file only moves bytes: parse JSON → feed
// the reducer → execute effects. `ws` is the single dependency; nothing from
// the app is imported at runtime except the shared pure protocol lib.
//
// TLS: production runs wss with the pre-provisioned cert (doc §1a —
// relay.showrunr.ai via DNS-01 at home; provisioning tooling is chunk 6).
// Without cert paths it serves plain ws — loopback tests and LAN debugging.

export interface RelayOptions {
  port: number;                 // 0 = ephemeral (tests read the bound port)
  journalPath?: string;         // omit = in-memory only (no reboot promise)
  tls?: { certPath: string; keyPath: string };
  hbMs?: number;                // lease constants, doc §9 Q2 (test-shrinkable)
  hbMiss?: number;
}

export interface RelayHandle {
  port: number;
  close(): Promise<void>;
}

type JournalRow = { room: string; roomCode: string; epoch: number };

function readJournal(path: string | undefined): JournalRow[] {
  if (!path || !existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')) as JournalRow[];
}

export function startRelay(opts: RelayOptions): Promise<RelayHandle> {
  const journal = new Map<string, JournalRow>(readJournal(opts.journalPath).map((r) => [r.room, r]));
  let state = initRelayState([...journal.values()]);
  const leaseMs = (opts.hbMs ?? HB_MS) * (opts.hbMiss ?? HB_MISS);

  const sockets = new Map<string, WebSocket>();
  let nextConnId = 1;

  // rule 4: `{room, roomCode, epoch}` to disk — atomic (tmp + rename) so a
  // crash mid-write can't eat the registry. Small (rooms ≈ 1); sync is fine.
  function persistJournal(row: JournalRow) {
    journal.set(row.room, row);
    if (!opts.journalPath) return;
    const tmp = `${opts.journalPath}.tmp`;
    writeFileSync(tmp, JSON.stringify([...journal.values()]));
    renameSync(tmp, opts.journalPath);
  }

  function run(input: RelayInput) {
    const r = reduceRelay(state, input, leaseMs);
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
        // Bounced at the door (doc §3/§7): app-defined close code.
        sockets.get(e.conn)?.close(4001, 'bad room or code');
        return;
      }
      case 'journal':
        persistJournal({ room: e.room, roomCode: e.roomCode, epoch: e.epoch });
        return;
    }
  }

  const server = opts.tls
    ? createHttpsServer({ cert: readFileSync(opts.tls.certPath), key: readFileSync(opts.tls.keyPath) })
    : createHttpServer();
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    const conn = String(nextConnId++);
    sockets.set(conn, ws);
    ws.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        ws.close(4002, 'bad frame'); // not JSON — not our client
        return;
      }
      // The socket is the trust boundary: full per-type shape validation BEFORE
      // the reducer (Codex chunk-3 HIGH — unknown types and fieldless known
      // types must close, never crash). The pure core trusts its input types.
      const frame = parseClientFrame(raw);
      if (frame === null) {
        ws.close(4002, 'bad frame');
        return;
      }
      run({ kind: 'frame', conn, frame, now: Date.now() });
    });
    ws.on('close', () => {
      sockets.delete(conn);
      run({ kind: 'disconnect', conn, now: Date.now() });
    });
  });

  // The lease sweep (doc §4.2): one timer for all rooms.
  const sweep = setInterval(() => run({ kind: 'tick', now: Date.now() }), Math.max(50, (opts.hbMs ?? HB_MS) / 2));
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
            wss.close(() => server.close(() => done()));
          }),
      });
    });
  });
}
