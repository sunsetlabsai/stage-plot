# Design: AI Op Contract — editing without replacing

**Status:** v1 — **Proposed. NOT approved, NOT built.**

**Date:** 2026-08-20
**Supersedes:** `docs/design-core-path-tier1.md` **§2 (chunk 2, "AI apply
integrity")** — see §9. §1 of that document has shipped (PR #144); §3 (mix
identity) is untouched and unaffected.

> ### ★ THE GATING ASSUMPTION — read before anything else
>
> **This entire document rests on one unverified claim: that the model can
> reliably emit correct, minimal ops.** We have not measured it. A spike exists
> (§10.1) and is blocked on API access.
>
> **If the spike fails, this design is shelved and "create-first" (§9.3) wins.**
> Nothing here should be built until the spike runs. Stating this up front
> because the last spec in this project produced a regression from a claim that
> was never checked — see `design-core-path-tier1.md` §1.2 part 3.

---

## §0 The question

Graham, 2026-08-20:

> "this is starting to sound like more dev work than its manual equivalent… the
> AI-generate on the input list might really be best used as a **create tool vs
> an edit tool**. at what point does iteration just become re-create anew?"

His argument, which this document accepts: if the AI's output is **close**,
dragging or typing the fix is faster than describing it. If it's **far**,
re-generate. The useful iteration surface is the **prompt**, not the diff.

He then identified two cases where that argument does **not** hold, and both are
v1 candidates:

1. **Bulk attribute change** — every wedge to IEMs, wired mics to wireless,
   straight stands to boom stands. One sentence versus twenty row edits.
2. **Additive / subtractive** — "strike the second guitar", "add two BGVs".
   Structural, not a field tweak.

Both are worth having and neither is served well by re-generation. This document
specifies the smallest contract that serves them safely.

---

## §1 Root cause — the contract and the prompt contradict each other

**Every AI tool today is whole-list replace** (`lib/agent.ts`):

| Tool | Description, verbatim |
|---|---|
| `update_inputs` | *"Replace the entire input list (channel list for FOH)."* |
| `update_monitors` | *"Replace the entire monitor mix list."* |
| `update_setlist` | *"Replace the entire setlist."* |
| `update_stage_plot` | replaces `stagePlot`, then cascades |

Meanwhile `lib/agent.ts`'s system prompt ends:

> *"The current show configuration is provided in each message. **Build on what
> exists rather than starting over**, unless the user asks for a fresh start."*

**We instruct the model to edit incrementally and hand it only
replace-the-world verbs.** Every "edit" is a full-list rewrite in which the
unchanged rows are reconstructed from memory — and anything the model fails to
reproduce is destroyed silently.

**This is why `design-core-path-tier1.md` §2 grew so large.** §2.1 teaches the
model to echo `id`s so that replace-the-world *happens* to be non-destructive;
§2.4 builds an impact-warning system for when it forgets. **§2.4 exists because
§2.1 cannot be trusted.** That is a workaround for a contract defect, not a fix.

**The fix is to change the verbs.** If the model names only the rows it intends
to touch, rows it does not mention cannot be destroyed — the property is
structural, not behavioural, and it needs no warning system to backstop it.

> **Prior art, unbuilt.** `docs/design-input-plot-linkage.md` **step 6** specified
> an op-based AI contract and was never built. `design-core-path-tier1.md`
> explicitly chose "a smaller mechanism that satisfies the same invariants"
> instead. This document returns to step 6's approach with a narrower scope.

---

## §2 Invariants

Every rule below names the mechanism that enforces it and whether that mechanism
exists today.

| # | Invariant | Enforced by |
|---|---|---|
| **O1** | A row the model does not name is not modified. | Structural — ops carry ids; there is no whole-list write path (§3) |
| **O2** | An op naming a row that does not exist is refused, not ignored. | `planChanges` validation (§5) — **does not exist yet** |
| **O3** | A reference (`slotId`, `mix`) is never left dangling by an applied plan. | Reference validation over the **post-batch** config (§5.2) — **does not exist yet** |
| **O4** | A plan applies completely or not at all. | Single tool, single approve card, pure `planChanges` (§6) — **does not exist yet** |
| **O5** | An ambiguous request produces a question, not a guess. | System prompt rule + no forced `tool_choice` (§4) |
| **O6** | Every tool call the model makes resolves to exactly one `tool_result`. | `buildApiMessages` — **currently violated by the new status; see §5.4** |
| **O7** | The user can see what a plan will change before approving it. | Approve card renders the ops as a diff (§7) — **does not exist yet** |

