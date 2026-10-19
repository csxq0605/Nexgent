"""Math tools - safe expression evaluation using AST traversal."""

import ast
import operator
import math
import json
import threading
from .registry import ToolDef
from ..permissions import Permission

_MAX_EXPONENT = 10000  # Limit exponent to prevent DoS (2**10000 is ~3000 digits)
_MAX_RESULT_DIGITS = 10000  # Limit result size to prevent OOM
_EVAL_TIMEOUT = 5  # seconds

_SAFE_OPERATORS = {
    ast.Add: operator.add, ast.Sub: operator.sub,
    ast.Mult: operator.mul, ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv, ast.Mod: operator.mod,
    ast.USub: operator.neg, ast.UAdd: operator.pos,
}
_SAFE_FUNCTIONS = {
    "abs": abs, "round": round, "min": min, "max": max,
    "sqrt": math.sqrt, "log": math.log, "log10": math.log10,
    "sin": math.sin, "cos": math.cos, "tan": math.tan,
    "pi": math.pi, "e": math.e, "pow": pow,
}


def _eval_node(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in _SAFE_FUNCTIONS:
            return _SAFE_FUNCTIONS[node.id]
        raise ValueError(f"Unknown variable: {node.id}")
    if isinstance(node, ast.BinOp):
        op = type(node.op)
        if op == ast.Pow:
            # Limit exponent to prevent DoS (2**999999999 hangs and OOMs)
            right = _eval_node(node.right)
            if isinstance(right, (int, float)) and abs(right) > _MAX_EXPONENT:
                raise ValueError(f"Exponent {right} exceeds maximum {_MAX_EXPONENT}")
            left = _eval_node(node.left)
            result = operator.pow(left, right)
            if isinstance(result, int) and len(str(abs(result))) > _MAX_RESULT_DIGITS:
                raise ValueError(f"Result has too many digits (>{_MAX_RESULT_DIGITS})")
            return result
        if op not in _SAFE_OPERATORS:
            raise ValueError(f"Unsupported operator: {op.__name__}")
        return _SAFE_OPERATORS[op](_eval_node(node.left), _eval_node(node.right))
    if isinstance(node, ast.UnaryOp):
        op = type(node.op)
        if op not in _SAFE_OPERATORS:
            raise ValueError(f"Unsupported operator: {op.__name__}")
        return _SAFE_OPERATORS[op](_eval_node(node.operand))
    if isinstance(node, ast.Call):
        func = _eval_node(node.func)
        if not callable(func):
            raise ValueError(f"Not callable: {func}")
        args = [_eval_node(a) for a in node.args]
        # Limit pow() calls to prevent DoS
        if func is pow and len(args) >= 2:
            exp = args[1]
            if isinstance(exp, (int, float)) and abs(exp) > _MAX_EXPONENT:
                raise ValueError(f"Exponent {exp} exceeds maximum {_MAX_EXPONENT}")
        result = func(*args)
        if isinstance(result, int) and len(str(abs(result))) > _MAX_RESULT_DIGITS:
            raise ValueError(f"Result has too many digits (>{_MAX_RESULT_DIGITS})")
        return result
    raise ValueError(f"Unsupported expression: {ast.dump(node)}")


def safe_eval(expression: str):
    tree = ast.parse(expression, mode="eval")
    # Run evaluation in a thread with timeout to prevent DoS
    result = [None]
    error = [None]
    def _run():
        try:
            result[0] = _eval_node(tree.body)
        except Exception as e:
            error[0] = e
    t = threading.Thread(target=_run, daemon=True)
    t.start()
    t.join(timeout=_EVAL_TIMEOUT)
    if t.is_alive():
        raise TimeoutError(f"Evaluation timed out after {_EVAL_TIMEOUT}s")
    if error[0]:
        raise error[0]
    return result[0]


def calculator(params: dict) -> str:
    expr = params.get("expression", "")
    try:
        result = safe_eval(expr)
        return json.dumps({"expression": expr, "result": result})
    except Exception as e:
        return json.dumps({"expression": expr, "error": str(e)})


def get_tools() -> list[ToolDef]:
    return [
        ToolDef(
            name="calculator",
            description="Evaluate a math expression safely. Supports +,-,*,/,**,sqrt,sin,cos,tan,log,abs,round,min,max. Example: '247*893', 'sqrt(144)', 'sin(pi/2)'",
            parameters={
                "type": "object",
                "properties": {
                    "expression": {"type": "string", "description": "Math expression to evaluate"}
                },
                "required": ["expression"]
            },
            handler=calculator,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=True,
        )
    ]
