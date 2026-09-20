"""Task-first product commands plus the preserved 0.8 research interface."""
import argparse
import json
import os
from pathlib import Path
import threading

from .evolution.controller import StudyController


TASK_COMMANDS = {
    "task", "task-resume", "task-show", "task-list", "task-export", "task-benchmark",
    "rsi-status", "rsi-events", "rsi-register", "rsi-feedback", "rsi-generate",
    "rsi-plan", "rsi-run-plan", "rsi-assess", "rsi-plan-monitor", "rsi-promote",
    "rsi-run-monitor", "rsi-monitor", "rsi-rollback",
    "rsi-cycle-start", "rsi-cycle-resume", "rsi-cycle-show", "rsi-cycle-recover",
    "rsi-improver-status", "rsi-improver-events",
    "rsi-study-plan", "rsi-study-run", "rsi-study-assess", "rsi-study-list",
}


def project_root():
    configured = os.environ.get("NEXGENT_PROJECT_ROOT")
    if configured:
        return Path(configured).resolve()
    for path in (Path.cwd(), *Path(__file__).resolve().parents):
        if (path / "pyproject.toml").exists() and (path / "src" / "nexgent").exists():
            return path
    return Path.cwd()


def _json_argument(value, *, label):
    """Read a JSON value from inline text, @file, or an existing file path."""
    source = value
    path = None
    if value.startswith("@"):
        path = Path(value[1:]).expanduser()
        if not path.is_file():
            raise ValueError(f"{label} file does not exist: {path}")
    elif not value.lstrip().startswith(("{", "[")):
        candidate = Path(value).expanduser()
        try:
            if candidate.is_file():
                path = candidate
        except OSError:
            path = None
    if path is not None:
        source = path.read_text(encoding="utf-8")
    try:
        return json.loads(source)
    except json.JSONDecodeError as exc:
        raise ValueError(f"{label} must be valid JSON or a JSON file: {exc.msg}") from exc


def _object_argument(value, *, label):
    result = _json_argument(value, label=label)
    if not isinstance(result, dict):
        raise ValueError(f"{label} must be a JSON object")
    return result


def _task_budget(args):
    return {key: value for key, value in {
        "max_model_calls": getattr(args, "max_calls", None),
        "max_completion_tokens": getattr(args, "max_completion_tokens", None),
        "max_tool_calls": getattr(args, "max_tool_calls", None),
        "max_nodes": getattr(args, "max_nodes", None),
    }.items() if value is not None}


def _add_task_budget(parser):
    parser.add_argument("--max-calls", type=int, help="Maximum admitted model calls")
    parser.add_argument("--max-completion-tokens", type=int, help="Maximum reserved completion tokens")
    parser.add_argument("--max-tool-calls", type=int, help="Maximum admitted tool calls")
    parser.add_argument("--max-nodes", type=int, help="Maximum admitted execution nodes")


def _event_limit(value):
    try:
        limit = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError("event limit must be an integer") from None
    if not 1 <= limit <= 1000:
        raise argparse.ArgumentTypeError("event limit must be between 1 and 1000")
    return limit


def _task_summary(state):
    return {key: state.get(key) for key in
            ("id", "status", "output_refs", "outcome", "usage", "last_error")}


def _task_benchmark(identity):
    from .tasks.tools import task_benchmarks

    adapters = task_benchmarks()
    if identity not in adapters:
        raise ValueError(f"Task benchmark is not installed: {identity}")
    return adapters[identity]


def _promotion_policy(value):
    from .tasks.evolution import PromotionPolicy

    fields = _object_argument(value, label="policy") if value else {}
    try:
        return PromotionPolicy(**fields)
    except TypeError as exc:
        raise ValueError(f"policy has unsupported fields: {exc}") from None


def _public_active_result(result):
    """Keep package source out of command output while retaining deployment identity."""
    from .tasks.evolution_view import public_channel_state

    return public_channel_state(result)


def _record_result(record, fields):
    """Return only control-plane identities and aggregate evidence, never frozen task payloads."""
    return {key: record.get(key) for key in fields if key in record}


def _stop_event():
    stop = threading.Event()
    import signal
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    return stop


