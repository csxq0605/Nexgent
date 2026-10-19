"""
Minimal Agent Harness Demo - Stage 3 deliverable
Demonstrates: tool registry, permission gate, session store, context compaction, agent loop.
Uses Xiaomi MiMo API (OpenAI-compatible format).
"""

import os, sys, json, time, hashlib, ast, operator, math
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional
from openai import OpenAI

# ============================================================
# Safe math evaluator (replaces eval)
# ============================================================

_SAFE_OPERATORS = {
    ast.Add: operator.add, ast.Sub: operator.sub,
    ast.Mult: operator.mul, ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod,
    ast.Pow: operator.pow, ast.USub: operator.neg, ast.UAdd: operator.pos,
}
_SAFE_FUNCTIONS = {
    "abs": abs, "round": round, "min": min, "max": max,
    "sqrt": math.sqrt, "log": math.log, "log10": math.log10,
    "sin": math.sin, "cos": math.cos, "tan": math.tan,
    "pi": math.pi, "e": math.e,
}


def _safe_eval_node(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in _SAFE_FUNCTIONS:
            return _SAFE_FUNCTIONS[node.id]
        raise ValueError(f"Unknown variable: {node.id}")
    if isinstance(node, ast.BinOp):
        op_type = type(node.op)
        if op_type not in _SAFE_OPERATORS:
            raise ValueError(f"Unsupported operator: {op_type.__name__}")
        return _SAFE_OPERATORS[op_type](_safe_eval_node(node.left), _safe_eval_node(node.right))
    if isinstance(node, ast.UnaryOp):
        op_type = type(node.op)
        if op_type not in _SAFE_OPERATORS:
            raise ValueError(f"Unsupported operator: {op_type.__name__}")
        return _SAFE_OPERATORS[op_type](_safe_eval_node(node.operand))
    if isinstance(node, ast.Call):
        func = _safe_eval_node(node.func)
        if not callable(func):
            raise ValueError(f"Not callable: {func}")
        return func(*[_safe_eval_node(a) for a in node.args])
    raise ValueError(f"Unsupported expression: {ast.dump(node)}")


def safe_eval(expression: str):
    tree = ast.parse(expression, mode="eval")
    return _safe_eval_node(tree.body)


class Permission(Enum):
    NONE = "none"
    READ = "read"
    WRITE = "write"
    EXECUTE = "execute"
    DESTRUCTIVE = "destructive"


@dataclass
class ToolDef:
    name: str
    description: str
    parameters: dict
    handler: Callable[[dict], str]
    permission: Permission = Permission.NONE


class ToolRegistry:
    def __init__(self):
        self._tools: dict[str, ToolDef] = {}

    def register(self, tool: ToolDef):
        self._tools[tool.name] = tool

    def get(self, name: str) -> Optional[ToolDef]:
        return self._tools.get(name)

    def list_tools(self) -> list[dict]:
        return [
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters
                }
            }
            for t in self._tools.values()
        ]

    def execute(self, name: str, params: dict, permission_gate: 'PermissionGate') -> str:
        tool = self._tools.get(name)
        if not tool:
            return json.dumps({"error": f"Unknown tool: {name}"})
        if not permission_gate.check(tool.permission):
            return json.dumps({"error": f"Permission denied for '{name}' (requires {tool.permission.value})"})
        try:
            return tool.handler(params)
        except Exception as e:
            return json.dumps({"error": f"Tool '{name}' failed: {str(e)}"})


class PermissionGate:
    def __init__(self, auto_approve: set = None, interactive: bool = True):
        self.auto_approve = auto_approve or {Permission.NONE, Permission.READ}
        self.interactive = interactive
        self.log: list[str] = []

    def check(self, required: Permission) -> bool:
        if required in self.auto_approve:
            self.log.append(f"  [AUTO] {required.value}")
            return True
        if required == Permission.DESTRUCTIVE:
            self.log.append(f"  [BLOCKED] {required.value}")
            return False
        # WRITE / EXECUTE need confirmation
        if not self.interactive:
            self.log.append(f"  [DENIED] {required.value} (non-interactive)")
            return False
        try:
            response = input(f"  Allow {required.value}? (y/n): ").strip().lower()
        except EOFError:
            self.log.append(f"  [DENIED] {required.value} (no input)")
            return False
        approved = response in ("y", "yes")
        self.log.append(f"  [{'APPROVED' if approved else 'DENIED'}] {required.value}")
        return approved


@dataclass
class Session:
    session_id: str
    messages: list = field(default_factory=list)
    created_at: float = field(default_factory=time.time)

    def add_message(self, role: str, content):
        self.messages.append({"role": role, "content": content})

    def get_messages(self) -> list:
        return self.messages


