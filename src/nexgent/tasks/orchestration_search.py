"""Bounded development search for genuine orchestration candidates.

This module is deliberately upstream of selection.  It classifies PackagePatch
v3 children by their *executed orchestration structure*, projects only bounded
public development outcomes into repair briefs, and stores an append-only event
chain.  Generating candidates is not evidence of benefit; a search can only
return candidates that are ready for an independent selection experiment.
"""

from __future__ import annotations

import ast
from copy import deepcopy
import json
import math
import time
import uuid

from ..kernel.programs import digest
from .dynamic_roles import materialize_task_roles
from .package_runner import CapabilityAbort
from .packages import verify_package
from .tools import ContractError


SEARCH_SCHEMA = "nexgent.orchestration-search.v1"
SEARCH_EVENT_SCHEMA = "nexgent.orchestration-search-event.v1"
QUALIFICATION_SCHEMA = "nexgent.orchestration-development-qualification.v1"
REPAIR_SCHEMA = "nexgent.orchestration-repair-brief.v1"
_TERMINAL = frozenset({"completed", "failed"})


class DevelopmentQualificationError(ContractError):
    """A terminal, sanitized development-run failure with durable evidence."""

    def __init__(self, failure):
        self.failure = _copy(failure, "Development qualification failure")
        super().__init__(self.failure.get("failure_type", "qualification_failed"))


def _copy(value, label):
    try:
        return json.loads(json.dumps(value, ensure_ascii=False, sort_keys=True,
                                     separators=(",", ":"), allow_nan=False))
    except (TypeError, ValueError, RecursionError) as exc:
        raise ContractError(f"{label} must be finite JSON") from exc


def _id(prefix):
    return prefix + "-" + uuid.uuid4().hex[:16]


def _node_refs(value):
    refs = set()
    if isinstance(value, dict):
        if isinstance(value.get("$node"), str):
            refs.add(value["$node"].split(".", 1)[0])
        first = value.get("$first_success")
        if isinstance(first, list):
            refs.update(item.split(".", 1)[0] for item in first
                        if isinstance(item, str))
        for child in value.values():
            refs.update(_node_refs(child))
    elif isinstance(value, list):
        for child in value:
            refs.update(_node_refs(child))
    return refs


def _without_prompt_text(value):
    """Copy structural values while withholding embedded model instructions."""
    if isinstance(value, dict):
        return {key: _without_prompt_text(child)
                for key, child in value.items() if key != "prompt"}
    if isinstance(value, list):
        return [_without_prompt_text(child) for child in value]
    return deepcopy(value)


def _graph_projection(graph):
    if not isinstance(graph, dict) or not isinstance(graph.get("nodes"), list):
        raise ContractError("Orchestration workflow must contain a node list")
    rows = []
    for node in graph["nodes"]:
        if not isinstance(node, dict) or not isinstance(node.get("id"), str):
            raise ContractError("Orchestration workflow nodes need stable ids")
        row = {
            "id": node["id"],
            "method": node.get("method"),
            "role_ref": node.get("role_ref"),
            "component_ref": node.get("component_ref"),
            "depends_on": sorted(_node_refs(node.get("bindings", {}))),
            "params": _without_prompt_text(node.get("params", {})),
            "condition": deepcopy(node.get("condition")),
            "on_failure": deepcopy(node.get("on_failure")),
            "retry": deepcopy(node.get("retry")),
            "join_policy": node.get("join_policy"),
            "max_iterations": node.get("max_iterations"),
            "until": deepcopy(node.get("until")),
        }
        if node.get("method") == "loop":
            row["body"] = _graph_projection(node.get("body"))
        rows.append(row)
    return {
        "nodes": rows,
        "outputs_from": sorted(_node_refs(graph.get("outputs", {}))),
        "control_edges": deepcopy(graph.get("control_edges", [])),
        "artifact_edges": deepcopy(graph.get("artifact_edges", [])),
        "join_policy": graph.get("join_policy"),
        "failure_routes": deepcopy(graph.get("failure_routes", [])),
        "revision_rules": deepcopy(graph.get("revision_rules", [])),
    }


