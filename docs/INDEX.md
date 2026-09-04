# docs/ — the index

**This file is the single source of truth for whether a doc's subject is BUILT.**
Individual docs do not carry their own build status any more. They carried one for months,
written at design time and never revisited at ship time, and on 2026-09-04 an audit found
**19 of 75 docs telling a reader "DESIGN-ONLY — do NOT build" for features that had been
live for months.** Nothing failed when a status line was wrong, so every one of them rotted.

`tests/docs-index-contract.test.ts` fails if a doc is missing here, listed twice, listed but
absent from disk, or given a state outside the vocabulary. It deliberately does **not** check
that a state is *correct* — no test can — but a doc can no longer be added, or deleted, without
someone making a decision here.

Every state below was verified against code on 2026-09-04, not read off the doc.

| State | Meaning |
|---|---|
| `SHIPPED-RECORD` | Built. The doc is the record of *why*, not a thing to build. |
| `PARTIAL` | Some named parts built, others not — the note says which. |
| `UNBUILT-DESIGN` | Designed, not built. Safe to build from, subject to the usual gate. |
| `BACKLOG` | Holding pen. Needs a design before it is buildable. |
| `SUPERSEDED` | Dead. The thing it specifies was removed. Retained only while something points at it. |
| `OPS` | Runbook, agent instruction, or operational/UAT record. Not a design. |

## Charting — uploaded PDFs, calibration, overlays

| Doc | State | Note |
|---|---|---|
| `design-chart-converter.md` | SHIPPED-RECORD | Uploaded PDF → VLM → draft calibration. Live at `/api/charts/convert`. |
| `design-chart-library.md` | SHIPPED-RECORD | `chart_library` + upload. Migration `003_chart_library.sql`. |
| `design-chart-measurement.md` | SHIPPED-RECORD | Measurement engine, B1 **and** B2 (`lib/chart-measured.ts:297` → `convert/route.ts:227`). ⚠ Its own text still says B2 is unbuilt and `:210` "Nothing imports them" — both false. |
| `design-chart-review-step.md` | PARTIAL | Verdict vocabulary shipped (`lib/types.ts:96`, `chart-calibration.ts:1005`). The pick-a-split review sheet is **chunk C, unbuilt** — today's review UI is still the v1 confidence queue it set out to replace. |
| `design-chart-offline-fixes.md` | SHIPPED-RECORD | Both fixes live (`page.tsx:6208`, `songs/route.ts:83`). |
| `design-chart-role-overrides.md` | UNBUILT-DESIGN | No `chartOverrides`/`sourceRole` anywhere. One role per chart still. |
| `design-barline-calibration.md` | SHIPPED-RECORD | `moveBarBoundary` (`lib/chart-calibration.ts:526`). |
| `design-barline-add-remove.md` | SHIPPED-RECORD | `addBarline`/`removeBarline` (`lib/chart-calibration.ts:738,778`). |
| `design-cv-barline-snap.md` | SHIPPED-RECORD | `snapBarsToLines` (`lib/chart-snap.ts:163`). |
| `design-library-chart-management.md` | SHIPPED-RECORD | `components/ManageChartsModal.tsx:65`. |
| `design-inline-chart-viewer.md` | SHIPPED-RECORD | pdf.js viewer, cache-first (`lib/pdf-viewer.ts:1-13`). |
| `design-realtime-chart-control.md` | SHIPPED-RECORD | Calibration sidecar + conductor legs. |
| `design-nav-graph.md` | SHIPPED-RECORD | `resolveRoadmap` (`lib/chart-calibration.ts:938`). |
| `design-perform-readiness.md` | SHIPPED-RECORD | `performReadiness` + `PerformReadinessStrip`. |
| `design-batch-chart-resolution.md` | SUPERSEDED | Drive-era batch resolution; replaced by library-keyed resolution at show GET. The route survives but bails for every real show (`page.tsx:6208`). |
| `backlog-charting.md` | BACKLOG | Holding pen, explicitly not a plan. |

## Roadmap builder — native charts

