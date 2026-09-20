"""Canonical TaskService adapter and public numerical DomainPack.

The legacy ``nexgent.benchmarks`` adapter remains authoritative for old Study
records.  This module reuses its deterministic synthetic generator and numeric
semantics while assigning new TaskSpec/Episode identities and keeping hidden
forecast trajectories inside the host evaluator.
"""

from __future__ import annotations

from copy import deepcopy
import hashlib
import hmac
import inspect
from importlib.metadata import version as distribution_version
import json
import os
from pathlib import Path
import secrets

import numpy as np

from nexgent.tasks.benchmarks import BenchmarkDescriptor
from nexgent.tasks.packages import make_package
from nexgent.tasks.tools import ToolSpec

from ..benchmark import (
    BENCHMARK_VERSION as LEGACY_VERSION,
    ResearchBenchmark,
    _digest,
)
from ..expressions import NumericalFailure, validate_model
from ..toolbox import Toolbox


VERSION = "scientific-discovery-task-v1"
REPORT_SCHEMA = "nexgent-scientific-discovery-task-report-v1"
SPLIT_ALIASES = {"development": "development", "final_holdout": "confirmation"}
SPLITS = tuple(SPLIT_ALIASES)
TOOL_PREFIX = "scientific_discovery."
TOOL_NAMES = tuple(TOOL_PREFIX + name for name in (
    "smooth", "differentiate", "feature_matrix", "linear_fit", "fit_model",
    "integrate", "validate",
))
CANONICAL_TOOL_API = (
    "Use the TaskService capability list in the package payload. Call numerical primitives "
    "with context.tool('scientific_discovery.<method>', arguments). Available methods are "
    "smooth, differentiate, feature_matrix, linear_fit, fit_model, integrate and validate. "
    "Their JSON schemas and fixed work reservations are supplied by the host. Returned "
    "work_units fields are diagnostics only; the root Episode tool ledger is authoritative."
)
EVIDENCE_SCOPE = (
    "Deterministic synthetic ODE recovery scored on host-only future trajectories. "
    "This is a benchmark control, not evidence of a new natural law or RSI efficacy."
)
RELEASE_KEY_BYTES = 32
RELEASE_KEY_RELATIVE_PATH = Path(
    ".nexgent/benchmark-private/scientific-discovery-v1.key")
MAX_RESULT_BYTES = 180_000
INVALID_NRMSE = 1e6
FORECAST_SUBSTEPS = 3
NRMSE_SCALE_FLOOR = 0.05
SCORE_MULTIPLIER = 10.0
HIDDEN_WORK_LIMIT = 1_000_000_000


def _canonical(value):
    return json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))


def _file_sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _load_or_create_release_key(project_root):
    """Read one project release secret, creating it with exclusive ownership."""
    root = Path(project_root).resolve()
    path = (root / RELEASE_KEY_RELATIVE_PATH).resolve()
    try:
        path.relative_to(root)
    except ValueError:
        raise ValueError("Scientific release key resolved outside the project") from None
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists():
        temporary = path.with_name(path.name + "." + secrets.token_hex(8) + ".tmp")
        descriptor = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            key = secrets.token_bytes(RELEASE_KEY_BYTES)
            with os.fdopen(descriptor, "wb") as stream:
                descriptor = None
                stream.write(key)
                stream.flush()
                os.fsync(stream.fileno())
            try:
                # A hard link publishes the fully-written inode only if the
                # final name is still absent. Concurrent creators keep the
                # single winner and all readers see exactly 32 bytes.
                os.link(temporary, path)
            except FileExistsError:
                pass
        finally:
            if descriptor is not None:
                os.close(descriptor)
            temporary.unlink(missing_ok=True)
    key = path.read_bytes()
    if len(key) != RELEASE_KEY_BYTES:
        raise ValueError("Scientific release key must contain exactly 32 bytes")
    return key


