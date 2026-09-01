# Conductor transport — cloud relay as the one deployment (kills the local-box story)

**Status:** v5 — chunks 1–3 BUILT, MERGED, DEPLOYED (`relay.showrunr.ai` on Fly, live since
2026-07-02; UAT fix PR #118). v4/v5 amend the shipped design with **§9: the venue-network
requirement and the degraded-state contract**, ratified by Graham 2026-08-04. §8 Q5 and Q6
are RESOLVED by §9 — read §9 before re-litigating either.
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
writeFileSync + rename.** Graham gave GO; chunks 1–3 shipped as PRs #115/#116/#117.
**Codex R4 = NO-GO (2H/1M) on the §9 amendment, all folded (v5).** Root cause of both
HIGHs, and it is one root cause: **§9 was written as product requirements without checking
them against the shipped code**, so it asserted capability the build does not have. HIGH-1 —
§9.3 called itself "UI-only, zero protocol contact" while requiring the conductor to see
follower reality, which no frame carries (the relay holds `room.members` privately and emits
nothing to the writer). HIGH-2 — §9.1 promised offline chart rendering as a guarantee when
`sw.js`/`chart-cache.ts` are explicitly best-effort. MED-3 — "never connected vs lost" was
required without a state model, against a hook with only `'off' | 'connecting' | 'joined'`.
v5 fixes the class, not the instances: **every §9.3 requirement now names the mechanism that
satisfies it and whether that mechanism exists today.**
**Date:** 2026-07-02 (v3) · 2026-08-04 (v4 amendment, v5 R4 fold)
**Branch:** `opus/design-relay-cloud` (v3) · `opus/relay-venue-network-requirement` (v4)
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
6. **`presence` frame** (§9.3.2) — relay→writer roster on join/leave/grant, coalesced;
   `relay-core.ts` + `relay-protocol.ts` + conn-machine → `RelayFacts`. Reducer tests per
   §9.3.2. Requires a relay deploy. *(Gated on the §9.6 phone retest.)*
7. **Degraded-state UI** (§9.3.1) — the six-state connection model in
   `use-conductor-session.ts`, copy + affordance for each, conductor-side follower readout
   from chunk 6. No protocol contact. *(Depends on 6 for the readout only; the
   `room-rotated` state does not — see §9.3.)*
8. ✅ **Persist-on-fetch** (§9.1) — **SHIPPED.** `fetchChartBytes` writes network-fetched
   bytes to the chart cache on both branches, making "rendered once ⇒ available offline"
   true. Was solo-mode only, no relay contact, so it landed ahead of testers without the
   §9.6 phone retest. Its real value is narrower than "makes offline work": it closes the
   gap for **legacy Drive charts**, which had no automatic cache path at all, and gives
   Supabase charts a second chance when the unobserved bulk warm fails. ⚠ It does **not**
   relax §9.5's precondition to "open it once" — an earlier draft of this line claimed that,
   and it is wrong: chunk 8 persists only the charts a device actually *rendered*, and the
   Supabase warm that covers the rest reports nothing. Offline Access remains the only
   path that covers a full set **and** tells you whether it worked.

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
5. **The dead-venue story:** ✅ **RESOLVED 2026-08-04 — see §9.2.** Officially "self-drive
   floor, no togetherness." Reaffirmed and promoted from a deferred question to a stated
   product requirement. If real demand emerges: native app (true P2P) — NOT a hardware
   kit. Recorded so the Pi never comes back.
6. **Mid-show backhaul loss** — ✅ **RESOLVED 2026-08-04: DECLINED for v1, see §9.4.**
   Graham re-raised this independently on 2026-08-03 ("limited backhaul for the purposes of
   establishing the connection"), which is this question restated — evidence that leaving it
   "open" makes it recur. It is now closed with a rationale and a named re-open trigger.
   Original text retained below for the record.

   *(v2 candidate, discussed with Graham 2026-07-02):* the cloud
   star requires continuous backhaul from every mirroring device. A WebRTC-data-channel
   hybrid — cloud relay does signaling at soundcheck, deltas then flow peer-to-peer over
   the local network — could survive backhaul dying mid-show (established local ICE pairs
   outlive the internet). The 3b rejection of WebRTC ("signaling needs a channel first")
   dissolves once a cloud relay exists to sign through. Real cost: mesh complexity, NAT
   variance, and the baton arbiter needs a home. Deliberately NOT v1; recorded so the
   strongest objection to the star has a named answer.

---

## 9. The venue-network requirement and the degraded-state contract (ratified 2026-08-04; amended through v6)

Added after Graham raised venue backhaul as a blocker to putting ShowRunr in outside
testers' hands. This section states as **product requirements** what §1 and §8 previously
carried as implementation notes and deferred questions.

> ### ★ Rule for all of §9 (v6, after Codex R5)
>
> **Every falsifiable claim in this section names its mechanism and whether that mechanism
> exists in shipped code today — including tester-facing instructions.**
>
> This rule exists because the same defect has now been caught twice. R4 found §9 asserting
> capability the build does not have; v5 fixed it by adding a mechanism/exists-today table
> **to §9.3 only**, and then wrote §9.1 and §9.5 free-hand — so R5 found the identical error
> in the offline claim (HIGH-1). The v5 fix was applied as an *instance* when the defect was
> a *class*.
>
> Two corollaries, both drawn from R5 findings:
> - **An acceptance criterion is a claim.** "Join emits presence" named no mechanism and
>   contradicted the coalescing requirement beside it (MED-2).
> - **The rule cuts both ways.** Requirement 6 was marked "does not exist" when the code
>   existed and was tested (MED-3). Unchecked pessimism builds the wrong chunk just as
>   surely as unchecked optimism ships a false promise.

### 9.1 Two independent offline stories — do not conflate them

Graham's framing, 2026-08-04. ShowRunr makes two different "works offline" claims, with
different requirements. Most of the confusion in this area comes from treating them as one.

| | **Solo mode** | **Conductor mode** |
|---|---|---|
| Covers | charts, setlist, stage plot, input list, notes | shared navigation: position mirroring, moving redline, baton |
| Connectivity to **start** | required once (cache warm) | required |
| Connectivity **during** the show | **not required** | **required, continuously** |
| Status | shipped | shipped (chunks 1–3), **not yet verified on a phone** (§9.6) |

The solo floor is real and present in code: `public/sw.js` caches the app shell (`/` plus
the PDF worker), serves navigations network-first with cache fallback, keeps a separate
chart cache, and accepts a `WARM_CACHE` message for pre-warming.

**But it is best-effort, and the doc must not promise more than the code delivers** (Codex
R4 HIGH-2). Opening the show once while online *starts* the warm; it does not guarantee it
finished, or that everything needed got cached:

- `lib/chart-cache.ts` races the service-worker controller against a timeout and posts
  `WARM_CACHE` only if the controller won — no controller, no warm, no error.
- `WARM_CACHE` failures are skipped silently; nothing reports which URLs actually landed.
- `sw.js` never caches `/api/*` by design, so anything a chart needs from an API route at
  render time is not covered by the shell cache.
- Chart auto-cache on the show page is fire-and-forget and **Supabase-only**
  (`page.tsx:557-564` on show load; `page.tsx:6692` when a song is added). It calls
  `downloadAllCharts`, so it covers the whole Supabase set in advance — but failures are
  swallowed by `.catch(() => {})` and nothing reports what actually landed.
- ✅ **Rendering a chart now caches it — chunk 8, shipped.** `fetchChartBytes`
  (`lib/pdf-viewer.ts:65`) writes fetched bytes to the Cache API on both network branches,
  so "rendered once ⇒ available offline" is true. It was the R5 HIGH-1 trap: before it, the
  only persistent write was `downloadAllCharts`, which **legacy Drive charts never got
  automatically at all**.

⚠ **The line reference above was stale, and that stale number caused a bad correction.** An
earlier revision cited the auto-cache at `page.tsx:490`; that line is now `setTab('perform')`,
and on 2026-09-01 I read the miss as evidence the auto-cache had never existed and deleted the
claim — asserting "there never was" one. **It does exist**, at `:557-564`, and Codex caught
it. The grep that "confirmed" the absence looked for callers of `cacheChart` and stopped one
hop short of asking who calls `downloadAllCharts`. **When a cited line number doesn't match,
that is evidence the file moved, not that the feature is fictional.**

**Post-chunk-8 the two sources still differ, and the difference is the point of chunk 8:**

| Source | What caches it | Survives a reload offline? |
|---|---|---|
| Supabase | bulk auto-cache on show open (whole set, unobserved), **plus** rendering it | **Usually** — and now with a second chance if the warm silently failed |
| Drive (legacy) | **no auto-cache**; rendering it (chunk 8), or the Offline Access download | **Yes** once rendered or downloaded — before chunk 8, only if downloaded |

So chunk 8's real value is narrower than "makes offline work," and should be stated that way:
it closes the gap for **legacy Drive charts**, which had no automatic path at all, and gives
**Supabase charts a second chance** when the unobserved bulk warm fails. The honest claim is:
**a chart that has been rendered on this device, or covered by a clean Offline Access
download, will open with zero connectivity.**

Three residual gaps, all deliberate, all silent:

- A chart with no `modifiedTime` has no cache key (`chart-cache.ts:9`), so it renders online
  and stays absent offline.
- The chunk-8 write is fire-and-forget by design — a quota or private-browsing failure
  surfaces nothing, because offline availability must never fail a render that succeeded.
- The Supabase bulk warm is equally unobserved, which is why the §9.3 readiness indicator
  ("charts ready offline") remains the honest fix rather than more caching.

A device installing the PWA for the first time *at* a dead venue still has nothing cached and
still gets nothing. See §9.5. The §9.3 readiness indicator ("charts ready offline") is the
natural companion and remains the honest way to make this checkable rather than ritual.

**Backlog (named, so it is not lost):** the warm is unobservable to the user. A readiness
indicator — "charts ready offline" vs "still caching" — would make the precondition
checkable instead of ritual. Not v1; it is the natural companion to §9.3 and should be
reconsidered the moment a tester reports missing charts at a venue.

> "ShowRunr works offline" is **true of solo mode and false of conductor mode.** Never say
> it unqualified to a tester.

### 9.2 The requirement (v1, ratified)

**Every device that wants to mirror holds a path to `relay.showrunr.ai` for as long as it
wants to mirror.**

Stated plainly, because the shorthand keeps drifting: this is **persistent backhaul for the
duration of the show, not merely enough to establish the room.** The relay is a dumb star —
every navigation frame flows through it, for the whole show. There is no post-join handoff
to a local transport. The architecture in which establishment alone needs the internet is
§8 Q6, declined for v1 (§9.4).

**An AP without backhaul buys nothing.** A browser tab cannot accept incoming connections,
so devices sharing a disconnected LAN have no one to talk to. **"Local AP, no internet" and
"no network at all" are the same case** — the router's presence is irrelevant. This is the
same physics that killed the local-box story in §0; it did not change.

**Governing constraint (Graham, 2026-08-04): simplicity for the conductor and the players
outranks venue coverage.** Setup must not be hard for anyone. A requirement of "the venue
needs working internet" is accepted as fair, and is cheaper than any mechanism that would
relax it.

### 9.3 Degraded-state contract — the build item

The failure this defends against is **not** "the venue had no internet." It is *"something
looked broken and the player could not tell whether it was working."* The degraded state is
a good product — your whole chart book, minus sync — and today we do not say so.

Requirements — **each names the mechanism that satisfies it, and whether that mechanism
exists today.** v4 omitted this column and thereby asserted capability the build lacks
(Codex R4 HIGH-1); the column is the fix for the class of error, not just the instance.

| # | Requirement | Mechanism | Exists today? |
|---|---|---|---|
| 1 | **Loss of the relay is a named state, not a silent one.** A device that was mirroring and is no longer mirroring says so. | Client-side: socket close → a distinguishable state (§9.3.1) | **No** — state model too coarse; needs 9.3.1 |
| 2 | **Name what still works.** "Charts only — no conductor sync," never a bare error. The player has lost a feature, not the app. | UI copy on the states from 9.3.1 | **No** — pure UI, no blocker |
| 3 | **Never a dead end.** Every degraded state carries an affordance back (retry / re-open the join sheet). | UI affordance per state | **Partly** — PR #118 shipped it for the *pre-join hang* (`RelayConnectingOverlay`, tappable connecting chip); the *post-join drop* is uncovered |
| 4 | **Distinguish "never connected" from "lost connection."** Different causes, different user actions. | The state model in §9.3.1 | **No** — `use-conductor-session.ts` has only `'off' \| 'connecting' \| 'joined'`, and every close resets to `initClientConn()`, so a mid-show drop is byte-identical to a cold start |
| 5 | **The conductor sees follower reality.** An MD driving a room where nobody is mirroring should know. Silent solo-conducting is the worst version of this bug. | **A new `presence` frame, relay→writer** (§9.3.2) | **No — and this one is protocol, not UI.** The relay mutates `room.members` on join/leave but emits nothing to the writer; non-writer disconnect returns no effects at all |
| 6 | **Silent room rotation is surfaced.** *(new in v5; re-attributed in v6)* | **The create-mode 4004 close path** (`use-conductor-session.ts:606`), surfaced as the `room-rotated` state in §9.3.1. Presence (§9.3.2) is *corroborating evidence only*, never the detector | **Partly** — the rotation itself is implemented **and tested** (`tests/use-conductor-session.test.tsx:1119`). What is missing is only that it is **silent**: no state, no copy, no signal on either side |

**Requirement 6, found folding R4 and not in v4 at all.** On close code 4004 in create-mode,
the conductor clears `adoptedRoomRef` and the next connect **mints a brand-new room code**
(chunk 2, by design: the old room is genuinely gone). The QR silently re-renders — and every
follower is now holding a dead code, where they get 4004 → `roomGone` → retries stopped. A
relay restart or a GC sweep mid-show therefore **orphans the entire band while the conductor
keeps conducting**, with no signal on either side that the room they share no longer exists.
This is the sharpest real instance of requirement 5, which is why it was invisible while
requirement 5 had no mechanism.

**v6 correction (Codex R5 MED-3) — do not attribute this to presence.** v5 said presence
makes rotation observable because "followers drop to zero and stay there." That is wrong as
a *detector*: a zero follower count is indistinguishable from nobody having scanned yet,
from everyone having legitimately left, and from the normal pre-show state. It cannot
carry the requirement.

The real mechanism is **local to the conductor and already exists**: the create-mode 4004
branch in `use-conductor-session.ts:606` knows, at the instant it fires, that the room it
adopted is gone and a new code is coming. Nothing needs to be inferred. Requirement 6 is
therefore satisfied by the **`room-rotated` state in §9.3.1** — a client state transition,
not a protocol addition — and presence serves only as corroboration once it exists. This
also means **requirement 6 does not depend on chunk 6**; it lands with the §9.3.1 state
model. The conductor-facing copy must say *re-scan*, not *reconnect* — the old code will
never work again.

#### 9.3.1 The connection state model (Codex R4 MED-3)

Requirements 1 and 4 need states the client does not currently have. Today: `status: 'off' |
'connecting' | 'joined'`, and `onclose` rebuilds the binding via `initClientConn()`, which
lands back on `connecting` no matter what preceded it. "Never connected" and "lost
connection" are therefore *the same value*.

Replace with an explicit, closed set. **Each state must name its trigger, its copy, and its
affordance** — a state without an affordance is the dead end requirement 3 forbids:

| State | Entered when | Copy intent | Affordance |
|---|---|---|---|
| `idle` | Not conducting/mirroring; user hasn't asked | — | Go live / Join |
| `connecting-initial` | First connect attempt of this session; never reached `joined` | "Getting a room code…" / "Joining…" | Hide (overlay stays until dismissed — PR #118) |
| `joined` | `joined` frame received | Live | Normal UI |
| `reconnecting` | Socket closed **after** having reached `joined`; retrying with backoff | "Lost connection — charts only, no conductor sync. Reconnecting…" | Retry now |
| `room-gone` | Close 4004 in **join**-mode; retries stopped (already modelled as `roomGone`) | "That room has ended." | Re-scan QR / re-enter code |
| `room-rotated` | Close 4004 in **create**-mode; a new code was minted | "Your room code changed — followers must re-scan." | Show new QR |

The distinction requirement 4 asks for is exactly `connecting-initial` vs `reconnecting`,
and it is cheap: it is one "have we ever seen `joined` on this session" bit that `onclose`
must stop discarding when it resets the binding. **That bit is the whole fix** — the states
above are its presentation.

Note `room-gone` and `room-rotated` are the follower and conductor faces of the *same*
event. Testing one without the other is how requirement 6 stayed invisible.

#### 9.3.2 The `presence` frame (relay → writer)

Requirement 5 cannot be satisfied without the relay telling the conductor something it has
never told anyone. This is a **real protocol addition** and must be spec'd, built, and
tested as one — not smuggled in as UI work.

It is small, because the relay already holds the data: `room.members` is a
`Map<conn, deviceLabel>`, maintained on join (`relay-core.ts:422`) and leave (`:453`).
Nothing reads it outward except late-joiner attribution.

- **Shape:** `{ type: 'presence'; followers: number; labels: string[] }`, added to the
  relay→client union in `lib/relay-protocol.ts` alongside `conductor-lost`.
- **Recipient:** the writer only. Followers do not get a roster in v1 — smallest change that
  satisfies the requirement, and it keeps labels off every socket.
- **`followers` is defined as `room.members.size` excluding `writerConn`.** State it in the
  code, not just here; off-by-one on "does the conductor count itself" is the obvious bug.
- **Labels come from the relay's own member registry, never from a payload** — same rule as
  `writerLabel` (§4.3). The dumbness fence holds: the relay is reporting what it already
  knows about connections, not interpreting content.
- **Triggered by:** member join, member leave, and **grant** — a device that claims the
  baton mid-session never sent a fresh `hello`, so it would otherwise hold the baton with no
  roster. This is the case that will be missed if it isn't written down. Note *triggered*,
  not *emitted*: see the next bullet, which v5 got wrong.
- ★ **Coalesced — and the debounce lives in the reducer, not the binding** (Codex R5 MED-2).
  v5 said both "join emits presence" and "trailing-edge coalesce," which cannot both be
  true: for two rapid joins, immediate emit gives two frames and trailing-edge gives one
  later frame. The contradiction came from never naming *where* the timer lives. It lives
  **in reducer state, flushed on tick**:
  - A join / leave / grant sets `room.presenceDueAt = now + PRESENCE_DEBOUNCE_MS` (~1s) and
    returns **no presence effect**.
  - `sweep()` — already the reducer's `{ kind: 'tick', now }` arm (`relay/server.ts:388`
    drives it) — emits one `presence` effect for every room whose `presenceDueAt` has
    elapsed, computed from the room's state **at flush time**, then clears the marker.
  - Trailing-edge falls out for free: the flush reads current state, so the frame always
    carries the final count. A flapping follower produces one frame per window, not per flap.

  **Why reducer-state and not a `setTimeout` in the binding:** §9.3.2's acceptance criteria
  are pure-reducer tests, where time is an argument. A binding-level debounce would push
  presence testing into server-integration territory and out of the layer where every other
  relay invariant is proven. It would also be the only piece of relay timing not visible to
  `reduceRelay` — the lease sweep and room GC already live there.

  Edge case to spec, because it is the one that will bite: if the writer disconnects between
  the trigger and the flush, the pending marker must be **dropped, not delivered** — a room
  with no writer has nobody to tell (see the test list below).
- **Extend, never reshape** — same discipline as `joined` (§4): shipped clients that don't
  parse `presence` must keep working, so it is a new frame type, not a field on an old one.

**Tests (relay-core, pure-reducer level — these are the acceptance criteria).** All of them
assert *eventual* emission — drive `{ kind: 'tick', now }` past the window; **none may
assert that a join emits synchronously**, which is exactly the v5 error:

- A join returns **no** presence effect at `t+0`; a tick past the window emits exactly one,
  addressed to the writer and to nobody else.
- Two rapid joins inside one window emit **one** frame, carrying the **final** count.
- A leave, and a grant, each arm the same flush (grant → the **new** writer).
- `followers` excludes `writerConn`.
- A room with no writer emits nothing — no crash, no queued frame — and a writer that
  disconnects between trigger and flush drops the pending marker.
- **A follower count dropping to zero is delivered.** This is requirement 5's whole point,
  and zero is exactly the value a naive "only send if non-empty" guard would swallow.
- Ticks with no armed room emit nothing (no per-tick chatter).

**Build (revised — v4's "UI-only, zero protocol contact" was false):** two chunks, in order.
**Numbered per §7's global sequence — v5 numbered them 1 and 2 locally while §7 called them
6 and 7, which is the kind of drift that gets the wrong thing built** (Codex R5 LOW-4):

- **Chunk 6 — `presence` frame:** `relay-core.ts` (trigger + `presenceDueAt` + tick flush)
  + `relay-protocol.ts` + the client conn-machine surfacing `followers`/`labels` into
  `RelayFacts`. Tests above. Relay deploy required.
- **Chunk 7 — degraded-state UI:** the §9.3.1 state model in `use-conductor-session.ts`,
  plus copy and affordances for all six states, plus the conductor-side follower readout
  **from chunk 6**. No protocol contact; genuinely UI + hook once chunk 6 lands.

Note **requirement 6 (`room-rotated`) sits in chunk 7, not chunk 6** — its mechanism is the
existing create-mode 4004 path, so it needs no protocol work. Only the *follower readout*
in chunk 7 depends on chunk 6.

Neither is started. Build after Codex GO, per the standing gate.

### 9.4 §8 Q6 (WebRTC hybrid) — DECLINED for v1

The idea: relay does signaling at soundcheck, deltas then flow peer-to-peer over the venue
LAN, so an established room survives backhaul dying mid-show.

Declined, for three reasons:

1. **It contradicts the governing constraint.** It adds a second transport and a fallback
   negotiation between them. Complexity lands on the exact surface — go-live at a gig —
   that §9.2 says must stay simple.
2. **New failure class, worst-timed.** Peer-mesh problems (NAT variance, ICE, the baton
   arbiter's home) are the kind that pass at rehearsal and fail at the venue.
3. **It fails where it is needed.** Guest Wi-Fi that isolates clients blocks peer traffic
   outright — and hostile guest Wi-Fi is precisely the venue class this was meant to save.
   So it adds risk in the venues that already work and does not rescue many that don't.

**Re-open trigger (evidence, not anticipation):** outside-tester sessions show that
*mid-show backhaul loss* — as distinct from never having usable internet, or from onboarding
failures — is a material cause of failed sessions. Absent that evidence, this stays closed.
If the dead-venue case ever becomes commercially real, §8 Q5's answer stands: a native app,
not a hardware kit and not a mesh.

### 9.5 Tester-facing preconditions

What must be said plainly to outside testers, and what must be true before they get it.

**Onboarding (mandatory, not advisory).** Chunk 8 has landed, so rendering a chart now
persists it — but that only covers charts the tester actually paged to, and the Supabase
bulk warm that covers the rest is unobserved, so neither is checkable from the outside.
Every device must still do **one of these two** while online, at home, before leaving for
the gig:

1. **Run Offline Access → download, to completion, with zero failures.** Not "start it" —
   watch it finish and report no failures. It is the only path that both covers charts the
   tester has *not* opened **and reports whether it worked** — the automatic Supabase warm
   does the first but not the second, and legacy Drive charts get no automatic warm at all.
2. **Or pass an airplane-mode reopen test:** put the device in airplane mode, fully reopen
   the show, and confirm every chart comes up. This proves the floor instead of assuming it.

**v6 correction (Codex R5 HIGH-1), retained as the reason this section exists:** v5 asked
testers to "open the show and confirm charts render," on the theory that rendering proves the
cache is warm. At the time it did not — the render path read the cache but never wrote it.
Chunk 8 has since made rendering persist, so v5's *instruction* now happens to hold for any
chart actually rendered; its *reasoning* was still wrong when written, and the error class —
a tester-facing claim written without checking it against shipped code — is what the §9
mechanism rule guards. Do not read chunk 8 as a licence to reinstate "open the show once":
that phrasing was wrong then for the write path and is wrong now for coverage.

The most likely tester failure is still not exotic venue networking — it is skipping, or
half-doing, this step. Chunk 8 made the step smaller, not optional.

**The stated requirement:** conductor mode needs working internet at the venue for the whole
show. One member's phone hotspot is a fully supported answer (§1 on-ramps) — frames are
tiny; it is continuity, not bandwidth, that matters.

**Named venue risks — all of these look like "there is Wi-Fi" and behave like a dead
network:**
- **Captive portals** — per-device sign-in, very common in bars. Every device must complete it.
- **Client isolation** — devices cannot see each other. Harmless to us (we are a star, not a
  mesh), and worth noting as the reason §9.4 would not have helped.
- **An AP with no backhaul** — buys nothing (§9.2).

**What to promise:** if the internet drops, nobody loses their charts; they lose the moving
redline and shared navigation until signal returns, then rejoin and re-sync. That is the
honest, and genuinely decent, floor.

### 9.6 Sequencing note

The parked phone retest gates this. Until conductor mode is verified working end-to-end on
Graham's own phone, handing it to outside testers measures onboarding, not transport.
Retest first, then §9.3, then testers.
