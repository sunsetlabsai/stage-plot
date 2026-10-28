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
| **Performance directions on a section (`note`, `open`)** | **← this doc** (§2.4) |

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

### 2.4 Performance directions — kept verbatim, in place

*(Amendment, 2026-10-28, per `design-common-roadmap.md` §4.2.)*

**Requirement (Graham, 2026-10-27).** Lines like "vamp until signaled change" or "solo over
the chorus until done" stay **verbatim, in place, inside their section**: not suppressed,
not ignored, not translated into a bar count.

**Why it matters more than the corpus shows (Graham, 2026-10-28).** Directions are rare in
the sheets because notation apps give us no clean way to write them, so the band does them
as audibles on stage and as pencil marks on the readers' charts. A place to write them down
makes them part of the chart. That makes this **an authoring feature first and a parsing
feature second**: an owner must be able to type a direction on any roadmap section, whether
or not a lyrics sheet ever proposed it (§2.4.3).

#### 2.4.1 What the live sheets actually say (measured)

A read-only scan of the 342 live lyric sheets (`~/x/lyrics-corpus`, every page, text layer,
all-caps lines only; scratch line-grouper — the build's acceptance arm re-measures with the
shipped `linesOf`, see §10):

| Kind of line | Lines | Sheets | Example |
| --- | --- | --- | --- |
| Header the #211 recognizer accepts | 2,673 | 332 | `VERSE 1 8X`, `VAMP 4X`, `INTRO VAMP` |
| **All-caps line with a count that it rejects** | **458** | **146** | `GUITAR SOLO 8X`, `QUIET CHORUS 8X`, `ADD DRUMS 4X` |
| … of which several sections on one line (`;`) | 72 | | `VAMP 4X; SOLO 12X`, `DRUMS 4X; ADD KEYS 6X` |
| … of which an extra count (`+`) | 80 | | `CHORUS 8X + 4`, `PRE-CHORUS 4X+1X`, `CHORUS 4X (+2 BEATS)` |
| **Open length** ("at least N") | 6 | | `SOLO 8X+`, `OUTRO 8X+`, `CHORUS 14X+` |
| **Uncertain count** (author unsure: `?`, `?X`, bare `X`) | 68 | 20 | `CHORUS 24X ?`, `VERSE 1 ?X`, `INTRO X; CHORUS X` |
| Cued or free direction, no count | 2 | | `KEYS SIGNAL CHANGE TO GET LUCKY`, `REPEAT SONG` |
| All-caps line, no count, not a header | 67 | 51 | `AC/DC · Key G · 127 BPM`, `ARRANGEMENT NOTE`, `(BUH BUH BUH BUM)` |

Three conclusions, each one a rule below:

1. **The real gap is coverage, not "until signaled".** One sheet in three (146/342) has
   count-bearing section lines the #211 recognizer rejects: instrument and qualifier labels,
   `+` counts, several sections on one line. #211 was right to reject them. For section
   *marks*, a missed line costs the owner one tap and a false one is a wrong seek target.
   **For the proposer, a missed line is a wrong form.** So the proposer gets a wider grammar
   (§2.4.2) and the #211 recognizer stays exactly as it is. Hand check: 30 of 30 randomly
   sampled rejected count-bearing lines were real sections, none were lyrics.
2. **Open and uncertain are different things.** `8X+` is the author saying "at least 8, then
   on a cue": a fact about the performance. `24X ?` is the author not knowing: a gap in the
   sheet. They must never share a representation.
3. **Count-less lines can't be told apart by shape.** In that row, a direction
   (`KEYS SIGNAL CHANGE…`) sits beside band/BPM title lines and sung syllables. The proposer
   does not guess about them (§2.4.2, "Two more rules").

#### 2.4.2 The proposer's form-line grammar

**Step 0 — the existing grammar first.** A line `parseHeaderLine` accepts is read by §2,
unchanged (`Verse 8x` bars, `Chorus x2` plays + inherit, bare label inherit). The procedure
below runs **only on lines it rejects**. *(Codex R2: without this step, `Chorus x2` after
`Chorus 8x` was "not used".)*

A rejected line is a **form line** if it is all-caps (≥ 80% of its letters uppercase, starts
with a capital) and carries at least one **count token**: `NX`, `?X`, `X?`, or a standalone
`X` or `?` word. It splits on `;` into **parts**, in order; each part is one section.

Each part is read by **one ordered procedure**. The first step that decides, decides.
*(Rewritten after Codex R1 and R2. R1: overlapping rules gave `SOLO 8X+ UNTIL KEYBOARD CUE`
two readings. R2: the open-tail row ran before the second-count check, so `VAMP 4X+ SOLO 8X`
became one open Vamp with the note `SOLO 8X`, and the Solo was lost.)*

