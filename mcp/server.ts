/**
 * MCP server entry point (spec 033) — `npm run mcp`. Like workers/index.ts,
 * this is a process shell: it resolves the actor once, adapts the registry
 * in lib/mcp/tools.ts onto the stdio transport, and contains no logic of
 * its own. One operator identity per process; see lib/mcp/context.ts.
 */
import * as dotenv from "dotenv";
dotenv.config();

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { z } from "zod";
import { log } from "@/lib/logger";
import { resolveMcpActor, McpActorError } from "@/lib/mcp/context";
import { MCP_TOOLS, invokeTool } from "@/lib/mcp/tools";

async function main(): Promise<void> {
  const actor = await resolveMcpActor();

  const server = new McpServer({ name: "avos-visibility", version: "0.1.0" });

  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // The SDK takes the raw shape for discovery; execution goes back
        // through invokeTool so the strict schema stays the authority.
        inputSchema: (tool.schema as z.AnyZodObject).shape,
      },
      async (args: Record<string, unknown>) => {
        const result = await invokeTool(actor, tool.name, args);
        if (result.ok) {
          return {
            content: [
              { type: "text" as const, text: JSON.stringify(result.data, null, 2) },
            ],
          };
        }
        return {
          isError: true,
          content: [
            {
              type: "text" as const,
              text: `${result.error.kind}: ${result.error.message}`,
            },
          ],
        };
      }
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout is the protocol channel — operational logs go to stderr.
  console.error(
    `avos-visibility MCP server ready (${MCP_TOOLS.length} tools) as ${actor.email} [${actor.role}]`
  );
}

main().catch((err) => {
  if (err instanceof McpActorError) {
    console.error(`refusing to start: ${err.message}`);
  } else {
    log("error", "mcp.start_failed", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  process.exit(1);
});
