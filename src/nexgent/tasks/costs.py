"""Shared, versioned projections of Episode usage into normalized work."""

from __future__ import annotations

import math


COST_PROJECTION_SCHEMA = "nexgent.normalized-work-projection.v1"

# These weights define a comparison proxy, not a provider price schedule.
STANDARD_COST_WEIGHTS = {
    "model_calls": 1.0,
    "charged_completion_tokens": 0.001,
    "tool_calls": 1.0,
    "charged_tool_work_units": 1.0,
    "nodes": 1.0,
}

# Plans written before COST_PROJECTION_SCHEMA did not freeze a projection.
# Preserve their P3 interpretation when an old trial is assessed for the first
# time; immutable decisions that already exist are returned without recompute.
LEGACY_EVOLUTION_COST_WEIGHTS = {
    **STANDARD_COST_WEIGHTS,
    "nodes": 0.1,
}


def cost_projection_spec(weights=STANDARD_COST_WEIGHTS):
    """Return the JSON-safe projection definition to freeze in a plan."""
    return {
        "schema": COST_PROJECTION_SCHEMA,
        "gate_basis": "conservative_work",
        "weights": _weights(weights),
    }


def normalized_work_projection(usage, weights=STANDARD_COST_WEIGHTS):
    """Project usage without conflating reservations with reported tokens.

    ``conservative_work`` is suitable for admission and gates: it uses the
    host's non-refundable charged completion and tool-work values.
    ``reported_token_work`` replaces charged completion tokens with provider
    reported prompt plus completion tokens, and is absent unless every model
    call has complete reported token usage. It is descriptive only.
    """
    if not isinstance(usage, dict):
        return None
    weights = _weights(weights)
    charged = {}
    for key in STANDARD_COST_WEIGHTS:
        value = usage.get(key)
        if type(value) is not int or value < 0:
            return None
        charged[key] = value
    conservative_work = sum(charged[key] * weights[key] for key in charged)

    reported_tokens = _reported_tokens(usage)
    reported_token_work = None
    if reported_tokens is not None:
        reported_token_work = (
            conservative_work
            - charged["charged_completion_tokens"]
            * weights["charged_completion_tokens"]
            + (reported_tokens["prompt_tokens"]
               + reported_tokens["completion_tokens"])
            * weights["charged_completion_tokens"]
        )
    return {
        "schema": COST_PROJECTION_SCHEMA,
        "weights": weights,
        "conservative_work": conservative_work,
        "conservative_token_basis": "charged_completion_tokens",
        "charged_completion_tokens": charged["charged_completion_tokens"],
        "reported_token_work": reported_token_work,
        "reported_token_basis": "prompt_tokens_plus_completion_tokens",
        "reported_tokens": reported_tokens,
    }


def _weights(value):
    if not isinstance(value, dict) or set(value) != set(STANDARD_COST_WEIGHTS):
        raise ValueError("Cost projection weights are invalid")
    result = {}
    for key in STANDARD_COST_WEIGHTS:
        weight = value.get(key)
        if type(weight) not in {int, float} or not math.isfinite(weight) or weight < 0:
            raise ValueError("Cost projection weights are invalid")
        result[key] = float(weight)
    return result


def _reported_tokens(usage):
    known = usage.get("known_usage")
    if not isinstance(known, dict):
        return None
    values = {key: known.get(key) for key in (
        "prompt_tokens", "completion_tokens", "total_tokens")}
    if any(type(value) is not int or value < 0 for value in values.values()):
        return None
    missing = usage.get("usage_missing_call_ids")
    if missing != [] and usage.get("usage_complete") is not True:
        return None
    # A nonempty missing list always wins over a coarse usage_complete flag.
    if isinstance(missing, list) and missing:
        return None
    return values
