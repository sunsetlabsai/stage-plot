# Conductor Authority — 3b transport: discovery + claim/failover (§8.2-2 resolution)

**Status:** v3. Build state tracked in `docs/INDEX.md`, not here. Codex R1 folded (3 HIGH + 2 MED — ONE systemic gap: session
identity was missing from the control plane; fixed with the writer-announced `session`
blob). Codex R2 folded (1 HIGH + 2 MED): session identity is now the FULL reducer-scope
triple `SessionKey = {sessionId, songRef, programHash}` end to end — the R1 fold had
quietly re-weakened it to `sessionId` alone on the snapshot path; also `activeSession` is
explicitly nullable, and song-change epoch semantics pinned (baton epoch inherited,
per-session seq restarts at 0). **Codex R3 = GO** (one non-blocking note folded: live-writer
snapshot requests off the active key get `snapshot-none` immediately, never forwarded —
§5, tested in chunks 1/3). Resolves the epic's last open item
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
- **(b) Plain-http relay-served STATUS page (DEGRADE, honestly rescoped — Codex R1 MED-2).**
  The relay can serve a tiny self-contained page over `http://<LAN-IP>` for a device that
  never pre-installed the PWA. On a backhaul-less network that device has NO app shell and
  NO chart assets, so "follow along" on the chart would be a lie — the degrade is a
  **text-only position view** (song / section / bar / conductor banner) bundled INTO the
  relay binary, fed by the same frames. Optional, last build chunk, cut-eligible. The
  design center remains: members install + sync at home.
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
  a room, per-song sessions are self-scoped by the envelope (`sessionId`/`songRef`, fixed
  ground). The relay never *interprets* songs — but it holds ONE opaque **active-session
  blob** per room, announced by the writer via the `session` frame (§4.4/§6, stored +
  rebroadcast verbatim). **Session identity in this protocol is the FULL reducer-scope
  triple — `SessionKey = {sessionId, songRef, programHash}` — everywhere** (Codex R2 HIGH:
  the shipped reducer fails closed on a mismatch of ANY of the three,
  `conductor-state.ts:176-184`; `sessionId` alone is chart/show-grained while `programHash`
  changes on recompile/recalibration, so a sessionId-only match could serve a snapshot the
  reducer — or the local program — then rejects). Discovery and snapshot recovery are
  *session*-scoped, so the room-grained control plane must be able to say **which**
  session is live (Codex R1 HIGH-1) — without it a late joiner cannot know which
  `SessionKey` to request, which chart to open, or whether a cached snapshot is even for
  the current song.
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
  that's the bouncer, not cryptography. **`joined` returns the room's `activeSession`**
  (§6), so a late joiner's app can open the right chart and request the right snapshot
  without hunting — the join token itself stays session-free (sessions churn per song;
  the QR must not).
- **D2. mDNS — REJECTED.** Unreliable in iOS browsers, adds zero over a pinned DNS name on
  our own AP (§1a already gives us a stable name), and can't carry the room code.
- **D3. Room codes rotate per show** (generated at room-create, shown beside the QR). Stale
  QR screenshots from last week don't admit.
- **Room create = the FIRST `hello`** (pinned at chunk 3): there is no separate create
  frame — the opening device generates the slug + code app-side, and its `hello` for an
  unknown room creates it (epoch 0, journaled) with that code as the door. Later `hello`s
  must match the journaled code. A typo'd room name at join therefore creates a phantom
  room rather than bouncing — benign on a band-owned relay (rooms are keyed; the code
  still guards the real one), and it keeps the relay one-frame dumb. One `hello` per
  connection: a re-`hello` on an admitted connection is bounced (a second admit would
  double-enroll the connection across rooms — a fan-out leak).

## 4. The claim protocol (baton lifecycle)

The relay is the single arbiter (epic §5: "first claim at epoch N+1 wins"). The state it
keeps per room is tiny: `{ epoch, writerConn | null, roomCode, activeSession:
SessionKey | null, snapshotCache: { key: SessionKey, state } | null }`. `activeSession`
is **null** until the first writer announcement and again after a relay reboot (the
journal restores identity, not liveness — Codex R2 MED-1); clients seeing null render
"waiting for a conductor", self-drive, and offer the claim affordance — there is no
session to request a snapshot for.