| Doc | State | Note |
|---|---|---|
| `design-roadmap-builder.md` | SHIPPED-RECORD | Migration `009`, `components/RoadmapBuilder.tsx`. |
| `design-roadmap-key-resolution.md` | SHIPPED-RECORD | `relabelSection` (`lib/chart-calibration.ts:101`). |
| `design-roadmap-edit-loop.md` | SHIPPED-RECORD | Re-open + replace-on-save. Already self-labelled correctly. |
| `design-roadmap-authoring-fidelity.md` | SHIPPED-RECORD | Transcribe-then-fold pipeline (`lib/roadmap-parse.ts:20-26`). |
| `design-roadmap-expressiveness.md` | PARTIAL | Gap 1 shipped (`alter?` + `drawAccidental`). Gap 2 (`keyShift`) unbuilt. |
| `design-roadmap-fit-to-width.md` | SHIPPED-RECORD | Wrap + both render bugs (`lib/roadmap-layout.ts:174`). |
| `design-roadmap-line-measure-numbers.md` | SHIPPED-RECORD | Both surfaces (`roadmap-render.ts:260`, `RoadmapBuilder.tsx:906`). |
| `design-roadmap-notation-toggle.md` | SHIPPED-RECORD | Migration `017` + builder toggle. |
| `design-roadmap-prompt-persistence.md` | SHIPPED-RECORD | Migration `016`, read+write doors both wired. |
| `design-song-form-from-lyrics.md` | UNBUILT-DESIGN | No lyrics parser, no second proposer. Feeds `lib/song-structure.ts`, which does exist. |

## Conductor — authority, clock, transport

| Doc | State | Note |
|---|---|---|
| `design-conductor-authority.md` | PARTIAL | Chunks 1–5 shipped. §2.2 per-chart **alignment persistence** unbuilt — no migration, and `song-structure.ts` has one prod consumer. |
| `design-conductor-chunk3.md` | SHIPPED-RECORD | `lib/conductor-state.ts:29`. |
| `design-conductor-chunk4.md` | SHIPPED-RECORD | `lib/conductor-session.ts` + `conductor-targets.ts`. |
| `design-conductor-chunk4-ui.md` | SHIPPED-RECORD | `ConductorCluster`, mounted `page.tsx:3370`. |
| `design-conductor-chunk5.md` | SHIPPED-RECORD | `shouldAutoFire` returns real verdicts (`conductor-session.ts:166`). |
| `design-conductor-chunk5b-clock.md` | PARTIAL | Reckoning/align/motion/confidence shipped. The `live`/`coasting` audio rung and the deferred `seek` re-seat are not. |
| `design-conductor-chunk5b-c1-align.md` | SHIPPED-RECORD | `initReckoning`/`alignReckoning`. |
| `design-conductor-chunk5b-c2-motion.md` | SHIPPED-RECORD | `computeStaticRung`/`rebaselineMotion`. |
| `design-conductor-chunk5b-c3-confidence.md` | SHIPPED-RECORD | `CLOCK_CONFIDENCE_BOUND_BARS = 8` (`conductor-clock.ts:149`). |
| `design-conductor-chunk5b-c4-live.md` | PARTIAL | 4a shipped (tempo detect + telemetry). 4b unbuilt — `conductor-clock.ts:161` still `case 'live': return false`. |
| `design-conductor-insert-return.md` | SHIPPED-RECORD | Return-leg resolver (`lib/conductor-targets.ts:280`). |
| `design-conductor-3b-discovery-failover.md` | SHIPPED-RECORD | `SessionKey` triple + relay arbiter (`relay/relay-core.ts:232-270`). |
| `design-conductor-ux-polish.md` | SHIPPED-RECORD | All three sections. |

## Relay

| Doc | State | Note |
|---|---|---|
| `design-relay-cloud.md` | SHIPPED-RECORD | Live on Fly at `relay.showrunr.ai`. Cert expires 2026-09-30. |
| `relay-provisioning.md` | OPS | At-home provisioning checklist. |

## Backend, identity, keys, commercial