def orchestration_projection(package):
    """Return a prompt-free structural projection of executable orchestration.

    Prompt or skill text is intentionally absent.  A candidate therefore
    cannot qualify as O evolution merely by changing an S component.
    """
    verify_package(package)
    manifest = package["manifest"]
    if manifest.get("manifest_version") != 2:
        raise ContractError("Orchestration search requires manifest v2")
    components = manifest.get("components", {})
    workflows = {}
    used_roles = set()
    task_roles = {}
    root = manifest.get("orchestrator")
    if not isinstance(root, str):
        raise ContractError("Package has no registered orchestrator identity")
    pending, visited = [root], set()
    while pending:
        component_id = pending.pop(0)
        if component_id in visited:
            continue
        visited.add(component_id)
        component = components.get(component_id)
        if (not isinstance(component, dict) or component.get("class") != "O"
                or component.get("kind") != "workflow"):
            raise ContractError("Reachable orchestrator must be an O workflow component")
        ref = component.get("ref")
        declaration = manifest.get("workflows", {}).get(ref)
        if not isinstance(declaration, dict) or not isinstance(declaration.get("ref"), str):
            raise ContractError("O workflow component has no registered workflow")
        try:
            graph = materialize_task_roles(
                json.loads(package["files"][declaration["ref"]]))
        except (KeyError, TypeError, json.JSONDecodeError) as exc:
            raise ContractError("O workflow component is not valid JSON") from exc
        for role_ref, role in graph.get("task_roles", {}).items():
            structural = {
                "component_ref": role.get("component_ref"),
                "capabilities": sorted(role.get("capabilities", [])),
                "digest": role.get("digest"),
            }
            previous = task_roles.setdefault(role_ref, structural)
            if previous != structural:
                raise ContractError("Task role identity has conflicting definitions")
        projected = _graph_projection(graph)
        stack = list(projected["nodes"])
        while stack:
            row = stack.pop()
            if isinstance(row.get("role_ref"), str):
                used_roles.add(row["role_ref"])
            if isinstance(row.get("body"), dict):
                stack.extend(row["body"].get("nodes", []))
            nested = components.get(row.get("component_ref"))
            if (isinstance(nested, dict) and nested.get("class") == "O"
                    and nested.get("kind") == "workflow"):
                pending.append(row["component_ref"])
        for rule in projected.get("revision_rules", []):
            planner_role_ref = (
                rule.get("planner_role_ref") if isinstance(rule, dict) else None)
            if isinstance(planner_role_ref, str):
                used_roles.add(planner_role_ref)
            workflow_ref = rule.get("workflow_ref") if isinstance(rule, dict) else None
            owners = [identity for identity, declaration in components.items()
                      if declaration.get("class") == "O"
                      and declaration.get("kind") == "workflow"
                      and declaration.get("ref") == workflow_ref]
            pending.extend(owners)
        workflows[component_id] = {
            "registry_ref": ref,
            "max_parallel": declaration.get("max_parallel", 4),
            "graph": projected,
        }
    if not workflows:
        raise ContractError("Package has no executable O workflow component")
    roles = {}
    for role_ref in sorted(used_roles):
        if role_ref in task_roles:
            role = task_roles[role_ref]
            roles[role_ref] = {
                "component_ids": [role["component_ref"]],
                "capabilities": list(role["capabilities"]),
                "content_digest": role["digest"],
            }
            continue
        declaration = manifest.get("roles", {}).get(role_ref)
        if not isinstance(declaration, dict):
            raise ContractError("Workflow references an unregistered role")
        owners = sorted(identity for identity, component in components.items()
                        if component.get("kind") == "role"
                        and component.get("ref") == role_ref)
        roles[role_ref] = {
            "component_ids": owners,
            "capabilities": sorted(declaration.get("capabilities", [])),
        }
    return {
        "orchestrator": root,
        "workflows": workflows,
        "used_roles": roles,
    }


def orchestration_delta(parent, child):
    """Prove that workflow edges, role assignments, or O policy changed."""
    before = orchestration_projection(parent)
    after = orchestration_projection(child)
    return {
        "changed": before != after,
        "parent_projection_digest": digest(before),
        "candidate_projection_digest": digest(after),
    }


def _controlled_source_is_statically_local(package, component_ref):
    component = package["manifest"].get("components", {}).get(component_ref)
    if not isinstance(component, dict) or component.get("kind") != "skill":
        raise ContractError("Workflow skill has no stable component identity")
    skill = package["manifest"].get("skills", {}).get(component.get("ref"))
    if not isinstance(skill, dict):
        raise ContractError("Workflow skill is not registered")
    if skill.get("kind") != "controlled_code":
        # Non-code skills cross a host capability boundary whose cost cannot be
        # inferred from the package alone.
        return False
    path = skill.get("ref", "").split(":", 1)[0]
    try:
        tree = ast.parse(package["files"][path])
    except (KeyError, SyntaxError, TypeError) as exc:
        raise ContractError("Controlled skill source cannot be inspected") from exc
    external = {"ask", "tool", "parallel", "delegate", "plan", "feedback"}
    return not any(isinstance(node, ast.Attribute) and node.attr in external
                   for node in ast.walk(tree))


class _DynamicWorkBudget(ContractError):
    """A valid graph whose complete work cannot be inferred from its package."""


