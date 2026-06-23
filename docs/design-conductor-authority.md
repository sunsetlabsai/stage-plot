# Conductor authority — live roadmap broadcast across N charts (design)

**Status:** Proposed (design draft, pre-Codex). Design-only; no build.
**Date:** 2026-06-22
**Branch:** `opus/design-conductor-authority`
**Parent:** `design-realtime-chart-control.md` — this is the detailed design of its **Concept B** (networked seek) plus the tractable tier of **Concept C** (tempo-awareness). It resolves that doc's Open Questions #1 (B transport) and the C-tier split, and consumes the **nav-graph** layer (`design-nav-graph.md`).
**Builds on:** the merged calibration editor (chunks 1–3), the nav-graph resolver (chunk 4, `resolveRoadmap`), and the per-chart hash-keyed `(chart_id, source_hash)` sidecar with the `draft|verified` lifecycle.

---

## 1. The problem

In live performance the MD makes a realtime change — "another round of the solo," "back to the top of the chorus," "to the coda," "cut the bridge." The whole band must re-home to **the same musical position**, but every member is reading a **different chart** for the same song (their instrument/role), each with its **own** geometry and **own** roadmap markers, each in its **own** coordinate space. The redline must move to that shared musical spot on every chart at once, and it must work in a **venue with no reliable network.**

This is the live, band-aware layer ForScore structurally lacks. It rides entirely on top of the existing per-chart redline — it adds **togetherness**, and togetherness is the one property that is allowed to degrade gracefully (a disconnected device keeps following its own chart).

---

## 2. The reframe: two orthogonal layers, not three flavors of "seek"

The parent doc framed A/B/C as three automation levels of one *seek* primitive. Designing the conductor layer surfaced a cleaner decomposition — **two orthogonal axes**, and a complete follow uses **both**:

| Axis | What it controls | Sources |
|---|---|---|
| **WHERE** (position) | which logical position the redline is at | manual tap (A) · MD redirect (B) |
| **HOW FAST** (motion) | how the redline coasts *between* positions | null (seek-only) · static BPM marking · **live audio tempo** (C-tier-1) |

- **Position is discrete and authored live** (a tap or a broadcast redirect). It is the roadmap/structure layer.
- **Motion is a clock** that advances the redline between anchors. Audio-tempo is just the best *source* for that clock; it fills the long-nullable `tempoBpm` field and flips a seek-only chart into auto-advance.
- They **re-anchor each other** (§7): the clock smooths motion but drifts in position; the position layer re-zeros it at every section boundary and MD cue. Neither is sufficient alone — which is exactly why we want both.

"Audio decides *where* you are" (score-following / jump-detection) is a different, research-grade thing on the *position* axis and stays **deferred** (parent doc C-tier-2). We sign up only for audio on the *motion* axis.

---

## 3. Position model — structural-node redirect (overlay, not edit)

### 3.1 There is no shared coordinate today; the roadmap is the only common thread

`resolveRoadmap(cal)` is a pure function of **one chart's** bars+markers; `barId`s are chart-local UUIDs. So "the same place" across N charts cannot be a coordinate — it must be a **shared logical position**, and the only thing genuinely common across charts is the **song's structure** (the roadmap). Bar-number commonality is *downstream* of structural commonality: bar numbers line up only where the print lines up.

**Two bar numbers, and the gap between them is the trap:**
- **Physical bar** — the printed box on *that* chart (`Bar.absNumber`, dense 1..n). Unique *within* a chart; common across charts **only where the print matches.**
- **Musical bar** — the bar's number in the song's structure; what a musician means by "from bar 37." A property of the song, not the page.

They diverge systematically at **repeats written out vs. repeat signs** (a chart printing `|: 8 :|` is 8 boxes; one writing the repeat out is 16 → physical numbering diverges by 8 from there on, same music). Pickups (anacrusis counted as bar 1 / 0 / not at all) and collapsed multi-bar rests are the smaller off-by-one versions.

**Conclusion:** anchor shared identity on **roadmap nodes** (sections, rehearsal marks, repeat-starts, segno, coda, fine) — few, semantically *labeled*, far more position-stable than the bar grid. Bar number rides along as the fine-grain fallback and the **display** label.

### 3.2 Backend vs. frontend seam

