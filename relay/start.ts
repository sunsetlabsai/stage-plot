import { startRelay } from './server';

// The relay entrypoint (design-relay-cloud.md: cloud-hosted at
// relay.showrunr.ai; the platform terminates TLS on 443 and forwards here).
//   RELAY_PORT         default 8787 (the platform's internal port)
//   RELAY_JOURNAL      default ./relay-journal.json (S5 — the global grant
//                      counter must live on a persistent volume)
//   RELAY_ORIGINS      comma-separated Origin allowlist (S4);
//                      default https://showrunr.ai. Empty string = allow all
//                      (local dev only).
//   RELAY_TRUST_PROXY  "1" behind the platform proxy (fly-client-ip /
//                      x-forwarded-for become the rate-limit grain). NEVER on
//                      a direct listener.
//   RELAY_CERT / RELAY_KEY  local-dev wss only; omit in cloud (platform TLS)
//                           — plain ws behind the proxy.
// Run: npx tsx relay/start.ts

const port = Number(process.env.RELAY_PORT ?? 8787);
const journalPath = process.env.RELAY_JOURNAL ?? './relay-journal.json';
const tls =
  process.env.RELAY_CERT && process.env.RELAY_KEY
    ? { certPath: process.env.RELAY_CERT, keyPath: process.env.RELAY_KEY }
    : undefined;
const origins = (process.env.RELAY_ORIGINS ?? 'https://showrunr.ai')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s !== '');
const trustProxy = process.env.RELAY_TRUST_PROXY === '1';

startRelay({ port, journalPath, tls, origins, trustProxy }).then((h) => {
  console.log(
    `showrunr relay: ${tls ? 'wss' : 'ws (plain — platform TLS or local dev)'} on port ${h.port}, ` +
      `journal ${journalPath}, origins ${origins.length > 0 ? origins.join(' ') : 'ANY (dev)'}`,
  );
});
