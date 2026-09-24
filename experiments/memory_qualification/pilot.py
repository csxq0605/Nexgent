"""Run one development -> generated M -> selection -> frozen-reuse pilot.

The benchmark adapter remains the sole owner of evaluation.  This module only
selects public task references, freezes their identities before generation,
and drives the framework's normal GenerationService and MemoryService paths.
It is a mechanism qualification, not a causal estimate of memory benefit.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import json
from pathlib import Path
import time
import uuid

from nexgent.kernel.programs import digest
from nexgent.tasks.benchmarks import host_runtime_fingerprint, validate_snapshot, validate_tasks
from nexgent.tasks.evolution import EvolutionService
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.improver_seed import default_improver_package
from nexgent.tasks.memory import MemoryService
from nexgent.tasks.multirole_seed import multirole_package
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError, task_benchmarks


SCHEMA = "nexgent.pure-m-qualification.v1"
TASK_CHANNEL = "memory-qualification-agent"
MEMORY_CHANNEL = "memory-qualification-release"
MEMORY_COMPONENT = "working-memory"
FORBIDDEN_SPLITS = frozenset({
    "final_holdout", "final_transfer", "meta_transfer", "confirmation",
})
TASK_BUDGET = {
    "max_model_calls": 3,
    "max_completion_tokens": 4800,
    "max_tool_calls": 0,
    "max_nodes": 30,
}
GENERATION_BUDGET = {
    "max_model_calls": 1,
    "max_completion_tokens": 6000,
    "max_tool_calls": 0,
    "max_nodes": 12,
}


MEMORY_PREPARE_SOURCE = '''def prepare(payload, context):
    inputs = {}
    for name, artifact_id in sorted(payload.get("input_refs", {}).items()):
        artifact = context.read_artifact(artifact_id)
        inputs[name] = artifact["content"]
    memory = context.memory_search("", 20)
    return {
        "objective": payload.get("objective", ""),
        "inputs": inputs,
        "deliverables": payload.get("deliverables", []),
        "constraints": payload.get("constraints", {}),
        "memory": memory,
    }
'''


def root_memory_resource():
    """Return the empty, inert M baseline used before generated evolution."""
    return {
        "policy": {
            "retrieval": {"kind": "literal-any-term", "version": 1,
                          "max_results": 20},
            "writeback": {"enabled": False, "allowed_kinds": []},
        },
        "data": {"items": []},
    }


def memory_ready_package():
    """Add an explicit M resource and actual retrieval to the fixed baseline."""
    baseline = multirole_package()
    files = deepcopy(baseline["files"])
    manifest = deepcopy(baseline["manifest"])
    resource = root_memory_resource()
    files["skills/prepare.py"] = MEMORY_PREPARE_SOURCE
    files["memory/root.json"] = json.dumps(
        resource, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    manifest["components"][MEMORY_COMPONENT] = {
        "class": "M", "kind": "resource", "ref": "memory/root.json"}
    return make_package(files, manifest, provenance={
        "origin": "nexgent.memory-qualification-parent",
        "scope": "domain-neutral model-driven pure-M qualification",
        "baseline_package_digest": baseline["digest"],
    })


def _unit(task_ref):
    value = task_ref.get("statistical_unit_id")
    if not isinstance(value, str) or not value:
        raise ContractError(
            "Memory qualification requires benchmark statistical_unit_id values")
    return value


def _one_disjoint_task(adapter, *, split, seed, excluded):
    if split in FORBIDDEN_SPLITS:
        raise ContractError("Frozen or transfer splits cannot enter M qualification")
    rows = validate_tasks(adapter.tasks(split=split, seed=seed))
    for row in rows:
        if _unit(row) not in excluded:
            return row
    raise ContractError("No unused statistical unit is available for M qualification")


def freeze_tasks(adapter, *, feedback_seed, selection_seed, reuse_seed,
                 reuse_split="development"):
    """Resolve all task units before the improver model can be called."""
    feedback = _one_disjoint_task(
        adapter, split="development", seed=feedback_seed, excluded=set())
    used = {_unit(feedback)}
    selection = _one_disjoint_task(
        adapter, split="selection", seed=selection_seed, excluded=used)
    used.add(_unit(selection))
    reuse = _one_disjoint_task(
        adapter, split=reuse_split, seed=reuse_seed, excluded=used)
    frozen = {"feedback": feedback, "selection": selection, "reuse": reuse}
    if len({_unit(task) for task in frozen.values()}) != 3:
        raise ContractError("M qualification statistical units must be pairwise disjoint")
    return frozen


def _package_registration(registration):
    return {key: registration[key] for key in (
        "channel", "revision", "package_id", "package_digest")}


def _bootstrap(tasks, evolution, memory):
    package = memory_ready_package()
    try:
        task_release = evolution.active(TASK_CHANNEL)
    except (KeyError, ContractError):
        task_release = evolution.register(TASK_CHANNEL, package)
    if task_release["package_digest"] != package["digest"]:
        raise ContractError("M qualification task channel has another package")
    try:
        memory_release = memory.active(MEMORY_CHANNEL)
    except (KeyError, ContractError):
        root = memory.admit(
            package, root_memory_resource(),
            provenance={"origin": "qualification_bootstrap", "claim": "none"})
        evaluator = {
            "id": "memory-qualification-bootstrap", "revision": 1,
            "criterion": "finite normalized empty root bound to exact package",
        }
        plan = memory.plan_selection(
            root["id"], criteria={"bootstrap_only": True},
            evaluator_snapshot=evaluator)
        memory.assess(
            plan["id"], evaluator_snapshot=evaluator, verdict="accepted",
            reason="Host bootstrap of the inert empty memory root",
            evidence={"resource_digest": digest(root_memory_resource())})
        memory_release = memory.register(MEMORY_CHANNEL, root["id"])
    if (memory_release["package_id"] != package["id"]
            or memory_release["package_digest"] != package["digest"]):
        raise ContractError("M qualification memory channel belongs to another package")
    return package, task_release, memory_release


def _run_task(tasks, adapter, task_ref, *, task_release, memory_release, budget,
              on_created=None):
    snapshot = validate_snapshot(adapter.snapshot())
    registration = {
        "benchmark_id": adapter.id,
        "task_ref": deepcopy(task_ref),
        "snapshot": deepcopy(snapshot),
        "host_runtime": host_runtime_fingerprint(),
    }
    context = deepcopy(task_ref.get("context") or {})
    context["memory_writeback"] = False
    episode = tasks.create(
        task_ref["objective"], task_ref.get("inputs"), task_ref.get("deliverables"),
        deepcopy(budget), task_ref.get("capabilities"), context=context,
        constraints=task_ref.get("constraints"), entry=task_ref.get("entry", "execute"),
        package_channel=TASK_CHANNEL,
        expected_package_registration=_package_registration(task_release),
        memory_channel=MEMORY_CHANNEL,
        expected_memory_registration=memory_release,
        benchmark_registration=registration)
    if on_created is not None:
        on_created(episode)
    tasks.run(episode["id"])
    return tasks.evaluate(episode["id"], adapter, deepcopy(task_ref), snapshot=snapshot)


def _call_projection(tasks, episode_id):
    return [{
        "role": call.get("role"),
        "configured_model": call.get("configured_provider_model"),
        "observed_model": call.get("observed_provider_model"),
        "provider_revision": call.get("provider_revision"),
        "status": call.get("status"),
    } for call in tasks.store.calls(episode_id)]


def _public_outcome(result):
    report = result["evaluation"]
    return {
        "episode_id": result["episode_id"],
        "status": report.get("status"),
        "score_available": report.get("score_available"),
        "score": report.get("score"),
        "accepted": report.get("accepted"),
        "usage": result.get("usage"),
    }


def _error_category(exc):
    if isinstance(exc, ContractError):
        return "contract_rejected"
    if isinstance(exc, (KeyboardInterrupt, SystemExit)):
        return "interrupted"
    return "execution_failed"


def _reserve_attempt(tasks, receipt, receipt_path):
    """Durably spend task units before the first model-bearing Episode runs."""
    attempt_id = receipt["attempt_id"]
    rows = [(receipt["benchmark_id"], value["statistical_unit_id"], phase,
             attempt_id) for phase, value in receipt["frozen_tasks"].items()]
    encoded = json.dumps(receipt, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), allow_nan=False)
    with tasks.store.connect() as db:
        db.executescript("""
            CREATE TABLE IF NOT EXISTS memory_qualification_attempts(
                id TEXT PRIMARY KEY, benchmark_id TEXT NOT NULL,
                status TEXT NOT NULL, receipt_path TEXT NOT NULL,
                data TEXT NOT NULL, digest TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS memory_qualification_units(
                benchmark_id TEXT NOT NULL, statistical_unit_id TEXT NOT NULL,
                phase TEXT NOT NULL, attempt_id TEXT NOT NULL,
                PRIMARY KEY(benchmark_id, statistical_unit_id));
        """)
        db.execute("BEGIN IMMEDIATE")
        if db.execute(
                "SELECT 1 FROM memory_qualification_attempts WHERE id=?",
                (attempt_id,)).fetchone():
            db.rollback()
            raise ContractError(
                "Memory qualification attempt already exists; automatic replay is disabled")
        try:
            db.execute(
                "INSERT INTO memory_qualification_attempts VALUES(?,?,?,?,?,?)",
                (attempt_id, receipt["benchmark_id"], receipt["status"],
                 str(receipt_path), encoded, digest(receipt)))
            db.executemany(
                "INSERT INTO memory_qualification_units VALUES(?,?,?,?)", rows)
        except Exception as exc:
            db.rollback()
            raise ContractError(
                "A frozen M-qualification statistical unit was already spent") from exc


def _checkpoint_attempt(tasks, receipt):
    encoded = json.dumps(receipt, ensure_ascii=False, sort_keys=True,
                         separators=(",", ":"), allow_nan=False)
    with tasks.store.connect() as db:
        changed = db.execute(
            "UPDATE memory_qualification_attempts SET status=?,data=?,digest=? WHERE id=?",
            (receipt["status"], encoded, digest(receipt), receipt["attempt_id"])).rowcount
        if changed != 1:
            raise ContractError("M qualification attempt ledger is unavailable")


def run_pilot(root, adapter, *, feedback_seed=0, selection_seed=0,
              reuse_seed=1, reuse_split="development", gateway_factory=None,
              receipt_path=None, attempt_id=None):
    """Execute one fail-closed qualification and return its sanitized receipt."""
    root = Path(root).resolve()
    receipt_path = (Path(receipt_path).resolve() if receipt_path else
                    root / ".nexgent" / "exports" / "memory-qualification" /
                    f"pilot-{time.time_ns()}-{uuid.uuid4().hex[:8]}.json")
    receipt_path.parent.mkdir(parents=True, exist_ok=True)
    receipt = {
        "schema": SCHEMA, "status": "planning", "claim": "mechanism_qualification_only",
        "attempt_id": attempt_id or "memory-attempt-" + uuid.uuid4().hex[:16],
        "benchmark_id": adapter.id, "started_at": time.time(),
    }
    tasks = None
    reserved = False

    def save():
        receipt_path.write_text(json.dumps(
            receipt, ensure_ascii=False, indent=2, allow_nan=False) + "\n",
            encoding="utf-8")
        if reserved:
            _checkpoint_attempt(tasks, receipt)

    save()
    try:
        frozen = freeze_tasks(
            adapter, feedback_seed=feedback_seed, selection_seed=selection_seed,
            reuse_seed=reuse_seed, reuse_split=reuse_split)
        receipt["frozen_tasks"] = {name: {
            "id": task["id"], "digest": digest(task),
            "statistical_unit_id": _unit(task),
        } for name, task in frozen.items()}
        receipt["benchmark_snapshot_digest"] = digest(validate_snapshot(adapter.snapshot()))
        receipt["status"] = "tasks_frozen"
        save()

        tasks = TaskService(root, gateway_factory=gateway_factory)
        _reserve_attempt(tasks, receipt, receipt_path)
        reserved = True
        evolution = EvolutionService(tasks)
        generation = GenerationService(tasks, evolution)
        memory = MemoryService(tasks)
        package, task_release, memory_release = _bootstrap(tasks, evolution, memory)
        receipt["parent_package_digest"] = package["digest"]
        receipt["parent_memory_id"] = memory_release["memory_id"]
        receipt["parent_memory_digest"] = memory_release["memory_digest"]

        def development_created(episode):
            receipt["development"] = {"episode_id": episode["id"],
                                      "status": "admitted"}
            receipt["status"] = "development_admitted"
            save()

        development = _run_task(
            tasks, adapter, frozen["feedback"], task_release=task_release,
            memory_release=memory_release, budget=TASK_BUDGET,
            on_created=development_created)
        receipt["development"] = _public_outcome(development)
        receipt["development"]["model_calls"] = _call_projection(
            tasks, development["episode_id"])
        bundle = generation.capture_feedback(
            TASK_CHANNEL, [development["episode_id"]], task_release["revision"])
        receipt["feedback_bundle_id"] = bundle["id"]
        receipt["feedback_bundle_digest"] = bundle["digest"]
        receipt["status"] = "feedback_frozen"
        save()

        receipt["status"] = "generation_admitted"
        receipt["generation"] = {
            "status": "admitted", "feedback_bundle_id": bundle["id"]}
        save()
        generated = generation.generate(
            TASK_CHANNEL, bundle["id"], default_improver_package(),
            {"mutable_components": [MEMORY_COMPONENT],
             "allowed_operations": ["replace"], "max_patch_bytes": 100000},
            task_release["revision"], memory_channel=MEMORY_CHANNEL,
            expected_memory_revision=memory_release["revision"],
            budget=GENERATION_BUDGET)
        receipt["generation"] = {
            "id": generated["id"], "status": generated["status"],
            "reason_type": generated.get("reason_type"),
            "episode_id": generated.get("episode_id"),
            "memory_candidate_id": generated.get("memory_candidate_id"),
            "memory_candidate_digest": generated.get("memory_candidate_digest"),
            "usage": generated.get("usage"),
        }
        if generated.get("episode_id"):
            receipt["generation"]["model_calls"] = _call_projection(
                tasks, generated["episode_id"])
        if generated["status"] != "generated":
            receipt.update(status="generation_abstained_or_missing",
                           completed_at=time.time())
            save()
            return receipt

        candidate_id = generated["memory_candidate_id"]
        evaluator_snapshot = validate_snapshot(adapter.snapshot())
        plan = memory.plan_selection(
            candidate_id,
            criteria={"benchmark_acceptance_required": True,
                      "candidate_memory_consumption_required": True},
            evaluator_snapshot=evaluator_snapshot, channel=MEMORY_CHANNEL,
            expected_revision=memory_release["revision"])
        receipt["status"] = "selection_admitted"
        receipt["selection"] = {"plan_id": plan["id"], "status": "admitted"}
        save()
        execution = memory.evaluate_generated_candidate(
            plan["id"], adapter=adapter, task_ref=frozen["selection"],
            budget=TASK_BUDGET)
        decision = memory.assess(
            plan["id"], evaluator_snapshot=evaluator_snapshot,
            verdict=execution["verdict"],
            reason="Host-frozen benchmark selection and memory-consumption gate",
            evidence={"selection_execution_id": execution["id"],
                      "selection_execution_digest": execution["digest"]})
        selection_episode = tasks.get_private(execution["episode_id"])
        receipt["selection"] = {
            "plan_id": plan["id"], "execution_id": execution["id"],
            "episode_id": execution["episode_id"],
            "episode_status": execution["episode_status"],
            "memory_consumed": execution["memory_consumed"],
            "verdict": execution["verdict"], "decision_id": decision["id"],
            "evaluation_status": (selection_episode.get("evaluation") or {}).get("status"),
            "score": (selection_episode.get("evaluation") or {}).get("score"),
            "model_calls": _call_projection(tasks, execution["episode_id"]),
        }
        if decision["verdict"] != "accepted":
            receipt.update(status="selection_rejected", completed_at=time.time())
            save()
            return receipt

        promoted = memory.promote(
            MEMORY_CHANNEL, candidate_id, expected_revision=memory_release["revision"],
            expected_memory_id=memory_release["memory_id"])
        def reuse_created(episode):
            receipt["reuse"] = {"episode_id": episode["id"], "status": "admitted"}
            receipt["status"] = "reuse_admitted"
            save()

        reuse = _run_task(
            tasks, adapter, frozen["reuse"], task_release=task_release,
            memory_release=promoted, budget=TASK_BUDGET,
            on_created=reuse_created)
        reuse_episode = tasks.get_private(reuse["episode_id"])
        reuse_snapshot = tasks.store.memory_snapshot(
            reuse_episode["memory_snapshot_id"], reuse_episode["id"])
        candidate_item_ids = {
            item["id"] for item in memory.version(candidate_id)["resource"]["data"]["items"]}
        consumed_item_ids = {
            item_id for event in reuse_episode["events"]
            if event["kind"] == "memory_consumed"
            and event["content"].get("snapshot_id") == reuse_snapshot["id"]
            for item_id in event["content"].get("item_ids", [])}
        activated = bool(candidate_item_ids & consumed_item_ids)
        receipt["promotion"] = {
            "channel": promoted["channel"], "revision": promoted["revision"],
            "memory_id": promoted["memory_id"],
            "memory_digest": promoted["memory_digest"],
        }
        receipt["reuse"] = {
            **_public_outcome(reuse),
            "snapshot_id": reuse_snapshot["id"],
            "snapshot_digest": reuse_snapshot["digest"],
            "promoted_memory_frozen": (
                reuse_snapshot.get("source", {}).get("memory_id") == candidate_id),
            "candidate_memory_consumed": activated,
            "model_calls": _call_projection(tasks, reuse["episode_id"]),
        }
        receipt.update(
            status=("completed" if activated else "reuse_not_activated"),
            completed_at=time.time())
    except BaseException as exc:
        receipt.update(status="error", error_type=type(exc).__name__,
                       error_category=_error_category(exc),
                       completed_at=time.time())
        save()
        raise
    save()
    return receipt


def load_adapter(benchmark, root, *, bbh_data=None):
    """Resolve an installed adapter, with an explicit BBH data-path escape hatch."""
    if bbh_data is not None:
        if benchmark != "bbh":
            raise ContractError("--bbh-data can only be used with --benchmark bbh")
        try:
            from nexgent_bbh.task_benchmark import BigBenchHardTaskBenchmark
        except ImportError as exc:
            raise ContractError(
                "The BBH task-benchmark package is not importable on PYTHONPATH") from exc
        return BigBenchHardTaskBenchmark(
            data_path=Path(bbh_data).resolve(), samples_per_task=1)
    adapters = task_benchmarks(root)
    if benchmark not in adapters:
        raise ContractError(
            f"Task benchmark is not installed: {benchmark}; provide --bbh-data for BBH")
    return adapters[benchmark]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--benchmark", required=True)
    parser.add_argument("--bbh-data", type=Path)
    parser.add_argument("--feedback-seed", type=int, default=0)
    parser.add_argument("--selection-seed", type=int, default=0)
    parser.add_argument("--reuse-seed", type=int, default=1)
    parser.add_argument("--reuse-split", default="development")
    parser.add_argument("--attempt-id")
    args = parser.parse_args(argv)
    adapter = load_adapter(
        args.benchmark, args.root, bbh_data=args.bbh_data)
    output = (args.root.resolve() / ".nexgent" / "exports" /
              "memory-qualification")
    output.mkdir(parents=True, exist_ok=True)
    receipt_path = output / f"pilot-{time.time_ns()}-{uuid.uuid4().hex[:8]}.json"
    receipt = run_pilot(
        args.root, adapter, feedback_seed=args.feedback_seed,
        selection_seed=args.selection_seed, reuse_seed=args.reuse_seed,
        reuse_split=args.reuse_split, attempt_id=args.attempt_id,
        receipt_path=receipt_path)
    print(json.dumps({"status": receipt["status"],
                      "receipt": str(receipt_path)},
                     ensure_ascii=False))
    return 0 if receipt["status"] in {
        "completed", "selection_rejected", "generation_abstained_or_missing"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