def compact_context(messages: list, max_messages: int = 20) -> list:
    if len(messages) <= max_messages:
        return messages

    result = []
    tail = messages[-max_messages:]

    # collect valid tool_call_ids from remaining assistant messages
    valid_tool_call_ids = set()
    for msg in tail:
        msg_dict = msg if isinstance(msg, dict) else getattr(msg, '__dict__', msg)
        if isinstance(msg_dict, dict):
            tool_calls = msg_dict.get("tool_calls")
            if tool_calls:
                for tc in (tool_calls if isinstance(tool_calls, list) else []):
                    tc_id = tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", None)
                    if tc_id:
                        valid_tool_call_ids.add(tc_id)

    for msg in tail:
        msg_dict = msg if isinstance(msg, dict) else getattr(msg, '__dict__', msg)
        if isinstance(msg_dict, dict) and msg_dict.get("role") == "tool":
            tc_id = msg_dict.get("tool_call_id")
            if tc_id in valid_tool_call_ids:
                result.append(msg)
        else:
            result.append(msg)

    return result


class AgentHarness:
    def __init__(self, max_steps: int = 15):
        self.max_steps = max_steps
        self.registry = ToolRegistry()
        self.permission_gate = PermissionGate()
        self._register_default_tools()

    def _register_default_tools(self):
        self.registry.register(ToolDef(
            name="read_file",
            description="Read a file's contents",
            parameters={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
            handler=lambda p: self._read_file(p["path"]),
            permission=Permission.READ
        ))
        self.registry.register(ToolDef(
            name="write_file",
            description="Write content to a file",
            parameters={"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]},
            handler=lambda p: self._write_file(p["path"], p["content"]),
            permission=Permission.WRITE
        ))
        self.registry.register(ToolDef(
            name="list_files",
            description="List files in a directory",
            parameters={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
            handler=lambda p: self._list_files(p["path"]),
            permission=Permission.READ
        ))
        self.registry.register(ToolDef(
            name="calculator",
            description="Evaluate a math expression",
            parameters={"type": "object", "properties": {"expression": {"type": "string"}}, "required": ["expression"]},
            handler=lambda p: self._calculator(p["expression"]),
            permission=Permission.NONE
        ))

    def _read_file(self, path: str) -> str:
        try:
            resolved = Path(path).resolve()
            allowed_dir = Path.cwd().resolve()
            if not resolved.is_relative_to(allowed_dir):
                return json.dumps({"error": "Path outside allowed directory"})
            with open(path, "r", encoding="utf-8") as f:
                return json.dumps({"content": f.read()[:5000]})
        except Exception as e:
            return json.dumps({"error": str(e)})

    def _write_file(self, path: str, content: str) -> str:
        try:
            resolved = Path(path).resolve()
            allowed_dir = Path.cwd().resolve()
            if not resolved.is_relative_to(allowed_dir):
                return json.dumps({"error": "Path outside allowed directory"})
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            return json.dumps({"status": "written", "bytes": len(content)})
        except Exception as e:
            return json.dumps({"error": str(e)})

    def _list_files(self, path: str) -> str:
        try:
            entries = os.listdir(path)
            return json.dumps({"files": entries[:50], "count": len(entries)})
        except Exception as e:
            return json.dumps({"error": str(e)})

    def _calculator(self, expression: str) -> str:
        try:
            result = safe_eval(expression)
            return json.dumps({"result": result})
        except Exception as e:
            return json.dumps({"error": str(e)})

    def run(self, task: str, session: Optional[Session] = None) -> str:
        if session is None:
            session = Session(session_id=hashlib.md5(str(time.time()).encode()).hexdigest()[:8])

        client = OpenAI(api_key=MIMO_API_KEY, base_url=MIMO_BASE_URL)
        session.add_message("user", task)
        tools = self.registry.list_tools()

        messages = [
            {"role": "system", "content": "You are MiMo, a helpful AI assistant developed by Xiaomi."}
        ] + compact_context(session.get_messages())

        for step in range(self.max_steps):
            response = client.chat.completions.create(
                model=MIMO_MODEL,
                messages=messages,
                tools=tools,
                tool_choice="auto",
                max_completion_tokens=2048,
                temperature=0.7,
                top_p=0.9
            )

            choice = response.choices[0]
            message = choice.message

            if not message.tool_calls:
                final = message.content or "[No response]"
                session.add_message("assistant", final)
                return final

            msg_dump = message.model_dump()
            if msg_dump.get("content") is None:
                msg_dump["content"] = ""
            session.messages.append(msg_dump)
            messages.append(msg_dump)
            for tc in message.tool_calls:
                func_name = tc.function.name
                func_args = json.loads(tc.function.arguments)
                print(f"  [Step {step+1}] {func_name}({json.dumps(func_args)[:80]})")
                result = self.registry.execute(func_name, func_args, self.permission_gate)
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})

        return "[ERROR] Max steps reached."


if __name__ == "__main__":
    harness = AgentHarness()
    session = Session(session_id="demo")

    print("=== Agent Harness Demo (MiMo) ===")
    print(f"Model: {MIMO_MODEL}")
    print(f"API Key: ***configured***")
    print("Available tools:", [t["function"]["name"] for t in harness.registry.list_tools()])
    print()

    while True:
        task = input("Task: ").strip()
        if task.lower() in ("quit", "exit", "q"):
            break
        if not task:
            continue
        print()
        result = harness.run(task, session)
        print(f"\nResult:\n{result}\n")
