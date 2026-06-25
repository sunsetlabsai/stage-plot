# ShowRunr — Roadmap Authoring Fidelity (chunk 5: parse that doesn't drop bars) DESIGN

**Status:** DESIGN-ONLY. Codex review, then build.
Companion to `docs/design-roadmap-builder.md` (chunks 0–3 shipped, main `9902d08`)
and `docs/design-roadmap-key-resolution.md` (chunk 4, awaiting Codex).

---

## 1. The failure (reproducible)

Given a verse written plainly as eight 2-bar spans — `D, G7, D, G7, D, E, G,
Dsus2` = **16 bars** — the AI parse returned a verse of **8 bars**. It ate half
the section, silently, and the spec it produced was structurally valid (the
validator has no way to know the user meant 16). A re-prompt asking for "more
careful attention to the verse" did not reliably fix it.

The drop is concentrated in the front of the verse — the alternating cell
`D G7 D G7 D` (spans 1–5, ten bars). This is not a random hallucination; it is a
**structural** failure of the current design, and it recurs.

## 2. Root cause — we impose the conditions that make counting fail

A bigger/"smarter" model of the **same family** fumbles this too. The difference
between a faithful read and a dropped one is not model IQ; it is the **conditions
we put the parser under**, and we control all three:

1. **We gag the reasoning that makes counting reliable.** The system prompt says
   *"Return ONLY the JSON object — no prose."* Faithful counting comes from
   literal span-by-span enumeration (a scratchpad). We forbid exactly that, then
   expect accurate counts.
2. **Objective mismatch.** One-shot, the model optimizes for a *plausible,
   compact, well-formed* spec — not for *fidelity to the literal sequence*.
3. **The output format rewards the bug.** The sparse spec **pays** the model to
   find repeats (sparse `changes`, section `repeat`). Faced with `D G7 D G7 D…`
   the format actively incentivizes "that's a vamp" — which is precisely how
   spans 3–5 disappear.

**Corollary:** the fix is not a better model. It is to change the conditions —
specifically, to **stop asking one LLM pass to transcribe AND compress at once**,
and to **make the bar count self-evidencing in the output** so collapse is neither
rewarded nor invisible.

## 3. Design principle

> **Separate transcription from compression. Take counting off the LLM wherever
> the author already wrote countable spans. Make the count the output, not a
> hidden side effect of it.**

Three consequences:

- The model's job becomes **transcription into an explicit, per-span intermediate**
  (the SpanList, §5) — *not* authoring the sparse spec. It never decides "this is a
  repeat"; it lists spans in order.
- **We** do the compression (SpanList → sparse `RoadmapSpec`) in **deterministic,
  pure, fixture-tested** code (§6). The folding that was causing the error becomes
  a verifiable function.
- Where the author wrote in a countable grammar ("2 bars D"), a **deterministic
  parser** (§7) handles it with **zero LLM** — math counts, the model only
  interprets genuinely fuzzy prose.

This is the builder thesis applied one layer up: *we own the structure, so the
count is right by construction.*

## 4. Architecture — four layers

```
NL description
  │
  ├─[L1] deterministic span-grammar parser  ──► SpanList (faithful, no LLM)
  │        "2 bars D, 2 bars G7, …"
  │
  ├─[L2] LLM for the fuzzy residue          ──► SpanList edits + structure ops
  │        "drop one bar of G, replace with Bm7/Em/A as a tag"; repeats; nav.
  │        Operates ON the SpanList. Enumeration IS the output (no gag, no
  │        collapse incentive). Also does chord→degree (Nashville) conversion.
  │
  ├─[L3] deterministic fold + validate      ──► RoadmapSpec  →  validateRoadmapSpec
  │        SpanList (+ ops) → expand → run-length fold → spec → the EXISTING gate.
  │
  └─[L4] read-back tally + diff-aware regenerate
           echo per-section bar totals; regenerate feeds prior spec + correction.
```

L3's terminal gate is **unchanged** — `validateRoadmapSpec` stays the DB boundary
(`lib/roadmap-spec.ts`). Everything new (SpanList, fold, grammar) is pure and
sits *before* it, exactly mirroring the converter's "pure gate + thin transport"
discipline (`lib/roadmap-parse.ts`).

## 5. The SpanList intermediate

