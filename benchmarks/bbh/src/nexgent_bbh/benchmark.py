"""Independent exact-answer scoring for two pinned BIG-Bench Hard tasks."""

from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path

from nexgent.benchmarks import BenchmarkSpec

from .baseline import TASK_SOURCE
from .data import COMMIT, TASKS, DatasetError, load

VERSION = "bbh-two-task-v1"
PARTITIONS = {"development": (0, 40), "selection": (40, 60), "transfer": (60, 80),
              "meta_transfer": (80, 90), "confirmation": (90, 100)}
# Framework evaluation roles map to existing native pools; aliases never add data.
SPLIT_ALIASES = {"final_transfer": "transfer"}
CONTRACT = """solve(problem, tools) returns {'answer': a string}.
problem.input is the official question, problem.category is boolean_expressions or word_sorting.
Boolean operators use not > and > or precedence and parentheses. Return True or False.
Sort every supplied word in ascending alphabetical order, separated by single spaces.
Answers are compared case-sensitively after whitespace normalization; explanatory text is not an answer.
You may implement algorithms in Python or use the host's budgeted tools.ask/parallel capabilities.
Targets and other split examples are never provided to the source program.
"""


def _digest(value):
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(encoded.encode()).hexdigest()


def _fixtures():
    """Authored interface tests, never an implicit substitute for official data."""
    expressions, words = [], []
    for index in range(40):
        expression = "not " * index + "( True and False ) is"
        expressions.append({"input": expression, "target": "True" if index % 2 else "False"})
        tokens = ["zebra", "amber", "word" + str(index), "middle"]
        words.append({"input": "Sort the following words alphabetically: List: " + " ".join(tokens),
                      "target": " ".join(sorted(tokens))})
    return {"boolean_expressions": expressions, "word_sorting": words}


