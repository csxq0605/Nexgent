"""Artifact tools and independent task acceptance for the workbench domain."""

from collections import defaultdict
from copy import deepcopy
import inspect
import re

from nexgent.tasks.benchmarks import BenchmarkDescriptor

from .data import VERSION, SPLITS, digest, inputs_for, row_errors
from .schemas import DELIVERY_SCHEMAS, obj, STR, INT, REV, schema_errors


INSPECTION_SCHEMA = obj({
    "dataset_version": {"type": ["string", "null"]}, "sources_digest": STR,
    "row_count": INT, "valid_row_count": INT,
    "issues": {"type": "array", "items": obj({
        "source_row_id": {"type": ["string", "null"]},
        "fields": {"type": "array", "items": STR}})},
    "revision_inventory": {"type": "array", "items": obj({
        "record_id": STR, "revisions": {"type": "array", "items": REV}})},
    "scope": STR})
VALIDATION_SCHEMA = obj({"valid": {"type": "boolean"},
                         "schema_valid": {"type": "boolean"},
                         "policy_consistent": {"type": "boolean"},
                         "errors": {"type": "array", "items": STR},
                         "delivery_digest": STR, "scope": STR})


class ControlledToolFailure(RuntimeError):
    """One admitted failure for an explicitly requested synthetic recovery trial."""


def _content(context, ref):
    artifact = context.read_artifact(ref)
    return artifact["content"]


def inspect_sources(arguments, context):
    context.check_stop()
    sources = _content(context, arguments["source_ref"])
    if context.task.get("context", {}).get("controlled_failure", False):
        if context.once("workbench.inspect_sources.synthetic-failure.v1"):
            raise ControlledToolFailure("SYNTHETIC controlled once-only inspect failure; retry the same inputs. Acceptance criteria are unchanged.")
    if not isinstance(sources, dict) or not isinstance(sources.get("rows"), list):
        raise ValueError("sources artifact must contain rows array")
    rows = sources["rows"]
    issues = []
    revisions = defaultdict(set)
    seen = set()
    for row in rows:
        errors = row_errors(row)
        row_id = row.get("source_row_id") if isinstance(row, dict) else None
        if row_id in seen:
            errors.append("duplicate_source_row_id")
        if row_id is not None:
            seen.add(row_id)
        if errors:
            issues.append({"source_row_id": row_id, "fields": errors})
        else:
            revisions[row["record_id"]].add(row["revision"])
    return {"dataset_version": sources.get("dataset_version"), "sources_digest": digest(sources),
            "row_count": len(rows), "valid_row_count": len(rows) - len(issues),
            "issues": issues, "revision_inventory": [
                {"record_id": key, "revisions": sorted(revisions[key])} for key in sorted(revisions)],
            "scope": "Structural inspection only; no reconciliation or hidden evaluation."}