- **Backend / wire = a structural reference, never a chart-local id.** Identity by *role + disambiguator*:
  - singletons trivially: `pieceStart`, `segno`, `coda`, `fine`;
  - sections by normalized label + ordinal (`Chorus #2`, `Letter B`);
  - repeat-spans by the node they head;
  - optional **bar-offset within the node** for fine targeting where structure matches.
- **Frontend = local resolve + local label.** Each device maps the structural ref → **its own** `barId → coords`, renders the redline locally, and labels it in **its own** terms (the MD's screen reads "→ B / bar 17"; the bassist's screen lands wherever B sits on the bass chart and labels it from the bass chart). The wire carries structure; the screen carries coordinates.

```ts
type StructuralRef =
  | { kind: 'pieceStart' }
  | { kind: 'segno' | 'coda' | 'fine' }
  | { kind: 'section'; label: string; ordinal: number }   // normalized label + Nth occurrence
  | { kind: 'repeatStart'; headLabel?: string; ordinal: number }
  // optional fine offset, used only where structure matches across charts:
  & { barOffset?: number };
```

Resolution on each device: `resolveRef(localCalibration, ref) → { barId, pass } | { unresolved, reason }`. A chart that can't resolve the ref (missing section, structure mismatch) **does not guess** — it surfaces "structure differs" and falls back to that member self-navigating. Never silent mis-home.

### 3.3 Redirect = jump to an existing node; overlay, not edit (locked)

The conductor **never edits the saved roadmap.** A redirect says only *"next, go to node X"* — and **X must already exist on the roadmap.** This makes the legal target set **finite and enumerable** (it is exactly the roadmap nodes → a picker, not an editor), needs no re-validation and no re-resolve of a mutated graph, and keeps the **generate-once / edit-safe converter guarantee** untouched.

- "Another round" = redirect to the repeat-start node (already there).
- "To the coda" = redirect to the coda node (already there).
- "Cut the bridge" = redirect *forward* to the post-bridge node (already there).

All the same primitive — *jump to an existing node* — differing only in direction.

**The one nuance — structure is read-only, traversal is live.** "Already on the roadmap" means an existing **node**, re-enterable for **additional passes the static traversal didn't include** ("another round" wants a pass beyond the printed repeat count). So:

> **The live overlay may re-enter existing nodes for extra passes; it may never invent a node.**

That is still not "editing" — the printed structure is untouched; only the live traversal is overlaid. Mechanically the overlay sits on top of `resolveRoadmap`'s traversal: a redirect abandons the current traversal index and resumes at the node's `(barId, pass)`, requesting a pass beyond the static list when needed.

### 3.4 The change marker — telegraph + fire point (the conducting gesture)

Changes happen at **boundaries**, not mid-bar, and real MDs **signal ahead** ("a change is coming… in 4, 3, 2, 1, CHANGE"). So the redirect is a placed **ephemeral change marker** (overlay-only, never persisted to the roadmap) that does both jobs at once:

1. **Telegraph (arm):** the MD drops it ~1–2 bars before the boundary. *Every* follower's chart instantly shows "**change pending → Chorus**" in its own coordinates. Nobody moves yet. (The armed change is **state**, not a fired event — a device joining mid-cue must see it; see §6.)
2. **Fire (commit):** at the boundary, the redline jumps on every device at once. The marker's position **is** the fire point.

**Commit trigger is pluggable by motion regime (locked):**
- **Clock present** (static BPM or live audio tempo): the cursor crosses the change marker on its own → **auto-fire, hands-free.** Preferred.
- **No clock** (null tempo, dead stage, everyone playing): nothing reaches the boundary by itself → the MD's deliberate **"go" tap is the commit.** Not an extra step — the only reliable trigger when there is no clock. It *is* the baton, digitized.

Same armed state in the truth object; two ways to discharge it. Auto-fire is a tempo-present luxury, not the dead-stage baseline — we don't over-promise hands-free.

### 3.5 Continuation semantics at the target (open — §8)

A redirect re-homes position; what governs forward motion *after* arrival (does the repeat re-arm, which ending plays next, does pass-state reset or continue) is the genuinely subtle part and is left open in §8.

### 3.6 Worked example (two charts, one redirect)

Song with a 1st/2nd ending. **Guitar chart** writes the repeat out (physical bars 1–16). **Horn chart** uses `|: … 1.|2. :|` (physical bars 1–10). Same music.