A flat, ordered, per-section list of contiguous spans with **explicit** bar
counts — the shape the author actually writes, made structural. A span's unit is a
whole **bar pattern** (one bar's worth of chords), NOT a single chord, so split
bars survive (the shipped model is `BarChange.chords: ChordHit[]`, and chunk-3
authoring already supports split bars like `5 4` and `1 - 4 5` via the
`-` tie grammar, `lib/roadmap-view.ts`):

```ts
// One bar's content: 1 chord = whole bar; N chords = a split bar, each carrying
// its beat weight, exactly as parseBarInput already produces (ViewCell[] → here
// normalized to ChordHit[] whose beats sum to timeSig.beats).
type BarPattern = ChordHit[];

interface ChordSpan {
  bar: BarPattern;   // the per-bar pattern (split-bar-aware), Nashville-normalized
  bars: number;      // contiguous bars sharing this IDENTICAL pattern (>= 1)
}
interface SectionDraft {
  label: string;             // "Verse", "Chorus", "Intro"…
  spans: ChordSpan[];        // IN ORDER, one per contiguous region — NEVER pre-merged
  ops?: StructureOp[];       // repeat / tag-edit / nav (§5.1)
}
type AuthoringDraft = {
  timeSig: TimeSig;
  renderKey: string;
  sections: SectionDraft[];
};
```

Why spans-with-counts (not one-element-per-bar):
- Mirrors the input 1:1 ("2 bars D" → `{ bar: [{degree:1}], bars: 2 }`), so the
  model transcribes rather than reinterprets.
- Each count is **explicit and summable** → the read-back tally (§8) and an
  internal per-section total are trivial, so a dropped span shows up immediately
  as a short total.
- Terser than 16 per-bar elements → less token pressure on long songs.
- A split bar is a span of `bars: 1` whose `bar` holds the multi-chord pattern;
  two consecutive identical split bars collapse to `bars: 2` losslessly (the fold,
  §6, re-expands them).

**Anti-collapse discipline (L2 prompt rules):**
- Emit **one span per contiguous region, in order**. Do **NOT** merge
  non-adjacent identical patterns (the three separate `D` spans stay three spans).
- Coalesce only **adjacent** identical bar patterns into one span's `bars` count;
  never across a differing bar.
- Do **NOT** introduce a `repeat` unless the author explicitly says "repeat."
- Preserve the **exact** chord quality given (major unless told minor; do not
  diatonicize).
- The enumeration **is** the answer — there is no terser "correct" form to collapse
  toward, so the reward that drove the bug is gone.

### 5.1 StructureOp — the op union (build-ready)

Ops are the non-span structure the author states in prose. Each op is applied at a
defined phase (§6) so ordering and bounds are unambiguous. All bar references are
**1-based bar positions within the section, against the section's pre-op
(authored-span) bar array** — pinned so an op can't drift after another op resizes
the section.

```ts
type StructureOp =
  // Splice: remove `count` bars at 1-based `at`, insert the given spans in their
  // place. The "drop one bar of G, replace with Bm7/Em/A" tag = remove 1 at the
  // final-G position, insert [Bm7,Em,A] spans. Pure array splice on the expanded
  // bar array.
  | { kind: 'spliceBars'; at: number; count: number; insert: ChordSpan[] }
  // Section repeat. Maps 1:1 to SectionRepeat (plain | volta). Mutually exclusive
  // per section (a section has at most ONE repeat op).
  | { kind: 'repeat'; repeat: SectionRepeat }
  // Global navigation marker. `ref` is { sectionId, bar } (stable-id, lowered to a
  // BarRef index at fold time exactly like viewToSpec does today).
  | { kind: 'nav'; marker: 'segno'|'coda'|'toCoda'|'fine'; ref: ViewBarRef }
  | { kind: 'navJump'; at: ViewBarRef; from: 'capo'|'segno'; until: 'end'|'fine'|'coda' };
```

Bounds + conflict rules (validated before fold; a violation fails the draft with a
clear error, never a silent drop):
- `spliceBars`: `1 ≤ at`, `count ≥ 0`, `at + count - 1 ≤ section.bars`; `insert`
  spans well-formed. Multiple splices on one section apply **left-to-right by
  `at`, on the original (pre-op) bar positions** — i.e. positions are resolved
  once, up front, so earlier splices don't renumber later ones (no index drift).
  Overlapping splice ranges = error.
- `repeat`: at most one per section; `plain` requires `section.bars ≥ 2`; `volta`
  endings obey the existing validator preconditions (start>1, non-overlap, passes
  partition 1..max). Repeat is resolved **after** splices (it brackets the final
  bar array).
- `nav`/`navJump`: cross-field preconditions (toCoda⇒coda, D.S.⇒segno, al-Coda⇒
  coda+toCoda, al-Fine⇒fine) are **not** re-checked here — they remain the
  domain of `validateRoadmapSpec` at the L3 gate, so there is one source of truth.
  A nav `ref` to a deleted/spliced-away bar drops that nav block (same fail-safe
  as the chunk-3 `lowerNavigation`).

## 6. Deterministic fold (SpanList → RoadmapSpec)

Pure function `foldDraft(draft: AuthoringDraft): RoadmapSpec`. For each section:

1. **Expand** spans → a per-bar degree array (`section.bars` = Σ span.bars).
2. **Sparse `changes`**: emit a change only at bars where the chord differs from
   the previous bar (the sparse-overlay model the renderer already expects) —
   computed by us, losslessly, from the explicit array. The model never makes this
   call.
3. **`repeat`**: only when an `op` explicitly declares one (plain or volta);
   never inferred from a repeated chord pattern.
4. **Structure ops** (tag-edits like "drop a bar of G, add Bm7/Em/A") are applied
   to the bar array **before** folding, so the post-chorus tag becomes literal bars.

**Re-expand semantics (round-trip definition).** "Re-expand" in the round-trip
test means: walk the section's bars 1..N and, for any bar with **no** sparse
`change`, **inherit the previous bar's pattern** (the sustain-until-next-change
model the renderer draws). This is deliberately **NOT** `specToView`'s view shape,
which leaves unaddressed bars `null` for editor cells. The fold's inverse must use
inheritance so `re-expand(fold(draft)) == draft`'s explicit per-bar array; a `null`
re-expansion would falsely "lose" the sustained bars and break the invariant.

