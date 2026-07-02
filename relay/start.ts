import { startRelay } from './server';

// The relay box entrypoint (doc §9 Q1: single Node script, `ws` only dep).
//   RELAY_PORT     default 8787 (the wss port the QR encodes, doc §3 D1)
//   RELAY_JOURNAL  default ./relay-journal.json (rule 4 — survive reboots)
//   RELAY_CERT / RELAY_KEY   pre-provisioned cert paths (doc §1a); omit for
//                            plain ws (LAN debugging only — browsers block it)
// Run: npx tsx relay/start.ts   (packaging/provisioning is chunk 6)

const port = Number(process.env.RELAY_PORT ?? 8787);
const journalPath = process.env.RELAY_JOURNAL ?? './relay-journal.json';
const tls =
  process.env.RELAY_CERT && process.env.RELAY_KEY
    ? { certPath: process.env.RELAY_CERT, keyPath: process.env.RELAY_KEY }
    : undefined;

startRelay({ port, journalPath, tls }).then((h) => {
  console.log(`showrunr relay: ${tls ? 'wss' : 'ws (INSECURE — no cert)'} on port ${h.port}, journal ${journalPath}`);
});
