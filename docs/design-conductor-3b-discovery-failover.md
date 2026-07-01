# Conductor Authority — 3b transport: discovery + claim/failover (§8.2-2 resolution)

**Status:** v1 — DESIGN-ONLY, pre-Codex. Resolves the epic's last open item
(`docs/design-conductor-authority.md:214` — §8.2-2 *"Failover + session discovery on a
backhaul-less relay: the `claim` protocol details (how a new MD is discovered + accepted
post-MD-death), room discovery (QR to relay / mDNS / room code)"*). On GO this flips
§8.2-2 → resolved in the epic doc, unlocking chunk 3b (transport) build chunking.
**Date:** 2026-07-01
**Branch:** `opus/design-conductor-3b-discovery`
**Parent:** `design-conductor-authority.md` §4 (single-writer/epoch), §5 (band-owned AP +
relay-as-arbiter), §6 (state-mirror, no event replay). Sibling:
`design-conductor-chunk5b-clock.md` (resolved §8.2-1 the same way — question → decisions →
flip on GO).

---

## 0. The question (verbatim, §8.2-2)

> Failover + session discovery on a backhaul-less relay (§4/§5) [gates chunk 3 transport]:
> the `claim` protocol details (how a new MD is discovered + accepted post-MD-death), room
> discovery (QR to relay / mDNS / room code).

Everything MD-local is shipped: the pure reducer (chunk 3a, `lib/conductor-state.ts`), the
single-device controller (chunk 4, `lib/conductor-session.ts`), the clock layer + 4a shadow
detector. The one remaining seam is explicit in shipped code:

> "`dispatch` mints a message, applies it through `reduceConductor`, and keeps the result.
> **That mint+loopback is the seam 3b replaces with the real fan-out.**"
> — `lib/conductor-session.ts:17`

This doc designs everything between that seam and a follower's screen: the relay, the room,
the join, the claim, and the death of an MD. It does **not** re-open the reducer — chunk 3a's
admission contract is the fixed ground this protocol is built to satisfy.

### 0.1 The fixed ground (shipped, not relitigated)

| Contract | Where | What 3b must honor |
|---|---|---|
| Messages are deltas; admission is contiguous (`seq === state.seq+1`); any gap → `needsSnapshot` | `conductor-state.ts:201-203` | Transport may drop/reorder freely; the ONE recovery door is a snapshot pull |
| `claim` is a snapshot boundary, never a follower-applied delta; higher-epoch claim → `needsSnapshot`, equal/lower → ignored | `conductor-state.ts:189-193` | The new MD mints the new generation OUT OF BAND; the relay serves it as the snapshot |
| Future non-claim epoch → `needsSnapshot` (missed-claim vs forgery indistinguishable locally; "forgery is rejected by the relay (3b)") | `conductor-state.ts:197-199` | **Sender authenticity is the relay's job** — the reducer only scopes |
| Envelope self-scopes (sessionId/songRef/programHash); reducer fails closed cross-room/-revision | `conductor-state.ts:176-184` | The relay does NOT need to understand payloads to keep rooms honest |
| Single seq-issuer = the MD (`dispatch`, epoch held, seq+1) | `conductor-session.ts:61-88` | Exactly one writer connection per room, relay-enforced |
| Per-device offline floor: no transport ⇒ self-drive; detach/resync local-only | epic §4/§5 | Transport is load-bearing for togetherness ONLY — every failure degrades to Concept A |

---

## 1. The crux nobody named: secure context on a dead network

Before QR-vs-mDNS matters, there is a browser-platform wall:

1. **Mixed content:** the app is an https-origin PWA (showrunr.ai). Browsers **block `ws://`
   (insecure WebSocket) from an https page** — so "just connect to `ws://192.168.x.x:8787`"
   does not work at all from the installed app.
2. **Secure context:** serving the app from the relay over plain `http://<LAN-IP>` avoids
   mixed content but loses the service worker (SW registration requires a secure context) —
   no offline cache, no PWA install, and a fresh full load on every join.
3. **No backhaul** means no public DNS and no on-the-fly certificate issuance at the venue.

mDNS does not rescue this (a `.local` name is still not a secure origin, and iOS-browser
mDNS resolution is unreliable anyway — rejected, see D2). The workable answers:

- **(a) Pre-provisioned certificate + local DNS override (CHOSEN).** The relay box carries a
  real, publicly-valid certificate for a dedicated name (e.g. `relay.showrunr.ai`), obtained
  via a DNS-01 challenge **at home, while the box has internet** (Let's Encrypt, ~90-day
  renewal as a pre-gig checklist item). The band AP's DHCP/DNS answers `relay.showrunr.ai`
  with the relay's LAN IP. At the venue: the PWA (already installed + SW-cached from its real
  origin) opens `wss://relay.showrunr.ai:8787` — valid cert, secure context, no warnings, no
  backhaul needed. This is the established local-HTTPS pattern (Plex et al.).
