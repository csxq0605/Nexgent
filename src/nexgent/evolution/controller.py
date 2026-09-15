"""A durable experiment coordinator; the agent source owns the research algorithm.

The immutable host admits resources, runs programs, evaluates submissions and
maintains evidence. It does not select a scientific algorithm or write patches.
"""
from __future__ import annotations

from copy import deepcopy
import json
from pathlib import Path
import threading
import time
import uuid

from ..agents.broker import ImprovementBroker
from ..agents.seed import seed_files
from ..kernel.programs import canonical, digest, make_bundle, validate_source
from ..kernel.runner import ProgramRunner
from ..kernel.store import BudgetExhausted, Store
from ..models.gateway import ModelGateway
from ..research import LiteratureSearch
from ..research.library import ResearchEvidence
from ..science import API_REFERENCE, ResearchBenchmark, Toolbox, strong_baseline_files


PROTOCOL = {
    "version": "source-rsi-research-v1",
    "quality_delta": 0.002, "quality_worst_case": -0.12,
    "efficiency_delta": -0.002, "efficiency_worst_case": -0.05,
    "efficiency_cost_ratio": 0.85,
    "statement": "Engineering archive admission, fixed before the source-RSI model study. Scientific effects require paired final evidence.",
}
RUNTIME_CONTRACT = """Files execute workflow.py, task.py, meta.py in one namespace.
solve(problem, tools) returns {model:{terms:[expression strings],coefficients:[[numbers]]},...}.
improve(context, broker) returns {candidates:[{files:{filename:FULL source},rationale:str,hypothesis:str}],research:dict}.
select_parent(archive) optionally returns an existing archive id. context.parent is your actual source.
Editable files: task.py,meta.py,workflow.py,roles.json; functions, loops and algorithms can change.
No imports/classes/with/match/private names/reflective attributes/files/network. Attribute writes forbidden.
Safe builtins and math are available. Numeric and model capabilities are budgeted by the host.
Use the supplied tools API exactly. Code may read tools.work_units but cannot reset it.
Models return JSON. Source instruction ceiling is 2 million, numeric work is separately charged.
brokers: ask(role,prompt,payload,max_tokens=6000); parallel([{role,prompt,payload,max_tokens}]);
experiment(files,label) provides development-only measurements; search(query); log(kind,content).
The total per-study budget is in context.budget; respect remaining calls and reservations.
Research feedback includes actual failures and offspring results; final transfer evaluation stays private.
"""


def compact_measurement(report):
    """Enough to diagnose the experiments without resending every trajectory/model."""
    return {k: deepcopy(report[k]) for k in ("score", "score_available", "split", "seed", "status", "failure_kind", "groups", "work_units", "evaluator_digest", "suite_digest", "measurement_key", "bundle_id") if k in report} | {
        "tasks": [{k: deepcopy(t[k]) for k in ("task_id", "family", "group", "score", "nrmse", "status", "equation", "error", "complexity") if k in t} for t in report.get("tasks", [])]
    }


def compare(candidate, reference):
    resource_failures = {"timeout", "interrupted", "stopped", "budget_exhausted", "missing"}
    if any(r.get("status") in resource_failures or r.get("score_available") is False for r in (candidate, reference)):
        return {"accepted": False, "delta": None, "worst_case": None, "cost_ratio": candidate.get("work_units", 0) / max(1, reference.get("work_units", 0)), "reason": "Resource-limited measurement is missing; diagnose cost or execution before comparing quality"}
    old = {t["task_id"]: t for t in reference.get("tasks", [])}
    new = {t["task_id"]: t for t in candidate.get("tasks", [])}
    if not old or old.keys() != new.keys() or candidate.get("suite_digest") != reference.get("suite_digest"):
        return {"accepted": False, "delta": None, "worst_case": None, "cost_ratio": None, "reason": "Evaluation tasks do not match; no comparable evidence"}
    delta = candidate["score"] - reference["score"]
    worst = min(new[k]["score"] - old[k]["score"] for k in old)
    ratio = candidate["work_units"] / max(1, reference["work_units"])
    quality = delta >= PROTOCOL["quality_delta"] and worst >= PROTOCOL["quality_worst_case"]
    efficient = delta >= PROTOCOL["efficiency_delta"] and worst >= PROTOCOL["efficiency_worst_case"] and ratio <= PROTOCOL["efficiency_cost_ratio"]
    valid = candidate.get("status") == "ok"
    return {"accepted": bool(valid and (quality or efficient)), "delta": delta, "worst_case": worst, "cost_ratio": ratio,
            "reason": "Quality gain with bounded regressions" if quality and valid else "Comparable quality at lower measured work" if efficient and valid else "No admissible quality/cost improvement; retain evidence for research"}