### 4.1 Normal claim (session start, or deliberate handoff)
1. Device sends `claim-request`.
2. Relay grants iff the baton is **free** (no writer) or **orphaned** (§4.2). Grant:
   `epoch := epoch+1`, `writerConn := this connection`, reply `claim-grant {epoch}`.
   Anyone else concurrently claiming gets `claim-denied {epoch}` (relay is a single
   process; requests serialize — no tie to break).
3. **The new MD mints the new generation out of band** (fixed ground): a new pure helper
   `acceptBaton(session, grantedEpoch, now)` in `conductor-session.ts` — epoch := granted,
   seq := 0, its OWN authoritative vm/current/clock, armed := null (a telegraphed cue was
   the old MD's intent; never inherited). It also mints and returns the `claim`
   ConductorMessage to broadcast — `dispatch` can't (claim is a snapshot boundary, not a
   delta: handled entirely in reducer admission, seq ignored — so it rides seq 0 and
   consumes no seq). The binding then (re-)announces `session {SessionKey}` (idempotent
   mid-song — same key), uploads this state as `snapshot {state}` to the relay (cache,
   §D6), and broadcasts the claim.
4. Followers reduce the `claim`: higher epoch → `needsSnapshot` (shipped path,
   `conductor-state.ts:189-191`) → they pull → they mirror the new generation. A follower
   that missed the claim entirely hits the future-epoch door on the next delta
   (`:197-199`) — same recovery, by construction. **Scope caveat (Codex R1 MED-1):** the
   reducer's scope gate runs BEFORE claim handling (`conductor-state.ts:176-184`) — a
   `claim` from a *different* session is IGNORED, not rebased. So claims converge only
   *within* a session; a follower on the wrong/old session gets moved by the `session`
   frame (§4.4), never by a claim. The client binding (build chunk 4) gates the claim UI
   and snapshot adoption on matching `activeSession` metadata.
5. A **deliberate handoff** ("you conduct the next set") is the same flow with the old MD
   releasing first (`release-baton`). **The relay treats a release as an INSTANT orphan**
   (Codex chunk-3 HIGH-2): baton freed, `conductor-lost` broadcast, pending requests
   drained — without the broadcast no follower's `hasWriter` ever clears, so the claim
   affordance (`follower && !hasWriter`) never opens and the released baton is unreachable
   through the client machine (a permanently headless room — release has no lease to
   lapse). "No orphan wait" still holds: the baton is free immediately and the first
   claim wins; and the honesty frame is honest — no one is conducting until the next
   grant.

### 4.2 MD death (the failover)
- **Detection = lease.** The writer connection heartbeats (app-level `hb` frame every
  `HB_MS`, default 2000). The relay marks the baton **orphaned** after `HB_MISS` (default 3)
  consecutive misses (~6s) — or instantly on clean WS close.
- **On orphan, the relay broadcasts `conductor-lost`.** Followers show the banner and are
  *already* self-driving correctly: no new deltas are arriving, and the per-device redline
  floor (epic §4 "MD device dies → everyone falls to self-drive") needs no message to keep
  playing. `conductor-lost` is honesty UI, not a mechanism.