- **(b) Plain-http relay-served page (DEGRADE, kept).** The relay also serves a minimal
  join page over `http://<LAN-IP>` for a device that never pre-installed the PWA. No SW, no
  offline — but a guest sub can still follow along. Explicitly a degrade, never the design
  center.
- **(c) Self-signed cert — REJECTED** (per-device trust warnings, iOS actively hostile).
- **(d) WebRTC data channels — REJECTED for v1** (signaling needs a working channel first —
  chicken-and-egg on a dead network; and it buys nothing over a working `wss://` star).

**Consequence for the product:** joining a session presumes the member **installed the PWA
while online** (at home — same place they load their charts). The venue flow never needs
backhaul; the *provisioning* flow (cert renewal, PWA install, chart sync) is a documented
at-home checklist. This matches the §5 philosophy: transport depends on nothing the venue
provides — and on a few things the band prepares.

## 2. Topology + roles

```
            band-owned AP (pocket router)
                     │  (DNS: relay.showrunr.ai → LAN IP)
              ┌──────┴──────┐
              │  relay box  │  tiny Node service: wss star + arbiter
              └──────┬──────┘
      ┌────────┬─────┴─────┬──────────┐
     MD      follower   follower   follower     (PWAs, offline-cached)
   (writer)  (mirror)   (mirror)   (mirror)
```

- **Relay = dumb star + baton arbiter.** It fans out writer messages verbatim, enforces
  *who may write*, arbitrates *claims*, and forwards *snapshot requests*. It never parses
  `ConductorMessage.payload`, never runs the reducer, never stores musical state beyond an
  opaque cached snapshot blob (D6). Schema-agnostic by design: relay deploys must not couple
  to app releases.
- **Room = one show** (grain: `show-slug`). One relay, one room live at a time in practice,
  but rooms are cheap and keyed — two bands sharing a rehearsal space don't collide. Within
  a room, per-song sessions are already self-scoped by the envelope (`sessionId`/`songRef`,
  fixed ground) — the relay does not track songs.
