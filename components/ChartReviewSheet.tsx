'use client';

import { useState } from 'react';
import type { Candidate, CountOutcome } from '@/lib/chart-review-sheet';
import { refusalMessage, surplusWarning } from '@/lib/chart-review-sheet';

// ── The chart review sheet (docs/design-chart-review-step.md §C3) ────────────
//
// PURE and presentational, like PerformReadinessStrip: props in, one callback out, no
// PDF, no fetch, no calibration mutation. The owner-facing rules it enforces:
//
//   - NO NOTATION VOCABULARY. Every question is "pick the picture that looks right" or
//     "count the bars in this line". Nothing here says measure, span, multirest or
//     barline-cluster. "Barline" appears once, in the surplus warning, because there is
//     no plainer word for the thing the owner is looking at.
//   - NEVER MANDATORY. Every screen can be left without answering, and leaving saves the
//     chart exactly as it already was.
//   - ★ THE COUNT IS ALWAYS SHOWN BACK BEFORE IT COMMITS. Not politeness — the corpus
//     measurement says an undercount is accepted by the geometry every single time
//     (N-1 accepted 464/464) and nothing downstream can catch it, while `confirmed` is
//     never machine-overwritten. The owner's eye is the last check that exists.

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
  /** Draws the system band with an optional split overlaid. Supplied by the page. */
  renderStrip: (xs: number[] | null, tone?: 'proposed' | 'confirmed') => React.ReactNode;
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

  const [step, setStep] = useState<SheetStep>('choose');
  const [picked, setPicked] = useState<number | null>(null);
  const [count, setCount] = useState<number | null>(null);
  const [outcome, setOutcome] = useState<CountOutcome | null>(null);

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
    // VLM's geometry, so no competing opinion was ever stored to disagree with.
    const single = candidates.length === 1;
    return (
      <Shell heading={heading} counter={counter}>
        <p className={`text-sm mb-3 ${flagged ? 'text-amber-400' : 'text-zinc-400'}`}>
          {flagged ? "This line didn't check out." : 'Nothing flagged this line — you did.'}
        </p>
        <div className="mb-1">{renderStrip(single ? candidates[0].xs : null)}</div>
        <p className="text-sm font-semibold mt-3 mb-2">
          {single ? 'Does this look right?' : 'Which split looks right?'}
        </p>
        <div className="flex flex-col gap-2 mb-3">
          {candidates.map((c, i) => (
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
              <span className="flex-1">
                {single ? `Yes, ${c.xs.length} bars` : `${c.xs.length} bars`}
              </span>
            </button>
          ))}
          <button
            type="button"
            aria-pressed={picked === -1}
            onClick={() => {
              setPicked(-1);
              setStep('count');
            }}
            className="flex items-center gap-3 w-full text-left rounded-lg px-3 py-2 text-sm border border-zinc-700 bg-zinc-800 hover:bg-zinc-700"
          >
            {single ? 'No — let me count' : 'None of these'}
          </button>
        </div>
        <Actions>
          <Btn onClick={onDismiss} kind="ghost">
            {flagged ? 'Later' : 'Cancel'}
          </Btn>
          <Btn
            kind="primary"
            disabled={picked === null || picked < 0}
            onClick={() => {
              if (picked !== null && picked >= 0) onConfirm(candidates[picked].xs);
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