def _public_policy_errors(delivery, inputs):
    """Check the published policy without importing or reproducing the hidden oracle output.

    Feedback deliberately identifies violated rules, never expected records, values, totals,
    or source IDs.  The hidden evaluator remains the authority for exact acceptance.
    """
    rows = inputs.get("sources", {}).get("rows", []) if isinstance(inputs, dict) else []
    valid_rows = [row for row in rows if not row_errors(row)]
    highest = {}
    for row in valid_rows:
        highest[row["record_id"]] = max(highest.get(row["record_id"], 0), row["revision"])

    ledger = delivery["ledger"]
    report = delivery["report"]
    records = ledger["records"]
    conflicts = ledger["conflicts"]
    errors = []

    record_ids = [record["record_id"] for record in records]
    if record_ids != sorted(record_ids) or len(record_ids) != len(set(record_ids)):
        errors.append("policy/ledger.records: records_must_be_unique_and_sorted")
    expected_record_ids = set(highest)
    if set(record_ids) != expected_record_ids:
        errors.append("policy/ledger.records: valid_record_coverage_mismatch")

    conflict_ids = [conflict["record_id"] for conflict in conflicts]
    if conflict_ids != sorted(conflict_ids) or len(conflict_ids) != len(set(conflict_ids)):
        errors.append("policy/ledger.conflicts: conflicts_must_be_unique_and_sorted")
    conflicts_by_id = {conflict["record_id"]: conflict for conflict in conflicts}

    for record in records:
        record_id = record["record_id"]
        if record_id not in highest:
            continue
        latest_rows = [row for row in valid_rows
                       if row["record_id"] == record_id and row["revision"] == highest[record_id]]
        latest_ids = {row["source_row_id"] for row in latest_rows}
        submitted_ids = record["source_row_ids"]
        if submitted_ids != sorted(submitted_ids) or set(submitted_ids) != latest_ids:
            errors.append("policy/ledger.records: highest_revision_provenance_mismatch")
        if record["revision"] != highest[record_id]:
            errors.append("policy/ledger.records: highest_revision_mismatch")
        values = {(row["department"], row["amount_cents"], row["deleted"])
                  for row in latest_rows}
        conflict = len(values) > 1
        if conflict:
            if (record["status"] != "conflict" or record["department"] is not None
                    or record["amount_cents"] is not None):
                errors.append("policy/ledger.records: unresolved_conflict_must_be_held")
            detail = conflicts_by_id.get(record_id)
            if detail is None:
                errors.append("policy/ledger.conflicts: conflict_detail_missing")
            else:
                submitted_values = {(item["department"], item["amount_cents"], item["deleted"])
                                    for item in detail["candidate_values"]}
                if (detail["revision"] != highest[record_id]
                        or set(detail["source_row_ids"]) != latest_ids
                        or submitted_values != values):
                    errors.append("policy/ledger.conflicts: conflict_evidence_mismatch")
        else:
            department, amount, deleted = next(iter(values))
            expected_status = "deleted" if deleted else "active"
            if (record["status"] != expected_status or record["department"] != department
                    or record["amount_cents"] != amount):
                errors.append("policy/ledger.records: resolved_value_mismatch")
            if record_id in conflicts_by_id:
                errors.append("policy/ledger.conflicts: nonconflict_detail_present")

    if set(conflict_ids) != {record["record_id"] for record in records
                             if record["status"] == "conflict"}:
        errors.append("policy/ledger.conflicts: conflict_record_alignment_mismatch")

    active = [record for record in records if record["status"] == "active"]
    counts = {"active_count": len(active),
              "deleted_count": sum(record["status"] == "deleted" for record in records),
              "conflict_count": sum(record["status"] == "conflict" for record in records),
              "total_amount_cents": sum(record["amount_cents"] for record in active)}
    summary = report["summary"]
    if any(summary[name] != value for name, value in counts.items()):
        errors.append("policy/report.summary: aggregate_counts_or_total_inconsistent_with_ledger")
    departments = defaultdict(lambda: {"active_count": 0, "total_amount_cents": 0})
    for record in active:
        departments[record["department"]]["active_count"] += 1
        departments[record["department"]]["total_amount_cents"] += record["amount_cents"]
    submitted_departments = summary["by_department"]
    if ([item["department"] for item in submitted_departments]
            != sorted(item["department"] for item in submitted_departments)
            or len({item["department"] for item in submitted_departments})
            != len(submitted_departments)):
        errors.append("policy/report.summary.by_department: departments_must_be_unique_and_sorted")
    submitted_by_department = {item["department"]: {
        "active_count": item["active_count"], "total_amount_cents": item["total_amount_cents"]}
        for item in submitted_departments}
    if submitted_by_department != dict(departments):
        errors.append("policy/report.summary.by_department: aggregate_inconsistent_with_ledger")

    if report["input_digest"] != digest(inputs):
        errors.append("policy/report.input_digest: frozen_input_binding_mismatch")
    invalid_rows = {row.get("source_row_id"): row_errors(row)[0]
                    for row in rows if row_errors(row) and isinstance(row, dict)
                    and isinstance(row.get("source_row_id"), str)}
    excluded = report["excluded_rows"]
    if [item["source_row_id"] for item in excluded] != sorted(
            item["source_row_id"] for item in excluded):
        errors.append("policy/report.excluded_rows: rows_must_be_sorted")
    if ({item["source_row_id"]: item["reason"] for item in excluded} != invalid_rows
            or len({item["source_row_id"] for item in excluded}) != len(excluded)):
        errors.append("policy/report.excluded_rows: invalid_row_coverage_or_reason_mismatch")
    return sorted(set(errors))


def validate_delivery(arguments, context):
    context.check_stop()
    delivery = {name: _content(context, arguments[f"{name}_ref"])
                for name in DELIVERY_SCHEMAS}
    schema_failures = schema_errors(delivery)
    policy_failures = [] if schema_failures else _public_policy_errors(
        delivery, context.task.get("inputs", {}))
    errors = schema_failures + policy_failures
    return {"valid": not errors, "schema_valid": not schema_failures,
            "policy_consistent": not policy_failures and not schema_failures,
            "errors": errors, "delivery_digest": digest(delivery),
            "scope": "Public schema and policy consistency feedback; no expected answer or hidden acceptance result."}


