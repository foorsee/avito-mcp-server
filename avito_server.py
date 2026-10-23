#!/usr/bin/env python3
"""
Model Context Protocol (MCP) server for Avito in Python 3.12+.
Provides tools for searching listings, viewing item details, messaging sellers,
and checking chat history.
"""

import asyncio
import json
import logging
import signal
import sys
from typing import Any, Dict, Literal, Optional

# Support both mcp 2.x (MCPServer) and mcp 1.x (FastMCP)
try:
    from mcp.server.mcpserver import MCPServer
    server = MCPServer(name="avito-mcp-server")
except (ImportError, ModuleNotFoundError):
    from mcp.server.fastmcp import FastMCP
    server = FastMCP("avito-mcp-server")

from avito_core import (
    close_browser,
    get_chat_history,
    get_item_details,
    list_chats,
    search_avito,
    send_message,
)

logging.basicConfig(level=logging.INFO, format="[avito-mcp-py] %(message)s", stream=sys.stderr)
log = logging.getLogger("avito_mcp")


@server.tool(
    name="avito_search",
    description="Search for listings on Avito by query, location, price range and sort order."
)
async def tool_search(
    query: str,
    location: str = "all",
    price_min: Optional[int] = None,
    price_max: Optional[int] = None,
    sort: Literal["default", "price_asc", "price_desc", "date"] = "default",
    limit: int = 10
) -> str:
    """Search for listings on Avito."""
    try:
        res = await search_avito(
            query=query,
            location=location,
            price_min=price_min,
            price_max=price_max,
            sort=sort,
            limit=limit
        )
        return json.dumps(res, ensure_ascii=False, indent=2)
    except Exception as e:
        log.error("avito_search error: %s", e)
        return json.dumps({"error": str(e)}, ensure_ascii=False)


@server.tool(
    name="avito_get_item_details",
    description="Get full details of an Avito listing: title, price, description, seller rating/reviews, parameters, delivery status and messaging capability."
)
async def tool_get_item_details(url: str) -> str:
    """Get full details of an Avito listing."""
    try:
        res = await get_item_details(url=url)
        return json.dumps(res, ensure_ascii=False, indent=2)
    except Exception as e:
        log.error("avito_get_item_details error: %s", e)
        return json.dumps({"error": str(e)}, ensure_ascii=False)


@server.tool(
    name="avito_send_message",
    description="Send a message to an Avito seller to negotiate or ask questions. Requires prior login via login_avito.py."
)
async def tool_send_message(url: str, message: str) -> str:
    """Send a message to an Avito seller."""
    try:
        res = await send_message(url=url, message=message)
        return json.dumps(res, ensure_ascii=False, indent=2)
    except Exception as e:
        log.error("avito_send_message error: %s", e)
        return json.dumps({"error": str(e)}, ensure_ascii=False)


@server.tool(
    name="avito_list_chats",
    description="List recent chats from the user's Avito messenger. Requires prior login."
)
async def tool_list_chats(limit: int = 10) -> str:
    """List recent chats from Avito messenger."""
    try:
        res = await list_chats(limit=limit)
        return json.dumps(res, ensure_ascii=False, indent=2)
    except Exception as e:
        log.error("avito_list_chats error: %s", e)
        return json.dumps({"error": str(e)}, ensure_ascii=False)


@server.tool(
    name="avito_get_chat_history",
    description="Read message history in an active Avito chat to check seller responses."
)
async def tool_get_chat_history(chat_url: Optional[str] = None, limit: int = 15) -> str:
    """Get chat messages with an Avito seller."""
    try:
        res = await get_chat_history(chat_url=chat_url, limit=limit)
        return json.dumps(res, ensure_ascii=False, indent=2)
    except Exception as e:
        log.error("avito_get_chat_history error: %s", e)
        return json.dumps({"error": str(e)}, ensure_ascii=False)


def main():
    log.info("Starting Avito MCP Python server on stdio...")

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    def shutdown():
        log.info("Shutting down server, closing browser...")
        try:
            loop.run_until_complete(close_browser())
        except Exception:
            pass

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            signal.signal(sig, lambda s, f: shutdown())
        except Exception:
            pass

    try:
        if hasattr(server, "run_stdio_async"):
            loop.run_until_complete(server.run_stdio_async())
        else:
            server.run(transport="stdio")
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        shutdown()


if __name__ == "__main__":
    main()
