# Design: YAML Show Files & BYOS Storage

**Status:** v1.2 — post-adversarial review (7 + 3 findings addressed). Build state tracked in `docs/INDEX.md`, not here.
**Depends on:** None (Phase 1 is a format change; Phase 2 adds a storage provider)
**Scope:** Migrate show file format from JSON to YAML; introduce Bring Your Own Storage (BYOS) with GitHub as first provider; define chart normalization path for .md-first storage.

---

## The Problem

ShowRunr stores everything in localStorage. One browser clear, one device swap, one incognito tab — and the show's gone. The `.showrunr.json` export is a safety net, but it's manual. Musicians don't think about backups until load-in, and by then it's too late.

The existing Google Drive integration solves chart *access* (resolving PDFs and Docs from role-based folders), but it doesn't solve show file *persistence*. Show config — stage plot, inputs, monitors, setlist — lives only in the browser.

**Goal:** Make show files durable, portable, and version-controlled without adding a backend database.

---

## Design: Three Phases

### Phase 1: YAML Show Files (immediate, this PR)

Replace `.showrunr.json` export/import with `.showrunr.yaml`. Same data, better format.

### Phase 2: BYOS — GitHub Provider

Store `.showrunr.yaml` files in the user's own GitHub repo. Auto-save on edit, version history from git, zero infrastructure cost.

### Phase 3: Chart Normalization & GitHub Charts

Convert PDF/Google Doc charts to Markdown. Once charts are `.md`, they can live in the same GitHub repo as the show file — no Drive dependency for bands that don't use it.

---

## Phase 1: YAML Show Files

### Why YAML Over JSON

| Concern | JSON | YAML |
|---|---|---|
| Human-readable | Barely (brackets, quotes, commas) | Yes (indentation, plain strings) |
| Comments | No | Yes (`# extended outro solo`) |
| Multi-line strings | Escaped `\n` | Block scalars (`\|`, `>`) |
| Git diffs | Noisy (trailing commas, brackets) | Clean (line-per-value) |
| Editor support | Universal | Universal (VSCode, vim, etc.) |
| Parse in JS | Native `JSON.parse` | `yaml` package (MIT, 45KB gzipped) |

The trade-off is a new dependency (`yaml` on npm). Worth it — the show file becomes something a musician can open in any text editor, read, and hand-edit if needed.

### Show File Schema (`.showrunr.yaml`)

```yaml
# ShowRunr Show File v1
format: showrunr/v1

name: Loosely Covered
date: 2026-05-21
venue: Bohemian Club
lineup: 7-Piece Band

stagePlot:
  - name: Rachel
    pos: DSC
    role: Lead Vox
    mix: 1
    featured: true
  - name: Graham
    pos: DSL
    role: Gtr + BGV
    mix: 2
    power: true
  - name: JT
    pos: USC
    role: Drums
    mix: 6

inputs:
  - ch: 1
    inst: Kick
    mic: Beta 52 / D6
    stand: Short Boom
  - ch: 2
    inst: Snare Top
    mic: SM57
    stand: Short Boom
    notes: 2-3" off head, angled

monitors:
  - mix: 1
    name: Rachel (DSC)
    needs: Lead Vox only, light keys

notes:
  - label: Power
    text: |
      Terry (USL) and Matt (USR) need AC drops.
      Graham's pedalboard runs on its own power supply.

setlist:
  - title: Valerie
    lead: Rachel
    notes: "E -- Amy Winehouse; Graham/Matt BGV"
  - title: Superstition
    lead: Graham
    notes: "Ebm -- Stevie Wonder, extended outro solo"

# Chart source (optional -- preserved for Drive users)
chartsSource:
  provider: drive
  folderId: 1a2b3c_drive_folder_id
```

### Schema Changes vs. Current `.showrunr.json`