---

## §3 The contract

### 3.1 One tool, not nine

```
apply_changes({ ops: [ ... ] })
```

**Graham ruled: single tool.** The alternative — one tool per entity, each taking
`ops[]` — is easier for the model to drive but makes atomicity the app's problem:
"strike the second guitar" spans `stagePlot` and `inputs`, and if those arrive as
two calls, one can be approved and the other rejected, leaving a half-edited
show. A single call is atomic by construction and renders as one approve card.

The six existing tools are **not** removed by this document. See §9.2 for their
disposition.

### 3.2 Op shape

```ts
type Op = {
  entity: 'stagePlot' | 'inputs' | 'monitors';
  action: 'add' | 'remove' | 'patch';
  id?: string;      // required for remove/patch; forbidden for add
  tempId?: string;  // add only; see §3.3
  values?: object;  // add: the new row. patch: ONLY the changed fields.
};
```

| action | `id` | `values` | Meaning |
|---|---|---|---|
| `add` | forbidden | the new row | Create a row. The app assigns the real `id`. |
| `remove` | required | forbidden | Delete the named row. |
| `patch` | required | changed fields only | Merge `values` into the named row. |

**`patch` is a merge, not a replace.** Omitted fields are untouched. This is the
whole point: "all wedges to IEMs" is four patches carrying one field each, not
four rows rewritten from memory.

**`values` is deliberately field-agnostic** — any field of the target entity.
Enumerating patchable fields per entity would be a second schema to keep in sync
with `lib/types.ts`, and drift between the two is precisely the class of defect
this project keeps producing. Validation (§5) checks references and identity, not
field names; an unknown field is dropped with a warning rather than refused.

### 3.3 ★ Intra-batch references — the hole a naive contract leaves

"Add two new background singers" needs a `stagePlot` row **and** `inputs` rows,
and `InputChannel.slotId` must point at the slot being created **in the same
batch** — which has no `id` yet, because the app assigns ids on apply.

**Spec: `tempId`.** An `add` may carry a `tempId`, a caller-chosen string
prefixed `new:`. Other ops in the same batch may use that string anywhere a real
id is expected. On apply, each `tempId` is resolved to the minted real id before
any row is written.

```jsonc
[
  { "entity": "stagePlot", "action": "add", "tempId": "new:alicia",
    "values": { "name": "Alicia", "pos": "DSL", "role": "BGV", "mix": 3 } },
  { "entity": "inputs", "action": "add",
    "values": { "inst": "Alicia Vox", "mic": "SM58", "stand": "Tall boom",
                "slotId": "new:alicia" } }
]
```

Rules:
- A `tempId` **must** start with `new:`. Anything else is refused — this is what
  prevents a model-invented id from colliding with a real one.
- A `tempId` must be unique within the batch.
- A reference to a `new:` string with no matching `tempId` is refused (O3).
- `tempId` never reaches storage.

> **Rejected alternative: nested creates** (a slot op carrying its inputs
> inline). It makes the op list non-uniform — some rows appear as ops, others
> hide inside other ops — so both validation and the approve-card diff need two
> code paths for the same concept. `tempId` keeps every created row visible as
> its own op.

> **Rejected alternative: positional references** (`slotRef: {opIndex: 0}`).
> Correct but brittle: the meaning of every reference changes if the model
> reorders its own ops, and reordering is exactly the kind of harmless-looking
> variation a model produces.

### 3.4 ★★ One of Graham's headline use cases cannot be expressed today

**Verified against `lib/types.ts`, not assumed:**

```ts
export interface MonitorMix { id?: string; mix: number; name: string; needs: string; }
```

**There is no monitor `type` field.** `grep -ri "wedge|iem|in-ear"` over `lib`,
`components`, and `app` returns only free-text band notes and one unrelated
comment. So of the three bulk changes Graham named:

| Bulk change | Field | Expressible today? |
|---|---|---|
| wired mics → wireless | `InputChannel.mic` | ✅ |
| straight stands → boom | `InputChannel.stand` | ✅ |
| **all wedges → IEMs** | — | ❌ **no such field** |

