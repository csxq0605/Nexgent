"""
Minimal Agent Loop - Stage 1 deliverable
A ~120-line agent that can select tools, execute them, and return final answers.
Uses Xiaomi MiMo API (OpenAI-compatible format).
"""

import os, sys, json, time, ast, operator, math
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL
from openai import OpenAI

# ============================================================
# Safe math evaluator (replaces eval)
# ============================================================

_SAFE_OPERATORS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
    ast.USub: operator.neg,
    ast.UAdd: operator.pos,
}

_SAFE_FUNCTIONS = {
    "abs": abs, "round": round, "min": min, "max": max,
    "sqrt": math.sqrt, "log": math.log, "log10": math.log10,
    "sin": math.sin, "cos": math.cos, "tan": math.tan,
    "pi": math.pi, "e": math.e,
}


def _safe_eval_node(node):
    """Recursively evaluate an AST node with only safe operations."""
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
        left = _safe_eval_node(node.left)
        right = _safe_eval_node(node.right)
        return _SAFE_OPERATORS[op_type](left, right)
    if isinstance(node, ast.UnaryOp):
        op_type = type(node.op)
        if op_type not in _SAFE_OPERATORS:
            raise ValueError(f"Unsupported operator: {op_type.__name__}")
        return _SAFE_OPERATORS[op_type](_safe_eval_node(node.operand))
    if isinstance(node, ast.Call):
        func = _safe_eval_node(node.func)
        if not callable(func):
            raise ValueError(f"Not callable: {func}")
        args = [_safe_eval_node(a) for a in node.args]
        return func(*args)
    raise ValueError(f"Unsupported expression: {ast.dump(node)}")


def safe_eval(expression: str):
    """Safely evaluate a math expression without exec/eval."""
    tree = ast.parse(expression, mode="eval")
    return _safe_eval_node(tree.body)

# --- Tool Definitions ---
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "calculator",
            "description": "Evaluate a math expression. Use for arithmetic, algebra, or unit conversions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "expression": {"type": "string", "description": "The math expression to evaluate, e.g. '2 + 3 * 4'"}
                },
                "required": ["expression"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search",
            "description": "Search for information on a topic. Returns a brief summary. NOTE: This is a demo placeholder - returns simulated results.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "The search query"}
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a local file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "File path to read"}
                },
                "required": ["path"]
            }
        }
    }
]


def execute_tool(name: str, params: dict) -> str:
    """Execute a tool and return the result as a string."""
    if name == "calculator":
        try:
            result = safe_eval(params["expression"])
            return json.dumps({"result": result})
        except Exception as e:
            return json.dumps({"error": str(e)})
    elif name == "search":
        return json.dumps({"summary": f"Search results for '{params['query']}': [placeholder - connect to real search API]"})
    elif name == "read_file":
        try:
            from pathlib import Path
            resolved = Path(params["path"]).resolve()
            allowed = Path.cwd().resolve()
            if not str(resolved).startswith(str(allowed)):
                return json.dumps({"error": "Path outside allowed directory"})
            with open(params["path"], "r", encoding="utf-8") as f:
                return json.dumps({"content": f.read()[:2000]})
        except Exception as e:
            return json.dumps({"error": str(e)})
    return json.dumps({"error": f"Unknown tool: {name}"})


def agent_loop(
    user_message: str,
    max_steps: int = 10,
    timeout_seconds: int = 60
) -> str:
    """
    The core agent loop:
    1. Send message + tools to MiMo LLM
    2. If LLM returns tool_calls, execute the tool and loop
    3. If LLM returns text (no tool calls), return the final answer
    """
    client = OpenAI(api_key=MIMO_API_KEY, base_url=MIMO_BASE_URL)
    messages = [
        {"role": "system", "content": "You are MiMo, an AI assistant developed by Xiaomi."},
        {"role": "user", "content": user_message}
    ]
    start_time = time.time()

    for step in range(max_steps):
        if time.time() - start_time > timeout_seconds:
            return "[ERROR] Agent timed out."

        try:
            response = client.chat.completions.create(
                model=MIMO_MODEL,
                messages=messages,
                tools=TOOLS,
                tool_choice="auto",
                max_completion_tokens=1024,
                temperature=0.7,
                top_p=0.9
            )
        except Exception as e:
            return f"[ERROR] API call failed: {e}"

        choice = response.choices[0]
        message = choice.message

        # If no tool calls, we're done
        if not message.tool_calls:
            return message.content or "[No response]"

        # If tool calls, execute them and continue
        messages.append(message.model_dump())
        for tc in message.tool_calls:
            func_name = tc.function.name
            func_args = json.loads(tc.function.arguments)
            print(f"  [Step {step+1}] Tool: {func_name}({json.dumps(func_args)})")
            result = execute_tool(func_name, func_args)
            messages.append({
                "role": "tool",
                "tool_call_id": tc.id,
                "content": result
            })

    return "[ERROR] Max steps reached without final answer."


if __name__ == "__main__":
    print("=== Minimal Agent (MiMo) ===")
    print(f"Model: {MIMO_MODEL}")
    print(f"API: {MIMO_BASE_URL}")
    print(f"API Key: ***configured***")
    print("Type a message (or 'quit' to exit):\n")

    while True:
        user_input = input("You: ").strip()
        if user_input.lower() in ("quit", "exit", "q"):
            break
        if not user_input:
            continue
        print("\nAgent thinking...")
        answer = agent_loop(user_input)
        print(f"\nAgent: {answer}\n")