- **The orphaned writer may hear its own funeral.** If the MD's connection is alive but
  lease-lapsed (e.g. app backgrounded), the relay's `conductor-lost` broadcast reaches it
  too. The pure client machine **fails safe**: a believed-writer that receives
  `conductor-lost` self-demotes to follower (invariant: `phase === 'writer'` ⇒ this
  connection is the relay's `writerConn`). It does *not* pull a snapshot — there is no
  live writer to resync from, and its own local state is the freshest in the room; it may
  simply re-claim (§4.3). Its next `msg` would bounce `not-writer` anyway — belt and
  suspenders.
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

### 4.4 Session switch (song change — the flow v1 forgot to write down)

A **switch is any change to any field of the `SessionKey`**: the next song mints a new
`sessionId` (chunk 4's grain), but a mid-song recompile/recalibration changes
`programHash` with the SAME sessionId — and per the reducer's scope gate that is just as
much a new session (Codex R2 HIGH corollary; this case is invisible if identity is
sessionId-only). The MD announces `session {SessionKey}`; the relay **replaces** the
room's active-session blob, **drops the previous key's snapshot cache**, and broadcasts
the frame. Followers switch charts locally, then pull the new session's snapshot.
**Epoch semantics (Codex R2 MED-2):** the baton epoch is relay-owned and *orthogonal to
sessions* — a same-baton switch **inherits the current epoch** (epoch = baton generation,
per the parent design; it bumps only on claim), while `seq` restarts at 0 per session
(the reducer's contiguity check is per-session state, so this is well-formed). Ordering
is safe by construction: the writer sends `session` before any `msg` for it on ONE ordered
socket, and the relay fans out per-connection FIFO — and even a follower that reduces a
new-session `msg` before switching just *ignores* it at the scope gate (fixed ground),
then recovers via the post-switch snapshot pull. **Chart-not-synced honesty (own-sweep
finding):** if `activeSession.songRef` isn't in the joiner's local chart store, perfect
session metadata still can't render a chart — show an honest "chart not on this device"
banner (chart sync is at-home provisioning, §1); never a blank or wrong chart.

## 5. Snapshot service (the one recovery door, served)

- **D6. Forward-to-MD, with the claim-time snapshot as a stale-marked cache (CHOSEN).**
  A follower whose reducer returns `needsSnapshot` sends `snapshot-request {session:
  SessionKey}`. **The relay forwards it to the writer ONLY if the request's key fully
  equals `activeSession`** — otherwise it answers `snapshot-none` immediately, without
  bothering the writer (Codex R3 note: the requester is on a dead session; the `session`
  frame, not a snapshot, is what moves it). On a match, the MD's client replies
  `snapshot {state}` (its authoritative `ConductorState` — already fully serializable,
  fixed ground); the relay routes it back. The relay also keeps the **last uploaded
  snapshot, tagged with its full `SessionKey`** (claim-time upload; dropped on `session`
  change, §4.4) and serves it flagged `stale: true` **only** when there is no live writer
  AND **every field** of the request's key matches the tag (Codex R1 HIGH-2 + R2 HIGH — an
  untagged cache could hand a joiner the *previous song's* state, and a sessionId-only tag
  could hand it same-chart state from an **older `programHash`**, which the reducer/local
  program then reject; "opaque payload" never meant "unidentified payload"). Any mismatch →
  `snapshot-none`; the requester self-drives. A `snapshot-request` pending when the writer
  orphans is answered the same way — matching stale cache or `snapshot-none`; a request
  never hangs. Belt and suspenders: the client ALSO verifies the adopted state's
  `sessionId`/`songRef`/`programHash` (the same three fields the reducer scopes on) against
  its request before adopting any snapshot, so a buggy relay can't cross-feed sessions.
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
← joined           { epoch, hasWriter,                    // you're in; authority facts +
                     activeSession: SessionKey | null }   //  which session is live (HIGH-1);
                                                          //  null = none announced yet (§4).
                                                          //  No `writer` field: writer is a
                                                          //  CONNECTION, and `joined` only ever
                                                          //  answers a fresh connection, which
                                                          //  by definition is not writerConn
→ session          { session: SessionKey }                // writer only; relay stores+broadcasts
← session          { session: SessionKey }                // switch: change chart, pull snapshot
→ claim-request    {}
← claim-grant      { epoch }                              // you are the writer; mint via acceptBaton
← claim-denied     { epoch }                              // someone else holds/won it
→ release-baton    {}                                     // deliberate handoff — relay treats
                                                          //  as instant orphan (conductor-lost)
→ msg              { msg: ConductorMessage }              // writer only; fans out to the room
← msg              { msg: ConductorMessage }              // fan-out delivery
← not-writer       { epoch, activeSession }               // your msg bounced; demote + resync
→ snapshot-request { session: SessionKey }
← snapshot-needed  { session: SessionKey, requestId }     // relay→writer: someone needs state
→ snapshot         { requestId?, state }                  // writer→relay (reply or claim-time upload)
← snapshot         { state, stale: boolean }              // relay→requester (full-key-checked, §5)
← snapshot-none    { session: SessionKey }                // nothing valid for that key; self-drive
→ hb               {}                                     // writer lease heartbeat
← conductor-lost   {}                                     // baton orphaned; honesty UI
← claim            —                                      // (not a control frame: the claim
                                                          //  ConductorMessage rides `msg` as normal)
```

The relay treats the `SessionKey` as an opaque blob it stores and rebroadcasts verbatim;
its ONLY operation on it is field-wise string equality across **all three fields** (never
sessionId alone — Codex R2 HIGH) — dumbness preserved, identity complete.

Relay-enforced rules, complete: (1) `hello` requires the room code; (2) `msg`, `session`,
and `snapshot` accepted only from `writerConn`; (3) `claim-request` granted only on
free/orphaned baton; (4) the **room registry is journaled to disk as
`{room, roomCode, epoch}`** — epoch is relay-assigned and monotonic per room (a reboot must
not reissue epoch N), and the roomCode must survive the same reboot or the failure matrix's
"same QR readmits" promise is false (Codex R1 HIGH-3: journaling epoch alone would bounce
every rejoining `hello` at the code check). The snapshot cache is deliberately NOT
journaled — ephemeral, honest-stale at best. Only `msg`, `session`, and `conductor-lost`
fan out; every other frame is point-to-point routing per the table above. (5) **The socket
is a trust boundary**: every inbound frame is shape-validated per type BEFORE the reducer
(`parseClientFrame`, chunk-3 HIGH — unknown types and fieldless known types close 4002,
never crash); validation stays as dumb as the relay — `msg` bodies are never deep-parsed,
and a `snapshot` state is checked only for the identity triple the relay itself reads.
The client binding mirrors this for relay frames (chunk 4).

## 7. Failure matrix (every row degrades to self-drive, never to wrong)

| Failure | Detection | Behavior |
|---|---|---|
| Follower drops WS | its own socket close | keeps playing (self-drive floor); on reconnect: `hello` → snapshot pull → mirror |
| Follower misses deltas (radio blip, no disconnect) | reducer seq-gap → `needsSnapshot` | snapshot pull; at most one wrong-position *display* interval bounded by pull RTT |
| MD drops WS / device dies | relay lease (§4.2) | `conductor-lost` → all self-drive → manual re-claim, epoch+1 |
| Zombie MD returns | relay `writerConn` check | `not-writer` → self-demote → follower |
| Relay box dies | all sockets drop | whole room self-drives (Concept A floor); reboot restores the room registry from the `{room, roomCode, epoch}` journal → **same QR readmits**, epoch never reused; `activeSession` restarts **null** and the snapshot cache is lost (identity persists, liveness doesn't) → rejoiners self-drive until the writer reconnects and re-announces |
| Two simultaneous claims | relay serializes | one grant, one denial — no tie exists |
| Join during orphan | `joined { hasWriter: false }` | stale-marked snapshot iff **every field** of its `SessionKey` tag matches the request (§5), else `snapshot-none` → self-drive + claim affordance |
| MD switches session (next song, OR mid-song recalibration = new `programHash`, same sessionId) | `session` broadcast (§4.4) | switch/reload chart → pull the new key's snapshot; pre-switch new-key deltas ignored at the scope gate, recovered by the pull |
| Join before any writer has announced | `joined { activeSession: null }` | "waiting for a conductor" + self-drive + claim affordance; no snapshot to request |
| Joiner lacks the active chart file | local chart-store check vs `activeSession.songRef` | honest "chart not on this device" banner — never a blank or wrong chart; sync is at-home provisioning (§1) |
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

1. **Pure protocol lib** (`lib/relay-protocol.ts`): control-frame types (`SessionKey`,
   `session`, nullable `activeSession`, `snapshot-none`) + the client-side connection state
   machine (joining → follower → writer → demoted; session-switch + snapshot-pull loop as a
   pure reducer over frames). Tests: every §7 row as a frame-sequence case; zombie-demote;
   claim/deny; contiguity resume after pull; session-switch mid-mirror (incl. programHash-
   only change); snapshot mismatching on ANY of the three key fields rejected client-side;
   `activeSession: null` → no pull, waiting state.
2. **`acceptBaton`** (pure, `conductor-session.ts`): mint the new generation (epoch :=
   granted, seq 0, own vm/current/clock, armed null). Tests: follower on old epoch converges
   via claim→needsSnapshot→snapshot; equal/lower claim ignored; cross-session claim ignored
   at the scope gate (converges via `session` frame instead — MED-1).
3. **The relay service** (`relay/` — Node + `ws`, no app imports): room registry, code check,
   writer enforcement, lease, `{room, roomCode, epoch}` journal, nullable active-session
   blob, **full-`SessionKey`-tagged** snapshot cache, forward paths. Tests: integration over
   real sockets (loopback), the §7 matrix again end-to-end — including reboot-readmit (same
   code, epoch monotonic, activeSession null), stale-cache mismatch on each key field
   individually → `snapshot-none`, and **live-writer request off the active key →
   `snapshot-none` immediately, writer never receives `snapshot-needed`** (Codex R3 note).
4. **Client binding**: `use-conductor-session` grows the fan-out seam (dispatch → also emit
   `msg` + announce `session` on start/switch — including on recompile/recalibration, since
   a new `programHash` IS a switch, §4.4), the mirror path (incoming `msg` → reduce →
   needsSnapshot → pull), the session-switch path (`session` frame → chart switch → pull;
   same-baton switch inherits epoch, seq restarts at 0), and the claim/demote UX state —
   claim UI + snapshot adoption gated on the full matching `SessionKey`. The 5b clock stays
   MD-local (its wire `clock` re-emit already exists as a payload).
5. **Join/QR + failover UI**: join screen (auto-open `activeSession`'s chart; "chart not on
   this device" honesty), QR render, conductor-lost banner, "Take the baton" confirm,
   "X is conducting" attribution.
6. **Provisioning docs/tooling**: cert issue/renew script + the at-home checklist.
7. *(Optional, cut-eligible)* **Relay-served text-only guest status page** (§1b as
   rescoped) — song/section/bar + conductor banner, no chart render.

### Build pins — chunk 4 (client binding), folded back post-build

Decisions made while building chunk 4, now canonical:

- **Architecture: a second pure layer** (`lib/relay-binding.ts`) between the frozen chunk-1
  conn machine and the hook. It owns exactly the gates the machine cannot know because they
  depend on the device's LOCAL chart (`localKey`): mirror/adopt only when `localKey`
  field-wise equals the room's key (`reduceConductor` throws by design on a hash mismatch —
  a mismatch is the honest `chartMismatch` fact, never a throw), claim gated on having a
  chart, the writer's §4.4 re-announce, and the §4.1-3 grant order (announce → snapshot
  upload → claim) pinned purely via feedback inputs (`baton-accepted`, `serve-state`,
  `mirror-outcome`). The hook executes effects against its ONE `ConductorSession` and the
  socket; nothing else.
- **`parseRelayFrame` depth = "validate what you read"** (the §6 rule-5 client mirror):
  frame fields plus the `ConductorMessage`/`ConductorState` ENVELOPE the reducer's admission
  path reads (identity triple, epoch/seq/sentAt numbers, `payload.kind` — which must be one
  of the KNOWN `ConductorPayload` discriminators, Codex chunk-4 R1 MED: the reducer's switch
  is exhaustive over them, so an unknown kind is dropped at the boundary rather than falling
  off the switch; the mixed-version heal is the designed one — the next delta's seq gap →
  `needsSnapshot` → pull). Payload BODIES and a snapshot's vm are deliberately NOT
  deep-validated — they originate from another instance of this app on the band trust plane
  (§8/D5), the same plane on which a snapshot's vm is adopted wholesale. Garbage is DROPPED
  client-side (`bad-frame`), not closed — the relay is our box; a bad frame off it is a bug
  to survive, not a peer to eject.
- **`dispatch` returns the minted `msg` iff it APPLIED** (the fan-out seam). A rejected mint
  is never returned — fanning out a message the writer's own reducer refused would hand
  followers a delta their mirrors also refuse.
- **Follower hard gate on local dispatch**: with a relay bound and phase `follower`, local
  gestures/clock do NOT dispatch — the wire is the session's one writer; a local dispatch
  would burn seq numbers the mirror never saw and freeze it silently (`ignored` forever).
  `joining` is deliberately NOT blocked: the self-drive floor — an MD whose relay box died
  keeps conducting. A disconnected follower therefore CAN fork (self-drive mints local seqs
  the writer never saw); the fork is crushed at rejoin by the adoption rule below.
- **Snapshot adoption has TWO authority regimes**, told apart by the wire's `stale` flag
  (`shouldAdoptSnapshot`, Codex chunk-4 R1 HIGH). FRESH (`stale: false`) is authored by the
  room's LIVE writer answering this pull — THE authority within a session — and is adopted
  UNCONDITIONALLY: a follower that self-drove while offline holds coordinates on a FORK, not
  on the writer's timeline, so comparing them is meaningless, and rejecting the writer's
  snapshot would strand the device (every later delta lands `ignored`, a silently frozen
  mirror). The rejoin pull is mandatory (`joined` always pulls the active session), so fresh
  force-adoption is the fork-crushing door. STALE (`stale: true`) is the relay's claim-time
  cache, served only when NO writer is live — unattributed, so forward-only coordinates
  apply (`stateSupersedes`: higher epoch, or same epoch + higher seq). The load-bearing
  stale case: an EX-WRITER reconnects and its join-pull is answered by that cache, which is
  BEHIND the freshest state in the room (§4.2) — adopting it would rewind the one device
  that's right.
- **Chart-arrived-late heal**: a snapshot gated away by `localKey` consumed the machine's
  outstanding pull, so `local-ready` landing ON the active key force-feeds `needsSnapshot`
  to re-open it (pull is idempotent per key) — convergence now, not at the next delta's gap.
- **Writer epoch-inherit at re-key** (§4.4 mechanics): `initSession` mints epoch 0, so a
  writer's fresh session (next song / recompile) is rebased onto the relay grant
  (`conn.epoch`) BEFORE `local-ready` announces it; seq stays 0 (per-session restart).
- **`localKey` outlives the socket**: the conn machine resets on every (re)connect and
  teardown, but `localKey` tracks the SESSION lifecycle (`local-ready`/`local-gone` from the
  hook's identity effect) — wiping it on socket teardown would strand a config change or
  relay off→on toggle (identity unchanged ⇒ `local-ready` never re-fires).
- **Hook constants**: app heartbeat 1000ms (half the relay lease `HB_MS`); reconnect backoff
  flat 1500ms (the relay is the band's own box — the only recovery is it coming back).
- **Surface**: `relay: RelaySurface` on the conductor surface — `status off|connecting|joined`,
  `role local|writer|follower`, `canClaim`, `conductorLost`, `activeSession`,
  `chartMismatch`, `requestClaim()`, `releaseBaton()`. No relay configured = hard-coded OFF
  block (shipped single-device behaviour byte-for-byte). Chart navigation on
  `switch-session` and all banners are chunk 5.

## 11. Test plan spine

Pure-first (chunks 1–2 carry the bulk): frame-sequence tables driving the client state
machine + reducer together — join/late-join (activeSession-directed), gap→pull→resume,
claim happy-path, orphan re-claim, zombie demote, join-during-orphan stale snapshot
(full-key match) vs `snapshot-none` (mismatch on each field individually), session switch
(§4.4: new song AND programHash-only, incl. pre-switch delta ignored → recovered by pull),
cross-session claim ignored, `activeSession: null` waiting state, cross-room bounce. Relay
integration (chunk 3) re-runs the same tables over real sockets, plus reboot-readmit from
the journal (activeSession restarts null). UI chunks assert the banner/affordance renders per
connection state (jsdom, existing harness patterns), incl. chart-not-on-device honesty.
