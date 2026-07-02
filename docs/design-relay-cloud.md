# Conductor transport — cloud relay as the one deployment (kills the local-box story)

**Status:** v1 — DESIGN-ONLY. Not built. Awaiting Graham review, then Codex.
**Date:** 2026-07-02
**Branch:** `opus/design-relay-cloud`
**Parent:** `design-conductor-authority.md` (epic), `design-conductor-3b-discovery-failover.md`
(the protocol — UNCHANGED by this doc except where called out), chunk 6
(`relay/provision-cert.sh` + `docs/relay-provisioning.md` — RETIRED by this doc).

---

## 0. Why this doc exists (the premise correction)

The 3b transport was designed around the hardest venue case: **no internet at all**. The
answer to that case worked — but its operational cost was mis-weighed:

- a band-owned configurable AP,
- a separate box running Node (laptop or Pi) carried to every gig,
- a 90-day manual cert ceremony (DNS-01 TXT dance at home),
- AP DNS overrides + static DHCP leases.

That is not "leverage the gear already at a gig." It's a lighting rig for a bar band.

The unstated physics that forced it: **a browser tab cannot accept incoming connections.**
A PWA can only dial out. So "conductor's phone + any existing AP, nothing else" was never
achievable — *something* must accept connections, and on a dead network that something must
be local hardware. This was the real trade when PWA won over native-BLE peer-to-peer, and
it should have been named then.

**The correction:** stop optimizing for the dead-network case. Host the relay in the cloud,
permanently, at `relay.showrunr.ai`. Then the PWA dials out over *any* internet — venue
Wi-Fi or one member's phone hotspot (relay traffic is tiny JSON frames; one bar of LTE is
plenty). Zero hardware. Zero provisioning. Zero cert ceremony. The genuinely-dead venue
(no cell signal at all) degrades to what the design already guarantees: every device
self-drives (the Concept A floor). If that case ever matters commercially, the answer is a
native app, not a Pi.

**What survives untouched:** the entire protocol — reducer, baton epochs, journaled rooms,
claim/failover, session keys, snapshot doors, join/QR UX, all of chunks 1-5 (~1194 tests).
The relay was designed as a dumb star that never parses payloads; dumbness is
location-independent. What dies is chunk 6's provisioning ceremony and the band-AP DNS
trick. That is the smallest slice of the epic.

## 1. The workflow (the point of the whole change)

### Before (local box) vs after (cloud)

| | Local box (shipped) | Cloud (this doc) |
|---|---|---|
| **Buy** | configurable AP + Pi/laptop | nothing |
| **At home, once** | clone repo, npm install, issue cert (DNS-01 TXT dance), configure AP DNS + DHCP | nothing |
| **At home, every ~90 days** | re-run cert ceremony before it lapses | nothing |
| **At home, before each gig** | cert `check`, charge/pack the box + AP | nothing |
| **At the venue** | power AP + box, join all devices to the band AP, start relay in a terminal, THEN go live | be on any internet, go live |
| **If it breaks mid-gig** | you debug a Linux box on stage | everyone self-drives; rejoin when signal returns |

### The full "after" workflow, end to end

**At home (unchanged from what already exists — this is chart provisioning, not relay
provisioning):** each member installs the PWA and opens the show once online, so the
service worker caches the app + charts. This was always required and still is.

**At the gig:**
1. Everyone's device gets on the internet however is convenient: venue Wi-Fi, or one
   member's **phone hotspot** (which networks the band AND reaches the relay — the AP and
   the backhaul in one device already in someone's pocket).
2. MD opens the show → **Conduct** → **Go live**. The app connects out to
   `wss://relay.showrunr.ai`, creates the room, shows the QR + join code.
3. Everyone else scans the QR (or types the code). Mirroring starts. Done.

There is no step where anyone touches a terminal, a router admin page, or a certificate.

### On-ramps: how the band gets internet at the venue (any of these, per gig)