def _graph_work_budget(graph, package):
    """Conservatively bound one reachable workflow execution."""
    if graph.get("revision_rules"):
        raise _DynamicWorkBudget(
            "Dynamic workflow revision has no package-static development budget bound")
    total = {"model_calls": 0, "completion_tokens": 0,
             "tool_calls": 0, "nodes": 0}
    nodes = graph.get("nodes")
    if not isinstance(nodes, list):
        raise ContractError("Workflow budget requires a node list")
    for node in nodes:
        method = node.get("method")
        total["nodes"] += 1
        if method == "ask":
            max_tokens = (node.get("params") or {}).get("max_tokens", 4000)
            if type(max_tokens) is not int or not 1 <= max_tokens <= 6000:
                raise ContractError("Ask node has no valid completion-token bound")
            total["model_calls"] += 1
            total["completion_tokens"] += max_tokens
        elif method == "tool":
            total["tool_calls"] += 1
        elif method == "loop":
            bound = node.get("max_iterations")
            if type(bound) is not int or not 1 <= bound <= 1000:
                raise ContractError("Loop node has no finite iteration bound")
            nested = _graph_work_budget(node.get("body") or {}, package)
            for key in total:
                total[key] += bound * nested[key]
        elif method in {"parallel", "delegate"}:
            raise _DynamicWorkBudget(
                f"{method} node has no package-static descendant work bound")
        elif method == "skill":
            if not _controlled_source_is_statically_local(
                    package, node.get("component_ref")):
                raise _DynamicWorkBudget(
                    "Workflow skill has dynamic external work")
        elif method not in {"join", "read_artifact", "publish", "memory_search",
                            "remember"}:
            raise ContractError(f"Workflow method has no static work model: {method}")
    return total


def reachable_work_budget(package):
    """Return a conservative hard cap for the active reachable workflow.

    Unsupported dynamic delegation or workflow revision fails closed instead of
    silently under-budgeting a candidate.
    """
    verify_package(package)
    manifest = package["manifest"]
    root = manifest.get("orchestrator")
    component = manifest.get("components", {}).get(root)
    if (not isinstance(component, dict) or component.get("class") != "O"
            or component.get("kind") != "workflow"):
        raise ContractError("Active orchestrator is not a statically bounded O workflow")
    ref = component.get("ref")
    declaration = manifest.get("workflows", {}).get(ref)
    try:
        graph = json.loads(package["files"][declaration["ref"]])
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ContractError("Active workflow cannot be loaded for budget analysis") from exc
    return _graph_work_budget(graph, package)


def _development_episode_budget(value):
    fields = {"max_model_calls", "max_completion_tokens",
              "max_tool_calls", "max_nodes"}
    value = _copy(value, "Development Episode budget")
    if (not isinstance(value, dict) or set(value) != fields
            or any(type(value[key]) is not int or value[key] < 0
                   for key in fields)
            or value["max_nodes"] < 1):
        raise ContractError(
            "Development Episode budget must freeze every nonnegative runtime limit")
    return value


def _estimated_episode_budget(arms):
    cap = {key: max(arms["parent"][key], arms["candidate"][key])
           for key in arms["parent"]}
    # Runtime bookkeeping has bounded non-model nodes around the graph.  Keep
    # the established floor while deriving model/tool work from reachable code.
    cap["nodes"] = max(30, cap["nodes"] + 8)
    return {
        "max_model_calls": cap["model_calls"],
        "max_completion_tokens": cap["completion_tokens"],
        "max_tool_calls": cap["tool_calls"],
        "max_nodes": cap["nodes"],
    }


def paired_episode_budget(parent, candidate, *, development_episode_budget=None):
    """Give paired arms one cap, estimating static graphs and capping dynamic ones.

    A package-static estimate remains the default for simple workflows.  Graphs
    with runtime revision, delegation, parallel RPC, or externally acting
    skills require an explicit Episode cap; runtime accounting then enforces
    that same frozen cap independently on both paired arms.
    """
    explicit = (None if development_episode_budget is None else
                _development_episode_budget(development_episode_budget))
    arms, static_arms, dynamic_error = {}, {}, None
    for name, package in (("parent", parent), ("candidate", candidate)):
        try:
            budget = reachable_work_budget(package)
            static_arms[name] = budget
        except _DynamicWorkBudget as exc:
            dynamic_error = exc
            # A dynamic arm has no honest package-static estimate: a revision
            # may replace pending base nodes and descendants are runtime data.
            budget = None
        arms[name] = budget
    if dynamic_error is not None and explicit is None:
        raise ContractError(
            "Dynamic workflow work requires an explicit development Episode budget"
        ) from dynamic_error
    if explicit is None:
        return {"arms": arms, "episode_budget": _estimated_episode_budget(arms)}
    if static_arms:
        static_values = list(static_arms.values())
        static_required = _estimated_episode_budget({
            "parent": static_values[0], "candidate": static_values[-1]})
        if any(explicit[key] < static_required[key] for key in static_required):
            raise ContractError(
                "Explicit development Episode budget is insufficient for the static paired arm")
    return {"arms": arms, "episode_budget": explicit}


