# Conductor authority — live roadmap broadcast across N charts (design)

**Status:** **v3.1.** Build state tracked in `docs/INDEX.md`, not here. v2 closed Codex R1 NO-GO (9 findings → 3 roots → one move; §0); v3 closed the R2 GO-WITH-NITS items (§3.3/§3.4/§3.1 MED, OQ-2 provenance §2.2.1) → **Codex R3 = GO**; v3.1 closes the two chunk-1/2 gating decisions (§2.2.0 alignment ambiguity, §2.3.1 `barOffset` span-equivalence). Remaining open items gate later chunks only (§8.2).
**Date:** 2026-06-22
**Branch:** `opus/design-conductor-authority` (PR #87)
**Parent:** `design-realtime-chart-control.md` — detailed design of its **Concept B** (networked seek) + the tractable tier of **Concept C** (tempo-awareness). Resolves parent OQ #1 (B transport) + the C-tier split.
**Builds on:** the merged calibration editor (chunks 1–3), the nav-graph resolver `resolveRoadmap` (`lib/chart-calibration.ts:499`), the per-chart hash-keyed `(chart_id, source_hash)` sidecar + `draft|verified` lifecycle.

---

## 0. v2 reframe — the nine findings were one misplacement

Codex R1 (correct NO-GO) found that cross-chart identity and live-traversal semantics weren't closed enough to build. Re-read against the resolver, the nine findings collapse into **one mistake in v1: it put both the structural identity and the live VM at the *per-chart* layer** and tried to reconcile across charts at runtime. The fix is a single move:

> **Lift the structure *and* the live VM to a canonical song layer. The MD advances ONE canonical-roadmap VM; each chart is a pure renderer of canonical-position → local coordinates.**

| v1 finding | Root | Closed by |
|---|---|---|
| 1, 4 — label/ordinal isn't a stable cross-chart id; `barOffset` fragile | **A: identity** | §2 canonical structure map; label+ordinal demoted to a *seeding heuristic*; `barOffset` guarded by span-equivalence |
| 2, 3, 5 — re-entry isn't a `(barId,pass)` seek; continuation open; auto-fire on drift | **B: live VM** | §3 one canonical VM (resumable resolver) + B2 override model + §3.4 continuation rule + §3.5 auto-fire gate |
| 6, 7, 8 — hidden second writer; `seq` underspecified; split-brain | **C: authority/state** | §4 epoch + single seq-issuer + listener-as-telemetry; §5 relay-as-baton-arbiter; §6 deterministic MD-owned state machine |
| 9 — boundary enforcement hooks | (kept) | §7 explicit |

**v3 (Codex R2 GO-WITH-NITS) closes:** §3.3 "another round" is now a code-grounded clamp (`completedPasses := times-1`, a reachable VM state — never a freeze); §3.4 needs no separate exit computation (the extracted resolver's forward walk *is* the default exit); the "resumable resolver" MED is accepted as an **extracted VM core** (§3.1); OQ-2 provenance resolved to the hybrid model (§2.2.1). Architecture was signed off in R2; these were the pre-chunk-1/2 closures. **Codex R3 = GO.**

**v3.1 closes the two chunk-1/2 gating decisions:** §2.2.0 (partial alignment `local | tacet | unmapped`, degrade-precision-not-honesty) and §2.3.1 (`barOffset` honored only in a `bar-isomorphic` span). Plus the two R3 test-nuances folded into chunk 1/2 (§9): stable-id-preserving re-key, and inert already-`fired` D.S./D.C. on redirect. **Chunks 1–2 are GO.**

---

## 1. The problem

A single MD makes a realtime change — "another round of the solo," "back to the chorus," "to the coda," "cut the bridge." The whole band re-homes to **the same musical position**, but every member reads a **different chart** (their instrument/role), each with its own geometry, own roadmap markers, own coordinate space — and it must work in a **venue with no reliable network.** This adds *togetherness* on top of the existing per-chart redline; togetherness is the one property allowed to degrade gracefully (a disconnected device keeps following its own chart).

---

## 2. Canonical song structure — the shared identity (root A)

### 2.1 Why per-chart labels can't be the cross-chart authority
`resolveRoadmap(cal)` is pure over **one chart's** bars+markers; `barId`s are chart-local UUIDs. "The same place" across N charts therefore can't be a coordinate — and v1's "section by normalized label + ordinal on the wire" fails the exact common cases (`B` vs `Chorus 1`, missing tags, partial parts, collapsed multi-rests, different section counts). The only durable invariant is the **song's structure**, and it must be a **first-class object**, not reconstructed from each chart's labels at runtime. (This is your own "the roadmap is the common thread," promoted to an entity.)

### 2.2 The model
- **`SongStructure`** (song-scoped, one per song): the canonical roadmap — an ordered list of canonical sections + a canonical `RoadmapMarker[]` over canonical bars. Same marker model as a chart's roadmap (§`design-nav-graph.md`), just at the song level. This is what the live VM (§3) runs on.
- **Per-chart `alignment`** (on each chart's calibration): `localNode → canonicalNode` map (sections and, where structure matches, bars). Each chart **declares how it maps into the canonical structure.**
- **Authoring:** the converter *suggests* the alignment (label+ordinal + bar-count heuristics are the **seed**, not the authority); ambiguous mappings surface in the **existing review-queue pattern** for human confirm. A chart can't be a conductor *follower* for a song until its alignment is confirmed (else it self-navigates — §7).

### 2.2.0 Partial alignment — `tacet` vs `unmapped` (resolves §8.2-1)
**The governing spine for resolution: degrade *precision*, never *honesty* — bar → section → tacet → self-nav, but never land on a node the alignment didn't confirm.** Charts routinely disagree on section count (a horn tacets the bridge; a part omits a tag). So **alignment is per-section and may be partial.** Each canonical node maps to exactly one of:
- **`local`** — a confirmed local node. Resolves to local coords normally.
- **`tacet` (declared-absent)** — the player genuinely doesn't play that section. This is a **resolved** outcome, *not* an error: render "tacet — Bridge, back at Outro," hold position, **re-home at the next present section** when the cursor moves past. Musically exactly right (the horn rests, re-enters at the outro). Quiet/expected UI.
- **`unmapped` (ambiguous)** — the converter/owner genuinely can't place a local section (an extra repeat, an unidentifiable region). Goes to the **review queue**; until resolved, refs touching that region make **that member self-navigate** (§7). **Loud** UI — we honestly don't know where they go.

**Never block the whole chart:** a chart follows for every ref it can resolve (`local` or `tacet`); only `unmapped` refs trigger that one member's self-nav. **No auto-snap for `unmapped`** — a wrong guess is worse than honest self-nav. The *one* coarsening allowed is dropping bar-precision to section-precision **inside a confirmed alignment** (§2.3), which is degrading precision within a node we *did* confirm — not fabricating one.

### 2.2.1 Provenance of `SongStructure` (hybrid — resolves OQ-2)
The canonical structure is **not** authored from nothing, nor live-merged across charts. It's a **converter-proposed, owner-confirmed, once** entity:
1. **Converter proposes.** On first import for a song, the converter extracts a candidate canonical roadmap (its per-chart structural read becomes the seed).
2. **Owner confirms/edits once.** The song owner reviews the proposal → it becomes the **single authoritative `SongStructure`**. One human-confirmed source of truth → **no live N-way merge** (avoids the "charts disagree on section count" merge problem at the structure layer).
3. **Later charts align to it.** Subsequent charts map *into* the confirmed structure; ambiguities go to the **existing review queue** — never silently mutate canonical structure.
- **Re-key on owner edit = best-effort auto-remap, flag-the-breaks.** When the owner edits `SongStructure`, existing chart alignments are **auto-remapped by stable canonical-section id**; only alignments that **break** (a referenced canonical node removed/split) are flagged for re-review. We do **not** invalidate every alignment on every edit. Stable canonical ids (not labels/ordinals) are what make this safe.

### 2.3 The wire carries canonical refs; the screen carries local coords
- **Backend / wire = `CanonicalRef`** (a node in `SongStructure`): `pieceStart | segno | coda | fine | { section: canonicalSectionId } | { repeatStart: canonicalMarkerId }`, with an optional **`barOffset` valid only inside a span the alignment flags `bar-isomorphic`** (§2.3.1; never a free portable bar number — finding 4).
- **Frontend = local resolve + local label.** Each device maps `CanonicalRef → localNode` (via its alignment) → its own coords, renders locally, and labels in **its own** terms (MD reads "→ B / bar 17"; the bassist lands wherever B sits on the bass chart). A chart that can't resolve a ref (`unmapped`/structure-differs) **does not guess** — it surfaces "structure differs" and that member self-navigates (§7). Never silent mis-home.

### 2.3.1 `barOffset` span-equivalence (resolves §8.2-2)
`barOffset` only matters for mid-section targets ("start at bar 5 of the solo"), and raw bar numbers are non-portable (finding 4: written-out repeats, pickups, multirests). So:
> **A `barOffset` is honored only inside a span the alignment flags `bar-isomorphic`: equal bar count AND no intervening structural divergence (a structurally-flat run — no repeat/ending/jump boundary one chart writes out and the other doesn't, so bar *k* canonical ↔ bar *k* local 1:1).** The converter seeds the flag; it's part of confirmed alignment.
- **Fallback when not `bar-isomorphic`:** **drop the `barOffset` → resolve to the span/section head**, label "(bar-position approximate)," and surface to the MD that this follower coarsened. **Never** resolve to a non-isomorphic bar. This makes `barOffset` a bounded, *proven* convenience that degrades cleanly to structural granularity — it cannot reintroduce finding-4 fragility.

### 2.4 Worked example (the divergence case)
Guitar chart writes the repeat out (physical bars 1–16); horn chart uses `|: 1.|2. :|` (physical bars 1–10). Same music. Both align their *Solo* section to canonical `Solo#1`. MD broadcasts `CanonicalRef{section: Solo#1}`. Guitar resolves → its bar 17; horn → its bar 11; each labels from its own page. **No shared bar number was ever required.** v1's "broadcast bar 17" would have landed the horn wrong.

---

## 3. The live conductor VM (root B) — B2 override model

### 3.1 One VM, canonical, MD-owned
The redline's *played order* is produced by the resolver's VM — and a traversal step is only `{barId, pass}` (`pass` = bare entry-count, `lib/chart-calibration.ts:711`), while all behavior lives in hidden state: `completedPasses`, `fired`, `toCodaFired/alFineActive/alCodaArmed`, `cursor` (`:674–679`); endings are chosen by `completedPasses+1` (`:700`); nested-reset only fires in resolver-managed `backJumpTo` (`:683`). So a live redirect **cannot** be a `(barId,pass)` seek (finding 2). Instead:

> **There is one canonical VM, owned and stepped by the MD.** Its state *is* `ConductorState.cursor` (§6). Followers don't run their own VM — they mirror the MD's canonical VM and render it locally.

Implementation reuse: `resolveRoadmap` is already pure over `(bars, markers)`, so the **musical semantics** carry over to `SongStructure` unchanged. But the build delta is **not** a tiny wrapper — it's an **extracted VM core** (MED, accepted). Today the VM state is local variables (`completedPasses`, `fired`, coda/fine flags, `passCount`, `cursor`, `:673-680`); the stepper must **externalize** that state, precompute the marker indexes, and expose `step(state) → {transition, state'}` plus an `applyOverride(state, directive) → state'` hook. Chunk 2 budgets for this extraction — same musical rules, turned inside-out from run-to-completion into a resumable stepper. (This core is also what makes §3.3–3.4 well-defined: the resolver *is* the exit-decider.)

### 3.2 B2: default + override (chosen over exposing the whole VM)
Rather than fabricate arbitrary self-consistent VM states for any jump-in:
- **Default step:** the canonical resolver computes the next transition (its normal VM rule).
- **MD override:** a directive replaces the *next* step — `{ jumpTo: CanonicalRef, hold?: boolean, exit?: ExitPolicy }`.
- **Resume:** after an override, the default VM resumes from the target's **defined canonical entry** (§3.3 counter policy).

This narrows the hard problem to "default-continuation-from-an-entry + a small set of named intents," not "make every VM state reachable."

### 3.3 Redirect counter policy (what a jump does to VM state)
**Governing invariant: a redirect may only set VM state the resolver can *already reach on its own*.** It never fabricates an unreachable state. This is what keeps the overlay mechanically consistent with `resolveRoadmap` — and it's why the counters below are clamps to natural values, not freezes.

How the resolver counts (verify against code): `completedPasses` is incremented **at the exit edge**, then a back-jump fires only while `completedPasses < times` (`lib/chart-calibration.ts:725-727` volta-exit, `:738-740` plain repeatEnd); volta entry-select keys on `completedPasses+1` (`:700`). So `completedPasses` is "passes finished," and the *final* forward pass is the one entered at `completedPasses = times-1`.

A `jumpTo` a canonical node sets `cursor` there and applies the **minimal** state delta for the named intent:
- **"Another round" (re-enter a repeat):** jump to the repeat-start and **clamp `completedPasses(target) := times(target) − 1`** — the natural "one pass from exit" state. The next forward pass then yields `k = times` → selects the **final ending** (volta) or plays the body once (plain repeat) → exits naturally. **Reset descendant repeats** to 0 (mirroring `backJumpTo`'s nested-reset, `:686-690`); **do not** touch `fired` D.S./D.C. flags or sibling counters. Each additional "another round" tap re-applies the clamp (re-arms one more full pass). *(Why not "hold at `times`": that yields `k = times+1`, matches no printed ending, and skips past the whole ending group — no ending played. Wrong. The clamp is the only value that is both reachable and musically correct.)*
- **Indefinite vamp** is **not** this rule — it's the §3.4 hold/release path: suppress the exit-increment entirely, loop body-only, apply the same `times-1` clamp **on release** so the final ending is taken.
- **"To the coda" / "skip to X":** jump to the node; leave repeat counters as-is; set `alCodaArmed`/`toCodaFired` only if the intent is the al-Coda path.
- The directive is **idempotent** under `(epoch, seq)` (§6) — re-applying the same redirect is a no-op.

### 3.4 Continuation / exit semantics (closes finding 3)
**There is no separate "default exit" computation.** A redirect sets reachable VM state (§3.3); the resolver's **own forward walk** then produces every subsequent transition. "Default exit" is just *the VM's next step from the post-redirect state*. So exit precedence is only two layers:
1. **MD-specified exit** (optional armed override) — the directive's `exit` names an out ("…to the coda," "…then the bridge") that fires when the target completes. Wins when present.
2. **Default = let the resolver walk forward** from the post-redirect cursor. No guessing about the origin node's fall-through.

The four cases Codex flagged all fall out of this one rule — none needs a special default:
- **Target inside an outer repeat:** the jump leaves the outer counter untouched, so the outer `repeatEnd` rule fires normally when the cursor reaches it.
- **Target inside a volta body:** the ending taken is fixed by the counter §3.3 set (`times-1` → final ending). Deterministic.
- **Release from a vamp before an ending group:** on release, apply the `times-1` clamp; Rule 1 (`:700`) then selects the final ending. MD may override to a named ending.
- **Jump to a non-adjacent section:** continue forward **from the target**, never the origin — so the origin's (possibly wrong) fall-through is irrelevant. The resolver simply walks the canonical successors of the target.

(This is the same point the MED in §3.1 makes: the resolver *is* the exit-decider, so the extracted, resumable VM core is what makes §3.3–3.4 well-defined.)

### 3.5 The change marker — telegraph + fire, auto-fire **gated** (finding 5)
A placed **ephemeral change marker** (overlay-only, never persisted): the MD drops it ~1–2 bars early → every follower shows "**change pending → Chorus**" in its own coords (this is *why* it must be state, not an event — a mid-cue joiner must see it). The marker's position is the fire point. Commit trigger:
- **MD go-tap = the default and the floor.** It always works (the baton, digitized).
- **Auto-fire is allowed only behind a position-confidence gate:** clock present **AND** bars/beats-since-last-anchor under a bound **AND** clock confidence high **AND** no unresolved hold/vamp — **with an MD override always live.** Auto-fire is a *tempo-present luxury under confidence*, never an unconditional lock. A one-bar-early coda is worse than a tap (finding 5; v1's unconditional auto-fire is **unlocked**).

---

## 4. Authority — single MD, single writer, with epochs (root C)

**Only ever one MD** → no conflict resolution (no CRDT/merge). The MD's device **is** the truth; everyone else is a **read-only mirror**.

- **Writer epoch (baton generation):** `ConductorState.epoch` increments whenever the baton is (re-)claimed. **Lower-epoch directives/state are rejected.** This is what makes failover/partition safe (finding 8): there is exactly one live epoch.
- **Single seq-issuer:** **only the MD issues `seq`.** The listener node (§5) does **not** write state — it sends *telemetry* the MD ingests and re-emits as authoritative clock under the MD's `(epoch, seq)`. No hidden second writer (finding 6).
- **Followers render only MD-committed state.** `armed` is *advisory display*; **followers never locally commit a change** — the fire is an MD-committed `cursor` transition (armed cleared) in the broadcast state. Deterministic; late-join sees a committed cursor + current armed (finding 7).
- **Detach (grab-the-wheel):** a follower driving their own chart is a **private local override** — never writes shared state, never broadcasts. **Resync:** one-tap snaps back to the authoritative cursor (inherits `cursor.pass` verbatim — the MD VM is the single truth).
- **Failover:** MD device dies → everyone falls to **self-drive** (Concept A floor). The baton is **manually re-claimed**, bumping `epoch`; the relay arbitrates the claim (§5) so **never two live at once.**

---

## 5. Transport — band-owned local AP + relay; the relay is the baton arbiter

The feature exists because venues lack a reliable network, so transport depends on **nothing the venue provides.**

> **A band-owned local access point (pocket router / designated hotspot) running a tiny local WebSocket/WebRTC relay — no backhaul.** Stay a **PWA**; push in-app notifications via the native wrapper.

- **Rejected:** venue-WiFi / Supabase Realtime (needs backhaul); pure phone-mesh MultipeerConnectivity/Nearby (elegant but iOS↔Android don't interoperate, brutal iOS background limits, forces a native rewrite).
- **Chosen because** it's venue-independent (you carry it), **cross-platform** (just IP), low-latency, single-writer-shaped (a star through the relay) — and the "$20 router" is both the cheap and the principled answer.
- **Relay-as-arbiter (resolves finding 8 in our favor):** a *single* band-owned relay is a **single baton arbiter** — first claim at `epoch N+1` wins, the relay rejects the rest — so split-brain is **structurally impossible** in the normal topology. Pure mesh couldn't enforce one conductor; the relay can. (True two-relay partitions are out of scope — one band, one relay.)
- **Per-device offline floor never compromised:** each phone runs its **own** redline; transport is load-bearing only for togetherness. A player out of range keeps playing (self-drive) and **resyncs on reconnect by pulling current state.**

### 5.1 The clock layer (Concept C-tier-1)
Motion between anchors is a clock with a degrade ladder: **live audio tempo → last-known → static BPM → seek-only.**
- **One listener, one broadcast clock.** Detection runs on **one device** (the MD's, or a separable **listener node** taped near a clean source); the result is **telemetry to the MD**, who re-emits authoritative `clock` (tempo + downbeat phase + confidence) under its `(epoch, seq)` — *not* a second writer (finding 6).
- **Tempo ≠ position:** beat-tracking gives speed, never place → **dead-reckoning** that drifts on any structural deviation. So the clock is a **motion-smoother between anchors**, re-zeroed at every section boundary + MD cue (the band hits boundaries constantly → bounded drift). This is *why both layers are needed*.
- **Confidence-gate:** noisy mix → coast at last-good tempo, never jitter/lurch; degrade down the ladder. **Source quality is the whole ballgame** → audio-tempo is **designed-in now, turned on only after live source-quality validation.**

---

## 6. The shared state machine (root C)

Two phones stay together by **mirroring state**, not by shouting events (a shout strands any late/dropped device). The MD holds an authoritative truth object that **is the canonical VM**; followers mirror it and pull a fresh copy on any (re)join.

```ts
type ConductorState = {
  sessionId: string;
  songRef: string;
  epoch: number;                 // baton generation; lower-epoch msgs rejected
  seq: number;                   // monotonic, MD-only; orders + supersedes
  // cursor = the canonical VM snapshot (NOT a per-chart barId/pass):
  cursor: {
    node: CanonicalRef;          // current canonical position
    completedPasses: Record<canonicalRepeatId, number>;
    fired: Record<canonicalJumpId, boolean>;
    flags: { alFineActive: boolean; alCodaArmed: boolean; toCodaFired: boolean };
    passCount: Record<canonicalBarId, number>;
  };
  armed?: { fireAt: CanonicalRef; jumpTo: CanonicalRef; exit?: ExitPolicy }; // pending change marker (advisory display)
  // pre-5b compact shape — SUPERSEDED by chunk-5b §5.1. The broadcast (wire) clock is now
  // { rung: 'live'|'coasting'|'static-bpm'|'manual'; tempoBpm: number|null; confidence: number };
  // the reckoning state + confidence gate (anchor, barsSinceAnchor, alignedAtMs, motion baseline,
  // positionTrusted) are MD-LOCAL, off the wire. See docs/design-conductor-chunk5b-clock.md §5.1.
  clock: { tempoBpm: number | null; downbeatAt?: number; confidence: number };
  updatedAt: number;
};
```

- **Directives** (low-latency deltas) carry `(epoch, seq)`; apply-once by an `(epoch, seq)` high-water mark; **stale/duplicate/reordered ⇒ ignored**, a behind device pulls full state. Set: `arm`, `commit`, `redirect`, `hold`/`release`, `clock`, `claim` (epoch bump).
- **Transitions are deterministic and MD-owned:** the post-fire authoritative state is a **committed `cursor` with `armed` cleared** — so reordered arm/clock/commit can't desync a follower (each just converges on the latest committed state).
- **Late-join/reconnect:** pull full `ConductorState`, apply, resume mirroring — no event replay. **Detach/resync** are local-only (never touch shared state).

---

## 7. Boundary with existing rules (root C / finding 9 — explicit)

- **Conductor never writes another member's calibration.** Authority is *canonical-position + ephemeral directives only*; it crosses the owner/share boundary **only at the position layer**, never the calibration layer — keeping the **generate-once / edit-safe converter** untouched. (Load-bearing invariant; state it loudly.)
- **`verified` gate stays per-member, local.** Each device drives a redline only off its **own** verified, resolvable, **aligned** chart. An uncalibrated / `draft` / unaligned / `null`-tempo follower **ignores the conductor cursor entirely** and self-navigates. Conductor authority is **best-effort per member; never hard-fails.**
- **Ephemeral by default; no write-back path from live state.** Performance overlays (redirects, change markers, the live canonical VM) never persist. "We always add that repeat now" is a **separate, deliberate owner action** ("save as arrangement variant" on `SongStructure`) with **no path from a live session** (honors never-clobber).
- **Reconcile with** `design-perform-tab.md` (redline + gestures), `design-nav-graph.md` (the resolver/VM this lifts to canonical + steps), `design-chart-library.md` (where `SongStructure` + alignment live), `design-realtime-chart-control.md` (this is its B + C-tier-1).

---

## 8. Open questions

Closed by v2: v1's §8.1 (continuation — §3.4), §8.2 (resync pass-state — §4, inherit), §8.5 (auto-fire — §3.5 gate), the single-writer/state-machine gaps (§4/§6).
**Closed by v3 (R2 nits):** §3.3 counter mechanics (clamp to `times-1`, code-grounded), §3.4 exit determinism (no separate computation — resolver's forward walk *is* the exit), MED (extracted VM core, §3.1), and **OQ-2 provenance (resolved → §2.2.1 below).**

### 8.1 Resolved this round
- **OQ-2 `SongStructure` provenance → hybrid (model #3).** The converter **proposes** a canonical structure on first import; the **song owner confirms/edits it once** → it becomes authoritative; later charts **align to the confirmed structure** (ambiguities → the existing review queue). One human-confirmed source of truth → **no live N-way merge**, reusing the converter-suggest + review-queue pattern. **Re-key on owner edit → (b) best-effort auto-remap** by **stable canonical-section id**, **flagging only the breaks** for re-review (vs. invalidating all alignments). Folded into §2.2.

### 8.2 Status
**Closed by v3.1 (the chunk-1/2 gate):**
- **§8.2-1 alignment ambiguity → §2.2.0.** Partial alignment with per-node `local` | `tacet` | `unmapped`; tacet is resolved (rest + re-home), unmapped is loud + self-nav; never block the whole chart; no auto-snap. Spine: degrade precision, never honesty.
- **§8.2-2 `barOffset` span-equivalence → §2.3.1.** Honored only in a `bar-isomorphic` span (equal bar count + no intervening structural divergence); else drop to span head, label approximate.

**Resolved by chunk-5b clock design (`docs/design-conductor-chunk5b-clock.md`, Codex R9 GO):**
1. **Listener placement + clock latency (§5.1) [gated chunk 5] — RESOLVED.** (Q1) Ship MD-mic as v1, seam stays placement-agnostic, dedicated node UAT-deferred. (Q2) Relay latency is invisible at bar granularity (≤2.5%/bar at 50ms); reckon from receipt + carry freshness, never subtract a foreign monotonic clock. (Q3) Degrade ladder live→coasting→static-bpm→manual; motion on all non-manual rungs, only auto-*fire* gated; floor is 5a. Clock owns speed, MD owns place; provenance/counters ride the actual `current`-write (Invariant (P)). See chunk-5b §0–§8.

**Resolved by 3b transport design (`docs/design-conductor-3b-discovery-failover.md`, Codex R3 GO):**
2. **Failover + session discovery on a backhaul-less relay (§4/§5) [gated chunk 3 transport] — RESOLVED.** Secure context on a dead network = pre-provisioned valid cert + band-AP local DNS (`wss://relay.showrunr.ai`); discovery = QR + rotating room code; dumb relay = star + baton arbiter (journaled `{room, roomCode, epoch}`, lease-based orphan detection, zombie demote via `not-writer`, any-device claim behind confirm); session identity = the full reducer-scope `SessionKey {sessionId, songRef, programHash}` across discovery + snapshot recovery (forward-to-MD, stale-marked claim-time cache). Every failure row degrades to self-drive. See 3b doc §1–§7.

**§8.2 has no open items.** Chunk 3b transport is design-unblocked (build gated on explicit GO).

---

## 9. Build outline (after sign-off — design-first, not building)

Gated commits, Codex per chunk. Sequenced so each layer is demonstrable.

1. **`SongStructure` + alignment model** (pure, tested): canonical roadmap type, per-node alignment `local | tacet | unmapped` (§2.2.0), `resolveRef(alignment, CanonicalRef) → {localNode} | tacet | unresolved`, label+ordinal/bar-count **seeding** heuristics, `bar-isomorphic` guard for `barOffset` (§2.3.1). **Tests:** §2.4 divergence; a tacet section (rest + re-home); an unmapped section (self-nav, no snap); a non-isomorphic `barOffset` (drop to head). **Re-key test:** owner rename/reorder preserves stable ids → alignments survive; split/replace mints new ids → only those flagged (§2.2.1).
2. **Resumable canonical VM (B2)** (pure, tested): extracted VM core — stepwise `resolveRoadmap` (externalized `completedPasses`/`fired`/flags/`passCount`/`cursor` + precomputed marker indexes) that yields transitions + accepts `{ jumpTo, hold?, exit? }` overrides; the §3.3 counter policy + §3.4 exit. Drive from a local mock MD. **Tests:** "another round" clamp on 2x/3x/non-contiguous-volta/nested; the four §3.4 exit cases; **a redirect landing before an already-`fired` D.S./D.C. leaves it inert unless MD explicitly resets** (Codex R3 nuance).
3. **State machine + local relay:** `ConductorState`, directives, `(epoch, seq)` idempotency, claim/arbitration, late-join pull, detach/resync. Own-AP WebSocket relay; PWA. Single-writer + epoch enforced.
4. **Change-marker UI + gated commit (§3.5):** place/arm/telegraph on all charts; go-tap default, gated auto-fire.
5. **Clock layer + audio-tempo listener (§5.1):** ladder + telemetry→MD→broadcast; confidence gating. Audio-tempo designed-in, on-after-validation.

**Chunks 1–2 are now unblocked** (provenance §2.2.1, alignment §2.2.0, `barOffset` §2.3.1 all closed; Codex R3 = GO). Listener/clock (§5.1) is **resolved** by the chunk-5b clock design (see §8.2 Status). The one remaining open item gates chunk 3's transport only: failover + session discovery — designed in `docs/design-conductor-3b-discovery-failover.md`.

---

## 10. Decisions locked (v3.1)

- **Identity = a canonical `SongStructure` + per-chart alignment;** the wire carries `CanonicalRef`, each chart renders local coords + local label. Label+ordinal is a **seed**, not the authority.
- **Alignment is per-node `local | tacet | unmapped`;** tacet = resolved (rest + re-home), unmapped = loud + self-nav, never block the whole chart, no auto-snap. **Spine: degrade precision (bar→section→tacet→self-nav), never honesty** (§2.2.0). **`barOffset` honored only in a `bar-isomorphic` span;** else drop to span head, label approximate (§2.3.1).
- **`SongStructure` provenance = hybrid (#3):** converter proposes → owner confirms once → later charts align in; re-key on edit = best-effort auto-remap by stable canonical id, flag-the-breaks (§2.2.1).
- **One canonical VM, MD-owned;** the live layer is **B2 (default + override)** over a resumable, **extracted-core** `resolveRoadmap` (§3.1). **"Another round" = clamp `completedPasses := times-1`** (reachable natural state, §3.3). **No separate exit computation — the resolver's forward walk from the post-redirect state *is* the default exit; MD `exit` overrides** (§3.4).
- **Change marker telegraphs + fires; go-tap is the default/floor, auto-fire only behind a position-confidence gate** (§3.5).
- **Single MD = single writer, with `epoch` + single `seq`-issuer;** listener = telemetry not a writer; followers render only MD-committed state; private detach + one-tap resync; relay-arbitrated baton claim on failover (§4–6).
- **One listener, one broadcast clock; audio-tempo is the dead-reckoned *motion* source, re-anchored by position;** listener role separable from MD (§5.1).
- **Transport = band-owned local AP + relay, no backhaul, stay PWA;** relay is the single baton arbiter (split-brain structurally impossible) (§5).
- **State-machine authoritative (the canonical VM is the state), `(epoch, seq)`-idempotent, deterministic MD-owned transitions** (§6).
- **Ephemeral by default; conductor never writes another member's calibration; per-member verified+aligned gate intact; no live→persist write-back** (§7).
