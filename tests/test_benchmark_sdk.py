"""Canonical TaskService benchmark SDK contracts; no models or external tools."""

import json
from pathlib import Path
import sys

import pytest


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "benchmarks" / "workbench" / "src"))
sys.path.insert(0, str(ROOT / "benchmarks" / "openfoam" / "src"))

from nexgent.tasks.benchmarks import (
    BenchmarkDescriptor, BenchmarkRegistry, SDK_SCHEMA, host_runtime_fingerprint,
)
from nexgent.tasks.packages import make_package
from nexgent.tasks.capability_authority import make_episode_authority
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, ToolRegistry
from nexgent_openfoam import OpenFOAMCavityBenchmark
from nexgent_workbench import WorkbenchBenchmark


class Point:
    def __init__(self, name, provider):
        self.name = name
        self.provider = provider

    def load(self):
        if isinstance(self.provider, BaseException):
            raise self.provider
        return self.provider


class Adapter:
    id = "fixture"
    descriptor = BenchmarkDescriptor(
        id=id, version="1", title="Fixture", splits=("development",),
        default_split="development", required_capabilities=(),
        evidence_scope="SDK contract fixture only",
    )

    def __init__(self, root=None):
        self.root = root

    @classmethod
    def from_project(cls, root):
        return cls(Path(root).resolve())

    def describe(self):
        return {"id": self.id, "data_origin": "authored_fixture"}

    def snapshot(self):
        return {"id": self.id, "evaluator_digest": "fixture-v1"}

    def tasks(self, split="development", seed=0):
        return [{"id": f"fixture/{split}/{seed}", "objective": "Return a score",
                 "inputs": {}, "deliverables": [{"name": "result", "schema": {
                     "type": "object", "required": ["score"],
                     "properties": {"score": {"type": "number"}}}}],
                 "capabilities": [],
                 "context": {"split": split, "seed": seed}}]

    def evaluate(self, task_ref, deliverables, execution_view):
        return {"status": "accepted", "score_available": True,
                "score": 1.0, "accepted": True}


def test_benchmark_episode_uses_host_granted_service_authority(tmp_path, monkeypatch):
    import nexgent.tasks.runtime as runtime_module

    adapter = Adapter()
    monkeypatch.setattr(runtime_module, "task_benchmarks", lambda: {adapter.id: adapter})
    source = '''def execute(payload, context):
    developed = context.develop_service({
        'name': 'benchmark.context',
        'description': 'Add the requested score to model-visible context.',
        'source': "def provide(payload, context):\\n    value = payload['payload'].copy()\\n    value['score'] = 1.0\\n    return {'payload': value, 'annotations': {}}\\n",
    })
    context.activate_service(developed['definition_id'], 0)
    result = context.ask('solver', 'Return the JSON payload.', {'task': 'score'}, 20)
    artifact = context.publish(result, name='result')
    return {'deliverables': {'result': artifact['id']}}
'''
    package = make_package(
        {"main.py": source}, {"entries": {"execute": "main.py:execute"}})

    class Gateway:
        def __init__(self, reserve, stop_event):
            self.reserve = reserve

        def ask(self, role, prompt, payload=None, max_tokens=4000):
            receipt = {"call_id": "benchmark-model-1", "role": role,
                       "model": "deterministic-fixture", "status": "started",
                       "reserved_completion_tokens": max_tokens,
                       "max_tokens": max_tokens}
            self.reserve(receipt)
            self.reserve({**receipt, "status": "received",
                          "usage": {"prompt_tokens": 1,
                                    "completion_tokens": 1,
                                    "total_tokens": 2}})
            return payload

    authority = make_episode_authority(
        ["service_provider"], ["model_context"], version=2)
    service = TaskService(tmp_path, tools=ToolRegistry(), gateway_factory=Gateway)
    result = service.benchmark(
        adapter.id, package=package, capability_authority=authority)
    episode_id = result["reports"][0]["episode_id"]
    assert service.store.get(episode_id)["task"]["capability_authority"] == authority
    assert service.store.get(episode_id)["status"] == "completed"
    assert service.store.calls(episode_id)[0]["service_provider"]["authority_digest"] == authority["digest"]
    assert result["reports"][0]["evaluation"]["accepted"] is True