def _run_task_command(args):
    from .tasks.runtime import TaskService

    service = TaskService(args.root)
    if args.command.startswith("rsi-"):
        if args.command == "rsi-study-list":
            from .tasks.studies import public_study_records
            return public_study_records(service.store, args.limit)
        if args.command in {"rsi-improver-status", "rsi-improver-events"}:
            from .tasks.improvers import (
                ImproverService, public_improver_event, public_improver_state,
            )

            improvers = ImproverService(service)
            if args.command == "rsi-improver-status":
                return public_improver_state(improvers.active(args.channel))
            events = improvers.events(args.channel)[-args.limit:]
            return {"channel": args.channel,
                    "events": [public_improver_event(event) for event in events]}
        if args.command in {"rsi-study-plan", "rsi-study-run", "rsi-study-assess"}:
            from .tasks.studies import RSIStudyService, StudyPolicy

            studies = RSIStudyService(service, _task_benchmark(args.benchmark))
            if args.command == "rsi-study-plan":
                policy_fields = (_object_argument(args.policy, label="study policy")
                                 if args.policy else {})
                try:
                    policy = StudyPolicy(**policy_fields)
                except TypeError as exc:
                    raise ValueError(f"study policy has unsupported fields: {exc}") from None
                result = studies.create_plan(
                    arms={"baseline": _object_argument(
                              args.baseline_package, label="baseline package"),
                          "candidate": _object_argument(
                              args.candidate_package, label="candidate package")},
                    baseline_arm="baseline", candidate_arm="candidate",
                    split="final_holdout", seeds=args.seeds,
                    episode_budget=_task_budget(args), provider=args.provider,
                    model=args.model, policy=policy,
                    require_model_calls=not args.no_require_model_calls,
                    observed_model=args.observed_model,
                    provider_revision=args.provider_revision)
                return _record_result(result, (
                    "schema", "id", "benchmark_id", "split", "seeds", "arms",
                    "baseline_arm", "candidate_arm", "episode_budget", "provider",
                    "model", "resolved_model", "model_profile_digest",
                    "model_version_binding", "expected_observed_model",
                    "expected_provider_revision", "require_model_calls", "policy",
                    "adapter_fingerprint", "execution_environment_digest", "statistics",
                    "protocol_digest", "created_at", "record_digest"))
            if args.command == "rsi-study-run":
                result = studies.run(args.plan_id, stop_event=_stop_event())
                return _record_result(result, (
                    "schema", "id", "plan_id", "plan_digest", "protocol_digest",
                    "status", "measurement_complete", "completed_cells",
                    "created_at", "record_digest"))
            result = studies.assess(args.run_id)
            return _record_result(result, (
                "schema", "id", "plan_id", "run_id", "protocol_digest",
                "complete_pair_count", "planned_pair_count", "independent_cluster_count",
                "planned_cluster_count", "missing", "metrics",
                "gates", "engineering_acceptance", "statistical_support",
                "version_scope", "claim_scope", "created_at", "record_digest"))
        from .tasks.evolution import EvolutionService
        from .tasks.evolution_view import public_evolution_event

        evolution = EvolutionService(service)
        if args.command.startswith("rsi-cycle-"):
            from .tasks.cycles import RSICycleService
            from .tasks.generation import GenerationService

            cycles = RSICycleService(
                service, evolution, GenerationService(service, evolution))
            if args.command == "rsi-cycle-show":
                return cycles.public(args.cycle_id)
            if args.command == "rsi-cycle-recover":
                cycles.recover(
                    args.cycle_id,
                    confirm_no_external_commit=args.confirm_no_external_commit)
                return cycles.public(args.cycle_id)
            if args.command == "rsi-cycle-resume":
                cycle = cycles.get(args.cycle_id)
                selection = _task_benchmark(cycle["selection"]["benchmark_id"])
                guard = _task_benchmark(cycle["guard"]["benchmark_id"])
                cycles.resume(
                    args.cycle_id, selection, guard, stop_event=_stop_event())
                return cycles.public(args.cycle_id)
            benchmark = _task_benchmark(args.benchmark)
            if args.improver_channel:
                improver = None
            elif args.improver_package in {None, "builtin:reference-os-v1"}:
                from .tasks.improver_seed import default_improver_package
                improver = default_improver_package()
            else:
                improver = _object_argument(
                    args.improver_package, label="improver package")
            cycle = cycles.create(
                channel=args.channel, feedback_episode_ids=args.episode_ids,
                improver_package=improver,
                improver_channel=args.improver_channel,
                expected_improver_revision=args.expected_improver_revision,
                mutation_policy=_object_argument(
                    args.mutation_policy, label="mutation policy"),
                expected_revision=args.expected_revision,
                selection_adapter=benchmark, guard_adapter=benchmark,
                selection_seed=args.selection_seed, guard_seed=args.guard_seed,
                generation_budget=(_object_argument(
                    args.generation_budget, label="generation budget")
                    if args.generation_budget else None),
                selection_budget=(_object_argument(
                    args.selection_budget, label="selection budget")
                    if args.selection_budget else None),
                guard_budget=(_object_argument(
                    args.guard_budget, label="guard budget")
                    if args.guard_budget else None),
                policy=_promotion_policy(args.policy),
                rollback_on_regression=not args.no_rollback)
            if not args.register_only:
                cycles.run(
                    cycle["id"], benchmark, benchmark, stop_event=_stop_event())
            return cycles.public(cycle["id"])
        if args.command == "rsi-status":
            return _public_active_result(evolution.active(args.channel))
        if args.command == "rsi-events":
            events = evolution.events(args.channel)[-args.limit:]
            return {"channel": args.channel,
                    "events": [public_evolution_event(event) for event in events]}
        if args.command == "rsi-register":
            package = _object_argument(args.package, label="package")
            return _public_active_result(evolution.register(args.channel, package))
        if args.command in {"rsi-feedback", "rsi-generate"}:
            from .tasks.generation import GenerationService

            generation = GenerationService(service, evolution)
            if args.command == "rsi-feedback":
                result = generation.capture_feedback(
                    args.channel, args.episode_ids, args.expected_revision)
                return _record_result(result, (
                    "schema", "id", "channel", "channel_revision", "parent_package_id",
                    "parent_package_digest", "digest", "created_at", "record_digest"))
            if args.improver_package and args.improver_channel:
                raise ValueError("Specify either an improver package or an improver channel")
            if args.improver_channel:
                improver = None
            elif args.improver_package in {None, "builtin:reference-os-v1"}:
                from .tasks.improver_seed import default_improver_package
                improver = default_improver_package()
            else:
                improver = _object_argument(args.improver_package, label="improver package")
            mutation = _object_argument(args.mutation_policy, label="mutation policy")
            result = generation.generate(
                args.channel, args.feedback_id, improver, mutation, args.expected_revision,
                improver_channel=args.improver_channel,
                expected_improver_revision=args.expected_improver_revision,
                budget=_task_budget(args), stop_event=_stop_event())
            return _record_result(result, (
                "schema", "id", "channel", "channel_revision", "status", "reason_type",
                "reason_digest",
                "feedback_bundle_id", "feedback_digest", "improver_package_id",
                "improver_package_digest", "improver_closure_digest", "episode_id",
                "episode_status", "usage", "execution", "patch_digest", "candidate_id",
                "candidate_package_id", "candidate_package_digest", "created_at",
                "completed_at", "record_digest"))
        if args.command == "rsi-plan":
            result = evolution.plan_pair(
                args.candidate_id, _task_benchmark(args.benchmark), split=args.split,
                split_role="selection", seed=args.seed, budget=_task_budget(args),
                policy=_promotion_policy(args.policy))
            return _record_result(result, (
                "id", "candidate_id", "channel", "parent_package_id",
                 "parent_package_digest", "package_id", "package_digest", "suite_digest",
                 "split_role", "arm_schedule", "environment_digest", "budget", "policy",
                 "policy_digest", "created_at",
                "record_digest"))
        if args.command == "rsi-run-plan":
            result = evolution.run_pair(
                args.plan_id, _task_benchmark(args.benchmark), stop_event=_stop_event())
            return _record_result(result, (
                "id", "plan_id", "candidate_id", "channel", "parent_package_id",
                "parent_package_digest", "package_id", "package_digest", "suite_digest",
                "split_role", "policy", "policy_digest", "arm_order", "created_at",
                "record_digest"))
        if args.command == "rsi-assess":
            return evolution.assess(args.trial_id)
        if args.command == "rsi-plan-monitor":
            result = evolution.plan_monitor(
                args.candidate_id, _task_benchmark(args.benchmark), split=args.split,
                seed=args.seed, budget=_task_budget(args))
            return _record_result(result, (
                 "id", "candidate_id", "channel", "package_id", "package_digest",
                 "suite_digest", "task_schedule", "environment_digest", "budget",
                 "created_at", "record_digest"))
        if args.command == "rsi-promote":
            return _public_active_result(evolution.promote(
                args.candidate_id, args.decision_id, monitor_plan_id=args.monitor_plan_id))
        if args.command == "rsi-run-monitor":
            result = evolution.run_monitor(
                args.channel, _task_benchmark(args.benchmark), stop_event=_stop_event())
            return _record_result(result, (
                "id", "monitor_plan_id", "suite_digest", "episode_ids", "record_digest"))
        if args.command == "rsi-monitor":
            result = evolution.monitor(
                args.channel, args.episode_ids, rollback_on_regression=not args.no_rollback)
            result["active"] = _public_active_result(result["active"])
            return result
        if args.command == "rsi-rollback":
            return _public_active_result(evolution.rollback(args.channel, reason=args.reason))
    if args.command == "task-list":
        return [{"id": state.get("id"), "objective": state.get("task", {}).get("objective"),
                 "status": state.get("status"), "outcome": state.get("outcome")}
                for state in service.list()]
    if args.command == "task-show":
        return service.get(args.episode_id)
    if args.command == "task-export":
        return {"episode_id": args.episode_id,
                "path": service.export(args.episode_id, args.output)}

    stop = _stop_event()
    if args.command == "task-resume":
        return _task_summary(service.run(args.episode_id, stop_event=stop))
    if args.command == "task-benchmark":
        if args.package and args.package_channel:
            raise ValueError("Specify either --package or --package-channel")
        package = _object_argument(str(args.package), label="package") if args.package else None
        options = {"controlled_failure": True} if args.controlled_failure else {}
        return service.benchmark(args.benchmark, split=args.split, seed=args.seed,
                                 budget=_task_budget(args), package=package,
                                 package_channel=args.package_channel,
                                 stop_event=stop, **options)

    inputs = _object_argument(args.input, label="input") if args.input else {}
    deliverables = _json_argument(args.deliverables, label="deliverables") if args.deliverables else None
    if deliverables is not None and not isinstance(deliverables, list):
        raise ValueError("deliverables must be a JSON array")
    constraints = _object_argument(args.constraints, label="constraints") if args.constraints else None
    if args.package and args.package_channel:
        raise ValueError("Specify either --package or --package-channel")
    package = _object_argument(str(args.package), label="package") if args.package else None
    state = service.create(args.objective, inputs=inputs, budget=_task_budget(args),
                           capabilities=args.capability, package=package,
                           package_channel=args.package_channel,
                           deliverables=deliverables, constraints=constraints)
    if args.register_only:
        return _task_summary(state)
    return _task_summary(service.run(state["id"], stop_event=stop))