| Current (AppConfig JSON) | New (YAML) | Reason |
|---|---|---|
| `showInfo.bandName` | `name` | Flatten — no nested wrapper |
| `showInfo.eventDate` | `date` | Flatten |
| `showInfo.venue` | `venue` | Flatten |
| `lineup` | `lineup` | No change |
| `setlist[].id` | *omitted* | Runtime concern (DnD). Regenerated on load via `withStableIds()` |
| `setlist[].position` | *omitted* | Redundant with array index. Recomputed on load via `renumberSetlist()`. |
| `setlist[].charts[]` | *omitted from default export* | Resolved at runtime from chartsSource. See "Chart References" below. |
| `chartsRootFolderId` | `chartsSource.folderId` | Namespaced under provider block |
| — | `format: showrunr/v1` | Version tag for future schema evolution |

### Chart References — Export Options

Charts are resolved at runtime (batch resolution from Drive). By default, the YAML export omits chart URLs — they're ephemeral (Drive URLs can change, files get moved).

For offline portability, an explicit "Export with chart refs" option embeds them:

```yaml
setlist:
  - title: Valerie
    lead: Rachel
    charts:
      - role: Lyrics
        url: https://drive.google.com/file/d/abc123
        fileId: abc123
      - role: Guitar
        url: https://drive.google.com/file/d/def456
        fileId: def456
```

This is opt-in. The default export is clean and portable.

### Import Compatibility

The import flow accepts both `.showrunr.json` (legacy) and `.showrunr.yaml` (new):

1. Read file extension
2. `.json` → `JSON.parse()`, map `showInfo.*` to flat fields, pass through existing validation
3. `.yaml` → `yaml.parse()`, validate `format: showrunr/v1`, pass through same validation
4. Both paths produce the same internal `AppConfig` object
5. `withStableIds()` ensures all songs/inputs/monitors get UUIDs
6. `renumberSetlist()` recomputes `position` from array index (1-based) — required because YAML omits position

**Finding #3 fix:** `withStableIds()` currently does NOT call `renumberSetlist()`. The deserializer must call it explicitly, or `withStableIds()` must be extended to include renumbering. Without this, imported YAML songs will render with `undefined` position numbers.

Old `.showrunr.json` files remain importable indefinitely. No forced migration.

### Internal Storage (No Change)

localStorage continues to store JSON internally. YAML is the *file format*, not the runtime format. The serialization boundary is at export/import only.

### New Dependency

```
npm install yaml
```

`yaml` (npm) — YAML 1.2 parser/serializer for JS. MIT license, zero dependencies, well-maintained. Used by Prettier, ESLint, and most of the JS ecosystem.

### Implementation

1. Add `yaml` dependency
2. Create `lib/show-file.ts`:
   - `serializeShow(config: AppConfig): string` — YAML output
   - `deserializeShow(content: string, filename: string): AppConfig` — detects format by extension, parses, validates, normalizes
3. Update export button: `.showrunr.yaml` filename, YAML content
4. Update import: accept both `.yaml` and `.json`
5. Update `Content-Type` on download: `application/x-yaml`
6. Shareable URL (`?config=` param): stays as base64-encoded JSON — URLs need compact encoding, not human readability

---

## Phase 2: BYOS — GitHub Provider

### The Model

Users connect their GitHub account. ShowRunr reads/writes `.showrunr.yaml` files to a repo they own. Git provides version history, branching, and collaboration for free.

```
user-repo/
  shows/
    2026-05-21-bohemian-club.showrunr.yaml
    2026-06-15-great-american.showrunr.yaml
    tour-summer-26.showrunr.yaml
```

ShowRunr becomes a "fat client" over the user's own storage. No Vercel database, no backend persistence, no data ownership questions.

### Why GitHub First

1. **Free repos** — unlimited private repos on free tier
2. **Native YAML** — GitHub renders YAML with syntax highlighting
3. **Version history** — every save is a commit; full undo/diff for free
4. **Collaboration** — share a repo, everyone sees the same shows
5. **Offline** — `git clone` gives you a local copy; Service Worker caches last-known state in the app
6. **Graham's workflow** — you already live in GitHub; this is zero friction

