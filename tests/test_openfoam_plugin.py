"""OpenFOAM plugin contracts with faked processes; real CFD is provider-gated."""

from copy import deepcopy
import ast
import io
import inspect
import json
import os
from pathlib import Path
import sys
import threading

import pytest


ROOT = Path(__file__).resolve().parents[1]
PLUGIN_ROOT = ROOT / "benchmarks" / "openfoam"
sys.path.insert(0, str(PLUGIN_ROOT / "src"))
sys.path.insert(0, str(ROOT / "src"))

from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService, ToolContext
from nexgent.tasks.tools import ToolRegistry, validate
from nexgent_openfoam import (
    OpenFOAMCavityBenchmark,
    OpenFOAMCavityDomain,
    prepare_cavity,
    probe_environment,
    run_cavity,
    validate_delivery,
)
import nexgent_openfoam.plugin as openfoam_plugin
import nexgent_openfoam.runner as openfoam_runner
from nexgent_openfoam.data import digest, inputs_for
from nexgent_openfoam.runner import (
    OpenFOAMRunError,
    discover_environment,
    execute_case,
)
from nexgent_openfoam.schemas import SPEC_SCHEMA, validation_errors


class ContractContext:
    """Small host double for artifact, workspace, stop, and once contracts."""

    def __init__(self, task, workspace, *, claims=None):
        self.task = deepcopy(task)
        self.stop_event = threading.Event()
        self._workspace = Path(workspace)
        self.claims = set() if claims is None else claims
        self.artifacts = {
            name: {"id": name, "content": deepcopy(value)}
            for name, value in task.get("inputs", {}).items()
        }

    def check_stop(self):
        if self.stop_event.is_set():
            raise InterruptedError("contract stop")

    def read_artifact(self, ref):
        return deepcopy(self.artifacts[ref])

    def publish(self, content, name=None, schema="application/json"):
        ref = name or f"artifact-{len(self.artifacts)}"
        artifact = {"id": ref, "content": deepcopy(content), "schema": schema}
        self.artifacts[ref] = artifact
        return deepcopy(artifact)

    def once(self, key):
        if key in self.claims:
            return False
        self.claims.add(key)
        return True

    def workspace(self, namespace):
        assert namespace == "openfoam"
        self._workspace.mkdir(parents=True, exist_ok=True)
        return self._workspace


