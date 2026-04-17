#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server } from "./server.js";
// Phase 2/3/5 tool modules self-register on import:
// import "./tools/rename-symbol.js";
// import "./tools/find-references.js";
// import "./tools/rename-file.js";
const transport = new StdioServerTransport();
await server.connect(transport);
//# sourceMappingURL=bin.js.map