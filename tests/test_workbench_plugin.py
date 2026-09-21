"""Workbench deterministic contract tests; no models or real runtime evidence."""

from copy import deepcopy
from pathlib import Path
import sys
import threading

import pytest

# The optional plugin need not be installed just to run these contract tests.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "benchmarks" / "workbench" / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from nexgent_workbench import WorkbenchBenchmark, WorkbenchDomain
from nexgent_workbench._evaluation import expected_delivery
from nexgent_workbench.data import digest, row_errors
from nexgent_workbench.plugin import ControlledToolFailure, inspect_sources, validate_delivery


class ContractContext:
    """TEST DOUBLE: host artifact access and durable episode claim contract."""

    def __init__(self, task, *, claims=None):
        self.task = deepcopy(task)
        self.episode_id = "contract-episode"
        self.stop_event = threading.Event()
        self.claims = set() if claims is None else claims
        self.artifacts = {name: {"id": name, "content": deepcopy(value)}
                          for name, value in task["inputs"].items()}

    def read_artifact(self, ref):
        return deepcopy(self.artifacts[ref])

    def publish(self, content, name=None, schema="application/json"):
        ref = name or f"artifact-{len(self.artifacts)}"
        artifact = {"id": ref, "content": deepcopy(content), "schema": schema}
        self.artifacts[ref] = artifact
        return deepcopy(artifact)

    def check_stop(self):
        if self.stop_event.is_set():
            raise InterruptedError("contract stop")

    def once(self, key):
        if key in self.claims:
            return False
        self.claims.add(key)
        return True


def contract_execution(task, delivery=None):
    context = ContractContext(task)
    delivery = expected_delivery(task["inputs"]) if delivery is None else delivery
    inspected = inspect_sources({"source_ref": "sources"}, context)
    for name, content in delivery.items():
        context.publish(content, name=name)
    checked = validate_delivery({"ledger_ref": "ledger", "report_ref": "report"}, context)
    # Receipts are explicitly a deterministic host-contract double, not model evidence.
    receipts = [{"name": "workbench.inspect_sources", "status": "completed", "result": inspected},
                {"name": "workbench.validate_delivery", "status": "completed", "result": checked}]
    return delivery, {"inputs": deepcopy(task["inputs"]), "tool_calls": receipts}


def test_split_identities_are_deterministic_disjoint_and_alias_explicit():
    benchmark = WorkbenchBenchmark()
    pools, input_digests, task_ids = [], [], []
    for split in ("development", "selection", "guard", "final_holdout"):
        seed = 13
        task = benchmark.tasks(split, seed)[0]
        assert task == benchmark.tasks(split, seed)[0]
        pools.append({row["record_id"] for row in task["inputs"]["sources"]["rows"]})
        input_digests.append(digest(task["inputs"]))
        task_ids.append(task["id"])
    assert all(a.isdisjoint(b) for i, a in enumerate(pools) for b in pools[i + 1:])
    assert len(set(input_digests)) == 4
    assert len(set(task_ids)) == 4
    assert benchmark.tasks("dev", 0) == benchmark.tasks("development", 0)
    with pytest.raises(ValueError, match="Unknown split"):
        benchmark.tasks("transfer", 0)
    assert benchmark.snapshot() == benchmark.snapshot()
    assert len(set(benchmark.snapshot()["split_identity_digests"].values())) == 4


def test_guard_split_is_evaluated_by_the_same_frozen_contract():
    benchmark = WorkbenchBenchmark()
    task = benchmark.tasks("guard", 13)[0]
    delivery, view = contract_execution(task)

    report = benchmark.evaluate(task, delivery, view)

    assert report["accepted"] is True
    assert report["score"] == 1.0
    assert report["split"] == "guard"
    assert report["task_ref"] == task["id"]


def test_snapshot_binds_public_tool_and_task_contract_implementations(monkeypatch):
    """Resume/evaluation must detect tool semantics changing after registration."""
    import nexgent_workbench.plugin as plugin

    benchmark = WorkbenchBenchmark()
    original = benchmark.snapshot()
    real_getsource = plugin.inspect.getsource

    def changed_getsource(subject):
        source = real_getsource(subject)
        if subject is plugin.validate_delivery:
            return source + "\n# simulated public validator upgrade\n"
        return source

    monkeypatch.setattr(plugin.inspect, "getsource", changed_getsource)
    changed = benchmark.snapshot()
    assert changed["evaluator_digest"] != original["evaluator_digest"]


