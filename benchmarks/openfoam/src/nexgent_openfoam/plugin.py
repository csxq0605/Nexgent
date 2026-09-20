"""Optional Foundation OpenFOAM 8 cavity domain and receipt-bound benchmark."""

from __future__ import annotations

from copy import deepcopy
import inspect
import os
from pathlib import Path
import re

from .data import SCENARIO, SPLITS, TEMPLATE_RELPATH, VERSION, digest, inputs_for
from .schemas import (
    DELIVERY_SCHEMAS, PARAMETER_SCHEMA, PREPARE_SCHEMA, PROBE_SCHEMA,
    RUN_RESULT_SCHEMA, SPEC_SCHEMA, VALIDATION_SCHEMA, delivery_schema_errors,
    obj, validation_errors,
)
from . import runner


def _content(context, ref):
    artifact = context.read_artifact(ref)
    if not isinstance(artifact, dict) or "content" not in artifact:
        raise ValueError("Artifact reference did not resolve to content")
    return artifact["content"]


def _provenance(backend=None):
    return {
        "foundation": "OpenFOAM Foundation",
        "version": "8",
        "backend": backend,
        "template_relpath": TEMPLATE_RELPATH,
        "copy_mode": "bounded_regular_files",
    }


def probe_environment(arguments, context):
    context.check_stop()
    return runner.discover_environment().public()


def _validate_frozen_spec(spec, context):
    errors = validation_errors(spec, SPEC_SCHEMA, "spec")
    if errors:
        raise ValueError("; ".join(errors))
    frozen = context.task.get("inputs", {}).get("spec")
    if not isinstance(frozen, dict) or digest(spec) != digest(frozen):
        raise ValueError("spec_ref must resolve to the frozen task input")


def _job_root(context, job_digest):
    if not re.fullmatch(r"[0-9a-f]{64}", job_digest):
        raise ValueError("Invalid managed job digest")
    workspace = Path(context.workspace("openfoam")).resolve()
    jobs = (workspace / "jobs").resolve()
    try:
        jobs.relative_to(workspace)
    except ValueError:
        raise ValueError("Managed jobs directory escaped its workspace") from None
    jobs.mkdir(parents=True, exist_ok=True)
    target = (jobs / job_digest).resolve()
    try:
        target.relative_to(jobs)
    except ValueError:
        raise ValueError("Managed job escaped its workspace") from None
    return target


def _case_paths(job_root):
    job_root = Path(job_root).resolve()
    case_dir = job_root / "case"
    marker_path = job_root / "prepared.json"
    run_path = job_root / "run.json"
    if case_dir.exists():
        try:
            case_dir.resolve().relative_to(job_root)
        except ValueError:
            raise RuntimeError("Managed case directory escaped its job root") from None
    if any(path.is_symlink() for path in (case_dir, marker_path, run_path)):
        raise RuntimeError("Managed job metadata may not use symbolic links")
    return case_dir, marker_path, run_path


