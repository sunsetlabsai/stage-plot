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
| Ordered sections + bar counts + repeats/voltas + time sig | **Built** — `RoadmapSpec` / `RoadmapSection`, `lib/roadmap-spec.ts:19-51` |
| Nashville chord model incl. split bars | **Built** — `ChordHit`, `BarChange`, `lib/roadmap-spec.ts:75-87` |
| Deterministic text → structure parser | **Built but chord-oriented** — `parseDescription` (`lib/roadmap-authoring.ts:545`) rejects form-only input (`:559`); **not reusable here**, see §6.2 |
| Transcribe-then-fold parse discipline (anti bar-drop) | **Built** — `lib/roadmap-parse.ts`, `design-roadmap-authoring-fidelity.md` §2 |
| Song-scoped canonical structure + per-chart alignment | **Designed + pure code, UNWIRED** — `lib/song-structure.ts`; no table, no route, no UI |
| Provenance rule for `SongStructure` | **Decided** — `design-conductor-authority.md` §2.2.1 (converter proposes → owner confirms once → later charts align in) |
| **A proposer that does not require PDF geometry** | **← this doc** |
| **Lyrics-sheet section grammar as a parseable source** | **← this doc** |
| **A form-only (chord-free) path into `RoadmapSpec`** | **← this doc** (§6.2) |

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
| `<Label> x<N>` | **play the section N times** — carries **no bar count**, so it inherits like a bare label | `Chorus x2` → the 8-bar chorus, twice |
| `<Label>` (bare) | inherit bar count from the previous same-labelled section | second `Verse` → 8 bars |

⚠ Note the second row: **`x<N>` states a repeat, not a length.** In the worked example
below, the final `Chorus x2` gets its 8 bars from the earlier `Chorus 8x` — so it is an
*inheriting* form too, and carries exactly the same guess risk as a bare label (§2.2).

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
   conductor position. It is **not** sufficient for duration estimates.
   `RoadmapSpec` carries `timeSig` but no provenance, so a defaulted 4/4 would read as
   fact downstream. **Decision (Graham): carry the provenance in the spec** — add an
   optional field (e.g. `timeSigSource?: 'read' | 'assumed'`; absent ⇒ `'read'`, so every
   existing spec keeps its current meaning).
   **No `ROADMAP_SPEC_VERSION` bump and no migration**: an added *optional* field is
   forward-compatible, the same argument PR #172 makes for `Bar.measures?: number`
   ("optional-field forward-compat, no schema bump"). Keeping the two decisions
   consistent matters more than either one individually — both are "a count/unit we
   defaulted, recorded as defaulted."
   Downstream rule: anything computing **duration** must refuse to run on
   `timeSigSource: 'assumed'` until an owner confirms the meter. Form, bar counts and
   conductor position are unaffected — they never needed the meter.
2. **No chords.** Addressed in §4.
3. **No sub-bar rhythm.** Out of scope by construction — that is a chart, not a form.
4. **No lyric-to-bar alignment.** §3.

### 2.2 Ambiguities the parser must surface rather than resolve

