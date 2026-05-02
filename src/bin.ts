#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { server } from "./server.js";

import "./tools/rename-symbol.js";
import "./tools/find-references.js";
import "./tools/rename-file.js";
import "./tools/extract-function.js";
import "./tools/move-function.js";
import "./tools/get-diagnostics.js";
import "./tools/hover.js";
import "./tools/go-to-definition.js";

const transport = new StdioServerTransport();
await server.connect(transport);