def prepare_cavity(arguments, context):
    context.check_stop()
    spec = _content(context, arguments["spec_ref"])
    _validate_frozen_spec(spec, context)
    spec_digest = digest(spec)
    if context.task.get("context", {}).get("controlled_failure", False):
        if context.once("openfoam.prepare_cavity.synthetic-contract-rejection.v1"):
            return {
                "status": "contract_rejected",
                "reason": "synthetic_once_only_rejection",
                "retryable": True,
                "feedback": (
                    "Synthetic once-only contract rejection: the frozen spec remains valid; "
                    "retry prepare_cavity with the same spec_ref."
                ),
                "spec_digest": spec_digest,
                "template_digest": None,
                "job_digest": None,
                "case_ref": None,
                "provenance": _provenance(),
            }
    environment = runner.discover_environment()
    if not environment.available:
        raise runner.EnvironmentUnavailable(
            "OpenFOAM Foundation 8 environment unavailable: " + ", ".join(environment.reasons))
    workspace = Path(context.workspace("openfoam")).resolve()
    jobs = (workspace / "jobs").resolve()
    try:
        jobs.relative_to(workspace)
    except ValueError:
        raise ValueError("Managed jobs directory escaped its workspace") from None
    jobs.mkdir(parents=True, exist_ok=True)
    staging = jobs / (".preparing-" + spec_digest[:12] + "-" + digest(
        {"idempotency_key": getattr(context, "idempotency_key", "contract")})[:12])
    if staging.exists():
        if staging.is_symlink() or staging.resolve().parent != jobs:
            raise RuntimeError("Incomplete managed preparation escaped its jobs directory")
        import shutil
        shutil.rmtree(staging)
    staging.mkdir()
    try:
        template_digest = runner.copy_official_template(environment, staging / "case")
    except BaseException:
        import shutil
        if (staging.exists() and not staging.is_symlink()
                and staging.resolve().parent == jobs):
            shutil.rmtree(staging)
        raise
    job_digest = digest({"spec": spec, "template_digest": template_digest,
                         "foundation": "OpenFOAM Foundation 8"})
    job_root = _job_root(context, job_digest)
    case_dir, marker_path, _ = _case_paths(job_root)
    case_receipt = {
        "schema_version": "openfoam-case-receipt-v1",
        "job_digest": job_digest,
        "spec_digest": spec_digest,
        "template_digest": template_digest,
        "case_digest": template_digest,
        "scenario": SCENARIO,
        "foundation_version": "8",
        "execution_backend": environment.backend,
        "template_relpath": TEMPLATE_RELPATH,
    }
    if job_root.exists():
        if not case_dir.is_dir() or not marker_path.is_file():
            raise RuntimeError("Managed job exists without a complete preparation receipt")
        if runner.read_json(marker_path) != case_receipt:
            raise RuntimeError("Managed job preparation receipt does not match the frozen input")
        import shutil
        shutil.rmtree(staging)
    else:
        runner.write_json(staging / "prepared.json", case_receipt)
        os.replace(staging, job_root)
    artifact = context.publish(case_receipt, name="openfoam_case_receipt")
    return {
        "status": "prepared",
        "reason": None,
        "retryable": False,
        "feedback": None,
        "spec_digest": spec_digest,
        "template_digest": template_digest,
        "job_digest": job_digest,
        "case_ref": artifact["id"],
        "provenance": _provenance(environment.backend),
    }


def _validate_case_receipt(value, context):
    required = {
        "schema_version", "job_digest", "spec_digest", "template_digest", "case_digest",
        "scenario", "foundation_version", "execution_backend", "template_relpath",
    }
    if not isinstance(value, dict) or set(value) != required:
        raise ValueError("case_ref must resolve to a managed case receipt")
    if value["schema_version"] != "openfoam-case-receipt-v1":
        raise ValueError("Unsupported case receipt")
    for name in ("job_digest", "spec_digest", "template_digest", "case_digest"):
        if not isinstance(value[name], str) or not re.fullmatch(r"[0-9a-f]{64}", value[name]):
            raise ValueError("Case receipt contains an invalid digest")
    frozen = context.task.get("inputs", {}).get("spec")
    if value["spec_digest"] != digest(frozen):
        raise ValueError("Case receipt is not bound to the frozen task input")
    if (value["scenario"] != SCENARIO or value["foundation_version"] != "8"
            or value["execution_backend"] not in {"native", "wsl"}
            or value["template_relpath"] != TEMPLATE_RELPATH):
        raise ValueError("Case receipt identifies an unsupported scenario")


def run_cavity(arguments, context):
    context.check_stop()
    case_receipt = _content(context, arguments["case_ref"])
    _validate_case_receipt(case_receipt, context)
    job_root = _job_root(context, case_receipt["job_digest"])
    case_dir, marker_path, run_path = _case_paths(job_root)
    if not case_dir.is_dir() or not marker_path.is_file():
        raise RuntimeError("Managed prepared case is missing")
    if runner.read_json(marker_path) != case_receipt:
        raise RuntimeError("Case artifact does not match the managed preparation receipt")
    if run_path.is_file():
        result = runner.read_json(run_path)
        if validation_errors(result, RUN_RESULT_SCHEMA, "run_result"):
            raise RuntimeError("Stored run receipt failed its schema")
        return result
    before = runner.tree_digest(case_dir)
    if before != case_receipt["case_digest"]:
        raise RuntimeError("Prepared case changed before solver execution")
    environment = runner.discover_environment()
    if not environment.available:
        raise runner.EnvironmentUnavailable(
            "OpenFOAM Foundation 8 environment unavailable: " + ", ".join(environment.reasons))
    if environment.backend != case_receipt["execution_backend"]:
        raise runner.EnvironmentUnavailable("Prepared case execution backend changed before run")
    resources = runner.execute_case(
        case_dir, environment, check_stop=context.check_stop)
    parsed = runner.parse_run(case_dir, resources)
    after = runner.tree_digest(case_dir)
    result = runner.make_run_documents(case_receipt, resources, parsed, after)
    errors = validation_errors(result, RUN_RESULT_SCHEMA, "run_result")
    if errors:
        raise RuntimeError("Generated run receipt failed its schema: " + "; ".join(errors))
    runner.write_json(run_path, result)
    return result


