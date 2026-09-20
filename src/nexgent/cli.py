"""Task-first product commands plus the preserved 0.8 research interface."""
import argparse
import json
import os
from pathlib import Path
import threading

from .evolution.controller import StudyController


TASK_COMMANDS = {"task", "task-resume", "task-show", "task-list", "task-export", "task-benchmark"}


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


def _task_summary(state):
    return {key: state.get(key) for key in
            ("id", "status", "output_refs", "outcome", "usage", "last_error")}


def _run_task_command(args):
    from .tasks.runtime import TaskService

    service = TaskService(args.root)
    if args.command == "task-list":
        return [{"id": state.get("id"), "objective": state.get("task", {}).get("objective"),
                 "status": state.get("status"), "outcome": state.get("outcome")}
                for state in service.list()]
    if args.command == "task-show":
        return service.get(args.episode_id)
    if args.command == "task-export":
        return {"episode_id": args.episode_id,
                "path": service.export(args.episode_id, args.output)}

    stop = threading.Event()
    import signal
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    if args.command == "task-resume":
        return _task_summary(service.run(args.episode_id, stop_event=stop))
    if args.command == "task-benchmark":
        package = _object_argument(str(args.package), label="package") if args.package else None
        options = {"controlled_failure": True} if args.controlled_failure else {}
        return service.benchmark(args.benchmark, split=args.split, seed=args.seed,
                                 budget=_task_budget(args), package=package,
                                 stop_event=stop, **options)

    inputs = _object_argument(args.input, label="input") if args.input else {}
    deliverables = _json_argument(args.deliverables, label="deliverables") if args.deliverables else None
    if deliverables is not None and not isinstance(deliverables, list):
        raise ValueError("deliverables must be a JSON array")
    constraints = _object_argument(args.constraints, label="constraints") if args.constraints else None
    package = _object_argument(str(args.package), label="package") if args.package else None
    state = service.create(args.objective, inputs=inputs, budget=_task_budget(args),
                           capabilities=args.capability, package=package,
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
    benchmark_task.add_argument("--controlled-failure", action="store_true",
                                help="Request the benchmark's deterministic recovery trial when supported")
    _add_task_budget(benchmark_task)

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
        except (ValueError, OSError) as exc:
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
