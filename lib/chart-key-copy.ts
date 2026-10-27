// What the chart surfaces say when AI is not available to this user
// (design-ai-key-availability §13.5). In one place because the routes write it and
// the clients link it: every message names Settings, and the client renders the
// Settings link beside it. Settings exists now (`/dashboard/settings`), so this is
// §13.5's target copy, not the interim "add it on a show's AI tab".
//
// `unconfigured` and `exhausted` read differently to the user but share one reason
// code (`no_key`): to them both mean "AI is off for you until you add a key"
// (§13.6 Q6 — the operator distinction stays in the route's branching and logs).

export const SETTINGS_HREF = '/dashboard/settings';

/** The `reason` a chart route attaches when the user can fix it in Settings. */
export type ChartKeyReason = 'no_key' | 'key_rejected';

export function isChartKeyReason(v: unknown): v is ChartKeyReason {
  return v === 'no_key' || v === 'key_rejected';
}

export const CHART_KEY_COPY = {
  parse: {
    unconfigured:
      "AI chart generation isn't available. Add your Anthropic API key in Settings to generate charts from a description.",
    exhausted: "You've used the free AI allowance. Add your Anthropic API key in Settings to keep generating charts.",
    rejected: 'Anthropic rejected your API key. Check it in Settings.',
  },
  convert: {
    no_key: 'AI overlays need an Anthropic API key. Add yours in Settings, or Calibrate by hand.',
    key_rejected: 'Anthropic rejected your API key. Check it in Settings, or Calibrate by hand.',
  },
} as const;
