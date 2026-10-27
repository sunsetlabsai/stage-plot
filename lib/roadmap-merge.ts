import { resolveRoadmap } from './chart-calibration';
import { layoutRoadmap } from './roadmap-layout';
import { buildCalibration } from './roadmap-calibration';
import type { BarRef, RoadmapNavigation, RoadmapSection, RoadmapSpec } from './roadmap-spec';

// ── Roadmap Builder — merge repeated sections on parse ───────────────────────
// docs/design-roadmap-structure-editing.md §4. "2x chorus" reaches the fold as two
// Chorus sections written out longhand (the L2 prompt transcribes, never
// compresses). This is the deterministic compression step: a run of 2+ ADJACENT
// sections that are the same section written twice merges into the first, under a
// plain |: :|×N repeat. Ruling §8.1: merge always, whatever the phrasing — every
// target display is a phone. A run that fails ANY test stays longhand; the step
// never guesses. Runs between foldDraft and validateRoadmapSpec, so the L1 grammar
// path and the L2 model path both get it. Pure — no IO.

// "Verse 1" = "Verse 2" = "verse" (ruling §8.2). A label that is ONLY a number
// keeps itself, so "1" and "2" never collapse to the same empty base.
function baseLabel(label: string): string {
  const stripped = label.replace(/\s*\d+\s*$/, '').trim();
  return stripped || label.trim();
}

// Key-sorted stringify: equality of folded spec content must not depend on the
// order a producer happened to write object keys in.
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// Exact equality of the folded section content — no fuzzy match. The fold emits
// changes by a per-section inheritance-diff, so the same section written twice
// produces identical `changes` arrays.
function sameContent(a: RoadmapSection, b: RoadmapSection): boolean {
  return (
    a.bars === b.bars &&
    baseLabel(a.label).toLowerCase() === baseLabel(b.label).toLowerCase() &&
    stableStringify(a.changes ?? []) === stableStringify(b.changes ?? [])
  );
}

function navRefs(nav: RoadmapNavigation | undefined): BarRef[] {
  if (!nav) return [];
  return [nav.segno, nav.coda, nav.toCoda, nav.fine, nav.jump?.at].filter((r): r is BarRef => !!r);
}

// The written-content sequence a spec PLAYS: walk the VM to completion (under
// resolveRoadmap's own termination cap) and read each played bar's written content
// as-is — its own chords, or blank. Blank bars are never resolved to a chord
// (ruling §8.5). null = the walk failed or capped, which never counts as equivalent.
function playedContent(spec: RoadmapSpec): string[] | null {
  try {
    const layout = layoutRoadmap(spec);
    const resolved = resolveRoadmap(buildCalibration(spec, layout));
    if (!resolved.ok) return null;
    const byId = new Map(layout.bars.map((b) => [b.id, b] as const));
    const out: string[] = [];
    for (const step of resolved.traversal) {
      const bar = byId.get(step.barId);
      if (!bar) return null;
      const change = bar.section.changes?.find((c) => c.bar === bar.barInSection);
      out.push(change ? stableStringify(change.chords) : 'blank');
    }
    return out;
  } catch {
    return null; // a malformed pre-validate spec: leave it to validateRoadmapSpec
  }
}

function samePlayback(a: string[] | null, b: string[] | null): boolean {
  return a !== null && b !== null && a.length === b.length && a.every((x, i) => x === b[i]);
}

// The §4 playback-equivalence check as one call: do two specs play the same
// written content, step for step? Reused by the editor's Unroll (§5.1), so the
// merge and its escape hatch agree by construction.
export function playsTheSame(a: RoadmapSpec, b: RoadmapSpec): boolean {
  return samePlayback(playedContent(a), playedContent(b));
}

// Merge sections [i..j] into i (×(j−i+1)); refs past j shift down by j−i. The
// caller has already proved no ref points into (i, j].
function mergeRun(spec: RoadmapSpec, i: number, j: number): RoadmapSpec {
  const first = spec.sections[i];
  const merged: RoadmapSection = {
    ...first,
    label: baseLabel(first.label),
    repeat: { kind: 'plain', times: j - i + 1 },
  };
  const sections = [...spec.sections.slice(0, i), merged, ...spec.sections.slice(j + 1)];
  const shift = (r: BarRef): BarRef => (r.section > j ? { ...r, section: r.section - (j - i) } : r);

  const next: RoadmapSpec = { ...spec, sections };
  const nav = spec.navigation;
  if (nav) {
    const out: RoadmapNavigation = {};
    if (nav.segno) out.segno = shift(nav.segno);
    if (nav.coda) out.coda = shift(nav.coda);
    if (nav.toCoda) out.toCoda = shift(nav.toCoda);
    if (nav.fine) out.fine = shift(nav.fine);
    if (nav.jump) out.jump = { ...nav.jump, at: shift(nav.jump.at) };
    next.navigation = out;
  }
  return next;
}

// §4: fold adjacent identical sections into a plain repeat. Runs sequentially on
// the evolving spec; each merge is checked for playback equivalence against the
// spec it replaces, so the final spec plays exactly as the longhand one did.
export function mergeRepeatedSections(spec: RoadmapSpec): RoadmapSpec {
  let current = spec;
  let i = 0;
  while (i < current.sections.length) {
    const first = current.sections[i];
    // A run only starts on a section that could carry a plain repeat.
    if (first.repeat || first.bars < 2) {
      i += 1;
      continue;
    }

    // Extend while the next section is the same section written again. A section
    // a nav ref points into ends the run (it may start the next one): the merge
    // would delete the bar that ref lands on.
    const refSections = new Set(navRefs(current.navigation).map((r) => r.section));
    let j = i;
    while (
      j + 1 < current.sections.length &&
      !current.sections[j + 1].repeat &&
      !refSections.has(j + 1) &&
      sameContent(first, current.sections[j + 1])
    ) {
      j += 1;
    }

    if (j > i) {
      const candidate = mergeRun(current, i, j);
      // A jump that replays a repeat plays it once (the VM keeps pass counts across
      // a D.C./D.S.), so two Verses before a D.C. play 4× longhand but 3× merged.
      if (samePlayback(playedContent(current), playedContent(candidate))) {
        current = candidate;
        i += 1;
        continue;
      }
    }
    // Unmerged: a run that failed stays longhand WHOLE — no retry on a sub-run (§4).
    i = j + 1;
  }
  return current;
}
