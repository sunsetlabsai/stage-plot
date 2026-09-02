# Song form from lyrics sheets — a geometry-free proposer for canonical structure (design)

**Status:** design only. Nothing built. Build gated on explicit GO.

---

## 0. What this is, in one paragraph

We hold a large corpus of lyrics PDFs whose section headers already carry the song's
form in plain text — `Intro 4x`, `Verse 8x`, `Chorus x2`, `Out 4x`, plus a key. That
text is a **complete, geometry-free statement of song form**. This design parses it
into the existing `RoadmapSpec` (`lib/roadmap-spec.ts`) and uses the result as a
**second proposer** for the `SongStructure` provenance step already specified in
`design-conductor-authority.md` §2.2.1 — the step that today has exactly one proposer,
the PDF converter, which depends on the geometry pipeline landing.

**The thesis:** for any song where a lyrics sheet exists, we can obtain canonical song
structure **without solving bar geometry at all**.

### 0.1 What is genuinely new here — and what is not

This doc claims a narrow delta. Most of the machinery it needs already exists, and
saying so precisely is the point.

| Concern | Status in repo today |
| --- | --- |
| Ordered sections + bar counts + repeats/voltas + time sig | **Built** — `RoadmapSpec` / `RoadmapSection`, `lib/roadmap-spec.ts:19-34` |
| Nashville chord model incl. split bars | **Built** — `ChordHit`, `BarChange`, `lib/roadmap-spec.ts:75-87` |
| Deterministic text → structure parser | **Built** — `parseDescription`, `lib/roadmap-authoring.ts:545` |
| Transcribe-then-fold parse discipline (anti bar-drop) | **Built** — `lib/roadmap-parse.ts`, `design-roadmap-authoring-fidelity.md` §2 |
| Song-scoped canonical structure + per-chart alignment | **Designed + pure code, UNWIRED** — `lib/song-structure.ts`; no table, no route, no UI |
| Provenance rule for `SongStructure` | **Decided** — `design-conductor-authority.md` §2.2.1 (converter proposes → owner confirms once → later charts align in) |
| **A proposer that does not require PDF geometry** | **← this doc** |
| **Lyrics-sheet section grammar as a parseable source** | **← this doc** |

Everything else below is composition, not invention. Where this doc and an existing
doc disagree, the existing doc wins and this one is wrong.

---

## 1. The problem

`design-conductor-authority.md` §2.2.1 fixes how canonical structure comes into being:

> **Converter proposes.** On first import for a song, the converter extracts a candidate
> canonical roadmap (its per-chart structural read becomes the seed).

That is a good rule with one supply problem: the converter's structural read is
recovered from PDF vector geometry. It is the hardest, least certain part of the
system, and canonical structure — the thing conductor mode's whole cross-chart story
depends on — is currently downstream of it.

Meanwhile the same fact, stated unambiguously in text, is sitting in a corpus we
already have.

**A lyrics sheet is a bad chart and an excellent form document.** It carries no
geometry worth recovering, and that is exactly why it is easy: there is nothing to
measure. The form is written down.

---

## 2. The source grammar

Section headers in the corpus follow a consistent convention:

| Form | Meaning | Example |
| --- | --- | --- |
| `<Label> <N>x` | **bar count within** the section | `Verse 8x` → an 8-bar verse |
| `<Label> x<N>` | **play the section N times** | `Chorus x2` → the chorus, twice |
| `<Label>` (bare) | inherit bar count from the previous same-labelled section | second `Verse` → 8 bars |

A representative sheet:

```
Key: G
Intro 4x
Verse 8x
Chorus 8x
Solo 4x
Verse
Chorus x2
Out 4x
```

which is, in `RoadmapSpec` terms: seven ordered `RoadmapSection`s, `bars` set from the
`Nx` form, and `repeat: { kind: 'plain', times: 2 }` on the final chorus.

### 2.1 What the grammar does not carry