class BigBenchHardBenchmark:
    @classmethod
    def from_project(cls, project_root):
        path = os.environ.get("NEXGENT_BBH_DATA") or Path(project_root) / ".nexgent" / "benchmarks" / "bbh"
        return cls(data_path=path)

    def __init__(self, *, data_path=None, samples_per_task=6, fixture=False):
        if type(samples_per_task) is not int or not 1 <= samples_per_task <= 100:
            raise ValueError("samples_per_task must be an integer in 1..100")
        if type(fixture) is not bool:
            raise ValueError("fixture must be an explicit boolean test option")
        self.samples_per_task = samples_per_task
        self.fixture = fixture
        if fixture:
            records = _fixtures()
            manifest = {"mode": "synthetic_test_fixture", "data_digest": _digest(records),
                        "scope": "Authored adapter tests; not official BIG-Bench Hard results"}
        else:
            path = data_path or os.environ.get("NEXGENT_BBH_DATA")
            if not path:
                raise DatasetError("Set NEXGENT_BBH_DATA to a verified dataset directory; first run nexgent-bbh-download --destination PATH")
            records, manifest = load(path)
            manifest = {**manifest, "mode": "official_pinned_subset"}
        title = "BBH · Boolean expressions + Word sorting" + (" [TEST FIXTURE]" if fixture else "")
        self.spec = BenchmarkSpec(id="bbh", title=title,
            description="Two official BIG-Bench Hard tasks; exact-answer algorithm/prompt evaluation, not the full 23-task suite." if not fixture else "Synthetic interface fixtures only; not official BBH evidence.",
            task_contract=CONTRACT, toolbox_factory=None, work_unit="source_instruction_events")
        self._pools = {}; counts = {}
        for task in TASKS:
            unique = {}
            for index, record in enumerate(records[task]):
                key = _digest([task, " ".join(record["input"].split())])
                if key in unique:
                    if unique[key]["target"] != record["target"]:
                        raise DatasetError("Conflicting targets for a duplicate public input")
                    continue
                unique[key] = {"task_id": "bbh-" + key[:24], "category": task,
                               "input": record["input"], "target": record["target"], "source_index": index}
            ordered = [unique[key] for key in sorted(unique)]
            counts[task] = {"original": len(records[task]), "unique_public_inputs": len(ordered)}
            for split, (start, end) in PARTITIONS.items():
                pool = ordered[len(ordered) * start // 100:len(ordered) * end // 100]
                if not pool: raise DatasetError("Insufficient unique examples for disjoint benchmark partitions")
                self._pools[(task, split)] = pool
        self._manifest = {**manifest, "counts": counts, "partitions_percent": PARTITIONS,
                          "split_aliases": SPLIT_ALIASES,
                          "samples_per_task": samples_per_task,
                          "partition_rule": "Deduplicate normalized public input; sort its SHA256; disjoint fixed percentile pools; seed only orders samples inside a pool."}
        self.evaluator_digest = _digest(self.snapshot())

    def initial_files(self):
        return {"task.py": TASK_SOURCE}

    def snapshot(self):
        return {"files": {p.name: p.read_text(encoding="utf-8") for p in sorted(Path(__file__).parent.glob("*.py"))},
                "versions": {"adapter": VERSION}, "data": deepcopy(self._manifest)}

    def research_context(self):
        return {"benchmark": self.spec.as_dict(), "data_provenance": deepcopy(self._manifest),
                "instructions": "Investigate correctness, algorithm cost, robust parsing and improver behavior. Development examples may guide changes; held-out targets must remain private. The fixed algorithmic control is capable of full accuracy on these two categories, so report a saturated baseline honestly.",
                "papers": [{"title": "Challenging BIG-Bench Tasks and Whether Chain-of-Thought Can Solve Them",
                            "url": "https://aclanthology.org/2023.findings-acl.824/", "venue": "Findings of ACL 2023",
                            "evidence_level": "verified_metadata", "scope": "The original suite has 23 tasks; this adapter covers only two."}]}

    def _cases(self, split, seed):
        split = SPLIT_ALIASES.get(split, split)
        if split not in PARTITIONS or type(seed) is not int:
            raise ValueError("Use a registered split and an integer seed")
        selected = []
        for task in TASKS:
            pool = self._pools[(task, split)]
            selected.extend(sorted(pool, key=lambda row: _digest([seed, row["task_id"]]))[:self.samples_per_task])
        return deepcopy(selected)

    def problems(self, split, seed):
        return [self._public(case) for case in self._cases(split, seed)]

    @staticmethod
    def _public(case):
        return {key: deepcopy(case[key]) for key in ("task_id", "category", "input")} | {"requirements": CONTRACT}

    @staticmethod
    def _resource(error_type, message=""):
        if error_type in {"InterruptedError", "CancelledError"}: return "interrupted"
        if error_type == "TimeoutError": return "timeout"
        if error_type in {"BudgetExhausted", "WorkBudgetExceeded", "MemoryError"}: return "budget_exhausted"
        if "Source instruction budget exhausted" in message or "BudgetExhausted" in message:
            return "budget_exhausted"
        return None

    def evaluate(self, bundle, split, seed, runner, *, stop_event=None, max_work_units=20_000_000):
        if type(max_work_units) is not int or max_work_units <= 0:
            raise ValueError("max_work_units must be a positive integer")
        cases = self._cases(split, seed)
        native_split = SPLIT_ALIASES.get(split, split)
        suite = _digest({"version": VERSION, "data": self._manifest, "split": native_split, "seed": seed, "cases": cases})
        execution, output, source_error, resource = {}, [], None, None
        if stop_event is not None and stop_event.is_set():
            resource, source_error = "interrupted", "Stopped before source execution"
        else:
            try:
                result = runner.run(bundle, "solve_batch", {"problems": [self._public(case) for case in cases]},
                                    stop_event=stop_event, max_work_units=max_work_units)
                output, execution = result["value"], result["execution"]
                if not isinstance(output, list): raise ValueError("solve_batch must return a list")
            except Exception as exc:
                execution = deepcopy(getattr(exc, "execution", {}))
                source_error = f"{type(exc).__name__}: {str(exc)[:400]}"
                resource = self._resource(type(exc).__name__, str(exc))
        instructions = execution.get("instructions")
        cost_known = type(instructions) is int and instructions >= 0
        if cost_known and instructions > max_work_units:
            resource, source_error = "budget_exhausted", "Source instruction events exceeded the registered domain budget"
        tasks = []
        for index, case in enumerate(cases):
            entry = output[index] if index < len(output) and isinstance(output[index], dict) else {}
            missing = resource or self._resource(entry.get("error_type"), entry.get("error", ""))
            if stop_event is not None and stop_event.is_set(): missing = "interrupted"
            answer = (entry.get("submission") or {}).get("answer") if isinstance(entry.get("submission"), dict) else None
            valid = bool(entry.get("ok")) and isinstance(answer, str) and len(answer) <= 100000
            correct = valid and " ".join(answer.split()) == " ".join(case["target"].split())
            row = {"task_id": case["task_id"], "family": case["category"], "group": case["category"],
                   "score": float(correct) if not missing else 0.0, "score_available": not bool(missing),
                   "status": missing or ("ok" if valid else "invalid"), "correct": bool(correct) if not missing else None,
                   "source_index": case["source_index"], "submission": {"answer": answer} if valid else None}
            if missing: row.update(failure_kind=missing, error=source_error or entry.get("error", "Resource-limited evaluation"))
            elif not valid: row["error"] = source_error or entry.get("error", "Return an answer string")
            elif not correct: row["error"] = "Exact answer mismatch"
            # Hidden targets are never copied into public evaluation feedback.
            tasks.append(row)
        missing = [row for row in tasks if not row["score_available"]]
        groups = {task: {"score": sum(row["score"] for row in tasks if row["family"] == task) / sum(row["family"] == task for row in tasks),
                         "tasks": sum(row["family"] == task for row in tasks),
                         "score_available": all(row["score_available"] for row in tasks if row["family"] == task)} for task in TASKS}
        status = missing[0]["status"] if missing else "ok" if all(row["status"] == "ok" for row in tasks) else "partial_failure"
        return {"score": sum(row["score"] for row in tasks) / len(tasks), "score_available": not missing,
                "status": status, "split": split, "native_split": native_split, "seed": seed, "tasks": tasks, "groups": groups,
                "work_units": instructions if cost_known else max_work_units, "work_unit": self.spec.work_unit,
                "cost_status": "observed_source_instruction_events" if cost_known else "reserved_cap_actual_cost_unavailable",
                "execution": execution, "suite_digest": suite, "evaluator_digest": self.evaluator_digest,
                "data_provenance": deepcopy(self._manifest), "domain": self.spec.description,
                "evidence_scope": "Exact-answer accuracy on disjoint subsets of two tasks, with host-observed Python source trace events as cost. Not a full BBH result, not new reasoning algorithms, and not evidence of universal RSI. Resource-limited scores are missing, not observed zeros."}


__all__ = ["BigBenchHardBenchmark"]
