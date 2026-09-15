"""Research operations, each backed by the same product controller and ledger."""
import argparse
import json
import os
from pathlib import Path
import threading

from .evolution.controller import StudyController


def project_root():
    configured = os.environ.get("NEXGENT_PROJECT_ROOT")
    if configured:
        return Path(configured).resolve()
    for path in (Path.cwd(), *Path(__file__).resolve().parents):
        if (path / "pyproject.toml").exists() and (path / "src" / "nexgent").exists():
            return path
    return Path.cwd()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Nexgent scientific source-RSI system")
    parser.add_argument("--root", type=Path, default=project_root())
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("gui")
    sub.add_parser("list")
    create = sub.add_parser("research")
    create.add_argument("question")
    create.add_argument("--generations", type=int, default=3)
    create.add_argument("--arm", choices=("full", "task_only", "greedy"), default="full")
    create.add_argument("--seed", type=int, default=0)
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
            p.add_argument("--seeds", type=int, nargs="+", default=[401, 502, 603])
            p.add_argument("--k", type=int, default=1)
    args = parser.parse_args(argv)
    if args.command == "gui":
        from .ui.app import main as gui_main
        os.environ["NEXGENT_PROJECT_ROOT"] = str(args.root)
        return gui_main(["--project", str(args.root)])
    controller = StudyController(args.root)
    if args.command == "list":
        result = [{k: s.get(k) for k in ("id", "question", "status", "generation", "arm")} for s in controller.list_studies()]
    elif args.command == "show":
        result = controller.get(args.study_id)
    elif args.command == "export":
        result = {"path": controller.export(args.study_id, args.output)}
    elif args.command == "meta-evaluate":
        report = controller.meta_evaluate(args.study_id, seeds=args.seeds, k=args.k)
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
            state = controller.create(args.question, args.generations, args.arm, args.seed, budget, starting_program=args.starting_program, prior_study=args.prior_study)
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
    return 1 if isinstance(result, dict) and result.get("status") in {"failed", "paused"} else 0


if __name__ == "__main__":
    raise SystemExit(main())
