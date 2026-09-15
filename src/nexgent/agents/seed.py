"""Bootstrap research programs. Every returned source is inherited and editable."""

from copy import deepcopy
import json


WORKFLOW_SOURCE = '''def inspect_source_proposal(design, parent_files, allowed):
    check = {"issues": [], "changed_files": [], "unchanged_files_omitted": [], "anchors": [],
             "verification_scope": "Exact source differences and lexical anchors only; semantic mechanisms and scientific gains are unverified."}
    proposals = design.get("candidates", [])
    if not isinstance(proposals, list) or len(proposals) != 1 or not isinstance(proposals[0], dict):
        check["issues"].append("Return exactly one candidate object")
        return None, check
    proposed = proposals[0]
    files = proposed.get("files", {})
    if not isinstance(files, dict):
        check["issues"].append("files must map allowed names to complete source strings")
        return None, check
    changed = {}
    for name, source in files.items():
        if not isinstance(source, str):
            check["issues"].append("Source must be text: " + str(name))
        elif source == parent_files.get(name):
            check["unchanged_files_omitted"].append(name)
        elif name not in allowed:
            check["issues"].append("File is frozen in this experiment: " + str(name))
        else:
            changed[name] = source
            old_lines = parent_files.get(name, "").split("\\n")
            new_lines = source.split("\\n")
            check["changed_files"].append({"file": name,
                "old_characters": len(parent_files.get(name, "")), "new_characters": len(source),
                "added_line_examples": [line[:240] for line in new_lines if line.strip() and line not in old_lines][:8],
                "removed_line_examples": [line[:240] for line in old_lines if line.strip() and line not in new_lines][:8]})
    if not changed:
        check["issues"].append("no_source_changes: all returned source is identical to the actual parent")
    for field in ["rationale", "hypothesis"]:
        if not isinstance(proposed.get(field), str) or not proposed[field].strip():
            check["issues"].append("Missing nonempty " + field)
    evidence = proposed.get("code_evidence", [])
    anchored = []
    if not isinstance(evidence, list):
        evidence = []
    for anchor in evidence[:12]:
        if not isinstance(anchor, dict):
            check["issues"].append("code_evidence entries must be objects")
            continue
        name, fragment, mechanism = anchor.get("file"), anchor.get("new_code"), anchor.get("mechanism")
        valid = isinstance(name, str) and name in changed and isinstance(fragment, str) and bool(fragment.strip())
        valid = valid and isinstance(mechanism, str) and bool(mechanism.strip())
        valid = valid and fragment in changed[name] and fragment not in parent_files.get(name, "")
        check["anchors"].append({"file": name, "new_code": fragment, "mechanism_claim": mechanism, "lexically_valid": valid})
        if valid:
            anchored.append(name)
        else:
            check["issues"].append("Mechanism anchor does not identify new source: " + str(name))
    for name in changed:
        if name not in anchored:
            check["issues"].append("Missing a new exact code_evidence fragment for changed file: " + name)
    candidate = {"files": changed, "rationale": proposed.get("rationale", ""),
                 "hypothesis": proposed.get("hypothesis", ""), "code_evidence": evidence}
    return candidate, check

def experiment_issues(report, baseline, budget):
    issues = []
    if report.get("status") != "ok":
        issues.append("development_status=" + str(report.get("status", "missing")))
    if report.get("score_available") is False or report.get("failure_kind") or report.get("error"):
        issues.append("Development has missing evidence or an explicit failure")
    failed = [row for row in report.get("tasks", []) if row.get("status") != "ok" or row.get("error") or row.get("score_available") is False]
    if failed:
        issues.append("Unsuccessful or unmeasured task count: " + str(len(failed)))
    score, old_score = report.get("score"), baseline.get("score")
    work, old_work = report.get("work_units"), baseline.get("work_units")
    if isinstance(score, (int, float)) and isinstance(old_score, (int, float)):
        if score < old_score:
            issues.append("Measured development score regressed against the parent")
        if isinstance(work, (int, float)) and isinstance(old_work, (int, float)) and old_work > 0:
            if work > 1.25 * old_work and score <= old_score:
                issues.append("Measured work increased by over 25 percent without a score gain")
    limit = budget.get("max_work_units_per_evaluation")
    if isinstance(work, (int, float)) and isinstance(limit, (int, float)) and work >= 0.9 * limit:
        issues.append("Measured work used at least 90 percent of the shared evaluation budget")
    return issues

def run_development(candidate, broker, label):
    try:
        return broker.experiment(candidate["files"], label)
    except Exception as failure:
        return {"status": "failed", "score_available": False, "error": str(failure),
                "limitation": "The experiment failed; no successful measurement is claimed."}

def measured_quality(report):
    if report.get("status") != "ok" or report.get("score_available") is False or report.get("error") or report.get("failure_kind"):
        return None
    score = report.get("score")
    if not isinstance(score, (int, float)) or not math.isfinite(score):
        return None
    if any(row.get("status") != "ok" or row.get("score_available") is False or row.get("error") for row in report.get("tasks", [])):
        return None
    return score

def research_cycle(context, broker):
    roles = context.get("roles", {})
    parent = context.get("parent", {})
    budget = context.get("budget", {})
    remaining_calls = budget.get("remaining_calls", 4)
    remaining_tokens = budget.get("remaining_completion_tokens", 16400)
    plan = {"initial_calls": 3, "initial_completion_reservation": 10400,
            "repair_calls": 1, "repair_completion_reservation": 6000,
            "repair_reserved": remaining_calls >= 4 and remaining_tokens >= 16400,
            "scope": "Agent-side allocation; the host durably admits each actual request."}
    research = {"hypotheses": [], "source_checks": [], "development_experiments": [], "revisions": [],
                "budget_plan": plan, "repair": {"status": "not_needed", "maximum_attempts": 1},
                "limitation": "Source anchors do not verify semantic claims. Development trials are not held-out evidence; independent tests decide gains."}
    if remaining_calls < 3 or remaining_tokens < 10400:
        research["repair"]["status"] = "insufficient_initial_budget"
        broker.log("research_budget", research)
        return {"candidates": [], "research": research}
    broker.log("research_budget", plan)
    query = context.get("literature_query", "dynamical systems sparse identification")
    literature = broker.search(query)
    research["literature"] = literature
    broker.log("literature", literature)
    evidence_payload = {
        "question": context.get("question", "Discover reproducible scientific dynamics"),
        "development": context.get("development", {}),
        "failures": context.get("failures", []),
        "archive": context.get("archive", []),
        "parent": {"id": parent.get("id"), "generation": parent.get("generation"),
                   "files": parent.get("files", {}), "component_digests": parent.get("component_digests", {})},
        "tool_api": context.get("tool_api", ""),
        "editable_components": context.get("editable_components", ["task.py", "meta.py", "workflow.py", "roles.json"]),
        "literature": literature,
        "budget": budget, "budget_plan": plan
    }
    analyses = broker.parallel([
        {"role": "mechanism_researcher", "prompt": roles.get("mechanism_researcher", "Analyze scientific and software failure mechanisms."),
         "payload": evidence_payload, "max_tokens": 2200},
        {"role": "experimental_critic", "prompt": roles.get("experimental_critic", "Design experiments that could disprove the proposed mechanisms."),
         "payload": evidence_payload, "max_tokens": 2200}
    ])
    research["hypotheses"] = analyses
    broker.log("hypotheses", analyses)
    design_payload = {
        "question": evidence_payload["question"],
        "parent": evidence_payload["parent"],
        "tool_api": evidence_payload["tool_api"],
        "editable_components": evidence_payload["editable_components"],
        "development": evidence_payload["development"],
        "archive": evidence_payload["archive"],
        "analyses": analyses, "literature": literature,
        "runtime_contract": context.get("runtime_contract", ""),
        "budget": budget, "budget_plan": plan
    }
    design = broker.ask("main", roles.get("source_designer", "Return candidate source replacements and research rationale."),
                        design_payload, max_tokens=6000)
    research["design"] = design.get("research", {})
    candidate, check = inspect_source_proposal(design, parent.get("files", {}), evidence_payload["editable_components"])
    research["source_checks"].append({"stage": "design", "check": check})
    broker.log("source_check", research["source_checks"][-1])
    issues = check["issues"].copy()
    selected, selected_trial = None, {}
    if not issues:
        trial = run_development(candidate, broker, "Test the proposed source against development observations")
        research["development_experiments"].append({"stage": "design", "report": trial, "changed_files": list(candidate["files"])})
        broker.log("experiment", research["development_experiments"][-1])
        issues.extend(experiment_issues(trial, evidence_payload["development"], budget))
        selected, selected_trial = candidate, trial
    if issues and plan["repair_reserved"]:
        research["repair"] = {"status": "attempted", "maximum_attempts": 1, "triggered_by": issues}
        repair_payload = design_payload.copy()
        repair_payload.update({"phase": "targeted_source_repair", "previous_candidate": candidate,
            "actual_source_check": check, "actual_development_report": selected_trial,
            "repair_triggers": issues, "remaining_repair_calls": 1,
            "instruction": "Use actual source differences and measured status/failures/work, not claimed success. Return one repaired candidate as complete changed files relative to the ORIGINAL parent. Keep every earlier edit you intend to retain. A no-op needs a real source change. Do not increase loops to hide budget failure; implement bounded adaptive search and preserve the best available model."})
        repair_payload["budget"] = budget.copy()
        repair_payload["budget"].update(remaining_calls=1, remaining_completion_tokens=6000)
        repaired = broker.ask("main", roles.get("source_designer", "Return one targeted source repair with code_evidence."),
                              repair_payload, max_tokens=6000)
        revised, revised_check = inspect_source_proposal(repaired, parent.get("files", {}), evidence_payload["editable_components"])
        research["source_checks"].append({"stage": "repair", "check": revised_check})
        research["revisions"].append({"research": repaired.get("research", {}), "candidate": revised})
        broker.log("source_check", research["source_checks"][-1])
        if revised_check["issues"]:
            research["repair"].update(status="invalid_repair", unresolved=revised_check["issues"])
        elif selected is not None and candidate is not None and revised["files"] == candidate["files"]:
            research["repair"].update(status="repair_noop", unresolved=["Repair repeated the already tested candidate; no new experiment or gain is claimed"])
        else:
            revised_trial = run_development(revised, broker, "Retest the targeted source repair on development observations")
            research["development_experiments"].append({"stage": "repair", "report": revised_trial, "changed_files": list(revised["files"])})
            broker.log("experiment", research["development_experiments"][-1])
            unresolved = experiment_issues(revised_trial, evidence_payload["development"], budget)
            research["repair"].update(status="evaluated", unresolved=unresolved)
            before, after = measured_quality(selected_trial), measured_quality(revised_trial)
            if selected is None or before is None or (after is not None and after >= before):
                selected, selected_trial = revised, revised_trial
            research["repair"]["selection_rule"] = "Prefer a fully measured higher development score; ties prefer the revised source. If neither has a complete measurement, retain the latest validated source without claiming a gain."
    elif issues:
        research["repair"] = {"status": "insufficient_reserved_budget", "maximum_attempts": 1, "triggered_by": issues}
    research["selected_development"] = selected_trial
    research["selected_changed_files"] = list(selected["files"]) if selected is not None else []
    broker.log("research_result", research)
    return {"candidates": [selected] if selected is not None else [], "research": research}
'''