**Op ordering (single defined phase order, no drift).** Per section, fold applies:
(1) expand spans → explicit bar array; (2) apply `spliceBars` ops left-to-right on
**pre-op** positions (§5.1, resolved once up front); (3) recompute `section.bars`;
(4) derive sparse `changes` by inheritance-diff; (5) attach the single `repeat` op;
(6) lower `nav`/`navJump` refs to BarRef indices (dropping any ref to a
spliced-away bar). Navigation cross-field preconditions are left to
`validateRoadmapSpec` at L3 — one source of truth.

The fold is the *only* place compression happens, it is total and deterministic,
and it is unit-testable against fixtures (round-trip: SpanList → spec → re-expand
== original bar array, by the inheritance definition above).

## 7. Span-grammar (the deterministic front-end, L1)

A small, explicit grammar for the countable phrasing authors naturally use, parsed
with **no LLM**:

- `"<N> bars <CHORD>"`, `"<CHORD> for <N> bars"`, `"<N> bars of <CHORD>"`
- comma/clause-separated span lists ("2 bars D, 2 bars G7, 2 bars D, …")
- `<CHORD>` accepts **letter names** (the way the failing input was written —
  `D`, `G7`, `Dsus2`) **or** roman/number degrees.

### 7.1 The chord parser (the part Codex flagged)

The motivating failure is **letter-chord** input. `lib/roadmap-view.ts::parsePart`
parses only `[IiVv]+|[1-7]` and *rejects* letters and accidentals — so it cannot
normalize `D`/`G7`/`Dsus2`. We therefore add a dedicated **key-aware
letter→degree parser**, `parseLetterChord(token, renderKey)`, the inverse of the
renderer's existing `degreeLetter(degree, renderKey)`:

```ts
// "G7" + renderKey "D" → { degree: 4, quality: '7' }   (G is the 4 of D)
// "Bm7"               → { degree: 6, quality: 'm7' }
// "E/D"               → { degree: 2, bass: 1 }          (slash bass → degree)
// "C" + renderKey "D" → CHROMATIC (C is ♭7 of D): no diatonic degree → null
function parseLetterChord(token: string, renderKey: string): ChordHit | null;
```

Algorithm (pure, key-aware, fixture-tested):
1. Tokenize `root[accidental][quality][/bass]` with an explicit regex
   (`^([A-G])([#b]?)(...quality...)?(?:/([A-G][#b]?))?$`).
2. Map the (root, accidental) letter to the **scale degree in `renderKey`** by
   inverting the renderer's key→letter table. A letter that lands on a diatonic
   scale tone yields `degree ∈ 1..7`; map the quality suffix to the existing
   `ChordHit.quality` enum; map a slash `/bass` letter to its degree.
3. **Chromatic roots fall through.** A letter that is NOT a diatonic degree of
   `renderKey` (e.g. `C` in key D = ♭7, or the `E/D`→`6/5` ambiguity) returns
   `null` — the grammar does **not** force it. `null` means "not a clean diatonic
   degree": the token is handed to L2, and a true chromatic root is the
   **Gap-1 `alter` follow-on** (`docs/design-roadmap-expressiveness.md`), NOT
   silently rounded to the nearest degree.

This keeps L1 honest: it converts only what it can convert *exactly*, and defers
everything else rather than guessing. Roman/number tokens continue to route through
the existing `parsePart` rules unchanged; letters route through `parseLetterChord`.