def validate_delivery(arguments, context):
    context.check_stop()
    delivery = {
        "run_manifest": _content(context, arguments["run_manifest_ref"]),
        "verification_report": _content(context, arguments["verification_report_ref"]),
    }
    errors = delivery_schema_errors(delivery)
    receipt_consistent = False
    run_digest = None
    if not errors:
        manifest = delivery["run_manifest"]
        report = delivery["verification_report"]
        run_digest = manifest["run_digest"]
        if report["run_digest"] != run_digest:
            errors.append("receipt/run_digest: manifest_report_mismatch")
        job_root = _job_root(context, manifest["job_digest"])
        _, _, run_path = _case_paths(job_root)
        if not run_path.is_file():
            errors.append("receipt/run: managed_run_receipt_missing")
        else:
            try:
                receipt_consistent = runner.read_json(run_path) == delivery
            except (OSError, ValueError):
                receipt_consistent = False
            if not receipt_consistent:
                errors.append("receipt/run: delivery_does_not_match_managed_run")
        if report["status"] != "passed" or not all(item["passed"] for item in report["checks"]):
            errors.append("verification/smoke: all_public_checks_must_pass")
    return {
        "valid": not errors,
        "schema_valid": not delivery_schema_errors(delivery),
        "receipt_consistent": receipt_consistent,
        "errors": sorted(set(errors)),
        "delivery_digest": digest(delivery),
        "run_digest": run_digest,
        "scope": "Public schema and managed-receipt consistency only; no accuracy or RSI claim.",
    }


class OpenFOAMCavityDomain:
    id = "openfoam_cavity"

    def describe(self):
        return {
            "id": self.id,
            "version": VERSION,
            "title": "OpenFOAM Foundation 8 cavity smoke",
            "tools": [
                "openfoam.probe_environment", "openfoam.prepare_cavity",
                "openfoam.run_cavity", "openfoam.validate_delivery",
            ],
            "data_origin": "Official OpenFOAM Foundation 8 cavity tutorial copied at execution time.",
        }

    def snapshot(self):
        return self.describe()

    def environment_probe(self):
        return runner.discover_environment().public()

    def tools(self):
        from nexgent.tasks.tools import ToolSpec, artifact_ref_schema
        empty = obj({})
        ref = artifact_ref_schema()
        return [
            ToolSpec(
                name="openfoam.probe_environment",
                description="Read-only inspection for an already configured Foundation OpenFOAM 8 cavity environment. On Windows it may start only the fixed Ubuntu-20.04 WSL probe and installed OpenFOAM environment script; it never accepts shell text.",
                input_schema=empty, output_schema=PROBE_SCHEMA, effect_class="read",
                handler=probe_environment,
            ),
            ToolSpec(
                name="openfoam.prepare_cavity",
                description="Validate the frozen Re=10 spec and bounded-copy the official cavity template into the host-managed task workspace. Returns a case artifact reference.",
                input_schema=obj({"spec_ref": ref}), output_schema=PREPARE_SCHEMA,
                effect_class="artifact_write", handler=prepare_cavity,
            ),
            ToolSpec(
                name="openfoam.run_cavity",
                description="Run only fixed blockMesh, checkMesh and icoFoam argv against a managed case, with bounded time/output, then return receipt-bound delivery documents.",
                input_schema=obj({"case_ref": ref}), output_schema=RUN_RESULT_SCHEMA,
                effect_class="external_compute", handler=run_cavity,
            ),
            ToolSpec(
                name="openfoam.validate_delivery",
                description="Validate final delivery schemas and bind them to the managed real-run receipt.",
                input_schema=obj({"run_manifest_ref": ref, "verification_report_ref": ref}),
                output_schema=VALIDATION_SCHEMA, effect_class="read", handler=validate_delivery,
            ),
        ]