Named explicitly, because each one is a place we must not guess:

1. **No time signature.** Bars are bars, which is sufficient for form and for
   conductor position. It is **not** sufficient for duration estimates. Default to
   `4/4` and record that it was **assumed**, never inferred.
2. **No chords.** Addressed in §4.
3. **No sub-bar rhythm.** Out of scope by construction — that is a chart, not a form.
4. **No lyric-to-bar alignment.** §3.

### 2.2 Ambiguities the parser must surface rather than resolve

- **Bare-section inheritance is right most of the time and silently wrong sometimes.**
  If verse 1 is 16 bars and verse 2 is 8, inheritance produces a confidently wrong
  form. Bare sections resolve **with reduced confidence, flagged for review** — never
  silently.
- **Multiplier scope.** `Verse, Chorus x2` — the `x2` binds to `Chorus` under this
  grammar. If a sheet ever intends "the verse/chorus pair, twice," the grammar cannot
  express it and the parser must not invent it. Parse per-section; flag adjacent
  multipliers that look like a group repeat.
- **Label vocabulary is open.** `Out`, `Outro`, `Tag`, `Ending` are the same idea.
  Normalize for *seeding* alignment only — `lib/song-structure.ts` is explicit that
  label+ordinal is a seed heuristic and never the cross-chart authority.

---

## 3. Lyrics do not go on the roadmap

**Decision. The lyric text is discarded after the structural headers are parsed.**

The reason generalizes past this feature:

> **Horizontal position cannot be recovered from text.**

To place a lyric line against a bar we would have to guess where in the bar the
syllable falls. A guessed position is worse than no position, because a performer
reads position as information — the same failure mode as a drifting bar overlay, on
a different axis. And at performance distance, a roadmap that has become a page of
lyrics is no longer glanceable, which was its only job.

If lyrics are wanted at performance time, the lyrics chart itself already exists as a
`role='lyrics'` chart (`supabase/migrations/003_chart_library.sql:16-29`) and can be
viewed directly. That is a solved problem and this is not it.

---

## 4. The fidelity ladder

The one framing that keeps this design from over-reaching:

| Level | Content | Where it lives today |
| --- | --- | --- |
| **L0 — form** | ordered sections, bar counts, repeats, key | `RoadmapSpec` with `changes` omitted |
| **L1 — harmonic sketch** | + one chord per bar (NNS) | `RoadmapSpec` with `changes` populated |
| **L2 — chart** | + sub-bar hits, pushes, kicks, geometry | existing builder/converter charts |

A lyrics sheet yields **exactly L0**.

**L0 is a finished artifact, not L2 with holes.** It is complete at its level: it can
drive conductor position, produce a bar count, seed alignment, and validate a
converter's structural read. Treating it as a degraded chart would be the wrong frame
and would invite exactly the guessing §2.1 and §3 forbid.

### 4.1 L0 → L1 is typed, never inferred

The complement of §3's principle:

> **Chord rhythm is encodable in text. Lyric alignment is not.**

`| 1 . 5 . |` carries its own subdivision. Nothing is being recovered from position,
so promotion from L0 to L1 is safe — and it is already built: `ChordHit` /
`BarChange` (`lib/roadmap-spec.ts:75-87`), the quality whitelist, the degree⇄letter
conversion in `lib/roadmap-view.ts`, and the `RoadmapBuilder` UI. An MD types changes
against a grid that already has the correct bar counts.

Because NNS is key-agnostic and the sheet supplies the key, transposition is free —
horns concert, guitar capoed, or the band dropping the song a whole step, all from
one stored spec.

**We do not AI-infer chords from key + section + song identity.** The model may
transcribe what an author states; it may not invent harmony.

---

## 5. Where it lands: a second proposer, not a new entity

§2.2.1's provenance rule is unchanged. This design adds one arrow into step 1.