All three hit the same cloud relay; mix and match per venue, nothing about the design
changes. The invariant: **every device that wants to mirror holds a path to the relay for
as long as it wants to mirror** (a drop = self-drive until rejoin, correct-never-wrong).

| On-ramp | Band carries | Config at the venue |
|---|---|---|
| Venue Wi-Fi | nothing | everyone joins venue Wi-Fi (passwords / captive portals, per venue) |
| Phone hotspot | nothing | everyone joins one member's hotspot; its single LTE link carries the room (tiny frames — one bar of signal suffices) |
| **Band AP with backhaul** (travel router on venue ethernet, or tethered to a phone) | a travel router | **none** — devices auto-join the familiar SSID they've joined before; router tethers or plugs in |

The third row redeems the original premise honestly: "nothing but an existing Wi-Fi AP"
IS the workflow — provided the AP can reach the internet. It needs zero special
configuration (no DNS override, no static lease, no relay box) because all of that
apparatus existed only to fake `relay.showrunr.ai` inside a disconnected bubble; with real
backhaul, the real name answers. Only the AP that CANNOT reach the internet ever required
carrying a server, and that case is now officially the self-drive floor (§8 Q5).

**Degrade ladder (all shipped behavior, unchanged):** device loses signal → it self-drives,
rejoins + snapshot-pulls when signal returns. Relay unreachable for everyone → whole room
self-drives (same floor as "relay box died" in the shipped failure matrix). MD's device
dies → `conductor-lost` → anyone taps *Take the baton*.

## 2. What actually changes (and what explicitly does not)

### D1. Hosting: one always-on Node host with WebSockets + a persistent disk (CHOSEN: Fly.io; Railway = equal-weight alternate)

Requirements that pick the platform: long-lived WebSocket connections (rules out Vercel —
the app stays there, the relay cannot), a **persistent volume** for the room journal
(epoch monotonicity across restarts is a protocol invariant — §4 below), TLS managed by
the platform, ~$5/mo. Fly.io and Railway both satisfy all four; default Fly (volumes +
anycast + `fly.toml` in-repo is the cleanest single-file ops story). A plain VPS also
works but re-introduces cert ops (even if automated) — only if the platforms disappoint.

### D2. One wss URL, standard port

`NEXT_PUBLIC_RELAY_URL=wss://relay.showrunr.ai` — **port 443**, not 8787. Venue/guest
Wi-Fi and hotel-style captive networks routinely block nonstandard ports; 443 passes
everywhere TLS passes. The platform terminates TLS on 443 and forwards to the relay's
internal port; `relay/start.ts` keeps `RELAY_PORT` and gains nothing. `RELAY_CERT`/
`RELAY_KEY` stay supported for plain-`ws://` local dev and the integration tests, but the
provisioning ceremony around them is deleted (§6).

### D3. The relay code itself: minimal, deliberate deltas only

The protocol is untouched. The deltas are all "the socket now faces the public internet"
(§3) plus room-identity (§4). No frame changes except where §4 says so. The reducer,
`lib/relay-protocol.ts`, `lib/relay-binding.ts`, and the hook are **zero-change** unless
§4's room-identity decision touches the join frame — called out there.

### What does NOT change (fence, explicit)

- Single-writer/baton/epoch semantics, lease heartbeats, claim/failover — byte-for-byte.
- Snapshot service (forward-to-writer + stale cache) — byte-for-byte.
- `SessionKey` scoping, session-switch flow — byte-for-byte.
- The PWA offline chart cache and at-home install/sync story.
- Self-drive floor: transport remains load-bearing for togetherness ONLY.
- 3c (cross-chart canonical lift) remains a separate future design.

## 3. The new trust reality: a public socket (the section Codex should attack)

The shipped trust model (discovery doc §2/D5) was: *"joining the band's private AP +
knowing the room code IS the trust boundary."* Half of that boundary just evaporated —
anyone on the internet can open a socket to the relay. The room code is now the only door,
and the relay must survive strangers. The threat is still "bored neighbor / script kiddie,"
not a nation-state; the responses are proportionate:

- **S1. Join-code entropy up.** 4 chars was sized for a private AP. Public door: **6
  chars, unambiguous alphabet** (no 0/O/1/I; ~32^6 ≈ 1.07B) — still shoutable across a
  stage, still fits beside a QR. QR users never type it anyway.
- **S2. Rate limiting, three grains.** (a) per-IP `hello` attempts (bad-code guesses) —
  token bucket, ban-listed after sustained abuse; (b) per-connection frame rate (a joined
  guest can't flood the fan-out); (c) per-IP concurrent-connection cap. Constants are
  defer-with-default (§8 Q2).
- **S3. Payload caps.** `ws` `maxPayload` set explicitly (snapshot is the largest legit
  frame; size one generously and reject beyond). A public socket must not buffer unbounded
  garbage.
- **S4. Origin allowlist.** Browsers send `Origin`; accept only `https://showrunr.ai`
  (+ configured preview origins). Belt, not crypto — non-browser clients can lie — but it
  zeroes the drive-by-website vector against members' browsers and costs one header check.
- **S5. Room GC.** On a shared always-on relay, phantom rooms (typo'd creates, abandoned
  shows) accumulate forever without collection: **empty room + no activity for 24h →
  journal entry dropped.** (The local-box design never needed this — the box rebooted
  between gigs.) A GC'd room's stale QR simply re-creates on next use — same recovery row
  as today's reboot-readmit, epoch floor preserved by §4's journal rule.
- **What we deliberately still don't do (v1):** crypto identity, accounts-gated rooms,
  E2E payload encryption. The payload is bar positions of a setlist — the code door plus
  S1-S5 is proportionate. Revisit if the product grows beyond "a band and its show."

## 4. Room identity on a shared relay (the one real protocol touch)

Shipped grain: **room = show-slug**, minted client-side, created by first `hello`. On a
band-private box that was safe. On a shared cloud relay it collides: two bands with a show
named `summer-tour` land in the SAME room — first one creates it, the second band's members
bounce on a code mismatch with no way to understand why ("wrong code" that is actually
"wrong band").

**D4. Room id = the join code itself: client-mints a random 6-char code (S1 alphabet) at
Go-live; `room == code`.** One identifier, globally unique by entropy, zero lookup
machinery, and the "type the code" fallback works by construction (the code IS the room
key — today's flow needed the typer to already know the slug; this deletes that hidden
assumption). The QR carries what it always carried (`relay`, `room`, `code` — now
`room === code`; keep both query params so the join URL shape is stable). Colliding mints
(~1-in-a-billion per active room) are handled honestly: `hello`-create of a room that
already has a live writer → bounce; the MD's app re-mints and re-renders the QR — one
frame of retry logic in the client binding, invisible to humans.

Consequences, pinned:
- The journal entry stays `{room, roomCode, epoch}` (now redundant fields — harmless;
  epoch monotonicity rule unchanged, volume-backed per D1).
- Show-slug stops being wire-relevant; `SessionKey` (sessionId/songRef/programHash)
  already carries ALL musical identity end-to-end. Nothing else reads the room name.
- Rooms are per-gig ephemera (GC'd, S5), not stable show addresses. A band going live
  twice in one night mints two rooms; fine — the QR is the address.
- **This is the only change with wire/client-code contact:** the mint-at-create + collision
  re-mint in the client binding, and relaxing the "room = show-slug" doc language. The
  conn machine, reducer, and frames are otherwise untouched.

## 5. WAN behavior deltas (constants, not architecture)

- **Lease constants hold.** `HB_MS`=2000 / `HB_MISS`=3 (~6s orphan) tolerate WAN jitter
  fine; no change.
- **Reconnect backoff gets jitter.** Shipped: flat 1500ms, rationale *"the relay is the
  band's own box."* It isn't anymore; flat retry from a whole venue that lost Wi-Fi is a
  thundering herd against a shared host. Exponential-ish with jitter, cap ~10s, reset on
  success. Client-binding constant change, one test.
- **Latency reality check (why nothing else changes):** one WAN round trip (~30-80ms
  regional) added to delta fan-out. The design never promised beat-grade sync over the
  wire (the 5b clock layer is MD-local; followers mirror *position*, not click). Bar-grain
  position mirroring is indifferent to 80ms. No protocol accommodation needed or made.
- **Health endpoint.** Plain HTTP `GET /healthz` (platform liveness probes + a pre-gig
  human check: "is the relay up" in a browser). The relay already runs an HTTP server
  under the WS upgrade; this is a two-line handler, no protocol contact.

## 6. What gets deleted / rewritten (the honest cleanup)

- **DELETE `relay/provision-cert.sh`** and the cert ceremony. (The cert issued 2026-07-02
  simply expires unused, or serves local-dev wss until then.)
- **REWRITE `docs/relay-provisioning.md` → `docs/relay-ops.md`:** deploy/update/rollback
  on the platform, secrets, volume, GC + rate-limit constants, `/healthz`, "what to do if
  the relay is down mid-gig" (answer: nothing — everyone self-drives; fix it after).
  The at-home **member** checklist (PWA install + chart sync) moves to user-facing docs;
  it was never really about the relay.
- **AMEND discovery/failover doc §1/§2/D5** with a pointer to this doc (crux inverted:
  secure context is free on a real origin; trust boundary per §3 here). The protocol
  sections stand.
- **Local-box mode is de-productized, not de-coded:** `ws://` + env-cert paths remain for
  dev/tests. No doc tells a musician to buy hardware.

## 7. Build outline (after sign-off — gated, Codex per chunk)

1. **Relay hardening** (`relay/server.ts` + `relay-core.ts`): S1-S5 + D4 room=code +
   `/healthz` + backoff jitter (client constant). Tests: rate-limit buckets, origin
   bounce, payload cap, GC sweep, create-collision re-mint, journal GC persistence.
2. **Deploy** (`fly.toml` or equivalent in-repo, volume, secrets, DNS cutover of
   `relay.showrunr.ai`, `NEXT_PUBLIC_RELAY_URL` on Vercel). Smoke: two devices on
   different networks (one on LTE hotspot) mirror a session.
3. **Docs cleanup** (§6) + delete provision-cert.sh.
4. *(cut-eligible)* Uptime ping/alert on `/healthz`.

## 8. Open questions (defer-with-default)

1. **Platform:** Fly vs Railway — default Fly (D1). Graham may have a hosting preference;
   either satisfies the four requirements.
2. **Rate-limit + GC constants:** defaults in chunk 1 code review (hello: 10/min/IP burst
   20; frames: 30/s/conn; conns: 20/IP; GC: 24h). Tune at UAT, not worth debating now.
3. **Room-code length:** 6 (S1). Could go 5 if typing feels heavy at UAT; not below.
4. **Multi-region later?** v1 = single region nearest home turf. A band tour crossing
   oceans adds ~150ms — still fine at bar grain. Revisit only with real demand.
5. **The dead-venue story:** officially "self-drive floor, no togetherness." If real
   demand emerges: native app (true P2P) — NOT a hardware kit. Recorded so the Pi never
   comes back.
6. **Mid-show backhaul loss (v2 candidate, discussed with Graham 2026-07-02):** the cloud
   star requires continuous backhaul from every mirroring device. A WebRTC-data-channel
   hybrid — cloud relay does signaling at soundcheck, deltas then flow peer-to-peer over
   the local network — could survive backhaul dying mid-show (established local ICE pairs
   outlive the internet). The 3b rejection of WebRTC ("signaling needs a channel first")
   dissolves once a cloud relay exists to sign through. Real cost: mesh complexity, NAT
   variance, and the baton arbiter needs a home. Deliberately NOT v1; recorded so the
   strongest objection to the star has a named answer.
