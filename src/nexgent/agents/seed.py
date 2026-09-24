"""Bootstrap research programs. Every returned source is inherited and editable."""

from copy import deepcopy
import json


WORKFLOW_SOURCE = '''def source_without_comments(source):
    # A lexical audit, not a proof of semantic equivalence. Preserve strings and indentation.
    result, quote, triple, escaped, comment = [], "", False, False, False
    index = 0
    while index < len(source):
        char = source[index]
        if char == "\\n" and not quote:
            comment = False
            last = len(result) - 1
            while last >= 0 and result[last] in [" ", "\\t", "\\r"]:
                last -= 1
            if last < 0 or result[last] == "\\n":
                result = result[:last + 1]
            else:
                result.append(char)
            index += 1
            continue
        if comment:
            if char == "\\n":
                comment = False
                result.append(char)
        elif quote:
            result.append(char)
            if escaped:
                escaped = False
            elif char == chr_backslash():
                escaped = True
            elif triple and source[index:index + 3] == quote * 3:
                result.extend([quote, quote])
                index += 2
                quote, triple = "", False
            elif not triple and char == quote:
                quote = ""
        elif char == "#":
            comment = True
        elif char in ["'", '"']:
            quote = char
            triple = source[index:index + 3] == char * 3
            result.append(char)
            if triple:
                result.extend([char, char])
                index += 2
        else:
            result.append(char)
        index += 1
    return "".join(result)

def chr_backslash():
    return "\\\\"

def revision_difference(revised, previous):
    if previous is None:
        return {"changed_files": list(revised["files"]), "comments_only_or_identical": False}
    names = set(revised["files"]) | set(previous["files"])
    changed = [name for name in names if source_without_comments(revised["files"].get(name, "")) != source_without_comments(previous["files"].get(name, ""))]
    return {"changed_files": sorted(changed), "comments_only_or_identical": not changed,
            "scope": "Comment-aware lexical comparison against the just-tested proposal; not semantic equivalence."}

def inspect_source_proposal(design, parent_files, allowed):
    check = {"issues": [], "changed_files": [], "unchanged_files_omitted": [], "anchors": [],
             "verification_scope": "Exact source differences and lexical anchors only; semantic mechanisms and measured gains are unverified."}
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
            if name.endswith(".py") and source_without_comments(source) == source_without_comments(parent_files.get(name, "")):
                check["issues"].append("comment_only_source_change: " + name)
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

def prepare_literature_query(context, domain):
    # The research question remains intact; only the bounded search request is shortened.
    options = [("literature_query", context.get("literature_query")),
               ("domain.literature_query", domain.get("literature_query")),
               ("question", context.get("question")),
               ("default", "source code recursive self improvement agents")]
    for origin, raw in options:
        if isinstance(raw, str) and raw.strip():
            normalized = " ".join(raw.split())
            return {"query": normalized[:400].strip(), "source": origin,
                    "input_characters": len(raw), "normalized_characters": len(normalized),
                    "limit_characters": 400, "truncated": len(normalized) > 400}

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
    domain = context.get("domain", {})
    query = prepare_literature_query(context, domain)
    research["literature_query"] = query
    broker.log("literature_query", query)
    literature = {"registered": context.get("literature", []), "retrieved": broker.search(query["query"])}
    research["literature"] = literature
    broker.log("literature", literature)
    evidence_payload = {
        "question": context.get("question", "Improve the registered agent under its evaluation contract"),
        "domain": domain, "task_contract": context.get("task_contract", {}),
        "capabilities": context.get("capabilities", {}), "prior_research": context.get("prior_research", {}),
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
        {"role": "mechanism_researcher", "prompt": roles.get("mechanism_researcher", "Analyze registered task and software failure mechanisms."),
         "payload": evidence_payload, "max_tokens": 2200},
        {"role": "experimental_critic", "prompt": roles.get("experimental_critic", "Design experiments that could disprove the proposed mechanisms."),
         "payload": evidence_payload, "max_tokens": 2200}
    ])
    research["hypotheses"] = analyses
    broker.log("hypotheses", analyses)
    design_payload = {
        "question": evidence_payload["question"],
        "domain": domain, "task_contract": evidence_payload["task_contract"],
        "capabilities": evidence_payload["capabilities"], "prior_research": evidence_payload["prior_research"],
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
        trial = run_development(candidate, broker, "Test the proposed source under the registered development contract")
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
            "instruction": "Use actual source differences and measured status/failures/work, not claimed success. Return one repaired candidate as complete changed files relative to the ORIGINAL parent. Also compare against the just-tested previous_candidate: repeating its executable source or changing only comments is not a repair. Keep every earlier edit you intend to retain. Use the registered resource and task contract; spending more or hiding missing tasks is not a budget repair."})
        repair_payload["budget"] = budget.copy()
        repair_payload["budget"].update(remaining_calls=1, remaining_completion_tokens=6000)
        repaired = broker.ask("main", roles.get("source_designer", "Return one targeted source repair with code_evidence."),
                              repair_payload, max_tokens=6000)
        revised, revised_check = inspect_source_proposal(repaired, parent.get("files", {}), evidence_payload["editable_components"])
        research["source_checks"].append({"stage": "repair", "check": revised_check})
        research["revisions"].append({"research": repaired.get("research", {}), "candidate": revised})
        revision_check = revision_difference(revised, candidate) if revised is not None else {}
        research["revisions"][-1]["difference_from_tested"] = revision_check
        broker.log("source_check", research["source_checks"][-1])
        if revised_check["issues"]:
            research["repair"].update(status="invalid_repair", unresolved=revised_check["issues"])
        elif selected is not None and revision_check.get("comments_only_or_identical"):
            research["repair"].update(status="repair_noop", unresolved=["Repair repeated the already tested candidate; no new experiment or gain is claimed"])
        else:
            revised_trial = run_development(revised, broker, "Retest the targeted source repair under the registered development contract")
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

def meta_research_trigger(context):
    if not context.get("capabilities", {}).get("probe_improver"):
        return []
    if "meta.py" not in context.get("editable_components", []):
        return []
    parent = context.get("parent", {})
    identities = [parent.get("id"), parent.get("digest")]
    identities = [identity for identity in identities if identity]
    evidence = []
    development = context.get("development", {})
    if development.get("score_available") is False or development.get("failure_kind") or development.get("error"):
        evidence.append({"kind": "current_parent_failure", "source_id": parent.get("id"), "measurement": development})
    prior = context.get("prior_research") or {}
    public_prior = prior.get("study_id") and prior.get("scope") == "development_and_selection_only"
    for failure in context.get("failures", [])[-8:]:
        references = [failure.get("parent_id"), failure.get("candidate_id"), failure.get("source"), failure.get("source_digest"),
                      failure.get("measurement", {}).get("bundle_id")]
        if any(identity in references for identity in identities):
            evidence.append({"kind": "source_linked_failure", "source_id": parent.get("id"), "record": failure})
        elif public_prior and failure.get("kind"):
            evidence.append({"kind": "registered_prior_research_problem", "prior": prior, "record": failure,
                             "scope": "A prior research problem, not proof that the current parent has that failure."})
    recent = context.get("knowledge", [])[-2:]
    if len(recent) == 2 and all(row.get("source") and isinstance(row.get("decision", {}).get("delta"), (int, float)) and row["decision"]["delta"] <= 0 for row in recent):
        evidence.append({"kind": "two_public_non_improving_offspring", "records": recent})
    return evidence

def meta_probe_issues(probe):
    issues = []
    if probe.get("schema") != "nexgent-improver-probe-v1" or probe.get("split") != "development":
        issues.append("Invalid development probe contract")
    if probe.get("status") != "completed":
        issues.append("probe_status=" + str(probe.get("status", "missing")) + "; reason=" + str(probe.get("reason", "")))
    rows = probe.get("arms", [])
    arms = {row.get("arm"): row for row in rows if isinstance(row, dict)} if isinstance(rows, list) else {}
    if len(arms) != 2:
        issues.append("Missing complete paired arms")
    for name in ["initial", "evolved"]:
        arm = arms.get(name, {})
        if arm.get("status") != "complete":
            issues.append("Incomplete arm: " + name)
        gain = arm.get("development_gain")
        if not isinstance(gain, (int, float)) or isinstance(gain, bool) or not math.isfinite(gain):
            issues.append("Missing actual development gain for " + name)
        attempts = arm.get("attempts", [])
        if not attempts:
            issues.append("No actual improve execution evidence for " + name)
        for attempt in attempts:
            if attempt.get("error") or attempt.get("failure_kind") or attempt.get("failure"):
                issues.append("Actual " + name + " offspring generation failed")
            execution = attempt.get("execution") or {}
            if execution.get("entry") != "improve" or not execution.get("source_digest"):
                issues.append("Missing actual improve source receipt for " + name)
    if probe.get("evidence", {}).get("missing"):
        issues.append("Probe reports missing execution or cost evidence")
    delta = probe.get("aggregate", {}).get("paired_development_gain")
    if not isinstance(delta, (int, float)) or isinstance(delta, bool) or not math.isfinite(delta):
        issues.append("Paired development effect is missing")
    elif delta <= 0:
        issues.append("Paired development evidence does not support a positive meta effect")
    return issues

def meta_research_cycle(context, broker, triggers):
    roles, parent, budget = context.get("roles", {}), context.get("parent", {}), context.get("budget", {})
    calls, tokens = budget.get("remaining_calls", 0), budget.get("remaining_completion_tokens", 0)
    plan = {"design_calls": 3, "design_completion_tokens": 10400,
            "probe_calls_reserved": 12, "probe_completion_tokens_reserved": 60000,
            "maximum_probes": 1, "maximum_repairs": 1,
            "repair_reserved": calls >= 16 and tokens >= 76400,
            "scope": "Host same-study admission and paired preflight remain authoritative."}
    research = {"branch": "meta_research", "trigger_evidence": triggers, "budget_plan": plan,
                "source_checks": [], "hypotheses": [], "probes": [], "revisions": [],
                "repair": {"status": "not_needed", "maximum_attempts": 1},
                "evidence_status": "unverified", "limitation": "Development meta probes do not establish held-out improvement or novelty."}
    if calls < 15 or tokens < 70400:
        research["status"] = "insufficient_budget_for_paired_probe"
        broker.log("meta_research_budget", research)
        ordinary = research_cycle(context, broker)
        ordinary["research"]["meta_research_skipped"] = research
        return ordinary
    literature = {"registered": context.get("literature", []),
                  "retrieved": broker.search("source code recursive self improvement actual improver offspring evaluation")}
    payload = {"phase": "meta_mechanism_research", "domain": context.get("domain", {}),
        "task_contract": context.get("task_contract", {}), "tool_api": context.get("tool_api", ""),
        "runtime_contract": context.get("runtime_contract", ""), "parent": parent,
        "question": context.get("question", "Improve the registered agent's research program"),
        "development": context.get("development", {}), "trigger_evidence": triggers,
        "literature": literature, "editable_components": ["meta.py"], "budget": budget, "budget_plan": plan,
        "capabilities": context.get("capabilities", {}),
        "instruction": "Investigate the improver itself. Freeze task.py, workflow.py and roles.json. Propose executable meta.py control flow with an ordinary task-improvement branch when probe_improver capability is false. Test the actual offspring of this new improver, not a proxy or claimed role plan."}
    analyses = broker.parallel([
        {"role": "mechanism_researcher", "prompt": roles.get("mechanism_researcher", "Explain the actual source-linked research failures."), "payload": payload, "max_tokens": 2200},
        {"role": "experimental_critic", "prompt": roles.get("experimental_critic", "Challenge the proposed meta mechanism with an actual offspring experiment."), "payload": payload, "max_tokens": 2200}])
    payload["analyses"] = analyses
    research.update(hypotheses=analyses, literature=literature)
    design = broker.ask("main", roles.get("meta_designer", roles.get("source_designer", "Return one complete meta.py candidate with code_evidence.")), payload, max_tokens=6000)
    candidate, check = inspect_source_proposal(design, parent.get("files", {}), ["meta.py"])
    research["source_checks"].append({"stage": "meta_design", "check": check})
    research["design"] = design.get("research", {})
    if check["issues"] and plan["repair_reserved"]:
        repair_payload = payload.copy()
        repair_payload.update(phase="meta_source_repair_before_probe", previous_candidate=candidate,
            actual_source_check=check, repair_triggers=check["issues"], remaining_repair_calls=1)
        repaired = broker.ask("main", roles.get("meta_designer", "Repair one complete meta.py source, with code_evidence."), repair_payload, max_tokens=6000)
        candidate, check = inspect_source_proposal(repaired, parent.get("files", {}), ["meta.py"])
        research["source_checks"].append({"stage": "meta_design_repair", "check": check})
        research["revisions"].append({"research": repaired.get("research", {}), "candidate": candidate})
        research["repair"]["status"] = "used_before_probe"
    if check["issues"]:
        research.update(status="invalid_meta_source", unresolved=check["issues"])
        broker.log("meta_research_result", research)
        return {"candidates": [], "research": research}
    # This RPC runs both actual source improvers; all inner requests share the host's ledger.
    try:
        probe = broker.probe_improver(candidate["files"], "Compare actual proposed and reference improvers from the registered common task anchor")
    except Exception as failure:
        probe = {"schema": "nexgent-improver-probe-v1", "status": "incomplete", "split": "development",
                 "reason": "probe_request_failed", "error": str(failure), "arms": [], "aggregate": {}}
    research["probes"].append(probe)
    issues = meta_probe_issues(probe)
    candidate["evidence_status"] = "development_supported" if not issues else "unproven"
    candidate["probe_id"] = probe.get("probe_id")
    research["evidence_status"] = candidate["evidence_status"]
    research["probe_interpretation"] = {"issues": issues, "scope": "Actual development offspring evidence only; no deployment promotion or transfer claim."}
    broker.log("meta_probe_feedback", {"probe": probe, "interpretation": research["probe_interpretation"]})
    # One targeted repair may use this actual feedback, but there is no second probe in this outer run.
    if issues and probe.get("status") != "skipped_identical_improver" and probe.get("reason") != "insufficient_budget" and plan["repair_reserved"] and research["repair"]["status"] == "not_needed":
        repair_payload = payload.copy()
        repair_payload.update(phase="meta_repair_after_actual_probe", previous_candidate=candidate,
            actual_probe=probe, repair_triggers=issues, remaining_repair_calls=1,
            instruction="Use the actual offspring, source, status and cost evidence. Return one targeted meta.py repair relative to the original parent. It must also change executable source relative to previous_candidate. No second probe is allowed. This new source will be UNVERIFIED and must not inherit the old probe's measured outcome.")
        repair_payload["budget"] = {"remaining_calls": 1, "remaining_completion_tokens": 6000}
        try:
            repaired = broker.ask("main", roles.get("meta_designer", "Repair the meta source from the actual probe evidence."), repair_payload, max_tokens=6000)
        except Exception as failure:
            research["repair"].update(status="model_repair_failed", error=str(failure))
            research.update(status="research_branch_returned", selected_changed_files=list(candidate["files"]))
            broker.log("meta_research_result", research)
            return {"candidates": [candidate], "research": research}
        revised, revised_check = inspect_source_proposal(repaired, parent.get("files", {}), ["meta.py"])
        difference = revision_difference(revised, candidate) if revised is not None else {}
        research["source_checks"].append({"stage": "meta_probe_repair", "check": revised_check})
        research["revisions"].append({"research": repaired.get("research", {}), "candidate": revised, "difference_from_tested": difference})
        if revised_check["issues"] or difference.get("comments_only_or_identical"):
            research["repair"].update(status="invalid_or_noop_repair", unresolved=revised_check["issues"], difference_from_tested=difference)
        else:
            revised.update(evidence_status="unverified", needs_probe=True, based_on_probe_id=probe.get("probe_id"))
            candidate = revised
            research["repair"]["status"] = "unverified_revision_after_probe"
            research["evidence_status"] = "unverified"
    research["status"] = "research_branch_returned"
    research["selected_changed_files"] = list(candidate["files"])
    broker.log("meta_research_result", research)
    return {"candidates": [candidate], "research": research}
'''

