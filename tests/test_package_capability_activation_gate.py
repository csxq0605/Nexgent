"""A packaged capability must run successfully before it can pass selection."""

import pytest

from nexgent.tasks.evolution import _loaded_evidence


@pytest.mark.parametrize("kind", ["tool", "service_provider"])
def test_loading_package_source_alone_does_not_activate_capability(kind):
    package = {
        "digest": "package-digest", "component_digests": {"capability.py": "file-digest"},
    }
    component = {
        "component_id": "capability-component", "class": "S", "kind": kind,
        "ref": "capability-name", "files": ["capability.py"],
    }
    execution = {
        "package_digest": package["digest"],
        "loaded_modules": ["capability.py"],
    }
    before = _loaded_evidence(component, execution, package)
    assert before["activation_required"] is True
    assert before["loaded"] is False

    execution["activated_components"] = [{
        "component_id": component["component_id"], "kind": kind,
        "package_digest": package["digest"], "source_path": "capability.py",
    }]
    after = _loaded_evidence(component, execution, package)
    assert after["activation_matches"] == 1
    assert after["loaded"] is True

    execution["activated_components"][0]["package_digest"] = "other-package"
    assert _loaded_evidence(component, execution, package)["loaded"] is False