The monitor-type case would require adding `MonitorMix.type` — a schema change
touching the mix editor, print/PDF, YAML import/export, and console export. That
is real scope Graham has not seen and has not ruled on.

**Disposition: OUT OF SCOPE here, and called out rather than quietly dropped.**
The op contract is field-agnostic (§3.2), so it will handle `type` the day the
field exists — no change to this design. **This is an open question for Graham
(§12 Q1).**

**Lesson, recorded because it is the second instance in two weeks:** speccing the
fix is what revealed that one of the two motivating use cases has no data model
behind it. An audit of the AI path would never have surfaced it.

### 3.5 What `add` may omit

`InputChannel.ch` is required by the type but is a **positional** value the user
should not have to dictate. If an `add` on `inputs` omits `ch`, the app assigns
`max(existing ch) + 1`. Same for `MonitorMix.mix`. A model-supplied value is
honoured unless it collides (§5.2).

---

## §4 Ambiguity is a first-class case

**Graham, 2026-08-20:**

> "on 'c' i think we also need to think about whether 'add 2 bgv' is for existing
> players or net new players... it might be 1 net new background singer, plus add
> a bgv mic for the bass player (existing)."

**"Add two BGVs" is three different requests** and the words do not distinguish
them:

| Reading | Ops |
|---|---|
| Two net-new singers | 2 `stagePlot` adds + 2 `inputs` adds (with `tempId`s) |
| One new singer, one existing player also sings | 1 slot add + 2 input adds, one carrying an **existing** `slotId` |
| Two existing players gain vocal mics | 2 `inputs` adds, **0** slot adds |

**Two consequences, and the second is the load-bearing one:**

**4.1 `inputs`↔`stagePlot` is many-to-one.** A performer already on the plot who
gains a vocal mic needs **one new input carrying their existing `slotId`** — and
**must not** get a second stage slot. A duplicate performer is the failure mode
to guard against, and it is a plausible one: "add a BGV" reads like "add a
person."

**4.2 The correct answer to an ambiguous request is a question.** The system
prompt already says *"Ask clarifying questions only when genuinely ambiguous"* —
this is that case, and it is cheaper than any amount of undo machinery. The
prompt gains an explicit rule:

> If the request is ambiguous about **which existing rows** it affects, or about
> whether a person is new or already on the stage plot, ask before emitting ops.
> A wrong guess costs the user more than a question does.

`tool_choice` stays `auto` — forcing a tool call would make O5 unenforceable by
construction.

**★ This is a testable behaviour, and §10 tests it as a first-class case: a
confident tool call on an ambiguous ask is a defect, not a success.**

---

## §5 Validation, refusal, and recovery

### 5.1 One pure function

```ts
planChanges(config: AppConfig, ops: Op[]):
  | { ok: true;  next: AppConfig; summary: ChangeSummary }
  | { ok: false; problems: Problem[] }
```

Pure, total, no I/O. This is deliberate: the apply path today lives inside a
6,700-line client component and is effectively untestable, which is why the
existing cascade defect survived four audits. Everything decidable moves into
`lib/`.

### 5.2 Rules

Evaluated against the **post-batch** config, not the current one — a plan that
removes a monitor and re-points its performers in the same batch is valid, and a
rule evaluated against the pre-batch state would wrongly refuse it.

| Rule | Refuses |
|---|---|
| Identity | `remove`/`patch` naming an id that does not exist (O2); `add` carrying an `id`; `patch` with empty `values` |
| Temp ids | `tempId` without the `new:` prefix; duplicate `tempId`; a `new:` reference with no matching `tempId` |
| Links | `slotId` that resolves to neither an existing slot nor a batch-created one (O3) |
| Mixes | `stagePlot.mix` pointing at a monitor absent after the batch; duplicate `mix` numbers; non-positive `mix` |
| Channels | duplicate `ch` after the batch |

Unknown fields in `values` are **dropped with a warning**, not refused — a
refusal there would turn a harmless model quirk into a dead end.

### 5.3 Refusal is a state, and the card must say what to do

A refused plan: **config unchanged**, the proposal **stays in the transcript**,
the card shows the reason **and the recovery**, and **Apply is removed, not
disabled** — a disabled button invites re-clicking something that can never
succeed. **No auto-retry.**

> *"This plan would leave 2 performers pointing at Mix 3, which it removes. Ask
> again, or move those performers first."*