class WorkbenchDomain:
    id = "workbench"

    def describe(self):
        return {"id": self.id, "version": VERSION,
                "title": "Versioned invoice reconciliation", "tools": [
                    "workbench.inspect_sources", "workbench.validate_delivery"],
                "data_origin": "Authored operational fixtures; no population-level effectiveness claim."}

    def snapshot(self):
        return self.describe()

    def environment_probe(self):
        return {"available": True, "status": "available", "requires_external_environment": False,
                "details": "Pure Python artifact tools; provider is configured by the host."}

    def tools(self):
        from nexgent.tasks.tools import ToolSpec, artifact_ref_schema
        return [ToolSpec(name="workbench.inspect_sources",
                         description="Inspect source artifact shape and revision inventory, without reconciling records.",
                         input_schema=obj({"source_ref": artifact_ref_schema()}),
                         output_schema=INSPECTION_SCHEMA,
                         effect_class="read", handler=inspect_sources),
                ToolSpec(name="workbench.validate_delivery",
                         description="Read actual ledger/report artifacts and return public schema and policy-consistency feedback. A successful tool receipt for the final artifacts is required; mentioning this tool in prose is not validation.",
                         input_schema=obj({"ledger_ref": artifact_ref_schema(),
                                           "report_ref": artifact_ref_schema()}),
                         output_schema=VALIDATION_SCHEMA, effect_class="read", handler=validate_delivery)]


