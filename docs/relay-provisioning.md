# Relay provisioning — at-home checklist

> Conductor 3b chunk 6 (design-conductor-3b §1a, §10-6). How a band gets the
> relay actually runnable at a venue with **no internet**. Everything that
> needs the internet happens **at home**; the venue steps need none.

## Why this dance exists (§1a, locked)

The app is a PWA served over **https**, so browsers refuse plain `ws://`
(mixed content) and refuse self-signed certs. There is no backhaul at the
venue, so no ACME challenge can run there. The locked answer:

1. At home, issue a **real Let's Encrypt cert** for `relay.showrunr.ai`
   using a **DNS-01** challenge (no server needs to be reachable).
2. At the venue, the **band AP's DNS** answers `relay.showrunr.ai` with the
   relay box's LAN IP.
3. Devices open `wss://relay.showrunr.ai:8787` — hostname matches the cert,
   the browser is happy, no internet involved.

Certs last ~90 days, so renewal is a pre-gig checklist item, not a
set-and-forget.

## One-time setup

### 1. The relay box

Any machine that can sit at the venue and run Node (a laptop, a Pi). Clone
the repo and `npm install` on it **at home** — this installs `tsx` (a
declared devDependency), so `npx tsx` below resolves from `node_modules`
and never reaches for the network at the venue. The relay runs with:

```sh
RELAY_CERT=... RELAY_KEY=... npx tsx relay/start.ts
```

Env vars (`relay/start.ts`):

| var | default | meaning |
| --- | --- | --- |
| `RELAY_PORT` | `8787` | wss listen port |
| `RELAY_JOURNAL` | `./relay-journal.json` | baton-epoch journal (survives restarts) |
| `RELAY_CERT` / `RELAY_KEY` | *(unset)* | TLS cert/key paths. Unset = plain `ws://`, LAN debugging only — browsers will NOT connect a PWA to it. |

### 2. First cert issue

```sh
./relay/provision-cert.sh issue
```

Certbot prints a TXT record for `_acme-challenge.relay.showrunr.ai`; add it
at the DNS host for `showrunr.ai`, wait a minute for propagation, continue.
Cert files land under `relay/certs/config/live/relay.showrunr.ai/` and the
script prints the exact `RELAY_CERT`/`RELAY_KEY` export lines.

`relay/certs/` holds private key material — it is git-ignored; never commit it.

### 3. Band AP DNS override

On the band-owned AP/router, configure:

- **Static DHCP lease** for the relay box (so its LAN IP never changes).
- **Local DNS override**: `relay.showrunr.ai` → that LAN IP
  (dnsmasq: `address=/relay.showrunr.ai/192.168.x.x`; most consumer/travel
  routers expose this as "DNS host mapping" or similar).

### 4. App build config

The web app only shows relay UI when it was **built** with
`NEXT_PUBLIC_RELAY_URL` set (e.g. `wss://relay.showrunr.ai:8787`). That's a
build-time env var on the deployment, not a venue step.

## Pre-gig checklist (at home, with internet)

1. **Cert valid through the gig**: `./relay/provision-cert.sh check` —
   exits non-zero if missing or under 30 days. If so, run `issue`.
2. **Every device installs the PWA** and opens the show once while online,
   so the service worker and all charts are cached for offline.
3. **Device labels set**: open Perform, join or go live once — the name you
   enter is remembered per device (used for conductor attribution).
4. **Smoke test on the band AP**: power the AP + relay box, join a phone to
   the AP, confirm `relay.showrunr.ai` resolves to the box
   (`ping relay.showrunr.ai`), start the relay, go live on one device, scan
   the QR from another, confirm it mirrors.

## At the venue (no internet needed)

1. Power the band AP and the relay box; join all devices to the AP.
2. On the box:

   ```sh
   export RELAY_CERT=".../relay/certs/config/live/relay.showrunr.ai/fullchain.pem"
   export RELAY_KEY=".../relay/certs/config/live/relay.showrunr.ai/privkey.pem"
   npx tsx relay/start.ts
   ```

3. MD opens the show (already cached offline), taps **Conduct** → **Go live**,
   and shows the QR / 4-char room code to the band.
4. Everyone else scans the QR (or taps **Join** and types the code + their
   name). Done — one writer, everyone mirrors.

## Troubleshooting

| symptom | cause | fix |
| --- | --- | --- |
| Devices stuck on "Joining the room…" | DNS override missing, or relay not running, or cert expired (browser silently refuses wss) | `ping relay.showrunr.ai` from a phone browser won't tell you much — check the AP's DNS mapping, check the relay process is up, run `provision-cert.sh check` |
| Relay logs close code `4001` | wrong room or join code | Re-scan the QR shown by the current conductor; a code from an earlier room create is stale |
| Relay logs close code `4002` | malformed frame (version skew between app and relay) | Update the relay box's checkout to match the deployed app |
| "Conductor lost" strip | MD's device left the AP or the app backgrounded long enough to miss heartbeats | MD rejoins, or anyone with the chart taps **Take the baton** |
| Chart-mismatch strip on a follower | that device doesn't have the conductor's chart (or it isn't calibrated) | Sync/calibrate the chart at home next time; the strip names the chart when it can |
| Works over `ws://` locally but not on phones | no TLS = mixed content | Set `RELAY_CERT`/`RELAY_KEY`; plain `ws://` is LAN-debug only |
