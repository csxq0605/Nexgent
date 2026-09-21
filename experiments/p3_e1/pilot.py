"""Run one real-model, domain-neutral P3 E1 qualification attempt.

The runner intentionally performs one generation attempt.  Missing or invalid
generation, rejected selection, and guard failure are persisted as a sanitized
receipt and are never retried automatically.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path
import time
import uuid

from nexgent.kernel.programs import digest
from nexgent.tasks.cycles import RSICycleService
from nexgent.tasks.evidence import export_p3_e1_evidence
from nexgent.tasks.evolution import (
    EvolutionService,
    PromotionPolicy,
    host_runtime_fingerprint,
)
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.improver_seed import default_improver_package
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService


PARENT_SOURCE = """def execute(payload, context):
    artifact = context.publish({'version': 0, 'score': 0.0}, name='result')
    return {'deliverables': {'result': artifact['id']}}
"""


def result_spec():
    return [{"name": "result", "schema": {
        "type": "object",
        "required": ["version", "score"],
        "properties": {
            "version": {"type": "integer"},
            "score": {"type": "number"},
        },
    }}]


def parent_package():
    return make_package(
        {"behavior.py": PARENT_SOURCE},
        {"entries": {"execute": "behavior.py:execute"}},
        provenance={"fixture": "p3-e1-domain-neutral-parent"},
    )


class P3E1QualificationBenchmark:
    """Three disjoint task identities with one public generic contract."""

    id = "p3-e1-qualification-v1"

    def snapshot(self):
        return {"id": self.id, "evaluator_digest": "p3-e1-public-result-v1"}

    def describe(self):
        return {"id": self.id, "kind": "domain-neutral-qualification"}

    def tasks(self, split="development", seed=0):
        if split not in {"development", "selection", "guard"}:
            raise ValueError("P3 E1 benchmark supports development, selection, and guard")
        return [self.task(split, seed)]

    def task(self, split, seed=0):
        identity = f"p3-e1/{split}/{seed}"
        unit = f"p3-e1-unit/{split}/{seed}"
        cluster = "p3-e1-generic-result-v1"
        return {
            "id": identity,
            "statistical_unit_id": unit,
            "cluster_id": cluster,
            "objective": (
                "Publish result with integer version=1 and numeric score=1.0."
            ),
            "inputs": {"qualification_case": {"split": split, "seed": seed}},
            "deliverables": result_spec(),
            "capabilities": [],
            "context": {"split": split, "split_role": split,
                        "task_identity": identity,
                        "statistical_unit_id": unit,
                        "cluster_id": cluster},
        }

    def reuse_task(self):
        row = self.task("development", 97)
        row["id"] = "p3-e1/reuse/97"
        row["statistical_unit_id"] = "p3-e1-unit/reuse/97"
        row["inputs"] = {"qualification_case": {"split": "reuse", "seed": 97}}
        row["context"] = {"split": "development", "split_role": "development",
                          "qualification_role": "post-promotion-reuse",
                          "task_identity": row["id"],
                          "statistical_unit_id": row["statistical_unit_id"],
                          "cluster_id": row["cluster_id"]}
        return row

    def evaluate(self, task_ref, deliverables, execution_view):
        result = deliverables["result"]
        score = float(result.get("score", 0.0))
        version = result.get("version")
        accepted = version == 1 and score == 1.0
        return {
            "status": "accepted" if accepted else "rejected",
            "score_available": True,
            "score": score,
            "accepted": accepted,
        }


def _write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2,
                   allow_nan=False) + "\n",
        encoding="utf-8",
    )


def _benchmark_registration(benchmark, task_ref):
    return {
        "benchmark_id": benchmark.id,
        "task_ref": deepcopy(task_ref),
        "snapshot": deepcopy(benchmark.snapshot()),
        "host_runtime": host_runtime_fingerprint(),
    }


def _append_attempt_index(output, receipt):
    row = {key: receipt[key] for key in (
        "attempt_id", "started_at", "channel", "receipt_path")}
    output.mkdir(parents=True, exist_ok=True)
    with (output / "attempts.jsonl").open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True,
                                allow_nan=False) + "\n")


def _safe_generation(generation, generation_id):
    try:
        record = generation.generation(generation_id)
    except (KeyError, ValueError):
        return {"id": generation_id, "status": "unavailable"}
    return {key: deepcopy(record.get(key)) for key in (
        "id", "status", "reason_type", "reason_digest", "episode_id",
        "episode_status", "feedback_bundle_id", "improver_package_id",
        "improver_package_digest", "candidate_id", "candidate_package_id",
        "candidate_package_digest", "usage", "record_digest",
    )}


def run_pilot(project_root, output):
    """Run exactly one pilot attempt and return its sanitized receipt."""
    project_root = Path(project_root).resolve()
    output = Path(output).resolve()
    attempt_id = "p3-e1-attempt-" + uuid.uuid4().hex[:16]
    attempt_dir = output / attempt_id
    attempt_dir.mkdir(parents=True, exist_ok=False)
    receipt_path = attempt_dir / "p3-e1-pilot-receipt.json"
    evidence_path = attempt_dir / "p3-e1-evidence.json"
    channel = "p3-e1-" + uuid.uuid4().hex[:12]
    receipt = {
        "schema": "nexgent.p3-e1-pilot-receipt.v1",
        "attempt_id": attempt_id,
        "started_at": time.time(),
        "project_root_digest": digest(str(project_root)),
        "channel": channel,
        "status": "running",
        "automatic_retries": 0,
        "receipt_path": str(receipt_path),
    }
    _write_json(receipt_path, receipt)
    _append_attempt_index(output, receipt)
    tasks = evolution = generation = cycles = None
    cycle_id = None
    try:
        tasks = TaskService(project_root)
        evolution = EvolutionService(tasks)
        generation = GenerationService(tasks, evolution)
        cycles = RSICycleService(tasks, evolution, generation)
        benchmark = P3E1QualificationBenchmark()
        parent = parent_package()
        evolution.register(channel, parent)

        development = benchmark.task("development", 3)
        feedback_episode = tasks.create(
            development["objective"], development["inputs"],
            development["deliverables"], capabilities=development["capabilities"],
            context=development["context"], package_channel=channel,
            benchmark_registration=_benchmark_registration(benchmark, development))
        feedback_episode = tasks.run(feedback_episode["id"])
        tasks.evaluate(
            feedback_episode["id"], benchmark, development,
            snapshot=benchmark.snapshot())

        cycle = cycles.create(
            channel=channel,
            feedback_episode_ids=[feedback_episode["id"]],
            improver_package=default_improver_package(),
            mutation_policy={
                "mutable_paths": ["behavior.py"],
                "component_classes": {"behavior.py": "O"},
                "allowed_operations": ["replace"],
                "max_patch_bytes": 100000,
            },
            expected_revision=0,
            selection_adapter=benchmark,
            guard_adapter=benchmark,
            selection_seed=17,
            guard_seed=23,
            generation_budget={
                "max_model_calls": 1,
                "max_completion_tokens": 6000,
                "max_tool_calls": 0,
                "max_nodes": 16,
            },
            policy=PromotionPolicy(
                min_quality_delta=0.5,
                monitor_min_score=1.0,
                monitor_min_success_rate=1.0,
            ),
        )
        cycle_id = cycle["id"]
        cycle = cycles.run(cycle_id, benchmark, benchmark)
        receipt["cycle"] = cycles.public(cycle_id)
        generation_id = (cycle.get("refs") or {}).get("generation_id")
        if generation_id:
            receipt["generation"] = _safe_generation(generation, generation_id)
        if cycle["status"] != "completed":
            receipt["status"] = "failed"
            receipt["failure_stage"] = cycle["status"]
            receipt["completed_at"] = time.time()
            _write_json(receipt_path, receipt)
            return receipt

        active = evolution.active(channel)
        reuse_task = benchmark.reuse_task()
        registration = {key: active[key] for key in (
            "channel", "revision", "package_id", "package_digest")}
        reuse = tasks.create(
            reuse_task["objective"], reuse_task["inputs"],
            reuse_task["deliverables"], capabilities=reuse_task["capabilities"],
            context=reuse_task["context"], package_channel=channel,
            expected_package_registration=registration,
            benchmark_registration=_benchmark_registration(benchmark, reuse_task))
        reuse = tasks.run(reuse["id"])
        tasks.evaluate(reuse["id"], benchmark, reuse_task, snapshot=benchmark.snapshot())
        export_p3_e1_evidence(
            evidence_path, cycles, cycle_id=cycle_id,
            reuse_episode_ids=[reuse["id"]])
        receipt.update({
            "status": "completed",
            "reuse_episode_id": reuse["id"],
            "evidence_path": str(evidence_path),
            "completed_at": time.time(),
        })
    except Exception as exc:
        receipt.update({
            "status": "failed",
            "failure_stage": "exception",
            "error_type": type(exc).__name__,
            "error_digest": digest({"type": type(exc).__name__, "message": str(exc)}),
            "completed_at": time.time(),
        })
        if cycles is not None and cycle_id is not None:
            try:
                cycle = cycles.get(cycle_id)
                receipt["cycle"] = cycles.public(cycle_id)
                generation_id = (cycle.get("refs") or {}).get("generation_id")
                if generation_id and generation is not None:
                    receipt["generation"] = _safe_generation(generation, generation_id)
            except Exception:
                receipt["cycle_projection"] = "unavailable"
    _write_json(receipt_path, receipt)
    return receipt


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="Run one domain-neutral real-model P3 E1 qualification attempt")
    parser.add_argument("--project-root", default=".",
                        help="Project containing the existing models.json")
    parser.add_argument("--output", required=True,
                        help="Directory for sanitized receipt and successful evidence")
    args = parser.parse_args(argv)
    receipt = run_pilot(args.project_root, args.output)
    print(json.dumps(receipt, ensure_ascii=False, sort_keys=True, allow_nan=False))
    return 0 if receipt["status"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
