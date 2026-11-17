"""Optional compatibility check using the Python MCP transport used by Hermes."""
import asyncio
import json
import sys

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


async def main():
    token = sys.stdin.readline().strip()
    async with httpx.AsyncClient(headers={"Authorization": f"Bearer {token}"}) as http:
        async with streamable_http_client("http://127.0.0.1:4317/api/mcp", http_client=http) as (reader, writer, _):
            async with ClientSession(reader, writer) as session:
                await session.initialize()
                tools = await session.list_tools()
                assert "search_books" in [tool.name for tool in tools.tools]
                result = await session.call_tool("search_books", {"query": "Earthsea"})
                assert not result.isError
                assert any(item["title"] == "MCP Earthsea" for item in json.loads(result.content[0].text)["items"])
    print("PASS Python MCP transport used by Hermes")


asyncio.run(main())