def normalize_qualification(candidate_id, value):
    """Validate the only development projection allowed into search/repair."""
    value = _copy(value, "Development qualification")
    if (not isinstance(candidate_id, str) or not candidate_id
            or not isinstance(value, dict)
            or set(value) != {"schema", "candidate_id", "tasks", "usage",
                              "evidence_refs"}
            or value.get("schema") != QUALIFICATION_SCHEMA
            or value.get("candidate_id") != candidate_id
            or not isinstance(value.get("tasks"), list)
            or not value["tasks"] or len(value["tasks"]) > 128):
        raise ContractError("Development qualification has an invalid envelope")
    refs = value["evidence_refs"]
    if (not isinstance(refs, dict) or set(refs) != {"plan_id", "trial_id"}
            or any(not isinstance(refs[key], str) or not refs[key] for key in refs)):
        raise ContractError("Development qualification evidence refs are invalid")
    task_fields = {
        "statistical_unit_id", "parent_status", "candidate_status",
        "parent_score_available", "candidate_score_available",
        "parent_score", "candidate_score", "activation_loaded",
        "artifact_contract_valid",
    }
    seen = set()
    for row in value["tasks"]:
        if not isinstance(row, dict) or set(row) != task_fields:
            raise ContractError("Development qualification exposes unknown task fields")
        unit = row["statistical_unit_id"]
        if not isinstance(unit, str) or not unit or unit in seen:
            raise ContractError("Development qualification units must be unique")
        seen.add(unit)
        for key in ("parent_score_available", "candidate_score_available",
                    "activation_loaded", "artifact_contract_valid"):
            if type(row[key]) is not bool:
                raise ContractError("Development qualification booleans are invalid")
        for key in ("parent_status", "candidate_status"):
            if row[key] not in _TERMINAL:
                raise ContractError("Development qualification status is not terminal")
        for available_key, score_key in (
                ("parent_score_available", "parent_score"),
                ("candidate_score_available", "candidate_score")):
            score = row[score_key]
            if (row[available_key] and (type(score) not in {int, float}
                                       or not math.isfinite(score))):
                raise ContractError("Available development scores must be finite")
            if not row[available_key] and score is not None:
                raise ContractError("Unavailable development scores must be null")
    usage = value["usage"]
    usage_fields = {"model_calls", "completion_tokens", "tool_calls", "nodes",
                    "usage_complete"}
    if (not isinstance(usage, dict) or set(usage) != usage_fields
            or usage.get("usage_complete") is not True
            or any(type(usage.get(key)) is not int or usage[key] < 0
                   for key in usage_fields - {"usage_complete"})):
        raise ContractError("Development qualification usage is incomplete")
    return value


def assess_qualification(qualification, *, minimum_mean_delta=0.0):
    """Classify viability without opening selection or claiming RSI benefit."""
    failures, deltas = set(), []
    for row in qualification["tasks"]:
        if row["candidate_status"] != "completed":
            failures.add("candidate_execution_failed")
        if not row["activation_loaded"]:
            failures.add("orchestration_not_loaded")
        if not row["artifact_contract_valid"]:
            failures.add("artifact_contract_invalid")
        if not (row["parent_score_available"] and row["candidate_score_available"]):
            failures.add("score_unavailable")
        else:
            deltas.append(row["candidate_score"] - row["parent_score"])
    mean_delta = sum(deltas) / len(deltas) if deltas else None
    if mean_delta is not None and mean_delta < minimum_mean_delta:
        failures.add("development_quality_below_floor")
    return {
        "eligible_for_selection": not failures,
        "failure_codes": sorted(failures),
        "mean_quality_delta": mean_delta,
        "task_count": len(qualification["tasks"]),
        "claim_limit": (
            "Development qualification only; generation count and development "
            "score do not establish orchestration or RSI benefit."),
    }


def repair_brief(attempt, assessment):
    """Project a bounded, task-agnostic repair signal for the next attempt."""
    if type(attempt) is not int or attempt < 1:
        raise ContractError("Repair attempt must be a positive integer")
    return {
        "schema": REPAIR_SCHEMA,
        "prior_attempt": attempt,
        "failure_codes": list(assessment.get("failure_codes") or []),
        "mean_quality_delta": assessment.get("mean_quality_delta"),
        "instruction": (
            "Change executable workflow topology, role assignment, or bounded "
            "orchestration policy. Do not infer hidden answers or evaluator logic."),
    }