### Auth Flow

**Decision (Finding R2-#2): GitHub App, not OAuth App.** The two paths have fundamentally different token models. We pick one — GitHub App — and design for it cleanly.

#### Why GitHub App over OAuth App

| Concern | Classic OAuth App | GitHub App |
|---|---|---|
| Scope | `repo` — all repos, read + write | Per-repo installation, `contents: write` only |
| Token type | Personal access token (never expires unless revoked) | User-to-server token (expires in 8 hours) |
| Refresh | None needed (but revocation on password change / SSO / 1yr inactivity) | Refresh token flow (standard OAuth2 refresh) |
| User trust | "ShowRunr wants access to all your repos" | "Install ShowRunr on: [repo picker]" |

#### Auth Flow (GitHub App)

1. `GET /api/auth/github` — redirect to GitHub App installation/authorization URL
2. User installs the App on a specific repo (or grants access to a selected repo)
3. `GET /api/auth/github/callback` — exchange code for user-to-server access token + refresh token
4. Both tokens stored in localStorage as `stageplot-github-token`:
   ```typescript
   interface GitHubToken {
     access_token: string;   // expires in 8 hours
     refresh_token: string;  // expires in 6 months
     expires_at: number;     // epoch ms
   }
   ```
5. Before every API call, check `expires_at`. If expired, exchange refresh token for new access token via `POST https://github.com/login/oauth/access_token` with `grant_type=refresh_token`.
6. If refresh token is also expired (6 months) or revoked → clear tokens, surface "Reconnect GitHub" prompt, fall back to localStorage. No silent data loss.

#### GitHub App Registration

Requires a one-time setup in GitHub Developer Settings:
- **App name:** ShowRunr
- **Callback URL:** `{DEPLOY_URL}/api/auth/github/callback`
- **Permissions:** Repository contents (read & write)
- **User authorization:** "Request user authorization (OAuth) during installation"
- **Webhook:** disabled (we don't need push events)

The App ID and private key go into env vars (`GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`), same pattern as the existing Google OAuth setup.

### Storage Provider Interface (SPI)

```typescript
interface ShowStorage {
  type: 'local' | 'github';  // extensible: 'drive' | 'dropbox' later

  // Show CRUD
  listShows(): Promise<ShowSummary[]>;
  loadShow(id: string): Promise<AppConfig>;
  saveShow(id: string, config: AppConfig): Promise<void>;
  deleteShow(id: string): Promise<void>;

  // Metadata
  getHistory(id: string): Promise<VersionEntry[]>;  // git log for GitHub
}

interface ShowSummary {
  id: string;           // filename stem: "2026-05-21-bohemian-club"
  name: string;         // derived from filename (slug → title case), NOT parsed from YAML
  date?: string;        // derived from filename date prefix (YYYY-MM-DD)
  lastModified: string; // git commit date or file mtime
}
```

The `local` provider wraps current localStorage behavior — no regression for users who don't connect GitHub.

### GitHub Provider Implementation

| Operation | GitHub API | Notes |
|---|---|---|
| `listShows()` | `GET /repos/{owner}/{repo}/contents/shows/` | Returns file list; **parse filenames only** for summaries (name/date extracted from filename convention `YYYY-MM-DD-venue-name.showrunr.yaml`). Full YAML parsing only on `loadShow()` — avoids N API calls to read file contents for the list view. (Finding #4) |
| `loadShow(id)` | `GET /repos/{owner}/{repo}/contents/shows/{id}.showrunr.yaml` | Returns base64-encoded content; decode + parse YAML |
| `saveShow(id, config)` | `PUT /repos/{owner}/{repo}/contents/shows/{id}.showrunr.yaml` | Requires SHA of current file (for update); creates commit |
| `deleteShow(id)` | `DELETE /repos/{owner}/{repo}/contents/shows/{id}.showrunr.yaml` | Requires SHA |
| `getHistory(id)` | `GET /repos/{owner}/{repo}/commits?path=shows/{id}.showrunr.yaml` | Commit log for file |

### Auto-Save

- Debounced save (2s after last edit, same as current localStorage write pattern)
- Each save = one git commit (message: `Update {show-name}` or `Auto-save {show-name}`)
- No batching — one file per commit keeps history clean
- Commits go to the default branch (main)

**Branch protection (Findings #5 + R2-#1):** If the target repo has branch protection rules (PR-only, required checks), direct commits to main will fail with a 403/422. A read-only probe will NOT detect this — reads succeed regardless of write protection.

Detection strategy: on repo setup, perform a **probe write** — create and immediately delete a disposable file (`shows/.showrunr-probe`, empty content) via the Contents API. If the write returns 403/422, branch protection is active. Surface a clear message: "This repo requires pull requests on the default branch. Either disable branch protection or pick a different repo." If the write succeeds, delete the probe file and proceed.

This costs 2 API calls (create + delete) but runs once during setup, not on every save. We do NOT auto-create PRs for auto-save — that's a fundamentally different UX and out of scope.

### Rate Limits

GitHub API: 5,000 requests/hour for authenticated users. A heavy session (loading 10 shows, saving 30 times) uses ~50 requests. Not a concern.

### Offline Behavior

- Service Worker caches last-loaded YAML for each show
- If GitHub is unreachable (gig venue, no wifi), app loads from SW cache
- Edits save to localStorage as fallback
- On reconnect, sync using SHA-based conflict detection (Finding #2):
  1. App stores the last-known file SHA (from the most recent `loadShow()` or `saveShow()` response)
  2. On reconnect, `saveShow()` sends this SHA as the precondition to GitHub's PUT endpoint
  3. If SHA matches → commit succeeds (no conflict)
  4. If SHA mismatch → GitHub returns 409 Conflict → app fetches the remote version
  5. Conflict UX: side-by-side diff showing "Your version" vs. "GitHub version" with options: "Keep mine" (force-overwrite with new SHA), "Keep theirs" (discard local), or "Export mine as file" (safety valve)
  6. Timestamp comparison is NOT used — SHAs are the only reliable conflict detector

### Repo Setup UX

First-time flow:
1. User clicks "Connect GitHub" → OAuth
2. App prompts: "Pick a repo for your shows" → repo selector (list user's repos)
3. Option: "Create new repo" → creates `showrunr-data` (private) via API
4. App creates `shows/` directory with a `README.md` explaining the format
5. Repo + path stored in localStorage config

### Interaction with Existing Systems

| System | Impact |
|---|---|
| **localStorage** | Becomes the `local` provider; still works for users who don't connect GitHub |
| **`.showrunr.json` import** | Still works — import any format, optionally save to GitHub |
| **Shareable URLs** | Still work — `?config=` embeds the full config regardless of storage provider |
| **Google Drive charts** | Unchanged — charts are resolved from Drive at setup time, independent of where the show file lives |
| **Offline chart cache** | Unchanged — Cache API stores chart blobs regardless of show storage |
| **AI Codesigner** | Unchanged — modifies in-memory config via tool use; save triggers write to active provider |
| **Print/PDF** | Unchanged — renders from in-memory config |

---

## Phase 3: Chart Normalization & .md-First Storage

### The Opportunity

GitHub is great for text files. Charts today are mostly PDFs and Google Docs — binary blobs that GitHub can store but can't diff, render, or search. If we normalize charts to Markdown, GitHub becomes a viable home for *everything* — show files and charts in one repo.

```
user-repo/
  shows/
    2026-05-21-bohemian-club.showrunr.yaml
  charts/
    valerie/
      lyrics.md       # Singer view
      guitar.md       # Chord chart (Nashville or standard)
      horns.md        # Horn chart (could be ABC notation in fenced block)
    superstition/
      lyrics.md
      guitar.md
      original.pdf    # Unconverted legacy fallback
```

### Why .md

1. **Universal** — every developer, every text editor, every platform renders Markdown
2. **GitHub renders it** — musicians can browse charts in the GitHub web UI without ShowRunr
3. **Diffable** — "who changed the key on Valerie?" is a git diff
4. **Lightweight** — a chord chart is 1-2KB vs. 500KB for a PDF
5. **AI-friendly** — structured text is trivially parseable by the codesigner agent

### Chart Markdown Format

**Lyrics (singer view):**
```markdown
# Valerie

**Key:** E | **Tempo:** 120 | **Feel:** Indie Pop

## Intro
(Guitar riff — 4 bars)

## Verse 1
Well sometimes I go out by myself
And I look across the water

## Chorus
> **Valerie** — why don't you come on over
> **Valerie** — (band hits on "Val-")
```

**Chord chart (rhythm section):**
```markdown
# Valerie — Guitar/Keys

**Key:** E | **Tempo:** 120

## Intro
| E  | Abm | F#m | E  |

## Verse
| E  | Abm | F#m | E  |
| E  | Abm | F#m | E  |

## Chorus
| A  | B   | E   | C#m |
| A  | B   | E   |     |
```

**Horn chart (melodic content):**

````markdown
# Valerie — Horn Section (Concert Pitch)

**Key:** E | **Tempo:** 120

## Chorus Hits
Bar 1: concert E, whole note (tutti)
Bar 3: walk up E-F#-G#-A (8th notes, unison)

<!-- Optional: ABC notation for rendering -->
```abc
X:1
T:Valerie - Horn Riff
K:E
M:4/4
L:1/8
|: E4 z4 | z4 z4 | E F G A B2 z2 | z8 :|
```
````

ABC notation (for horn/melodic parts) lives inside fenced code blocks in Markdown. GitHub renders these as plain code blocks (readable). ShowRunr can optionally render them with `abcjs` as a future enhancement. (Finding #7: outer fence uses quadruple backticks to nest correctly.)

### The Conversion Path

The AI codesigner (PR #17) already has Claude integration and tool use. Adding a "Digitize Chart" capability:

1. User uploads a PDF or image of a chart
2. Codesigner agent extracts content via Claude's vision capability
3. Agent generates role-appropriate `.md` files:
   - Lyrics → `lyrics.md` (strip music, keep structure)
   - Chord chart → `guitar.md` / `keys.md` (extract chords + form)
   - Horn part → `horns.md` (describe lines, optionally ABC notation)
4. User previews the Markdown against the original PDF
5. User approves → files committed to GitHub repo (or saved locally)
6. Original PDF kept as `original.pdf` fallback

### What Converts Well, What Doesn't

| Source | Conversion Quality | Notes |
|---|---|---|
| Lyrics sheet (text-heavy) | High | OCR + structure detection is reliable |
| Chord chart (Nashville numbers) | High | Numeric, regular grid pattern |
| Chord chart (standard notation) | Medium | Chord names above staff — extractable; voicings lost |
| Lead sheet (melody + chords) | Medium | Chords extractable; melody → ABC is imperfect |
| Full score (orchestral) | Low | Too complex for reliable automated conversion |
| Handwritten charts | Low-Medium | Vision model dependent; may need manual cleanup |

Unconverted or complex charts stay as PDFs. The `original.pdf` in the song folder is the fallback — ShowRunr opens it the same way it opens Drive PDFs today.

### Chart Resolution (Evolved)

Today: batch-resolve charts from Drive role subfolders by song title matching.

With GitHub charts: resolve by directory structure. Song title → folder name (normalized). Role → filename.

```typescript
// Phase 3 chart resolution for GitHub provider
async function resolveCharts(songTitle: string): Promise<Chart[]> {
  const folder = normalize(songTitle);  // reuse existing normalize()
  const files = await github.listFiles(`charts/${folder}/`);
  return files.map(f => ({
    role: f.name.replace(/\.(md|pdf|abc)$/, ''),  // "lyrics.md" → "lyrics"
    // Finding #1: Do NOT store download_url — it's ephemeral for private repos.
    // Store the stable path; fetch content JIT via authenticated API.
    path: `charts/${folder}/${f.name}`,  // stable repo-relative path
    sha: f.sha,                          // for cache invalidation
    label: f.name,
  }));
}

// To display a chart, fetch content on demand:
async function fetchChart(path: string): Promise<string> {
  // GET /repos/{owner}/{repo}/contents/{path} with Accept: application/vnd.github.raw
  // Returns raw file content via authenticated request — works for private repos
  return github.getFileContent(path);
}
```

**Finding #1 detail:** GitHub's `download_url` for private repos includes a short-lived token. Persisting it in `Chart.url` produces broken links after the token expires (~1 hour). Instead, store the stable repo-relative `path` and `sha`, then fetch raw content just-in-time via the authenticated Contents API. For `.md` charts, render the Markdown directly. For `.pdf` fallbacks, fetch the binary and display in an iframe (same pattern as the existing Drive download proxy).

The `Chart` interface gains two optional fields for GitHub-sourced charts (Finding R2-#3 — explicit in contract):

```typescript
export interface Chart {
  role: string;
  // Drive-sourced (existing)
  url?: string;            // Drive webViewLink
  fileId?: string;         // Drive file ID (for offline cache)
  mimeType?: string;       // original MIME type
  modifiedTime?: string;   // ISO timestamp (Drive cache invalidation)
  // GitHub-sourced (new)
  path?: string;           // repo-relative path, e.g. "charts/valerie/lyrics.md"
  sha?: string;            // git blob SHA (GitHub cache invalidation)
  // Shared
  label?: string;
  dupeCount?: number;
}
```

At most one source is populated: either `url`+`fileId` (Drive) or `path`+`sha` (GitHub). The `sha` field serves the same role as `modifiedTime` for Drive — if the blob SHA changes, the cached version is stale.

Drive resolution stays for users who keep charts on Drive. The two models coexist — `chartsSource.provider` in the show file controls which resolver runs.

---

## Migration & Backwards Compatibility

| Artifact | Migration | Breaking? |
|---|---|---|
| `.showrunr.json` files | Importable forever; "Save As YAML" option in import flow | No |
| localStorage data | Stays as JSON internally; no migration needed | No |
| Shareable URLs | Stay as base64 JSON; no change | No |
| Google Drive charts | Continue working via existing batch resolution | No |
| Offline chart cache | Unchanged (Cache API, keyed by fileId) | No |

Phase 1 is purely additive. Phase 2 adds a storage option without removing the existing one. Phase 3 adds a chart format without removing PDF support.

---

## Backlog Alignment

| Backlog Item | Relationship |
|---|---|
| **#8: Env var settings UX** | Independent — build before or after Phase 1 |
| **#9: TWA/WebKit wrapper** | Independent |
| **#10: Slug URLs** | Could share GitHub backend (slug → repo path); design after Phase 2 |
| **#11: Vercel KV quota** | Independent — try-it quota is separate from storage |

**Proposed order:** Phase 1 (YAML, small PR) → existing backlog items → Phase 2 (GitHub BYOS, larger) → Phase 3 (chart normalization, largest).

Phase 1 is a day of work. Phase 2 is a multi-session effort. Phase 3 depends on Phase 2 and the quality of Claude's vision-to-markdown conversion.

---

## Adversarial Cross-Check (Codex Review — v1.2, 2 rounds)

### Round 1 Findings (all addressed)

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | **HIGH** | GitHub `download_url` is ephemeral for private repos — persisting it breaks chart links | Store stable `path` + `sha`; fetch content JIT via authenticated API. See Phase 3 chart resolution code. |
| 2 | **HIGH** | Timestamp-based conflict detection is unreliable | Replaced with SHA-based preconditions. 409 → side-by-side conflict UX. See Offline Behavior. |
| 3 | **HIGH** | YAML omits `position` but `withStableIds()` doesn't recompute it | Deserializer must call `renumberSetlist()`. Documented in Import Compatibility. |
| 4 | **MEDIUM** | `listShows()` says "parsed from YAML" but also "parse filenames" — inconsistent | Clarified: filenames only for list view (no N+1 reads). YAML parsed only on `loadShow()`. |
| 5 | **MEDIUM** | Auto-save to main fails in branch-protected repos | Detect on repo setup; surface clear message; no auto-PR creation. See Auto-Save. |
| 6 | **MEDIUM** | `repo` scope too broad; token lifecycle assumptions too optimistic | Prefer GitHub App with fine-grained permissions. Handle 401 gracefully. See Auth Flow. |
| 7 | **LOW** | Nested fenced-code blocks render incorrectly | Fixed with quadruple-backtick outer fence. See horn chart example. |

### Round 2 Findings (all addressed)

| # | Severity | Finding | Resolution |
|---|---|---|---|
| R2-1 | **MEDIUM** | Branch-protection detection used a read probe — reads pass even with write protection | Replaced with probe write (create + delete disposable file). See Auto-Save. |
| R2-2 | **MEDIUM** | Auth model mixed OAuth App and GitHub App — different token lifecycles, spec was ambiguous | Committed to GitHub App only. Full token model (8hr access + 6mo refresh) specified. See Auth Flow. |
| R2-3 | **LOW** | Chart interface mentioned `path` but not `sha` — cache invalidation gap | `sha` now explicit in the `Chart` interface contract. See Phase 3 Finding #1 detail. |

### Open Questions (still need answers before build)

1. **Dependency risk:** `yaml` package — is it stable? What's the maintenance status? Are there known CVEs? Is there a lighter alternative?
2. **Round-trip fidelity:** Does `yaml.parse(yaml.stringify(config))` produce identical output to the input? Edge cases: special characters in song titles, multi-line notes, emoji in band names.
3. **Chart ref omission UX:** Default export omits chart URLs. What if a user exports, clears their browser, re-imports, and expects charts? How do we communicate this clearly?
4. **Token storage:** GitHub token in localStorage is accessible to any XSS. Same risk as current Google token. Acceptable trade-off? (HttpOnly cookie requires backend proxy for every API call.)
5. **Repo pollution:** Auto-save creates many small commits. Mitigation: encourage dedicated repo. Sufficient?
6. **Conversion quality (Phase 3):** Claude's vision model on music notation — is it good enough for horn parts, or only lyrics/chords? Needs empirical testing before committing to Phase 3.
7. **Duplicate song titles (Phase 3):** `charts/valerie/` uses normalized title as folder name. Two songs called "Crazy" → collision. Disambiguate with artist? Song ID?

---

## What This Design Intentionally Does NOT Cover

- **Google Drive as a BYOS provider** — future. Drive's API is more complex (no native YAML rendering, no version history UX). GitHub first.
- **Dropbox as a BYOS provider** — future. Same rationale.
- **Nashville Number System (NNS) as a dedicated file format** — NNS fits naturally in Markdown tables. No need for a custom `.nns` format or parser.
- **ABC notation rendering** — `abcjs` integration is a rendering enhancement, not a storage concern. Separate design doc if/when we build it.
- **Multi-provider sync** — show file on GitHub AND Drive simultaneously. Not needed; pick one provider per show.
- **Real-time collaboration** — two users editing the same show live. Out of scope; git handles async collaboration.
