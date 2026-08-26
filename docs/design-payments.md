# ShowRunr Payments + Subscription — Design Spec v1.2

> v1.2 changelog: Addressed 2 Codex round-2 findings — calendar-month show cap (not billing-period), webhook state reconciliation.
> v1.1 changelog: Addressed 4 Codex findings — billing PII isolation, quota counter split, collaborator enforcement scope, webhook idempotency.

## Goals

Monetize ShowRunr with a simple, low-friction subscription model. Cover infrastructure costs (Supabase, Vercel, storage), avoid LLM cost exposure, and provide value at a price point that encourages adoption over churn.

---

## Subscription Model

### Tiers

| | Free Trial | Pro (Monthly) | Pro (Annual) |
|---|---|---|---|
| **Price** | $0 | $2/mo | $14/yr (~42% off) |
| **Duration** | 30 days or 5 shows created, whichever first | Ongoing | Ongoing |
| **Songs + Charts** | 50 | 150 | 150 |
| **Shows** | 5 total | 30/mo | 30/mo |
| **AI Co-designer** | BYOA only | BYOA only | BYOA only |

### Key Definitions

- **Show created**: a new show record inserted. Renaming or changing the date does not count as a new show.
- **Song/chart limit**: account-wide (not per-show), since charts are per-song and songs are reused across shows.
- **30 shows/mo**: safety valve against abuse. 1/day is generous for any realistic band or venue use case.

### Trial Behavior

- Trial starts on account creation (profile claim).
- Trial ends at 30 days OR 5 shows created, whichever comes first.
- At trial end: **read-only access**. Existing shows remain viewable, exportable, and shareable. No new shows, no edits.
- No credit card required to start trial.

### Post-Trial Data Retention

- After trial expires without subscribing, data is retained for **180 days**.
- This retention window is disclosed in the trial start messaging and terms.
- After 180 days, shows and songs are deleted. Charts (stored files) are purged.
- If the user subscribes at any point within the 180-day window, full access is restored.

---

## Team / Collaboration Model

- **One owner per show**. The owner holds the subscription.
- **Collaborators are free**. Anyone with a show link can view. **Collaborators are VIEW ONLY** — they do not edit. *(Amended 2026-08-25: read "Authenticated collaborators can edit (subject to show freeze rules)". The `editor` role is deleted — see `design-single-backend.md` §3.3c. **This SIMPLIFIES the billing model**: only the owner writes, so there is no acting-user-vs-owner divergence to reconcile. Show-freeze rules still apply, but to the owner alone.)*
- No seat-based pricing. No team/org entity.
- Cross-team collaboration: share show files (YAML export/import). Keep it simple.

---

## Agent Upsell (Future — Not Launch Scope)

Designed into the schema but not built for launch. Ship Pro, validate demand, then layer this on.

| | Pro + AI |
|---|---|
| **Price** | TBD (~$5/mo estimate) |
| **Hosted agent** | Yes (platform-provided Claude API key) |
| **Usage** | N tool calls/mo (TBD based on cost analysis) |
| **Overage** | Hard cap (no surprise bills) |