```
                    ┌─ PDF converter (geometry) ──┐
  first import for  │                             │→ candidate → OWNER CONFIRMS ONCE
  a song            └─ lyrics sheet (text) ───────┘              → SongStructure
                              ▲ this doc                           (authoritative)
                                                                        │
                                              later charts align INTO it ┘
```

Consequences, all of them deliberate:

- **No new entity.** No "gold roadmap" table, no song-level structure invented here.
  The target is the already-designed `SongStructure` (`lib/song-structure.ts:35-40`).
- **No cross-tenant canonical layer.** `songs` is already owner-scoped
  (`unique(owner_id, song_key)`, `supabase/migrations/006_songs.sql`), so structure is
  the band's arrangement by construction. A platform-wide "this is what the song *is*"
  record would be net-new multi-tenant infrastructure, and the corpus could not
  populate it honestly anyway — a lyrics sheet is already *some band's* arrangement,
  with their cuts and their repeats. Crowning it canonical for everyone would assert
  an authority the data does not have.
- **Owner confirmation is not optional.** A parsed sheet is a *proposal*. It reaches
  `SongStructure` only through the same human confirmation the converter's proposal
  goes through.
- **No silent sync.** When a chart's structural read disagrees with confirmed
  structure, that is the existing review queue and the existing
  `local | tacet | unmapped` ladder (§2.2.0) — degrade precision, never honesty. This
  design adds no new coupling between representations.

### 5.1 Why this matters to conductor mode specifically

Today the conductor wire is scoped to a single chart file: `songRef` is the chart
`fileId` (`app/[owner]/[show]/page.tsx:3363`), positions are chart-local bar ids
(`lib/conductor-targets.ts:20-26`), and a follower on a different chart for the same song
is told so and self-navigates (`lib/relay-binding.ts:115`, `components/RelayStrip.tsx:136`).
Cross-chart following is deliberately deferred to 3c
(`design-conductor-3b-discovery-failover.md:354-361`).

3c needs a populated `SongStructure` for every song being conducted. Its only proposed
source is a geometry pipeline. **This gives 3c a supply of canonical structure that is
independent of geometry** — which also means the value of the measurement engine stops
being solely overlay quality and starts being cross-instrument sync.

---

## 6. Parsing approach

Reuse the existing discipline; do not build a second one.

1. **Extract the header lines** from the lyrics PDF's text layer. Section headers are
   short, line-initial, and match the §2 grammar; lyric body text does not. Scanned
   sheets with no text layer are **out of scope for v1** — they fail closed with
   "no text layer," they do not fall back to vision.
2. **Normalize to the authoring surface.** The deterministic
   `parseDescription(description, renderKey, timeSig)` (`lib/roadmap-authoring.ts:545`)
   already turns a textual structure description into an `AuthoringDraft`. Prefer
   normalizing the sheet's grammar into that surface over writing a parallel parser.
3. **Fold and validate.** `foldDraft` → `validateRoadmapSpec`, unchanged.
   `validateRoadmapSpec` remains the DB boundary gate; a lyrics-derived spec earns no
   exemption from it.
4. **Read back a tally.** `tallyDraft` exists precisely to catch a dropped span before
   save (`design-roadmap-authoring-fidelity.md` §2). A dropped section is the failure
   mode most likely to look plausible, so the tally is mandatory here, not optional.

**Determinism first.** The grammar in §2 is regular. An AI parse is a *fallback* for
sheets that deviate, subject to the same transcribe-then-fold split already used in
`lib/roadmap-parse.ts` — the model transcribes, we compress, the validator disposes.

---

## 7. Confidence and failure modes

Every one of these degrades to review, never to a silent result.