META_SOURCE = '''def improve(context, broker):
    return research_cycle(context, broker)

def select_parent(archive):
    # Initial engineering exploration hypothesis, not evidence of innovation:
    # give unexpanded programs a chance even when their task score is missing.
    if not archive:
        return None
    best = archive[0]
    best_priority = (best.get("score") or 0.0) + 2.0 / (1 + best.get("children", 0))
    for node in archive[1:]:
        priority = (node.get("score") or 0.0) + 2.0 / (1 + node.get("children", 0))
        if priority > best_priority:
            best = node
            best_priority = priority
    return best.get("id")
'''

ROLES = {
    "mechanism_researcher": (
        "You are investigating failures of a scientific-discovery agent AND its source-level improver. "
        "Read the supplied primary-literature excerpts, observed development results and current source. "
        "Separate observations from hypotheses; cite only supplied paper URLs and accurately state whether only an abstract/excerpt was read. "
        "Identify a mechanism-level algorithm or control-flow change, including how the improver itself could better design future changes. "
        "Diagnose the actual batch budget: 8 development or 12 transfer tasks share a numerical work limit. "
        "Expanding candidate loops can exhaust later tasks even when an individual task fits well. "
        "Distinguish missing resource-limited scores from measured low scientific scores. "
        'Return JSON with arrays: {"observations":["text"],"mechanisms":["text"],"predictions":["text"],"sources":["URL"],"limits":["text"]}. '
        "Use at most four concise statements per field. Do not claim experiments that have not run."
    ),
    "experimental_critic": (
        "Independently inspect the supplied science-agent source and development evidence. "
        "Challenge causal assumptions, hidden-data dependence, numerical instability and changes that merely tune constants. "
        "Design cheap discriminating experiments, a strong unchanged-code control, and one falsification condition for a substantive software change. "
        "Inspect top-level and per-task status/failure_kind/score_available and work_units, not only an error string. "
        "Challenge claims unsupported by changed functions and exact new code. Model rhetoric is not measured gain. "
        "You may critique the current improvement/workflow algorithm and suggest a new allocation of research roles. "
        'Return JSON with arrays: {"counterhypotheses":["text"],"experiments":["text"],"code_failures":["text"],"limits":["text"]}. '
        "Use at most four concise statements per field."
    ),
    "source_designer": (
        "Implement scientific-agent self-improvement in source code. The parent contains the ACTUAL source files that will execute next. "
        "Use the supplied numerical Tool API exactly. You may add functions, loops, new symbolic terms, continuous choices, "
        "model comparison algorithms, diagnostics and control flow. You may rewrite task.py, meta.py, workflow.py and roles.json, "
        "including adding/reorganizing internal functions. This is not a policy enum or choice table. "
        "The supplied editable_components is the allowed file list for THIS experiment. If only task.py is listed, "
        "change task.py only and keep the parent meta/workflow/roles intact; analyze mechanisms within that control arm. "
        "The task entry is solve(problem, tools); the meta entry is improve(context, broker); select_parent(archive) is optional. "
        "Files share a restricted global namespace. Use no imports, reflection, files, network or subprocesses. "
        "Tools/broker provide capabilities; source code chooses their ordering and composition. "
        "Broker calls are ask(role,prompt,payload,max_tokens=6000), parallel([{role,prompt,payload,max_tokens}]), "
        "experiment(files,label), search(query), log(kind,content). Use normal Python arguments with these exact signatures. "
        "Keep runtime and numerical output contracts valid. All candidate files inherit unchanged parent files automatically. "
        "Return exactly one thoughtful candidate containing FULL replacement file contents as JSON strings, not diffs or markdown. "
        "Use concise source and explanations within this response budget; omit unchanged files. "
        "Every candidate also needs code_evidence: an array with file, new_code (an exact short new source fragment), "
        "and mechanism (the falsifiable mechanism claim). Include an anchor for EACH changed file. "
        "The new_code must occur in the complete replacement and must not occur in that parent's file. "
        "These lexical anchors document a change; they do not establish semantic novelty or scientific success. "
        "Implement a mechanism-level task improvement and, when justified by diagnosed failures, a substantive change to the executable "
        "meta/workflow code so its successor will actually use the revised improvement process. Explain both mechanisms and their falsification tests. "
        "Do not make cosmetic edits to claim meta improvement; if no justified meta change exists, state that limitation. "
        "New roles, changed collaboration, alternative source-generation strategies and experiment-before-patch logic are allowed. "
        "Respect the provided budget. Never invent measured results, special-case task IDs, expose test data, change evaluator or budget enforcement. "
        "A batch of 8 development or 12 transfer tasks SHARES the numerical limit, typically 20 million work units. "
        "Each solve receives problem['numerical_budget'] with batch_limit, work_at_start, batch_remaining, remaining_tasks, "
        "and recommended_limit (remaining budget divided by remaining tasks). tools.work_units is the actual cumulative "
        "consumption and increases during this solve; track the difference from work_at_start. "
        "Use measured costs to stop search adaptively before exhausting the task allocation, preserve a fitted best model, "
        "and leave work for the remaining tasks. Allow headroom for another fit/validation operation; catching exhaustion "
        "after spending the entire batch is not a budget strategy. Increasing loop_count or silently skipping failed tasks "
        "is not a budget repair. Design efficient numerical control flow in source; the host supplies no scientific algorithm. "
        "On targeted_source_repair, revise the actual faulty source using supplied status, per-task failures, observed work "
        "and source differences. A missing or zero resource sentinel is not a successful observation. Keep within the one "
        "reserved repair call, return full changed files relative to the original parent, and do not claim the repair works before its experiment. "
        "The root JSON has candidates and research. Each candidate has files (filename to full source), rationale (nonempty string), "
        "hypothesis (nonempty string). research contains mechanism, expected_observation, falsification and cited_sources. "
        "Include task.py when its implementation changes; include complete changed meta.py/workflow.py when changing the "
        "improvement mechanism. Return only files whose content differs from the parent; no-op code is rejected."
    ),
}


def seed_files(task_files=None):
    if task_files is None:
        from ..science import seed_task_files
        task_files = seed_task_files()
    files = deepcopy(task_files)
    files.update({"workflow.py": WORKFLOW_SOURCE, "meta.py": META_SOURCE,
                  "roles.json": json.dumps(ROLES, ensure_ascii=False, indent=2)})
    return files
