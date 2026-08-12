# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
yarn build          # compile TypeScript → dist/
yarn dev            # watch mode
yarn test           # run all tests (vitest)
yarn test:watch     # vitest in watch mode
yarn typecheck      # type-check without emit
yarn lint           # eslint src test
```

Run a single test file:
```bash
yarn test test/unit/framing.test.ts
```

Run integration tests (requires `typescript-language-server` globally installed):
```bash
yarn test test/integration/
```

The regression corpus (`test/regression/corpus.test.ts`) is skipped by default. To run it, set `OLD_LSP_MCP=/path/to/old/dist/index.js`.

## Architecture

This is an **MCP server** (`@modelcontextprotocol/sdk`) that bridges to a **TypeScript Language Server** (`typescript-language-server --stdio`) process, exposing LSP refactoring operations as Claude Code tools.

### Layers (top → bottom)

1. **`src/bin.ts`** — entry point. Imports tool modules (side-effects register them), connects MCP server to stdio transport.

2. **`src/server.ts`** — singleton `McpServer` instance. All tools register against it via `server.registerTool(...)`.

3. **`src/tools/`** — one file per MCP tool. Each file calls `getOrCreateClient(workspaceRoot)` to get an `LspLifecycle`, sends LSP requests, applies the resulting `WorkspaceEdit` to disk, and returns JSON to the MCP caller. Tools currently registered in `bin.ts`: `rename_symbol`, `find_references`, `rename_file`. `extract_function` and `move_function` are scaffolded but not yet wired in `bin.ts`.

4. **`src/lsp/factory.ts`** — per-workspace `LspLifecycle` cache with idle eviction (default 5 min). `getOrCreateClient(workspaceRoot)` returns a cached or freshly-initialized lifecycle; `evictClient()` kills and removes it.

5. **`src/lsp/lifecycle.ts`** — spawns `typescript-language-server --stdio`, performs LSP `initialize`/`initialized` handshake, warms up by opening one file per configured project, and manages `didOpen`/`didChange`/`didClose` notifications. Also tracks project-load readiness: it advertises `window.workDoneProgress`, answers the server's `window/workDoneProgress/create` request, and exposes `waitForProjectLoad()` / `runStable()` so semantic requests never run against a half-loaded project graph. Stderr is piped to a log file in `LSP_MCP_LOG_DIR` (default `os.tmpdir()`).

6. **`src/lsp/client.ts`** — low-level JSON-RPC client over the child process's stdio. Tracks pending requests by ID, dispatches responses/notifications, enforces `LSP_MCP_REQUEST_TIMEOUT_MS` (default 30 s).

7. **`src/lsp/framing.ts`** — LSP wire framing: `encodeMessage()` writes `Content-Length` headers; `FrameParser` parses incoming byte stream into messages.

8. **`src/workspace/detect.ts`** — walks up from a file path to find the workspace root (prefers `tsconfig.json` with `compilerOptions`, then `jsconfig.json`, then `package.json`).

8b. **`src/workspace/projects.ts`** — resolves the workspace's tsconfig graph (recursive `references`, plus nested `tsconfig.json` files) and picks one representative source file per configured project. Warmup opens exactly these: what makes a project's files findable is that the project is loaded, so N arbitrary files from the same project buy nothing.

9. **`src/workspace/edit-apply.ts`** — applies an LSP `WorkspaceEdit` (both `documentChanges` and legacy `changes` formats) to the filesystem using atomic write (tmp → rename).

10. **`src/verify/lingering-refs.ts`** — post-rename verification pass: text-searches for the old symbol name in workspace files to surface any references the LSP missed.

### Test fixtures

`test/fixtures/ts-sample/` is a minimal TypeScript project used by integration and regression tests. Tests copy it to a temp directory so edits don't pollute the source tree.

## Key constraints

- All `line`/`column` parameters are **0-indexed** (LSP convention).
- This is a clean-room implementation written against the LSP 3.17 spec and MCP spec only. Do not introduce code derived from other LSP-MCP implementations (see `CLEANROOM.md`).
- `extract_function` and `move_function` are experimental stubs — not wired into `bin.ts` yet.
