"""Canonical TaskService adapter for the pinned two-task BBH slice.

The preserved :mod:`nexgent_bbh.benchmark` adapter remains the authority for
data loading and deterministic partitioning.  This module changes only the
execution envelope: every selected example becomes one public ``TaskSpec`` and
the expected answer stays in this host-side adapter.
"""

from copy import deepcopy
import argparse
import hashlib
import json
import math
import os
from pathlib import Path

from nexgent.tasks.benchmarks import BenchmarkDescriptor
from nexgent.tasks.packages import make_package

from .benchmark import (
    CONTRACT, PARTITIONS, SPLIT_ALIASES as LEGACY_SPLIT_ALIASES,
    VERSION as LEGACY_VERSION, BigBenchHardBenchmark, _digest, _fixtures,
)
from .data import DatasetError, TASKS, source_manifest


VERSION = "bbh-two-task-task-v1"
REPORT_SCHEMA = "nexgent-bbh-task-report-v1"
SPLIT_ALIASES = {**LEGACY_SPLIT_ALIASES, "final_holdout": "confirmation"}
SPLITS = tuple(PARTITIONS) + tuple(SPLIT_ALIASES)
ANSWER_SCHEMA = {
    "type": "object",
    "required": ["answer"],
    "properties": {"answer": {"type": "string", "maxLength": 100000}},
    "additionalProperties": False,
}
EVIDENCE_SCOPE = (
    "Exact-answer accuracy on disjoint subsets of boolean_expressions and "
    "word_sorting only. This is not a full 23-task BBH result or evidence of RSI."
)
COST_SEMANTICS = {
    "quality_unit": "one case-sensitive exact-match task after whitespace normalization",
    "canonical_usage": (
        "TaskService host ledger: model calls/tokens, tool calls and nodes; token totals "
        "are unavailable when provider usage receipts are incomplete"
    ),
    "legacy_comparison": (
        "Canonical reports do not claim the legacy source_instruction_events scalar; "
        "cost numbers from the two runtimes must not be compared as the same unit"
    ),
}


REFERENCE_SOURCE = '''def bbh_atom(tokens, index):
    token = tokens[index]
    if token == "not":
        value, index = bbh_atom(tokens, index + 1)
        return not value, index
    if token == "(":
        value, index = bbh_or(tokens, index + 1)
        if tokens[index] != ")":
            raise ValueError("Expected a closing parenthesis")
        return value, index + 1
    if token not in ["True", "False"]:
        raise ValueError("Unknown Boolean token")
    return token == "True", index + 1

def bbh_and(tokens, index):
    value, index = bbh_atom(tokens, index)
    while index < len(tokens) and tokens[index] == "and":
        right, index = bbh_atom(tokens, index + 1)
        value = value and right
    return value, index

def bbh_or(tokens, index):
    value, index = bbh_and(tokens, index)
    while index < len(tokens) and tokens[index] == "or":
        right, index = bbh_and(tokens, index + 1)
        value = value or right
    return value, index

def solve(problem):
    prompt = problem["input"]
    if problem["category"] == "word_sorting":
        if "List:" not in prompt:
            raise ValueError("Word sorting needs the public List: input")
        return " ".join(sorted(prompt.split("List:", 1)[1].split()))
    if problem["category"] == "boolean_expressions":
        tokens = prompt.replace("(", " ( ").replace(")", " ) ").split()
        if tokens and tokens[-1] == "is":
            tokens = tokens[:-1]
        value, index = bbh_or(tokens, 0)
        if index != len(tokens):
            raise ValueError("Unexpected remaining Boolean tokens")
        return "True" if value else "False"
    raise ValueError("Unsupported task category")

def execute(payload, context):
    artifact = context.read_artifact(payload["input_refs"]["problem"])
    result = context.publish({"answer": solve(artifact["content"])}, name="answer")
    return {"deliverables": {"answer": result["id"]},
            "summary": "Solved one public BBH task with the fixed algorithmic control",
            "limitations": ["This package covers only boolean expressions and word sorting"]}
'''