- **Writer = a connection, not a credential.** The relay records which *connection* holds
  the baton (epoch N). Only that connection's `msg` frames fan out; anyone else's are
  rejected with `not-writer`. This is the "forgery rejected by the relay" line the reducer
  comment promises (`conductor-state.ts:198`) — possession-based, no crypto identity in v1
  (D5: joining the band's private AP + knowing the room code *is* the trust boundary).

## 3. Discovery (how a phone finds the room)

- **D1. Join token = QR + short room code fallback (CHOSEN).** The MD (or whoever runs the
  box) opens the session; the app displays a QR encoding
  `https://showrunr.ai/join?relay=wss://relay.showrunr.ai:8787&room=<slug>&code=<XYZW>`
  plus the 4-char code in large type. Scanning opens the (cached) PWA straight into the join
  flow; a member who can't scan types the code into the app's Join screen (the app tries the
  well-known relay name). The relay admits a `hello` only with the current room code —
  that's the bouncer, not cryptography.
- **D2. mDNS — REJECTED.** Unreliable in iOS browsers, adds zero over a pinned DNS name on
  our own AP (§1a already gives us a stable name), and can't carry the room code.
- **D3. Room codes rotate per show** (generated at room-create, shown beside the QR). Stale
  QR screenshots from last week don't admit.

## 4. The claim protocol (baton lifecycle)

The relay is the single arbiter (epic §5: "first claim at epoch N+1 wins"). The state it
keeps per room is tiny: `{ epoch, writerConn | null, roomCode, snapshotCache }`.

### 4.1 Normal claim (session start, or deliberate handoff)
1. Device sends `claim-request`.
2. Relay grants iff the baton is **free** (no writer) or **orphaned** (§4.2). Grant:
   `epoch := epoch+1`, `writerConn := this connection`, reply `claim-grant {epoch}`.
   Anyone else concurrently claiming gets `claim-denied {epoch}` (relay is a single
   process; requests serialize — no tie to break).
3. **The new MD mints the new generation out of band** (fixed ground): a new pure helper
   `acceptBaton(session, grantedEpoch, now)` in `conductor-session.ts` — epoch := granted,
   seq := 0, its OWN authoritative vm/current/clock, armed := null. It uploads this state
   as `snapshot {state}` to the relay (cache, §D6) and broadcasts a `claim` message.
4. Followers reduce the `claim`: higher epoch → `needsSnapshot` (shipped path,
   `conductor-state.ts:189-191`) → they pull → they mirror the new generation. A follower
   that missed the claim entirely hits the future-epoch door on the next delta
   (`:197-199`) — same recovery, by construction.
5. A **deliberate handoff** ("you conduct the next set") is the same flow with the old MD
   releasing first (`release-baton`), so the grant needs no orphan wait.

### 4.2 MD death (the failover)
- **Detection = lease.** The writer connection heartbeats (app-level `hb` frame every
  `HB_MS`, default 2000). The relay marks the baton **orphaned** after `HB_MISS` (default 3)
  consecutive misses (~6s) — or instantly on clean WS close.
- **On orphan, the relay broadcasts `conductor-lost`.** Followers show the banner and are
  *already* self-driving correctly: no new deltas are arriving, and the per-device redline
  floor (epic §4 "MD device dies → everyone falls to self-drive") needs no message to keep
  playing. `conductor-lost` is honesty UI, not a mechanism.
- **Re-claim = §4.1 against an orphaned baton.** Whoever taps "Take the baton" (confirm
  dialog — D4) claims; epoch bumps; the room converges on the new MD. Musically this is
  exactly the stage reality: the band keeps playing, someone picks up the baton.
- **The zombie MD:** the old MD reconnects believing it's the writer. Its connection is not
  `writerConn`, so its `msg` frames bounce with `not-writer {epoch}` → the client demotes
  itself to follower UI and pulls a snapshot. Its stale directives never reach a follower —
  **split-brain is structurally impossible at the relay** (and even a hypothetically leaked
  stale message dies at every reducer's epoch gate; belt and suspenders).

### 4.3 Who may claim
- **D4. Any joined device, behind a confirm dialog (CHOSEN).** On stage, whoever can grab
  the baton must be able to (the owner's phone may be the dead one). Guarding with roles
  would trade a real failure mode for a ceremonial one. The confirm dialog ("Take the baton?
  You'll conduct everyone's charts") prevents pocket-claims; the claim is also loudly
  attributed in every follower's banner ("Rachel is conducting").

## 5. Snapshot service (the one recovery door, served)

- **D6. Forward-to-MD, with the claim-time snapshot as a stale-marked cache (CHOSEN).**
  A follower whose reducer returns `needsSnapshot` sends `snapshot-request {sessionId}`.
  The relay forwards it to the writer; the MD's client replies `snapshot {state}` (its
  authoritative `ConductorState` — already fully serializable, fixed ground); the relay
  routes it back. The relay also keeps the **last uploaded claim-time snapshot** and serves
  it flagged `stale: true` **only** when there is no live writer (join-during-orphan:
  better an honest stale mirror + self-drive than nothing). A `snapshot-request` pending
  when the writer orphans is answered the same way (stale cache) — a request never hangs.
  - Why not relay-side reduction to keep a live snapshot? The relay would need the compiled
    program (`programHash` coupling) and every reducer version — the dumb-relay property
    (§2) is worth more than saving the MD ~N replies. Band-sized N (≤ ~10) makes the
    forward path trivially cheap.
- **Late-join = the same door.** `hello` → joined → `snapshot-request` → mirror deltas from
  there. No event replay anywhere (epic §6), so the relay buffers nothing.

## 6. Wire protocol (control plane)

Client↔relay frames (JSON over one `wss://` socket). The `msg` frame body is the shipped
`ConductorMessage` — untouched, opaque to the relay.

```
→ hello            { room, code, deviceLabel }            // join; bounced on bad code
← joined           { epoch, writer: boolean, hasWriter }  // you're in; current authority facts
→ claim-request    {}
← claim-grant      { epoch }                              // you are the writer; mint via acceptBaton
← claim-denied     { epoch }                              // someone else holds/won it
→ release-baton    {}                                     // deliberate handoff
→ msg              { msg: ConductorMessage }              // writer only; fans out to the room
← msg              { msg: ConductorMessage }              // fan-out delivery
← not-writer       { epoch }                              // your msg bounced; demote + snapshot
→ snapshot-request { sessionId }
← snapshot-needed  { sessionId, requestId }               // relay→writer: someone needs state
→ snapshot         { requestId?, state }                  // writer→relay (reply or claim-time upload)
← snapshot         { state, stale: boolean }              // relay→requester
→ hb               {}                                     // writer lease heartbeat
← conductor-lost   {}                                     // baton orphaned; honesty UI
← claim            —                                      // (not a control frame: the claim
                                                          //  ConductorMessage rides `msg` as normal)
```

Relay-enforced rules, complete: (1) `hello` requires the room code; (2) `msg` and
`snapshot` accepted only from `writerConn`; (3) `claim-request` granted only on free/orphaned
baton; (4) epoch is assigned by the relay, monotonic per room, **persisted across relay
restarts** (a relay reboot must not reissue epoch N — journal `{room, epoch}` to disk).
Only `msg` fans out; every other frame is point-to-point routing per the table above.

## 7. Failure matrix (every row degrades to self-drive, never to wrong)

| Failure | Detection | Behavior |
|---|---|---|
| Follower drops WS | its own socket close | keeps playing (self-drive floor); on reconnect: `hello` → snapshot pull → mirror |
| Follower misses deltas (radio blip, no disconnect) | reducer seq-gap → `needsSnapshot` | snapshot pull; at most one wrong-position *display* interval bounded by pull RTT |
| MD drops WS / device dies | relay lease (§4.2) | `conductor-lost` → all self-drive → manual re-claim, epoch+1 |
| Zombie MD returns | relay `writerConn` check | `not-writer` → self-demote → follower |
| Relay box dies | all sockets drop | whole room self-drives (Concept A floor); relay reboot restores room, epoch journal prevents reuse; everyone rejoins via the same QR |
| Two simultaneous claims | relay serializes | one grant, one denial — no tie exists |
| Join during orphan | `joined { hasWriter: false }` | stale-marked snapshot (D6) + self-drive + claim affordance |
| Wrong-room / stale-code QR | code check at `hello` | bounced at the door; reducer scoping is the second wall |

## 8. Scope fence

- **3b-v1 is same-chart-file broadcast.** The shipped wire carries LOCAL barIds
  (`Armed.fireAt`, `Directive` targets) — meaningful when every device renders the same
  chart file, which chunk 4's sessionId grain (chart-file-id + show-slug) already assumes.
  The canonical `CanonicalRef` lift for cross-chart following (guitar chart vs horn chart)
  is **3c**, deliberately AFTER the transport exists — this protocol is position-payload-
  agnostic, so nothing here changes when the payload goes canonical.
- **No write-back, no persistence of live state** (epic §7) — the relay's snapshot cache is
  ephemeral room state, wiped with the room.
- **No crypto identity in v1** (D5). AP possession + room code + writer-connection is the
  trust model; revisit only if the product leaves the band-owned-AP topology.
- **Native wrapper / push notifications** (epic §5 note) — out of scope here.

## 9. Open questions (defer-with-default)

1. **Relay runtime/hardware:** default = a single-file Node script (`ws` only dep) that runs
   on anything — pocket-router-adjacent Pi, or a laptop. Hardware pick is a UAT/ops question,
   not architecture.
2. **Lease constants:** `HB_MS`=2000, `HB_MISS`=3 (~6s to orphan). Feels right for "a song
   doesn't fall apart in one bar"; tune at UAT.
3. **Cert operations:** accept the §1a pre-gig renewal checklist (cert + PWA install + chart
   sync all live in the same "before you leave the house" list)?
4. **Room-code UX:** 4 chars, per-show rotation (D3) — enough? (Threat is a bored neighbor,
   not an adversary.)

## 10. Build outline (after sign-off — design-first, not building)

Gated commits, Codex per chunk; each demonstrable.

1. **Pure protocol lib** (`lib/relay-protocol.ts`): control-frame types + the client-side
   connection state machine (joining → follower → writer → demoted; snapshot-pull loop as a
   pure reducer over frames). Tests: every §7 row as a frame-sequence case; zombie-demote;
   claim/deny; contiguity resume after pull.
2. **`acceptBaton`** (pure, `conductor-session.ts`): mint the new generation (epoch :=
   granted, seq 0, own vm/current/clock, armed null). Tests: follower on old epoch converges
   via claim→needsSnapshot→snapshot; equal/lower claim ignored.
3. **The relay service** (`relay/` — Node + `ws`, no app imports): room registry, code check,
   writer enforcement, lease, epoch journal, forward paths. Tests: integration over real
   sockets (loopback), the §7 matrix again end-to-end.
4. **Client binding**: `use-conductor-session` grows the fan-out seam (dispatch → also emit
   `msg`), the mirror path (incoming `msg` → reduce → needsSnapshot → pull), and the
   claim/demote UX state. The 5b clock stays MD-local (its wire `clock` re-emit already
   exists as a payload).
5. **Join/QR + failover UI**: join screen, QR render, conductor-lost banner, "Take the
   baton" confirm, "X is conducting" attribution.
6. **Provisioning docs/tooling**: cert issue/renew script + the at-home checklist.

## 11. Test plan spine

Pure-first (chunks 1–2 carry the bulk): frame-sequence tables driving the client state
machine + reducer together — join/late-join, gap→pull→resume, claim happy-path, orphan
re-claim, zombie demote, join-during-orphan stale snapshot, cross-room bounce. Relay
integration (chunk 3) re-runs the same tables over real sockets. UI chunks assert the
banner/affordance renders per connection state (jsdom, existing harness patterns).