### 5.4 ★★ The `'refused'` status breaks API history — and it is the OPPOSITE bug the tier-1 doc predicted

`design-core-path-tier1.md` §2.4 warns that `'refused'` must count as **resolved**
in `hasPendingTools` or the composer locks. **Read against the code, that warning
is already satisfied and the real bug is elsewhere:**

```ts
// lib/agent-history.ts
export function hasPendingTools(messages) {
  return messages.some((m) => m.toolCalls?.some((tc) => tc.status === 'pending'));
}
```

`hasPendingTools` tests `=== 'pending'`, so **any** new status counts as resolved
by construction. The composer does not lock.

**But `buildApiMessages` emits a `tool_result` only for `'applied'` and
`'rejected'`:**

```ts
if (tc.status === 'applied')       { /* push tool_result */ }
else if (tc.status === 'rejected') { /* push tool_result, is_error */ }
// 'refused' → NOTHING IS PUSHED
```

A `'refused'` call therefore leaves an assistant `tool_use` block with **no
matching `tool_result`**, and the Anthropic API rejects any subsequent request in
that conversation. **The next message the user sends fails outright** — a harder
failure than the locked composer the doc anticipated.

⇒ `buildApiMessages` **must** emit a result for `'refused'`, carrying the real
cause:

> `Refused: this plan would leave 2 performers pointing at a mix it removes. Nothing was applied.`

**The reason it cannot reuse `'rejected'` still stands** and is worth restating:
`'rejected'` sends **"Rejected by user."** with `is_error: true`. Reusing it would
tell the model *the user declined this change* when the truth is *the app refused
it as malformed* — so the next turn the model has no idea what was wrong and
every reason to think the user simply did not want it. **A lie to the model is a
silent failure with extra steps.**

---

## §6 Atomicity

One call → one `planChanges` → one approve card → all ops or none. `planChanges`
returns a complete next-config; the apply path swaps it in through the §2.3
normalizer (`withStableIds`) and writes once. There is no partial-apply path to
get wrong, and no cross-call coordination to design.

---

## §7 The approve card becomes a diff

`ToolCallPreview` today renders whole lists, because a whole list is what the
tools send. Ops are not lists, and rendering raw ops is worse than useless to a
performer.

The card renders `ChangeSummary` in plain language, grouped by entity:

```
Stage plot   − Priya (Guitar 2)
Inputs       − ch 6 Guitar 2
             + Alicia Vox — SM58, tall boom  → Alicia
Monitors     ~ Mix 1, Mix 2, Mix 3, Mix 4    type → IEM
```

Counts, not just rows, when a change is large (`~ 14 inputs — mic changed`).
`ChangeSummary` comes from `planChanges`, so it is pure and testable, and it
cannot drift from what apply actually does — it is computed by the same function.

---

## §8 ★ Model-robustness is a design criterion, not a model choice

**Graham, 2026-08-20:**

> "We don't WANT to be wed to a single model version. Shouldn't this be easy/
> flexible enough to change?"

**He is right, and the code already disagrees with him.** `lib/agent-key.ts:14-15`
hardcodes the model twice:

```ts
export const TRYIT_MODEL = 'claude-sonnet-4-6';
export const BYOA_MODEL  = 'claude-sonnet-4-6';
```

**The mechanism to fix this already exists and is already imported into that very
file.** `lib/agent-key.ts:1` imports `readAdminConfig` from `lib/admin-config.ts`
— a generic keyed store with Redis + env fallback (`{value, source:'redis'|'env'}`),
a `setAdminConfig` setter, and an existing `/admin` surface. Making the model a
config key is a value edit with **no deploy**, and it satisfies the standing
no-hardcoding rule the constants currently violate.

**The design consequence is larger than the config change.** If the model is a
config value — and under BYOA it is effectively whatever we point it at — then:

> **The contract must be drivable by the weakest model we would plausibly ship,
> not the strongest one available.**

A contract only a frontier model can drive is a fragile contract: it breaks on a
config edit, and it breaks differently for different users. This is why §3 keeps
the op vocabulary small (3 entities × 3 actions, one tool), rejects a predicate
query language, and makes `values` a plain object. Every one of those choices
trades expressive power for the odds that a mid-tier model gets it right.

