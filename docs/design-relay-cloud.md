# Conductor transport — cloud relay as the one deployment (kills the local-box story)

**Status:** v3 — DESIGN-ONLY. Not built.
**Codex R1 = NO-GO (3H/5M/2L), all folded** — root cause: v1's D4 kept the shipped
*implicit-create-on-first-hello*, which only made sense on a band-private box; v2 moved to
explicit create/join intent + relay-minted codes.
**Codex R2 = NO-GO (2H/3M/1L), all folded** — root cause of both HIGHs: v2 tied per-room
epoch monotonicity to a per-room record and a clock, and lost when either lied. v3: **one
global durable monotone grant counter** (S5) with **write-ahead-before-ack** journal
policy (S2) — room records become droppable cache; plus tiered pre-admission payload caps
(S3), `joined` extended-never-reshaped, `use-conductor-session` config/lifecycle as a
first-class change surface, typed-code join scoped to the show page (global `/join`
cut-eligible).
**Codex R3 = GO-WITH-NITS (2 LOW, both doc-consistency, both folded).** R3 confirmed:
cross-room epoch interleave safe under the shipped reducer; write-ahead-before-ack is the
right durability point — **build note: "flushed durable" must be real (fsync), not just
writeFileSync + rename.** Awaiting Graham's GO before any build.
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
Wi-Fi or one member's phone hotspot (relay traffic is tiny JSON frames — bandwidth is
never the constraint; *continuity* of the connection is, per §1's invariant). Zero
hardware. Zero provisioning. Zero cert ceremony. The genuinely-dead venue
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
| Phone hotspot | nothing | everyone joins one member's hotspot; its single LTE link carries the room. Bandwidth is trivial (tiny frames), but this rides ONE phone's battery + cellular coverage — a real operational dependency, not a guarantee (Codex R1 LOW-10). If it dies: room self-drives, MD's re-created room readmits when signal returns |
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

**The single-arbiter invariant must be PINNED in deploy config** (Codex R1 MED-6): the
entire claim protocol assumes one serial relay process — two instances behind one name
are two baton arbiters, and a rolling deploy that overlaps old+new instances splits the
room mid-song. Deploy config: **exactly one machine, one region, stop-then-start deploy
strategy** (no autoscaling, no rolling overlap — `fly.toml` single machine +
`strategy = "immediate"`, or platform equivalent). The deploy blip degrades to the
shipped relay-death row: everyone self-drives, reconnects, rejoins. A shared volume does
NOT make two processes one arbiter; instance count = 1 is a protocol requirement, not an
ops preference — stated in bold in `relay-ops.md` and as a comment in the config file.

### D2. One wss URL, standard port

`NEXT_PUBLIC_RELAY_URL=wss://relay.showrunr.ai` — **port 443**, not 8787. Venue/guest
Wi-Fi and hotel-style captive networks routinely block nonstandard ports; 443 passes
everywhere TLS passes. The platform terminates TLS on 443 and forwards to the relay's
internal port; `relay/start.ts` keeps `RELAY_PORT` and gains nothing. `RELAY_CERT`/
`RELAY_KEY` stay supported for plain-`ws://` local dev and the integration tests, but the
provisioning ceremony around them is deleted (§6).

### D3. The relay code itself: minimal, deliberate deltas only