def test_public_tools_inspect_and_validate_without_hidden_answer():
    task = WorkbenchBenchmark().tasks()[0]
    context = ContractContext(task)
    result = inspect_sources({"source_ref": "sources"}, context)
    assert result["row_count"] == 14 and result["valid_row_count"] == 11
    assert {i["fields"][0] for i in result["issues"]} == {"amount_cents", "currency", "revision"}
    assert not ({"ledger", "summary", "expected", "target", "conflicts"} & set(result))
    assert set(task["inputs"]) == {"sources", "policy"}
    delivery = expected_delivery(task["inputs"])
    # A schema-valid but incorrect amount gets actionable rule feedback without
    # revealing the expected total or importing the hidden oracle result.
    delivery["report"]["summary"]["total_amount_cents"] += 1
    for name, value in delivery.items():
        context.publish(value, name=name)
    checked = validate_delivery({"ledger_ref": "ledger", "report_ref": "report"}, context)
    assert checked["schema_valid"] and not checked["policy_consistent"]
    assert not checked["valid"] and checked["delivery_digest"] == digest(delivery)
    assert checked["errors"] == [
        "policy/report.summary: aggregate_counts_or_total_inconsistent_with_ledger"]
    assert "2700" not in str(checked["errors"])


def test_public_policy_feedback_guides_revision_without_becoming_hidden_oracle():
    task = WorkbenchBenchmark().tasks()[0]
    context = ContractContext(task)
    delivery = expected_delivery(task["inputs"])
    record = next(record for record in delivery["ledger"]["records"]
                  if record["status"] == "active")
    record["revision"] -= 1
    for name, value in delivery.items():
        context.publish(value, name=name)
    checked = validate_delivery({"ledger_ref": "ledger", "report_ref": "report"}, context)
    assert not checked["valid"] and checked["schema_valid"]
    assert "policy/ledger.records: highest_revision_mismatch" in checked["errors"]
    # Feedback identifies the violated public rule, not the record or correct value.
    assert record["record_id"] not in str(checked["errors"])

    repaired = expected_delivery(task["inputs"])
    for name, value in repaired.items():
        context.publish(value, name=name)
    validated = validate_delivery({"ledger_ref": "ledger", "report_ref": "report"}, context)
    assert validated["valid"] and validated["schema_valid"] and validated["policy_consistent"]
    assert validated["errors"] == []


def test_public_contract_distinguishes_invalid_exclusions_from_valid_superseded_rows():
    benchmark = WorkbenchBenchmark()
    task = benchmark.tasks()[0]
    policy = task["inputs"]["policy"]
    assert "exactly the invalid input rows" in policy["exclusion_rule"]
    assert "lower revision" in policy["exclusion_rule"]
    assert "first failed field in invalid_reason_order" in policy["exclusion_rule"]
    assert any("never valid superseded revisions" in requirement
               for requirement in task["constraints"]["quality_requirements"])
    assert "valid row superseded by a higher revision" in task["objective"]

    rows = task["inputs"]["sources"]["rows"]
    valid_lower_revision = next(
        row for row in rows
        if not row_errors(row) and any(
            other["record_id"] == row["record_id"]
            and not row_errors(other)
            and other["revision"] > row["revision"]
            for other in rows))
    assert row_errors(valid_lower_revision) == []

    delivery = expected_delivery(task["inputs"])
    delivery["report"]["excluded_rows"].append({
        "source_row_id": valid_lower_revision["source_row_id"],
        "reason": "superseded_revision"})
    delivery["report"]["excluded_rows"].sort(key=lambda item: item["source_row_id"])
    context = ContractContext(task)
    for name, value in delivery.items():
        context.publish(value, name=name)
    checked = validate_delivery({"ledger_ref": "ledger", "report_ref": "report"}, context)
    assert checked["schema_valid"] and not checked["policy_consistent"]
    assert checked["errors"] == [
        "policy/report.excluded_rows: invalid_row_coverage_or_reason_mismatch"]