class OpenFOAMCavityBenchmark:
    id = "openfoam_cavity"

    def describe(self):
        return {
            "id": self.id,
            "version": VERSION,
            "title": "Foundation 8 cavity Re=10 execution smoke",
            "splits": list(SPLITS),
            "parameter_schema": deepcopy(PARAMETER_SCHEMA),
            "task_count_per_seed": 1,
            "data_origin": "official_openfoam_foundation_8_tutorial",
            "acceptance": "Frozen input integrity plus actual probe, preparation, solver and final-delivery receipts.",
            "research_scope": "Execution smoke only; no numerical-accuracy, performance, general CFD, or RSI claim.",
        }

    def snapshot(self):
        from . import _evaluation, data, schemas
        from nexgent.tasks.runtime import TaskService, ToolContext
        return {
            **self.describe(),
            "evaluator_digest": digest({
                "evaluator": inspect.getsource(_evaluation),
                "schemas": inspect.getsource(schemas),
                "data": inspect.getsource(data),
                "runner": inspect.getsource(runner),
                "tools": {
                    "probe": inspect.getsource(probe_environment),
                    "prepare": inspect.getsource(prepare_cavity),
                    "run": inspect.getsource(run_cavity),
                    "validate": inspect.getsource(validate_delivery),
                    "registration": inspect.getsource(OpenFOAMCavityDomain.tools),
                },
                "task_contract": inspect.getsource(type(self).tasks),
                "acceptance": inspect.getsource(type(self).evaluate),
                "host_runtime": {
                    "tool_workspace": inspect.getsource(ToolContext.workspace),
                    "tool_receipts": inspect.getsource(TaskService._invoke),
                    "evaluation_view": inspect.getsource(TaskService.evaluate),
                },
            }),
            "frozen_input_digest": digest(inputs_for("smoke", 0)),
        }

    def tasks(self, split="smoke", seed=0, *, controlled_failure=False):
        inputs = inputs_for(split, seed)
        if type(controlled_failure) is not bool:
            raise ValueError("controlled_failure must be boolean")
        trial = "recovery" if controlled_failure else "normal"
        task_id = f"openfoam_cavity/{VERSION}/smoke/0/{trial}"
        return [{
            "id": task_id,
            "schema_version": "1",
            "objective": (
                "Execute the frozen OpenFOAM Foundation 8 cavity Re=10 smoke slice. "
                "First call openfoam.probe_environment. Call prepare_cavity with the spec "
                "artifact; if the controlled trial returns contract_rejected, correct the "
                "workflow by retrying the same frozen spec. Call run_cavity with the returned "
                "case_ref. Publish its run_manifest and verification_report values as the two "
                "final artifacts, then call validate_delivery on those exact refs and require "
                "valid=true before delivery. Do not edit dictionaries, supply shell text, or "
                "claim accuracy, convergence, performance, general CFD validity, or RSI."
            ),
            "inputs": inputs,
            "deliverables": [
                {"name": name, "schema": deepcopy(schema)}
                for name, schema in DELIVERY_SCHEMAS.items()
            ],
            "constraints": {
                "allowed_effects": ["read", "artifact_write", "external_compute"],
                "wall_seconds": 300,
                "quality_requirements": [
                    "Use only the frozen smoke/cavity_re10 specification",
                    "Use the official Foundation 8 cavity template without edits",
                    "Run only fixed blockMesh, checkMesh and icoFoam commands",
                    "Deliver documents copied from the real run receipt",
                    "Validate the exact final artifact versions",
                    "Describe results as an execution smoke check only",
                ],
            },
            "capabilities": [
                "openfoam.probe_environment", "openfoam.prepare_cavity",
                "openfoam.run_cavity", "openfoam.validate_delivery",
            ],
            "context": {
                "domain": self.id,
                "benchmark": self.id,
                "split": "smoke",
                "seed": 0,
                "scenario": SCENARIO,
                "spec_digest": digest(inputs["spec"]),
                "controlled_failure": controlled_failure,
                "trial_type": "synthetic_once_only_contract_rejection" if controlled_failure else "normal",
            },
        }]

    def evaluate(self, task_ref, deliverables, execution_view):
        from ._evaluation import evaluate_receipts
        task_id = task_ref["id"] if isinstance(task_ref, dict) else task_ref
        match = re.fullmatch(
            rf"openfoam_cavity/{re.escape(VERSION)}/smoke/0/(normal|recovery)",
            str(task_id),
        )
        if not match:
            raise ValueError("Unknown frozen OpenFOAM cavity task reference")
        recovery = match.group(1) == "recovery"
        task = self.tasks("smoke", 0, controlled_failure=recovery)[0]
        result = evaluate_receipts(task, deliverables, execution_view, recovery=recovery)
        return {
            "benchmark": self.id,
            "task_ref": task_id,
            "split": "smoke",
            **result,
            "evaluator_digest": self.snapshot()["evaluator_digest"],
            "trial_type": task["context"]["trial_type"],
            "scope": "Foundation 8 cavity execution smoke; no accuracy, convergence, performance, general CFD, or RSI claim.",
        }


def domain_pack():
    return OpenFOAMCavityDomain()


def benchmark_adapter():
    return OpenFOAMCavityBenchmark()
