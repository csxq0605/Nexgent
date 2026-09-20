"""Receipt-bound evaluator helpers. This module never runs or inspects OpenFOAM."""

from .data import digest
from .schemas import delivery_schema_errors


def _completed(receipts, name):
    return [item for item in receipts
            if item.get("name") == name and item.get("status") == "completed"
            and isinstance(item.get("result"), dict)]


def evaluate_receipts(task, deliverables, execution_view, *, recovery):
    inputs = execution_view.get("inputs")
    integrity = isinstance(inputs, dict) and digest(inputs) == digest(task["inputs"])
    errors = delivery_schema_errors(deliverables)
    receipts = execution_view.get("tool_calls", [])
    if not isinstance(receipts, list):
        receipts = []

    probes = _completed(receipts, "openfoam.probe_environment")
    probed = any(item["result"].get("available") is True for item in probes)
    prepares = _completed(receipts, "openfoam.prepare_cavity")
    prepared = [item for item in prepares if item["result"].get("status") == "prepared"]
    spec_digest = digest(task["inputs"]["spec"])
    matching_prepare = [item for item in prepared
                        if item["result"].get("spec_digest") == spec_digest
                        and isinstance(item["result"].get("job_digest"), str)
                        and isinstance(item["result"].get("template_digest"), str)]
    controlled_rejections = [(index, item) for index, item in enumerate(receipts)
                             if item in prepares
                             and item["result"].get("status") == "contract_rejected"
                             and item["result"].get("reason") == "synthetic_once_only_rejection"
                             and item["result"].get("retryable") is True
                             and "retry prepare_cavity with the same spec_ref" in
                                 item["result"].get("feedback", "")
                             and item["result"].get("spec_digest") == spec_digest]
    rejection_count = len(controlled_rejections)
    prepared_positions = [index for index, item in enumerate(receipts)
                          if item in matching_prepare]
    recovery_ok = (rejection_count == 0 if not recovery else (
        rejection_count == 1
        and any(index > controlled_rejections[0][0] for index in prepared_positions)
    ))

    runs = _completed(receipts, "openfoam.run_cavity")
    matching_runs = [] if errors else [item for item in runs if item["result"] == deliverables]
    run_bound = bool(matching_runs)
    prepare_bound = False
    if run_bound and matching_prepare:
        manifest = deliverables["run_manifest"]
        prepare_bound = any(
            item["result"]["job_digest"] == manifest["job_digest"]
            and item["result"]["template_digest"] == manifest["template_digest"]
            for item in matching_prepare)
    spec_bound = not errors and deliverables["run_manifest"]["spec_digest"] == spec_digest

    checks_passed = False
    if not errors:
        report = deliverables["verification_report"]
        manifest = deliverables["run_manifest"]
        checks_passed = (report["status"] == "passed"
                         and report["run_digest"] == manifest["run_digest"]
                         and all(item["passed"] for item in report["checks"])
                         and manifest["foundation_version"] == "8"
                         and manifest["scenario"] == "cavity_re10")

    delivery_digest = digest(deliverables) if not errors else None
    validations = _completed(receipts, "openfoam.validate_delivery")
    validated = any(
        item["result"].get("valid") is True
        and item["result"].get("schema_valid") is True
        and item["result"].get("receipt_consistent") is True
        and item["result"].get("errors") == []
        and item["result"].get("delivery_digest") == delivery_digest
        and item["result"].get("run_digest") == deliverables.get("run_manifest", {}).get("run_digest")
        for item in validations) if delivery_digest else False

    conditions = [
        (integrity, "frozen_input_integrity_failed"),
        (not errors, "delivery_schema_failed"),
        (probed, "available_environment_probe_missing"),
        (bool(matching_prepare), "matching_case_preparation_missing"),
        (run_bound, "matching_real_run_receipt_missing"),
        (prepare_bound, "run_not_bound_to_prepared_case"),
        (spec_bound, "run_not_bound_to_frozen_spec"),
        (checks_passed, "smoke_checks_failed"),
        (validated, "matching_delivery_validation_missing"),
        (recovery_ok, "controlled_prepare_rejection_count_mismatch"),
    ]
    reasons = [reason for ok, reason in conditions if not ok]
    accepted = not reasons
    return {
        "accepted": accepted,
        "status": "accepted" if accepted else "rejected",
        "score": float(accepted),
        "score_available": True,
        "metrics": {
            "input_integrity": integrity,
            "environment_probed": probed,
            "case_prepared": bool(matching_prepare),
            "real_run_bound": run_bound,
            "prepare_run_bound": prepare_bound,
            "run_spec_bound": spec_bound,
            "smoke_checks_passed": checks_passed,
            "delivery_validated": validated,
            "controlled_rejection_observed": recovery and rejection_count == 1,
            "controlled_rejection_count": rejection_count,
        },
        "reasons": reasons,
        "schema_errors": errors,
    }
