from nexgent.tasks.costs import (
    LEGACY_EVOLUTION_COST_WEIGHTS, normalized_work_projection,
)
from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.studies import RSIStudyService


def _usage(**changes):
    value = {
        "model_calls": 1,
        "reserved_completion_tokens": 1000,
        "charged_completion_tokens": 1000,
        "completion_tokens": 200,
        "known_usage": {
            "prompt_tokens": 600, "completion_tokens": 200, "total_tokens": 800,
        },
        "usage_missing_call_ids": [],
        "tool_calls": 2,
        "charged_tool_work_units": 3,
        "nodes": 4,
        "usage_complete": True,
    }
    value.update(changes)
    return value


def test_p3_and_p5_share_one_conservative_and_reported_token_projection():
    usage = _usage()
    p3 = EvolutionService._cost_projection(usage)
    p5 = RSIStudyService._work_projection(usage)

    assert p3 == p5 == normalized_work_projection(usage)
    assert EvolutionService._cost(usage) == RSIStudyService._work(usage) == 11.0
    assert p3["conservative_token_basis"] == "charged_completion_tokens"
    assert p3["reported_tokens"] == {
        "prompt_tokens": 600, "completion_tokens": 200, "total_tokens": 800,
    }
    assert p3["reported_token_work"] == 10.8


def test_reported_token_projection_fails_closed_without_hiding_charged_work():
    usage = _usage(
        completion_tokens=None,
        known_usage={"prompt_tokens": 600, "completion_tokens": 0, "total_tokens": 600},
        usage_missing_call_ids=["call-missing"],
        usage_complete=False,
    )

    projection = normalized_work_projection(usage)
    assert projection["conservative_work"] == 11.0
    assert projection["reported_tokens"] is None
    assert projection["reported_token_work"] is None


def test_legacy_p3_projection_keeps_the_pre_versioned_node_weight():
    usage = _usage()
    legacy = EvolutionService._cost_projection(
        usage, LEGACY_EVOLUTION_COST_WEIGHTS)

    assert legacy["conservative_work"] == 7.4
    assert legacy["reported_token_work"] == 7.2
