# Clean-Room Implementation Statement

This repository (`@benmar/lsp-mcp`) is an independent, clean-room implementation of
an LSP↔MCP bridge server. It was written from first principles against two public
specifications only:

- **LSP 3.17** — https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
- **MCP** — https://modelcontextprotocol.io/ (via `@modelcontextprotocol/sdk`)

## What this means

- No source files from any existing LSP-MCP implementation were opened, read, or referenced during development.
- No git history, patches, or diffs from any prior fork were applied.
- Tool names and parameter names match the consumer-visible interface of the existing `lsp-refactoring` MCP server (functional interface, not copyrightable).
- All code is original and licensed MIT from the first commit.

## For contributors

If you are contributing to this repository, you must not introduce code derived from
unlicensed or incompatibly-licensed sources. When in doubt, implement from the LSP and
MCP specifications directly.
