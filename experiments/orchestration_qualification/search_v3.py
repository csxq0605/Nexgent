"""Run bounded MiMo-ready O search on fresh BBH development units.

This runner never opens selection.  Each model attempt is preceded by an
append-only intent event, uses GenerationService with an independently frozen
repair-aware R0 package, and must change the reachable execution graph before
it can spend a paired development qualification.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from nexgent.tasks.evolution import EvolutionService, PromotionPolicy
from nexgent.tasks.generation import GenerationService, PACKAGE_PATCH_SCHEMA
from nexgent.tasks.multirole_seed import multirole_package
from nexgent.tasks.orchestration_search import (
    BoundedOrchestrationSearch, DevelopmentQualificationError,
    QUALIFICATION_SCHEMA, paired_episode_budget)
from nexgent.tasks.orchestration_search_seed import (
    orchestration_search_improver_package)
from nexgent.tasks.package_runner import CapabilityAbort
from nexgent.tasks.runtime import TaskService
from nexgent_bbh.task_benchmark import BigBenchHardTaskBenchmark

from .preflight_v3 import _disjoint_units


def _sum_usage(total, value):
    total["model_calls"] += value.get("model_calls", 0)
    total["completion_tokens"] += value.get(
        "charged_completion_tokens", value.get("completion_tokens", 0))
    total["tool_calls"] += value.get(
        "charged_tool_calls", value.get("tool_calls", 0))
    total["nodes"] += value.get("nodes", 0)


def _used_statistical_units(tasks):
    """Exclude every unit already opened in any prior benchmark Episode."""
    units = set()
    for state in tasks.store.list():
        registration = tasks.store.benchmark_registration(state["id"])
        task_ref = (registration or {}).get("task_ref") or {}
        unit = task_ref.get("statistical_unit_id")
        if isinstance(unit, str) and unit:
            units.add(unit)
    return units


def _failed_qualification(tasks, evolution, plan_id, exc):
    cause = exc.cause if isinstance(exc, CapabilityAbort) else exc
    episodes, usage = [], {"model_calls": 0, "completion_tokens": 0,
                           "tool_calls": 0, "nodes": 0,
                           "usage_complete": True}
    statuses = {}
    for state in tasks.store.list():
        registration = (state.get("task", {}).get("context", {}).get(
            "evolution_registration") or {})
        if registration.get("plan_id") != plan_id:
            continue
        current = tasks.get_private(state["id"])
        episodes.append(current["id"])
        statuses[current["id"]] = current["status"]
        _sum_usage(usage, current.get("usage") or {})
        if (current.get("usage", {}).get("usage_complete") is not True
                or current.get("status") not in {"completed", "failed"}):
            usage["usage_complete"] = False
    trial_id = None
    try:
        claim = evolution.inspect_run_claim("paired", plan_id)
        if claim and claim.get("status") == "completed":
            trial_id = claim.get("record_id")
    except Exception:
        pass
    return DevelopmentQualificationError({
        "failure_type": type(cause).__name__,
        "evidence_refs": {"plan_id": plan_id, "trial_id": trial_id,
                          "episode_ids": sorted(episodes)},
        "episode_statuses": statuses,
        "usage": usage,
    })


def _qualification(tasks, evolution, adapter, candidate, *, seed, excluded,
                   remaining_budget):
    preview = adapter.tasks(split="development", seed=seed)
    units = _disjoint_units(excluded, preview)
    episode_count = 2 * len(preview)
    parent = tasks.store.package(candidate["parent_package_id"])
    child = tasks.store.package(candidate["package_id"])
    try:
        estimate = paired_episode_budget(parent, child)
    except Exception as exc:
        raise DevelopmentQualificationError({
            "failure_type": type(exc).__name__,
            "evidence_refs": {"plan_id": None, "trial_id": None,
                              "episode_ids": []},
            "episode_statuses": {},
            "usage": {"model_calls": 0, "completion_tokens": 0,
                      "tool_calls": 0, "nodes": 0, "usage_complete": True},
        }) from None
    cap = estimate["episode_budget"]
    required = {
        "model_calls": cap["max_model_calls"] * episode_count,
        "completion_tokens": cap["max_completion_tokens"] * episode_count,
        "tool_calls": cap["max_tool_calls"] * episode_count,
        "nodes": cap["max_nodes"] * episode_count,
    }
    if any(remaining_budget[key] < value for key, value in required.items()):
        raise DevelopmentQualificationError({
            "failure_type": "InsufficientSearchBudget",
            "evidence_refs": {"plan_id": None, "trial_id": None,
                              "episode_ids": []},
            "episode_statuses": {},
            "required_budget": required,
            "usage": {"model_calls": 0, "completion_tokens": 0,
                      "tool_calls": 0, "nodes": 0, "usage_complete": True},
        })
    plan = evolution.plan_pair(
        candidate["id"], adapter, split="development", split_role="development",
        seed=seed, budget=cap,
        policy=PromotionPolicy())
    if [task["statistical_unit_id"] for task in plan["suite"]["tasks"]] != units:
        raise ValueError("Development task selection changed during planning")
    try:
        trial = evolution.run_pair(plan["id"], adapter)
    except (Exception, CapabilityAbort) as exc:
        raise _failed_qualification(tasks, evolution, plan["id"], exc) from None
    rows = []
    usage = {"model_calls": 0, "completion_tokens": 0,
             "tool_calls": 0, "nodes": 0, "usage_complete": True}
    for pair, unit in zip(trial["pairs"], units):
        parent, child = pair["parent"], pair["candidate"]
        parent_episode = tasks.get_private(parent["episode_id"])
        child_episode = tasks.get_private(child["episode_id"])
        for run in (parent, child):
            if run.get("usage", {}).get("usage_complete") is not True:
                usage["usage_complete"] = False
            _sum_usage(usage, run.get("usage") or {})
        outcome = child_episode.get("outcome") or {}
        rows.append({
            "statistical_unit_id": unit,
            "parent_status": parent_episode["status"],
            "candidate_status": child_episode["status"],
            "parent_score_available": parent["evaluation"].get(
                "score_available") is True,
            "candidate_score_available": child["evaluation"].get(
                "score_available") is True,
            "parent_score": parent["evaluation"].get("score"),
            "candidate_score": child["evaluation"].get("score"),
            "activation_loaded": (child.get("loaded_evidence") or {}).get(
                "loaded") is True,
            "artifact_contract_valid": (
                child_episode["status"] == "completed"
                and outcome.get("delivery_status") == "delivered"
                and outcome.get("schema_validation") == "passed"),
        })
    return {"schema": QUALIFICATION_SCHEMA, "candidate_id": candidate["id"],
            "tasks": rows, "usage": usage,
            "evidence_refs": {"plan_id": plan["id"], "trial_id": trial["id"]}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--feedback-episode", required=True)
    parser.add_argument("--max-attempts", type=int, default=3)
    parser.add_argument("--target-qualified", type=int, default=1)
    parser.add_argument("--first-seed", type=int, default=2)
    parser.add_argument("--max-model-calls", type=int, default=48)
    parser.add_argument("--max-completion-tokens", type=int, default=80000)
    parser.add_argument("--max-nodes", type=int, default=400)
    args = parser.parse_args(argv)

    root = args.root.resolve()
    tasks = TaskService(root)
    evolution = EvolutionService(tasks)
    generation = GenerationService(tasks, evolution)
    parent = multirole_package()
    channel = "orchestration-v3-search"
    try:
        active = evolution.active(channel)
    except KeyError:
        active = evolution.register(channel, parent)
    if active["package_digest"] != parent["digest"]:
        raise ValueError("O-search channel has another active package")
    feedback = generation.capture_feedback(
        channel, [args.feedback_episode], active["revision"])
    excluded = _used_statistical_units(tasks)
    for row in feedback["episode_refs"]:
        registration = tasks.store.benchmark_registration(row["episode_id"])
        unit = ((registration or {}).get("task_ref") or {}).get(
            "statistical_unit_id")
        if not isinstance(unit, str) or not unit:
            raise ValueError("O search requires benchmark-bound feedback units")
        excluded.add(unit)

    mutation_policy = {
        "patch_contract": PACKAGE_PATCH_SCHEMA,
        "mutable_components": list(parent["manifest"]["components"]),
        "allow_add": True, "allow_remove": True, "max_patch_bytes": 300000,
        "capability_ceiling": ["ask"], "tool_ceiling": [], "max_parallel": 2,
    }
    adapter = BigBenchHardTaskBenchmark(data_path=args.data, samples_per_task=1)
    next_seed = args.first_seed

    def generate(attempt, attempt_id, repair, remaining):
        improver = orchestration_search_improver_package(
            repair, attempt_id=attempt_id)
        return generation.generate(
            channel, feedback["id"], improver, mutation_policy,
            active["revision"],
            budget={"max_model_calls": 1,
                    "max_completion_tokens": min(6000, remaining["completion_tokens"]),
                    "max_tool_calls": 0,
                    "max_nodes": min(12, remaining["nodes"])})

    def qualify(candidate, remaining):
        nonlocal next_seed
        for seed in range(next_seed, next_seed + 100):
            preview = adapter.tasks(split="development", seed=seed)
            try:
                _disjoint_units(excluded, preview)
            except ValueError:
                continue
            next_seed = seed + 1
            projected = _qualification(
                tasks, evolution, adapter, candidate, seed=seed,
                excluded=excluded, remaining_budget=remaining)
            units = [row["statistical_unit_id"] for row in projected["tasks"]]
            excluded.update(units)
            return projected
        raise ValueError("No fresh development statistical units were available")

    service = BoundedOrchestrationSearch(tasks, evolution, generation)
    result = service.run(
        channel, feedback["id"], active["revision"],
        {"max_attempts": args.max_attempts,
         "target_qualified": args.target_qualified,
         "minimum_mean_delta": 0.0,
         "max_model_calls": args.max_model_calls,
         "max_completion_tokens": args.max_completion_tokens,
         "max_tool_calls": 0, "max_nodes": args.max_nodes},
        generate=generate, qualify=qualify)
    print(result["id"])
    print(result["status"])
    return 0 if result["status"] == "qualified" else 1


if __name__ == "__main__":
    raise SystemExit(main())
