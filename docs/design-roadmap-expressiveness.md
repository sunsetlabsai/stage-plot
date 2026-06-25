# ShowRunr — Roadmap Expressiveness (follow-on refinement) DESIGN STUB

**Status:** DESIGN STUB. A follow-on refinement chunk, **deliberately deferred** —
NOT part of chunk 5 (authoring fidelity) or chunk 4 (re-key). Captured here so the
discussion that produced it isn't lost and so the active chunks don't bake in
assumptions that would block it.

**Theme:** expressing chords and tonal centers that fall **outside a single
diatonic key**. Two real gaps + one non-gap that's worth recording so we don't
mistake it for one.

---

## Context — where this came from

While transcribing a real song (verse `D G7 D G7 D E G Dsus2`, chorus `G A C G`
with a `Bm7 → Em → A/D7` tag), two questions surfaced that the current
`RoadmapSpec` can't (or only partly) answer:

1. A section that **modulates** — "the chorus is in G" when the verse felt like D.
2. A chord whose **root is chromatic** to the key — a `C` in `D` reads as a ♭7
   root (`bVII`), which `degree: 1..7` cannot reach.

(For that specific song, re-centering the analysis on **G mixolydian** dissolved
both — the verse is a V–I vamp, the `G7` is a natural I7, and the `C` is a plain
IV. But the general gaps are real and will recur.)

## Non-gap (record so it isn't "fixed" by accident)

NNS makes **quality explicit**, so a major chord on a diatonically-minor degree is
already expressible — it is just the bare number:

- `{ degree: 6 }` → **"6" = VI** (E major in G). `{ degree: 6, quality: "m" }` →
  "6m" = vi (Em). Same for `2` vs `2m`, `3` vs `3m`, etc.
- **Slash bass** is a scale degree: `E/D` in G = `{ degree: 6, bass: 5 }` → "6/5";
  with dominant color `{ degree: 6, quality: "7", bass: 5 }` → "6⁷/5".

⚠ Caveat: quality `"6"` is an **added-sixth chord** (E6 = E G# B C#), a different
thing from **degree 6**. Don't conflate them.

→ No schema change needed for VI / major-on-minor-degree / slash bass. The active
chunks already support these.

## Gap 1 — chromatic-root chords (accidentals on the degree)

`ChordHit.degree` is an integer `1..7` — it can only name **diatonic roots**. A
genuine `bVII` / `bIII` / `bVI` / `#IV` root (common in rock, gospel, modal
borrowing) is unreachable. A `C` in `D` is `b7`, not any of 1..7.

**Direction (not built):** add an optional **`alter`** to `ChordHit`:
`alter?: -1 | 0 | +1` (flat / natural / sharp on the degree root). `C` in `D`
becomes `{ degree: 7, alter: -1 }` → printed "♭7". Real Nashville already uses a
flat/sharp before the number, so this matches convention.

- Validator: `alter` optional, default 0; the resolved chromatic root must be a
  real pitch (no double-accidental nonsense).
- Renderer: prefix the degree glyph with ♭/♯.
- **Transpose-invariance preserved** — `alter` is relative to the (relative)
  degree, so a global re-key (chunk 4) still just relabels.

## Gap 2 — mid-song key change (modulation)

`renderKey` is **global** — one key for the whole chart. A section that genuinely
relocates the tonal center (and stays) can't be expressed; you'd have to renumber
the whole song against one center and lean on accidentals, which is wrong when the
ear has actually moved home.

**First, the discrimination that matters:**
- **(a) Same key, different emphasis** — a section just *parks* on a different
  chord (verse on the V, chorus on the I). **Needs nothing** — it's chord choice
  within one key. The common case, and the trap is over-building for it.
- **(b) Genuine modulation** — the tonal center relocates and stays (e.g. a final
  chorus up a step). **This** is what needs new surface.

**Direction (not built) — store the change RELATIVE:** add an optional per-section
key shift expressed as a **relationship to the song's primary key**, not an
absolute key:

- e.g. `keyShift?: { degree: <1..7>, alter?: -1|0|+1 }` ("the new local tonic is
  the 4 of the primary key") or an interval in semitones — TBD in the real spec.
- The section's degrees are then relative to its **local** tonic; the renderer
  prints a key-change marker at the section head, resolved at view time exactly
  like the chunk-4 key label.

**Why RELATIVE is mandatory (composition constraint):** chunk-4's whole invariance
is "a global re-key is a relabel." If a section's key were stored **absolutely**
("chorus = G"), a global override ("play the whole song up a step") would move the
verse and strand the chorus. Stored relative, every local tonic rides along with
the primary key — invariance holds. **The active chunks must not bake in a single
absolute-key assumption** (chunk 4 stores degrees relatively; chunk 5 Q3 flags
this — both are clear today).

## Sequencing

Defer the whole stub until after chunk 5 (fidelity) and chunk 4 (re-key) land. The
two gaps are the **same family** ("outside one diatonic key") and should likely
ship together as one expressiveness chunk: `alter` (Gap 1) is the smaller, more
isolated change; modulation (Gap 2) is larger and leans on the chunk-4 view-time
key-label machinery. Build Gap 1 first if split.

## Open questions (for the eventual spec, not now)

1. `alter` encoding — `-1|0|+1` enum vs a signed semitone offset on the root.
2. `keyShift` encoding — degree-of-primary (`{degree, alter}`) vs semitone
   interval. Lean degree-of-primary (reads like a chart, stays relative).
3. Does a modulated section's key-change marker reuse the chunk-4 chrome overlay,
   or print in the PDF body? (Lean: chrome for live, body-stamp on export — mirror
   chunk-4's hybrid.)
4. Letters display mode (deferred in chunk 4) interacts with both — a letter
   re-spelling must honor `alter` and per-section local tonic. Keep numbers-native
   until then.
