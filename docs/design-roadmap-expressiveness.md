# ShowRunr — Roadmap Expressiveness (follow-on refinement) DESIGN

**Status:** **Gap 1 (chromatic roots) is BUILD-READY and being pulled forward** (per
Graham, after chunk-5 design GO). Gap 2 (modulation) stays a deferred stub. Captured
here so the discussion that produced it isn't lost and so the active chunks don't
bake in assumptions that would block it. Chunk-5 authoring-fidelity design merged to
main `4e29fb4`; chunk-4 re-key still on its own branch awaiting Codex re-review.

**Theme:** expressing chords and tonal centers that fall **outside a single
diatonic key**. Two real gaps + one non-gap that's worth recording so we don't
mistake it for one.

---

## Context — where this came from

While transcribing a real song, two questions surfaced that the current
`RoadmapSpec` can't (or only partly) answer:

1. A section that **modulates** — the tonal center actually relocates and stays.
2. A chord whose **root is chromatic** to the key — a `C` in `D` reads as a ♭7
   root (`bVII`), which `degree: 1..7` cannot reach.

### The motivating song (key = D) — the canonical Gap-1 fixture

An earlier pass mis-analyzed this as "G mixolydian"; the correct key is **D**
(A = V, G = IV, D = I keep it solidly in D — the only out-of-key color is borrowed,
not a key change). NNS numbers are **major-scale-anchored**, so `7` always means
C♯ regardless of whether you hear D major or D-mixolydian inflection. Walking every
chord against the schema, **the entire song is expressible today except one**:

| chord (in key D) | reading | `ChordHit` | gap? |
|---|---|---|---|
| D | I | `{degree:1}` | — |
| G7 | IV7 | `{degree:4, quality:'7'}` | — |
| D/E | I over 2 (passing) | `{degree:1, bass:2}` | — |
| A7 | V7 | `{degree:5, quality:'7'}` | — |
| Dsus2 | Isus2 | `{degree:1, quality:'sus2'}` | — |
| D7 | I7 | `{degree:1, quality:'7'}` | — |
| G | IV | `{degree:4}` | — |
| A | V | `{degree:5}` | — |
| Bm7 | vi7 | `{degree:6, quality:'m7'}` | — |
| Em | ii | `{degree:2, quality:'m'}` | — |
| E (verse-3) | II (major-on-2) | `{degree:2}` | — |
| **C** (chorus `G A C G`) | **♭VII (C major)** | `{degree:7, alter:-1}` | **Gap 1** |

So one chord — the chorus `C` — is the **whole** unlock for Gap 1. The two
flagged-as-hairy chords are *not* schema gaps: `D/E` is `{degree:1, bass:2}` (E is
the diatonic 2 of D), and the verse-3 `E` major is the bare `{degree:2}` (a major
chord on the diatonically-minor degree 2 — its chromatic G♯ is carried by *quality*,
exactly the non-gap below).

### ♭VII vs vii° — the distinction the schema must make

These are **different chords**, and today the schema can only spell one of them:

| chord | notes | `ChordHit` | today? |
|---|---|---|---|
| **vii°** = C♯ diminished (diatonic leading-tone) | C♯–E–G | `{degree:7, quality:'dim'}` | ✅ yes |
| **♭VII** = C major (rock/backdoor borrow) | C–E–G | `{degree:7, alter:-1}` | ❌ Gap 1 |

The chorus `C` is unambiguously **C major** → it is the ♭VII, the one we can't write.
Degree 7 reaches only C♯; without `alter` a user must mis-spell the ♭VII as a
diminished, which is a *different chord*. That is precisely the hole Gap 1 fills.

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

## Gap 1 — chromatic-root chords (accidentals on the degree) — BUILD-READY

`ChordHit.degree` is an integer `1..7` — it can only name **diatonic roots**. A
genuine `bVII` / `bIII` / `bVI` / `#IV` / `#V` root (common in rock, gospel, modal
borrowing) is unreachable. A `C` in `D` is `♭7`, not any of 1..7. This is small,
isolated, and the motivating song needs *only* this — so it ships first.

### Schema (`lib/roadmap-spec.ts`)

Add one optional field to `ChordHit`:

```ts
alter?: -1 | 0 | +1;   // flat | natural | sharp on the degree ROOT (default 0)
```

- `C` in `D` → `{ degree: 7, alter: -1 }`, printed **"♭7"**. Real Nashville already
  writes a flat/sharp before the number, so this matches convention exactly.
- `alter` qualifies the **root only**; chord `quality` is unchanged (a ♭VII *major*
  is `{degree:7, alter:-1}`, default major quality). A slash `bass` may take its own
  accidental later, but **bass alteration is out of scope for this chunk** (chunk-5
  §7.1 already defers a chromatic *bass* to Gap 1 — see integration below; v1 of
  Gap 1 covers the chromatic **root**, and a chromatic bass keeps returning to L2).

### Validator (`validateRoadmapSpec`)