def test_registry_isolates_duplicates_load_failures_identity_mismatch_and_unavailability(tmp_path):
    class Mismatch(Adapter):
        id = "different"
        descriptor = BenchmarkDescriptor(
            id=id, version="1", title="Different", splits=("development",),
            default_split="development")

    class Unavailable(Adapter):
        id = "offline"
        descriptor = BenchmarkDescriptor(
            id=id, version="1", title="Offline", splits=("development",),
            default_split="development")

        def availability(self):
            return {"available": False,
                    "reason": "SECRET_AVAILABILITY_DETAIL=C:/private/dataset"}

    points = [
        Point("fixture", Adapter),
        Point("duplicate", Adapter), Point("duplicate", Adapter),
        Point("broken", RuntimeError("SECRET_PLUGIN_IMPORT_DETAIL=C:/private/plugin")),
        Point("mismatch", Mismatch),
        Point("offline", Unavailable),
    ]
    registry = BenchmarkRegistry(tmp_path, points=points)
    assert registry.get("fixture").root == tmp_path.resolve()
    records = {row["id"]: row for row in registry.available()}
    assert records["fixture"]["available"] is True
    assert records["fixture"]["sdk_schema"] == SDK_SCHEMA
    for identity in ("duplicate", "broken", "mismatch", "offline"):
        assert records[identity]["available"] is False
        with pytest.raises(ContractError, match="unavailable"):
            registry.get(identity)
    public = json.dumps(registry.available(), sort_keys=True)
    assert "SECRET_PLUGIN_IMPORT_DETAIL" not in public
    assert "SECRET_AVAILABILITY_DETAIL" not in public
    with pytest.raises(ContractError) as unavailable:
        registry.get("broken")
    assert "SECRET_PLUGIN_IMPORT_DETAIL" not in str(unavailable.value)


def test_registry_validates_snapshot_tasks_and_reports_as_finite_json():
    registry = BenchmarkRegistry(points=[Point("fixture", Adapter)])
    adapter = registry.get("fixture")
    assert registry.snapshot(adapter)["evaluator_digest"] == "fixture-v1"
    assert registry.tasks(adapter, split="development", seed=3)[0]["id"].endswith("/3")
    assert registry.evaluate(adapter, {}, {}, {})["score"] == 1.0

    adapter.snapshot = lambda: {"bad": float("nan")}
    with pytest.raises(ContractError, match="finite JSON"):
        registry.snapshot(adapter)
    adapter.snapshot = lambda: {"id": "fixture"}
    adapter.tasks = lambda **_: [{"id": "invalid", "objective": "one",
                                  "inputs": {"bad": float("nan")}}]
    with pytest.raises(ContractError, match="finite JSON"):
        registry.tasks(adapter, split="development", seed=0)
    adapter.evaluate = lambda *_: {"status": "ok", "score_available": True,
                                   "score": float("inf")}
    with pytest.raises(ContractError, match="finite JSON"):
        registry.evaluate(adapter, {}, {}, {})
    adapter.evaluate = lambda *_: {"status": "unavailable", "score_available": False,
                                   "score": 1.0, "accepted": True}
    with pytest.raises(ContractError, match="cannot claim"):
        registry.evaluate(adapter, {}, {}, {})


def test_current_task_plugins_expose_explicit_descriptors_and_host_identity_is_separate():
    workbench = WorkbenchBenchmark()
    openfoam = OpenFOAMCavityBenchmark()
    assert workbench.descriptor.id == workbench.id
    assert "confirmatory" in workbench.descriptor.modes
    assert workbench.descriptor.allowed_suite_roles == ("qualification",)
    assert openfoam.descriptor.id == openfoam.id
    assert "confirmatory" not in openfoam.descriptor.modes
    assert openfoam.descriptor.allowed_suite_roles == ("demo_only",)
    assert "host_runtime" not in openfoam.snapshot()
    runtime = host_runtime_fingerprint()
    assert runtime["schema"] == "nexgent.task-benchmark-host-runtime.v1"
    assert {"benchmarks.py", "outcomes.py", "runtime.py", "tools.py",
            "store.py", "packages.py"} <= set(runtime["files"])


def test_benchmark_descriptor_defaults_to_demo_only_and_validates_roles():
    descriptor = BenchmarkDescriptor(
        id="safe-default", version="1", title="Safe default",
        splits=("development",), default_split="development")
    assert descriptor.allowed_suite_roles == ("demo_only",)
    assert descriptor.as_dict()["allowed_suite_roles"] == ["demo_only"]
    with pytest.raises(ContractError, match="suite roles"):
        BenchmarkDescriptor(
            id="unsafe", version="1", title="Unsafe",
            splits=("development",), default_split="development",
            allowed_suite_roles=("unregistered",))