META_SOURCE = '''def improve(context, broker):
    triggers = meta_research_trigger(context)
    if triggers:
        return meta_research_cycle(context, broker, triggers)
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
        "Investigate the registered task agent AND its source-level improver. The domain, task contract and tool API are supplied in the payload. "
        "Read the supplied primary-literature excerpts, observed development results and current source. "
        "Separate observations from hypotheses; cite only supplied paper URLs and accurately state whether only an abstract/excerpt was read. "
        "Identify a mechanism-level algorithm or control-flow change, including how the improver itself could better design future changes. "
        "Diagnose the supplied resource contract, including shared limits and actual reported costs. "
        "Distinguish missing resource-limited scores from measured low task scores. "
        "Bind failure claims to source and measurement IDs; a registered prior failure does not prove the current parent still fails. "
        "For meta_mechanism_research, propose an executable change to improve control flow, role coordination or evidence-based revision, "
        "with a test of its actual offspring from the same task starting point. "
        'Return JSON with arrays: {"observations":["text"],"mechanisms":["text"],"predictions":["text"],"sources":["URL"],"limits":["text"]}. '
        "Use at most four concise statements per field. Do not claim experiments that have not run."
    ),
    "experimental_critic": (
        "Independently inspect the registered agent source and development evidence. "
        "Challenge causal assumptions, hidden-data dependence, resource failures and changes that merely tune constants. "
        "Design cheap discriminating experiments, a strong unchanged-code control, and one falsification condition for a substantive software change. "
        "Inspect top-level and per-task status/failure_kind/score_available and work_units, not only an error string. "
        "Challenge claims unsupported by changed functions and exact new code. Model rhetoric is not measured gain. "
        "You may critique the current improvement/workflow algorithm and suggest a new allocation of research roles. "
        'Return JSON with arrays: {"counterhypotheses":["text"],"experiments":["text"],"code_failures":["text"],"limits":["text"]}. '
        "Use at most four concise statements per field."
    ),
    "source_designer": (
        "Implement agent self-improvement in source code under the supplied domain, task_contract, tool_api and runtime_contract. "
        "The parent contains the ACTUAL source files that will execute next. Use the supplied Tool API exactly. "
        "You may add functions, loops, algorithms, diagnostics and control flow. You may rewrite task.py, meta.py, workflow.py and roles.json, "
        "including adding/reorganizing internal functions. This is not a policy enum or choice table. "
        "The supplied editable_components is the allowed file list for THIS experiment. If only task.py is listed, "
        "change task.py only and keep the parent meta/workflow/roles intact; analyze mechanisms within that control arm. "
        "The task entry is solve(problem, tools); the meta entry is improve(context, broker); select_parent(archive) is optional. "
        "Files share a restricted global namespace. Use no imports, reflection, files, network or subprocesses. "
        "Tools/broker provide capabilities; source code chooses their ordering and composition. "
        "Broker calls are ask(role,prompt,payload,max_tokens=6000), parallel([{role,prompt,payload,max_tokens}]), "
        "experiment(files,label), search(query), log(kind,content), and probe_improver(files,label) only when context.capabilities permits it. "
        "Use normal Python arguments with these exact signatures. Keep runtime and task output contracts valid. "
        "All candidate files inherit unchanged parent files automatically. "
        "Return exactly one thoughtful candidate containing FULL replacement file contents as JSON strings, not diffs or markdown. "
        "Use concise source and explanations within this response budget; omit unchanged files. "
        "Every candidate also needs code_evidence: an array with file, new_code (an exact short new source fragment), "
        "and mechanism (the falsifiable mechanism claim). Include an anchor for EACH changed file. "
        "The new_code must occur in the complete replacement and must not occur in that parent's file. "
        "These lexical anchors document a change; they do not establish semantic novelty or measured success. "
        "Implement a mechanism-level task improvement and, when justified by diagnosed failures, a substantive change to the executable "
        "meta/workflow code so its successor will actually use the revised improvement process. Explain both mechanisms and their falsification tests. "
        "Do not make cosmetic edits to claim meta improvement; if no justified meta change exists, state that limitation. "
        "New roles, changed collaboration, alternative source-generation strategies and experiment-before-patch logic are allowed. "
        "Respect the provided budget. Never invent measured results, special-case task IDs, expose test data, change evaluator or budget enforcement. "
        "Use the registered resource contract and observed costs to stop work adaptively, retain valid intermediate results "
        "and leave headroom for final output and other tasks. Catching exhaustion after spending a shared budget is not "
        "a budget strategy. More loops or silently skipping failed tasks is not a budget repair. "
        "On targeted_source_repair, revise the actual faulty source using supplied status, per-task failures, observed work "
        "and source differences. A missing or zero resource sentinel is not a successful observation. Keep within the one "
        "reserved repair call, return full changed files relative to the original parent, and do not claim the repair works before its experiment. "
        "Also compare a repair against the just-tested candidate: changing comments or repeating its existing mechanism does not implement a repair. "
        "The root JSON has candidates and research. Each candidate has files (filename to full source), rationale (nonempty string), "
        "hypothesis (nonempty string). research contains mechanism, expected_observation, falsification and cited_sources. "
        "Include task.py when its implementation changes; include complete changed meta.py/workflow.py when changing the "
        "improvement mechanism. Return only files whose content differs from the parent; no-op code is rejected."
    ),
}

ROLES["meta_designer"] = (
    ROLES["source_designer"] +
    " This phase is an explicit meta-mechanism experiment. Return ONLY meta.py as a full replacement; "
    "task.py, workflow.py and roles.json are frozen. Rewrite improve(context,broker) executable control flow "
    "so the revised improver actually diagnoses, delegates, designs or revises differently. "
    "Changing only prompts, comments, labels, task parameters or select_parent is insufficient for this mechanism question. "
    "The parent's workflow helper functions remain available, including research_cycle, inspect_source_proposal, "
    "experiment_issues, measured_quality and run_development; you can define new functions in meta.py. "
    "Avoid copying the large workflow. Define a concise complete meta.py within 6000 output tokens. "
    "When context.capabilities.probe_improver is false, perform a real ordinary task-improvement process, "
    "not another probe and not an empty success claim. The tested improver receives at most 6 model calls, "
    "30000 completion tokens and 3 development experiments, and must return at most one task candidate. "
    "A single outer probe compares actual old/new improve execution from a common registered task anchor. "
    "Use the actual probe feedback when supplied. A repaired M written after that probe is unverified; "
    "never copy the old M's evidence status onto it or issue a second probe. "
    "State a falsification condition and preserve negative or missing evidence. "
    'Wire example (shape only, not an acceptable substantive improvement): '
    '{"candidates":[{"files":{"meta.py":"def improve(context, broker):\\n    result = research_cycle(context, broker)\\n    return result\\n"},'
    '"rationale":"Explain the actual new mechanism","hypothesis":"Predict a falsifiable effect",'
    '"code_evidence":[{"file":"meta.py","new_code":"result = research_cycle(context, broker)","mechanism":"Explain the changed executable behavior"}]}],'
    '"research":{"mechanism":"text","expected_observation":"text","falsification":"text","cited_sources":[]}}'
)


def seed_files(task_files=None):
    if not isinstance(task_files, dict) or not isinstance(task_files.get("task.py"), str) or not task_files["task.py"].strip():
        raise ValueError("The registered domain must supply a nonempty task.py seed")
    files = deepcopy(task_files)
    files.update({"workflow.py": WORKFLOW_SOURCE, "meta.py": META_SOURCE,
                  "roles.json": json.dumps(ROLES, ensure_ascii=False, indent=2)})
    return files