Key considerations for future design:
- Stripe usage-based billing (metered product) — different from flat subscription
- Need tool-call cost tracking per user
- Hard cap vs. overage pricing — lean toward hard cap for simplicity
- BYOA remains available at all tiers (user's own key, zero platform cost)

---

## Owner / Grandfathering

- Platform owner account (Graham) flagged as `plan: 'owner'` — exempt from billing.
- No Stripe customer record created for owner accounts.
- Owner plan has no limits (songs, shows, etc.).

---

## Stripe Integration

### Approach: Stripe Checkout (Hosted)

- **Stripe Checkout**: redirect to Stripe-hosted payment page for subscription signup.
- **Stripe Customer Portal**: redirect to Stripe-hosted portal for manage/cancel/update payment method.
- No payment forms in ShowRunr UI. Stripe handles PCI compliance, tax, receipts, card updates.

### Stripe Products

1. **ShowRunr Pro Monthly** — $2/mo recurring
2. **ShowRunr Pro Annual** — $14/yr recurring

### Flow

```
[ShowRunr UI]                    [Stripe]
    |                                |
    |-- "Subscribe" CTA ----------->|
    |   (Checkout Session)          |
    |                               |-- Payment page
    |                               |-- Success → redirect to /dashboard?upgraded=1
    |                               |-- Cancel → redirect to /dashboard
    |                                |
    |-- "Manage Subscription" ----->|
    |   (Customer Portal)           |
    |                               |-- Update card, cancel, view invoices
    |                               |-- Return → /dashboard
    |                                |
    |<-- Webhook: subscription ------|
    |    created/updated/deleted     |
    |    → update billing_accounts  |
```

### Webhook Events to Handle

| Event | Action |
|---|---|
| `checkout.session.completed` | Create `billing_accounts` row, set `profiles.plan = 'pro'` |
| `invoice.paid` | Confirm ongoing provisioning — set/keep `profiles.plan = 'pro'` |
| `customer.subscription.updated` | Update plan if changed (e.g., monthly ↔ annual) |
| `customer.subscription.deleted` | Set `profiles.plan = 'expired'`, start 180-day retention clock |
| `invoice.payment_failed` | Set `profiles.plan = 'past_due'`, show banner in UI |

### Webhook Idempotency and Ordering

- Store every processed event in a `billing_events` log table: `(id PK, stripe_event_id UNIQUE, event_type, processed_at)`.
- On webhook receipt, check `stripe_event_id` uniqueness before processing. Skip duplicates.
- Stripe retries failed webhook deliveries and may send duplicates — this prevents plan flapping and duplicate mutations.
- All webhook handlers must be idempotent beyond the event log (i.e., setting `plan = 'pro'` when already `'pro'` is a no-op).

**Out-of-order delivery:** Stripe does not guarantee webhook delivery order. A stale `invoice.payment_failed` could arrive after a newer `invoice.paid`. To handle this:
- On any plan-mutating webhook, **fetch current subscription state from Stripe** (`stripe.subscriptions.retrieve(subscription_id)`) rather than trusting the event payload alone.
- The webhook event is the trigger; the Stripe API response is the source of truth for plan state.
- This prevents a late-arriving failure event from overwriting a successful payment.

### Database Schema Changes

```sql
-- Migration 006: payments

-- profiles: public-readable fields only (plan status is not PII)
ALTER TABLE profiles ADD COLUMN plan TEXT NOT NULL DEFAULT 'trial';
-- plan values: 'owner', 'trial', 'pro', 'expired', 'past_due'

ALTER TABLE profiles ADD COLUMN trial_started_at TIMESTAMPTZ DEFAULT now();
ALTER TABLE profiles ADD COLUMN plan_expires_at TIMESTAMPTZ;
-- plan_expires_at: set to trial_started_at + 30 days for trial,
-- or subscription end date for cancelled pro.

ALTER TABLE profiles ADD COLUMN shows_created_lifetime INTEGER NOT NULL DEFAULT 0;
-- Lifetime total shows created. Used for trial 5-show gate. Never resets.

ALTER TABLE profiles ADD COLUMN shows_created_this_period INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN period_start TIMESTAMPTZ;
-- Rolling period counter for pro 30/mo limit. Uses CALENDAR MONTH window
-- (not Stripe billing period). Dynamic check: if period_start is in a
-- previous calendar month, reset counter to 0 and set period_start to
-- 1st of current month before incrementing.

ALTER TABLE profiles ADD COLUMN songs_count INTEGER NOT NULL DEFAULT 0;
-- Incremented/decremented on song library changes. Used for 50/150 limit.

-- billing_accounts: private table, NO public RLS
-- Contains Stripe PII — accessible only via service-role key (server-side).
CREATE TABLE billing_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  stripe_customer_id TEXT NOT NULL,
  stripe_subscription_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(profile_id)
);

-- billing_events: webhook idempotency log
CREATE TABLE billing_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ DEFAULT now()
);

-- RLS: billing tables are server-only (no public access)
ALTER TABLE billing_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
-- No policies = no client access. Server uses service-role key.
```

> **Design note (Codex finding #1):** `stripe_customer_id` is intentionally kept off `profiles` because `profiles` has `SELECT USING (true)` RLS. All Stripe identifiers live in `billing_accounts`, accessible only server-side via service-role key.

### Enforcement Points

All write gates resolve against the **show owner's** billing state.

**⛔ Amended 2026-08-25 — the scenario this rule was written for CANNOT OCCUR.** This read: *"not the acting user's. A collaborator editing someone else's show is gated by the owner's plan. This prevents a free collaborator from being incorrectly blocked on a paid owner's show, and prevents a paid collaborator from bypassing limits on an expired owner's show."* **Collaborators are VIEW ONLY** (`design-single-backend.md` §3.3c), so the acting user on any write **is** the show owner and the two can no longer diverge.

**Keep the rule as written anyway** — "resolve against the show owner" is now trivially true rather than wrong, and it is the correct invariant if delegated writes ever return (see the conductor-delegate backlog note in §3.3c). What is deleted is the *justification*, which described a principal that no longer exists.

| Gate | Check (against show owner) | Behavior |
|---|---|---|
| Create show | `plan` is active + `shows_created_lifetime` < 5 (trial) or `shows_created_this_period` < 30 (pro) | Block with upgrade CTA |
| Edit show | `plan` is active (not expired/trial-ended) | Read-only mode with upgrade CTA |
| Add song | `songs_count` < tier limit (50 trial / 150 pro) | Block with upgrade CTA |
| Upload chart | `songs_count` < tier limit | Block with upgrade CTA |
| AI co-designer | Always BYOA (no gate needed at launch) | N/A |

### Monthly Show Counter Reset

- `shows_created_this_period` resets dynamically — no cron needed.
- Uses **calendar month** window, not Stripe billing period. This is critical for annual subscribers — Stripe's billing period is yearly, but the show cap is monthly.
- On show creation: if `period_start` is in a previous calendar month, reset counter to 0 and set `period_start` to the 1st of the current month, then increment.
- `shows_created_lifetime` never resets (used for trial gate only).
- Same logic applies to both monthly and annual Pro subscribers — the show cap is always 30/calendar month regardless of billing cadence.

---

## UI Changes

### Pricing / Subscribe

- `/pricing` page — simple tier comparison table (trial vs. pro).
- "Subscribe" CTA → Stripe Checkout redirect.
- Show current plan + status in account/profile section.

### Upgrade CTAs

- When a gated action is blocked, show inline message: "Upgrade to Pro to [create more shows / add more songs / keep editing]" with a button linking to Stripe Checkout.
- Dashboard banner when trial is ending soon (< 7 days or 4/5 shows used).

### Manage Subscription

- "Manage Subscription" link in profile/account area → Stripe Customer Portal redirect.
- Only visible for `plan = 'pro'` or `plan = 'past_due'`.

---

## Environment Variables

```
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PRO_MONTHLY_PRICE_ID=price_...
STRIPE_PRO_ANNUAL_PRICE_ID=price_...
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_...
```

---

## Test Marketing

- Price points ($2/mo, $14/yr) are initial — plan to A/B test or adjust based on early feedback.
- The steep annual discount (42% off) is intentional to drive annual adoption and reduce churn management overhead.

---

## Out of Scope (Launch)

- Agent upsell tier (metered billing) — future
- Apple/Google IAP — staying PWA-only, Stripe-only
- Team/org billing — no seat pricing
- Usage analytics dashboard — track internally, surface later
- Promo codes / coupons — add via Stripe dashboard if needed, no custom UI

---

## Resolved Questions

1. **Monthly show reset mechanism** — dynamic check (no cron). Compare `period_start` on each show creation.
2. **Past-due grace period** — follow Stripe's default retry schedule (~4 weeks). No custom nagging.
3. **Show freeze interaction** — yes, duplicating a frozen show counts as a new show toward monthly/lifetime limits.

## Codex Review (v1.1) — 4 findings

1. **CRITICAL**: Billing PII (`stripe_customer_id`) moved from `profiles` (public-read RLS) to private `billing_accounts` table (server-only access).
2. **HIGH**: Single `shows_created_count` split into `shows_created_lifetime` (trial) + `shows_created_this_period` / `period_start` (pro monthly).
3. **HIGH**: Enforcement gates now explicitly resolve against show owner's plan, not acting user's plan.
4. **HIGH**: Added `invoice.paid` webhook event + `billing_events` idempotency log table.

## Codex Review (v1.2) — 2 findings

5. **HIGH**: Show cap uses calendar-month window, not Stripe billing period. Prevents annual subscribers from getting 30/year instead of 30/month.
6. **MEDIUM**: Webhook handlers now fetch current Stripe subscription state on plan-mutating events, not just trust event payload. Prevents out-of-order delivery from overwriting newer state.
