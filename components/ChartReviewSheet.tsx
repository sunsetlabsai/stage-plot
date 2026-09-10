'use client';

import { useState } from 'react';
import type { Candidate, CountOutcome } from '@/lib/chart-review-sheet';
import { candidateNote, refusalMessage, surplusWarning } from '@/lib/chart-review-sheet';

// ── The chart review sheet (docs/design-chart-review-step.md §C3) ────────────
//
// PURE and presentational, like PerformReadinessStrip: props in, one callback out, no
// PDF, no fetch, no calibration mutation. The owner-facing rules it enforces:
//
//   - NO NOTATION VOCABULARY, and no ENGINE vocabulary either. Every question is "pick
//     the picture that looks right" or "count the bars in this line". Nothing here says
//     measure, span, multirest, barline-cluster — or `split`, which is what the code
//     calls the thing and what an earlier draft of this component asked the owner about
//     (Codex L2, #184). "Barline" appears once, in the surplus warning, because there is
//     no plainer word for the thing the owner is looking at. `tests/chart-review-sheet-ui`
//     harvests this component's rendered text and enforces the ban — the earlier version
//     only checked the copy HELPERS, so these literals went unchecked and the UI test
//     locked the wrong wording in.
//   - NEVER MANDATORY. Every screen can be left without answering, and leaving saves the
//     chart exactly as it already was.
//   - ★ NOTHING COMMITS THAT THE OWNER HAS NOT SEEN AT FULL SIZE. Not politeness — the
//     corpus measurement says an undercount is accepted by the geometry every single time
//     (N-1 accepted 464/464) and nothing downstream can catch it, while `confirmed` is
//     never machine-overwritten. The owner's eye is the last check that exists. That rule
//     is why every option carries a PICTURE (Codex H2, #184: options reading only "N bars"
//     make two different 4-bar geometries indistinguishable) and why picking one of
//     several goes through a full-size preview before it writes.

export type SheetStep = 'choose' | 'count' | 'preview' | 'refused';

export interface ChartReviewSheetProps {
  /** 1-based position of this system on its page, for "Line 7". */
  lineNumber: number;
  /** How many systems are flagged in total, or null when the owner opened this itself. */
  queueTotal: number | null;
  queueIndex: number | null;
  /** True when the machine flagged this line; false when the owner opened it. */
  flagged: boolean;
  /** The candidate splits, already deduped. `renderStrip` draws them. */
  candidates: Candidate[];
  /**
   * Draws the system band with an optional split overlaid. Supplied by the page.
   *
   * `variant: 'mini'` is the same picture at option size — every candidate gets one, so
   * two same-count geometries are told apart by the thing that actually differs.
   */
  renderStrip: (
    xs: number[] | null,
    tone?: 'proposed' | 'confirmed',
    variant?: 'full' | 'mini',
  ) => React.ReactNode;
  /** Counts offered on the pad. The page picks the range around what it measured. */
  countChoices: number[];
  /** Resolve a count to a proposed split — pure, injected so the sheet stays testable. */
  onProposeCount: (n: number) => CountOutcome;
  /** Commit a split. `measures` is carried straight through to `confirmSystemSplit`. */
  onConfirm: (xs: number[]) => void;
  /** Leave without changing anything. */
  onDismiss: () => void;
  /** Hand off to the calibrate editor, with this system selected and `n` pre-set. */
  onOpenCalibrate: (n: number | null) => void;
}

