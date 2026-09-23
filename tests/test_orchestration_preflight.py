"""Development preflight must not disguise repeated examples with a new seed."""

import pytest

from experiments.orchestration_qualification.preflight_v3 import _disjoint_units


def test_preflight_rejects_same_statistical_unit_under_another_task_id():
    prior = {"bbh/example/case-1"}
    with pytest.raises(ValueError, match="overlap"):
        _disjoint_units(prior, [{
            "id": "bbh/development/9/case-1",
            "statistical_unit_id": "bbh/example/case-1",
        }])


def test_preflight_accepts_distinct_units():
    assert _disjoint_units({"bbh/example/case-1"}, [{
        "id": "bbh/development/1/case-2",
        "statistical_unit_id": "bbh/example/case-2",
    }]) == ["bbh/example/case-2"]