def test_invalid_reason_uses_first_failed_field_in_published_order():
    benchmark = WorkbenchBenchmark()
    task = benchmark.tasks()[0]
    invalid = next(row for row in task["inputs"]["sources"]["rows"]
                   if "amount_cents" in row_errors(row))
    invalid["currency"] = "EUR"
    assert row_errors(invalid)[:2] == ["amount_cents", "currency"]

    delivery = expected_delivery(task["inputs"])
    excluded = next(item for item in delivery["report"]["excluded_rows"]
                    if item["source_row_id"] == invalid["source_row_id"])
    assert excluded["reason"] == "amount_cents"
    excluded["reason"] = "currency"
    context = ContractContext(task)
    for name, value in delivery.items():
        context.publish(value, name=name)
    checked = validate_delivery({"ledger_ref": "ledger", "report_ref": "report"}, context)
    assert checked["schema_valid"] and not checked["policy_consistent"]
    assert checked["errors"] == [
        "policy/report.excluded_rows: invalid_row_coverage_or_reason_mismatch"]


def test_public_policy_validator_does_not_replace_exact_hidden_evaluator():
    benchmark = WorkbenchBenchmark()
    task = benchmark.tasks()[0]
    context = ContractContext(task)
    delivery = expected_delivery(task["inputs"])
    delivery["ledger"]["conflicts"][0]["candidate_values"].reverse()
    inspected = inspect_sources({"source_ref": "sources"}, context)
    for name, value in delivery.items():
        context.publish(value, name=name)
    checked = validate_delivery({"ledger_ref": "ledger", "report_ref": "report"}, context)
    assert checked["valid"]
    view = {"inputs": deepcopy(task["inputs"]), "tool_calls": [
        {"name": "workbench.inspect_sources", "status": "completed", "result": inspected},
        {"name": "workbench.validate_delivery", "status": "completed", "result": checked}]}
    report = benchmark.evaluate(task["id"], delivery, view)
    assert not report["accepted"]
    assert report["reasons"] == ["ledger_or_provenance_incorrect"]


def test_host_evaluator_accepts_exact_delivery_only_with_matching_artifact_receipts():
    benchmark = WorkbenchBenchmark()
    task = benchmark.tasks()[0]
    delivery, view = contract_execution(task)
    assert benchmark.evaluate(task["id"], delivery, view)["accepted"]
    assert delivery["report"]["summary"] == {
        "active_count": 3, "deleted_count": 1, "conflict_count": 1,
        "total_amount_cents": 2700, "by_department": [
            {"department": "engineering", "active_count": 1, "total_amount_cents": 1250},
            {"department": "operations", "active_count": 1, "total_amount_cents": 800},
            {"department": "sales", "active_count": 1, "total_amount_cents": 650}]}
    view["tool_calls"] = []
    report = benchmark.evaluate(task["id"], delivery, view)
    assert not report["accepted"] and report["metrics"]["ledger_correct"]
    assert "matching_source_inspection_missing" in report["reasons"]


def test_input_tampering_boolean_integer_collision_and_stale_checked_draft_rejected():
    benchmark = WorkbenchBenchmark()
    task = benchmark.tasks()[0]
    delivery, view = contract_execution(task)
    valid = next(row for row in view["inputs"]["sources"]["rows"] if row["revision"] == 1)
    valid["revision"] = True  # Python True == 1 must not defeat JSON integrity.
    assert not benchmark.evaluate(task["id"], delivery, view)["metrics"]["input_integrity"]
    delivery, view = contract_execution(task)
    delivery["report"]["summary"]["total_amount_cents"] += 1
    report = benchmark.evaluate(task["id"], delivery, view)
    assert not report["accepted"] and not report["metrics"]["delivery_schema_checked"]
    assert not report["metrics"]["report_correct"]


def test_conflict_source_arbitration_deleted_totals_invalid_rows_and_provenance_rejected():
    benchmark = WorkbenchBenchmark()
    task = benchmark.tasks()[0]
    baseline = expected_delivery(task["inputs"])
    mutations = []
    conflict = next(i for i, row in enumerate(baseline["ledger"]["records"]) if row["status"] == "conflict")
    changed = deepcopy(baseline)
    changed["ledger"]["records"][conflict].update(status="active", department="sales", amount_cents=2400)
    mutations.append(changed)
    changed = deepcopy(baseline)
    changed["report"]["summary"]["total_amount_cents"] += 3100
    mutations.append(changed)
    changed = deepcopy(baseline)
    changed["report"]["excluded_rows"] = []
    mutations.append(changed)
    changed = deepcopy(baseline)
    changed["ledger"]["records"][0]["source_row_ids"].pop()
    mutations.append(changed)
    for changed in mutations:
        delivery, view = contract_execution(task, changed)
        report = benchmark.evaluate(task["id"], delivery, view)
        assert not report["accepted"] and report["score"] == 0
        assert "expected" not in report and "target" not in report


