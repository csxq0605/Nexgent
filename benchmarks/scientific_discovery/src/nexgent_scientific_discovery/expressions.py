"""A small mathematical expression language for submitted vector fields."""
from __future__ import annotations

import ast
import math
import operator

import numpy as np


class NumericalFailure(ValueError):
    pass


_BINARY = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
           ast.Div: operator.truediv, ast.Pow: operator.pow}
_SCALAR = {name: getattr(math, name) for name in ("sin", "cos", "tanh", "exp", "sqrt", "log")}
_SCALAR["abs"] = abs
_ARRAY = {name: getattr(np, name) for name in ("sin", "cos", "tanh", "exp", "sqrt", "log", "abs")}


def expression(term: str, dimension: int, *, vectorized: bool = False):
    """Compile only arithmetic nodes into closures; never evaluate Python source."""
    if not isinstance(term, str) or len(term) > 240:
        raise NumericalFailure("expression must be a string of at most 240 characters")
    try:
        tree = ast.parse(term, mode="eval")
    except (SyntaxError, RecursionError) as exc:
        raise NumericalFailure("invalid mathematical expression") from exc
    if len(list(ast.walk(tree))) > 100:
        raise NumericalFailure("expression is too complex")
    functions = _ARRAY if vectorized else _SCALAR

    def build(node):
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            value = float(node.value)
            if not math.isfinite(value) or abs(value) > 1e6:
                raise NumericalFailure("invalid expression constant")
            return lambda x, t: value
        if isinstance(node, ast.Name):
            if node.id == "t":
                return lambda x, t: t
            if node.id in [f"x{i}" for i in range(dimension)]:
                index = int(node.id[1:])
                return lambda x, t: x[index]
            raise NumericalFailure("unknown variable in expression")
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            child = build(node.operand)
            sign = -1 if isinstance(node.op, ast.USub) else 1
            return lambda x, t: sign * child(x, t)
        if isinstance(node, ast.BinOp) and type(node.op) in _BINARY:
            if isinstance(node.op, ast.Pow):
                exponent = node.right
                literal = exponent.operand if isinstance(exponent, ast.UnaryOp) and isinstance(exponent.op, (ast.UAdd, ast.USub)) else exponent
                if not isinstance(literal, ast.Constant) or type(literal.value) not in (int, float) or abs(literal.value) > 6:
                    raise NumericalFailure("powers require a literal exponent between -6 and 6")
            left, right, operation = build(node.left), build(node.right), _BINARY[type(node.op)]
            return lambda x, t: operation(left(x, t), right(x, t))
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in functions and len(node.args) == 1 and not node.keywords:
            child, function = build(node.args[0]), functions[node.func.id]
            return lambda x, t: function(child(x, t))
        raise NumericalFailure("expression contains an unsupported operation")

    return build(tree.body), len(list(ast.walk(tree)))


def validate_model(model):
    if not isinstance(model, dict):
        raise NumericalFailure("submission needs a model object")
    terms = model.get("terms")
    if not isinstance(terms, list) or not 1 <= len(terms) <= 64 or len(set(terms)) != len(terms):
        raise NumericalFailure("model needs 1 to 64 distinct expression terms")
    try:
        coefficients = np.asarray(model.get("coefficients"), dtype=float)
    except (TypeError, ValueError) as exc:
        raise NumericalFailure("invalid coefficients") from exc
    if coefficients.ndim != 2 or not 1 <= coefficients.shape[0] <= 6 or coefficients.shape[1] != len(terms):
        raise NumericalFailure("coefficients must have shape [state dimension][term]")
    if not np.isfinite(coefficients).all() or np.max(np.abs(coefficients)) > 1e6:
        raise NumericalFailure("nonfinite or excessive model coefficients")
    parsed = [expression(term, coefficients.shape[0]) for term in terms]
    return terms, coefficients, parsed


def bounded_rk4(field, initial, dt, steps, *, substeps=2, start_time=0.0, charge=None):
    state = [float(value) for value in initial]
    if not 1 <= len(state) <= 6 or not all(math.isfinite(value) and abs(value) < 1e5 for value in state):
        raise NumericalFailure("invalid initial state")
    if not math.isfinite(dt) or not 0 < dt <= 1 or type(steps) is not int or not 0 <= steps <= 2000 or type(substeps) is not int or not 1 <= substeps <= 32:
        raise NumericalFailure("invalid integration grid")
    h, time = dt / substeps, start_time
    result = [state[:]]

    def rhs(x, t):
        if not all(math.isfinite(value) and abs(value) < 1e5 for value in x):
            raise NumericalFailure("unstable integrated state")
        if charge:
            charge()
        try:
            values = [float(value) for value in field(x, t)]
        except (OverflowError, ValueError, ZeroDivisionError, TypeError) as exc:
            raise NumericalFailure("invalid vector field evaluation") from exc
        if len(values) != len(state) or not all(math.isfinite(value) and abs(value) < 1e9 for value in values):
            raise NumericalFailure("unstable vector field")
        return values

    for _ in range(steps):
        for _ in range(substeps):
            a = rhs(state, time)
            b = rhs([x + h * dx / 2 for x, dx in zip(state, a)], time + h / 2)
            c = rhs([x + h * dx / 2 for x, dx in zip(state, b)], time + h / 2)
            d = rhs([x + h * dx for x, dx in zip(state, c)], time + h)
            state = [x + h * (aa + 2 * bb + 2 * cc + dd) / 6 for x, aa, bb, cc, dd in zip(state, a, b, c, d)]
            if not all(math.isfinite(value) and abs(value) < 1e5 for value in state):
                raise NumericalFailure("unstable integrated state")
            time += h
        result.append(state[:])
    return result
