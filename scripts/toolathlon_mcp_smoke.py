"""Initialize installed local MCP servers without a model or task fixtures."""

import asyncio
import json
import os
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def check(name, command, arguments):
    scratch = "/tmp/toolathlon-infra-smoke"
    Path(scratch).mkdir(exist_ok=True)
    env = dict(os.environ)
    env.update({"UV_OFFLINE": "1", "ALLOWED_DIR": scratch})
    params = StdioServerParameters(
        command=command, args=arguments, cwd="/workspace", env=env
    )
    async with stdio_client(params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            tools = await session.list_tools()
            return {"server": name, "tool_count": len(tools.tools), "status": "ok"}


async def main():
    checks = [
        ("excel", "uv", ["run", "--no-sync", "excel-mcp-server", "stdio"]),
        (
            "filesystem",
            "npx",
            ["--no-install", "@modelcontextprotocol/server-filesystem", "/tmp/toolathlon-infra-smoke"],
        ),
        ("terminal", "uvx", ["--offline", "cli-mcp-server"]),
    ]
    for name, command, arguments in checks:
        try:
            result = await asyncio.wait_for(check(name, command, arguments), timeout=30)
        except Exception as error:
            result = {"server": name, "status": "failed", "error": str(error)}
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