export function ChartReviewSheet(props: ChartReviewSheetProps) {
  const {
    lineNumber,
    queueTotal,
    queueIndex,
    flagged,
    candidates,
    renderStrip,
    countChoices,
    onProposeCount,
    onConfirm,
    onDismiss,
    onOpenCalibrate,
  } = props;

  const [rawStep, setStep] = useState<SheetStep>('choose');
  const [picked, setPicked] = useState<number | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<CountOutcome | null>(null);

  // ★ `picked` IS AN INDEX INTO A LIST THIS COMPONENT DOES NOT OWN (Codex R2, #184).
  // The parent rebuilds `candidates` every render — the async measurement lands and adds
  // options, and a calibrate edit underneath this sheet can collapse two options into one
  // — so an index that resolved when it was chosen may not resolve now. Resolving it ONCE,
  // here, is the whole guard: below this line there is no `candidates[picked]`, so there
  // is no second site to forget. An index that no longer resolves is not a pick.
  //
  // `picked === -1` is the separate "none of these" marker and is deliberately not a
  // candidate. The parent ALSO keys this component on gen/hash/systemId, which throws all
  // of this state away when the sheet is handed a different line; that covers the swap,
  // and this covers the list moving under a single line.
  const pickedCandidate = picked !== null && picked >= 0 ? (candidates[picked] ?? null) : null;

  // A preview of a candidate that has vanished is not a screen — fall back to the ask
  // rather than rendering nothing at the owner.
  const step: SheetStep =
    rawStep === 'preview' && count === null && !pickedCandidate ? 'choose' : rawStep;

  const heading = `Line ${lineNumber}`;
  const counter =
    queueTotal !== null && queueIndex !== null
      ? `${queueIndex + 1} of ${queueTotal} to check`
      : 'you opened this';

  function chooseCount(n: number) {
    setCount(n);
    const res = onProposeCount(n);
    setOutcome(res);
    setStep(res.kind === 'ok' ? 'preview' : 'refused');
  }

  // ── the ask ──
  if (step === 'choose') {
    // One candidate is the NORMAL case on a measured chart: measurement replaced the
    // VLM's geometry, so no competing opinion was ever stored to disagree with. Two or
    // more means the chart's own printed numbers disagree with what we measured — the
    // case the picker exists for, and the case where telling the options apart requires
    // seeing them.
    const single = candidates.length === 1;
    // The big strip tracks the selection, so the answer to "which one" is on screen at
    // full size the moment it is picked, not only after a commit.
    const shown = pickedCandidate ? pickedCandidate.xs : single ? candidates[0].xs : null;
    return (
      <Shell heading={heading} counter={counter}>
        <p className={`text-sm mb-3 ${flagged ? 'text-amber-400' : 'text-zinc-400'}`}>
          {flagged ? "This line didn't check out." : 'Nothing flagged this line — you did.'}
        </p>
        <div className="mb-1">{renderStrip(shown)}</div>
        <p className="text-sm font-semibold mt-3 mb-2">
          {single ? 'Does this look right?' : 'Which one looks right?'}
        </p>
        <div className="flex flex-col gap-2 mb-3">
          {candidates.map((c, i) => {
            const note = candidateNote(c);
            return (
              <button
                key={i}
                type="button"
                aria-pressed={picked === i}
                onClick={() => setPicked(i)}
                className={`flex items-center gap-3 w-full text-left rounded-lg px-3 py-2 text-sm border ${
                  picked === i
                    ? 'border-sky-400 bg-sky-950'
                    : 'border-zinc-700 bg-zinc-800 hover:bg-zinc-700'
                }`}
              >
                <Radio on={picked === i} />
                {/* The picture IS the option. The count is the caption on it. */}
                <span className="block flex-1 min-w-0">{renderStrip(c.xs, 'proposed', 'mini')}</span>
                <span className="shrink-0 text-right">
                  <span className="block tabular-nums">
                    {single ? `Yes, ${c.xs.length} bars` : `${c.xs.length} bars`}
                  </span>
                  {note ? <span className="block text-[10px] text-zinc-400">{note}</span> : null}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            aria-pressed={picked === -1}
            onClick={() => {
              setPicked(-1);
              setStep('count');
            }}
            className="flex items-center gap-3 w-full text-left rounded-lg px-3 py-2 text-sm border border-zinc-700 bg-zinc-800 hover:bg-zinc-700"
          >
            <Radio on={false} />
            <span className="flex-1">{single ? 'No — let me count' : 'None of these'}</span>
          </button>
        </div>
        <Actions>
          <Btn onClick={onDismiss} kind="ghost">
            {flagged ? 'Later' : 'Cancel'}
          </Btn>
          <Btn
            kind="primary"
            disabled={!pickedCandidate}
            onClick={() => {
              if (!pickedCandidate) return;
              // ★ One candidate ⇒ the big strip above IS that candidate, already at full
              // size, so "Use this" commits exactly what is on screen. SEVERAL candidates
              // ⇒ go through the preview anyway. The whole finding was that the owner
              // could commit a picture they had only seen as a label; a mini beside a
              // radio narrows that gap but does not close it at option size.
              if (single) return onConfirm(pickedCandidate.xs);
              // Drop any count answered earlier in this sheet, so the preview below
              // routes on `picked` and cannot read a stale `outcome` from a count the
              // owner has since backed out of.
              setCount(null);
              setOutcome(null);
              setStep('preview');
            }}
          >
            Use this
          </Btn>
        </Actions>
      </Shell>
    );
  }

  // ── the count ──
  if (step === 'count') {
    return (
      <Shell heading={heading} counter="counting">
        <p className="text-sm text-zinc-400 mb-3">Count the bars you can see in this line.</p>
        <div className="mb-1">{renderStrip(null)}</div>
        <p className="text-xs text-zinc-500 mt-1 mb-3">A repeated section counts once.</p>
        <p className="text-sm font-semibold mb-2">How many bars?</p>
        <div className="grid grid-cols-5 gap-2 mb-3">
          {countChoices.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={count === n}
              onClick={() => chooseCount(n)}
              className={`rounded-lg py-3 text-base tabular-nums border ${
                count === n
                  ? 'border-sky-400 bg-sky-400 text-sky-950 font-bold'
                  : 'border-zinc-700 bg-zinc-800 hover:bg-zinc-700'
              }`}
            >
              {n}
            </button>
          ))}
        </div>
        <Actions>
          <Btn onClick={() => setStep('choose')} kind="ghost">
            Back
          </Btn>
        </Actions>
      </Shell>
    );
  }

  // ── show a PICKED candidate back at full size, before anything is written ──
  if (step === 'preview' && count === null && pickedCandidate) {
    const c = pickedCandidate;
    return (
      <Shell heading={heading} counter="check this">
        <p className="text-sm text-zinc-400 mb-3">Here&apos;s what you picked.</p>
        <div className="mb-1">{renderStrip(c.xs, 'proposed')}</div>
        <p className="mt-3 mb-3 text-xs text-zinc-500">
          Nothing re-checks this afterwards — your answer is kept exactly as given.
        </p>
        <Actions>
          <Btn onClick={() => setStep('choose')} kind="ghost">
            Back
          </Btn>
          <Btn kind="confirm" onClick={() => onConfirm(c.xs)}>
            Keep {c.xs.length} bars
          </Btn>
        </Actions>
      </Shell>
    );
  }

  // ── show it back, ALWAYS, before anything is written ──
  if (step === 'preview' && outcome?.kind === 'ok' && count !== null) {
    const warn = surplusWarning(outcome.surplus, count);
    return (
      <Shell heading={heading} counter="check this">
        <p className="text-sm text-zinc-400 mb-3">Here&apos;s what {count} bars gives you.</p>
        <div className="mb-1">{renderStrip(outcome.xs, 'proposed')}</div>
        {warn ? (
          <p className="mt-3 mb-3 rounded-lg border border-amber-900 bg-amber-950 px-3 py-2 text-xs text-amber-300">
            {warn}
          </p>
        ) : (
          <p className="mt-3 mb-3 text-xs text-zinc-500">
            Nothing re-checks this afterwards — your answer is kept exactly as given.
          </p>
        )}
        <Actions>
          <Btn onClick={() => setStep('count')} kind="ghost">
            Change count
          </Btn>
          <Btn kind="confirm" onClick={() => onConfirm(outcome.xs)}>
            Keep {count}
          </Btn>
        </Actions>
      </Shell>
    );
  }

  // ── refusal: hand off rather than invent ──
  if (step === 'refused' && outcome?.kind === 'refused') {
    return (
      <Shell heading={heading} counter="can't place it">
        <div className="mb-1">{renderStrip(null)}</div>
        <p className="mt-3 mb-3 rounded-lg border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-300">
          {refusalMessage(outcome.reason, outcome.available)}
        </p>
        <Actions>
          <Btn onClick={onDismiss} kind="ghost">
            Skip this line
          </Btn>
          <Btn kind="primary" onClick={() => onOpenCalibrate(count)}>
            Set them by hand
          </Btn>
        </Actions>
      </Shell>
    );
  }

  return null;
}

// ── chrome ───────────────────────────────────────────────────────────────────

function Shell(props: { heading: string; counter: string; children: React.ReactNode }) {
  return (
    <section className="bg-zinc-900 text-zinc-200 p-4" aria-label="Review this line">
      <div className="flex items-baseline justify-between gap-3 mb-1">
        <span className="text-sm font-semibold">{props.heading}</span>
        <span className="text-xs text-zinc-500 tabular-nums">{props.counter}</span>
      </div>
      {props.children}
    </section>
  );
}

/** The chosen-ness of an option, as an affordance rather than a colour change alone. */
function Radio(props: { on: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`shrink-0 w-[15px] h-[15px] rounded-full border-[1.5px] grid place-items-center ${
        props.on ? 'border-sky-400' : 'border-zinc-500'
      }`}
    >
      {props.on ? <span className="w-[7px] h-[7px] rounded-full bg-sky-400" /> : null}
    </span>
  );
}

function Actions(props: { children: React.ReactNode }) {
  return <div className="flex gap-2">{props.children}</div>;
}

function Btn(props: {
  children: React.ReactNode;
  onClick: () => void;
  kind?: 'primary' | 'ghost' | 'confirm';
  disabled?: boolean;
}) {
  const base = 'flex-1 rounded-lg px-3 py-2.5 text-sm font-semibold border disabled:opacity-40';
  const tone =
    props.kind === 'primary'
      ? 'bg-amber-500 border-amber-500 text-amber-950'
      : props.kind === 'confirm'
        ? 'bg-emerald-500 border-emerald-500 text-emerald-950'
        : 'bg-transparent border-zinc-700 text-zinc-400 hover:bg-zinc-800';
  return (
    <button type="button" onClick={props.onClick} disabled={props.disabled} className={`${base} ${tone}`}>
      {props.children}
    </button>
  );
}
