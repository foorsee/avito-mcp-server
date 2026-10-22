#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchAvito, getItemDetails, downloadItemImages, sendMessage, getChatHistory, listChats, closeBrowser } from "./avito_core.mjs";

const log = (...args) => console.error("[avito-mcp]", ...args);

// On macOS, GUI apps (like Claude Desktop / Cursor / Gemini Desktop) don't inherit /opt/homebrew/bin in PATH
if (process.platform === "darwin") {
  const extraPaths = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/homebrew/sbin"];
  const currentPath = process.env.PATH || "";
  const missing = extraPaths.filter((p) => !currentPath.includes(p));
  if (missing.length > 0) {
    process.env.PATH = missing.join(":") + ":" + currentPath;
  }
}

const server = new McpServer({
  name: "avito-mcp-server",
  version: "1.1.0"
});

function wrapTool(name, fn) {
  return async (args) => {
    try {
      const res = await fn(args);
      return {
        content: [{ type: "text", text: JSON.stringify(res, null, 2) }]
      };
    } catch (err) {
      log(`${name} error:`, err?.message);
      return {
        content: [{ type: "text", text: `Error: ${err?.message || String(err)}` }],
        isError: true
      };
    }
  };
}

server.registerTool(
  "avito_search",
  {
    title: "Search Avito listings",
    description: "Search for listings on Avito by query, location, price range and sort order.",
    inputSchema: {
      query: z.string().describe("Search query, e.g. 'iphone 15 pro', 'rtx 4070'"),
      location: z.string().default("all").describe("City or region, e.g. 'moskva', 'sankt-peterburg', 'all'"),
      price_min: z.number().int().nonnegative().optional().describe("Minimum price in RUB"),
      price_max: z.number().int().nonnegative().optional().describe("Maximum price in RUB"),
      sort: z.enum(["default", "price_asc", "price_desc", "date"]).default("default").describe("Sort order"),
      limit: z.number().int().min(1).max(30).default(10).describe("Max results to return")
    }
  },
  wrapTool("avito_search", searchAvito)
);

server.registerTool(
  "avito_get_item_details",
  {
    title: "Get Avito item details",
    description: "Get full details of an Avito listing: title, price, description, seller rating/reviews, parameters, delivery status and messaging capability.",
    inputSchema: {
      url: z.string().describe("Full URL of the listing or item ID")
    }
  },
  wrapTool("avito_get_item_details", getItemDetails)
);

server.registerTool(
  "avito_send_message",
  {
    title: "Send message to Avito seller",
    description: "Send a message to a seller on Avito to negotiate or ask questions. Requires prior login via npm run login.",
    inputSchema: {
      url: z.string().describe("Item URL or direct chat URL"),
      message: z.string().describe("Text of the message to send")
    }
  },
  wrapTool("avito_send_message", sendMessage)
);

server.registerTool(
  "avito_list_chats",
  {
    title: "List Avito messenger chats",
    description: "List recent chats from the user's Avito messenger. Requires prior login.",
    inputSchema: {
      limit: z.number().int().min(1).max(20).default(10).describe("Max chats to return")
    }
  },
  wrapTool("avito_list_chats", listChats)
);

server.registerTool(
  "avito_get_chat_history",
  {
    title: "Get chat messages with Avito seller",
    description: "Read message history in an active Avito chat to check seller responses.",
    inputSchema: {
      chat_url: z.string().optional().describe("URL of the specific chat or empty for active chat"),
      limit: z.number().int().min(1).max(30).default(15).describe("Max messages to return")
    }
  },
  wrapTool("avito_get_chat_history", getChatHistory)
);

server.registerTool(
  "avito_download_images",
  {
    title: "Download Avito listing photos",
    description: "Download photos from an Avito listing to local disk for visual AI inspection. Returns array of local file paths and image URLs.",
    inputSchema: {
      url: z.string().describe("Item URL or item ID"),
      limit: z.number().int().min(1).max(10).default(5).describe("Max photos to download (default 5)")
    }
  },
  wrapTool("avito_download_images", downloadItemImages)
);


let shuttingDown = false;
async function cleanup(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("server shutting down, closing browser...");
  await closeBrowser().catch(() => {});
  process.exit(exitCode);
}

process.on("SIGINT", () => cleanup(0));
process.on("SIGTERM", () => cleanup(0));
process.on("uncaughtException", (err) => {
  log("uncaughtException:", err);
  cleanup(1);
});

// Stdio pipe disconnection handling: when host process closes stdin, shut down browser cleanly
process.stdin.on("end", () => cleanup(0));
process.stdin.on("close", () => cleanup(0));

const transport = new StdioServerTransport();
transport.onclose = () => cleanup(0);
await server.connect(transport);
log("avito-mcp-server ready on stdio");