- **Any inheriting section requires explicit per-section confirmation.** That means
  **both** a bare `<Label>` **and** a multiplier-only `<Label> x<N>` — the latter states
  how many times to play a section, never how long it is, so it inherits its bar count
  exactly as a bare label does. *(The `x<N>` case was missed in the first two drafts and
  caught in Codex R2; the doc's own worked example depends on it.)*
  If verse 1 is 16 bars and verse 2 is 8, inheritance produces a confidently wrong
  form. An inherited count is still a **guess** — the source omitted it — so by this
  doc's own standard (§3) it cannot be emitted as a resolved value. An inheriting
  section yields a **proposed** count the owner must confirm per section; it is never
  persisted on confidence alone. With no same-label antecedent it **fails**; we do not
  invent a length in either form. *(Tightened from "reduced confidence + review flag"
  after Codex R1: a flag still ships a concrete number.)*
- **Multiplier scope.** `Verse, Chorus x2` — the `x2` binds to `Chorus` under this
  grammar. If a sheet ever intends "the verse/chorus pair, twice," the grammar cannot
  express it and the parser must not invent it. Parse per-section; flag adjacent
  multipliers that look like a group repeat.
- **Label vocabulary is open.** `Out`, `Outro`, `Tag`, `Ending` are the same idea.
  Normalize for *seeding* alignment only — `lib/song-structure.ts` is explicit that
  label+ordinal is a seed heuristic and never the cross-chart authority.

### 2.3 The unit is the musical measure, never the visible bar

*(Raised by the parallel chunk-B session; it would otherwise have silently corrupted
§9 Q5.)*

`Verse 8x` means **eight musical measures**. That is not the same unit as
`ChartCalibration.Bar.absNumber`, which is *"1-based global bar number in reading
order"* (`lib/types.ts:113`) — i.e. **visible** bars on the page. A multirest is one
visible bar but N musical measures, so the two counts diverge on exactly the charts
where cross-instrument sync matters most: horn and vocal parts.

**Canonical unit = the musical measure.** Three reasons, in order:

1. **Canonical structure is abstract by definition.** `CanonicalBar` carries *"NO
   geometry — canonical structure is abstract"* (`lib/song-structure.ts:27-29`). Visible
   bars are a rendering property of one chart; measures are a property of the song. A
   canonical layer counted in visible bars would be chart-specific by construction,
   which is the one thing it exists not to be.
2. **Cross-instrument sync requires it.** A horn part with an 8-measure multirest and a
   guitar part with 8 written bars are *in the same place*. Only the musical count says so.
3. **The authored side is already musical.** `RoadmapSection.bars` comes from an author
   describing form; builder charts have no multirests, so it is a measure count already.

**What the alignment layer actually does with a multirest — degrade, not resolve.**
*(Corrected after Codex R2; an earlier draft claimed multirest alignment came "for
free," which overstated the model.)* Alignment maps a canonical **section** to a local
section plus a boolean — `NodeAlignment` is `{ status, localSectionId, barIsomorphic }`
(`lib/song-structure.ts:65-80`). It does **not** map N canonical bars onto 1 visible
bar; there is no bar-level correspondence in the model at all.

What is genuinely true, and verified: `seedAlignment` marks a span non-isomorphic when
bar counts differ (`lib/song-structure.ts:272-283`), and `resolveRef` then coarsens
`barOffset` to the local section head (`:242-248`). So a multirest section **degrades
safely to section precision** — "top of the bridge," not "bar 5 of the bridge."

That is the correct outcome under §2.2.0's *degrade precision, never honesty*, and it
means choosing the musical measure as the canonical unit introduces **no new failure
mode**. It is not the same as bar-accurate following through a multirest, which the
model cannot express today and which nothing in this design proposes to add.

**Consequence for this design:** a lyrics-derived count is directly comparable to
`RoadmapSection.bars` and to `SongStructure` bars, and is **not** comparable to
`max(absNumber)`. See §9 Q5.

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

A split bar carries its own subdivision in the notation. Nothing is recovered from
position, so promotion from L0 to L1 is safe — and the whole path is **already built
and reachable on a saved chart**:

- **Re-open.** Builder charts carry an **Edit** affordance in `ManageChartsModal`
  (`components/ManageChartsModal.tsx:248-256`) → `startEdit` fetches the saved spec
  from `/api/charts/roadmap/[chartId]` (`:128-140`) → the builder mounts in edit mode.
- **Enter chords.** In the rendered Nashville sheet, **click a bar** → an inline input
  (`components/RoadmapBuilder.tsx:1040-1080`), grammar `1   5 4   1 - 4 5` (space
  separates chords in the bar, `-` holds), with a live `SplitPreview` carving the bar
  by beats as you type. Commit on Enter → `onCommitBar`
  (`components/RoadmapBuilder.tsx:405, 942`).
- **An all-empty spec is already representable.** `ViewBar = ViewCell[] | null`
  (`lib/roadmap-view.ts:38`) and the view model seeds `Array.from({length: sec.bars},
  () => null)` (`lib/roadmap-view.ts:341`). An L0 spec — correct bar counts, zero
  `changes` — is a valid, renderable, editable chart on day one. **This is the single
  most load-bearing reuse in this design**: the lyrics parser's output is not a new
  kind of object needing new UI, it is an ordinary builder chart with empty bars.

> ⚠ **Discoverability gap (not a blocker for this design, but a real finding).**
> Chord entry lives on the *chart preview*, not on the section list — the section list
> offers only `+ Add section` / remove (`RoadmapBuilder.tsx:573-574, 742`). Nothing signals
> that clicking a bar is how chords are entered. An owner handed an L0 chart from a
> lyrics sheet will be looking for exactly this and will plausibly conclude the product
> cannot do it. Worth a separate UX ticket; this design assumes the capability, not the
> affordance.

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
`fileId` (`app/[owner]/[show]/page.tsx:3364`), positions are chart-local bar ids
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
2. **Emit a `RoadmapSpec` directly — do NOT route through `parseDescription`.**
   *(Corrected after Codex review; an earlier draft of this doc claimed the authoring
   surface could be reused, and it cannot.)* The existing text path is chord-oriented
   and **rejects form-only input**: `parseDescription` returns null for a labelled
   section with no span body — `if (clauses.length === 0) return null; // a labelled
   section with no spans = miss` (`lib/roadmap-authoring.ts:559`) — and the whole
   description defers on any unparseable clause (`:564`). `Verse 8x` has no chord
   clause by construction, so **every** lyrics sheet would defer.

   The L0 shape is simpler than an `AuthoringDraft` anyway: an ordered list of
   `{ label, bars, repeat? }`. Build a **form-only adapter** that emits `RoadmapSection[]`
   with `changes` **omitted** — legal, since `changes?` is optional
   (`lib/roadmap-spec.ts:32`) and the view model already seeds empty bars
   (`lib/roadmap-view.ts:341`). Do not synthesize placeholder spans to satisfy the
   authoring surface: that would invent chords, violating §4.1.
3. **Validate.** `validateRoadmapSpec` remains the DB boundary gate; a lyrics-derived
   spec earns no exemption from it.
4. **Read back a tally computed from the FOLDED SPEC, not the draft.** A read-back echo
   is mandatory here — a dropped section is the failure mode most likely to look
   plausible. But `tallyDraft` is **op-blind**: it sums `sec.spans` and ignores ops
   (`lib/roadmap-authoring.ts:407-416`), a fidelity hole already recorded as verified in
   `docs/backlog-charting.md` ("an intro `3x` repeat is not reflected"). This grammar
   emits repeats as a matter of course (`Chorus x2`), so `tallyDraft` would silently
   under-report exactly the construct we most need echoed. **The tally for this path
   must be derived from the validated spec** (sections × bars, with repeats expanded),
   or `tallyDraft` must first be made op-aware. Until one of those exists, the repeat
   grammar is not pinned.

**Determinism first.** The grammar in §2 is regular. An AI parse is a *fallback* for
sheets that deviate, subject to the same transcribe-then-fold split already used in
`lib/roadmap-parse.ts` — the model transcribes, we compress, the validator disposes.

---

## 7. Confidence and failure modes

Every one of these degrades to review, never to a silent result.

| Condition | Handling |
| --- | --- |
| Bare section, no prior same-label section | **Fail** the section; cannot invent a bar count |
| `<Label> x<N>`, no prior same-label section | **Fail** — a multiplier states repeats, not length (§2.2) |
| Any inheriting section (bare **or** `x<N>`) with an antecedent | **Propose** the inherited count; **require per-section owner confirmation** before persisting (§2.2) |
| No key line | Spec needs `renderKey`; prompt the owner, do not default |
| No time signature | Default `4/4` with `timeSigSource: 'assumed'` in the spec; duration math refuses until confirmed (§2.1) |
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

1. ~~**Corpus shape.**~~ **RESOLVED (Graham, 2026-09-02).** The existing library's
   lyrics PDFs are **already `role='lyrics'`** rows in `chart_library`, so ingest over
   the current corpus is a route over existing rows — no bulk importer needed.
   **But newly uploaded lyrics sheets are not tagged**, and would have to be marked as
   such at upload. That makes upload-time role tagging a **prerequisite for the ongoing
   path**, not for the backfill. Two consequences:
   - The backfill (existing corpus) and the ongoing path (new uploads) can ship
     **independently**; the backfill is unblocked today.
   - Ingest must key off `role='lyrics'` and must **not** infer "this looks like a
     lyrics sheet" from content. An untagged sheet is simply not a candidate — the
     honest failure is "not tagged," never a guess. (§7's fail-closed posture.)
2. **Text-layer coverage — unknown, cheaply measurable, and NOT a ceiling.**
   Graham (2026-09-02): *"not sure I know how to answer... but some do. And if/as
   needed, I can edit or add new ones with follow-able marks."* Two consequences, and
   the second is the important one:
   - **Measure it before building.** A read-only pass over `role='lyrics'` rows
     extracting text-layer presence + §2 grammar-match is a few hours and turns this
     from an assumption into a number. Do that first; it sizes chunks 1-2 exactly.
   - **The corpus is AUTHORABLE, so a parse failure is a work queue, not a dead end.**
     This is unlike the charting corpus, where a scan is simply a scan. If a sheet has
     no text layer or deviates from the grammar, Graham can add followable marks to it.
     **Design consequence:** ingest must emit a per-sheet **failure report naming the
     reason** (no text layer / no key line / unparseable header / bare section with no
     antecedent), not a silent skip count. That report *is* the annotation backlog.
     A design that only reports "412 of 464 succeeded" wastes the one property that
     makes this corpus better than the PDF one.
3. **Does a lyrics-derived proposal outrank a converter proposal** when both exist for
   one song, or does the owner always arbitrate? Recommendation: owner arbitrates, but
   default the selection to the lyrics read, since it is stated rather than recovered.
4. **Per-performer view lens.** Once a roadmap carries L1 changes it is legitimately
   viewable, and some players prefer a one-page number chart to a four-page part. Is
   that a per-performer preference inside conductor mode? Believed desirable; deferred
   — it is a conductor-UI question, not a structure question.
5. **Validation sweep — DESIGN-unblocked by #172, still BUILD-blocked, and the residual
   block is the interesting part.**
   Where lyrics-derived form and a converter read exist for the same song, agreement is
   independent corroboration of both. But the two are in **different units** (§2.3): the
   lyrics count is musical measures, `absNumber` is visible bars. Comparing them
   directly mis-reports every chart containing a multirest. Without a musical count a
   multirest is indistinguishable from an ordinary bar, so we cannot even identify which
   charts are safe to compare.
   **PR #172 merged (`4d290db`), so `Bar.measures?: number` is now a frozen spec** —
   `docs/design-chart-measurement.md` §Multirests. That closes the *design* dependency
   this item was originally waiting on. **It does not close the data dependency:**
   `Bar.measures` is not implemented in code, and calibration writes are
   **generate-once / insert-only** (`docs/design-chart-measurement.md`; there is no
   same-hash machine re-run). Multirests are captured **at creation, by chunk B2**.
   Two consequences that size this item honestly:
   - The sweep waits on the **B2 build**, not on a merge.
   - Even after B2 ships, only charts **created by the measured path** carry `measures`.
     Pre-B2 calibrations never acquire it by machine — an owner overwrite (PUT) is the
     only path. So the sweep's corpus is *post-B2 charts*, and it must report the
     unmeasurable remainder rather than silently comparing against a default of 1.
   When it runs it compares `Σ section.bars` (lyrics) against `Σ Bar.measures`
   (calibration) — never `max(absNumber)`.

---

## 10. Build outline (after sign-off — design-first, not building)

Gated commits, Codex per chunk.

1. **Grammar parser (pure, tested).** Header extraction + §2 grammar → `RoadmapSpec`
   **directly**, per §6.2 — a form-only adapter emitting `RoadmapSection[]` with
   `changes` omitted. It does **not** route through `AuthoringDraft`, `parseDescription`
   or `foldDraft`; that path rejects chord-free input (`lib/roadmap-authoring.ts:559`).
   **Tests:** each grammar row in §2; every §7 failure mode; the §2 worked example
   end-to-end; a bare section with no antecedent fails; a multiplier-only section with
   no antecedent fails (§2.2).
2. **Ingest path.** Text-layer extraction from a lyrics PDF → parser →
   `validateRoadmapSpec` → proposal record. Fails closed with no text layer.
   Read-back tally derived from the **validated spec**, not `tallyDraft` (§6.4) —
   `tallyDraft` is op-blind and this grammar emits repeats routinely.
3. **Owner confirmation UI.** Proposal → review → confirm, reusing the §2.2.1 flow.
   Blocked on that flow existing (conductor chunk 1 wiring).
4. **`SongStructure` seeding.** Confirmed spec → `SongStructure` + initial
   `ChartAlignment` via the existing `seedAlignment` (`lib/song-structure.ts:293`).
   **This chunk requires `SongStructure` to be PERSISTED, and no chunk owns that yet.**
   Conductor chunk 1 is explicitly the *pure* model — "`SongStructure` + alignment model
   (pure, tested)" (`docs/design-conductor-authority.md` §9.1) — it does not include a
   table, a route, or a review flow. So this depends on a **future persistence + review
   chunk that does not currently exist in any build outline**. *(Corrected after Codex
   review; an earlier draft wrongly assigned persistence to conductor chunk 1.)*
5. **Corroboration report.** Where both a lyrics read and a converter read exist,
   report agreement/disagreement per song (Q5).

6. **Upload-time `lyrics` role tagging.** Only gates the *ongoing* path (new uploads);
   the backfill over the already-tagged corpus does not wait on it (§9 Q1).

**Chunk 0 — measure the corpus first.** Before any of the above: a read-only pass over
`role='lyrics'` rows reporting text-layer presence and §2 grammar-match rates (§9 Q2).
It is small, it sizes chunks 1-2, and it produces the annotation backlog. Nothing here
should be built against an assumed coverage number.

**Sequencing note.** Chunks 1–2 are self-contained and depend on nothing unbuilt —
they produce a validated `RoadmapSpec`, which is already a first-class, editable
builder chart (§4.1). **That is a shippable increment on its own**, and it is where
this design's value is cheapest to realise.

Chunks 3–5 depend on `SongStructure` persistence, which **no existing chunk owns**
(§10.4). This design does not propose building it. What it does establish is a second,
geometry-independent reason to build it — the canonical layer currently has a supply
problem, and a corpus that already contains the answer.