class StudyController:
    def __init__(self, project_root, *, store=None, runner=None, benchmark=None, gateway_factory=None, search=None):
        self.root = Path(project_root).resolve()
        self.store = store or Store(self.root / ".nexgent" / "research")
        self.runner = runner or ProgramRunner()
        self.benchmark = benchmark or ResearchBenchmark()
        self.gateway_factory = gateway_factory or ModelGateway
        self.search = search if search is not None else ResearchEvidence(LiteratureSearch())
        self._guard = threading.RLock()

    def create(self, question, generations=3, arm="full", seed=0, budget=None, *, starting_program=None, prior_study=None):
        if not isinstance(question, str) or not question.strip() or len(question) > 12000:
            raise ValueError("Provide a research question within 12000 characters")
        if type(generations) is not int or not 1 <= generations <= 20 or type(seed) is not int:
            raise ValueError("Use 1..20 generations and an integer seed")
        if arm not in {"full", "task_only", "greedy"}:
            raise ValueError("Unknown registered experiment arm")
        limits = {"max_model_calls": generations * 6, "max_completion_tokens": generations * 30000,
                  "max_evaluations": generations * 12 + 12, "max_work_units_per_evaluation": 20_000_000,
                  "improver_timeout_seconds": 600}
        if budget:
            if set(budget) - limits.keys():
                raise ValueError("Unknown budget field")
            limits.update(budget)
        if any(type(v) is not int or v <= 0 for v in limits.values()):
            raise ValueError("Budgets must be positive integers")
        if limits["improver_timeout_seconds"] > 900:
            raise ValueError("Improver timeout must not exceed 900 seconds")
        initial = self.store.bundle(starting_program) if starting_program else make_bundle(seed_files(strong_baseline_files()), rationale="Strong unchanged scientific portfolio and initial literature/critique/source research program")
        self.store.put_bundle(initial)
        state = {"id": "study-" + uuid.uuid4().hex[:16], "question": question.strip(), "created": time.time(),
                 "status": "ready", "stage": "registered", "generation": 0, "max_generations": generations,
                 "arm": arm, "seed": seed, "budget": limits, "protocol": deepcopy(PROTOCOL),
                 "evaluator_digest": self.benchmark.evaluator_digest, "initial_program": initial["id"],
                 "active_program": initial["id"], "research_program": initial["id"], "archive": [],
                 "evaluations": [], "research": {"literature": [], "hypotheses": [], "experiments": [], "failures": [], "knowledge": []},
                 "conclusion": {}, "pending": None, "evaluation_count": 0, "numeric_work_units": 0,
                 "physical_numeric_work_units": 0, "admitted_measurements": {}, "implementation_digest": self._implementation_digest()}
        state["implementation_artifact"] = self.store.artifact(canonical(self._implementation_snapshot()))
        state["model_configuration"] = self._model_identity()
        if prior_study:
            prior = self.store.get(prior_study)
            # Only search/development evidence is reusable. Never inject the
            # completed study's final or meta-transfer measurements.
            public_history = {"failures": prior["research"]["failures"], "knowledge": prior["research"].get("knowledge", [])}
            state["prior_research"] = {"study_id": prior_study, "scope": "development_and_selection_only", "artifact": self.store.artifact(canonical(public_history))}
            state["research"]["failures"] = deepcopy(public_history["failures"][-8:])
            state["research"]["knowledge"] = deepcopy(public_history["knowledge"])
        self.store.save(state)
        self.store.event(state["id"], "registration", {"protocol": PROTOCOL, "arm": arm, "budget": limits, "initial_program": initial["id"], "evaluator_digest": state["evaluator_digest"]})
        return self.get(state["id"])

    def get(self, study_id):
        state = self.store.get(study_id)
        state["calls"] = self.store.calls(study_id)
        state["events"] = self.store.events(study_id)
        calls = state["calls"]
        state["usage"] = {"model_calls": len(calls), "reserved_completion_tokens": sum(c.get("reserved_completion_tokens", 0) for c in calls),
                          "reported_total_tokens": sum(c.get("usage", {}).get("total_tokens", 0) or 0 for c in calls),
                          "unknown_usage_calls": sum(not c.get("usage") for c in calls),
                          "evaluations": state.get("evaluation_count", 0), "numeric_work_units": state.get("numeric_work_units", 0),
                          "physical_numeric_work_units": state.get("physical_numeric_work_units", state.get("numeric_work_units", 0))}
        return state

    def _implementation_digest(self):
        return digest(self._implementation_snapshot())

    def _implementation_snapshot(self):
        import importlib.metadata
        source = Path(__file__).parents[1]
        # Freeze execution and research behavior; a window style change cannot
        # change the measured scientific implementation.
        files = {str(p.relative_to(source)): p.read_text(encoding="utf-8") for folder in ("kernel", "science", "agents", "models", "evolution", "research") for p in sorted((source / folder).glob("*.py"))}
        versions = {}
        for package in ("numpy", "scipy", "openai"):
            try:
                versions[package] = importlib.metadata.version(package)
            except importlib.metadata.PackageNotFoundError:
                versions[package] = "unavailable"
        return {"files": files, "versions": versions}

    def _model_identity(self):
        from ..models.config import load_profiles
        profiles, defaults = load_profiles(self.root)
        return {"defaults": defaults, "profiles": {key: {"model": p.model, "base_url": p.base_url} for key, p in profiles.items()}}

    def list_studies(self):
        return self.store.list()

    def get_program(self, program_id):
        return self.store.bundle(program_id)

    def continue_research(self, study_id, *, generations=3, budget=None):
        previous = self.store.get(study_id)
        return self.create(previous["question"], generations, previous["arm"], previous["seed"] + 1,
                           budget, starting_program=previous["research_program"], prior_study=study_id)

    def _save(self, state, progress=None):
        state["updated"] = time.time()
        self.store.save(state)
        if progress:
            progress(self.get(state["id"]))

    @staticmethod
    def _stop(stop_event):
        if stop_event is not None and stop_event.is_set():
            raise InterruptedError("Study stopped; admitted resources remain recorded")

    def _event(self, state, kind, content):
        """Register actual request/result artifacts, preserving explicit data edges."""
        content = deepcopy(content)
        if kind == "capability":
            if "request" in content:
                content["input_artifact_ids"] = [self.store.artifact(canonical(content["request"]))]
            if "result" in content:
                content["output_artifact_ids"] = [self.store.artifact(canonical(content["result"]))]
            content["depends_on"] = [state["pending"]["context_artifact"]] if (state.get("pending") or {}).get("context_artifact") else []
        self.store.event(state["id"], kind, content)

    def _measure(self, state, bundle, split, seed, stop_event=None):
        self._stop(stop_event)
        runtime_files = Path(__file__).parents[1] / "kernel"
        identity = {"source": bundle["digest"], "split": split, "seed": seed,
                    "evaluator": self.benchmark.evaluator_digest, "protocol": state["protocol"],
                    "runtime": digest({p.name: p.read_text(encoding="utf-8") for p in sorted(runtime_files.glob("*.py"))}),
                    "budget": state["budget"]["max_work_units_per_evaluation"]}
        key = digest(identity)
        with self._guard:
            cached = self.store.measurement(key)
            admitted = state.setdefault("admitted_measurements", {})
            if cached is not None and key in admitted:
                self.store.event(state["id"], "measurement_reused", {"key": key, "bundle_id": bundle["id"], "split": split, "seed": seed, "additional_work_units": 0, "logical_work_units": 0, "same_study": True})
                return cached
            if state["evaluation_count"] >= state["budget"]["max_evaluations"]:
                raise BudgetExhausted("The study's numerical evaluation budget is exhausted")
            state["evaluation_count"] += 1
            if cached is not None:
                state["numeric_work_units"] += cached.get("work_units", 0)
                admitted[key] = {"work_units": cached.get("work_units", 0), "physical_work_units": 0, "reused": True}
                self._save(state)
                self.store.event(state["id"], "measurement_reused", {"key": key, "bundle_id": bundle["id"], "split": split, "seed": seed, "additional_work_units": 0, "logical_work_units": cached.get("work_units", 0), "same_study": False})
                return cached
            # Reserve before process launch. Interrupted evaluation is not refunded.
            self._save(state)
            self.store.event(state["id"], "measurement_started", {"key": key, "bundle_id": bundle["id"], "split": split, "seed": seed, "identity": identity})
        report = self.benchmark.evaluate(bundle, split, seed, self.runner, stop_event=stop_event,
                                         max_work_units=state["budget"]["max_work_units_per_evaluation"])
        with self._guard:
            state["numeric_work_units"] += report.get("work_units", 0)
            state["physical_numeric_work_units"] = state.get("physical_numeric_work_units", 0) + report.get("work_units", 0)
            self._save(state)
        self._stop(stop_event)  # A cancelled worker never creates a successful reusable measurement.
        report["bundle_id"] = bundle["id"]
        report["measurement_key"] = key
        state["admitted_measurements"][key] = {"work_units": report.get("work_units", 0), "physical_work_units": report.get("work_units", 0), "reused": False}
        self._save(state)
        self.store.measurement(key, report)
        self.store.event(state["id"], "measurement", {"key": key, "bundle_id": bundle["id"], "evidence": compact_measurement(report), "artifact": self.store.artifact(canonical(report))})
        return report

    def _gateway(self, state, stop_event, admission=None):
        return self.gateway_factory(self.root, reserve=admission or (lambda receipt: self.store.reserve(state["id"], receipt)), stop_event=stop_event)

    def _context(self, state, parent, development):
        usage = self.get(state["id"])["usage"]
        return {"question": state["question"], "parent": parent, "roles": json.loads(parent["files"].get("roles.json", "{}")),
                "development": compact_measurement(development), "failures": state["research"]["failures"][-8:],
                "archive": deepcopy(state["archive"]), "tool_api": API_REFERENCE, "runtime_contract": RUNTIME_CONTRACT,
                "budget": {**state["budget"], "remaining_calls": state["budget"]["max_model_calls"] - usage["model_calls"],
                           "remaining_completion_tokens": state["budget"]["max_completion_tokens"] - usage["reserved_completion_tokens"]},
                "research_mechanism": "Use actual offspring evidence and failures to improve task code AND the research/improvement program; final tests remain private.",
                "editable_components": ["task.py"] if state["arm"] == "task_only" else ["task.py", "meta.py", "workflow.py", "roles.json"]}

    def _generate(self, state, parent, context, label, stop_event=None):
        self._stop(stop_event)
        context_id = self.store.artifact(canonical(context))
        if state.get("pending") is not None:
            state["pending"]["context_artifact"] = context_id
        self._save(state)
        calls_before = {c["call_id"] for c in self.store.calls(state["id"])}
        admission_lock = threading.RLock()
        def admission(receipt):
            with admission_lock:
                if context.get("meta_evaluation") and receipt["status"] == "started":
                    current = [c for c in self.store.calls(state["id"]) if c["call_id"] not in calls_before]
                    limits = context["matched_generation_budget"]
                    if len(current) >= limits["max_model_calls"] or sum(c.get("reserved_completion_tokens", 0) for c in current) + receipt["reserved_completion_tokens"] > limits["max_completion_tokens"]:
                        raise BudgetExhausted("Matched improver generation budget is exhausted")
                self.store.reserve(state["id"], receipt)
        gateway = self._gateway(state, stop_event, admission)
        gateway.preflight()
        numerical_reports = []
        numerical_attempts = [0]

        def experiment(files, experiment_label):
            if context.get("meta_evaluation"):
                if numerical_attempts[0] >= context["matched_generation_budget"]["max_development_experiments"]:
                    raise BudgetExhausted("Matched improver development-experiment budget is exhausted")
                numerical_attempts[0] += 1
            if state["arm"] == "task_only" and not context.get("meta_evaluation"):
                files = {"task.py": files.get("task.py", parent["files"]["task.py"])}
            trial = make_bundle(files, parent, rationale=experiment_label, provenance={"kind": "agent_development_experiment", "study": state["id"]})
            self.store.put_bundle(trial)
            report = self._measure(state, trial, "development", context.get("development_seed", state["seed"]), stop_event)
            numerical_reports.append(compact_measurement(report))
            return compact_measurement(report)

        broker = ImprovementBroker(gateway, parent_files=parent["files"], experiment=experiment,
                                   search=self.search, event=lambda kind, content: self._event(state, kind, content),
                                   stop_event=stop_event, source_bundle=parent["id"])
        try:
            response = self.runner.run(parent, "improve", context, handler=broker.handle,
                                       timeout=state["budget"]["improver_timeout_seconds"], stop_event=stop_event)
        except Exception as exc:
            exc.calls = [c for c in self.store.calls(state["id"]) if c["call_id"] not in calls_before]
            exc.numerical_reports = numerical_reports
            raise
        value = response["value"]
        if not isinstance(value, dict) or not isinstance(value.get("candidates"), list) or len(value["candidates"]) > 4:
            failure = ValueError("improve must return at most four source candidates")
            failure.calls = [c for c in self.store.calls(state["id"]) if c["call_id"] not in calls_before]
            failure.numerical_reports = numerical_reports
            failure.execution = response["execution"]
            raise failure
        candidates, failures = [], []
        methods = [n for n in dir(Toolbox) if not n.startswith("_") and callable(getattr(Toolbox, n))]
        for proposal in value["candidates"]:
            try:
                if not isinstance(proposal, dict) or not proposal.get("rationale") or not proposal.get("hypothesis"):
                    raise ValueError("A candidate needs explicit rationale and falsifiable hypothesis")
                replacements = proposal["files"]
                if state["arm"] == "task_only" and not context.get("meta_evaluation"):
                    replacements = {"task.py": replacements.get("task.py", parent["files"]["task.py"])}
                candidate = make_bundle(replacements, parent, rationale=proposal["rationale"],
                                        provenance={"study": state["id"], "label": label, "hypothesis": proposal["hypothesis"], "context_artifact": context_id, "producer_source": parent["id"]})
                for name, source in candidate["files"].items():
                    if name.endswith(".py"):
                        validate_source(source, name, methods)
                if candidate["digest"] == parent["digest"]:
                    raise ValueError("The candidate contains no source changes")
                self.store.put_bundle(candidate)
                candidates.append(candidate)
            except (ValueError, KeyError, TypeError) as exc:
                failures.append({"type": "invalid_source", "error": str(exc)[:1200], "proposal_artifact": self.store.artifact(canonical(proposal))})
        result = {"candidates": candidates, "failures": failures, "research": value.get("research", {}),
                  "execution": response["execution"], "context_artifact": context_id, "numerical_reports": numerical_reports,
                  "calls": [c for c in self.store.calls(state["id"]) if c["call_id"] not in calls_before]}
        self.store.event(state["id"], "offspring_generated", {"parent_id": parent["id"], "label": label, "candidate_ids": [c["id"] for c in candidates], "execution": response["execution"], "artifact": self.store.artifact(canonical(result))})
        return result

    def _parent(self, state, stop_event):
        if state["arm"] == "greedy":
            return self.store.bundle(state["active_program"])
        source = self.store.bundle(state["research_program"])
        try:
            result = self.runner.run(source, "select_parent", deepcopy(state["archive"]), stop_event=stop_event, timeout=20)
            identity = result["value"]
            if identity not in {n["id"] for n in state["archive"]}:
                raise ValueError("Source parent selector returned no existing archive identity")
            self.store.event(state["id"], "parent_selection", {"selector_source": source["id"], "selected": identity, "execution": result["execution"]})
            return self.store.bundle(identity)
        except InterruptedError:
            raise
        except Exception as exc:
            self.store.event(state["id"], "selector_failure", {"source": source["id"], "error": str(exc), "fallback": state["active_program"]})
            state["research"]["failures"].append({"kind": "selector_failure", "error": str(exc)[:1200]})
            return self.store.bundle(state["active_program"])

    def _retain_research(self, state, result):
        research = result.get("research", {})
        if not isinstance(research, dict):
            research = {"unstructured": research}
        for field in ("literature", "hypotheses"):
            if research.get(field):
                state["research"][field].append({"generation": state["generation"] + 1, "content": research[field]})
        state["research"]["experiments"].append({"generation": state["generation"] + 1, "research": research, "execution": result.get("execution"), "candidate_ids": [c["id"] for c in result.get("candidates", [])]})
        state["research"]["failures"].extend(result.get("failures", []))

    def run(self, study_id, progress=None, stop_event=None):
        stop_event = stop_event or threading.Event()
        with self.store.lock(study_id):
            state = self.store.get(study_id)
            if state["status"] == "completed":
                return self.get(study_id)
            if state["evaluator_digest"] != self.benchmark.evaluator_digest or state["protocol"] != PROTOCOL or state.get("implementation_digest") != self._implementation_digest() or state.get("model_configuration") != self._model_identity():
                raise ValueError("Evaluator or registered protocol changed; create a new study")
            try:
                self._gateway(state, stop_event).preflight()
                state.update(status="running", stage="strong baseline")
                self._save(state, progress)
                initial = self.store.bundle(state["initial_program"])
                if not state["archive"]:
                    dev = self._measure(state, initial, "development", state["seed"], stop_event)
                    selection = self._measure(state, initial, "selection", state["seed"] + 17, stop_event)
                    state["baseline"] = {"development": compact_measurement(dev), "selection": compact_measurement(selection)}
                    state["archive"].append({"id": initial["id"], "parent_id": initial.get("parent_id"), "generation": initial["generation"], "score": selection["score"], "children": 0, "descendant_gain": 0, "changes": [], "status": "initial"})
                    self._save(state, progress)
                while state["generation"] < state["max_generations"]:
                    self._stop(stop_event)
                    pending = state.get("pending")
                    if pending and pending.get("phase") == "generating":
                        # A crashed provider attempt is never silently reissued on resume.
                        state["research"]["failures"].append({"generation": pending["generation"], "kind": "interrupted_generation", "parent_id": pending["parent_id"], "reason": "No committed offspring; prior call reservations remain charged"})
                        state["generation"] = pending["generation"]
                        state["pending"] = None
                        self._save(state, progress)
                        continue
                    if not pending:
                        parent = self._parent(state, stop_event)
                        dev = self._measure(state, parent, "development", state["seed"], stop_event)
                        state["pending"] = {"phase": "generating", "generation": state["generation"] + 1, "parent_id": parent["id"], "processed": []}
                        state.update(stage=f"generation {state['generation'] + 1}: source research", research_program=parent["id"])
                        self._save(state, progress)
                        context = self._context(state, parent, dev)
                        try:
                            result = self._generate(state, parent, context, f"generation-{state['generation'] + 1}", stop_event)
                            self._retain_research(state, result)
                            state["pending"].update(phase="evaluating", candidates=[c["id"] for c in result["candidates"]])
                        except InterruptedError:
                            raise
                        except Exception as exc:
                            failure = {"generation": state["generation"] + 1, "parent_id": parent["id"], "kind": "research_execution_failure", "error": f"{type(exc).__name__}: {str(exc)[:1200]}"}
                            state["research"]["failures"].append(failure)
                            self.store.event(study_id, "research_failure", failure)
                            if any(label in str(exc) for label in ("ModelTransportError", "Provider request failed", "budget is exhausted")):
                                raise RuntimeError("Research transport or budget failed; diagnose before starting another model generation: " + str(exc)) from exc
                            state["pending"].update(phase="evaluating", candidates=[])
                        self._save(state, progress)
                    pending = state["pending"]
                    parent = self.store.bundle(pending["parent_id"])
                    for candidate_id in pending["candidates"]:
                        if candidate_id in pending["processed"]:
                            continue
                        self._stop(stop_event)
                        state["stage"] = f"generation {pending['generation']}: independent experiment"
                        self._save(state, progress)
                        candidate = self.store.bundle(candidate_id)
                        measured = self._measure(state, candidate, "selection", state["seed"] + 17, stop_event)
                        champion = self.store.bundle(state["active_program"])
                        reference = self._measure(state, champion, "selection", state["seed"] + 17, stop_event)
                        decision = compare(measured, reference)
                        changes = [n for n in candidate["files"] if candidate["component_digests"][n] != parent["component_digests"].get(n)]
                        available = measured.get("score_available", True) and measured.get("status") not in {"budget_exhausted", "timeout", "interrupted", "stopped", "missing"}
                        row = {"generation": pending["generation"], "candidate_id": candidate_id, "parent_id": parent["id"], "score": measured["score"] if available else None,
                               **decision, "decision": "promoted" if decision["accepted"] else "research archive", "changes": changes,
                               "measurement": compact_measurement(measured), "reference_id": champion["id"]}
                        state["evaluations"].append(row)
                        parent_node = next(n for n in state["archive"] if n["id"] == parent["id"])
                        parent_node["children"] += 1
                        if available and parent_node.get("score") is not None:
                            parent_node["descendant_gain"] += measured["score"] - parent_node["score"]
                        state["archive"].append({"id": candidate_id, "parent_id": parent["id"], "generation": candidate["generation"], "score": measured["score"] if available else None, "score_available": bool(available), "children": 0, "descendant_gain": 0, "changes": changes, "status": row["decision"]})
                        # Exploration is separate from deployment: the new research
                        # program may choose any actual archive branch next time.
                        state["research_program"] = candidate_id
                        if decision["accepted"]:
                            state["active_program"] = candidate_id
                        else:
                            state["research"]["failures"].append({"kind": "scientific_counterexample", "generation": pending["generation"], "candidate_id": candidate_id,
                                                                  "decision": decision, "measurement": compact_measurement(measured)})
                        state["research"]["knowledge"].append({"kind": "measured_candidate", "source": candidate_id, "hypothesis": candidate["provenance"].get("hypothesis"), "decision": decision, "measurement_key": measured["measurement_key"]})
                        pending["processed"].append(candidate_id)
                        self.store.event(study_id, "candidate_evaluated", row)
                        self._save(state, progress)
                    state["generation"] = pending["generation"]
                    state["pending"] = None
                    self._save(state, progress)
                state["stage"] = "final unseen-family evaluation"
                self._save(state, progress)
                selected = self.store.bundle(state["active_program"])
                final_rows = []
                for seed in (state["seed"] + 101, state["seed"] + 202, state["seed"] + 303):
                    reference = self._measure(state, initial, "final_transfer", seed, stop_event)
                    candidate = self._measure(state, selected, "final_transfer", seed, stop_event)
                    missing = any(r.get("status") in {"timeout", "interrupted", "stopped", "budget_exhausted", "missing"} for r in (reference, candidate))
                    final_rows.append({"seed": seed, "initial": compact_measurement(reference), "selected": compact_measurement(candidate), "status": "missing" if missing else "evaluated", "delta": None if missing else candidate["score"] - reference["score"], "cost_ratio": candidate["work_units"] / max(1, reference["work_units"])})
                execution_sources = {e["content"].get("parent_id") for e in self.store.events(study_id) if e["kind"] == "offspring_generated"}
                changed_meta_ids = {e["candidate_id"] for e in state["evaluations"] if set(e["changes"]) & {"meta.py", "workflow.py"}}
                state["conclusion"] = {"protocol_completed": True, "source_self_modification": bool(state["evaluations"]),
                                       "executable_meta_changed": any(set(e["changes"]) & {"meta.py", "workflow.py"} for e in state["evaluations"]),
                                       "inherited_improver_executed": sorted(changed_meta_ids & execution_sources),
                                       "final_transfer": final_rows, "mean_transfer_delta": (sum(r["delta"] for r in final_rows if r["delta"] is not None) / len([r for r in final_rows if r["delta"] is not None])) if any(r["delta"] is not None for r in final_rows) else None,
                                       "missing_transfer_seeds": [r["seed"] for r in final_rows if r["delta"] is None],
                                       "meta_productivity": "Requires the separate actual-offspring controlled comparison",
                                       "domain": "Synthetic scientific dynamics; evidence concerns recovery and agent software, not discovery of an unknown natural law"}
                state.update(status="completed", stage="study completed; evidence available")
                self.store.event(study_id, "study_completed", state["conclusion"])
            except InterruptedError as exc:
                state.update(status="paused", stage="stopped", last_error=str(exc))
                self.store.event(study_id, "stopped", {"error": str(exc)})
            except Exception as exc:
                state.update(status="failed", stage="requires diagnosis", last_error=f"{type(exc).__name__}: {str(exc)[:1200]}")
                self.store.event(study_id, "study_failure", {"error": state["last_error"]})
            self._save(state, progress)
            return self.get(study_id)

    def meta_evaluate(self, study_id, seeds=(401, 502, 603), k=1, stop_event=None, progress=None):
        """Register a separate, budgeted experiment on two frozen actual improvers.

        No result flows back into the completed source study. Reopening the same
        experiment returns its report; an interrupted experiment is not reissued.
        """
        from .meta_evaluation import evaluate_improvers
        stop_event = stop_event or threading.Event()
        origin = self.store.get(study_id)
        if origin["status"] != "completed" or not origin["evaluations"]:
            raise ValueError("Finish a source study with evaluated descendants first")
        if origin.get("implementation_digest") != self._implementation_digest() or origin.get("model_configuration") != self._model_identity():
            raise ValueError("Study implementation changed before meta evaluation; register a new source study")
        initial = self.store.bundle(origin["initial_program"])
        evolved = self.store.bundle(origin["research_program"])
        registered = {"origin_study": study_id, "initial": initial["id"], "evolved": evolved["id"], "seeds": list(seeds), "k": k,
                      "generation_budget": {"max_model_calls": 6, "max_completion_tokens": 30000, "max_development_experiments": 3}}
        identity = "study-" + digest(registered)[:16]
        with self.store.lock(identity):
            try:
                existing = self.store.get(identity)
            except KeyError:
                existing = None
            if existing:
                if existing.get("meta_evaluation"):
                    return existing["meta_evaluation"]
                raise ValueError("This registered meta experiment has an incomplete attempt; inspect its receipts before a new registration")
            raw = {**deepcopy(origin), "id": identity, "kind": "meta_evaluation", "question": "Actual improver comparison: " + origin["question"],
                   "created": time.time(), "status": "running", "stage": "registered actual offspring experiment", "archive": [], "evaluations": [],
                   "research": {"literature": [], "hypotheses": [], "experiments": [], "failures": [], "knowledge": []},
                   "conclusion": {}, "registration": registered, "evaluation_count": 0, "numeric_work_units": 0,
                   "physical_numeric_work_units": 0, "admitted_measurements": {}, "pending": None,
                   "budget": {"max_model_calls": 12 * k * len(seeds), "max_completion_tokens": 60000 * k * len(seeds),
                              "max_evaluations": 32 * k * len(seeds), "max_work_units_per_evaluation": 20_000_000, "improver_timeout_seconds": 600}}
            self._save(raw, progress)
            self.store.event(identity, "meta_registration", registered)

            def measure(bundle, split, seed):
                self._stop(stop_event)
                self.store.put_bundle(bundle)
                return self._measure(raw, bundle, split, seed, stop_event)

            def generate(parent, context, label):
                self._stop(stop_event)
                self.store.put_bundle(parent)
                public = self._context(raw, parent, context["development"])
                public.update(context)
                public["development"] = compact_measurement(context["development"])
                public.update(meta_evaluation=True, development_seed=context["seed"], matched_generation_budget=registered["generation_budget"], failures=[], archive=[])
                public["budget"].update(remaining_calls=6, remaining_completion_tokens=30000)
                raw.update(stage="actual improver: " + label, pending={"phase": "meta_generating", "label": label})
                self._save(raw, progress)
                result = self._generate(raw, parent, public, label, stop_event)
                self._retain_research(raw, result)
                self._save(raw, progress)
                return result

            try:
                report = evaluate_improvers(initial, evolved, initial, seeds=seeds, k=k, generate=generate, evaluate=measure)
                self._stop(stop_event)
                for bundle in sorted(report["artifacts"].values(), key=lambda b: b["generation"]):
                    self.store.put_bundle(bundle)
                report["meta_study_id"] = identity
                report["registered_generation_budget"] = registered["generation_budget"]
                raw.update(status="completed", stage="actual offspring comparison complete", meta_evaluation=report, pending=None)
                self._save(raw, progress)
                report["ledger_usage"] = self.get(identity)["usage"]
                origin["conclusion"]["meta_evaluation"] = report
                origin["conclusion"]["meta_study_id"] = identity
                self.store.save(origin)
                self.store.event(study_id, "meta_evaluation_completed", {"meta_study_id": identity, "aggregate": report["aggregate"], "evidence": report["evidence"]})
                return report
            except Exception as exc:
                raw.update(status="paused" if stop_event.is_set() else "failed", stage="meta experiment needs diagnosis", last_error=f"{type(exc).__name__}: {str(exc)[:1200]}")
                self._save(raw, progress)
                raise

    def export(self, study_id, destination=None):
        state = self.get(study_id)
        ids = {state["initial_program"], state["active_program"], state["research_program"]} | {n["id"] for n in state["archive"]}
        payload = {"schema": "nexgent-study-v1", "study": state, "bundles": [self.store.bundle(i) for i in sorted(ids)]}
        if state.get("implementation_artifact"):
            with self.store.connect() as db:
                row = db.execute("SELECT content FROM artifacts WHERE id=?", (state["implementation_artifact"],)).fetchone()
            if row:
                payload["implementation"] = json.loads(row[0])
        # Never export model configuration. Request/output evidence may contain
        # the research question and source; export is an explicit local action.
        destination = Path(destination) if destination else self.root / ".nexgent" / "exports" / f"{study_id}.json"
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_text(json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False), encoding="utf-8")
        return str(destination.resolve())