| Condition | Handling |
| --- | --- |
| Bare section, no prior same-label section | **Fail** the section; cannot invent a bar count |
| Bare section inheriting from a prior one | Resolve, **reduced confidence**, flag for review (§2.2) |
| No key line | Spec needs `renderKey`; prompt the owner, do not default |
| No time signature | Assume `4/4`, **record as assumed**; block duration math on it |
| Bar count total disagrees with a converter read of the same song | Surface both; owner decides. **Never auto-reconcile** |
| No text layer (scanned sheet) | Out of scope v1; fail closed |
| Adjacent multipliers suggesting group repeat | Parse per-section, flag (§2.2) |

---

## 8. Decisions locked

1. Lyrics text is **not** placed on the roadmap; position is not recoverable from text (§3).
2. L0 (form only) is a **complete artifact**, not a degraded chart (§4).
3. L0 → L1 is **typed NNS**, never AI-inferred harmony (§4.1).
4. The output is a `RoadmapSpec`; **no new spec type** (§0.1).
5. The lyrics sheet is a **second proposer** under the existing §2.2.1 provenance rule;
   **no new entity**, no "gold" layer, no cross-tenant canonical record (§5).
6. Owner confirmation remains mandatory; a parse is a proposal (§5).
7. Disagreement between a chart and confirmed structure goes to the **existing review
   queue**; no silent sync (§5).
8. `validateRoadmapSpec` remains the DB boundary for this path (§6).

---

## 9. Open questions

1. **Corpus shape.** How are the lyrics PDFs currently stored — already `role='lyrics'`
   rows in `chart_library`, or an external set awaiting import? This decides whether
   ingest is a route over existing rows or a bulk importer.
2. **Text-layer coverage.** What fraction of the corpus has a usable text layer? §6
   fails closed without one, so this sizes the feature. (The charting corpus ran 7/8
   vector, 1/8 scan; lyrics sheets are likely better, but that is an assumption, not a
   measurement.)
3. **Does a lyrics-derived proposal outrank a converter proposal** when both exist for
   one song, or does the owner always arbitrate? Recommendation: owner arbitrates, but
   default the selection to the lyrics read, since it is stated rather than recovered.
4. **Per-performer view lens.** Once a roadmap carries L1 changes it is legitimately
   viewable, and some players prefer a one-page number chart to a four-page part. Is
   that a per-performer preference inside conductor mode? Believed desirable; deferred
   — it is a conductor-UI question, not a structure question.
5. **Validation sweep.** Where lyrics-derived form and a converter read exist for the
   same song, agreement is independent corroboration of both. Worth running as a
   measurement before either is trusted. Sizing depends on Q1/Q2.

---

## 10. Build outline (after sign-off — design-first, not building)

Gated commits, Codex per chunk.

1. **Grammar parser (pure, tested).** Header extraction + §2 grammar →
   `AuthoringDraft`, via `parseDescription` where possible. **Tests:** each grammar row
   in §2; every §7 failure mode; the §2 worked example end-to-end; a bare section with
   no antecedent fails; a dropped section is caught by `tallyDraft`.
2. **Ingest path.** Text-layer extraction from a lyrics PDF → parser → `foldDraft` →
   `validateRoadmapSpec` → proposal record. Fails closed with no text layer.
3. **Owner confirmation UI.** Proposal → review → confirm, reusing the §2.2.1 flow.
   Blocked on that flow existing (conductor chunk 1 wiring).
4. **`SongStructure` seeding.** Confirmed spec → `SongStructure` + initial
   `ChartAlignment` via the existing `seedAlignment` (`lib/song-structure.ts:293`).
   **This is the chunk that requires `SongStructure` to be persisted** — currently it
   has no table. That persistence belongs to conductor chunk 1, not to this design.
5. **Corroboration report.** Where both a lyrics read and a converter read exist,
   report agreement/disagreement per song (Q5).

**Sequencing note.** Chunks 1–2 are self-contained and depend on nothing unbuilt.
Chunks 3–4 depend on conductor chunk 1 landing `SongStructure` persistence. This
design does **not** propose building that persistence — it is an argument for why
conductor chunk 1 is worth more than it currently looks.