- `alter` optional, ∈ `{-1, 0, +1}`; absent ≡ `0`. Reject any other value.
- **No double-accidental / enharmonic-nonsense rule needed beyond the enum** —
  because `alter` is a single semitone on a diatonic degree, every `(degree, alter)`
  names a real chromatic pitch class; there is no `{degree, alter}` that resolves to
  a non-pitch. (We deliberately do **not** canonicalize enharmonics — `{4,+1}` "♯4"
  and `{5,-1}` "♭5" are both allowed and print as written, mirroring how a chart
  author chooses spelling. Equality/dedup compares the literal `(degree, alter)`.)
- Canonical form: omit `alter` when `0` (so existing specs and the fold's output are
  byte-identical to today; `alter` only appears on genuinely chromatic roots).

### Renderer (`lib/roadmap-render.ts`)

`drawBarContent` prints `${alterGlyph(c.alter)}${c.degree}${c.quality ?? ''}${slash}`,
where `alterGlyph` maps `-1→♭`, `+1→♯`, `0|undefined→''`. The glyph is a prefix on
the degree number, vector-drawn like the other music glyphs (no new font asset). The
`Key:` header is untouched — `alter` is part of the body, key-invariant.

### Transpose-invariance (composes with chunk 4)

`alter` is relative to the **relative** degree, so a global re-key (chunk 4) still
just relabels the header — "♭7" stays "♭7" in every key. This is *why* `alter` (not
a raw chromatic semitone-off-tonic) is the right primitive; it rides along with the
degree under any re-key. No interaction with the chunk-4 view-time key chrome.

### Integration with chunk-5 `parseLetterChord` (the seam)

Chunk-5 §7.1 currently returns `null` for a chromatic root (e.g. `C` in `D`) and
defers it here. Gap 1 closes that branch: `parseLetterChord` maps a chromatic root to
`{ degree, alter }`.

**Spelling is ambiguous, so the LETTER parser canonicalizes deterministically.** A
chromatic pitch sits a semitone from **two** diatonic degrees (C natural in D is
both ♭7 = C♯−1 *and* ♯6 = B+1), so "nearest degree" is not well-defined. The rule:
the letter parser always emits the **flat spelling of the upper diatonic neighbor** —
the five chromatic roots canonicalize to **♭2, ♭3, ♭5, ♭6, ♭7**. This yields the
conventional **♭7** for C-in-D (nobody writes ♯6 for the backdoor seven) and is fully
deterministic. The author typed a bare letter (`C`), which carries no spelling intent,
so a canonical choice is the honest one.

The **schema still stores both spellings faithfully** — `{4,+1}` ("♯4") and `{5,-1}`
("♭5") are both legal — so a user who types an explicit roman/number with an
accidental (`♯4`, `b3`) through the number grammar is honored as written; only the
*letter* path canonicalizes (because a letter is spelling-agnostic). Every chromatic
pitch in 12-TET is ≤1 semitone from a diatonic degree, so one `alter` step always
suffices. The L1 grammar and the L2 prompt gain a one-line "chromatic roots use ♭/♯
before the number; letters prefer ♭" rule; the `AuthoringDraft` → fold path is
otherwise unchanged.

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

### Gap-1 build steps

- **G1a — schema + validator + renderer:** add `ChordHit.alter?: -1|0|+1`
  (`lib/roadmap-spec.ts`), validator enum + omit-when-0 canonicalization, and the
  `alterGlyph` prefix in `drawBarContent` (`lib/roadmap-render.ts`). Pure + golden
  render test. Self-contained; nothing else depends on it.
- **G1b — parser seam:** extend `parseLetterChord` (chunk-5 §7.1) to emit
  `{degree, alter}` for chromatic roots via the prefer-flat-upper-neighbor rule;
  honor explicit `♭`/`♯` in the number/roman grammar; one-line prompt rule for L2.
  Chromatic *bass* still defers (returns null) — root-only for v1.
- G1a alone makes the motivating song fully expressible from the manual/number path;
  G1b makes the letter/AI path emit it.

### Tests (Gap 1)

- validator: `alter ∈ {-1,0,+1}` accepted, others rejected; `alter:0` omitted in
  canonical form (existing fixtures byte-identical); `{7,-1}` round-trips.
- renderer: `{7,-1}` prints "♭7", `{4,+1}` prints "♯4"; header `Key:` unchanged;
  determinism (byte-identical) holds with the glyph.
- transpose-invariance: re-key a spec containing `{7,-1}` → body unchanged, only the
  header label moves (composes with chunk 4).
- `parseLetterChord`: `C`+key D → `{7,-1}` (♭7, not ♯6); `Eb`+key D → `{3,-1}` (♭3);
  explicit `#4` via number grammar → `{4,+1}` honored; chromatic bass `E/Eb` still
  → null (deferred).
- end-to-end fixture: the motivating song parses with the chorus `C` as `{7,-1}` and
  the whole-song bar count is faithful.

## Sequencing

Gap 1 is being **pulled forward to build now** (Graham, after chunk-5 design GO) —
it is small, isolated, and the motivating song needs only it. Gap 2 (modulation)
stays deferred: larger, and leans on the chunk-4 view-time key-label machinery. The
two gaps are the **same family** ("outside one diatonic key") but split cleanly;
Gap 1 ships first and standalone.

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