def test_schema_checker_identifies_missing_mistyped_fields_and_stop_prevents_read():
    task = WorkbenchBenchmark().tasks()[0]
    context = ContractContext(task)
    context.publish({"records": "wrong", "conflicts": []}, name="ledger")
    context.publish({}, name="report")
    checked = validate_delivery({"ledger_ref": "ledger", "report_ref": "report"}, context)
    assert not checked["valid"] and checked["errors"]
    context.stop_event.set()
    with pytest.raises(InterruptedError):
        inspect_sources({"source_ref": "missing"}, context)


def test_once_only_synthetic_failure_contract_survives_context_reconstruction():
    benchmark = WorkbenchBenchmark()
    task = benchmark.tasks(controlled_failure=True)[0]
    claims = set()
    context = ContractContext(task, claims=claims)
    with pytest.raises(ControlledToolFailure, match="SYNTHETIC"):
        inspect_sources({"source_ref": "sources"}, context)
    resumed_context = ContractContext(task, claims=claims)
    assert inspect_sources({"source_ref": "sources"}, resumed_context)["row_count"] == 14
    normal = ContractContext(benchmark.tasks()[0])
    assert inspect_sources({"source_ref": "sources"}, normal)["row_count"] == 14
    assert normal.claims == set()


def test_recovery_acceptance_requires_exactly_one_real_host_failure_receipt():
    benchmark = WorkbenchBenchmark()
    task = benchmark.tasks(controlled_failure=True)[0]
    # Simulate the host continuing after the already consumed durable once claim.
    context = ContractContext(task, claims={"workbench.inspect_sources.synthetic-failure.v1"})
    delivery = expected_delivery(task["inputs"])
    for name, value in delivery.items():
        context.publish(value, name=name)
    receipts = [
        {"name": "workbench.inspect_sources", "status": "completed",
         "result": inspect_sources({"source_ref": "sources"}, context)},
        {"name": "workbench.validate_delivery", "status": "completed",
         "result": validate_delivery({"ledger_ref": "ledger", "report_ref": "report"}, context)}]
    view = {"inputs": task["inputs"], "tool_calls": receipts}
    assert not benchmark.evaluate(task["id"], delivery, view)["accepted"]
    failure = {"name": "workbench.inspect_sources", "status": "failed",
               "error": "ControlledToolFailure: SYNTHETIC controlled once-only inspect failure; retry the same inputs."}
    receipts.insert(0, failure)
    report = benchmark.evaluate(task["id"], delivery, view)
    assert report["accepted"] and report["metrics"]["controlled_failure_observed"]
    assert report["metrics"]["controlled_failure_count"] == 1
    receipts.insert(0, deepcopy(failure))
    assert not benchmark.evaluate(task["id"], delivery, view)["accepted"]
    receipts.pop(0)
    delivery["report"]["summary"]["total_amount_cents"] += 1
    # Even successful recovery never relaxes aggregate correctness.
    assert not benchmark.evaluate(task["id"], delivery, view)["accepted"]


def test_contract_factories_and_environment_probe_do_not_require_tool_loading():
    domain = WorkbenchDomain()
    assert domain.environment_probe()["available"]
    assert domain.snapshot()["id"] == "workbench"
    row = deepcopy(WorkbenchBenchmark().tasks()[0]["inputs"]["sources"]["rows"][0])
    row["amount_cents"] = True
    assert "amount_cents" in row_errors(row)


def test_public_tools_register_in_generic_host_and_validate_typed_results():
    from nexgent.tasks.tools import ToolRegistry, validate

    domain = WorkbenchDomain()
    registry = ToolRegistry(domain.tools())
    task = WorkbenchBenchmark().tasks()[0]
    context = ContractContext(task)
    delivery = expected_delivery(task["inputs"])
    for name, value in delivery.items():
        context.publish(value, name=name)
    for name, arguments in (("workbench.inspect_sources", {"source_ref": "sources"}),
                            ("workbench.validate_delivery", {"ledger_ref": "ledger", "report_ref": "report"})):
        tool = registry.get(name)
        validate(arguments, tool.input_schema, allow_artifact_refs=True)
        result = tool.handler(arguments, context)
        validate(result, tool.output_schema)
        assert tool.effect_class == "read"