The protocol's *semantics* are untouched — baton, epochs, sessions, snapshots. The deltas
are "the socket now faces the public internet" (§3) plus room identity/lifecycle (§4).
The full change-surface inventory lives at the end of §4 (Codex R1 MED-7 — v1 claimed
"zero-change" too broadly); the genuinely zero-change core is the reducer
(`lib/conductor-state.ts`) and `conductor-session.ts`, which never see room identity.

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
- **S2. Rate limiting, four grains** (Codex R1 HIGH-2: v1 throttled only bad-code
  *guesses*; creation itself was the cheaper attack). (a) per-IP `hello` attempts —
  token bucket, ban-listed after sustained abuse; (b) **per-IP room *creates*** (tighter
  bucket — creating costs the relay a journal write, guessing doesn't); (c) per-connection
  frame rate (a joined guest can't flood the fan-out); (d) per-IP concurrent-connection
  cap. Plus a structural backstop: a **global active-room cap** (bounce `relay-full` —
  honest, and it turns a create-flood into a bounded nuisance instead of disk exhaustion).
  **Journal write policy (Codex R2 HIGH-2 — v2's blanket "debounce" was wrong):
  authority-bearing writes are synchronous write-ahead** — a create or claim-grant is
  flushed durable BEFORE the ack leaves the relay (a grant acknowledged but not durable
  can be reissued after a crash — the exact reuse the invariant forbids). Only
  non-authority journal activity (GC compaction) may coalesce. Write *rate* is protected
  by the throttles, not by deferring durability: creates are IP-throttled + room-capped,
  and grants require holding a room's code (band trust plane, human-scale frequency).
  Constants defer-with-default (§8 Q2). Note §4 removes the biggest creation surface
  outright: join-typos can no longer create rooms at all.
- **S3. Payload caps, tiered by admission state — validate before you buy** (Codex R1
  MED-5 + R2 MED-5: budgets must bind BEFORE a client is anyone). Tiers:
  (a) **pre-admission: a connection's first frame must be a `hello` and is capped at a
  small raw-byte budget (~1KB)** — length-checked on the wire BEFORE JSON parse; an
  unauthenticated stranger can never make the relay parse snapshot-sized JSON, and the
  S2 frame-rate cap applies from byte one (pre-admission included), not just to joined
  guests; (b) **post-admission, non-writer:** per-frame-type budgets (`hello`-sized
  control frames only — a follower never legitimately sends big frames);
  (c) **writer only:** the generous `snapshot` budget — the one large frame is only legal
  from `writerConn` (shipped rule 2), so `ws` `maxPayload` alone never defines a
  stranger's cost. Plus **string-field length caps** (`deviceLabel`, code, `showRef`) in
  `parseClientFrame` and a **cap on pending snapshot-requests per room**. Validation
  order stays cheap-first: raw length (per tier) → JSON parse → per-type shape.
- **S4. Origin allowlist.** Browsers send `Origin`; accept only `https://showrunr.ai`
  (+ configured preview origins). Belt, not crypto — non-browser clients can lie — but it
  zeroes the drive-by-website vector against members' browsers and costs one header check.
- **S5. Room lifecycle + the epoch invariant** (Codex R1 HIGH-1 → R2 HIGH-1, two dead
  attempts is enough: v1's "GC preserves the floor" was false, and v2's time-floored
  epochs were false too — rapid claim/release cycles advance epochs faster than wall
  seconds, and clock rollback breaks the floor independently; any scheme that ties
  per-room monotonicity to a per-room record OR a clock loses when the record dies or
  the clock lies). Lifecycle: **unclaimed rooms** (created, writer never claimed) GC
  after **15 min**; **abandoned rooms** (empty, no activity) GC after **24h**.
  The invariant is preserved by removing its per-room dependency: **one global, durable,
  monotone grant counter.** Every epoch the relay ever issues — room create seed and
  every claim grant, across ALL rooms — is `++globalEpochCounter`, journaled write-ahead
  (S2: flushed before the ack). Per-room epochs are then a strictly increasing
  subsequence of a single never-decreasing integer, so **no room can ever see a reissued
  epoch, no matter what was GC'd, re-minted, or when** — room records become freely
  droppable cache, not integrity state. No tombstones, no wall clock, no high-water math;
  crash-restore reads one integer back. Cost: epochs interleave across rooms (room A gets
  5, room B gets 6, A's next is 7) — the reducer never assumed density, only ordering
  within its room (fixed ground), and the shipped future-epoch door (`needsSnapshot` →
  pull) is exactly how a returning client reconciles. Defense-in-depth: restore adds a
  fixed slack (+1000) on unclean shutdown; harmless (gaps are free) and covers a torn
  final write.
- **What we deliberately still don't do (v1):** crypto identity, accounts-gated rooms,
  E2E payload encryption. The payload is bar positions of a setlist — the code door plus
  S1-S5 is proportionate. Revisit if the product grows beyond "a band and its show."

## 4. Room identity on a shared relay (the one real protocol touch)

Shipped grain: **room = show-slug**, minted client-side, created by first `hello`. On a
band-private box that was safe. On a shared cloud relay it collides: two bands with a show
named `summer-tour` land in the SAME room — first one creates it, the second band's members
bounce on a code mismatch with no way to understand why ("wrong code" that is actually
"wrong band").

**D4 (v2 — rewritten after Codex R1 HIGH-3/MED-4/MED-8; v1's client-minted
code-on-implicit-create is DEAD). Explicit create/join intent on the wire; the RELAY
mints the code; `room == code`.**

The v1 shape inherited the shipped "first `hello` creates the room" trick — fine on a
private box, incoherent on a shared relay: the wire couldn't distinguish an MD creating
from a follower joining (HIGH-3: bouncing "existing room with live writer" would bounce
every legitimate follower), client-side minting made collisions a real race under load or
abuse (MED-4: birthday math across active + journaled + attacker-created rooms, not
1-in-a-billion), and a typo'd join manufactured phantom rooms. One shape change deletes
all three:

- **`hello` gains `intent: 'create' | 'join'`.**
- **Create:** no room field sent. The relay mints an unused 6-char code (S1 alphabet) —
  it holds the registry, so "unused" is a lookup, not a probability — seeds the room's
  epoch from the global grant counter (S5), journals write-ahead, and replies `joined { room, created: true, epoch, hasWriter:
  false, activeSession: null }`. The QR renders from the response. **Collisions cannot
  occur, so no collision path exists to get wrong.**
- **Join:** `room` (the code) required; unknown room → bounced with `no-room`. **A typo'd
  code now bounces honestly instead of manufacturing a phantom room** — the discovery
  doc's D3 "phantom rooms are benign" note is superseded; on a public relay they were an
  attack surface (S2), and now they are impossible.
- **Show identity for the typed-code path (MED-8, the overpromise):** v1 claimed "type the
  code" works by construction — false: the shipped join flow lands on a show URL and
  derives everything from it; a generic code-only Join screen wouldn't know which show or
  charts to open. Fix in the established pattern: the creating `hello` carries an opaque
  **`showRef` blob** (owner/slug), stored + returned in every `joined` exactly like
  `activeSession` — the relay stores and echoes it, never interprets it (dumbness
  preserved). QR joins keep deep-linking as today; a typed-code join navigates via the
  echoed `showRef`. "Chart not on this device" honesty (discovery doc §4.4) already covers
  the member who lands on a show they never synced.

Consequences, pinned:
- Wire changes, complete list: `hello.intent`, `hello.showRef` (create only),
  `joined.created` + `joined.room` + `joined.showRef`, `no-room` bounce, `relay-full`
  bounce (S2). **`joined` is EXTENDED, never reshaped** (Codex R2 MED-4): every shipped
  field — `epoch`, `hasWriter`, `activeSession`, `writerLabel` — survives byte-for-byte;
  new fields are additive, so the shipped conn-machine parse paths keep working unread.
  Version skew between app and relay already closes 4002 (shipped rule 5); relay deploys
  with the app change — no compat shim.
- Journal becomes: the **global epoch counter** (S5, the one integrity datum) + a room
  registry `{room, epoch, showRef}` (`roomCode` merged into `room`; droppable per S5).
- **Typed-code join is scoped to the show page in v1** (Codex R2 LOW-6): the member opens
  their show and types the code there — the shipped assumption that joiners land on a
  show URL (`lib/relay-join.ts:3`) stays true. A generic global `/join` route (navigate
  anywhere via the echoed `showRef`) is specced by this doc but **cut-eligible**, built
  last or not at all; `showRef` ships regardless (it costs one opaque field and unlocks
  the route whenever wanted).
- Show-slug stops being the room key; `SessionKey` carries all musical identity.
- Rooms are per-gig ephemera (S5), not stable show addresses. Going live twice in one
  night mints two rooms; the QR is the address.

**Change-surface inventory (Codex R1 MED-7 — v1's "zero-change" claim was too broad).**
Honest list of every shipped surface D4 + §5 touch: `lib/relay-protocol.ts` (hello/joined
shapes, `no-room`/`relay-full`, conn-machine create/join arms), `lib/relay-binding.ts`
(create-vs-join entry), `lib/relay-join.ts` (4-char code assumption, `roomNameFor(owner,
slug)` — deleted), the show page's QR/join URL construction and Join screen
(`app/[owner]/[show]/page.tsx`), **`lib/use-conductor-session.ts` as a FIRST-CLASS
surface, not a constant tweak** (Codex R2 MED-3): its `RelayConfig` requires `room`/`code`
up front and sends `helloFrame(room, code, label)` on socket open — under D4-create
neither exists until `joined` returns them, so the config model splits into
create-mode (no room; adopt `joined.room`, hold it across reconnects for THIS live
session) vs join-mode (room known), and the hook's open/reconnect lifecycle changes with
it — plus the backoff jitter (§5), and all their tests. The reducer
(`lib/conductor-state.ts`) and `conductor-session.ts` remain genuinely zero-change — they
never see room identity.

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
- **AMEND discovery/failover doc §1/§2/D3/D5** with a pointer to this doc (crux inverted:
  secure context is free on a real origin; trust boundary per §3 here; D3's
  implicit-create + "phantom rooms benign" superseded by §4 here). The protocol
  sections stand.
- **AMEND the epic (`design-conductor-authority.md` §5 and the §8 transport language)**
  (Codex R1 LOW-9): it still canonizes "band-owned AP, no backhaul" as the transport
  topology, which would mislead every future chunk (3c included). One paragraph + pointer
  here; the two-axis model and single-writer sections are untouched.
- **Local-box mode is de-productized, not de-coded:** `ws://` + env-cert paths remain for
  dev/tests. No doc tells a musician to buy hardware.

## 7. Build outline (after sign-off — gated, Codex per chunk)

1. **Relay hardening** (`relay/server.ts` + `relay-core.ts`): S1-S5 (global epoch
   counter, write-ahead-before-ack, unclaimed/abandoned GC, create throttles, room cap,
   tiered payload budgets, pending snapshot-request cap) + D4 create/join intent with
   relay-minted codes + `showRef` + `/healthz`. Tests: rate-limit buckets per grain
   (incl. pre-admission), origin bounce, pre-hello 1KB cap (snapshot-sized first frame
   bounced unparsed), GC sweeps (both TTLs), **the R1/R2-HIGH-1 regression: GC'd-code
   re-mint after rapid claim/release churn still grants strictly higher epochs**,
   **crash-restore: ack'd grant survives restart, un-ack'd never reissues** (write-ahead
   ordering), `no-room`/`relay-full` bounces.
2. **Client binding + join surfaces** (the MED-7 + R2-MED-3 inventory): protocol/
   conn-machine create/join arms (`joined` extended, shipped fields untouched),
   `use-conductor-session` config split (create-mode adopts `joined.room`) + reconnect
   lifecycle, `relay-join.ts` rewrite, QR/Join screen on the show page, backoff jitter.
   Tests per surface. Generic `/join` route via `showRef`: cut-eligible tail.
3. **Deploy** (`fly.toml` or equivalent in-repo — **instance count 1 + stop-then-start
   pinned per D1**, volume, secrets, DNS cutover of `relay.showrunr.ai`,
   `NEXT_PUBLIC_RELAY_URL` on Vercel). Smoke: two devices on different networks (one on
   LTE hotspot) mirror a session.
4. **Docs cleanup** (§6) + delete provision-cert.sh.
5. *(cut-eligible)* Uptime ping/alert on `/healthz`.

## 8. Open questions (defer-with-default)

1. **Platform:** Fly vs Railway — default Fly (D1). Graham may have a hosting preference;
   either satisfies the four requirements.
2. **Rate-limit + GC constants:** defaults in chunk 1 code review (hello: 10/min/IP burst
   20; creates: 3/min/IP burst 5; frames: 30/s/conn; conns: 20/IP; room cap: 500;
   unclaimed GC: 15min; abandoned GC: 24h; **GC-compaction coalesce: 1s — compaction
   ONLY; authority-bearing create/grant writes are NEVER debounced**, per S2's
   write-ahead-before-ack rule). Tune at UAT, not worth debating now.
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