- MD arms a change marker at the end of the chorus pointing at `{ kind:'section', label:'Solo', ordinal:1 }`.
- Wire carries the *structural ref*, not a bar number.
- Guitar device resolves Solo → its bar 17; horn device resolves Solo → its bar 11. Each shows "→ Solo" on its own page in its own coords.
- On commit, both redlines jump to their local Solo. **No shared bar number was ever required** — only the shared section identity. Had we broadcast "bar 17," the horn chart would have landed wrong.

---

## 4. Authority model — single MD, single writer (locked)

**Only ever one MD.** This is not just policy; single-writer **eliminates conflict resolution** — no CRDT, no merge, no "two people drove." The MD's device **is** the source of truth; everyone else is a **read-only mirror**.

- **Session/room:** a session scopes "the band for this song" (keyed to the show/setlist context). Members join the session to follow.
- **Grant/revoke:** one designated conductor (default: the show owner, or whoever claims the baton in-session). Followers opt in to *follow*; opting out is local and silent.
- **Detach (grab-the-wheel):** a follower tapping their own marker is a **private local override** — they stop mirroring and self-drive. It never writes shared state and never broadcasts (parent doc's follow-mode scope).
- **Resync:** a one-tap "resync to MD" snaps the detached follower back to the authoritative cursor (and clears their local override). Pass-state on resync ties to §8.
- **Failover:** if the MD's device dies, authority is gone and everyone falls back to **self-drive** — which is just Concept A, the universal floor. The baton may be **manually re-designated** to another member; **never two live at once.**

Single-writer also carries to the **clock** (§5): one device owns *both* the position cursor and the broadcast tempo. Followers mirror both.

---

## 5. Motion layer — the clock, and audio-tempo as its best source

The redline's motion between anchors is a **clock** with a graceful **degrade ladder**:

```
live audio tempo  →  last-known tempo  →  static BPM marking  →  seek-only (no advance)
```

### 5.1 One listener, one clock, broadcast (locked)

Do **not** let every follower mic-track independently — N phones beat-tracking a room **diverge** and multiply the noise. Detection runs on **one device** and the result is **broadcast** as part of the truth object (tempo + downbeat phase + confidence). One listener, one clock, everyone shares it — the same single-writer principle as position.

- The **listener role is separable from the MD role**: position authority stays MD-only, but tempo may come from a **dedicated listener node** (a phone taped near a clean source). Both feed the relay.

### 5.2 The honest limit: tempo ≠ position

Beat-tracking gives *speed*, never *place*. Audio-tempo is therefore **dead-reckoning** — right pace, but position **drifts** on any structural deviation (an extra vamp bar, a dropped beat, a half-taken repeat — exactly what live bands do). So it is a **motion-smoother between anchors, not an autopilot.** This is *why both layers are necessary*: the clock smooths motion, and the position layer (§3, A/B) **re-zeros at every section boundary and MD cue** — which the band hits constantly — so drift stays bounded.

### 5.3 Guardrails

- **Confidence-gate the clock** (same pattern as the converter): a noisy/loud mix → low confidence → the redline **coasts at last-good tempo, never jitters or lurches.** Degrade *down* the ladder; never feed garbage to the cursor.
- **Source quality is the whole ballgame** for usability — clean off a click / kick mic / the MD's own instrument; brutal off a pocketed room-mic on a loud stage. This is the one piece that **needs real-world testing** before we trust it. Audio-tempo ships as the explicitly **deferred-but-designed-for** tier (designed in now so the clock seam exists; turned on after live validation).

---

## 6. Transport + the shared truth object

### 6.1 Transport: band-owned local AP + local relay (no backhaul)

The feature exists *because* venues have no reliable network, so the transport must depend on **nothing the venue provides.** Decision (zero-dev-cost "right answer" converged with the pragmatic one):

> **A band-owned local access point (a pocket router or a designated hotspot) running a tiny local WebSocket/WebRTC relay — no backhaul.** Stay a **PWA**; push in-app notifications via the native wrapper.

Rationale, against the alternatives:
- **Venue WiFi / Supabase Realtime — rejected:** needs backhaul, the exact thing a venue lacks.
- **Pure phone-to-phone platform mesh (MultipeerConnectivity / Nearby Connections) — rejected** despite being the more elegant zero-infra answer: Apple and Android meshes **don't interoperate** and iOS background-radio limits are brutal; a mixed-platform band sinks it, and it forces a native rewrite.
- **Own AP + relay — chosen:** venue-independent (you carry it), **cross-platform** (just IP, every device speaks it), low-latency, and a perfect fit for single-writer (a star through the relay). The "$20 router in the gig bag" is both the cheap path and the principled one.

**Per-device offline floor is never compromised:** each phone runs its **own** redline locally; the transport is load-bearing only for *togetherness*. A player who wanders out of WiFi range keeps playing (self-drive) and **resyncs on reconnect by pulling current truth.**

### 6.2 State, not just events

Two phones can be kept together by **shouting events** ("JUMP TO CODA") or by **mirroring state** ("here is the truth right now"). Events alone strand any device that joined late or dropped for 5 seconds — it never heard the shout. So the MD's device holds a small **authoritative truth object**; followers **mirror** it and can **pull a fresh copy** on any (re)join. The armed change marker (§3.4) is the canonical reason this must be state: a follower joining mid-cue must *see the pending change*, which an event stream can't replay.

```ts
type ConductorState = {
  sessionId: string;
  songRef: string;                    // which setlist entry / song
  cursor: { ref: StructuralRef; pass: number };          // current logical position (WHERE)
  armed?: { fireAt: StructuralRef; target: StructuralRef; pass?: number };  // pending change marker
  clock: { tempoBpm: number | null; downbeatAt?: number; confidence: number };  // HOW FAST
  seq: number;                        // monotonic; orders + supersedes directives
  updatedAt: number;
};
```

- **Directives** (events that mutate the truth) are still useful for low-latency: `arm`, `commit`, `seek`, `hold`/`release`, `clock`. But the **state is authoritative** — a directive is just a delta with a `seq`; a device that misses one recovers by re-pulling state.
- **Ordering / idempotency:** monotonic `seq`; a stale directive (lower `seq` than the device's last applied) is ignored, so a late-arriving "jump" can't mis-fire after the band already moved.
- **Late-join / reconnect:** pull full `ConductorState`, apply, resume mirroring. No event replay.
- **Detach/resync** are **local-only** follower actions; they never touch `ConductorState`.

---

## 7. How the layers compose (the whole picture)

```
 WHERE (position)         A: manual tap        ┐
                          B: MD redirect       ├─►  re-anchor (re-zero drift)
                                               │         ▲
 HOW FAST (motion)        clock ladder ────────┘         │
                          (audio-tempo → static → none) ─┘ smooth motion, drifts in position
```

- Position is set discretely (A/B) and is the **read-only-structure, live-traversal** overlay (§3.3).
- Motion coasts the redline between those anchors; audio-tempo is its best source (§5).
- They re-anchor each other; everything degrades to the **per-device offline floor** (each chart still follows itself).
- One MD writes both axes; the local relay carries a small authoritative truth object; followers mirror and can detach/resync.

---

## 8. Open questions (for adversarial review / Codex)

1. **Continuation semantics at a redirect target (§3.5) — the subtle one.** After "go to repeat-start": is this pass *n+1* (re-arm — it'll bounce again) or a clean entry? Which ending plays next after a back-jump redirect? Does a redirect **reset** pass counters for nested repeats inside the target, **continue** them, or take an explicit pass argument? Lean: the redirect carries an explicit `pass` (it's in `ConductorState.cursor`), and re-entry re-arms the target's own repeat while leaving siblings alone — but this needs the resolver's nested-reset rules (`design-nav-graph.md` §4) pressure-tested against a *live* re-entry rather than a static walk.
2. **Pass-state on resync** (§4) — a detached follower rejoining mid-repeat: inherit the MD's `cursor.pass` verbatim (trusts §3.2 resolution) vs. recompute locally. Lean: inherit — the MD's cursor is the single truth.
3. **Structure-mismatch handling** (§3.2) — when a chart can't resolve a structural ref (different sections, repeats-out vs. repeat-signs beyond a section boundary), is "that member self-navigates" enough, or do we want a coarser fallback (snap to nearest resolvable section)? How loud is the "structure differs" surfacing?
4. **Ref disambiguation robustness** (§3.2) — section identity by normalized label + ordinal assumes charts label sections compatibly ("B" vs "Chorus 1"). What's the normalization, and what happens when two charts disagree on section *count* (a chart missing a tag)?
5. **Auto-fire vs. go-tap boundary detection** (§3.4) — with live audio tempo the cursor crosses the marker "on its own," but tempo is dead-reckoned (§5.2); how much position-confidence is required before we trust an *auto*-fire vs. demanding the MD's go-tap? Mis-firing a change a bar early/late is worse than requiring the tap.
6. **Listener placement & clock latency** (§5.1) — dedicated listener node vs. MD device; phase alignment across relay latency (likely invisible at bar granularity, confirm); what the clock does when the listener drops.
7. **Failover UX** (§4) — manual baton re-designation when the MD's device dies: how is it claimed, and how do followers discover the new authority on a dead-network relay?
8. **Session discovery** (§4/§6) — how members find and join the session on a local relay with no backhaul (QR to the relay address? mDNS? a short room code?).

---

## 9. Boundary with existing rules (confirm during review)

- **Conductor never writes another member's calibration.** Authority is *logical-position + ephemeral directives only*; it crosses the owner/share boundary **only at the position layer**, never the calibration layer. This is the load-bearing invariant that keeps the whole feature safe and the **edit-safe converter** untouched — state it explicitly.
- **`verified` gate stays per-member, local.** The conductor relaxes nobody's `verified`+resolvable requirement; each device still only drives a redline off its **own** verified, resolvable chart. An uncalibrated/`draft`/`null`-tempo member shows no driven redline → self-navigates. Conductor authority is **best-effort per member** and never hard-fails.
- **Nothing persists by default.** Performance overlays (redirects, change markers, the live traversal) are **ephemeral**. "We always add that repeat now" is a *deliberate, separate* "save as arrangement variant" action — **never** an implicit write-back from a live session (honors generate-once / never-clobber).
- **Reconcile with** `design-perform-tab.md` (the redline + gestures live here), `design-nav-graph.md` (the resolver this overlays), and `design-realtime-chart-control.md` (this is its B + C-tier-1). No format/keying change to the calibration sidecar.

---

## 10. Build outline (after sign-off — design-first, not building yet)

Sequenced so each layer is independently demonstrable; gated commits, Codex per chunk.

1. **Structural-ref + resolve** (pure, tested): `StructuralRef`, `resolveRef(cal, ref) → {barId,pass}|unresolved`, ref-from-node enumeration (the picker's legal target set), label normalization. No transport. The §3.6 two-chart divergence is the test.
2. **Live overlay on the traversal** (pure, tested): redirect/extra-pass semantics over `resolveRoadmap`'s output (§3.3, §8.1 continuation rules once closed). Still local — drive it from a local mock conductor.
3. **The truth object + local relay transport**: `ConductorState`, directives, `seq` ordering, late-join pull, detach/resync. Own-AP WebSocket relay; PWA client. Single-writer enforced.
4. **Change-marker UI + auto-fire/go-tap commit** (§3.4): place/arm/telegraph on all charts; commit trigger pluggable by clock regime.
5. **Clock layer + audio-tempo listener** (§5): clock ladder + broadcast; confidence gating. Audio-tempo **designed-in, turned on after live source-quality validation.**

Transport OQ (§8.7/8.8) blocks only the relay/session-discovery details, not layers 1–2.

---

## 11. Decisions locked this pass

- **Position identity = roadmap structure**, not bar coordinates; bar number is the front-end label + fine fallback only (§3.1).
- **Backend carries a `StructuralRef`; frontend resolves to local coords + local label** (§3.2).
- **Redirect = jump to an *existing* node; overlay, never edit.** Live traversal may re-enter nodes for extra passes; may never invent a node (§3.3).
- **Change marker telegraphs + fires; commit auto-fires with a clock, MD go-tap without** (§3.4).
- **Single MD = single writer**; followers are read-only mirrors with private detach + one-tap resync; manual baton re-designation on failover (§4).
- **One listener, one broadcast clock**; audio-tempo is the *motion* source, dead-reckoned, re-anchored by position; listener role separable from MD (§5).
- **Transport = band-owned local AP + relay, no backhaul, stay PWA** with native-wrapper in-app notifs; pure phone-mesh and venue-WiFi/Supabase both rejected (§6.1).
- **State-authoritative (truth object) over events-only**; monotonic `seq`; late-join pulls state (§6.2).
- **Ephemeral by default; conductor never writes another member's calibration; per-member `verified` gate intact** (§9).