def _release_hmac(key, label, *parts):
    message = json.dumps(
        ["nexgent-scientific-discovery-release-v1", label, *parts],
        ensure_ascii=False, sort_keys=True, separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hmac.new(key, message, hashlib.sha256).digest()


class _MeteredToolbox(Toolbox):
    """Bridge legacy deterministic charges to the root Episode ledger."""

    def __init__(self, charge_work):
        super().__init__(2 ** 63 - 1)
        self._host_charge_work = charge_work

    def _charge(self, units):
        units = max(1, int(units))
        # The host commits the charge before the numerical boundary proceeds.
        self._host_charge_work(units)
        super()._charge(units)


def _run_tool(method, arguments, context):
    if not isinstance(arguments, dict):
        raise ValueError("Scientific numerical tool arguments must be an object")
    # Materializing large JSON arrays as NumPy buffers is real work.  Charge a
    # bounded input-size proxy before the first allocation; the legacy
    # Toolbox then meters each numerical chunk at its own execution boundary.
    stack, numeric_values = [arguments], 0
    while stack:
        value = stack.pop()
        if isinstance(value, dict):
            stack.extend(value.values())
        elif isinstance(value, list):
            stack.extend(value)
        elif type(value) in {int, float}:
            numeric_values += 1
    if numeric_values > 256:
        context.charge_work(numeric_values)
    toolbox = _MeteredToolbox(context.charge_work)
    return getattr(toolbox, method)(**arguments)


def smooth(arguments, context):
    return _run_tool("smooth", arguments, context)


def differentiate(arguments, context):
    return _run_tool("differentiate", arguments, context)


def feature_matrix(arguments, context):
    return _run_tool("feature_matrix", arguments, context)


def linear_fit(arguments, context):
    return _run_tool("linear_fit", arguments, context)


def fit_model(arguments, context):
    return _run_tool("fit_model", arguments, context)


def integrate(arguments, context):
    return _run_tool("integrate", arguments, context)


def validate(arguments, context):
    return _run_tool("validate", arguments, context)


_NUMBER = {"type": "number"}
_NONNEGATIVE_NUMBER = {"type": "number", "minimum": 0}
_WORK_UNITS = {"type": "integer", "minimum": 0}
_WINDOW = {"type": "integer", "minimum": 0, "maximum": 101}
_DEGREE = {"type": "integer", "minimum": 1, "maximum": 5}
_DT = {"type": "number", "exclusiveMinimum": 0, "maximum": 1}
_GENERAL_VECTOR = {
    "type": "array", "items": _NUMBER, "minItems": 1, "maxItems": 128}
_STATE_VECTOR = {
    "type": "array", "items": _NUMBER, "minItems": 1, "maxItems": 6}
_GENERAL_MATRIX = {
    "type": "array", "items": _GENERAL_VECTOR, "minItems": 1, "maxItems": 4000}
_STATE_MATRIX = {
    "type": "array", "items": _STATE_VECTOR, "minItems": 1, "maxItems": 4000}
_FEATURE_ROW = {
    "type": "array", "items": _NUMBER, "minItems": 1, "maxItems": 64}
_FEATURE_MATRIX = {
    "type": "array", "items": _FEATURE_ROW, "minItems": 1, "maxItems": 4000}
_OBSERVATIONS = {
    "type": "array", "items": _STATE_MATRIX, "minItems": 1, "maxItems": 12}
_TERMS = {"type": "array", "items": {"type": "string", "maxLength": 240},
          "minItems": 1, "maxItems": 64, "uniqueItems": True}
_COEFFICIENT_ROW = {
    "type": "array", "items": _NUMBER, "minItems": 1, "maxItems": 64}
_COEFFICIENTS = {
    "type": "array", "items": _COEFFICIENT_ROW, "minItems": 1, "maxItems": 6}
_MODEL = {
    "type": "object", "required": ["terms", "coefficients"],
    "properties": {"terms": _TERMS, "coefficients": _COEFFICIENTS},
    "additionalProperties": False,
}


def _object(required, properties):
    return {"type": "object", "required": list(required),
            "properties": properties, "additionalProperties": False}


_LINEAR_FIT_OUTPUT = _object(
    ("coefficients", "training_rmse", "complexity", "work_units"), {
        "coefficients": {
            "type": "array", "items": _GENERAL_VECTOR,
            "minItems": 1, "maxItems": 128,
        },
        "training_rmse": _NONNEGATIVE_NUMBER,
        "complexity": {"type": "integer", "minimum": 0},
        "work_units": _WORK_UNITS,
    })
_FIT_MODEL_OUTPUT = _object(
    ("model", "training_rmse", "complexity", "work_units"), {
        "model": _MODEL,
        "training_rmse": _NONNEGATIVE_NUMBER,
        "complexity": {"type": "integer", "minimum": 0},
        "work_units": _WORK_UNITS,
    })
_VALIDATE_OUTPUT = _object(
    ("score", "nrmse", "stable", "complexity", "work_units"), {
        "score": {"type": "number", "minimum": 0, "maximum": 1},
        "nrmse": _NONNEGATIVE_NUMBER,
        "stable": {"type": "boolean"},
        "complexity": {"type": "integer", "minimum": 0},
        "work_units": _WORK_UNITS,
    })


_TOOL_CONTRACTS = {
    "smooth": (_object(("states",), {
        "states": _GENERAL_MATRIX, "window": _WINDOW, "degree": _DEGREE}),
        _GENERAL_MATRIX),
    "differentiate": (_object(("states", "dt"), {
        "states": _GENERAL_MATRIX, "dt": _DT, "window": _WINDOW,
        "degree": _DEGREE}), _GENERAL_MATRIX),
    "feature_matrix": (_object(("states", "terms"), {
        "states": _STATE_MATRIX, "terms": _TERMS,
        "times": {"type": "array", "items": _NUMBER,
                  "minItems": 1, "maxItems": 4000}}), _FEATURE_MATRIX),
    "linear_fit": (_object(("features", "targets"), {
        "features": _GENERAL_MATRIX, "targets": _GENERAL_MATRIX,
        "ridge": {"type": "number", "minimum": 0, "maximum": 100},
        "threshold": {"type": "number", "minimum": 0, "maximum": 10},
        "iterations": {"type": "integer", "minimum": 1, "maximum": 30}}),
        _LINEAR_FIT_OUTPUT),
    "fit_model": (_object(("observations", "dt", "terms"), {
        "observations": _OBSERVATIONS, "dt": _DT, "terms": _TERMS,
        "window": _WINDOW, "degree": _DEGREE,
        "ridge": {"type": "number", "minimum": 0, "maximum": 100},
        "threshold": {"type": "number", "minimum": 0, "maximum": 10},
        "weak_window": {"type": "integer", "minimum": 0, "maximum": 50}}),
        _FIT_MODEL_OUTPUT),
    "integrate": (_object(("model", "initial", "dt", "steps"), {
        "model": _MODEL, "initial": _STATE_VECTOR, "dt": _DT,
        "steps": {"type": "integer", "minimum": 0, "maximum": 2000},
        "substeps": {"type": "integer", "minimum": 1, "maximum": 32},
        "start_time": _NUMBER}),
        {"type": "array", "items": _STATE_VECTOR,
         "minItems": 1, "maxItems": 2001}),
    "validate": (_object(("model", "observations", "dt"), {
        "model": _MODEL, "observations": _OBSERVATIONS, "dt": _DT,
        "fraction": {"type": "number", "minimum": 0.1, "maximum": 0.9}}),
        _VALIDATE_OUTPUT),
}


_TOOL_DESCRIPTIONS = {
    "smooth": "Smooth one finite observed state trajectory with a local polynomial filter.",
    "differentiate": "Estimate derivatives from one finite observed state trajectory.",
    "feature_matrix": "Evaluate a bounded mathematical expression library on observed states.",
    "linear_fit": "Fit thresholded ridge coefficients to a public design matrix and targets.",
    "fit_model": "Fit an expression model from public observation trajectories.",
    "integrate": "Integrate a submitted expression model with bounded RK4.",
    "validate": "Score a model on a suffix of supplied public observations only.",
}


class ScientificDiscoveryDomain:
    """Public numerical capabilities; it owns no task sampling or hidden truth."""

    id = "scientific_discovery"

    def describe(self):
        return {
            "id": self.id,
            "version": VERSION,
            "title": "Scientific discovery numerical primitives",
            "tools": list(TOOL_NAMES),
            "data_origin": "No data in DomainPack; benchmark observations arrive as task artifacts.",
            "work_accounting": (
                "Each call reserves one unit and charges deterministic numerical batches through "
                "the root Episode ledger before execution; returned work_units fields are non-authoritative."
            ),
        }

    def snapshot(self):
        return self.describe()

    def environment_probe(self):
        return {"available": True, "status": "available",
                "requires_external_environment": False,
                "details": "Pure local NumPy/SciPy numerical tools."}

    def tools(self):
        handlers = {
            "smooth": smooth, "differentiate": differentiate,
            "feature_matrix": feature_matrix, "linear_fit": linear_fit,
            "fit_model": fit_model, "integrate": integrate, "validate": validate,
        }
        return [
            ToolSpec(
                name=TOOL_PREFIX + name,
                input_schema=deepcopy(_TOOL_CONTRACTS[name][0]),
                output_schema=deepcopy(_TOOL_CONTRACTS[name][1]),
                effect_class="local_compute",
                handler=handlers[name],
                description=_TOOL_DESCRIPTIONS[name],
                work_units_per_call=1,
            )
            for name in handlers
        ]


REFERENCE_SOURCE = '''def solve(problem, context):
    observations = problem["observations"]
    training = observations[:-1]
    validation = observations[-1:]
    terms = ["1"] + ["x" + str(i) for i in range(problem["dimension"])]
    fitted = context.tool("scientific_discovery.fit_model", {"observations": training, "dt": problem["dt"], "terms": terms, "window": 9, "degree": 3, "ridge": 0.000001, "threshold": 0.01, "weak_window": 0})
    checked = context.tool("scientific_discovery.validate", {"model": fitted["model"], "observations": validation, "dt": problem["dt"], "fraction": 0.15})
    final = context.tool("scientific_discovery.fit_model", {"observations": observations, "dt": problem["dt"], "terms": terms, "window": 9, "degree": 3, "ridge": 0.000001, "threshold": 0.01, "weak_window": 0})
    return {"model": final["model"], "hypotheses": [{"claim": "A linear field explains these observations", "falsifier": "Poor withheld-observation or host-only future prediction"}], "experiments": [{"kind": "observation_holdout", "training_rmse": fitted["training_rmse"], "validation": checked}], "limitations": ["Linear executable control; nonlinear mechanisms require richer expressions", "Observation validation and synthetic hidden scoring do not establish a new natural law"]}

def execute(payload, context):
    problem = context.read_artifact(payload["input_refs"]["problem"])["content"]
    result = context.publish(solve(problem, context), name="result")
    return {"deliverables": {"result": result["id"]},
            "summary": "Ran the frozen observation-only numerical control",
            "limitations": ["Synthetic benchmark control; no claim of scientific discovery or RSI improvement"]}
'''


def reference_package():
    """Return the executable, model-free canonical linear control."""
    return make_package(
        {"main.py": REFERENCE_SOURCE},
        {"entries": {"execute": "main.py:execute"}},
        provenance={
            "origin": "nexgent-scientific-discovery.reference-control",
            "benchmark_version": VERSION,
            "legacy_algorithm_version": LEGACY_VERSION,
            "algorithm": "observation-held-out linear expression control",
        },
    )


class ScientificDiscoveryTaskBenchmark:
    """Canonical per-system tasks with host-only future-trajectory scoring."""

    id = "scientific_discovery"
    descriptor = BenchmarkDescriptor(
        id=id,
        version=VERSION,
        title="Scientific discovery · synthetic ODE recovery",
        splits=SPLITS,
        default_split="development",
        modes=("fixed",),
        required_capabilities=TOOL_NAMES,
        evidence_scope=EVIDENCE_SCOPE,
    )

    @classmethod
    def from_project(cls, project_root):
        return cls(project_root=project_root)

    def __init__(self, *, project_root=None):
        self.project_root = (Path(project_root).resolve()
                             if project_root is not None else None)
        self._release_key = (_load_or_create_release_key(self.project_root)
                             if self.project_root is not None else None)
        self._case_cache = {}

    def describe(self):
        return {
            **self.descriptor.as_dict(),
            "task_count": {"development": 8, "final_holdout": 12},
            "split_aliases": deepcopy(SPLIT_ALIASES),
            "split_evidence_status": {
                "development": "historically consumed development distribution",
                "final_holdout": (
                    "historically consumed confirmation distribution exposed only for "
                    "migration regression and golden-equivalence checks"
                ),
            },
            "reference_agent_package": (
                "nexgent_scientific_discovery.canonical:reference_package"),
            "statistical_design": {
                "statistical_unit": (
                    "one generated system at one split/seed/index, exposed under an opaque id "
                    "and scored over two host-only forecasts"
                ),
                "cluster": (
                    "opaque family-stable mechanism cluster; family names remain evaluator-private"
                ),
                "seed_role": "suite-level repeat and pairing key, not an independence cluster",
                "release_role": (
                    "public seeds are mapped through one project-private release key; "
                    "reproduction requires the same key"
                ),
            },
            "legacy_compatibility": {
                "distribution": "nexgent-scientific-discovery",
                "legacy_entry_group": "nexgent.benchmarks",
                "canonical_entry_group": "nexgent.task_benchmarks",
                "shared_logical_id": self.id,
                "record_boundary": (
                    "Legacy Study/measurement IDs remain legacy-only; canonical TaskSpec and "
                    "Episode IDs use a separate namespace and cannot resume legacy records."
                ),
            },
            "cost_semantics": {
                "agent_numerics": "TaskService root tool ledger is authoritative.",
                "tool_result_work_units": "Diagnostic only; never used for budget settlement.",
                "host_generation_and_evaluation": (
                    "Trusted setup/scoring work is outside Agent tool usage and is not claimed as equal to legacy work totals."
                ),
            },
        }

    def _manifest(self):
        return {
            "schema": "nexgent-scientific-discovery-task-manifest-v1",
            "adapter_version": VERSION,
            "legacy_generator_version": LEGACY_VERSION,
            "splits": list(SPLITS),
            "split_aliases": deepcopy(SPLIT_ALIASES),
            "generator": "deterministic seeded synthetic ODE systems",
            "external_dataset": None,
            "task_identity": "canonical version plus public-problem content digest",
            "host_binding": (
                "split/seed/index reconstruction fields remain in the frozen benchmark "
                "registration and are absent from the Agent package payload"
            ),
        }

    def snapshot(self):
        if self._release_key is None:
            raise ValueError("Scientific discovery requires a project-local release key")
        manifest = self._manifest()
        legacy_dir = Path(__file__).parent.parent
        method_names = (
            "_native_split", "_legacy_seed", "_cases", "_public_problem",
            "_suite_digest", "_task", "tasks", "_private_case", "evaluate",
        )
        release_key_digest = hashlib.sha256(self._release_key).hexdigest()
        release_key_id = "science-release-v1-" + release_key_digest[:16]
        evaluator_components = {
            "schema": "nexgent-scientific-discovery-evaluator-components-v1",
            "legacy_generator_and_scorer_sha256": _file_sha256(
                legacy_dir / "benchmark.py"),
            "expression_language_sha256": _file_sha256(
                legacy_dir / "expressions.py"),
            "numerical_toolbox_sha256": _file_sha256(legacy_dir / "toolbox.py"),
            "canonical_contract_sha256": _digest({
                name: inspect.getsource(getattr(type(self), name))
                for name in method_names
            } | {
                "release_hmac": inspect.getsource(_release_hmac),
                "report_canonicalizer": inspect.getsource(_canonical),
            }),
            "tool_contract_sha256": _digest({
                "names": list(TOOL_NAMES),
                "schemas": _TOOL_CONTRACTS,
                "effect_class": "local_compute",
                "work_units_per_call": 1,
                "metering": {
                    "chunk": inspect.getsource(_MeteredToolbox._charge),
                    "input_materialization": inspect.getsource(_run_tool),
                },
            }),
            "evaluation_constants": {
                "version": VERSION,
                "report_schema": REPORT_SCHEMA,
                "evidence_scope": EVIDENCE_SCOPE,
                "split_aliases": deepcopy(SPLIT_ALIASES),
                "canonical_tool_api": CANONICAL_TOOL_API,
                "max_result_bytes": MAX_RESULT_BYTES,
                "invalid_nrmse": INVALID_NRMSE,
                "forecast_substeps": FORECAST_SUBSTEPS,
                "nrmse_scale_floor": NRMSE_SCALE_FLOOR,
                "score_multiplier": SCORE_MULTIPLIER,
                "hidden_work_limit": HIDDEN_WORK_LIMIT,
            },
            "release": {
                "release_key_id": release_key_id,
                "release_key_digest": release_key_digest,
            },
            "dependencies": {
                name: distribution_version(name) for name in ("numpy", "scipy")
            },
        }
        frozen = {
            **self.describe(),
            "manifest": manifest,
            "manifest_digest": _digest(manifest),
            "release_key_id": release_key_id,
            "release_key_digest": release_key_digest,
            "release_reproducibility": (
                "The same project-private release key is required to regenerate this "
                "task release; the key itself is never part of benchmark evidence."
            ),
            "evaluator_components": evaluator_components,
            "hidden_data_policy": (
                "Future trajectories and scoring targets exist only in evaluator memory; "
                "they are absent from TaskSpec, snapshot, report and suite/report digests."
            ),
        }
        return {**frozen, "evaluator_digest": _digest(evaluator_components)}

    def availability(self):
        if self.project_root is None or self._release_key is None:
            return {"available": False, "reason": "Project-local release key is unavailable"}
        if not self.project_root.is_dir():
            return {"available": False, "reason": "Project root is unavailable"}
        return {"available": True}

    @staticmethod
    def _native_split(split):
        if split not in SPLIT_ALIASES:
            raise ValueError("Use a registered scientific discovery split")
        return SPLIT_ALIASES[split]

    def _legacy_seed(self, native_split, public_seed):
        if self._release_key is None:
            raise ValueError("Scientific discovery requires a project-local release key")
        raw = _release_hmac(
            self._release_key, "legacy-generator-seed", native_split, public_seed)
        return int.from_bytes(raw[:16], "big")

    def _cases(self, native_split, seed):
        key = (native_split, seed)
        if key not in self._case_cache:
            self._case_cache[key] = ResearchBenchmark()._cases(
                native_split, self._legacy_seed(native_split, seed),
                Toolbox(HIDDEN_WORK_LIMIT))
        return self._case_cache[key]

    def _suite_digest(self, native_split, seed, cases):
        return _digest({
            "schema": "nexgent-scientific-discovery-public-suite-v1",
            "adapter_version": VERSION,
            "manifest_digest": self.snapshot()["manifest_digest"],
            "native_split": native_split,
            "seed": seed,
            "public_problem_ids": [self._public_problem(case)["task_id"]
                                   for case in cases],
        })

    @staticmethod
    def _public_problem(case):
        public = deepcopy(case["problem"])
        public.pop("task_id", None)
        public["tool_api"] = CANONICAL_TOOL_API
        identifier = _digest({
            "schema": "nexgent-scientific-discovery-public-problem-v1",
            "problem": public,
        })[:24]
        return {"task_id": identifier, **public}

    def _task(self, case, index, split, native_split, seed, suite_digest):
        public = self._public_problem(case)
        identity = f"scientific_discovery/{VERSION}/{public['task_id']}"
        unit_digest = _release_hmac(
            self._release_key, "statistical-unit", split, native_split,
            seed, index).hex()[:24]
        unit = f"scientific_discovery/statistical-unit/{unit_digest}"
        # Family membership is a statistical dependence boundary, but its name
        # remains evaluator-private.  The stable opaque cluster lets studies
        # avoid treating repeated mechanisms as independent samples.
        family_cluster = _release_hmac(
            self._release_key, "family-cluster", case["family"]).hex()[:24]
        cluster = f"scientific_discovery/family-cluster/{family_cluster}"
        return {
            "id": identity,
            "schema_version": "1",
            "statistical_unit_id": unit,
            "cluster_id": cluster,
            "objective": (
                "Recover a parsimonious continuous-time vector field from the supplied noisy "
                "observations. Read the problem artifact, use only its observations for fitting "
                "and method selection, and publish one result artifact containing a finite "
                "expression model plus honest hypotheses, experiments and limitations."
            ),
            "inputs": {"problem": public},
            "deliverables": [{"name": "result", "schema": {
                "type": "object", "required": ["model"],
                "properties": {
                    "model": deepcopy(_MODEL),
                    "hypotheses": {"type": "array", "maxItems": 32,
                                   "items": {"type": "object"}},
                    "experiments": {"type": "array", "maxItems": 100,
                                    "items": {"type": "object"}},
                    "limitations": {"type": "array", "maxItems": 32,
                                    "items": {"type": "string", "maxLength": 5000}},
                },
                "additionalProperties": True,
            }}],
            "constraints": {
                "allowed_effects": ["local_compute", "artifact_write"],
                "quality_requirements": [
                    "Do not infer or claim access to hidden future trajectories",
                    "Use public observations only for fitting and internal validation",
                    "Treat tool result work_units fields as non-authoritative diagnostics",
                    "Do not interpret a synthetic score as discovery of a natural law",
                ],
            },
            "capabilities": list(TOOL_NAMES),
            "context": {
                "benchmark": self.id, "split": split, "split_role": split,
                "memory_writeback": False,
            },
            # TaskService persists the full TaskSpec in its frozen benchmark
            # registration, but passes only selected task fields to create().
            # Keeping reconstruction data here prevents it entering the agent
            # package payload through state.task.context.
            "_benchmark_binding": {
                "split": split, "native_split": native_split, "seed": seed,
                "case_index": index, "suite_digest": suite_digest,
            },
        }

    def tasks(self, split="development", seed=0, **options):
        if options:
            raise ValueError("Scientific discovery canonical adapter has no task options")
        if type(seed) is not int:
            raise ValueError("Scientific discovery seed must be an integer")
        native = self._native_split(split)
        cases = self._cases(native, seed)
        suite = self._suite_digest(native, seed, cases)
        return [self._task(case, index, split, native, seed, suite)
                for index, case in enumerate(cases)]

    def _private_case(self, task_ref):
        if not isinstance(task_ref, dict) or not isinstance(
                task_ref.get("_benchmark_binding"), dict):
            raise ValueError("Frozen scientific task reference is invalid")
        binding = task_ref["_benchmark_binding"]
        split, seed, index = (binding.get("split"), binding.get("seed"),
                              binding.get("case_index"))
        if not isinstance(split, str) or type(seed) is not int or type(index) is not int:
            raise ValueError("Frozen scientific split, seed or index is invalid")
        expected_tasks = self.tasks(split, seed)
        if not 0 <= index < len(expected_tasks) or expected_tasks[index] != task_ref:
            raise ValueError("Noncanonical frozen scientific task reference")
        native = self._native_split(split)
        return self._cases(native, seed)[index]

    def evaluate(self, task_ref, deliverables, execution_view):
        case = self._private_case(task_ref)
        result = deliverables.get("result") if isinstance(deliverables, dict) else None
        score, nrmse, stable, complexity = 0.0, INVALID_NRMSE, False, 0
        reasons = []
        try:
            if not isinstance(result, dict):
                raise NumericalFailure("result artifact is missing or invalid")
            encoded = json.dumps(result, ensure_ascii=False, allow_nan=False)
            if len(encoded) > MAX_RESULT_BYTES:
                raise NumericalFailure("result artifact is too large")
            model = result.get("model")
            _, coefficients, _ = validate_model(model)
            if len(coefficients) != case["problem"]["dimension"]:
                raise NumericalFailure("submission dimension mismatch")
            ledger = Toolbox(HIDDEN_WORK_LIMIT)
            errors = []
            for target_list in case["forecasts"]:
                target = np.asarray(target_list)
                prediction = np.asarray(ledger.integrate(
                    model, target_list[0], case["problem"]["dt"],
                    len(target_list) - 1, substeps=FORECAST_SUBSTEPS))
                scale = np.maximum(
                    np.sqrt(np.mean(target ** 2, axis=0)), NRMSE_SCALE_FLOOR)
                errors.append(float(np.sqrt(np.mean(((prediction - target) / scale) ** 2))))
            nrmse = float(np.mean(errors))
            score = 1 / (1 + SCORE_MULTIPLIER * nrmse)
            stable = True
            complexity = int(np.count_nonzero(coefficients))
        except (NumericalFailure, TypeError, ValueError, OverflowError,
                ZeroDivisionError) as exc:
            reasons.append(type(exc).__name__)
        binding = task_ref["_benchmark_binding"]
        report = {
            "schema": REPORT_SCHEMA,
            "benchmark": self.id,
            "task_ref": task_ref["id"],
            "split_role": task_ref["context"]["split_role"],
            "statistical_unit_id": task_ref["statistical_unit_id"],
            "cluster_id": task_ref["cluster_id"],
            "status": "accepted" if stable else "rejected",
            "score_available": True,
            "score": float(score),
            "accepted": bool(stable),
            "nrmse": float(nrmse),
            "stable": bool(stable),
            "complexity": complexity,
            "reasons": reasons,
            "suite_digest": binding["suite_digest"],
            "manifest_digest": self.snapshot()["manifest_digest"],
            "evaluator_digest": self.snapshot()["evaluator_digest"],
            "host_usage": deepcopy(execution_view.get("usage"))
                if isinstance(execution_view, dict)
                and isinstance(execution_view.get("usage"), dict) else None,
            "scope": EVIDENCE_SCOPE,
        }
        report["report_identity"] = _digest(report)
        return _canonical(report)


def domain_pack():
    return ScientificDiscoveryDomain()


def benchmark_adapter():
    return ScientificDiscoveryTaskBenchmark()


__all__ = [
    "EVIDENCE_SCOPE", "REFERENCE_SOURCE", "ScientificDiscoveryDomain",
    "ScientificDiscoveryTaskBenchmark", "TOOL_NAMES", "VERSION",
    "benchmark_adapter", "domain_pack", "reference_package",
]