class WorkbenchBenchmark:
    id = "workbench"
    descriptor = BenchmarkDescriptor(
        id=id,
        version=VERSION,
        title="Artifact-based data reconciliation",
        splits=tuple(SPLITS),
        default_split="development",
        modes=("fixed", "confirmatory", "recovery"),
        allowed_suite_roles=("qualification",),
        required_capabilities=(
            "workbench.inspect_sources", "workbench.validate_delivery"),
        evidence_scope="Engineering task acceptance; no RSI/statistical efficacy claim.",
    )

    def describe(self):
        return {**self.descriptor.as_dict(), "split_aliases": {"dev": "development"},
                "task_count_per_seed": 1, "data_origin": "authored_operational_fixture",
                "acceptance": "Exact provenance-preserving reconciliation, aggregates, input integrity, and successful public artifact inspection and schema validation.",
                "research_scope": "P1 engineering benchmark; statistical efficacy belongs to P5."}

    def snapshot(self):
        from . import _evaluation
        from . import data, schemas
        return {**self.describe(), "evaluator_digest": digest({
            "oracle": inspect.getsource(_evaluation), "schemas": DELIVERY_SCHEMAS,
            "data_module": inspect.getsource(data), "schema_module": inspect.getsource(schemas),
            "task_contract": inspect.getsource(type(self).tasks),
            "acceptance": inspect.getsource(type(self).evaluate),
            "public_tools": {
                "inspect_sources": inspect.getsource(inspect_sources),
                "validate_delivery": inspect.getsource(validate_delivery),
                "public_policy": inspect.getsource(_public_policy_errors),
                "registration": inspect.getsource(WorkbenchDomain.tools),
            }}),
            "split_identity_digests": {split: digest(inputs_for(split, 0)) for split in SPLITS}}

    def tasks(self, split="development", seed=0, *, controlled_failure=False):
        split = "development" if split == "dev" else split
        inputs = inputs_for(split, seed)
        if type(controlled_failure) is not bool:
            raise ValueError("controlled_failure must be boolean")
        task_id = f"workbench/{VERSION}/{split}/{seed}/{'recovery' if controlled_failure else 'normal'}"
        return [{"id": task_id, "schema_version": "1",
                 "statistical_unit_id": task_id,
                 "cluster_id": f"workbench/{VERSION}/{split}/origin/{seed}",
                 "objective": "Reconcile the versioned invoice source rows under the supplied policy. Deliver a provenance-preserving ledger, explicit unresolved conflicts, and an exact aggregate/exclusion report. excluded_rows must contain exactly the invalid input rows; a valid row superseded by a higher revision is ignored for record selection and must not be reported as excluded. For an invalid row, use the first failing field in invalid_reason_order as its reason. Call inspect_sources on the sources artifact. Publish ledger and report artifacts, call validate_delivery on those actual artifact refs, use its errors to repair the content, republish, and repeat until valid=true. Naming a tool or proposed action in a deliverable does not call it; acceptance requires successful host receipts bound to the final artifact digest.",
                 "inputs": inputs,
                 "deliverables": [{"name": name, "schema": deepcopy(schema)}
                                  for name, schema in DELIVERY_SCHEMAS.items()],
                 "constraints": {"allowed_effects": ["read", "artifact_write"],
                                 "quality_requirements": ["Follow the explicit policy", "Exclude exactly invalid input rows, never valid superseded revisions", "For each invalid row use the first failed field in invalid_reason_order", "Do not silently choose conflicting values", "Use source row IDs as provenance", "Do not include deleted/conflicted invoices in totals", "Act on public validation feedback and validate the final artifact versions"]},
                 "capabilities": ["workbench.inspect_sources", "workbench.validate_delivery"],
                 "context": {"domain": self.id, "benchmark": self.id, "split": split,
                             "seed": seed, "input_digest": digest(inputs),
                             "controlled_failure": controlled_failure,
                             "trial_type": "synthetic_once_only_tool_failure" if controlled_failure else "normal"}}]

    def evaluate(self, task_ref, deliverables, execution_view):
        """Host resolves artifact refs; original inputs and receipts stay host supplied."""
        from ._evaluation import expected_delivery
        task_id = task_ref["id"] if isinstance(task_ref, dict) else task_ref
        match = re.fullmatch(
            rf"workbench/{re.escape(VERSION)}/(development|selection|guard|final_holdout)/(\d+)/(normal|recovery)",
            str(task_id),
        )
        if not match:
            raise ValueError("Unknown frozen workbench task reference")
        split, seed, trial = match.groups()
        task = self.tasks(split, int(seed), controlled_failure=trial == "recovery")[0]
        if task_id != task["id"]:
            raise ValueError("Noncanonical frozen workbench task reference")
        inputs = execution_view.get("inputs")
        integrity = isinstance(inputs, dict) and digest(inputs) == digest(task["inputs"])
        errors = schema_errors(deliverables)
        expected = expected_delivery(task["inputs"])
        ledger_ok = not errors and deliverables["ledger"] == expected["ledger"]
        report_ok = not errors and deliverables["report"] == expected["report"]
        receipts = execution_view.get("tool_calls", [])
        inspected = any(r.get("name") == "workbench.inspect_sources" and r.get("status") == "completed"
                        and isinstance(r.get("result"), dict)
                        and r["result"].get("sources_digest") == digest(task["inputs"]["sources"])
                        for r in receipts)
        checked = any(r.get("name") == "workbench.validate_delivery" and r.get("status") == "completed"
                      and isinstance(r.get("result"), dict) and r["result"].get("valid") is True
                      and r["result"].get("delivery_digest") == digest(deliverables)
                      for r in receipts) if not errors else False
        synthetic_failure_count = sum(
            r.get("name") == "workbench.inspect_sources" and r.get("status") == "failed"
            and "ControlledToolFailure:" in str(r.get("error", ""))
            and "SYNTHETIC controlled once-only inspect failure" in str(r.get("error", ""))
            for r in receipts)
        recovery_observed = trial != "recovery" or synthetic_failure_count == 1
        reasons = []
        for ok, reason in ((integrity, "frozen_input_integrity_failed"), (not errors, "delivery_schema_failed"),
                           (ledger_ok, "ledger_or_provenance_incorrect"), (report_ok, "aggregate_or_exclusions_incorrect"),
                           (inspected, "matching_source_inspection_missing"), (checked, "matching_delivery_validation_missing"),
                           (recovery_observed, "exactly_one_controlled_failure_not_observed")):
            if not ok:
                reasons.append(reason)
        accepted = not reasons
        return {"benchmark": self.id, "task_ref": task_id, "split": split,
                "accepted": accepted, "status": "accepted" if accepted else "rejected",
                "score": float(accepted), "score_available": True,
                "metrics": {"ledger_correct": ledger_ok, "report_correct": report_ok,
                            "input_integrity": integrity, "source_inspected": inspected,
                            "delivery_schema_checked": checked,
                            "controlled_failure_observed": trial == "recovery" and synthetic_failure_count == 1,
                            "controlled_failure_count": synthetic_failure_count},
                "reasons": reasons, "schema_errors": errors,
                "evaluator_digest": self.snapshot()["evaluator_digest"],
                "trial_type": task["context"]["trial_type"],
                "scope": "Engineering task acceptance; no RSI/statistical efficacy claim."}


def domain_pack():
    return WorkbenchDomain()


def benchmark_adapter():
    return WorkbenchBenchmark()
