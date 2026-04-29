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

## Parameter indexing

All `line` and `column` parameters are **0-indexed**, matching LSP protocol conventions.

## License

MIT — see [LICENSE](./LICENSE).

## Legal

This is a clean-room implementation. See [CLEANROOM.md](./CLEANROOM.md).
