# UAT — Realtime Chart Control, Step 1 (sections-only marker rail)

Manual test pass for the step-1 vertical slice: owner calibration UI + sidecar
save/load + Perform-mode overlay. Covers the section-rail only — no auto-advance,
bar geometry, leader/follower, or audio (those are later steps).

**Branch:** `opus/build-realtime-chart-control` · **Migration 008 applied:** yes.

## Setup
- **Owner (Liz):** authenticated, owns a show with a song that resolves to a
  **library-chart PDF** (a Supabase storage URL, not a Drive chart).
- **Performer (Dave):** non-owner, opens the same show via its public share link.
- A multi-page chart is ideal (exercises per-page filtering + page turns).

---

## A. Owner calibration flow (Liz)

- [ ] Open the chart in the Navigator (Perform or Mix tab). PDF renders.
- [ ] A **Calibrate** button shows in the header (owner + library chart only).
- [ ] Tap **Calibrate** → mode switches to calibrate; the calibrate toolbar
      appears at the bottom ("Tap the page to drop a section…").
- [ ] Tap a spot on the page → a pill drops **exactly there**, with an
      auto-focused inline label input. The pill is amber while unlabeled.
- [ ] Type a label, press Enter → pill turns blue (labeled), input closes.
- [ ] Drop two more labeled sections → three blue pills.
- [ ] With every pill labeled, **Verify & save** is enabled.
- [ ] Blank one label (or drop an unlabeled pill) → **Verify & save** disables;
      the toolbar shows the "every section needs a label" hint.
- [ ] Tap an existing pill → re-opens its label editor with an **×** delete.
- [ ] Tap **×** → the pill is removed.
- [ ] Turn to page 2 (tap right half) and drop a section → it records on page 2;
      page-1 pills are not shown while viewing page 2.
- [ ] Tap **Save draft** → footer shows "Saved"; status persists as `draft`.
- [ ] Re-open the chart → the draft sections reload (owner sees own drafts).
- [ ] Tap **Verify & save** → footer "Saved"; status is now `verified`.
- [ ] Tap **Done** → back to Perform; the verified markers now render in Perform.

**Invariants to confirm**
- [ ] Any drop / edit / delete returns status to **draft** (must re-verify).
- [ ] **Verify & save** is gated on every section having a non-blank label.

---

## B. Performer flow (Dave, non-owner)

- [ ] Open the song from the share link. PDF renders.
- [ ] **No Calibrate button** anywhere.
- [ ] Liz's **verified** calibration loads → section pills render as a clean
      Perform overlay (modest, dim pills).
- [ ] No redline until something is seeked.
- [ ] Tap a pill → a **redline** parks at that anchor's vertical position;
      footer shows "At · <label>" with a **clear** link.
- [ ] Long-press a pill (~450ms) → redline moves there, pill highlights as
      **held** (red ring); footer shows "Holding · <label>".
- [ ] Tap **clear** → redline and status clear.
- [ ] Tap **empty page area** (not on a pill) → page turns / song swipes as
      normal (overlay falls through between markers).
- [ ] Tap **on a pill** → never turns the page / changes song.
- [ ] Resize the window / rotate device → pills and redline stay glued to the
      printed page (re-measured via ResizeObserver).

---

## C. Source-scope boundary

- [ ] A **Drive-resolved** chart (no library id) shows **no Calibrate button**
      and never hits the calibration endpoint.
- [ ] A library chart for a **non-owner** shows no Calibrate button but still
      receives a verified calibration to drive the redline.

---

## D. Fail-closed cases (the important ones)

- [ ] **Draft only (not verified):** a performer gets a **404** from GET and sees
      **no overlay** — draft existence never leaks.
- [ ] **PDF re-uploaded (bytes changed):** new hash → no matching row → **no
      redline**. It does not best-effort apply to a chart it wasn't calibrated for.
- [ ] **Hash failure** (any reason) → **no redline** (caught + cleared).
- [ ] **Tampered DB row** — `verified` status but a blank label or out-of-range
      coords → GET re-validates (`isValidCalibration` + `isPerformable`) and
      returns nothing; the bad row cannot drive the redline.
- [ ] **PUT guard:** a client that POSTs a `verified` payload breaking the
      invariant is rejected (400) — the server never persists a dishonest verified.

---

## Out of scope for step 1 (do NOT expect)
- Auto-advance / tempo-driven page turns (seek-only by design).
- Bar-level geometry, per-bar ticks, nav graph / repeats.
- Leader → follower broadcast (level B).
- Audio auto-sensing (level C).
- Converter / structural auto-import.

## Notes / observed issues
_(log anything here during the pass)_
