"""Optional compatibility check using the Python MCP transport used by Hermes."""
import asyncio
import json
import os
import sys

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def main():
    base = (os.environ.get("DELB_REVIEW_URL") or os.environ.get("BASE_URL") or "http://127.0.0.1:4317").rstrip("/")
    token = sys.stdin.readline().strip()
    async with httpx.AsyncClient(headers={"Authorization": f"Bearer {token}"}) as http:
        async with streamable_http_client(f"{base}/api/mcp", http_client=http) as (reader, writer, _):
            async with ClientSession(reader, writer) as session:
                await session.initialize()
                tools = await session.list_tools()
                names = [tool.name for tool in tools.tools]
                assert all(name in names for name in ["search_books", "list_my_tbr", "set_tbr_note", "update_book_metadata", "get_reading_progress", "log_reading_progress"])
                result = await session.call_tool("search_books", {"query": "Earthsea"})
                assert not result.isError
                matches = json.loads(result.content[0].text)["items"]
                assert any(item["title"] == "MCP Earthsea" for item in matches)
                book_id = next(item["id"] for item in matches if item["title"] == "MCP Earthsea")
                progress = await session.call_tool("get_reading_progress", {"bookId": book_id})
                assert not progress.isError
                assert json.loads(progress.content[0].text)["history"] == []
                denied = await session.call_tool("log_reading_progress", {"bookId": book_id, "progressPercent": 30})
                assert denied.isError
                filtered = await session.call_tool("search_books", {"statuses": ["none"]})
                assert not filtered.isError
                assert any(item["title"] == "MCP Earthsea" for item in json.loads(filtered.content[0].text)["items"])
                queue = await session.call_tool("list_my_tbr", {})
                assert not queue.isError
                assert json.loads(queue.content[0].text)["items"] == []
    print("PASS Python MCP transport used by Hermes")


asyncio.run(main())
