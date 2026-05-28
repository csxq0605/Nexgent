"""Tool registry - unified tool definition and dispatch.

Implements Ch3 patterns:
- Tool protocol with concurrency-safe/unsafe markers (fail-closed defaults)
- Input validation before execution
- Tool result budget management (disk spillover for large outputs)
- Execution with permission gate integration
"""

import json
import os
import uuid
from dataclasses import dataclass, field
from typing import Callable, Optional
from ..permissions import Permission, PermissionGate


# Ch3: fail-closed defaults — tools must explicitly declare safety
@dataclass
class ToolDef:
    name: str
    description: str
    parameters: dict
    handler: Callable[[dict], str]
    permission: Permission = Permission.READ
    is_read_only: bool = False       # Ch3: read-only marker
    is_destructive: bool = False     # Ch3: destructive marker
    is_concurrency_safe: bool = False  # Ch3: can run in parallel


class ToolRegistry:
    """Central tool registry with validation and dispatch.

    Follows Ch3 patterns:
    - fail-closed: unknown tools rejected
    - input validation before execution
    - result budget: disk spillover for large outputs
    """

    # A7: disk spillover thresholds (approx 4 chars per token)
    SPILL_THRESHOLD_TOKENS = 10000   # ~40K chars
    MAX_RESULT_TOKENS = 25000        # ~100K chars
    SPILL_THRESHOLD_CHARS = SPILL_THRESHOLD_TOKENS * 4   # 40000
    MAX_RESULT_CHARS = MAX_RESULT_TOKENS * 4              # 100000
    SPILL_DIR = os.environ.get("MIMO_SPILL_DIR", ".mimo/outputs")

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
        """Generate OpenAI-compatible tool schema for API calls."""
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

    def list_read_only(self) -> list[ToolDef]:
        """Ch3: get all read-only tools for plan mode filtering."""
        return [t for t in self._tools.values() if t.is_read_only]

    def list_concurrency_safe(self) -> list[ToolDef]:
        """Ch3: get tools safe for parallel execution."""
        return [t for t in self._tools.values() if t.is_concurrency_safe]

    def _validate_params(self, tool: ToolDef, params: dict) -> Optional[str]:
        """Stage 1: Validate input parameters against tool schema.

        Returns error message if invalid, None if valid.
        """
        required = tool.parameters.get("required", [])
        properties = tool.parameters.get("properties", {})

        # Check required parameters
        for req in required:
            if req not in params:
                return f"Missing required parameter: {req}"

        # Check parameter types (basic validation)
        for key, value in params.items():
            if key in properties:
                prop = properties[key]
                expected_type = prop.get("type")
                if expected_type == "string" and not isinstance(value, str):
                    return f"Parameter '{key}' must be a string"
                # Check boolean BEFORE integer (isinstance(True, int) is True)
                if expected_type == "boolean" and not isinstance(value, bool):
                    return f"Parameter '{key}' must be a boolean"
                if expected_type == "integer" and (not isinstance(value, int) or isinstance(value, bool)):
                    return f"Parameter '{key}' must be an integer"
                if expected_type == "number" and not isinstance(value, (int, float)):
                    return f"Parameter '{key}' must be a number"
                # D6: Validate enum constraints
                if "enum" in prop and value not in prop["enum"]:
                    return f"Parameter '{key}' must be one of {prop['enum']}"
                # D6: Validate minimum/maximum constraints for numeric types
                if expected_type in ("integer", "number") and isinstance(value, (int, float)):
                    if "minimum" in prop and value < prop["minimum"]:
                        return f"Parameter '{key}' must be >= {prop['minimum']}"
                    if "maximum" in prop and value > prop["maximum"]:
                        return f"Parameter '{key}' must be <= {prop['maximum']}"

        return None

    def _spill_to_disk(self, result: str, tool_name: str) -> str:
        """Save large result to disk and return preview + file path (A7)."""
        os.makedirs(self.SPILL_DIR, exist_ok=True)
        file_id = str(uuid.uuid4())[:8]
        file_path = os.path.join(self.SPILL_DIR, f"{file_id}.txt")

        try:
            with open(file_path, "w", encoding="utf-8") as f:
                f.write(result)
        except Exception as e:
            # Fallback: hard truncate if disk write fails
            return (
                result[:self.MAX_RESULT_CHARS]
                + "\n... [truncated — disk spill failed]"
            )

        # Return preview (first SPILL_THRESHOLD chars) + file path
        preview = result[:self.SPILL_THRESHOLD_CHARS]
        return (
            f"{preview}\n\n"
            f"... [output truncated — full result ({len(result)} chars) saved to {file_path}]"
        )

    def execute(self, name: str, params: dict, perms: PermissionGate, permission_override=None) -> str:
        """Execute a tool with full 4-stage pipeline (Ch4).

        Stages:
        1. validateInput — parameter validation
        2. checkPermissions — permission gate
        3. handler execution
        4. result budget management (disk spillover for large outputs)
        """
        # Ch3: fail-closed — unknown tools rejected
        tool = self._tools.get(name)
        if not tool:
            return json.dumps({"error": f"Unknown tool: {name}"})

        # Stage 1: Input validation
        validation_error = self._validate_params(tool, params)
        if validation_error:
            return json.dumps({"error": f"Validation failed: {validation_error}"})

        # Stage 2: Permission check (C2: pass params for accurate protected path detection)
        action_desc = f"{name}({json.dumps(params, ensure_ascii=False)[:100]})"
        effective_perm = permission_override if permission_override is not None else tool.permission
        if not perms.check(effective_perm, action_desc, params=params):
            return json.dumps({"error": f"Permission denied for '{name}'"})

        # Stage 3: Execute handler
        try:
            result = tool.handler(params)
        except Exception as e:
            return json.dumps({"error": f"Tool '{name}' failed: {str(e)}"})

        # Stage 4: Result budget (A7: disk spillover for large outputs)
        # Spill to disk first (preserves full content), then truncate the preview
        if len(result) > self.SPILL_THRESHOLD_CHARS:
            result = self._spill_to_disk(result, name)
        elif len(result) > self.MAX_RESULT_CHARS:
            # Hard cap fallback (reachable when SPILL_THRESHOLD > MAX_RESULT_CHARS
            # or when thresholds are overridden for testing)
            result = result[:self.MAX_RESULT_CHARS]
        return result