class OrchestrationSearchJournal:
    """Append-only, digest-chained storage for search decisions."""

    def __init__(self, store):
        self.store = store
        with store.connect() as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS task_orchestration_search_events(
                    search_id TEXT NOT NULL, sequence INTEGER NOT NULL,
                    data TEXT NOT NULL, digest TEXT NOT NULL,
                    PRIMARY KEY(search_id, sequence))
            """)

    def append(self, search_id, kind, content):
        content = _copy(content, "Search event content")
        with self.store.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            rows = db.execute(
                "SELECT sequence,data,digest FROM task_orchestration_search_events "
                "WHERE search_id=? ORDER BY sequence", (search_id,)).fetchall()
            sequence = len(rows)
            if rows and rows[-1][0] != sequence - 1:
                raise ContractError("Search event sequence is not contiguous")
            previous_digest = rows[-1][2] if rows else None
            body = {"schema": SEARCH_EVENT_SCHEMA, "search_id": search_id,
                    "sequence": sequence, "kind": kind, "content": content,
                    "previous_digest": previous_digest, "created_at": time.time()}
            encoded = json.dumps(body, ensure_ascii=False, sort_keys=True,
                                 separators=(",", ":"), allow_nan=False)
            event_digest = digest(body)
            db.execute("INSERT INTO task_orchestration_search_events VALUES(?,?,?,?)",
                       (search_id, sequence, encoded, event_digest))
        return {**deepcopy(body), "record_digest": event_digest}

    def events(self, search_id):
        with self.store.connect() as db:
            rows = db.execute(
                "SELECT sequence,data,digest FROM task_orchestration_search_events "
                "WHERE search_id=? ORDER BY sequence", (search_id,)).fetchall()
        result, previous = [], None
        for expected, (sequence, encoded, stored_digest) in enumerate(rows):
            event = json.loads(encoded)
            if (sequence != expected or event.get("sequence") != expected
                    or event.get("previous_digest") != previous
                    or digest(event) != stored_digest):
                raise ContractError("Search event chain is invalid")
            result.append({**event, "record_digest": stored_digest})
            previous = stored_digest
        return result

    def open_searches(self, channel, feedback_bundle_id):
        """List incomplete matching searches so a restart fails closed."""
        with self.store.connect() as db:
            identities = [row[0] for row in db.execute(
                "SELECT DISTINCT search_id FROM task_orchestration_search_events"
            ).fetchall()]
        opened = []
        for identity in identities:
            events = self.events(identity)
            if not events or events[0]["kind"] != "started":
                continue
            content = events[0]["content"]
            if (content.get("channel") == channel
                    and content.get("feedback_bundle_id") == feedback_bundle_id
                    and events[-1]["kind"] != "finished"):
                opened.append(identity)
        return sorted(opened)

    def finalize_failed(self, search_id, failure):
        """Close one interrupted intent from host-reconciled evidence.

        This never resumes or repeats work. The caller must supply the plan and
        Episode evidence already observed by the host.
        """
        events = self.events(search_id)
        if (not events or events[-1]["kind"] != "attempt_started"
                or any(event["kind"] == "finished" for event in events)):
            raise ContractError("Only one open attempt intent can be reconciled")
        failure = _copy(failure, "Reconciled search failure")
        required = {"failure_type", "evidence_refs", "episode_statuses", "usage"}
        if not isinstance(failure, dict) or not required <= set(failure):
            raise ContractError("Reconciled search failure is incomplete")
        usage = failure["usage"]
        if (not isinstance(usage, dict)
                or set(usage) != {"model_calls", "completion_tokens", "tool_calls",
                                  "nodes", "usage_complete"}
                or any(type(usage.get(key)) is not int or usage[key] < 0
                       for key in ("model_calls", "completion_tokens", "tool_calls", "nodes"))
                or type(usage.get("usage_complete")) is not bool):
            raise ContractError("Reconciled search usage is invalid")
        intent = events[-1]["content"]
        matches = []
        try:
            with self.store.connect() as db:
                rows = db.execute(
                    "SELECT data,digest FROM task_candidate_generations").fetchall()
            for encoded, stored_digest in rows:
                record = json.loads(encoded)
                if digest(record) != stored_digest:
                    raise ContractError("Candidate generation record digest mismatch")
                improver = self.store.package(record.get("improver_package_id"))
                if (improver.get("provenance") or {}).get(
                        "search_attempt_id") == intent["attempt_id"]:
                    matches.append(record)
        except ContractError:
            raise
        except Exception:
            matches = []
        generation_usage = {"model_calls": 0, "completion_tokens": 0,
                            "tool_calls": 0, "nodes": 0}
        if len(matches) == 1:
            observed = matches[0].get("usage") or {}
            if observed.get("usage_complete") is not True:
                raise ContractError(
                    "Attempt-bound candidate generation usage is incomplete")
            generation_usage = {
                "model_calls": observed.get("model_calls", 0),
                "completion_tokens": observed.get(
                    "charged_completion_tokens", observed.get("completion_tokens", 0)),
                "tool_calls": observed.get(
                    "charged_tool_calls", observed.get("tool_calls", 0)),
                "nodes": observed.get("nodes", 0),
            }
            failure["generation_refs"] = {
                "generation_id": matches[0].get("id"),
                "candidate_id": matches[0].get("candidate_id")}
        else:
            raise ContractError(
                "Reconciliation requires exactly one attempt-bound generation record")

        plan_id = (failure.get("evidence_refs") or {}).get("plan_id")
        if not isinstance(plan_id, str) or not plan_id:
            raise ContractError("Reconciliation requires one development plan")
        with self.store.connect() as db:
            plan_row = db.execute(
                "SELECT data,digest FROM task_evolution_plans WHERE id=?",
                (plan_id,)).fetchone()
        if plan_row is None:
            raise ContractError("Reconciled development plan is absent")
        plan = json.loads(plan_row[0])
        if digest(plan) != plan_row[1]:
            raise ContractError("Reconciled development plan digest mismatch")
        started = events[0]["content"]
        generation = matches[0]
        expected = {
            "candidate_id": generation.get("candidate_id"),
            "channel": generation.get("channel"),
            "parent_package_id": generation.get("parent_package_id"),
            "parent_package_digest": generation.get("parent_package_digest"),
            "package_id": generation.get("candidate_package_id"),
            "package_digest": generation.get("candidate_package_digest"),
        }
        if (generation.get("status") != "generated"
                or generation.get("feedback_bundle_id")
                   != started.get("feedback_bundle_id")
                or generation.get("channel") != started.get("channel")
                or any(plan.get(key) != value for key, value in expected.items())
                or plan.get("split_role") != "development"
                or (plan.get("suite") or {}).get("split_role") != "development"):
            raise ContractError(
                "Reconciled plan is not bound to this search generation")

        trial_id = (failure.get("evidence_refs") or {}).get("trial_id")
        with self.store.connect() as db:
            claim = db.execute(
                "SELECT status,record_id FROM task_evolution_run_claims "
                "WHERE kind='paired' AND plan_id=?", (plan_id,)).fetchone()
            trial_row = (None if trial_id is None else db.execute(
                "SELECT data,digest FROM task_evolution_trials WHERE id=?",
                (trial_id,)).fetchone())
        if trial_id is None:
            if claim is not None and claim[0] == "completed":
                raise ContractError(
                    "Completed paired claim requires its immutable trial id")
        else:
            if not isinstance(trial_id, str) or not trial_id or trial_row is None:
                raise ContractError("Reconciled trial is absent")
            trial = json.loads(trial_row[0])
            if (digest(trial) != trial_row[1]
                    or trial.get("plan_id") != plan_id
                    or claim != ("completed", trial_id)):
                raise ContractError("Reconciled trial is not bound to the plan")

        episode_states = {}
        for state in self.store.list():
            registration = (state.get("task", {}).get("context", {}).get(
                "evolution_registration") or {})
            if registration.get("plan_id") == plan_id:
                episode_states[state["id"]] = state
        supplied_ids = (failure.get("evidence_refs") or {}).get("episode_ids")
        if (not isinstance(supplied_ids, list)
                or set(supplied_ids) != set(episode_states)
                or failure.get("episode_statuses") != {
                    identity: state.get("status")
                    for identity, state in episode_states.items()}):
            raise ContractError(
                "Reconciled Episode evidence does not match the frozen plan")
        measured = {"model_calls": 0, "completion_tokens": 0,
                    "tool_calls": 0, "nodes": 0, "usage_complete": True}
        for identity, state in episode_states.items():
            # Episode state intentionally does not denormalize the live call
            # ledger. Recompute exactly as TaskService.get_private() does;
            # using state.get("usage") here would silently read an empty/stale
            # projection after model receipts were committed.
            item = self.store.usage(identity)
            measured["model_calls"] += item.get("model_calls", 0)
            measured["completion_tokens"] += item.get(
                "charged_completion_tokens", item.get("completion_tokens", 0))
            measured["tool_calls"] += item.get(
                "charged_tool_calls", item.get("tool_calls", 0))
            measured["nodes"] += item.get("nodes", 0)
            if (item.get("usage_complete") is not True
                    or state.get("status") not in _TERMINAL):
                measured["usage_complete"] = False
        if measured != failure["usage"]:
            raise ContractError(
                "Reconciled usage differs from the plan-bound Episode ledger")
        total_usage = {key: usage[key] + generation_usage[key]
                       for key in generation_usage}
        content = {"attempt": intent["attempt"],
                   "attempt_id": intent["attempt_id"],
                   "failure": {**failure, "phase": "development_qualification",
                               "retry_safe": False},
                   "usage": total_usage}
        self.append(search_id, "attempt_failed", content)
        final = {"qualified_candidate_ids": [], "qualified_count": 0,
                 "usage": deepcopy(content["usage"]), "status": "failed",
                 "failure_phase": "development_qualification",
                 "selection_opened": False, "retry_safe": False,
                 "claim_limit": (
                     "Host-reconciled missing evidence; the attempt and its "
                     "development units must not be retried.")}
        self.append(search_id, "finished", final)
        return {"id": search_id, **final, "events": self.events(search_id)}


class BoundedOrchestrationSearch:
    """Coordinate bounded generation/repair attempts before selection.

    ``generate`` receives ``(attempt, attempt_id, repair, remaining_budget)`` and must
    return one immutable GenerationService record. ``qualify`` receives
    ``(candidate, remaining_budget)`` and must run fresh development tasks,
    returning the strict public qualification schema above.
    """

    def __init__(self, tasks, evolution, generation):
        self.tasks = tasks
        self.evolution = evolution
        self.generation = generation
        self.journal = OrchestrationSearchJournal(tasks.store)

    @staticmethod
    def _policy(value):
        value = _copy(value, "Search policy")
        fields = {"max_attempts", "target_qualified", "minimum_mean_delta",
                  "max_model_calls", "max_completion_tokens", "max_tool_calls",
                  "max_nodes"}
        if (not isinstance(value, dict) or set(value) != fields
                or type(value["max_attempts"]) is not int
                or not 1 <= value["max_attempts"] <= 16
                or type(value["target_qualified"]) is not int
                or not 1 <= value["target_qualified"] <= value["max_attempts"]
                or type(value["minimum_mean_delta"]) not in {int, float}
                or not math.isfinite(value["minimum_mean_delta"])
                or any(type(value[key]) is not int or value[key] < 0
                       for key in fields - {"max_attempts", "target_qualified",
                                            "minimum_mean_delta"})):
            raise ContractError("Search policy is invalid")
        return value

    @staticmethod
    def _usage(record):
        usage = (record or {}).get("usage") or {}
        return {
            "model_calls": usage.get("model_calls", 0),
            "completion_tokens": usage.get(
                "charged_completion_tokens", usage.get("completion_tokens", 0)),
            "tool_calls": usage.get("charged_tool_calls", usage.get("tool_calls", 0)),
            "nodes": usage.get("nodes", 0),
        }

    @staticmethod
    def _add_usage(total, addition):
        for key in total:
            value = addition.get(key)
            if type(value) is not int or value < 0:
                raise ContractError("Search usage is invalid")
            total[key] += value

    @staticmethod
    def _remaining(policy, usage):
        return {
            "model_calls": policy["max_model_calls"] - usage["model_calls"],
            "completion_tokens": policy["max_completion_tokens"] - usage["completion_tokens"],
            "tool_calls": policy["max_tool_calls"] - usage["tool_calls"],
            "nodes": policy["max_nodes"] - usage["nodes"],
        }

    def run(self, channel, feedback_bundle_id, expected_revision, policy, *,
            generate, qualify, search_id=None):
        if not callable(generate) or not callable(qualify):
            raise TypeError("Search generation and qualification must be callable")
        policy = self._policy(policy)
        if search_id is not None and (
                not isinstance(search_id, str) or not search_id
                or len(search_id) > 200
                or not search_id.startswith("orchestration-search-")):
            raise ContractError("Caller-owned search id is invalid")
        active = self.evolution.active(channel)
        feedback = self.generation.feedback(feedback_bundle_id)
        if (active["revision"] != expected_revision
                or feedback["channel"] != channel
                or feedback["channel_revision"] != expected_revision
                or feedback["parent_package_digest"] != active["package_digest"]):
            raise ContractError("Search parent or feedback revision is stale")
        binding = {
            "schema": SEARCH_SCHEMA, "channel": channel,
            "channel_revision": expected_revision,
            "feedback_bundle_id": feedback_bundle_id,
            "parent_package_digest": active["package_digest"], "policy": policy,
        }
        if search_id is not None:
            prior = self.journal.events(search_id)
            if prior:
                if (prior[0]["kind"] != "started"
                        or prior[0]["content"] != binding):
                    raise ContractError(
                        "Caller-owned search id is bound to different frozen inputs")
                finished = [event for event in prior if event["kind"] == "finished"]
                if len(finished) == 1 and prior[-1]["kind"] == "finished":
                    return {"id": search_id, **deepcopy(finished[0]["content"]),
                            "events": prior}
                raise ContractError(
                    "Caller-owned search is unfinished; reconcile its open attempt "
                    "before spending again")
        unfinished = self.journal.open_searches(channel, feedback_bundle_id)
        if unfinished:
            raise ContractError(
                "An earlier orchestration search is unfinished; reconcile its "
                "attempt intent before spending again: " + ",".join(unfinished))
        search_id = search_id or _id("orchestration-search")
        total = {"model_calls": 0, "completion_tokens": 0,
                 "tool_calls": 0, "nodes": 0}
        qualified, seen_packages, repair = [], set(), None
        self.journal.append(search_id, "started", binding)

        def terminal_failure(attempt_event, phase, exc):
            if isinstance(exc, DevelopmentQualificationError):
                failure = deepcopy(exc.failure)
            else:
                failure = {
                    "failure_type": type(exc).__name__,
                    "evidence_refs": {"plan_id": None, "trial_id": None,
                                      "episode_ids": []},
                    "usage": {"model_calls": 0, "completion_tokens": 0,
                              "tool_calls": 0, "nodes": 0,
                              "usage_complete": False},
                }
            failure.update(phase=phase, retry_safe=False)
            observed = failure.get("usage") or {}
            try:
                self._add_usage(total, observed)
            except ContractError:
                # The receipt remains explicit that cost is unknown rather
                # than replacing one failure with an unjournalled exception.
                failure["usage"] = {"model_calls": 0, "completion_tokens": 0,
                                    "tool_calls": 0, "nodes": 0,
                                    "usage_complete": False}
            attempt_event.update(failure=failure, usage=deepcopy(total))
            self.journal.append(search_id, "attempt_failed", attempt_event)
            final = {"qualified_candidate_ids": list(qualified),
                     "qualified_count": len(qualified), "usage": deepcopy(total),
                     "status": "failed", "failure_phase": phase,
                     "selection_opened": False,
                     "retry_safe": False,
                     "claim_limit": (
                         "The attempt ended without a scored development outcome; "
                         "its statistical units and external calls must not be retried.")}
            self.journal.append(search_id, "finished", final)
            return {"id": search_id, **deepcopy(final),
                    "events": self.journal.events(search_id)}

        for attempt in range(1, policy["max_attempts"] + 1):
            remaining = self._remaining(policy, total)
            if min(remaining.values()) < 0 or remaining["model_calls"] == 0:
                break
            attempt_id = f"{search_id}/attempt-{attempt}"
            self.journal.append(search_id, "attempt_started", {
                "attempt": attempt, "attempt_id": attempt_id,
                "remaining_budget": deepcopy(remaining),
                "repair_input": deepcopy(repair),
                "repair_digest": digest(repair),
                "recovery": (
                    "Intent is durable before generation. Automatic replay is forbidden "
                    "until its GenerationService record is reconciled."),
            })
            try:
                result = generate(
                    attempt, attempt_id, deepcopy(repair), deepcopy(remaining))
            except (Exception, CapabilityAbort) as exc:
                return terminal_failure(
                    {"attempt": attempt, "attempt_id": attempt_id,
                     "repair_input": deepcopy(repair)}, "generation", exc)
            stored = self.generation.generation(result.get("id"))
            if {key: value for key, value in result.items() if key != "record_digest"} != {
                    key: value for key, value in stored.items() if key != "record_digest"}:
                raise ContractError("Search generator did not return its immutable record")
            if (stored.get("channel") != channel
                    or stored.get("feedback_bundle_id") != feedback_bundle_id
                    or stored.get("channel_revision") != expected_revision):
                raise ContractError("Search generation crossed its frozen parent")
            self._add_usage(total, self._usage(stored))
            remaining = self._remaining(policy, total)
            if min(remaining.values()) < 0:
                raise ContractError("Search generation exceeded the frozen total budget")
            event = {"attempt": attempt, "attempt_id": attempt_id,
                     "generation_id": stored["id"],
                     "generation_status": stored.get("status"),
                     "usage": deepcopy(total), "repair_input": deepcopy(repair)}
            if stored.get("status") != "generated":
                assessment = {"eligible_for_selection": False,
                              "failure_codes": ["generation_" +
                                                (stored.get("reason_type") or "missing")],
                              "mean_quality_delta": None, "task_count": 0,
                              "claim_limit": "No candidate was generated."}
                event["assessment"] = assessment
                self.journal.append(search_id, "attempt_finished", event)
                repair = repair_brief(attempt, assessment)
                continue
            candidate = self.evolution.candidate(stored["candidate_id"])
            self.evolution._verify_generated_candidate(candidate)
            if candidate.get("targeting") != "manifest_component_set_v3":
                raise ContractError("Orchestration search only accepts PackagePatch v3")
            child = self.tasks.store.package(candidate["package_id"])
            delta = orchestration_delta(active["package"], child)
            event.update(candidate_id=candidate["id"],
                         candidate_package_digest=candidate["package_digest"],
                         orchestration_delta=delta)
            if candidate["package_digest"] in seen_packages:
                assessment = {"eligible_for_selection": False,
                              "failure_codes": ["duplicate_candidate"],
                              "mean_quality_delta": None, "task_count": 0,
                              "claim_limit": "Duplicate generation is not search progress."}
            elif not delta["changed"]:
                assessment = {"eligible_for_selection": False,
                              "failure_codes": ["no_executable_orchestration_delta"],
                              "mean_quality_delta": None, "task_count": 0,
                              "claim_limit": "S-only changes are not O search."}
            else:
                seen_packages.add(candidate["package_digest"])
                try:
                    raw = qualify(candidate, deepcopy(remaining))
                    qualification = normalize_qualification(candidate["id"], raw)
                    self._add_usage(total, qualification["usage"])
                    if min(self._remaining(policy, total).values()) < 0:
                        raise ContractError(
                            "Development qualification exceeded the frozen total budget")
                except (Exception, CapabilityAbort) as exc:
                    return terminal_failure(event, "development_qualification", exc)
                assessment = assess_qualification(
                    qualification, minimum_mean_delta=policy["minimum_mean_delta"])
                event["qualification"] = qualification
                if assessment["eligible_for_selection"]:
                    qualified.append(candidate["id"])
            event["assessment"] = assessment
            event["usage"] = deepcopy(total)
            self.journal.append(search_id, "attempt_finished", event)
            if len(qualified) >= policy["target_qualified"]:
                break
            repair = repair_brief(attempt, assessment)
        final = {"qualified_candidate_ids": qualified,
                 "qualified_count": len(qualified), "usage": total,
                 "status": "qualified" if len(qualified) >= policy["target_qualified"]
                 else "exhausted",
                 "selection_opened": False,
                 "claim_limit": (
                     "Candidates are only eligible for an independent selection run; "
                     "this search does not establish benefit.")}
        self.journal.append(search_id, "finished", final)
        return {"id": search_id, **deepcopy(final),
                "events": self.journal.events(search_id)}