| Doc | State | Note |
|---|---|---|
| `design-single-backend.md` | SHIPPED-RECORD | All chunks incl. 4 (`components/SettingsOverlay.tsx`). ⚠ Its own §status still lists chunk 4 as "remaining". Only the Vercel env teardown remains, outside the repo. |
| `design-supabase-backend.md` | PARTIAL | The four items its banner lists as unbuilt are closed. **But its "What Goes Away" table still specifies killing Google Drive (`:81-82`), which has not happened and is not going to** — Drive stays, ruled 2026-09-04; see `backlog-charting.md` §Google Drive stays. |
| `design-owner-namespacing.md` | SHIPPED-RECORD | Migration `005` + the `[owner]/[show]` route. |
| `design-owner-onboarding.md` | PARTIAL | Claim flow shipped. The `ADMIN_SECRET` bearer auth is dead — replaced by `requirePlatformAdmin()`. |
| `design-ai-key-availability.md` | PARTIAL | Probe + panel + recovery shipped. **§13 (one key resolver for all three AI surfaces) unbuilt** — parse and convert still call `getAdminConfig` directly. |
| `design-account-key-recovery.md` | SHIPPED-RECORD | `keyReject` wired (`agent/chat/route.ts:141`). |
| `design-payments.md` | UNBUILT-DESIGN | No Stripe, no tier/quota table anywhere. |
| `strategy-pwa-commercial.md` | PARTIAL | PWA half shipped. Commercial half has no code. |
| `backlog-admin-identity.md` | BACKLOG | Salvage of closed PR #123. Carries "account deletion is impossible today". |

## Offline, PWA, storage, Drive

| Doc | State | Note |
|---|---|---|
| `design-offline-pwa-supabase.md` | SHIPPED-RECORD | All three changes live. |
| `design-offline-chart-cache.md` | PARTIAL | The Cache-API design is **live and primary** (`lib/chart-cache.ts:32,62,155`). Only its Drive transport and manual CTA are legacy. Do not delete. |
| `design-alpha-ready.md` | SHIPPED-RECORD | Namespacing + PWA, both parts. |
| `design-storage-notation.md` | PARTIAL | Phase 1 YAML shipped (`lib/show-file.ts:1`). Phase 2 BYOS/GitHub unbuilt. |
| `backlog-offline-performer-cache.md` | BACKLOG | Needs a design first. |

## AI agent

| Doc | State | Note |
|---|---|---|
| `design-agent-codesigner.md` | SHIPPED-RECORD | Zone grid + BYOA/try-it modes (`lib/agent.ts:7-18`). |
| `design-core-path-tier1.md` | PARTIAL | §1 shipped. §2 superseded. §3 (mix identity / `renumberMix`) unbuilt. |
| `design-ai-op-contract.md` | UNBUILT-DESIGN | No op type, no applier. Full-replace path still live (`page.tsx:5588`). |

## Show, setlist, inputs, sharing

| Doc | State | Note |
|---|---|---|
| `design-song-library.md` | SHIPPED-RECORD | Migrations `006`/`010`/`012`. |
| `design-setlist-import-merge.md` | SHIPPED-RECORD | Chunks 1–3, #124/#125/#127. |
| `design-setlist-reordering.md` | SHIPPED-RECORD | Drag + explicit move up/down. |
| `design-new-show-modal.md` | SHIPPED-RECORD | New + duplicate (`dashboard/page.tsx:240`). |
| `design-share-reliability.md` | SHIPPED-RECORD | Slug stability + poisoned-localStorage fix. |
| `design-perform-tab.md` | SHIPPED-RECORD | `lib/show-tabs.ts:18`. |
| `design-console-export.md` | SHIPPED-RECORD | Tier 1 CSV/XML. Tiers 2–3 future by design. |
| `design-input-plot-linkage.md` | PARTIAL | Data model (steps 1–5) shipped. Step 6, the op-based AI contract, unbuilt. |
| `design-input-sends.md` | UNBUILT-DESIGN | No `sends` field on `InputChannel`. |
| `design-offgrid-zones.md` | UNBUILT-DESIGN | `PIT`/`FOH` type-valid, un-rendered; agent told not to use them. |
| `backlog-song-library-manager.md` | BACKLOG | Needs a design first. |
| `backlog-show-freeze.md` | BACKLOG | Needs a design first. |

## UAT and audit records

| Doc | State | Note |
|---|---|---|
| `uat-readiness-gaps.md` | OPS | Findings. Nothing scheduled until Graham cuts the line. |
| `uat-realtime-chart-control-step1.md` | OPS | Historical manual UAT pass. |