def test_task_registration_freezes_host_runtime_separately_from_plugin_snapshot(
        tmp_path, monkeypatch):
    import nexgent.tasks.runtime as runtime_module

    adapter = Adapter()
    monkeypatch.setattr(runtime_module, "task_benchmarks", lambda: {adapter.id: adapter})
    package = make_package(
        {"main.py": (
            "def execute(payload, context):\n"
            "    artifact = context.publish({'score': 1.0}, name='result')\n"
            "    return {'deliverables': {'result': artifact['id']}}\n")},
        {"entries": {"execute": "main.py:execute"}},
        provenance={"fixture": "benchmark-sdk-host-runtime"})
    service = TaskService(tmp_path, tools=ToolRegistry())
    result = service.benchmark(adapter.id, package=package)
    episode_id = result["reports"][0]["episode_id"]
    registration = service.store.benchmark_registration(episode_id)
    assert registration["snapshot"] == adapter.snapshot()
    assert registration["host_runtime"]["schema"] == (
        "nexgent.task-benchmark-host-runtime.v1")
    monkeypatch.setattr(
        runtime_module, "host_runtime_fingerprint",
        lambda: {"schema": "nexgent.task-benchmark-host-runtime.changed", "files": {}})
    with pytest.raises(ContractError, match="frozen benchmark registration"):
        service.evaluate_registered(episode_id)


def test_host_runtime_is_host_owned_and_checked_before_execution_or_resume(
        tmp_path, monkeypatch):
    import nexgent.tasks.runtime as runtime_module

    package = make_package(
        {"main.py": "def execute(payload, context):\n    raise ValueError('agent failure')\n"},
        {"entries": {"execute": "main.py:execute"}},
        provenance={"fixture": "benchmark-host-closure"})
    service = TaskService(tmp_path, tools=ToolRegistry())
    registration = {"benchmark_id": "fixture", "task_ref": {"id": "fixture/one"},
                    "snapshot": {"id": "fixture", "version": 1}}
    with pytest.raises(ContractError, match="host runtime differs"):
        service.create(
            "reject forged host", package=package,
            benchmark_registration={**registration, "host_runtime": {"forged": True}})
    assert service.list() == []

    state = service.create("resume under one host", package=package,
                           benchmark_registration=registration)
    failed = service.run(state["id"])
    assert failed["status"] == "failed"
    adapter = Adapter()
    service.evaluate(state["id"], adapter, registration["task_ref"],
                     snapshot=registration["snapshot"])
    frozen_evaluation = service.get(state["id"])["evaluation"]
    monkeypatch.setattr(
        runtime_module, "host_runtime_fingerprint",
        lambda: {"schema": "nexgent.task-benchmark-host-runtime.changed", "files": {}})
    with pytest.raises(ContractError, match="before Episode execution or resume"):
        service.run(state["id"])
    assert service.get(state["id"])["evaluation"] == frozen_evaluation


def test_evaluator_exception_is_persisted_as_missing_without_error_text(
        tmp_path, monkeypatch):
    class BrokenEvaluator(Adapter):
        def evaluate(self, task_ref, deliverables, execution_view):
            raise RuntimeError("SECRET_EVALUATOR_FAILURE_DETAIL=C:/private/oracle")

    adapter = BrokenEvaluator()
    monkeypatch.setattr(
        "nexgent.tasks.runtime.task_benchmarks", lambda: {adapter.id: adapter})
    package = make_package(
        {"main.py": (
            "def execute(payload, context):\n"
            "    artifact = context.publish({'score': 1.0}, name='result')\n"
            "    return {'deliverables': {'result': artifact['id']}}\n")},
        {"entries": {"execute": "main.py:execute"}},
        provenance={"fixture": "benchmark-evaluator-unavailable"})
    service = TaskService(tmp_path, tools=ToolRegistry())
    result = service.benchmark(adapter.id, package=package)
    report = result["reports"][0]["evaluation"]
    assert report["status"] == "evaluator_unavailable"
    assert report["score_available"] is False and report["accepted"] is None
    assert "SECRET_EVALUATOR_FAILURE_DETAIL" not in json.dumps(result, sort_keys=True)