**The spike (§10.1) therefore measures the contract, not the model.** Its
question is not "which model wins" but "does this work on the model that ships
today." Running three models is a diagnostic: if the shipping model fumbles and
the next tier up does not, the cheapest fix is a config change — and that is a
finding we would miss by testing one model.

---

## §9 Relationship to `design-core-path-tier1.md` §2

### 9.1 What this supersedes

| Tier-1 § | Was | Now |
|---|---|---|
| §2.1 identity in tool schemas | Teach the model to echo `id`s on whole-list writes | **Superseded.** Ops carry ids inherently; nothing to echo. |
| §2.2 conditional cascade removal | Suppress the cascade when the show has content | **Superseded.** No cascade — the model emits the ops it wants. See 9.4. |
| §2.4 `summarizeApplyImpact` warning | Count what an approved plan will destroy | **Superseded.** Unmentioned rows cannot be destroyed (O1), so there is nothing to warn about. `ChangeSummary` (§7) replaces it — describing an intended change, not warning about an unintended one. |

### 9.2 The six existing tools

`update_stage_plot`, `update_inputs`, `update_monitors` become **create-only**:
permitted when the target list is empty, refused when it is not, with the refusal
naming `apply_changes`. That preserves the first-run "describe your band" flow —
the flagship path, and the one thing whole-list replace is genuinely good at —
while closing the destructive edit path.

