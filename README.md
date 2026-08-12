# lsp-mcp

An MCP server that exposes LSP refactoring operations as Claude Code tools.

## Tools

| Tool | Description |
|------|-------------|
| `rename_symbol` | Rename a symbol project-wide (class, method, variable, parameter) |
| `find_references` | Find all references to a symbol across the workspace |
| `rename_file` | Rename a file and update all import specifiers |
| `extract_function` | Extract a code block into a named function (v0.2) |
| `move_function` | Move a function to a different file (v0.2, experimental) |

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
| `LSP_MCP_LOG_DIR` | `os.tmpdir()` | Directory for crash logs (Debug Failure captures) |
| `LSP_MCP_PROJECT_SETTLE_MS` | `500` | Idle window with no project load in flight before a semantic request is allowed through |
| `LSP_MCP_PROJECT_LOAD_TIMEOUT_MS` | `60000` | Ceiling on waiting for project load; the request is issued anyway on timeout |
| `LSP_MCP_WARMUP_MAX_FILES` | `500` | Safety cap on warmup opens (one file per configured project, so single digits in practice) |

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

## Parameter indexing

All `line` and `column` parameters are **0-indexed**, matching LSP protocol conventions.

## License

MIT — see [LICENSE](./LICENSE).

## Legal

This is a clean-room implementation. See [CLEANROOM.md](./CLEANROOM.md).