def test_optional_distribution_owns_entry_points_and_core_has_no_cfd_imports():
    pyproject = (PLUGIN_ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert 'openfoam_cavity = "nexgent_openfoam.plugin:domain_pack"' in pyproject
    assert 'openfoam_cavity = "nexgent_openfoam.plugin:benchmark_adapter"' in pyproject

    forbidden = ("nexgent_openfoam", "openfoam", "pyfoam")
    for source_path in (ROOT / "src" / "nexgent").rglob("*.py"):
        tree = ast.parse(source_path.read_text(encoding="utf-8"), filename=str(source_path))
        imports = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.extend(alias.name.lower() for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imports.append(node.module.lower())
        assert not any(name.startswith(forbidden) for name in imports), source_path


@pytest.mark.parametrize("mutation", [
    {"template_relpath": "../../etc/passwd"},
    {"commands": [["sh", "-c", "touch injected"]]},
    {"kinematic_viscosity_m2_per_s": float("nan")},
    {"expected_cell_count": True},
    {"expected_end_time": 10 ** 9},
    {"solver": "icoFoam; rm -rf case"},
])
def test_frozen_spec_schema_rejects_path_command_and_numeric_injection(mutation):
    spec = inputs_for()["spec"]
    spec.update(mutation)
    assert validation_errors(spec, SPEC_SCHEMA, "spec")


def test_domain_tool_schemas_are_closed_and_refs_are_the_only_path_like_inputs():
    tools = {tool.name: tool for tool in OpenFOAMCavityDomain().tools()}
    assert set(tools) == {
        "openfoam.probe_environment", "openfoam.prepare_cavity",
        "openfoam.run_cavity", "openfoam.validate_delivery",
    }
    valid_arguments = {
        "openfoam.probe_environment": {},
        "openfoam.prepare_cavity": {"spec_ref": "spec"},
        "openfoam.run_cavity": {"case_ref": "case"},
        "openfoam.validate_delivery": {
            "run_manifest_ref": "run_manifest",
            "verification_report_ref": "verification_report",
        },
    }
    for name, tool in tools.items():
        validate(valid_arguments[name], tool.input_schema, label=name)
        injected = {**valid_arguments[name], "command": "sh -c 'touch escaped'"}
        with pytest.raises(Exception):
            validate(injected, tool.input_schema, label=name)


def test_prepare_rejects_tampered_path_spec_before_environment_or_workspace(tmp_path):
    task = OpenFOAMCavityBenchmark().tasks()[0]
    context = ContractContext(task, tmp_path / "must-not-exist")
    malicious = deepcopy(task["inputs"]["spec"])
    malicious["template_relpath"] = "../../outside"
    context.artifacts["malicious"] = {"id": "malicious", "content": malicious}
    with pytest.raises(ValueError, match="template_relpath|frozen"):
        prepare_cavity({"spec_ref": "malicious"}, context)
    assert not context._workspace.exists()


def test_environment_probe_reports_missing_runtime_without_claiming_a_run():
    result = discover_environment({}, which=lambda _name: None).public()
    assert result["available"] is False and result["status"] == "unavailable"
    assert result["foundation_version"] is None and result["template"] is None
    assert {
        "foundation_version_8_required", "foundation_project_marker_required",
        "official_cavity_template_missing", "executable_missing:blockMesh",
        "executable_missing:checkMesh", "executable_missing:icoFoam",
    } <= set(result["reasons"])
    assert "run" not in result and "solver_succeeded" not in result


class _ImmediateProcess:
    def __init__(self, output):
        self.stdout = io.BytesIO(output)
        self.returncode = 0

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        self.returncode = -9


def test_runner_uses_fixed_argv_no_shell_and_bounded_output(tmp_path):
    case = tmp_path / "managed-case"
    case.mkdir()
    executables = {}
    for name in ("blockMesh", "checkMesh", "icoFoam"):
        executable = tmp_path / name
        executable.write_bytes(b"test executable")
        executables[name] = executable
    calls = []

    def popen(argv, **kwargs):
        calls.append((argv, kwargs))
        return _ImmediateProcess((argv[0].encode("utf-8") + b"\n") * 1200)

    receipt = execute_case(
        case, executables, timeout_s=1, output_limit=4096,
        popen_factory=popen,
    )
    assert len(calls) == 3
    for (argv, kwargs), program in zip(calls, ("blockMesh", "checkMesh", "icoFoam")):
        assert isinstance(argv, list) and argv == [str(executables[program]), "-case", str(case)]
        assert kwargs["shell"] is False and kwargs["cwd"] == str(case)
        assert "timeout" not in kwargs
    assert receipt["timeout_seconds_per_command"] == 1
    assert receipt["output_limit_bytes_per_command"] == 4096
    assert all(row["output_truncated"] for row in receipt["commands"])
    assert all(len(row["output_preview"].encode("utf-8")) < row["output_bytes"]
               for row in receipt["commands"])


def test_runner_enforces_timeout_and_rejects_unbounded_limits(tmp_path):
    executable = tmp_path / "blockMesh"
    executable.write_bytes(b"test executable")
    executables = {name: executable for name in ("blockMesh", "checkMesh", "icoFoam")}
    case = tmp_path / "case"
    case.mkdir()

    with pytest.raises(ValueError, match="timeout_s"):
        execute_case(case, executables, timeout_s=0)
    with pytest.raises(ValueError, match="output_limit"):
        execute_case(case, executables, output_limit=10 ** 9)

    clock = iter((0.0, 0.0, 2.0, 2.0))

    class HangingProcess(_ImmediateProcess):
        def __init__(self):
            super().__init__(b"")
            self.returncode = None

        def poll(self):
            return self.returncode

        def kill(self):
            self.returncode = -9

    with pytest.raises(OpenFOAMRunError, match="timeout"):
        execute_case(
            case, executables, timeout_s=1,
            popen_factory=lambda *args, **kwargs: HangingProcess(),
            monotonic=lambda: next(clock),
        )


def test_runner_cancellation_escalates_to_kill_and_uses_bounded_wait(tmp_path):
    executable = tmp_path / "blockMesh"
    executable.write_bytes(b"test executable")
    environment = {name: executable for name in ("blockMesh", "checkMesh", "icoFoam")}
    case = tmp_path / "case"
    case.mkdir()

    class StubbornProcess(_ImmediateProcess):
        def __init__(self):
            super().__init__(b"")
            self.returncode = None
            self.terminated = False
            self.killed = False

        def terminate(self):
            self.terminated = True

        def wait(self, timeout=None):
            if self.returncode is None:
                raise openfoam_runner.subprocess.TimeoutExpired("blockMesh", timeout)
            return self.returncode

        def kill(self):
            self.killed = True
            self.returncode = -9

    process = StubbornProcess()
    with pytest.raises(InterruptedError, match="stop"):
        execute_case(
            case, environment, popen_factory=lambda *args, **kwargs: process,
            check_stop=lambda: (_ for _ in ()).throw(InterruptedError("contract stop")),
        )
    assert process.terminated and process.killed


@pytest.mark.skipif(os.name != "nt", reason="WSL argv uses Windows drive paths")
def test_wsl_runner_passes_case_program_and_timeout_as_positional_argv(tmp_path):
    case = tmp_path / "case with ; shell chars"
    case.mkdir()
    launcher = tmp_path / "wsl.exe"
    launcher.write_bytes(b"fake")
    environment = openfoam_runner.EnvironmentProbe(
        True, "wsl", "8", "OpenFOAM", openfoam_runner.WSL_TEMPLATE,
        {name: Path(f"/opt/openfoam8/bin/{name}") for name in openfoam_runner.PROGRAMS},
        (), launcher,
    )
    calls = []

    def popen(argv, **kwargs):
        calls.append((argv, kwargs))
        return _ImmediateProcess(b"ok\n")

    execute_case(case, environment, timeout_s=7, popen_factory=popen)
    assert len(calls) == 3
    wsl_case = openfoam_runner.windows_path_to_wsl(case)
    for (argv, kwargs), program in zip(calls, openfoam_runner.PROGRAMS):
        assert argv[:8] == [
            str(launcher), "-d", openfoam_runner.WSL_DISTRIBUTION, "--exec", "/bin/bash",
            "--noprofile", "--norc", "-c",
        ]
        assert argv[8] == openfoam_runner.WSL_TOOL_SCRIPT
        assert argv[9:] == ["nexgent-openfoam-run", wsl_case, program, "7"]
        assert kwargs["shell"] is False


def test_prepare_removes_failed_staging_before_retry(tmp_path, monkeypatch):
    task = OpenFOAMCavityBenchmark().tasks()[0]
    context = ContractContext(task, tmp_path / "work")
    environment = openfoam_runner.EnvironmentProbe(
        True, "native", "8", "OpenFOAM", tmp_path / "template",
        {name: tmp_path / name for name in openfoam_runner.PROGRAMS}, (),
    )
    monkeypatch.setattr(openfoam_plugin.runner, "discover_environment", lambda: environment)
    attempts = []

    def flaky_copy(_environment, destination):
        attempts.append(Path(destination))
        Path(destination).mkdir(parents=True)
        (Path(destination) / "partial").write_text("partial", encoding="utf-8")
        if len(attempts) == 1:
            raise RuntimeError("copy interrupted")
        return digest({"template": "complete"})

    monkeypatch.setattr(openfoam_plugin.runner, "copy_official_template", flaky_copy)
    with pytest.raises(RuntimeError, match="copy interrupted"):
        prepare_cavity({"spec_ref": "spec"}, context)
    assert not list((context._workspace / "jobs").glob(".preparing-*"))
    prepared = prepare_cavity({"spec_ref": "spec"}, context)
    assert prepared["status"] == "prepared"
    assert not list((context._workspace / "jobs").glob(".preparing-*"))


def test_smoke_identity_is_frozen_to_one_real_scenario_and_seed():
    benchmark = OpenFOAMCavityBenchmark()
    normal = benchmark.tasks("smoke", 0)
    assert normal == benchmark.tasks("smoke", 0)
    assert normal[0]["inputs"] == inputs_for("smoke", 0)
    assert normal[0]["context"]["scenario"] == "cavity_re10"
    assert benchmark.tasks("smoke", 0, controlled_failure=True)[0]["id"] != normal[0]["id"]
    for split, seed in (("development", 0), ("smoke", 1), ("smoke", True)):
        with pytest.raises(ValueError):
            benchmark.tasks(split, seed)
    snapshot = benchmark.snapshot()
    assert snapshot == benchmark.snapshot()
    assert snapshot["frozen_input_digest"] == digest(inputs_for())


def test_snapshot_binds_schemas_tools_runner_evaluator_and_task_contract(monkeypatch):
    benchmark = OpenFOAMCavityBenchmark()
    original = benchmark.snapshot()["evaluator_digest"]
    real_getsource = openfoam_plugin.inspect.getsource
    observed = []

    def changed_getsource(subject):
        observed.append(subject)
        source = real_getsource(subject)
        if subject in (openfoam_plugin.validate_delivery, openfoam_plugin.runner):
            return source + "\n# simulated OpenFOAM contract revision\n"
        return source

    monkeypatch.setattr(openfoam_plugin.inspect, "getsource", changed_getsource)
    assert benchmark.snapshot()["evaluator_digest"] != original
    module_names = {getattr(subject, "__name__", "") for subject in observed
                    if inspect.ismodule(subject)}
    assert {
        "nexgent_openfoam._evaluation", "nexgent_openfoam.schemas",
        "nexgent_openfoam.data", "nexgent_openfoam.runner",
    } <= module_names
    assert {
        openfoam_plugin.probe_environment, openfoam_plugin.prepare_cavity,
        openfoam_plugin.run_cavity, openfoam_plugin.validate_delivery,
        openfoam_plugin.OpenFOAMCavityDomain.tools,
        openfoam_plugin.OpenFOAMCavityBenchmark.tasks,
        openfoam_plugin.OpenFOAMCavityBenchmark.evaluate,
        ToolContext.workspace,
    } <= set(observed)
    assert TaskService._invoke in observed
    assert TaskService.evaluate in observed


def test_public_tools_and_contracts_do_not_expose_acceptance_or_hidden_oracle():
    benchmark = OpenFOAMCavityBenchmark()
    task = benchmark.tasks()[0]
    public = {
        "task": task,
        "domain": OpenFOAMCavityDomain().describe(),
        "tools": [tool.describe() for tool in OpenFOAMCavityDomain().tools()],
    }
    encoded = json.dumps(public, sort_keys=True).lower()
    for forbidden in ("expected_delivery", "hidden_oracle", "accepted_answer", "private_score"):
        assert forbidden not in encoded
    public_handler_source = "\n".join(inspect.getsource(tool.handler)
                                       for tool in OpenFOAMCavityDomain().tools())
    assert "_evaluation" not in public_handler_source
    assert "expected_delivery" not in public_handler_source
    for tool in OpenFOAMCavityDomain().tools():
        assert not ({"accepted", "score", "oracle", "expected"}
                    & set(tool.output_schema.get("properties", {})))
    assert set(task["inputs"]) == {"spec"}
    assert set(item["name"] for item in task["deliverables"]) == {
        "run_manifest", "verification_report",
    }


def _valid_run_documents():
    command_outputs = {
        "blockMesh": "Creating polyMesh\n",
        "checkMesh": "cells: 400\nMesh OK.\n",
        "icoFoam": "Time = 0.5\nEnd\nSolving for Ux\n",
    }
    commands = []
    for program in ("blockMesh", "checkMesh", "icoFoam"):
        raw = command_outputs[program]
        commands.append({
            "program": program,
            "argv": [program, "-case", "<managed-case>"],
            "returncode": 0,
            "duration_ms": 1,
            "output_bytes": len(raw.encode("utf-8")),
            "output_digest": digest({"program": program, "output": raw}),
            "output_preview": raw,
            "output_truncated": False,
            "timed_out": False,
        })
    resources = {
        "timeout_seconds_per_command": 60,
        "output_limit_bytes_per_command": 65536,
        "command_count": 3,
        "wall_time_ms": 3,
        "commands": commands,
    }
    fields = [{
        "name": name,
        "path": f"0.5/{name}",
        "digest": digest({"field": name}),
        "class": "volVectorField" if name == "U" else "volScalarField",
        "dimensions": "[0 1 -1 0 0 0 0]" if name == "U" else "[0 2 -2 0 0 0 0]",
        "value_count": 400,
        "finite": True,
        "minimum": 0.0,
        "maximum": 1.0,
    } for name in ("U", "p")]
    case_receipt = {
        "job_digest": digest({"job": "fake"}),
        "spec_digest": digest(inputs_for()["spec"]),
        "template_digest": digest({"template": "fake"}),
        "case_digest": digest({"case": "before"}),
        "execution_backend": "native",
    }
    documents = openfoam_runner.make_run_documents(
        case_receipt, resources,
        {"mesh": {"cell_count": 400, "mesh_ok": True},
         "solver": {"end_time": 0.5, "completed": True,
                    "residual_lines_observed": 1, "residual_scan_complete": True},
         "fields": fields},
        digest({"case": "after"}),
    )
    return case_receipt, documents


def _accepted_execution(tmp_path, *, recovery=False):
    benchmark = OpenFOAMCavityBenchmark()
    task = benchmark.tasks(controlled_failure=recovery)[0]
    context = ContractContext(task, tmp_path / "openfoam")
    case_receipt, delivery = _valid_run_documents()
    job_root = context.workspace("openfoam") / "jobs" / case_receipt["job_digest"]
    job_root.mkdir(parents=True)
    openfoam_runner.write_json(job_root / "run.json", delivery)
    for name, value in delivery.items():
        context.publish(value, name=name)
    validated = validate_delivery({
        "run_manifest_ref": "run_manifest",
        "verification_report_ref": "verification_report",
    }, context)
    assert validated["valid"]
    prepared = {
        "status": "prepared", "reason": None,
        "retryable": False, "feedback": None,
        "spec_digest": case_receipt["spec_digest"],
        "template_digest": case_receipt["template_digest"],
        "job_digest": case_receipt["job_digest"],
        "case_ref": "case",
    }
    receipts = [
        {"name": "openfoam.probe_environment", "status": "completed",
         "result": {"available": True}},
        {"name": "openfoam.prepare_cavity", "status": "completed", "result": prepared},
        {"name": "openfoam.run_cavity", "status": "completed", "result": deepcopy(delivery)},
        {"name": "openfoam.validate_delivery", "status": "completed", "result": validated},
    ]
    if recovery:
        receipts.insert(1, {
            "name": "openfoam.prepare_cavity", "status": "completed",
            "result": {"status": "contract_rejected", "reason": "synthetic_once_only_rejection",
                       "retryable": True,
                       "feedback": ("Synthetic once-only contract rejection: the frozen spec "
                                    "remains valid; retry prepare_cavity with the same spec_ref."),
                       "spec_digest": case_receipt["spec_digest"]},
        })
    view = {"inputs": deepcopy(task["inputs"]), "tool_calls": receipts}
    return benchmark, task, delivery, view


@pytest.mark.parametrize("tool_name,reason", [
    ("openfoam.probe_environment", "available_environment_probe_missing"),
    ("openfoam.prepare_cavity", "matching_case_preparation_missing"),
    ("openfoam.run_cavity", "matching_real_run_receipt_missing"),
    ("openfoam.validate_delivery", "matching_delivery_validation_missing"),
])
def test_evaluator_requires_environment_prepare_solver_and_final_validation_receipts(
        tmp_path, tool_name, reason):
    benchmark, task, delivery, view = _accepted_execution(tmp_path)
    assert benchmark.evaluate(task["id"], delivery, view)["accepted"]
    view["tool_calls"] = [row for row in view["tool_calls"] if row["name"] != tool_name]
    report = benchmark.evaluate(task["id"], delivery, view)
    assert not report["accepted"] and reason in report["reasons"]


def test_evaluator_requires_mesh_solver_checks_and_validation_of_final_digest(tmp_path):
    benchmark, task, delivery, view = _accepted_execution(tmp_path)
    changed = deepcopy(delivery)
    changed["verification_report"]["mesh"]["cell_count"] = 399
    changed["verification_report"]["checks"][2]["passed"] = False
    changed["verification_report"]["status"] = "failed"
    view["tool_calls"] = [row for row in view["tool_calls"]
                          if row["name"] != "openfoam.run_cavity"] + [{
                              "name": "openfoam.run_cavity", "status": "completed",
                              "result": deepcopy(changed),
                          }]
    report = benchmark.evaluate(task["id"], changed, view)
    assert not report["accepted"] and "smoke_checks_failed" in report["reasons"]

    benchmark, task, delivery, view = _accepted_execution(tmp_path / "digest")
    delivery["verification_report"]["scope"] += " tampered"
    report = benchmark.evaluate(task["id"], delivery, view)
    assert not report["accepted"]
    assert "matching_real_run_receipt_missing" in report["reasons"]
    assert "matching_delivery_validation_missing" in report["reasons"]


def test_evaluator_independently_binds_manifest_to_frozen_spec(tmp_path):
    benchmark, task, delivery, view = _accepted_execution(tmp_path)
    changed = deepcopy(delivery)
    changed["run_manifest"]["spec_digest"] = digest({"tampered": True})
    for receipt in view["tool_calls"]:
        if receipt["name"] == "openfoam.run_cavity":
            receipt["result"] = deepcopy(changed)
        elif receipt["name"] == "openfoam.validate_delivery":
            receipt["result"]["delivery_digest"] = digest(changed)
    report = benchmark.evaluate(task["id"], changed, view)
    assert not report["accepted"]
    assert "run_not_bound_to_frozen_spec" in report["reasons"]


def test_controlled_prepare_rejection_is_once_only_and_receipt_count_is_exact(
        tmp_path, monkeypatch):
    task = OpenFOAMCavityBenchmark().tasks(controlled_failure=True)[0]
    context = ContractContext(task, tmp_path / "work")
    template = tmp_path / "template"
    required = {
        "0/U": "field", "0/p": "field",
        "constant/transportProperties": "nu [0 2 -1 0 0 0 0] 0.01;\n",
        "system/blockMeshDict": "mesh", "system/controlDict": "application icoFoam;\n",
        "system/fvSchemes": "schemes", "system/fvSolution": "solution",
    }
    for relative, content in required.items():
        path = template / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    executables = {}
    for name in ("blockMesh", "checkMesh", "icoFoam"):
        path = tmp_path / name
        path.write_bytes(b"fake")
        executables[name] = path
    available = openfoam_runner.EnvironmentProbe(
        True, "native", "8", "OpenFOAM", template, executables, ())
    monkeypatch.setattr(openfoam_plugin.runner, "discover_environment", lambda: available)

    first = prepare_cavity({"spec_ref": "spec"}, context)
    second = prepare_cavity({"spec_ref": "spec"}, context)
    third = prepare_cavity({"spec_ref": "spec"}, context)
    assert first["status"] == "contract_rejected"
    assert first["reason"] == "synthetic_once_only_rejection"
    assert first["retryable"] is True
    assert "retry prepare_cavity with the same spec_ref" in first["feedback"]
    assert second["status"] == third["status"] == "prepared"
    assert second["job_digest"] == third["job_digest"]

    benchmark, frozen, delivery, view = _accepted_execution(tmp_path / "accepted", recovery=True)
    assert benchmark.evaluate(frozen["id"], delivery, view)["accepted"]
    view["tool_calls"][1], view["tool_calls"][2] = view["tool_calls"][2], view["tool_calls"][1]
    report = benchmark.evaluate(frozen["id"], delivery, view)
    assert not report["accepted"]
    assert "controlled_prepare_rejection_count_mismatch" in report["reasons"]
    view["tool_calls"][1], view["tool_calls"][2] = view["tool_calls"][2], view["tool_calls"][1]
    view["tool_calls"].insert(1, deepcopy(view["tool_calls"][1]))
    report = benchmark.evaluate(frozen["id"], delivery, view)
    assert not report["accepted"]
    assert report["metrics"]["controlled_rejection_count"] == 2
    assert "controlled_prepare_rejection_count_mismatch" in report["reasons"]


def _task_service_smoke_package():
    return make_package({"main.py": """def execute(payload, context):
    probe = context.tool('openfoam.probe_environment', {})
    if not probe['available']:
        raise RuntimeError('OpenFOAM environment unavailable after successful provider gate')
    prepared = context.tool('openfoam.prepare_cavity', {'spec_ref': payload['input_refs']['spec']})
    if prepared['status'] == 'contract_rejected':
        if not prepared['retryable']:
            raise RuntimeError('controlled rejection did not authorize retry')
        prepared = context.tool('openfoam.prepare_cavity', {'spec_ref': payload['input_refs']['spec']})
    if prepared['status'] != 'prepared':
        raise RuntimeError('case was not prepared')
    delivery = context.tool('openfoam.run_cavity', {'case_ref': prepared['case_ref']})
    manifest = context.publish(delivery['run_manifest'], name='run_manifest')
    report = context.publish(delivery['verification_report'], name='verification_report')
    checked = context.tool('openfoam.validate_delivery', {
        'run_manifest_ref': manifest['id'],
        'verification_report_ref': report['id'],
    })
    if not checked['valid']:
        raise RuntimeError('final managed delivery validation failed')
    return {
        'deliverables': {
            'run_manifest': manifest['id'],
            'verification_report': report['id'],
        },
        'summary': 'Executed the fixed OpenFOAM smoke workflow and recovered once.',
    }
"""}, {"entries": {"execute": "main.py:execute"}})


def test_real_task_service_smoke_package_is_validated_without_running_provider():
    package = _task_service_smoke_package()
    source = package["files"]["main.py"]
    assert "context.ask" not in source
    assert source.count("context.tool") == 5
    assert package["manifest"]["entries"] == {"execute": "main.py:execute"}


@pytest.mark.provider
def test_real_openfoam_smoke_is_explicitly_opt_in(tmp_path):
    """One real solver path is available to providers, never part of default tests."""
    if os.environ.get("NEXGENT_OPENFOAM_REAL_TEST", "") != "1":
        pytest.skip("set NEXGENT_OPENFOAM_REAL_TEST=1 in a configured Foundation 8 shell")
    probe = discover_environment()
    if not probe.available:
        pytest.skip("OpenFOAM Foundation 8 environment is unavailable")
    benchmark = OpenFOAMCavityBenchmark()
    task = benchmark.tasks()[0]
    context = ContractContext(task, tmp_path / "real-openfoam")
    probed = probe_environment({}, context)
    prepared = prepare_cavity({"spec_ref": "spec"}, context)
    delivery = run_cavity({"case_ref": prepared["case_ref"]}, context)
    for name, value in delivery.items():
        context.publish(value, name=name)
    validated = validate_delivery({
        "run_manifest_ref": "run_manifest",
        "verification_report_ref": "verification_report",
    }, context)
    view = {"inputs": deepcopy(task["inputs"]), "tool_calls": [
        {"name": "openfoam.probe_environment", "status": "completed", "result": probed},
        {"name": "openfoam.prepare_cavity", "status": "completed", "result": prepared},
        {"name": "openfoam.run_cavity", "status": "completed", "result": delivery},
        {"name": "openfoam.validate_delivery", "status": "completed", "result": validated},
    ]}
    assert benchmark.evaluate(task["id"], delivery, view)["accepted"]


@pytest.mark.provider
def test_real_openfoam_recovery_smoke_runs_through_task_service_and_evaluator(tmp_path):
    """Opt-in vertical check: controlled package, task runtime, WSL, and evaluator."""
    if os.environ.get("NEXGENT_OPENFOAM_REAL_TEST", "") != "1":
        pytest.skip("set NEXGENT_OPENFOAM_REAL_TEST=1 in a configured Foundation 8 shell")
    probe = discover_environment()
    if not probe.available:
        pytest.skip("OpenFOAM Foundation 8 environment is unavailable")

    benchmark = OpenFOAMCavityBenchmark()
    task = benchmark.tasks(controlled_failure=True)[0]
    package = _task_service_smoke_package()
    service = TaskService(
        tmp_path / "task-service",
        tools=ToolRegistry(OpenFOAMCavityDomain().tools()),
    )
    state = service.create(
        task["objective"], task["inputs"], task["deliverables"],
        capabilities=task["capabilities"], package=package,
        context=task["context"], constraints=task["constraints"],
    )
    completed = service.run(state["id"])
    assert completed["status"] == "completed", completed.get("last_error")
    evaluated = service.evaluate(
        state["id"], benchmark, task, snapshot=benchmark.snapshot())
    assert evaluated["evaluation"]["accepted"], evaluated["evaluation"]
    tool_calls = [event["content"] for event in service.get(state["id"])["events"]
                  if event["kind"] == "tool"]
    assert [row["name"] for row in tool_calls] == [
        "openfoam.probe_environment",
        "openfoam.prepare_cavity",
        "openfoam.prepare_cavity",
        "openfoam.run_cavity",
        "openfoam.validate_delivery",
    ]
