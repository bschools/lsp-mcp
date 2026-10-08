# lsp-mcp

An MCP server that exposes LSP refactoring operations as Claude Code tools.

## Tools

| Tool | Description |
|------|-------------|
| `rename_symbol` | Rename a symbol project-wide (class, method, variable, parameter) |
| `find_references` | Find all references to a symbol across the workspace |
| `document_symbols` | List the symbols a file declares — no position needed; optional `name` filter |
| `rename_file` | Rename a file and update all import specifiers |
| `extract_function` | Extract a code range into a named function (refuses on `typescript-language-server`; see [Extract and move](#extract-and-move)) |
| `move_function` | Move a function to a different file (refuses on `typescript-language-server`; see [Extract and move](#extract-and-move)) |

## Installation

### Online (zero-config)

No installation needed. Claude Code will fetch the package automatically:

```json
{
  "mcpServers": {
    "lsp-refactoring": {
      "command": "npx",
      "args": ["-y", "@benmar/lsp-mcp"]
    }
  }
}
```

### Offline / firewalled machines

Install globally first:

```bash
pnpm add -g @benmar/lsp-mcp
```

Then point `.mcp.json` at the installed binary:

```json
{
  "mcpServers": {
    "lsp-refactoring": {
      "command": "lsp-mcp"
    }
  }
}
```

Or use an absolute path:

```json
{
  "mcpServers": {
    "lsp-refactoring": {
      "command": "/home/user/.local/share/pnpm/lsp-mcp"
    }
  }
}
```

## Requirements

- Node.js >= 20
- `typescript-language-server` installed globally: `npm install -g typescript-language-server typescript`

## Configuration

| Env var | Default | Description |
|---------|---------|-------------|
| `LSP_MCP_REQUEST_TIMEOUT_MS` | `30000` | LSP request timeout in ms |
| `LSP_MCP_IDLE_MS` | `300000` | Idle client eviction timeout in ms |
| `LSP_MCP_LOG_DIR` | `os.tmpdir()` | Directory for the tsserver log (`lsp-mcp-tsserver-<timestamp>.log`): server stderr, Debug Failure captures, and one line per incomplete result |
| `LSP_MCP_PROJECT_SETTLE_MS` | `500` | Idle window with no project load in flight before a semantic request is allowed through; also the `retryAfterMs` of an incomplete result |
| `LSP_MCP_PROJECT_LOAD_TIMEOUT_MS` | `60000` | Ceiling on waiting for project load; on timeout the tool returns an incomplete `project_loading` result instead of issuing the request |
| `LSP_MCP_WARMUP_MAX_FILES` | `500` | Safety cap on warmup opens (one file per configured project, so single digits in practice) |
| `LSP_MCP_VERIFY_BUDGET_MS` | `30000` | Time budget for `rename_symbol`'s whole post-edit verification pass |
| `LSP_MCP_VERIFY_MAX_CANDIDATES` | `1000` | Most old-name identifier candidates `rename_symbol` verification will classify; more returns `candidate_budget` |

## Project-load readiness

`typescript-language-server` loads each configured project lazily and answers
semantic requests from whatever slice of the graph is loaded — with no error
and no partial marker. On a large monorepo that means `find_references` can
silently return a subset of the real callers, and `rename_symbol` can rewrite
only the call sites the server happens to know about.

This server avoids that in two ways: warmup opens one file per configured
project (walking `references` and `include` in the workspace's tsconfigs), and
every project-wide request waits for tsserver's project-load progress to go
quiet before it is issued, re-issuing if a load starts mid-flight. Both are
required — either one alone still under-reports.

The cost is a one-time project-load pause on the first request against a
workspace (~20 s on a 2000-file monorepo), paid once per cached client.

## Incomplete results

When the graph cannot be shown to be settled, `find_references`,
`go_to_definition`, `get_diagnostics`, `rename_symbol`, `rename_file`, and
`move_function` return an incomplete result instead of an answer. They never
return a partial or empty answer as if it were complete:

```json
{
  "ok": false,
  "complete": false,
  "code": "project_loading",
  "retryable": true,
  "retryAfterMs": 500,
  "elapsedMs": 60012,
  "attempts": 1,
  "activeProjectLoads": 2,
  "hint": "The project graph is not settled (project_loading). Wait 500ms and retry. ..."
}
```

- `code` is `project_loading` when project load did not go quiet within
  `LSP_MCP_PROJECT_LOAD_TIMEOUT_MS`, or `graph_changing` when a project load
  began during every attempt, so no answer came from one stable graph.
- `retryAfterMs` equals `LSP_MCP_PROJECT_SETTLE_MS`. `elapsedMs`, `attempts`,
  and `activeProjectLoads` describe the wait that failed. The same values are
  written as one `[lsp-mcp] incomplete ...` line to the tsserver log.
- Wait `retryAfterMs` and retry. After three consecutive incomplete responses,
  stop retrying automatically, inspect the tsserver log in `LSP_MCP_LOG_DIR`,
  and treat the result as unavailable until the graph settles.
- `rename_symbol`, `rename_file`, and `move_function` refuse before applying
  any edit, so an incomplete result from them means nothing changed on disk
  (`filesChanged: []`). Every request whose response supplies the applied edit
  runs inside the stable window, including `move_function`'s `codeAction` and
  `codeAction/resolve`.

`get_diagnostics` has a second, separate wait. Its `timeoutMs` (default 5000)
bounds how long it waits for the server's diagnostic notification after the
project settles. When that times out it can still return an empty
`diagnostics` array, and that array does not prove the file has no diagnostics.

## Rename verification

After `rename_symbol` applies its edit, it verifies the rename semantically and
reports the two facts separately:

- `applied: true` means the edits in `filesChanged` are on disk.
- `verified: true` (and `ok: true`) means the verification completed and no old
  name that should have been renamed was left behind.
- `applied: true` with `verified: false` returns `code: "rename_unverified"`
  and a `hint` naming the paths in `lingeringReferences`. The edits are already on disk, so
  review or revert them before retrying.

Verification tokenizes every tracked and non-ignored untracked
TypeScript/JavaScript source and spec file in the workspace, including files
the edit touched. Each identifier spelled like the old name is resolved against
the post-edit graph, and the result lists it in one bucket. Only
`confirmedResiduals` lists each occurrence; the other buckets list one entry
per file:

| Field | Meaning | Affects `verified` |
|-------|---------|--------------------|
| `confirmedResiduals` | The old name no longer binds: a fresh diagnostic at that position reports an unbound name, missing export, or missing typed member | Yes, fails |
| `unclassifiedCandidates` | `{path, count}` per file. Classification could not finish, for example when diagnostics never arrived or a budget ran out | Yes, fails |
| `homonyms` | `{path, count, kinds}` per file. A different declaration that shares the name, including untyped object-literal and matcher keys | No |
| `informationalMentions` | `{path, count, kinds}` per file. Strings, templates, comments (`string`, `template`, `comment`), and untyped member accesses such as `(x as any).oldName` (`untyped`) | No |
| `lingeringReferences` | The sorted unique paths of `confirmedResiduals` and `unclassifiedCandidates` | No |

Grouping makes the response grow with the number of files rather than the
number of occurrences. It is not a size bound: a large enough workspace can
still produce a response over a client's output limit.

Untyped object-literal and matcher keys that name the old property, including
`expect.objectContaining` keys in a spec the rename does not edit, classify as
homonyms. They are not detected as residuals, so `verified: true` does not
cover them.

An empty `lingeringReferences` does not mean no old-name text remains.
`homonyms` and `informationalMentions` are excluded from it, so grep for the
old name after the rename.

An old-named alias to the renamed declaration, such as
`import { newName as oldName }`, is correct and is not listed.

The whole pass is bounded by `LSP_MCP_VERIFY_BUDGET_MS` (30 s) and
`LSP_MCP_VERIFY_MAX_CANDIDATES` (1000). Hitting a limit, or finding the graph
unsettled, returns `verified: false` with `verificationIncomplete.reason` set to
`time_budget`, `candidate_budget`, `project_loading`, or `graph_changing`. The
candidates it did not reach are listed as unclassified. A truncated set is
never reported as verified.

`rename_file` does not verify semantically. Its `lingeringReferences`, which
includes untracked files, is an advisory text match, and `ok: true` does not
mean every import was rewritten.

## Extract and move

`extract_function` takes `filePath`, a 0-indexed range (`startLine`,
`startColumn`, `endLine`, `endColumn`), and `newName`. `move_function` takes
`filePath`, a 0-indexed `line` and `column` on the function, and
`destinationFile`. A file reference alone does not identify an extractable
block: the caller must supply the range.

On `typescript-language-server` both tools refuse without changing any file:
`extract_function` returns `code: "command_execution_unsupported"` and
`move_function` returns `code: "destination_unsupported"`, each with
`filesChanged: []`. PersonaMind's v3 `RequiredTool` therefore cannot require
either tool with this backend yet.

## Parameter indexing

All `line` and `column` parameters are **0-indexed**, matching LSP protocol conventions.

## License

MIT — see [LICENSE](./LICENSE).

## Legal

This is a clean-room implementation. See [CLEANROOM.md](./CLEANROOM.md).