1. **Split.** COUNT = the first `NX` token if the part has one, else the first `?X` / `X?` /
   `X` / `?` token. LABEL = the text before COUNT with any `?` removed; TAIL = the text after
   COUNT with any `?` removed, trimmed.
   **Not used** if there is no count token, LABEL is empty, or LABEL contains a digit or `+`
   anywhere except one trailing ordinal (`VERSE 1`, `LONG VERSE 4` pass; `CHORUS 9+`,
   `CHORUS 6 TIMES` don't).
2. **Uncertain.** If the part contains `?` anywhere, or COUNT is not an `NX` → **uncertain**,
   never `open`. If COUNT is `NX`, propose N; otherwise propose from a same-label antecedent
   per §2.2, else fail the section. The owner confirms before it persists. Step 3 still runs
   for the note and for "not used", but its open row cannot apply.
3. **Read TAIL**, first match wins:
   | # | TAIL | Result |
   | --- | --- | --- |
   | 1 | empty | `bars` = N |
   | 2 | starts with `+` and the next non-space character is a digit (`+ 4`, `+1X`, `+2`) | **extra count**: `bars` = N, TAIL verbatim → note, **owner confirms the count** (Graham, 2026-10-28: `+4` might be bars or beats, so it is never added) |
   | 3 | exactly one bracketed group that contains `+` (`(+2 BEATS)`, `(12X + 8X)`) | **extra count**, as row 2 |
   | 4 | contains a count token anywhere (`+ SOLO 8X`, `, ALL 4X`, `/ALL 12X`) | **not used**: a second section outside `;` is a structure we can't split safely |
   | 5 | starts with `+` (`+`, `+ UNTIL KEYBOARD CUE`) | **open**: `bars` = N, `open: true`; text after the `+`, if any, → note |
   | 6 | anything else (`(CLAPS)`, `(ACAPELLA)`, `WITH IMPROV`) | `bars` = N, TAIL verbatim → note |
4. **Note too long.** A note longer than `NOTE_MAX` (§2.4.3) is never truncated: the
   section keeps its bars, the note is left off, and the full line goes on "Lines we didn't
   use" so the owner can shorten it.

**Not used** means the whole line goes on the read-back's **"Lines we didn't use"** list
(§6.4); the proposer never emits a partial line. That list holds **every line, in any case,
that contains a count token and produced no section**, plus the all-caps count-less lines
below. A count-bearing line can't drop out without showing up there.

Worked through the procedure:

| Line | Outcome |
| --- | --- |
| `Chorus x2` (after `Chorus 8x`) | step 0, §2: plays 2, inherits 8, owner confirms |
| `GUITAR SOLO 8X` | row 1: 8 bars |
| `CHORUS 8X (CLAPS)` | row 6: 8 bars, note `(CLAPS)` |
| `SOLO 8X+` | row 5: 8 bars, open |
| `SOLO 8X+ UNTIL KEYBOARD CUE` | row 5: 8 bars, open, note `UNTIL KEYBOARD CUE` |
| `VAMP 4X+ SOLO 8X` | row 4: not used |
| `CHORUS 8X + 4` | row 2: 8 bars, note `+ 4`, owner confirms |
| `CHORUS 4X (+2 BEATS)` | row 3: 4 bars, note `(+2 BEATS)`, owner confirms |
| `CHORUS 24X ?` | step 2: uncertain, propose 24 |
| `INTRO VAMP ? 4X` | COUNT `4X`, LABEL `INTRO VAMP`; step 2: uncertain, propose 4 |
| `BREAKDOWN ?` | step 2: uncertain, inherit or fail |
| `VAMP 4X; SOLO 12X` | two parts: 4 bars, then 12 bars |
| `GUITAR 1X, ALL 4X` | row 4: not used |
| `CHORUS 9+X` / `CHORUS 6 TIMES ?` | step 1, LABEL: not used |

Two more rules:

- **Count-less lines are never sections and never notes on their own.** An all-caps line with
  no count that `parseHeaderLine` rejects goes on the "Lines we didn't use" list, where the
  owner can tap it to attach it as a note to the section above. Measured: 67 such lines,
  most of them titles and BPM lines, so attaching them automatically would put noise on the chart.
- **Directions are never interpreted into structure.** `REPEAT SONG` and `REPEAT VERSE 3,
  CHORUS` imply sections, but the proposer doesn't add those sections. It keeps the words for
  the owner. Same principle as "blank bars are never interpreted"
  (`design-roadmap-structure-editing.md` §8).

Lyrics are still discarded (§3). A direction is not a lyric: it is written **to the
players**, not sung, and it is stated per section, so where it goes is known. That is the
exact property §3 says lyrics lack.

#### 2.4.3 The representation: `note` + `open` on `RoadmapSection`

Two optional fields, decided together (Graham, 2026-10-28: "both"):

```ts
export interface RoadmapSection {
  // …existing fields unchanged…
  note?: string;   // performance direction, verbatim, shown on the section's label line
  open?: true;     // length is set on stage: `bars` is the length DRAWN, a minimum, not the length played
}
```

- **`bars` stays required.** For an open section it is the length **drawn**: the stated
  minimum (`8X+` → 8). An authored open section with no stated minimum gets the owner's
  choice (default 4). That leaves `BarRef`, `validateRoadmapSpec`'s form math, navigation
  targets and seek unchanged. (The layout gains one line for a noted section, §2.4.4.) No sentinel `bars`, no null.
- **No version bump, no migration.** Both fields are optional, the same forward-compat
  argument as `timeSigSource` (§2.1) and `Bar.measures` (#172). Every existing spec keeps its
  meaning.
- **`validateRoadmapSpec` additions.** `note`: a string, trimmed, non-empty, at most
  `NOTE_MAX` = **52** characters. That is set by the worst case, not the typical one: the note
  line is `OPEN · ` + note at 9 pt Helvetica, and Helvetica's widest glyph (`W`, 944/1000 em)
  gives (7 + 52) × 0.944 × 9 ≈ 501 pt, inside the 516 pt content width
  (`PAGE_W − 2·MARGIN_X`, `lib/roadmap-layout.ts:23-25`). So no note can clip, whatever the
  label or the letters. Measured longest direction in the corpus: 31 characters. `open`: exactly `true` if present. **`open` with any
  `repeat` (plain or volta) is rejected**: "play N times" and "until the cue" contradict
  each other, and the renderer would have to invent which one wins.
- **What `open` changes downstream, and nothing more:**
  - The **read-back tally** (`tallySpec`) prints `8+ bars` for an open section.
  - **Duration math** treats an open section like `timeSigSource: 'assumed'`: it refuses
    until the owner gives a length (§2.1's rule, same reason: a minimum isn't a duration).
  - **Corroboration** (§9 Q5): a spec with an open section gives a lower bound
    (`Σ bars ≥`). It is reported as such and never compared as equal.
  - **Conductor clock: it holds at the end of an open section.** *(Corrected after Codex
    R1. The first draft said the playhead moves only on manual advance; that's true of the
    §3.5 gate, but the clock driver advances by itself when a bar is owed,
    `lib/use-conductor-session.ts:874`. So `SOLO 8X+` then `CHORUS 8X` would have rolled
    into the chorus after eight bars with no cue.)* The fix uses the plumbing that's already
    there: `buildCalibration` (`lib/roadmap-calibration.ts:25`), which already projects
    repeats and navigation onto `RoadmapMarker`, projects `open` as a **`hold` marker on the
    open section's last drawn bar**. `isValidCalibration` accepts the new kind;
    `resolveRoadmap` ignores it (it changes timing, not order). In the clock driver, when one
    bar is owed and the current bar carries `hold`, it **freezes** instead of advancing,
    using the existing suspend state (`stalled`, `:876-880`). Only the MD's **manual
    advance** leaves the hold: every manual seam that moves the position clears a stall
    through `writeDriver` (`:373-382`), while a clock advance deliberately doesn't. An align
    tap on the hold bar re-zeros onto it, and the clock freezes there again on the next owed
    bar, which is correct: aligning says "we're here", not "go on". **Test:** clock-on playback of
    `SOLO 8X+` → `CHORUS 8X` stays on solo bar 8 indefinitely and enters the chorus only on
    a manual advance. Uploaded (non-builder) charts never carry `hold`.

#### 2.4.4 Where it shows

- **Rendered chart.** A section with a `note` or `open` gets a **note line** under its bold
  label (`lib/roadmap-render.ts:134`), regular face, 9 pt: `OPEN · until keys signal`,
  `until keys signal`, or just `OPEN`. It gets its own line, not space on the label's line,
  because the label's length is unbounded, so the space left beside it can't be known in
  advance. *(Codex R1: a long label plus a 58-character note at 8 pt ran to ~626 pt, past
  the 612 pt page edge.)* With a line of its own, `NOTE_MAX` alone guarantees the fit.
  **Geometry:** `layoutRoadmap` gives that section's first system a label strip of
  `SYSTEM_LABEL_H + NOTE_LINE_H` instead of `SYSTEM_LABEL_H` (`lib/roadmap-layout.ts:30`).
  The PDF and the calibration both read the one layout ("change these and BOTH move
  together", `:19-21`), so they stay in step. A builder save already re-derives both, and
  bar ids don't depend on y. **Test:** a spec with no note or open lays out
  byte-identically to today (every existing chart unchanged); with a note, every PDF label
  and bar position equals its calibration coordinate.
- **Builder**: each section row (`components/RoadmapBuilder.tsx`, the row beside rename)
  gets a one-line **Direction** text field and an **Open** toggle. Nothing else — this is
  the "clean and easy" bar. The toggle is disabled with the reason shown while the section
  has a repeat, matching the validator.
- **Out of scope for the first build:** directions typed into the "describe it" box (the
  AI parse path). The row field covers authoring. Teaching `parseDescription` and the op
  layer a note op is a follow-up once the field has been used.

#### 2.4.5 A trap the build must close (verified in source)

The view model rebuilds sections **field by field** in at least six places, so it would
silently drop both new fields on the next edit: `specToView` (`lib/roadmap-view.ts:342`),
`viewToSpec` (`:359`), the bar-plan rebuild (`:567`), `setPlainRepeat` (`:679`),
`unrollRepeat`'s copies (`:704`), `addEndings` (`:745`).

**Merge.** `roadmap-merge.ts` folds adjacent same-content sections into a `×N` repeat, and
its equality check `sameContent` (`:38`) compares only `bars`, label and `changes`. Built
as-is, a closed `Chorus 8` followed by an open `Chorus 8` would collapse into one closed `×2`
and the cue would be lost (Codex R1, reproduced). Rule: **an open section never merges**
(a merge produces a repeat, and `open` + repeat is invalid), and **two sections merge only
if their notes are equal** (both absent counts as equal). `sameContent` gains both checks.
**Test:** closed+open, open+open, and same-label-different-note pairs each stay separate;
the existing merge cases are unchanged. **Fix it as a property on output, not
site by site:** a test that runs every `ViewModel` op on a section carrying `note` and
`open` and asserts both survive (or, for `open` + a repeat op, that the op is refused).
Patching six call sites by hand would miss the seventh.

---

## 3. Lyrics do not go on the roadmap

**Decision. The lyric text is discarded after the form lines are parsed.** Performance
directions are not lyrics and are kept (§2.4.2); this section is about sung text only.

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

1. **Extract the form lines** from the lyrics PDF's text layer, with the #211 line
   grouping and reading order (`lib/chart-section-headers.ts`: two-column sheets are the
   norm). A form line matches §2 or the wider §2.4.2 grammar; lyric body text does not. Scanned
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
   plausible. `tallyDraft` is **op-blind**: it sums `sec.spans` and ignores ops, and
   this grammar emits repeats as a matter of course (`Chorus x2`). **The tally for this
   path must be derived from the validated spec** — `tallySpec` (`lib/roadmap-authoring.ts`,
   built for `design-roadmap-structure-editing.md` §4) does that, showing repeats as `×N`
   and open sections as `8+ bars`. Under the tally, the read-back lists **"Lines we didn't
   use"**: every count-bearing line, in any case, that produced no section, plus the
   all-caps count-less lines (§2.4.2), each tappable to attach as a note to the section above. A dropped
   line shows up there instead of silently disappearing.

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
| `+` after a count (`8X + 4`, `(+2 BEATS)`) | `bars` = first count, the rest kept as the note; **propose, owner confirms** (§2.4.2 step 3 rows 2–3) |
| `?` / `?X` / bare `X` (author unsure) | Same as an inheriting section (§2.2); never `open` |
| `NX+` (at least N) | `bars` = N, `open: true` (§2.4.2 step 3 row 5) |
| All-caps line that fits no part shape, or has no count | Listed under "Lines we didn't use"; never guessed (§2.4.2) |

---

## 8. Decisions locked

1. Lyrics text is **not** placed on the roadmap; position is not recoverable from text (§3).
   Performance directions **are** kept, verbatim, in their section (§2.4).
2. L0 (form only) is a **complete artifact**, not a degraded chart (§4).
3. L0 → L1 is **typed NNS**, never AI-inferred harmony (§4.1).
4. The output is a `RoadmapSpec`; **no new spec type** (§0.1).
5. The lyrics sheet is a **second proposer** under the existing §2.2.1 provenance rule;
   **no new entity**, no "gold" layer, no cross-tenant canonical record (§5).
6. Owner confirmation remains mandatory; a parse is a proposal (§5).
7. Disagreement between a chart and confirmed structure goes to the **existing review
   queue**; no silent sync (§5).
8. `validateRoadmapSpec` remains the DB boundary for this path (§6).
9. A direction is `RoadmapSection.note` (verbatim); an on-cue length is `open: true` with
   `bars` = the drawn minimum. Optional fields, no version bump; `open` + repeat is
   invalid (§2.4.3).
10. Open (`8X+`) and uncertain (`?`) never share a representation (§2.4.1).
11. The proposer's grammar is wider than the #211 mark recognizer, and the recognizer does
    not change: a missed line costs a mark there and a wrong form here (§2.4.1).
12. Directions are authorable on any roadmap, from the builder row, independent of any
    lyrics sheet (§2.4.4).

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
     ⚠ *True of shipped code; chunk C makes that owner overwrite concrete.*
     `design-chart-review-step.md` §C4 gives the review sheet a re-derivation path —
     it re-runs the engine on one page and re-attributes `measures` from fresh output —
     so post-chunk-C the remainder is reducible by owner action rather than only by
     new bytes. The sweep should still report it, not assume it.
   When it runs it compares `Σ section.bars` (lyrics) against `Σ Bar.measures`
   (calibration) — never `max(absNumber)`. **If the lyrics spec has any `open` section, the
   lyrics sum is a lower bound** (§2.4.3): agreement is `Σ bars ≤ Σ measures`, and only a
   calibration *shorter* than the lyrics minimum is a disagreement. `SOLO 8X+` against a
   12-measure solo agrees. *(Codex R1: equality here contradicted §2.4.3.)*

---

## 10. Build outline (after sign-off — design-first, not building)

Gated commits, Codex per chunk.

**Chunk D — directions on the roadmap (own PR, FIRST; needs no lyrics sheet).** §2.4.3–2.4.5:
`note` + `open` on `RoadmapSection`, `validateRoadmapSpec` rules (`NOTE_MAX` = 52, `open`
is `true`, `open` + repeat rejected), the note line in layout + render, the `hold` marker
projected by `buildCalibration` + the clock-driver freeze, `sameContent`'s two merge rules,
the builder row's Direction field and Open toggle, `tallySpec`'s `8+`. **Tests:** validator
accept/reject per rule; the §2.4.5 property test over every `ViewModel` op; spec → view →
spec round-trip keeps both fields; a spec with no note/open lays out byte-identically to
today, and with one, PDF positions equal calibration coordinates; clock-on `SOLO 8X+` →
`CHORUS 8X` holds until a manual advance; the merge pairs in §2.4.5 stay separate. Browser drive before Codex (canvas work is invisible to jsdom). This is the
"write the audible down" feature, it's useful on every builder chart, and it ships on
its own.

1. **Grammar parser (pure, tested).** Form-line extraction + §2 and §2.4.2 grammar → `RoadmapSpec`
   **directly**, per §6.2 — a form-only adapter emitting `RoadmapSection[]` with
   `changes` omitted. It does **not** route through `AuthoringDraft`, `parseDescription`
   or `foldDraft`; that path rejects chord-free input (`lib/roadmap-authoring.ts:559`).
   **Tests:** each grammar row in §2 and each part shape in §2.4.2; every §7 failure mode;
   the "Lines we didn't use" list is exactly the unparsed all-caps lines; the §2 worked example
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

**Chunk 0 — measure the corpus first.** A read-only pass over `role='lyrics'` rows that
sizes chunks 1–2 and produces the annotation backlog (§9 Q2). *Partly answered 2026-10-28*
(§2.4.1): 332 of 342 live lyric sheets carry #211-recognized headers, so the text layer is
present on at least those. What's left becomes an acceptance arm next to
`scripts/chart-section-headers-acceptance.ts` (same `--dir`/`--show` shape) reporting per
sheet: sections parsed, open, uncertain, needs-confirm, and lines not used. Nothing here
should be built against an assumed coverage number.

**Sequencing note.** Chunks 1–2 are self-contained and depend on nothing unbuilt —
they produce a validated `RoadmapSpec`, which is already a first-class, editable
builder chart (§4.1). **That is a shippable increment on its own**, and it is where
this design's value is cheapest to realise.

Chunks 3–5 depend on `SongStructure` persistence, which **no existing chunk owns**
(§10.4). This design does not propose building it. What it does establish is a second,
geometry-independent reason to build it — the canonical layer currently has a supply
problem, and a corpus that already contains the answer.