**`update_setlist` is removed. Graham ruled the AI should not touch the setlist
or charts.** It replaces the whole list; §1.3 (shipped, PR #144) just made song
titles library-owned; charts resolve by normalized title. An AI writing titles
fights work that shipped last week. The setlist has a proper entry point already
(CSV/sheet import).

`update_notes` and `update_show_info` are unaffected — single-value writes with
no identity to lose.

### 9.3 The alternative this design must beat

**Create-first**: the AI generates into empty state and refuses to edit; iteration
is re-prompting. Cheaper than this design by roughly 4 PRs, and it is what we
ship if the spike fails. It loses both of §0's use cases — bulk change and
add/remove — which is the whole argument for spending anything here.

### 9.4 ★ What still ships regardless — do not lose this

**Tier-1 §2.3 — `withStableIds` at the `setConfig(` sites — is NOT superseded and
must ship whatever happens to this document.** It is a **manual-path** bug, with
no AI involved.

**Line numbers re-verified against `main` @ `6fa7328`, because PR #144 shifted
them and the tier-1 doc's citations are now stale** — restating a doc is still
quoting from memory:

| `setConfig(` site | Today | Disposition |
|---|---|---|
| `page.tsx:427` offline cache restore | already `withStableIds` | unchanged |
| `page.tsx:485` fetch load | `cfg`, normalized upstream | unchanged |
| `page.tsx:596` `updateConfig` | `ensureStageSlotIds` only | → `withStableIds` |
| `page.tsx:614` `applyImportMerge` | `ensureStageSlotIds` only | → `withStableIds` |
| `page.tsx:622` `undoImport` | `ensureStageSlotIds` only | → `withStableIds` |

`applyImportMerge` and `undoImport` run `ensureStageSlotIds` alone, so
**CSV/sheet-imported setlist rows land with no `id`** — and the component
dereferences `.id!` in **12 places** (`grep -c '\.id!'`), including `key={song.id!}`
(`:1563`, `:4599`) and `useSortable({ id: song.id! })` (`:4302`, `:4641`), plus the
same pattern for inputs (`:4795`, `:4834`) and monitors (`:4952`, `:4983`).
Broken React keys and dead drag-and-drop. It is a one-line swap per site to a
function that already exists.

**It is also a prerequisite here:** ops address rows by `id`, so every row must
have one before any of this can work.

---

## §10 Test plan

The house rule applies: **a test must distinguish the correct implementation from
the plausible-wrong one.**

### 10.1 The spike — gates everything else

Not a unit test. Real model, real config, no apply layer: does it emit correct,
minimal ops? Seven cases, each naming what a correct answer must **not** do:

| # | Ask | Correct | Plausible-wrong |
|---|---|---|---|
| A | "Strike the second guitar player" | remove `slot-4` + input `in-6` | touching guitar 1; removing the slot but not the input |
| B | "All the wedges to IEMs" | patch `type` on 4 monitors | re-sending `name`/`needs`; touching inputs |
| C1 | "Add two new background singers" | 2 slot adds w/ `tempId` + 2 input adds referencing them | inputs with no `slotId` |
| C2 | "The bass player is also going to sing" | **1 input add** carrying existing `slot-2` | **creating a second stage slot for a performer who already exists** |
| C3 | "Add two BGVs" *(ambiguous)* | **asks which reading** | any confident tool call |
| D | "Beta 91 on the kick instead" | exactly one patch, `in-1.mic` | patching the whole row; touching other drum inputs |
| E | "Separate mixes for the vocalist and each guitarist" | monitor adds + `stagePlot.mix` patches, consistent | leaving a performer on a removed mix |

Run against **the shipping model first** (§8), then a tier up as a diagnostic.
**Case B requires `MonitorMix.type` to exist (§3.4) — until Graham rules on Q1,
substitute a `stand` bulk change, which is expressible today.**

> **★ The current spike script tests a straw-man contract and case C1 is
> unanswerable under it** — it has no `tempId`, so a new input cannot reference a
> new slot, and the model is asked to do something the schema forbids. **Re-point
> the spike at §3 before drawing any conclusion from it.**

### 10.2 `planChanges` — pure, so fully testable

1. `patch` merges: named fields change, **unnamed fields on the same row are byte-identical**. *(Distinguishes merge from replace — the defect this whole design exists to remove.)*
2. A row not named by any op is byte-identical after apply. *(O1, stated as a test.)*
3. `remove`/`patch` on an unknown id refuses; **nothing is applied** — not "the rest applied". *(O2 + O4 together.)*
4. `tempId` resolves: the input's `slotId` equals the real minted slot id, and no `new:` string survives into the config.
5. A `new:` reference with no matching `tempId` refuses.
6. A batch that removes a monitor **and** re-points its performers is **accepted** — the post-batch rule (§5.2). *(Distinguishes post-batch evaluation from pre-batch, which would wrongly refuse this.)*
7. A batch that removes a monitor and leaves performers on it refuses, and the message names the count.
8. `add` on `inputs` omitting `ch` assigns `max+1`; a colliding explicit `ch` refuses.
9. An unknown field in `values` is dropped and warned — **not** refused.
10. `ChangeSummary` counts match what apply actually changed. *(Pins §7 to §6 — the summary cannot drift from the apply, because a divergence is a lie on the approve card.)*

### 10.3 History (§5.4)

11. A `'refused'` call produces a `tool_result` in `buildApiMessages`. *(Without this the next request 400s — the actual bug, not the predicted one.)*
12. That result is **not** `"Rejected by user."` and is distinguishable from a user rejection.
13. `hasPendingTools` is false with a `'refused'` call present. *(Pins the behaviour the tier-1 doc worried about, which the code already satisfies — a regression guard, not a fix.)*

### 10.4 Create-only guard (§9.2)

14. `update_inputs` on an empty list applies; on a populated list refuses, naming `apply_changes`.
15. First-run "describe your band" still produces a full plot + inputs + monitors. *(The flagship flow must not regress — this is the one thing whole-list replace was good at.)*

---

## §11 Out of scope

- **`MonitorMix.type`** (§3.4) — a schema change, Graham's call (Q1).
- **Predicate ops** (`where mic = 'wedge'`) — a query language; large surface, small gain over enumerate-and-touch, and worse under §8's weakest-model criterion.
- **Undo of an applied plan.** Approve is the gate. Ops are small and legible (§7), which is what makes that acceptable.
- **AI editing charts or the setlist** (§9.2) — ruled out.
- **Migration of existing shows.** Graham ruled production data needs no repair; ops are additive to the existing config shape.

---

## §12 Open questions for Graham

**Q1. `MonitorMix.type` — add it, or drop "wedges → IEMs" from v1?** (§3.4)
It is one of the two bulk changes he named, and it has no field today. Adding it
touches the mix editor, print/PDF, YAML import/export, and console export. The
other two bulk changes (mics, stands) work as-is.

**Q2. Should the model be a config key now, or later?** (§8) The plumbing exists
and is already imported. It is a small change that removes a deploy from every
future model move — but it is scope beyond this document.

**Q3. Create-only guard: refuse, or offer "replace everything"?** (§9.2) When a
user asks the AI to regenerate a show that already has content, is the right
answer a refusal that names `apply_changes`, or a confirm-and-replace? This is a
product call, not a technical one.
