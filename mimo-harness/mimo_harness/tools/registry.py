"""Tool registry - unified tool definition and dispatch."""

import json
from dataclasses import dataclass, field
from typing import Callable, Optional
from ..permissions import Permission, PermissionGate


@dataclass
class ToolDef:
    name: str
    description: str
    parameters: dict
    handler: Callable[[dict], str]
    permission: Permission = Permission.READ


class ToolRegistry:
    def __init__(self):
        self._tools: dict[str, ToolDef] = {}

    def register(self, tool: ToolDef):
        self._tools[tool.name] = tool

    def register_many(self, tools: list[ToolDef]):
        for t in tools:
            self.register(t)

    def get(self, name: str) -> Optional[ToolDef]:
        return self._tools.get(name)

    def list_tools(self) -> list[dict]:
        return [
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                }
            }
            for t in self._tools.values()
        ]

    def list_names(self) -> list[str]:
        return list(self._tools.keys())

    def list_all(self) -> list[ToolDef]:
        return list(self._tools.values())

    def execute(self, name: str, params: dict, perms: PermissionGate) -> str:
        tool = self._tools.get(name)
        if not tool:
            return json.dumps({"error": f"Unknown tool: {name}"})
        if not perms.check(tool.permission, f"{name}({json.dumps(params, ensure_ascii=False)[:100]})"):
            return json.dumps({"error": f"Permission denied for '{name}'"})
        try:
            result = tool.handler(params)
            # Truncate large results to prevent context overflow
            if len(result) > 10000:
                result = result[:10000] + "\n... [truncated]"
            return result
        except Exception as e:
            return json.dumps({"error": f"Tool '{name}' failed: {str(e)}"})