What the grammar does NOT try to parse (hands to L2): "drop one bar of G and
replace with …", "repeat verse", "Verse 3 is a variant", nav directives, chromatic
roots, anything ambiguous. The grammar is a **fast, faithful path for the part that
is failing**, not a general NL parser — when it doesn't match, L2 covers it.
(Coverage telemetry: log grammar-hit vs LLM-fallback ratio to see how much we keep
deterministic.)

## 8. Read-back tally + diff-aware regenerate (L4)

The loop the author actually invoked. Two pieces:

- **Read-back tally** (post-parse, pre-accept): a per-section plain-English echo —
  *"Verse: 16 bars — D×2, G7×2, D×2, G7×2, D×2, E×2, G×2, Dsus2×2."* A dropped span
  is caught on sight, before it's ever saved. Rendered from the SpanList, so it
  reflects exactly what will fold into the spec.
- **Diff-aware regenerate:** today regenerate re-parses **cold** (per chunk-3
  notes, replaces the whole spec from a fresh prompt). Instead, feed the **prior
  SpanList + the author's targeted correction** ("the verse should be 16 bars,
  you dropped the middle D-G7-D") back as context, so the model *edits* rather
  than re-guesses. Pairs with the Option-A scoped-patch direction already logged
  for the AI edit loop. Regenerate still re-folds + re-validates through L3.

## 9. Build steps

- **5a — spine:** `AuthoringDraft`/`SpanList` types + `foldDraft` (pure) + the
  read-back tally. Switch the existing parse to target the SpanList (L2 output
  contract change) and fold deterministically. Biggest fidelity win; keystone.
- **5b — span-grammar (L1):** deterministic parser for the countable phrasing;
  L2 becomes residue-only. Adds coverage telemetry.
- **5c — diff-aware regenerate (L4):** prior-draft + correction context; scoped
  edit instead of cold re-parse.

5a alone fixes the reported bug (explicit per-span counts + deterministic fold +
read-back). 5b and 5c harden and close the loop.

## 10. Tests

- `foldDraft`: span expansion arithmetic (Σ bars == section.bars); sparse-change
  derivation (change only on chord change); **inheritance** round-trip (SpanList →
  spec → re-expand-by-inheritance == bar array, including a sustained multi-bar
  span); `spliceBars` applied on pre-op positions (two splices don't drift);
  overlapping-splice = error; `repeat` only when declared; nav ref to a
  spliced-away bar drops the nav block.
- split bars: two adjacent identical split-bar patterns (`1 - 4 5`) coalesce to a
  `bars: 2` span and re-expand losslessly; a span's `bar: ChordHit[]` beats sum to
  `timeSig.beats`.
- `parseLetterChord`: `"G7"`+key D → `{degree:4,quality:'7'}`; `"Bm7"` →
  `{degree:6,quality:'m7'}`; `"E/D"`+key D → `{degree:2,bass:1}`; chromatic root
  `"C"`+key D → `null` (deferred to L2 / Gap-1, never rounded); round-trips against
  `degreeLetter` for all diatonic degrees across several `renderKey`s.
- span-grammar: the failing verse string parses to 8 spans / 16 bars; the
  alternating front (`D G7 D G7 D`) yields **five** spans, not a collapsed vamp;
  non-grammar prose returns "no match" (falls through to L2).
- parse boundary unchanged: malformed/hallucinated drafts still die at
  `validateRoadmapSpec`; the new layers never emit an unvalidated spec.
- read-back tally renders correct per-section totals from a SpanList.

## 11. Open questions

1. **L2 output: SpanList JSON, or extended-thinking + SpanList?** Making the
   enumeration the output already lifts the gag (§5). Do we *also* enable the
   SDK's thinking for the structural-op reasoning ("drop a bar, add a tag"), or is
   the explicit SpanList enough? (Lean: SpanList first; add thinking only if the
   fuzzy-op accuracy needs it.)
2. **Grammar breadth (5b).** Start with the exact `"N bars CHORD"` family above,
   or also cover "Nx CHORD", bar-range notation, beat-splits in prose? (Lean:
   ship the core family; widen by telemetry.)
3. **Mid-song key change.** A section that modulates (e.g. verse in D, chorus in
   G) is currently inexpressible — `renderKey` is global. Same family as the ♭7
   accidental gap (both = "tones outside one diatonic key"). Out of scope for
   chunk 5; flagged for an expressiveness chunk. **Design must compose with chunk
   4's transpose-invariance** — store any key change RELATIVE (a section-local
   tonic expressed as an interval/degree off the primary key), so a global re-key
   still moves everything together. (Detailed in the chunk-4/expressiveness
   discussion; captured here so 5a/5b don't bake in a single-key assumption that
   blocks it.)
