# PWA & Commercial Strategy
**Status:** Planning — not yet implemented
**Last updated:** 2026-05-20

---

## Distribution Model

**PWA over App Store.** Delivered as a Progressive Web App via the web — users install to home screen from the browser. No App Store review process, no Apple 30% cut, faster iteration.

- iOS: user taps Share → "Add to Home Screen" → app icon on home screen, launches full-screen
- Android: browser prompts install automatically
- Desktop: installable from Chrome/Edge

Apple only requires Sign in with Apple (not applicable — no social login) and in-app purchase routing (not applicable — billing via Stripe direct on the web). PWA sidesteps both.

---

## Revenue Model

**Annual billing preferred over monthly.**

| Option | Price | Stripe fees | Net |
|---|---|---|---|
| Monthly | $1.99/mo | ~18% | ~$1.63/mo |
| Annual | $14.99/yr | ~3-5% | ~$14.25/yr |

Annual billing reduces Stripe's per-transaction overhead from ~18% to ~3-5% and reduces churn significantly. Equivalent to ~$1.25/mo — competitive for a niche pro tool.

**Target:** break-even + modest margin. Not a venture-scale play. ~50-100 paying users likely covers hosting + Stripe fees with margin.

**Hosting cost:** Vercel free tier handles this volume easily. Near-zero fixed cost.

---

## Auth Strategy: Progressive, Feature-Gated

No login required to use the app. Auth triggered only when specific features need it.

### No auth required (always free, always works):
- Create/edit show config (band, venue, date)
- Stage plot, input list, monitor mixes, setlist
- Manual chart URL entry
- Print / PDF export
- Share via URL (config encoded in `?config=` param)
- localStorage persistence

### Google OAuth (on-demand, per feature):
- **"Import from Google Sheets"** → triggers `sheets.readonly` scope
- **"Connect Charts Folder"** → triggers `drive.file` scope

OAuth prompt appears only when user clicks these features — never upfront. Users who never use Sheets/Drive never see a login prompt.

### BYOA (Bring Your Own API key):
- AI collaborator feature — user supplies their own Anthropic/OpenAI key
- Stored in localStorage, never sent to any server except the AI provider directly
- Zero cost to the app operator

---

## Google OAuth Scopes (Minimal Surface)

| Scope | Purpose | Verification burden |
|---|---|---|
| `sheets.readonly` | Import setlist from Google Sheet | Low |
| `drive.file` | Access Charts folder (app-created or user-opened files only) | Low |

**Why `drive.file` not `drive.readonly`:** `drive.file` is scoped to files the app created or the user explicitly opened through the app — covers the Charts folder (app created it on setup) and any sheets imported by the user. Google does not require full OAuth verification for `drive.file` scope apps. Much easier review path than broad Drive access.

Apple has no visibility into Google OAuth flows — it's a standard web authentication, outside their purview.

---

## Pricing Tiers (Draft)

| Tier | Price | Features |
|---|---|---|
| **Free** | $0 | Full show config, manual everything, print, share link |
| **Pro** | $14.99/yr | + Google Sheets import, Drive charts, AI collaborator (BYOA), multi-show library |

Free tier is fully functional — not crippled. Pro tier adds the integrations that require external services. Natural upgrade path for power users.

---

## Google OAuth App Verification

To use Google OAuth in production (beyond 100 test users), Google requires:
- Privacy policy URL
- Terms of service URL
- App domain verification
- Scope justification (why do you need drive.file?)

**Timeline:** `drive.file` + `sheets.readonly` is a lighter verification path than sensitive scopes. Typically 1-2 weeks with complete submission. Start this process before public launch.

**Checklist:**
- [ ] Privacy policy page (e.g. `/privacy`)
- [ ] Terms of service page (e.g. `/terms`)
- [ ] Domain verified in Google Search Console
- [ ] OAuth consent screen completed in Google Cloud Console
- [ ] Submit for verification

---

## PWA Requirements Checklist

For full PWA installability:
- [ ] `manifest.json` with name, icons (192px, 512px), display: standalone, theme_color
- [ ] HTTPS (Vercel handles this)
- [ ] Service worker for offline support (at minimum: cache app shell)
- [ ] Icons in `/public/` at required sizes

Offline support priority: the app should work without internet for shows already loaded (cached config + chart URLs). Chart files themselves (PDFs, Docs) require connectivity to open.

---

## Open Questions

- App name? (Currently `stage-plot` — needs a product name for commercial release)
- Single Google Cloud project or per-user? (Single project with OAuth consent screen is standard)
- Stripe account: `graham@sunsetlabs.ai` or a dedicated account for this product?
- Free tier limit: unlimited shows, or cap at N shows to nudge upgrade?