def reference_package():
    """Return a deterministic, model-free AgentPackage for this two-task slice."""
    return make_package(
        {"main.py": REFERENCE_SOURCE},
        {"entries": {"execute": "main.py:execute"}},
        provenance={
            "origin": "nexgent-bbh.reference-control",
            "benchmark_version": VERSION,
            "algorithm": "recursive Boolean parser and lexicographic word sorting",
        },
    )


def reference_package_main(argv=None):
    """Write the immutable reference AgentPackage for ``task-benchmark``."""
    parser = argparse.ArgumentParser(
        description="Write the model-free BBH two-task reference AgentPackage")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)
    output = args.output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(
        json.dumps(reference_package(), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8")
    print(output)
    return 0


class BigBenchHardTaskBenchmark:
    """Canonical adapter; expected answers never enter task or report payloads."""

    id = "bbh"
    descriptor = BenchmarkDescriptor(
        id=id,
        version=VERSION,
        title="BBH · Boolean expressions + Word sorting",
        splits=SPLITS,
        default_split="development",
        modes=("fixed", "confirmatory"),
        allowed_suite_roles=("qualification",),
        required_capabilities=(),
        evidence_scope=EVIDENCE_SCOPE,
    )

    @classmethod
    def from_project(cls, project_root):
        path = (os.environ.get("NEXGENT_BBH_DATA")
                or Path(project_root) / ".nexgent" / "benchmarks" / "bbh")
        return cls(data_path=path)

    def __init__(self, *, data_path=None, samples_per_task=6, fixture=False):
        if type(samples_per_task) is not int or not 1 <= samples_per_task <= 100:
            raise ValueError("samples_per_task must be an integer in 1..100")
        if type(fixture) is not bool:
            raise ValueError("fixture must be an explicit boolean test option")
        self.data_path = Path(data_path).expanduser().resolve() if data_path else None
        self.samples_per_task = samples_per_task
        self.fixture = fixture
        self._legacy_instance = None

    def _data_identity(self):
        if self.fixture:
            return {"mode": "synthetic_test_fixture", "data_digest": _digest(_fixtures()),
                    "scope": "Authored adapter tests; not official BIG-Bench Hard results"}
        return {**source_manifest(), "mode": "official_pinned_subset"}

    def _manifest(self):
        return {
            "schema": "nexgent-bbh-task-manifest-v1",
            "adapter_version": VERSION,
            "legacy_partition_version": LEGACY_VERSION,
            "data": self._data_identity(),
            "partitions_percent": deepcopy(PARTITIONS),
            "split_aliases": deepcopy(SPLIT_ALIASES),
            "samples_per_task": self.samples_per_task,
            "selection_rule": (
                "Deduplicate normalized public input; sort its SHA256; use fixed disjoint "
                "percentile pools; seed orders examples only inside the selected native pool."
            ),
        }

    def _source_digests(self):
        directory = Path(__file__).parent
        return {
            name: hashlib.sha256((directory / name).read_bytes()).hexdigest()
            for name in ("task_benchmark.py", "benchmark.py", "data.py", "baseline.py")
        }

    def describe(self):
        return {
            **self.descriptor.as_dict(),
            "requested_samples_per_family": self.samples_per_task,
            "task_count_contract": (
                f"Exactly {self.samples_per_task} tasks from each of the two families, "
                "or task generation fails closed when a selected pool is smaller."
            ),
            "data_origin": self._data_identity()["mode"],
            "split_aliases": deepcopy(SPLIT_ALIASES),
            "cost_semantics": deepcopy(COST_SEMANTICS),
            "reference_agent_package": "nexgent_bbh:reference_package",
            "legacy_compatibility": {
                "distribution": "nexgent-bbh",
                "legacy_entry_group": "nexgent.benchmarks",
                "canonical_entry_group": "nexgent.task_benchmarks",
                "shared_logical_id": self.id,
                "record_boundary": (
                    "Legacy study/measurement IDs remain legacy-only; canonical Episode IDs "
                    "must not be interpreted as legacy measurements or resumed across runtimes."
                ),
            },
        }

    def snapshot(self):
        manifest = self._manifest()
        frozen = {
            **self.describe(),
            "manifest": manifest,
            "manifest_digest": _digest(manifest),
            "source_sha256": self._source_digests(),
            "answer_exposure": "Expected answers are absent; only pinned source identities are committed.",
        }
        return {**frozen, "evaluator_digest": _digest(frozen)}

    def availability(self):
        if not self.fixture and self.data_path is None:
            return {"available": False, "reason": "Pinned BBH dataset is not configured"}
        try:
            self._validate_capacity()
        except (DatasetError, OSError, ValueError):
            return {"available": False, "reason": (
                "Pinned BBH data is invalid or its pools cannot satisfy the configured "
                "exact sample count")}
        return {"available": True}

    def _legacy(self):
        if self._legacy_instance is None:
            self._legacy_instance = BigBenchHardBenchmark(
                data_path=self.data_path, samples_per_task=self.samples_per_task,
                fixture=self.fixture)
        return self._legacy_instance

    def _validate_capacity(self, native_split=None):
        benchmark = self._legacy()
        splits = (native_split,) if native_split is not None else tuple(PARTITIONS)
        short = [
            (task, split, len(benchmark._pools[(task, split)]))
            for split in splits for task in TASKS
            if len(benchmark._pools[(task, split)]) < self.samples_per_task
        ]
        if short:
            details = ", ".join(
                f"{task}/{split}={count}" for task, split, count in short)
            raise DatasetError(
                f"BBH requires exactly {self.samples_per_task} samples per family; "
                f"insufficient frozen pool capacity: {details}")
        return benchmark

    @staticmethod
    def _native_split(split):
        if split not in SPLITS:
            raise ValueError("Use a registered BBH split")
        return SPLIT_ALIASES.get(split, split)

    def _suite(self, native_split, seed, cases):
        manifest_digest = self.snapshot()["manifest_digest"]
        return _digest({
            "schema": "nexgent-bbh-public-suite-v1",
            "adapter_version": VERSION,
            "manifest_digest": manifest_digest,
            "native_split": native_split,
            "seed": seed,
            "task_ids": [case["task_id"] for case in cases],
        })

    def _task(self, case, requested_split, native_split, seed, suite_digest):
        public_problem = {
            "task_id": case["task_id"], "category": case["category"],
            "input": case["input"], "requirements": CONTRACT,
        }
        identity = f"bbh/{VERSION}/{native_split}/{seed}/{case['task_id']}"
        return {
            "id": identity,
            "schema_version": "1",
            "statistical_unit_id": f"bbh/example/{case['task_id']}",
            "cluster_id": f"bbh/example/{case['task_id']}",
            "objective": (
                "Solve the supplied public BBH problem. Read the problem artifact, then "
                "publish exactly one answer artifact shaped as {'answer': <string>}. "
                "Follow the problem requirements; do not add explanatory text to the answer."
            ),
            "inputs": {"problem": public_problem},
            "deliverables": [{"name": "answer", "schema": deepcopy(ANSWER_SCHEMA)}],
            "constraints": {
                "allowed_effects": ["read", "artifact_write"],
                "quality_requirements": [
                    "Return one answer string",
                    "Use case-sensitive exact-answer format after whitespace normalization",
                    "Do not claim results beyond this two-task BBH slice",
                ],
            },
            "capabilities": [],
            "context": {
                "domain": self.id, "benchmark": self.id,
                "split": requested_split, "native_split": native_split, "seed": seed,
                "suite_digest": suite_digest,
                "manifest_digest": self.snapshot()["manifest_digest"],
                "category": case["category"],
                "split_aliases": deepcopy(SPLIT_ALIASES),
                "memory_writeback": False,
            },
        }

    def tasks(self, split="development", seed=0, **options):
        if options:
            raise ValueError("BBH canonical adapter has no task options")
        if type(seed) is not int:
            raise ValueError("BBH seed must be an integer")
        native = self._native_split(split)
        benchmark = self._validate_capacity(native)
        cases = benchmark._cases(native, seed)
        counts = {task: sum(case["category"] == task for case in cases) for task in TASKS}
        if (len(cases) != 2 * self.samples_per_task
                or any(counts[task] != self.samples_per_task for task in TASKS)
                or len({case["task_id"] for case in cases}) != len(cases)):
            raise DatasetError(
                "BBH selected suite did not preserve the exact registered family multiset")
        suite = self._suite(native, seed, cases)
        return [self._task(case, split, native, seed, suite) for case in cases]

    def _private_case(self, task_ref):
        if not isinstance(task_ref, dict):
            raise ValueError("Frozen BBH task reference must be an object")
        context = task_ref.get("context")
        if not isinstance(context, dict):
            raise ValueError("Frozen BBH task context is missing")
        split, seed = context.get("split"), context.get("seed")
        if not isinstance(split, str) or type(seed) is not int:
            raise ValueError("Frozen BBH split or seed is invalid")
        candidates = self.tasks(split, seed)
        expected = next((task for task in candidates if task["id"] == task_ref.get("id")), None)
        if expected is None or expected != task_ref:
            raise ValueError("Noncanonical frozen BBH task reference")
        public_id = task_ref["inputs"]["problem"]["task_id"]
        native = self._native_split(split)
        case = next((row for row in self._legacy()._cases(native, seed)
                     if row["task_id"] == public_id), None)
        if case is None:
            raise ValueError("Unknown frozen BBH task reference")
        return case

    def evaluate(self, task_ref, deliverables, execution_view):
        case = self._private_case(task_ref)
        answer_doc = deliverables.get("answer") if isinstance(deliverables, dict) else None
        answer = answer_doc.get("answer") if isinstance(answer_doc, dict) else None
        valid = isinstance(answer, str) and len(answer) <= 100000
        correct = valid and " ".join(answer.split()) == " ".join(case["target"].split())
        context = task_ref["context"]
        usage = execution_view.get("usage") if isinstance(execution_view, dict) else None
        status = "accepted" if correct else "rejected"
        reasons = ([] if correct else
                   ["exact_answer_mismatch" if valid else "answer_artifact_invalid"])
        report = {
            "schema": REPORT_SCHEMA,
            "benchmark": self.id,
            "task_ref": task_ref["id"],
            "task_id": case["task_id"],
            "split": context["split"],
            "native_split": context["native_split"],
            "seed": context["seed"],
            "family": case["category"],
            "group": case["category"],
            "status": status,
            "score_available": True,
            "score": float(correct),
            "accepted": bool(correct),
            "reasons": reasons,
            "suite_digest": context["suite_digest"],
            "manifest_digest": context["manifest_digest"],
            "evaluator_digest": self.snapshot()["evaluator_digest"],
            "cost_semantics": deepcopy(COST_SEMANTICS),
            "host_usage": deepcopy(usage) if isinstance(usage, dict) else None,
            "scope": EVIDENCE_SCOPE,
        }
        report["report_identity"] = self._report_identity(task_ref, report)
        # The report deliberately contains neither the expected answer nor an
        # answer-derived hint. The submitted artifact already lives in the
        # Episode evidence store and is not duplicated here.
        return report

    @staticmethod
    def _report_identity(task_ref, report):
        """Bind public task identity and exact-match outcome without target data."""
        return _digest({
            "schema": REPORT_SCHEMA,
            "task_ref_digest": _digest(task_ref),
            "benchmark": report.get("benchmark"),
            "task_ref": report.get("task_ref"),
            "task_id": report.get("task_id"),
            "family": report.get("family"),
            "group": report.get("group"),
            "split": report.get("split"),
            "native_split": report.get("native_split"),
            "seed": report.get("seed"),
            "suite_digest": report.get("suite_digest"),
            "manifest_digest": report.get("manifest_digest"),
            "evaluator_digest": report.get("evaluator_digest"),
            "status": report.get("status"),
            "score_available": report.get("score_available"),
            "score": report.get("score"),
            "accepted": report.get("accepted"),
            "reasons": report.get("reasons"),
            "cost_semantics": report.get("cost_semantics"),
            "host_usage": report.get("host_usage"),
            "scope": report.get("scope"),
        })

    def aggregate(self, reports):
        """Validate and aggregate one complete evaluator-bound frozen suite."""
        rows = list(reports)
        if not rows:
            raise ValueError("Cannot aggregate an empty BBH report suite")
        try:
            json.dumps(rows, ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError, RecursionError):
            raise ValueError("BBH reports must be finite JSON") from None
        first = rows[0]
        if not isinstance(first, dict):
            raise ValueError("BBH reports must be objects")
        split, seed = first.get("split"), first.get("seed")
        if not isinstance(split, str) or type(seed) is not int:
            raise ValueError("BBH reports have an invalid frozen split or seed")
        expected_tasks = self.tasks(split, seed)
        expected_by_ref = {task["id"]: task for task in expected_tasks}
        expected_refs = set(expected_by_ref)
        expected_native = self._native_split(split)
        expected_suite = expected_tasks[0]["context"]["suite_digest"]
        snapshot = self.snapshot()
        expected_manifest = snapshot["manifest_digest"]
        expected_evaluator = snapshot["evaluator_digest"]
        required = {
            "schema", "benchmark", "task_ref", "task_id", "split", "native_split",
            "seed", "family", "group", "status", "score_available", "score",
            "accepted", "reasons", "suite_digest", "manifest_digest",
            "evaluator_digest", "report_identity", "cost_semantics", "scope",
            "host_usage",
        }
        seen = set()
        for row in rows:
            if not isinstance(row, dict) or not required.issubset(row):
                raise ValueError("BBH report schema is incomplete")
            score = row.get("score")
            accepted = row.get("accepted")
            if (row.get("schema") != REPORT_SCHEMA
                    or row.get("benchmark") != self.id
                    or row.get("score_available") is not True
                    or type(score) not in {int, float}
                    or not math.isfinite(score)
                    or score not in {0.0, 1.0}
                    or type(accepted) is not bool
                    or accepted != (score == 1.0)
                    or row.get("status") != ("accepted" if accepted else "rejected")
                    or not isinstance(row.get("reasons"), list)
                    or any(not isinstance(reason, str) for reason in row["reasons"])
                    or bool(row["reasons"]) == accepted
                    or row.get("cost_semantics") != COST_SEMANTICS
                    or not (row.get("host_usage") is None
                            or isinstance(row.get("host_usage"), dict))
                    or row.get("scope") != EVIDENCE_SCOPE):
                raise ValueError("BBH report has an invalid exact-match outcome schema")
            task_ref = row.get("task_ref")
            if not isinstance(task_ref, str) or task_ref in seen:
                raise ValueError("BBH report task references must be unique")
            seen.add(task_ref)
            expected = expected_by_ref.get(task_ref)
            if expected is None:
                raise ValueError("BBH report references a task outside the frozen suite")
            problem = expected["inputs"]["problem"]
            if (row.get("task_id") != problem["task_id"]
                    or row.get("family") != problem["category"]
                    or row.get("group") != problem["category"]
                    or row.get("split") != split
                    or row.get("native_split") != expected_native
                    or row.get("seed") != seed
                    or row.get("suite_digest") != expected_suite
                    or row.get("manifest_digest") != expected_manifest
                    or row.get("evaluator_digest") != expected_evaluator
                    or row.get("report_identity") != self._report_identity(expected, row)):
                raise ValueError("BBH report identity differs from the frozen public task")
        if seen != expected_refs or len(rows) != len(expected_tasks):
            raise ValueError("BBH reports are not the complete frozen task multiset")
        groups = {}
        for family in TASKS:
            selected = [row for row in rows if row.get("family") == family]
            if len(selected) != self.samples_per_task:
                raise ValueError("BBH reports do not preserve the registered family counts")
            available = bool(selected) and all(row.get("score_available") is True for row in selected)
            groups[family] = {
                "score": (sum(row["score"] for row in selected) / len(selected)
                          if available else None),
                "tasks": len(selected),
                "score_available": available,
            }
        available = all(row.get("score_available") is True for row in rows)
        return {
            "score": sum(row["score"] for row in rows) / len(rows) if available else None,
            "score_available": available,
            "tasks": len(rows),
            "groups": groups,
            "suite_digest": rows[0]["suite_digest"],
        }


def task_benchmark_adapter():
    return BigBenchHardTaskBenchmark()


__all__ = [
    "BigBenchHardTaskBenchmark", "REFERENCE_SOURCE", "reference_package",
    "reference_package_main", "task_benchmark_adapter",
]