def _task_failed(command, result):
    if command in {"task", "task-resume"}:
        return result.get("status") in {"failed", "paused", "waiting_input", "cancelled"}
    if command == "task-benchmark":
        reports = result.get("reports", [])
        return any(report.get("evaluation", {}).get("accepted") is not True for report in reports)
    if command in {"rsi-cycle-start", "rsi-cycle-resume", "rsi-cycle-recover"}:
        return (result.get("status") in
                {"generation_missing", "rejected", "guard_failed", "rolled_back"}
                or result.get("runner", {}).get("status") in
                {"paused", "recovery_required"})
    return False


def main(argv=None):
    parser = argparse.ArgumentParser(description="NExgent task agent runtime and legacy RSI research tools")
    parser.add_argument("--root", type=Path, default=project_root())
    sub = parser.add_subparsers(dest="command", required=True)
    gui = sub.add_parser("gui", help="Open the task workspace")
    gui.add_argument("--legacy-research", action="store_true", help="Open the preserved 0.8 research window")

    task = sub.add_parser("task", help="Register and execute an ordinary task")
    task.add_argument("objective")
    task.add_argument("--input", help="Inline JSON object, JSON file path, or @file")
    task.add_argument("--deliverables", help="JSON array (or file) of named output schemas")
    task.add_argument("--constraints", help="JSON object (or file) with quality/effect/wall-time constraints")
    task.add_argument("--capability", action="append", default=[], help="Grant an installed tool capability; repeat as needed")
    task.add_argument("--package", type=Path, help="AgentPackage JSON file; defaults to the installed seed package")
    task.add_argument("--package-channel", help="Resolve the active AgentPackage from this RSI channel")
    task.add_argument("--register-only", action="store_true", help="Register without executing")
    _add_task_budget(task)
    resume_task = sub.add_parser("task-resume", help="Resume a persisted task episode")
    resume_task.add_argument("episode_id")
    show_task = sub.add_parser("task-show", help="Show a persisted task episode")
    show_task.add_argument("episode_id")
    sub.add_parser("task-list", help="List top-level task episodes")
    export_task = sub.add_parser("task-export", help="Export a task episode and its evidence")
    export_task.add_argument("episode_id")
    export_task.add_argument("--output", type=Path)
    benchmark_task = sub.add_parser("task-benchmark", help="Run an installed benchmark through the task runtime")
    benchmark_task.add_argument("benchmark")
    benchmark_task.add_argument("--split", default="development")
    benchmark_task.add_argument("--seed", type=int, default=0)
    benchmark_task.add_argument("--package", type=Path, help="AgentPackage JSON file; defaults to the installed seed package")
    benchmark_task.add_argument("--package-channel", help="Resolve the active AgentPackage from this RSI channel")
    benchmark_task.add_argument("--controlled-failure", action="store_true",
                                help="Request the benchmark's deterministic recovery trial when supported")
    _add_task_budget(benchmark_task)

    rsi_status = sub.add_parser("rsi-status", help="Show the active package revision for an RSI channel")
    rsi_status.add_argument("channel")
    rsi_events = sub.add_parser("rsi-events", help="Show the public audit events for an RSI channel")
    rsi_events.add_argument("channel")
    rsi_events.add_argument("--limit", type=_event_limit, default=50)

    rsi_improver_status = sub.add_parser(
        "rsi-improver-status", help="Show the active recursive improver revision")
    rsi_improver_status.add_argument("channel")
    rsi_improver_events = sub.add_parser(
        "rsi-improver-events", help="Show the public recursive-improver audit chain")
    rsi_improver_events.add_argument("channel")
    rsi_improver_events.add_argument("--limit", type=_event_limit, default=50)

    rsi_register = sub.add_parser("rsi-register", help="Register a generation-zero package channel")
    rsi_register.add_argument("channel")
    rsi_register.add_argument("--package", required=True,
                              help="AgentPackage JSON object, file path, or @file")

    rsi_feedback = sub.add_parser("rsi-feedback", help="Capture development Episode feedback")
    rsi_feedback.add_argument("channel")
    rsi_feedback.add_argument("episode_ids", nargs="+")
    rsi_feedback.add_argument("--expected-revision", type=int, required=True)

    rsi_generate = sub.add_parser("rsi-generate", help="Generate a feedback-bound candidate")
    rsi_generate.add_argument("channel")
    rsi_generate.add_argument("feedback_id")
    improver_source = rsi_generate.add_mutually_exclusive_group()
    improver_source.add_argument(
        "--improver-package",
        help="Improver AgentPackage JSON, file, or builtin:reference-os-v1; defaults to builtin")
    improver_source.add_argument(
        "--improver-channel", help="Resolve the improver from a deployed improver channel")
    rsi_generate.add_argument(
        "--expected-improver-revision", type=int,
        help="Required compare-and-swap revision when using --improver-channel")
    rsi_generate.add_argument("--mutation-policy", required=True,
                              help="Mutation policy JSON object, file path, or @file")
    rsi_generate.add_argument("--expected-revision", type=int, required=True)
    _add_task_budget(rsi_generate)

    rsi_plan = sub.add_parser("rsi-plan", help="Freeze a paired selection trial plan")
    rsi_plan.add_argument("candidate_id")
    rsi_plan.add_argument("benchmark")
    rsi_plan.add_argument("--split", default="selection")
    rsi_plan.add_argument("--seed", type=int, default=0)
    rsi_plan.add_argument("--policy", help="Promotion policy JSON object, file path, or @file")
    _add_task_budget(rsi_plan)

    rsi_run_plan = sub.add_parser("rsi-run-plan", help="Execute a frozen paired trial plan")
    rsi_run_plan.add_argument("plan_id")
    rsi_run_plan.add_argument("benchmark")

    rsi_assess = sub.add_parser("rsi-assess", help="Assess a completed paired trial")
    rsi_assess.add_argument("trial_id")

    rsi_plan_monitor = sub.add_parser(
        "rsi-plan-monitor", help="Freeze an independent deployment monitoring plan")
    rsi_plan_monitor.add_argument("candidate_id")
    rsi_plan_monitor.add_argument("benchmark")
    rsi_plan_monitor.add_argument("--split", default="guard")
    rsi_plan_monitor.add_argument("--seed", type=int, default=0)
    _add_task_budget(rsi_plan_monitor)

    rsi_promote = sub.add_parser("rsi-promote", help="Promote an eligible candidate")
    rsi_promote.add_argument("candidate_id")
    rsi_promote.add_argument("decision_id")
    rsi_promote.add_argument("monitor_plan_id")

    rsi_run_monitor = sub.add_parser("rsi-run-monitor", help="Run the active guard plan")
    rsi_run_monitor.add_argument("channel")
    rsi_run_monitor.add_argument("benchmark")

    rsi_monitor = sub.add_parser("rsi-monitor", help="Assess evaluator-bound monitoring Episodes")
    rsi_monitor.add_argument("channel")
    rsi_monitor.add_argument("episode_ids", nargs="+")
    rsi_monitor.add_argument("--no-rollback", action="store_true",
                             help="Record degradation without automatic rollback")

    rsi_rollback = sub.add_parser("rsi-rollback", help="Roll back one promoted package edge")
    rsi_rollback.add_argument("channel")
    rsi_rollback.add_argument("reason")

    rsi_cycle_start = sub.add_parser(
        "rsi-cycle-start", help="Register and normally execute one complete RSI cycle")
    rsi_cycle_start.add_argument("channel")
    rsi_cycle_start.add_argument("benchmark")
    rsi_cycle_start.add_argument("episode_ids", nargs="+")
    rsi_cycle_start.add_argument("--expected-revision", type=int, required=True)
    rsi_cycle_start.add_argument("--mutation-policy", required=True,
                                 help="Mutation policy JSON object, file path, or @file")
    cycle_improver_source = rsi_cycle_start.add_mutually_exclusive_group()
    cycle_improver_source.add_argument(
        "--improver-package",
        help="Improver AgentPackage JSON, file, or builtin:reference-os-v1; defaults to builtin")
    cycle_improver_source.add_argument(
        "--improver-channel", help="Resolve the improver from a deployed improver channel")
    rsi_cycle_start.add_argument(
        "--expected-improver-revision", type=int,
        help="Required compare-and-swap revision when using --improver-channel")
    rsi_cycle_start.add_argument("--selection-seed", type=int, default=0)
    rsi_cycle_start.add_argument("--guard-seed", type=int, default=0)
    rsi_cycle_start.add_argument("--generation-budget",
                                 help="Generation budget JSON object, file path, or @file")
    rsi_cycle_start.add_argument("--selection-budget",
                                 help="Selection budget JSON object, file path, or @file")
    rsi_cycle_start.add_argument("--guard-budget",
                                 help="Guard budget JSON object, file path, or @file")
    rsi_cycle_start.add_argument("--policy",
                                 help="Promotion policy JSON object, file path, or @file")
    rsi_cycle_start.add_argument("--no-rollback", action="store_true",
                                 help="Record guard degradation without automatic rollback")
    rsi_cycle_start.add_argument("--register-only", action="store_true",
                                 help="Persist the frozen cycle without running it")

    rsi_cycle_resume = sub.add_parser(
        "rsi-cycle-resume", help="Resume a persisted RSI cycle")
    rsi_cycle_resume.add_argument("cycle_id")
    rsi_cycle_show = sub.add_parser(
        "rsi-cycle-show", help="Show a public RSI cycle projection")
    rsi_cycle_show.add_argument("cycle_id")
    rsi_cycle_recover = sub.add_parser(
        "rsi-cycle-recover", help="Recover an interrupted RSI cycle claim")
    rsi_cycle_recover.add_argument("cycle_id")
    rsi_cycle_recover.add_argument(
        "--confirm-no-external-commit", action="store_true",
        help="Allow retry only after externally confirming the pending action did not commit")

    rsi_study_plan = sub.add_parser(
        "rsi-study-plan", help="Pre-register a paired final-holdout RSI study")
    rsi_study_plan.add_argument("benchmark")
    rsi_study_plan.add_argument("--baseline-package", required=True,
                                help="Baseline AgentPackage JSON object, file, or @file")
    rsi_study_plan.add_argument("--candidate-package", required=True,
                                help="Candidate AgentPackage JSON object, file, or @file")
    rsi_study_plan.add_argument("--seeds", type=int, nargs="+", required=True)
    rsi_study_plan.add_argument("--provider", required=True)
    rsi_study_plan.add_argument("--model", required=True)
    rsi_study_plan.add_argument(
        "--observed-model", help="Exact model identity expected in provider responses")
    rsi_study_plan.add_argument(
        "--provider-revision", help="Exact provider-reported revision/system fingerprint")
    rsi_study_plan.add_argument("--policy", help="Study policy JSON object, file, or @file")
    rsi_study_plan.add_argument(
        "--no-require-model-calls", action="store_true",
        help="Allow deterministic packages with no model calls")
    _add_task_budget(rsi_study_plan)

    rsi_study_run = sub.add_parser(
        "rsi-study-run", help="Execute or resume a frozen final-holdout study")
    rsi_study_run.add_argument("plan_id")
    rsi_study_run.add_argument("benchmark")

    rsi_study_assess = sub.add_parser(
        "rsi-study-assess", help="Assess a completed paired RSI study")
    rsi_study_assess.add_argument("run_id")
    rsi_study_assess.add_argument("benchmark")
    rsi_study_list = sub.add_parser(
        "rsi-study-list", help="Show public frozen-study plans and reports")
    rsi_study_list.add_argument("--limit", type=_event_limit, default=50)

    sub.add_parser("list")
    sub.add_parser("benchmarks")
    evaluate = sub.add_parser("evaluate", help="Run a fixed program on an installed benchmark without evolution")
    evaluate.add_argument("--benchmark", required=True)
    evaluate.add_argument("--program", help="Stored source id; omitted uses the benchmark's baseline")
    evaluate.add_argument("--split", default="final_transfer")
    evaluate.add_argument("--seeds", type=int, nargs="+", default=[101])
    evaluate.add_argument("--max-calls", type=int, default=18)
    evaluate.add_argument("--max-completion-tokens", type=int, default=90000)
    create = sub.add_parser("research")
    create.add_argument("question")
    create.add_argument("--generations", type=int, default=3)
    create.add_argument("--arm", choices=("full", "task_only", "greedy"), default="full")
    create.add_argument("--seed", type=int, default=0)
    create.add_argument("--benchmark", help="Installed benchmark plugin identifier")
    create.add_argument("--max-calls", type=int)
    create.add_argument("--max-completion-tokens", type=int)
    create.add_argument("--register-only", action="store_true")
    create.add_argument("--prior-study", help="Reuse only public development/selection failure evidence")
    create.add_argument("--starting-program", help="Continue from an immutable source program in this workspace")
    for name in ("resume", "show", "export", "meta-evaluate"):
        p = sub.add_parser(name)
        p.add_argument("study_id")
        if name == "export":
            p.add_argument("--output", type=Path)
        if name == "meta-evaluate":
            p.add_argument("--benchmark", help="Optional target benchmark for actual improver transfer")
            p.add_argument("--seeds", type=int, nargs="+", default=[401, 502, 603])
            p.add_argument("--k", type=int, default=1)
            p.add_argument("--arm-max-calls", type=int, help="Total calls per seed/arm, including task evaluations")
            p.add_argument("--arm-max-completion-tokens", type=int)
            p.add_argument("--generation-max-calls", type=int)
            p.add_argument("--generation-max-completion-tokens", type=int)
            p.add_argument("--generation-max-experiments", type=int)
    args = parser.parse_args(argv)
    if args.command == "rsi-generate":
        if bool(args.improver_channel) != (args.expected_improver_revision is not None):
            parser.error("--improver-channel and --expected-improver-revision must be used together")
    if args.command == "rsi-cycle-start":
        if bool(args.improver_channel) != (args.expected_improver_revision is not None):
            parser.error("--improver-channel and --expected-improver-revision must be used together")
    if args.command == "gui":
        from .ui.app import main as gui_main
        os.environ["NEXGENT_PROJECT_ROOT"] = str(args.root)
        gui_args = ["--project", str(args.root)]
        if args.legacy_research:
            gui_args.append("--legacy-research")
        return gui_main(gui_args)
    if args.command in TASK_COMMANDS:
        try:
            result = _run_task_command(args)
        except (KeyError, ValueError, OSError) as exc:
            parser.error(str(exc))
        print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
        return 1 if _task_failed(args.command, result) else 0
    controller = StudyController(args.root)
    if args.command == "benchmarks":
        result = controller.list_benchmarks()
    elif args.command == "evaluate":
        stop = threading.Event()
        import signal
        signal.signal(signal.SIGINT, lambda *_: stop.set())
        state = controller.evaluate_benchmark(benchmark_id=args.benchmark, program_id=args.program,
            seeds=args.seeds, split=args.split, stop_event=stop,
            budget={"max_model_calls": args.max_calls, "max_completion_tokens": args.max_completion_tokens})
        result = {k: state.get(k) for k in ("id", "status", "benchmark", "usage", "conclusion", "last_error")}
        result["export"] = controller.export(state["id"])
    elif args.command == "list":
        result = [{k: s.get(k) for k in ("id", "question", "status", "generation", "arm")} for s in controller.list_studies()]
    elif args.command == "show":
        result = controller.get(args.study_id)
    elif args.command == "export":
        result = {"path": controller.export(args.study_id, args.output)}
    elif args.command == "meta-evaluate":
        generation_budget = {key: value for key, value in {
            "max_model_calls": args.generation_max_calls,
            "max_completion_tokens": args.generation_max_completion_tokens,
            "max_development_experiments": args.generation_max_experiments}.items() if value is not None}
        arm_budget = {key: value for key, value in {
            "max_model_calls": args.arm_max_calls,
            "max_completion_tokens": args.arm_max_completion_tokens}.items() if value is not None}
        report = controller.meta_evaluate(args.study_id, seeds=args.seeds, k=args.k, benchmark_id=args.benchmark,
            generation_budget=generation_budget, arm_budget=arm_budget)
        path = args.root / ".nexgent" / "exports" / (report["meta_study_id"] + ".json")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        result = {"meta_study_id": report["meta_study_id"], "aggregate": report["aggregate"], "evidence": report["evidence"], "usage": report.get("ledger_usage"), "export": str(path.resolve())}
    else:
        if args.command == "research":
            budget = {}
            if args.max_calls is not None:
                budget["max_model_calls"] = args.max_calls
            if args.max_completion_tokens is not None:
                budget["max_completion_tokens"] = args.max_completion_tokens
            state = controller.create(args.question, args.generations, args.arm, args.seed, budget, starting_program=args.starting_program, prior_study=args.prior_study, benchmark_id=args.benchmark)
        else:
            state = controller.get(args.study_id)
        print(json.dumps({"study_id": state["id"], "status": state["status"]}), flush=True)
        if getattr(args, "register_only", False):
            result = state
        else:
            stop = threading.Event()
            import signal
            signal.signal(signal.SIGINT, lambda *_: stop.set())
            last = [None]
            def progress(snapshot):
                stage = (snapshot["stage"], snapshot["usage"]["model_calls"])
                if stage != last[0]:
                    print(json.dumps({"study_id": snapshot["id"], "stage": snapshot["stage"], "generation": snapshot["generation"], "usage": snapshot["usage"]}, ensure_ascii=False), flush=True)
                    last[0] = stage
            result = controller.run(state["id"], progress, stop)
            result = {k: result.get(k) for k in ("id", "status", "generation", "usage", "conclusion", "last_error")}
            conclusion = result.get("conclusion", {})
            result["conclusion"] = {k: v for k, v in conclusion.items() if k not in {"final_transfer", "meta_evaluation"}}
            result["export"] = controller.export(state["id"])
    print(json.dumps(result, ensure_ascii=False, indent=2), flush=True)
    if isinstance(result, dict):
        if result.get("status") in {"failed", "paused"}:
            return 1
        conclusion = result.get("conclusion") or {}
        if conclusion.get("kind") == "fixed_program_benchmark" and conclusion.get("missing_seeds"):
            return 1
        if args.command == "meta-evaluate" and result.get("aggregate", {}).get("incomplete_seeds"):
            return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
