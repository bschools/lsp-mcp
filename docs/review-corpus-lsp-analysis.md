# What PersonaMind's review corpus says lsp-mcp should do

Analysis of 151 archived plan records in `PersonaMind/docs/archive/plans` — 133
with `reviewHistory` (strategic + tactical), 117 with `codeReview` — against
what an LSP-backed tool could actually answer.

Date of analysis: 2026-08-12.

---

## 1. The bug that matters today

`find_references` under-reports on PersonaMind, silently. Same symbol, same
position, cold server:

| Call | Files returned |
| --- | --- |
| Cold — `planSubtreeDigest` @ `libs/backlog/src/gate-admission/gate-admission.core.ts:194` | **5** |
| Same query after one unrelated `hover` | **10** |

Missed on the cold call — all real import + call sites, not comment mentions:

- `libs/backlog/src/gate-mark/gate-mark.core.ts`
- `scripts/plans/gate-reconcile.cli.ts`
- `scripts/plans/lib/plan-review-pipeline-runner-impl.ts`
- `scripts/plans/migrate-gate-admission.cli.ts`

Recall on the cold call: 5 of 9 real files. No error, no partial marker.

This matters beyond the review pipeline: PersonaMind's `CLAUDE.md` prescribes
`find_references` as the blast-radius fallback whenever the call graph is stale
or a symbol is missing from it. A silent 56%-recall answer to "who calls this"
is worse than no answer.

### Root cause

`typescript-language-server` loads each configured project lazily and in the
background, and answers semantic requests from whatever slice of the project
graph exists at that moment.

PersonaMind's root `tsconfig.json` is solution-style — `files: []` plus three
references (`tsconfig.libs.json`, `tsconfig.server.json`,
`tsconfig.scripts.json`) — so no single project owns the tree.

Measured convergence, warmup cap varied via `LSP_MCP_WARMUP_MAX_FILES`:

| Warmup files opened | Recall at first query | Converges |
| --- | --- | --- |
| 0 | 1/8 | ~15 s |
| 500 (the old default) | 4/8 | ~23 s |
| 3000 (all 2063 TS files) | — | request hit the 30 s timeout |

Two findings there. First, the eager warmup never fixed recall — it *delayed*
convergence, because 500 queued open commands sit ahead of the real work.
Second, the cap was load-bearing by accident: raising it to cover the whole
repo breaks the first request outright.

The 500-file walk was aimed at the wrong axis. What makes a project's files
findable is that the *project* is loaded; 500 files drawn from three projects
load exactly the same three projects that three files would.

### Fix

Two changes, both in `src/lsp/`:

1. **Warmup opens one file per configured project** (`src/workspace/projects.ts`)
   — walk `references` recursively plus any nested `tsconfig.json`, resolve each
   project's `include`/`files` to one representative source file, open those.
2. **Semantic requests wait for a quiescent project graph** (`runStable` in
   `src/lsp/lifecycle.ts`). tsserver does announce this work —
   `projectLoadingStart`/`projectLoadingFinish` surface as `$/progress`
   begin/end — but only if the client advertises `window.workDoneProgress`
   *and* answers the server's `window/workDoneProgress/create` request. The
   client did neither; server→client requests were dropped on the floor in
   `LspClient.dispatch`, so the progress reporter never began.

Measured on PersonaMind through the shipped path — `discoverProjectRepresentatives`
picks nine representatives across `libs`, `apps/server`, `apps/hooks`,
`apps/web`, `scripts` and `.config`:

Ground truth for the probe symbol is 9 files that reference it in code (comment
mentions excluded); the 8-entry expectation set below drops the declaration's
own spec files, which both runs agree on.

| | referencing files found | cold latency |
| --- | --- | --- |
| Before | 5 of 9, no error | 4.6 s |
| After | **9 of 9, three consecutive runs** | 20–30 s |

The write path was checked the same way: `textDocument/rename` on that symbol
returns a `WorkspaceEdit` covering 11 files — all 9, plus the two spec files
that reference it. A rename computed against a half-loaded graph would have
rewritten a subset and left the rest dangling, which is the failure
`verify/lingering-refs.ts` exists to catch after the fact.

The gate applies to `find_references`, `rename_symbol`, `rename_file`,
`go_to_definition`, `move_function` and `get_diagnostics`. Cold latency is the
price of loading every project up front; it is paid once per workspace
lifecycle (the client is cached with a 5-minute idle eviction), and it buys a
correct answer in place of a silently truncated one.

Neither change alone is sufficient, and this was measured both ways:

- Readiness gate alone (BFS warmup retained): 1/8. Progress quiescence marks
  "the projects tsserver knows about are loaded", not "every project is
  loaded".
- Project representatives alone (no `window.workDoneProgress`): 1/8 in 0.9 s —
  the reps trigger the loads, and the query races straight past them.

### One regression the fix surfaced

Dropping the eager 500-file open exposed a latent tsserver failure that the
old warmup had been masking: a position request issued against a document
tsserver has taken up but whose text it does not yet hold fails with
`Debug Failure. False expression.` out of `computePositionOfLineAndCharacter`.
`rename_symbol` had carried a hand-rolled evict-and-retry for this for as long
as it has existed; `runStable` now absorbs it centrally, resending the document
(`didChange`) before each retry.

---

## 2. What the review corpus asks for

4658 adjustments across 133 plans. `classId` is populated only on tactical
deterministic steps (1020 findings). The symbol/reference-shaped classes:

| classId | count | data source today |
| --- | --- | --- |
| `R6.stale_references` | 207 | `existsSync` on regex-scraped paths |
| `R1.path_symbol_existence` | 167 | `spawnSync("grep", ["-F", symbol, file])` |
| `R4.blast_radius` | 164 | `.claude/jit/call-graph.json` |
| `R2.consumer_coverage` | 30 | call graph |
| `R2.caller_coverage` | 21 | call graph |

**Staleness is the ROI argument, not false positives.** `call-graph.json` was
last built 2026-07-19 — 24 days before this analysis. `code-index.json`,
2026-08-04. Both back R1 symbol-overlap, R2 caller/consumer coverage and the R4
signature cascade. When the artifact is missing, `callGraphAvailable: false`
disables the check silently and it returns `[]`. A live LSP has no staleness
axis.

---

## 3. What LSP cannot fix — stated plainly

**The 188 `path::Symbol` false-positive suppressions are not a data-source
problem.** Of 419 `falsePositiveClaimRefs` across 35 plans, 188 are of the form
`path::Symbol`, and the sampled ones are all the same shape:
`MessageService.sendMessage`, `.queryStateSnapshot`, `.queryPsychologyTrace` —
"method not modified; signature unchanged." The cause is
`extractCallgraphCoverageFindings` iterating *every* call-graph node whose
`filePath` appears in the modify set, ignoring the symbol the row actually
names. LSP returns the same "this method has callers" answer. Fix belongs in
`cross-checks.core.ts`.

**`R6.stale_references` — the largest class — is not LSP work.** It is
`existsSync` on regex-extracted paths. The sampled false positive
(`libs/number/src/jsonl.util`) is an extensionless TS module path; the fix is
TypeScript module resolution or extension candidates in the existing CLI.

**Code review has almost no LSP surface.** Of 485 `codeReview` items: 244
uncategorized judgment, 99 test-coverage, 97 naming/documentation, 32 error
handling — against 6 dead-export, 5 dangling-reference and 1 type-safety.
`get_diagnostics` already exists and would earn roughly 2% of that corpus.

**Strategic review has none.** No `classId` is recorded at all; the findings are
design arguments — regex coverage tradeoffs, non-goal framing, whether the thing
is worth building.

---

## 4. Two structural blockers before the pipeline can consume any of this

1. **Query shape.** Every lsp-mcp tool takes `filePath + line + column`. The
   review pipeline's query is `(path, symbolName)` — a backtick-scraped string
   with no position. Using LSP for R1 today would mean grepping to find the
   position first, which defeats the point. The missing primitive is
   `textDocument/documentSymbol`: file in, declared symbols out, no position
   needed. It also only requires `ensureFile` on one file.
2. **Transport.** lsp-mcp speaks MCP over stdio. `scripts/plans/cross-checks.ts`
   is a Node CLI and cannot call it. A library export or a `lsp-mcp query`
   entrypoint is required regardless of which check migrates — and a persistent
   daemon if it is to run per-plan, since each spawn pays project-load cost.

---

## 5. Ranked

1. ~~Fix reference recall.~~ Done — see §1. Pays off immediately for
   agent-facing `find_references` and `rename_symbol`, independent of any
   pipeline work.
2. Add `document_symbols` — the only primitive that makes
   `R1.path_symbol_existence` LSP-answerable.
3. Library/CLI entrypoint plus a persistent daemon, without which (2) is
   unusable from `cross-checks.ts`.
4. Only then, migrate the call-graph-backed R4/R2 checks to live references.
   Gated on (1): an under-reporting reference oracle would have been worse than
   a stale call graph.
