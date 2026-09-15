"""Independent adversarial checks for the supported source language and ledger.

These tests exercise known boundaries; they do not certify an OS sandbox. The
worker fixture copies the current kernel into a temporary package with a pure,
minimal Toolbox so capability tests remain independent of numerical methods.
No test contacts a provider or runs model-generated source.
"""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import os
from pathlib import Path
import shutil
import threading
import time

import pytest

from nexgent.kernel import runner as runner_module
from nexgent.kernel.programs import ProgramError, make_bundle, validate_source, verify_bundle
from nexgent.kernel.runner import ProgramRunner
from nexgent.kernel.store import BudgetExhausted, Store


TASK = "def solve(problem, tools):\n    return {'answer': 3}\n"
META = "def improve(context, broker):\n    return {'candidates': []}\n"


def bundle(task=TASK, meta=META, **extra):
    return make_bundle({"task.py": task, "meta.py": meta, **extra})


@pytest.fixture
def source_runner(tmp_path, monkeypatch):
    package = tmp_path / "source" / "nexgent"
    original = Path(runner_module.__file__).parent
    shutil.copytree(original, package / "kernel", ignore=shutil.ignore_patterns("__pycache__"))
    (package / "__init__.py").write_text("", encoding="utf-8")
    science = package / "science"
    science.mkdir()
    (science / "__init__.py").write_text("", encoding="utf-8")
    (science / "toolbox.py").write_text(
        "class Toolbox:\n"
        "    def __init__(self, max_work_units=100):\n"
        "        self.work_units = 0\n"
        "        self.limit = max_work_units\n"
        "    def charge(self, amount):\n"
        "        self.work_units += amount\n"
        "        if self.work_units > self.limit:\n"
        "            raise RuntimeError('Numerical work budget exhausted')\n"
        "        return self.work_units\n"
        "    def receipts(self):\n"
        "        return []\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(runner_module, "__file__", str(package / "kernel" / "runner.py"))
    launched = []
    original_popen = runner_module.subprocess.Popen
    def track_process(*args, **kwargs):
        process = original_popen(*args, **kwargs)
        launched.append(process)
        return process
    monkeypatch.setattr(runner_module.subprocess, "Popen", track_process)
    yield ProgramRunner()
    assert all(process.poll() is not None for process in launched), "A source worker survived runner cleanup"


@pytest.mark.parametrize("source", [
    "import os\ndef solve(problem, tools): return 0",
    "from os import system\ndef solve(problem, tools): return 0",
    "def solve(problem, tools): return open('private.txt').read()",
    "def solve(problem, tools): return (1).__class__",
    "def solve(problem, tools): return getattr(math, 'sin')",
    "def solve(problem, tools): return '{0.__class__}'.format(1)",
    "def solve(problem, tools): return '{v.__class__}'.format_map({'v': 1})",
    "def solve(problem, tools): return (n for n in []).gi_frame",
    "def solve(problem, tools): return Exception().with_traceback(None)",
    "@math.sin\ndef solve(problem, tools): return 0",
    "class Sneaky: pass\ndef solve(problem, tools): return 0",
    "def solve(problem, tools):\n    match []:\n        case list(__reduce_ex__=reducer): return reducer(4)",
    "def solve(problem, tools):\n    match 0:\n        case int(__getattribute__=getter): return getter('__class__')",
])
def test_known_reflection_and_io_syntax_is_rejected(source):
    with pytest.raises(ProgramError):
        validate_source(source, "task.py")


@pytest.mark.parametrize("statement", [
    "broker.count = -100000",
    "broker.count -= 1",
    "del broker.count",
    "tools.work_units = 0",
    "tools.work_units -= 100000",
    "math.pi = 0",
])
def test_capability_attributes_cannot_be_mutated(statement):
    with pytest.raises(ProgramError):
        validate_source("def improve(context, broker):\n    " + statement + "\n", "meta.py")


def test_real_worker_executes_content_addressed_source(source_runner):
    program = bundle(task="def solve(problem, tools):\n    return {'answer': sum(problem['numbers'])}\n")
    result = source_runner.run(program, "solve_batch", {"problems": [{"numbers": [2, 3]}]}, timeout=5)
    assert result["value"] == [{"ok": True, "submission": {"answer": 5}}]
    assert result["execution"]["source_digest"] == program["digest"]
    assert result["execution"]["bundle_id"] == program["id"]
    assert result["execution"]["isolation"]["os_filesystem_container"] is False


def test_source_does_not_receive_environment_credentials(source_runner, monkeypatch):
    monkeypatch.setenv("NEXGENT_API_KEY", "private-test-value-never-sent")
    result = source_runner.run(bundle(), "solve_batch", {"problems": [{}]}, timeout=5)
    assert "private-test-value-never-sent" not in str(result)
    with pytest.raises(ProgramError):
        source_runner.run(bundle(task="import os\ndef solve(problem, tools): return os.environ"),
                          "solve_batch", {"problems": [{}]}, timeout=5)


def test_local_data_mutation_remains_available(source_runner):
    source = """def solve(problem, tools):
    values = [1, 2]
    values.append(3)
    values[0] = 4
    result = {'answer': sum(values)}
    result.update({'count': len(values)})
    return result
"""
    result = source_runner.run(bundle(task=source), "solve_batch", {"problems": [{}]}, timeout=5)
    assert result["value"][0]["submission"] == {"answer": 9, "count": 3}


def test_actual_numerical_facade_runs_under_audit_hook():
    source = """def solve(problem, tools):
    points = [[float(i)] for i in range(11)]
    smoothed = tools.smooth(points, window=5, degree=2)
    derivative = tools.differentiate(smoothed, 1.0, window=5, degree=2)
    features = tools.feature_matrix(smoothed, ['1', 'x0'])
    fitted = tools.linear_fit(features, derivative, ridge=0.0, threshold=0.0)
    receipts = tools.receipts()
    receipts[0]['work_units'] = -12345
    return {'coefficients': fitted['coefficients'], 'reported_work': tools.work_units}
"""
    result = ProgramRunner().run(bundle(task=source), "solve_batch", {"problems": [{}]},
                                 timeout=10, max_work_units=100000)
    task = result["value"][0]
    assert task["ok"], task
    assert task["submission"]["coefficients"][0][0] == pytest.approx(1.0, abs=1e-8)
    assert task["submission"]["coefficients"][0][1] == pytest.approx(0.0, abs=1e-8)
    assert result["execution"]["work_units"] > 0
    assert all(r["work_units"] >= 0 for r in result["execution"]["science_receipts"])


def test_cannot_reset_tool_budget_in_actual_worker(source_runner):
    source = """def solve(problem, tools):
    tools.charge(8)
    tools.work_units = 0
    tools.charge(8)
    return {'claimed_work': tools.work_units}
"""
    with pytest.raises(ProgramError):
        source_runner.run(bundle(task=source), "solve_batch", {"problems": [{}]},
                          max_work_units=10, timeout=5)


def test_cannot_reset_broker_rpc_budget_in_actual_worker(source_runner):
    source = """def improve(context, broker):
    for i in range(130):
        broker.count = 0
        broker.log('probe', i)
    return {'candidates': []}
"""
    received = []
    with pytest.raises(ProgramError):
        source_runner.run(bundle(meta=source), "improve", {}, timeout=5,
                          handler=lambda method, params: received.append((method, params)))
    assert len(received) <= 128


def test_timeout_bounds_pure_infinite_loop(source_runner):
    source = "def improve(context, broker):\n    while True:\n        pass\n"
    start = time.monotonic()
    with pytest.raises((TimeoutError, ProgramError)):
        source_runner.run(bundle(meta=source), "improve", {}, timeout=0.5)
    assert time.monotonic() - start < 3


def test_stop_terminates_pure_source_loop(source_runner):
    stop = threading.Event()
    timer = threading.Timer(0.3, stop.set)
    source = "def improve(context, broker):\n    while True:\n        pass\n"
    timer.start()
    start = time.monotonic()
    try:
        with pytest.raises(InterruptedError):
            source_runner.run(bundle(meta=source), "improve", {}, stop_event=stop, timeout=5)
    finally:
        timer.cancel()
        timer.join()
    assert time.monotonic() - start < 2


@pytest.mark.parametrize("catch_clause", ["except RuntimeError:", "except:"])
def test_instruction_budget_cannot_be_caught_and_disabled(source_runner, catch_clause):
    # Lower only the copied worker's threshold to reach the same failure path
    # quickly; a wall timeout must not hide a bypass of instruction accounting.
    copied_worker = Path(runner_module.__file__).with_name("worker.py")
    worker_text = copied_worker.read_text(encoding="utf-8")
    assert "instructions[0] > 2_000_000" in worker_text
    copied_worker.write_text(worker_text.replace("instructions[0] > 2_000_000", "instructions[0] > 2000"),
                             encoding="utf-8")
    source = """def improve(context, broker):
    try:
        value = 0
        while value < 10000:
            value += 1
    except RuntimeError:
        value = 0
        while value < 10000:
            value += 1
        return {'escaped_instruction_budget': True}
    return {'escaped_instruction_budget': False}
"""
    source = source.replace("except RuntimeError:", catch_clause)
    with pytest.raises(ProgramError, match="instruction budget"):
        source_runner.run(bundle(meta=source), "improve", {}, timeout=4)


def test_stop_interrupts_inflight_cooperative_capability(source_runner):
    stop, entered, finished = threading.Event(), threading.Event(), threading.Event()
    def handle(method, params):
        entered.set()
        try:
            if not stop.wait(3):
                raise AssertionError("Runner did not propagate cancellation")
            raise InterruptedError("Capability stopped")
        finally:
            finished.set()

    def cancel():
        if entered.wait(3):
            stop.set()

    canceller = threading.Thread(target=cancel)
    canceller.start()
    source = "def improve(context, broker):\n    return broker.log('probe', {})\n"
    try:
        with pytest.raises(InterruptedError):
            source_runner.run(bundle(meta=source), "improve", {}, handler=handle, stop_event=stop, timeout=4)
    finally:
        stop.set()
        canceller.join(timeout=1)
    assert entered.is_set()
    assert finished.wait(1)


def test_source_deadline_cancels_inflight_capability(source_runner):
    stop, entered, finished = threading.Event(), threading.Event(), threading.Event()
    def handle(method, params):
        entered.set()
        try:
            if not stop.wait(3):
                raise AssertionError("Source deadline did not reach its capability")
            raise InterruptedError("Capability deadline")
        finally:
            finished.set()

    source = "def improve(context, broker):\n    return broker.log('probe', {})\n"
    with pytest.raises(TimeoutError):
        source_runner.run(bundle(meta=source), "improve", {}, handler=handle, stop_event=stop, timeout=0.8)
    assert entered.is_set()
    assert stop.is_set()
    assert finished.wait(1)


@pytest.mark.skipif(os.name != "nt", reason="Checks the configured Windows process-commit ceiling")
def test_huge_allocation_fails_inside_memory_limited_worker(source_runner):
    result = source_runner.run(bundle(), "solve_batch", {"problems": [{}]}, timeout=5)
    memory = result["execution"]["isolation"]["memory_limit"]
    assert memory == {"kind": "process_commit", "bytes": 512 * 1024 * 1024}
    source = "def solve(problem, tools):\n    return 'x' * (2 ** 40)\n"
    result = source_runner.run(bundle(task=source), "solve_batch", {"problems": [{}]}, timeout=5)
    assert result["value"][0]["ok"] is False
    assert "MemoryError" in result["value"][0]["error"]


def test_excessive_return_value_is_rejected(source_runner):
    source = "def improve(context, broker):\n    return {'text': 'x' * 1600000}\n"
    with pytest.raises(ProgramError, match="output budget|output exceeded"):
        source_runner.run(bundle(meta=source), "improve", {}, timeout=5)


def test_every_source_component_changes_bundle_identity():
    base = bundle(**{"workflow.py": "def helper(): return 1\n", "roles.json": '{"critic":"A"}'})
    for name, replacement in {
        "task.py": TASK.replace("3", "4"),
        "meta.py": META.replace("[]", "[{}]"),
        "workflow.py": "def helper(): return 2\n",
        "roles.json": '{"critic":"B"}',
    }.items():
        changed = make_bundle({name: replacement}, parent=base)
        assert changed["digest"] != base["digest"]
        assert changed["component_digests"][name] != base["component_digests"][name]
        assert changed["parent_id"] == base["id"]
        assert changed["generation"] == 1


def test_tampered_source_or_component_digest_is_rejected():
    original = bundle()
    changed = deepcopy(original)
    changed["files"]["task.py"] = TASK.replace("3", "999")
    with pytest.raises(ProgramError):
        verify_bundle(changed)
    changed = deepcopy(original)
    changed["component_digests"]["task.py"] = "0" * 64
    with pytest.raises(ProgramError):
        verify_bundle(changed)


def test_stored_lineage_rejects_forged_generation(tmp_path):
    store = Store(tmp_path)
    parent = bundle()
    store.put_bundle(parent)
    child = make_bundle({"task.py": TASK.replace("3", "4")}, parent=parent)
    child["generation"] = 1000
    with pytest.raises((ProgramError, ValueError)):
        store.put_bundle(child)


def make_study(store, *, max_calls=3, max_tokens=30):
    identity = "study-0000000000000001"
    store.save({"id": identity, "status": "created", "budget": {
        "max_model_calls": max_calls, "max_completion_tokens": max_tokens}})
    return identity


def receipt(identity, tokens=10, status="started"):
    return {"call_id": identity, "status": status, "reserved_completion_tokens": tokens,
            "max_tokens": tokens}


def test_concurrent_model_admission_cannot_overspend(tmp_path):
    store = Store(tmp_path)
    study = make_study(store)
    barrier = threading.Barrier(8)

    def admit(index):
        barrier.wait(timeout=3)
        try:
            store.reserve(study, receipt(f"request-{index}"))
            return "reserved"
        except BudgetExhausted:
            return "rejected"

    with ThreadPoolExecutor(max_workers=8) as pool:
        outcomes = list(pool.map(admit, range(8)))
    assert outcomes.count("reserved") == 3
    assert outcomes.count("rejected") == 5
    assert len(store.calls(study)) == 3


def test_terminal_receipt_cannot_refund_original_reservation(tmp_path):
    store = Store(tmp_path)
    study = make_study(store, max_tokens=15)
    store.reserve(study, receipt("first"))
    store.reserve(study, receipt("first", tokens=1, status="failed"))
    assert store.calls(study)[0]["reserved_completion_tokens"] == 10
    with pytest.raises(BudgetExhausted):
        store.reserve(study, receipt("second"))


def test_reopen_and_status_save_do_not_reset_spent_budget(tmp_path):
    store = Store(tmp_path)
    study = make_study(store, max_calls=1, max_tokens=10)
    store.reserve(study, receipt("spent-before-crash"))
    reopened = Store(tmp_path)
    snapshot = reopened.get(study)
    snapshot["status"] = "running"
    reopened.save(snapshot)
    with pytest.raises(BudgetExhausted):
        reopened.reserve(study, receipt("second-after-restart"))
    assert reopened.calls(study)[0]["status"] == "started"


def test_unreserved_terminal_receipt_is_rejected(tmp_path):
    store = Store(tmp_path)
    study = make_study(store)
    with pytest.raises(ValueError, match="reserve"):
        store.reserve(study, receipt("never-sent", status="received"))
    assert store.calls(study) == []


def test_evaluation_cache_binds_source_evaluator_seed_protocol_and_budget(tmp_path):
    from nexgent.evolution.controller import StudyController

    class Benchmark:
        evaluator_digest = "frozen-evaluator-A"
        def __init__(self): self.calls = []
        def evaluate(self, program, split, seed, runner, **kwargs):
            self.calls.append((program["digest"], self.evaluator_digest, seed, kwargs["max_work_units"]))
            return {"score": 0.5, "status": "ok", "split": split, "seed": seed, "work_units": 10,
                    "evaluator_digest": self.evaluator_digest, "suite_digest": f"suite-{split}-{seed}",
                    "tasks": [{"task_id": "task-one", "score": 0.5}]}

    benchmark = Benchmark()
    controller = StudyController(tmp_path, benchmark=benchmark)
    created = controller.create("Cache identity audit", generations=1)
    state = controller.store.get(created["id"])
    first = bundle()
    changed = make_bundle({"task.py": TASK.replace("3", "4")}, parent=first)
    controller._measure(state, first, "development", 0)
    controller._measure(state, first, "development", 0)
    assert len(benchmark.calls) == 1
    controller._measure(state, changed, "development", 0)
    assert len(benchmark.calls) == 2
    benchmark.evaluator_digest = "frozen-evaluator-B"
    controller._measure(state, changed, "development", 0)
    assert len(benchmark.calls) == 3
    state["budget"]["max_work_units_per_evaluation"] += 1
    controller._measure(state, changed, "development", 0)
    assert len(benchmark.calls) == 4
    state["protocol"] = {**state["protocol"], "version": "new-registered-protocol"}
    controller._measure(state, changed, "development", 0)
    assert len(benchmark.calls) == 5
    controller._measure(state, changed, "development", 1)
    assert len(benchmark.calls) == 6
    reopened = StudyController(tmp_path, benchmark=benchmark)
    recovered = reopened.store.get(state["id"])
    reopened._measure(recovered, changed, "development", 1)
    assert len(benchmark.calls) == 6
    assert recovered["evaluation_count"] == 6
