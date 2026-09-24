"""Route-blind deterministic evaluator for the D1-C release-review probe.

The public boundary deliberately has only three arguments.  In particular, it
does not accept runtime state, a selected component, a checkpoint, or a backend
receipt.  ``condition_id`` is an opaque grouping label: it is echoed in the
result and never selects an answer key.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from copy import deepcopy
import json
import re
from typing import Any

from jsonschema import Draft202012Validator


SERVICES = ("atlas", "borealis", "cygnus")
CHECK_NAMES = (
    "tests_passed",
    "coverage",
    "open_sev1",
    "open_sev2",
    "rollback_minutes",
    "evidence_age_hours",
)

DELIVERABLE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "policy_revision",
        "per_service",
        "overall",
        "blocking_services",
        "summary",
    ],
    "properties": {
        "policy_revision": {"type": "integer"},
        "per_service": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": [
                    "service",
                    "checks",
                    "passed",
                    "blockers",
                    "evidence_refs",
                ],
                "properties": {
                    "service": {"type": "string"},
                    "checks": {
                        "type": "object",
                        "additionalProperties": False,
                        "required": list(CHECK_NAMES),
                        "properties": {
                            name: {"enum": ["pass", "fail"]}
                            for name in CHECK_NAMES
                        },
                    },
                    "passed": {"type": "boolean"},
                    "blockers": {
                        "type": "array",
                        "items": {"type": "string"},
                        "uniqueItems": True,
                    },
                    "evidence_refs": {
                        "type": "array",
                        "items": {"type": "string", "minLength": 1},
                        "uniqueItems": True,
                    },
                },
            },
        },
        "overall": {"enum": ["approve", "hold"]},
        "blocking_services": {
            "type": "array",
            "items": {"type": "string"},
            "uniqueItems": True,
        },
        "summary": {"type": "string", "minLength": 1},
    },
}


class EvaluatorInputError(ValueError):
    """The host crossed the route-blind evaluator boundary incorrectly."""


_ROUTE_KEY_FRAGMENTS = (
    "route",
    "selector",
    "checkpoint",
    "backend",
    "strategy_start",
    "strategy_handoff",
    "active_strategy",
    "component_id",
    "target_component",
    "source_segment",
    "target_segment",
)

_ROUTE_VALUE_PATTERN = re.compile(
    r"\b(?:strategy(?:_?start)?|dag|backend|checkpoint|selector|"
    r"component(?:_?id)?|handoff|route)\b",
    re.IGNORECASE,
)

_UNSUPPORTED_CLAIM_MARKERS = (
    "customer",
    "user impact",
    "region",
    "data loss",
    "outage",
    "latency",
    "security incident",
    "deployment completed",
    "用户",
    "客户",
    "地区",
    "区域",
    "数据丢失",
    "宕机",
    "延迟",
    "安全事件",
    "部署完成",
)


def _normalise_key(value: Any) -> str:
    text = re.sub(r"(?<!^)(?=[A-Z])", "_", str(value))
    return re.sub(r"[^a-z0-9]+", "_", text.lower()).strip("_")


def _reject_route_metadata(value: Any, *, path: str) -> None:
    if isinstance(value, Mapping):
        for key, child in value.items():
            normalised = _normalise_key(key)
            if any(fragment in normalised for fragment in _ROUTE_KEY_FRAGMENTS):
                raise EvaluatorInputError(
                    f"route metadata is forbidden at {path}.{key}"
                )
            _reject_route_metadata(child, path=f"{path}.{key}")
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray)):
        for index, child in enumerate(value):
            _reject_route_metadata(child, path=f"{path}[{index}]")
    elif isinstance(value, str) and _ROUTE_VALUE_PATTERN.search(value):
        raise EvaluatorInputError(f"route metadata is forbidden at {path}")


def _parse_deliverable(final_content: Any) -> tuple[Any, list[str]]:
    if isinstance(final_content, bytes):
        try:
            final_content = final_content.decode("utf-8")
        except UnicodeDecodeError as exc:
            return None, [f"invalid UTF-8: {exc}"]
    if isinstance(final_content, str):
        try:
            parsed = json.loads(final_content)
        except json.JSONDecodeError as exc:
            return None, [f"invalid JSON at line {exc.lineno} column {exc.colno}"]
    elif isinstance(final_content, Mapping):
        parsed = deepcopy(dict(final_content))
    else:
        return None, ["deliverable must be a JSON object or JSON text"]

    _reject_route_metadata(parsed, path="final_content")
    errors = sorted(
        Draft202012Validator(DELIVERABLE_SCHEMA).iter_errors(parsed),
        key=lambda error: tuple(str(part) for part in error.absolute_path),
    )
    messages = []
    for error in errors:
        location = ".".join(str(part) for part in error.absolute_path) or "$"
        messages.append(f"{location}: {error.message}")
    return parsed, messages


def _require_mapping(value: Any, label: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise EvaluatorInputError(f"{label} must be an object")
    return value


def _extract_inputs(
    frozen_inputs: Mapping[str, Any],
) -> tuple[Mapping[str, Any], dict[str, Mapping[str, Any]], str, dict[str, str]]:
    """Accept the canonical nested form and the probe's flat artifact map."""
    _reject_route_metadata(frozen_inputs, path="frozen_inputs")

    explicit_policy_keys = (
        "effective_policy",
        "policy_update",
        "policy_update.json",
        "release_policy_update.json",
    )
    present_policy_keys = [key for key in explicit_policy_keys if key in frozen_inputs]
    if len(present_policy_keys) > 1:
        raise EvaluatorInputError(
            "frozen_inputs has ambiguous effective-policy bindings: "
            + ", ".join(present_policy_keys)
        )
    selected_policy_key = present_policy_keys[0] if present_policy_keys else None
    # The legacy flat task shape used release_policy.json as the one effective
    # policy artifact.  Accept it only when no explicit update binding exists.
    if selected_policy_key is None and "release_policy.json" in frozen_inputs:
        selected_policy_key = "release_policy.json"
    if selected_policy_key is None:
        raise EvaluatorInputError("frozen_inputs is missing the effective policy")
    policy = _require_mapping(
        frozen_inputs[selected_policy_key], f"frozen_inputs.{selected_policy_key}"
    )

    nested_reports = frozen_inputs.get("service_reports")
    reports: dict[str, Mapping[str, Any]] = {}
    report_refs: dict[str, str] = {}
    if nested_reports is not None:
        nested_reports = _require_mapping(nested_reports, "frozen_inputs.service_reports")
        for service in SERVICES:
            direct_key = service if service in nested_reports else f"{service}_report.json"
            if direct_key not in nested_reports:
                raise EvaluatorInputError(f"missing frozen report for {service}")
            reports[service] = _require_mapping(
                nested_reports[direct_key], f"service_reports.{direct_key}"
            )
            report_refs[service] = f"{service}_report.json"
    else:
        for service in SERVICES:
            key = f"{service}_report.json"
            if key not in frozen_inputs:
                raise EvaluatorInputError(f"missing frozen report for {service}")
            reports[service] = _require_mapping(frozen_inputs[key], f"frozen_inputs.{key}")
            report_refs[service] = key

    evidence = frozen_inputs.get("evidence_refs")
    if evidence is not None:
        evidence = _require_mapping(evidence, "frozen_inputs.evidence_refs")
        policy_ref = evidence.get("policy")
        service_refs = _require_mapping(
            evidence.get("services"), "frozen_inputs.evidence_refs.services"
        )
        if not isinstance(policy_ref, str) or not policy_ref:
            raise EvaluatorInputError("evidence_refs.policy must be a nonempty string")
        for service in SERVICES:
            ref = service_refs.get(service)
            if not isinstance(ref, str) or not ref:
                raise EvaluatorInputError(
                    f"evidence_refs.services.{service} must be a nonempty string"
                )
            report_refs[service] = ref
    else:
        policy_ref = (
            selected_policy_key
            if selected_policy_key.endswith(".json")
            else "policy_update.json"
        )

    return policy, reports, policy_ref, report_refs


def _validate_policy_and_reports(
    policy: Mapping[str, Any], reports: Mapping[str, Mapping[str, Any]]
) -> None:
    allowed_policy_keys = {"revision", "service_pass_requires", "overall_rule"}
    if set(policy) != allowed_policy_keys:
        raise EvaluatorInputError("effective policy fields do not match the frozen schema")
    if type(policy["revision"]) is not int:  # bool is not a valid JSON integer here.
        raise EvaluatorInputError("effective policy revision must be an integer")
    if policy["overall_rule"] != "approve_only_if_every_service_passes":
        raise EvaluatorInputError("unsupported overall_rule in frozen policy")
    limits = _require_mapping(
        policy["service_pass_requires"], "effective policy service_pass_requires"
    )
    expected_limit_keys = {
        "tests_passed",
        "coverage_at_least",
        "open_sev1",
        "open_sev2",
        "rollback_minutes_at_most",
        "evidence_age_hours_at_most",
    }
    if set(limits) != expected_limit_keys:
        raise EvaluatorInputError("policy requirement fields do not match the frozen schema")
    if type(limits["tests_passed"]) is not bool:
        raise EvaluatorInputError("tests_passed requirement must be boolean")
    for key in expected_limit_keys - {"tests_passed"}:
        if type(limits[key]) not in (int, float):
            raise EvaluatorInputError(f"policy requirement {key} must be numeric")

    required_report_keys = {
        "tests_passed",
        "coverage",
        "open_sev1",
        "open_sev2",
        "rollback_minutes",
        "evidence_age_hours",
    }
    for service, report in reports.items():
        allowed = required_report_keys | {"service"}
        if set(report) - allowed or not required_report_keys.issubset(report):
            raise EvaluatorInputError(
                f"{service} report fields do not match the frozen schema"
            )
        if "service" in report and report["service"] != service:
            raise EvaluatorInputError(f"{service} report carries a different service name")
        if type(report["tests_passed"]) is not bool:
            raise EvaluatorInputError(f"{service}.tests_passed must be boolean")
        for key in required_report_keys - {"tests_passed"}:
            if type(report[key]) not in (int, float):
                raise EvaluatorInputError(f"{service}.{key} must be numeric")


def _expected_services(
    policy: Mapping[str, Any], reports: Mapping[str, Mapping[str, Any]]
) -> dict[str, dict[str, Any]]:
    limits = policy["service_pass_requires"]
    expected: dict[str, dict[str, Any]] = {}
    for service in SERVICES:
        report = reports[service]
        booleans = {
            "tests_passed": report["tests_passed"] is limits["tests_passed"],
            "coverage": report["coverage"] >= limits["coverage_at_least"],
            "open_sev1": report["open_sev1"] == limits["open_sev1"],
            "open_sev2": report["open_sev2"] == limits["open_sev2"],
            "rollback_minutes": (
                report["rollback_minutes"] <= limits["rollback_minutes_at_most"]
            ),
            "evidence_age_hours": (
                report["evidence_age_hours"] <= limits["evidence_age_hours_at_most"]
            ),
        }
        blockers = [name for name in CHECK_NAMES if not booleans[name]]
        expected[service] = {
            "checks": {
                name: "pass" if booleans[name] else "fail" for name in CHECK_NAMES
            },
            "passed": not blockers,
            "blockers": blockers,
        }
    return expected


def _rows_by_service(result: Mapping[str, Any]) -> tuple[list[Any], dict[str, Any]]:
    rows = result.get("per_service")
    if not isinstance(rows, list):
        return [], {}
    by_service: dict[str, Any] = {}
    for row in rows:
        if isinstance(row, Mapping) and isinstance(row.get("service"), str):
            by_service[row["service"]] = row
    return rows, by_service


def _normalise_summary_negations(text: str) -> str:
    for service in SERVICES:
        text = re.sub(
            rf"{service}.{{0,12}}\bnot\b.{{0,12}}"
            rf"(?:a\s+)?(?:block(?:er|ing|ed)?|fail(?:s|ed|ure|ing)?)",
            f"{service} passes",
            text,
        )
        text = re.sub(
            rf"{service}.{{0,12}}(?:did|does|do)\s+not\s+pass",
            f"{service} fails",
            text,
        )
        text = re.sub(
            rf"{service}.{{0,8}}(?:不是|并非|未被)(?:阻止|阻塞|失败)",
            f"{service} passes",
            text,
        )
    return text


def _summary_marks_atlas_as_blocker(summary: Any) -> bool:
    if not isinstance(summary, str):
        return False
    text = _normalise_summary_negations(summary.lower())
    patterns = (
        r"atlas.{0,16}(?:block(?:er|ing|ed)?|fail(?:s|ed|ure)?|失败|未通过|阻止)",
        r"(?:blockers?|blocking services|failed services)\s*"
        r"(?:are|include|includes|:)?\s*(?:borealis\s*,\s*)?"
        r"(?:cygnus\s*,\s*)?atlas",
        r"(?:失败服务|阻止服务)\s*(?:包括|为|是|：|:)?.{0,8}atlas",
    )
    return any(re.search(pattern, text) for pattern in patterns)


def _summary_supported(
    summary: Any,
    policy: Mapping[str, Any],
    reports: Mapping[str, Mapping[str, Any]],
    expected: Mapping[str, Mapping[str, Any]],
) -> bool:
    if not isinstance(summary, str) or not summary.strip():
        return False
    text = _normalise_summary_negations(summary.lower())
    if any(marker in text for marker in _UNSUPPORTED_CLAIM_MARKERS):
        return False

    # Field-looking identifiers are factual claims.  Permit only schema/input
    # vocabulary so an invented metric cannot pass as prose.
    snake_tokens = set(re.findall(r"\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b", text))
    allowed_snake_tokens = set(CHECK_NAMES) | {
        "open_sev1",
        "open_sev2",
        "policy_revision",
        "blocking_services",
    }
    if snake_tokens - allowed_snake_tokens:
        return False

    supported_numbers = {str(policy["revision"])}
    supported_numbers.update(
        str(value)
        for value in policy["service_pass_requires"].values()
        if type(value) in (int, float)
    )
    for report in reports.values():
        supported_numbers.update(
            str(value) for value in report.values() if type(value) in (int, float)
        )
    if set(re.findall(r"\b\d+(?:\.\d+)?\b", text)) - supported_numbers:
        return False

    # Reject direct contradictions about service-level outcomes.  Detailed
    # checks and blocker equality are independently enforced in criteria 2-4
    # and 12.
    for service in SERVICES:
        if expected[service]["passed"]:
            if re.search(
                rf"{service}.{{0,40}}(?:is |are )?(?:a )?"
                rf"(?:block(?:er|ing|ed)?|fail(?:s|ed|ure)?|失败|未通过|阻止)",
                text,
            ):
                return False
        elif re.search(
            rf"{service}.{{0,24}}(?:service )?(?:pass(?:es|ed)?|approved?|通过)",
            text,
        ):
            return False
    return True


def _criterion(
    criterion_id: str,
    name: str,
    passed: bool,
    *,
    expected: Any,
    actual: Any,
    schema_valid: bool,
) -> dict[str, Any]:
    criterion_passed = bool(schema_valid and passed)
    return {
        "id": criterion_id,
        "name": name,
        "passed": criterion_passed,
        "critical": True,
        "expected": expected,
        "actual": actual,
    }


def evaluate(
    condition_id: str,
    final_content: str | bytes | Mapping[str, Any],
    frozen_inputs: Mapping[str, Any],
) -> dict[str, Any]:
    """Score a final release review against frozen task inputs only.

    ``condition_id`` is intentionally opaque.  Two calls with identical
    ``final_content`` and ``frozen_inputs`` receive identical scoring fields,
    regardless of their condition labels.
    """
    if not isinstance(condition_id, str) or not condition_id.strip():
        raise EvaluatorInputError("condition_id must be a nonempty opaque string")
    frozen_inputs = _require_mapping(frozen_inputs, "frozen_inputs")
    policy, reports, policy_ref, report_refs = _extract_inputs(frozen_inputs)
    _validate_policy_and_reports(policy, reports)
    expected = _expected_services(policy, reports)

    parsed, schema_errors = _parse_deliverable(final_content)
    schema_valid = not schema_errors
    result: Mapping[str, Any] = parsed if isinstance(parsed, Mapping) else {}
    rows, by_service = _rows_by_service(result)

    exact_services = (
        len(rows) == len(SERVICES)
        and len(by_service) == len(SERVICES)
        and set(by_service) == set(SERVICES)
    )
    expected_blocking = [
        service for service in SERVICES if not expected[service]["passed"]
    ]
    expected_overall = "hold" if expected_blocking else "approve"

    service_matches = {}
    for service in SERVICES:
        row = by_service.get(service, {})
        service_matches[service] = all(
            row.get(field) == expected[service][field]
            for field in ("checks", "passed", "blockers")
        )

    evidence_ok = True
    evidence_actual: dict[str, Any] = {}
    all_report_refs = set(report_refs.values())
    for service in SERVICES:
        refs = by_service.get(service, {}).get("evidence_refs", [])
        evidence_actual[service] = refs
        refs_set = set(refs) if isinstance(refs, list) else set()
        evidence_ok = evidence_ok and policy_ref in refs_set
        evidence_ok = evidence_ok and report_refs[service] in refs_set
        evidence_ok = evidence_ok and not (
            refs_set & (all_report_refs - {report_refs[service]})
        )

    blocking_actual = result.get("blocking_services")
    blocking_exact = (
        isinstance(blocking_actual, list)
        and len(blocking_actual) == len(expected_blocking)
        and set(blocking_actual) == set(expected_blocking)
    )

    summary = result.get("summary")
    atlas_not_blocked = not _summary_marks_atlas_as_blocker(summary)
    supported_summary = _summary_supported(summary, policy, reports, expected)

    output_failed_services = []
    if exact_services:
        output_failed_services = [
            service for service in SERVICES if by_service[service].get("passed") is False
        ]
    output_overall = "hold" if output_failed_services else "approve"
    overall_consistent = (
        exact_services
        and result.get("overall") == output_overall
        and isinstance(blocking_actual, list)
        and len(blocking_actual) == len(output_failed_services)
        and set(blocking_actual) == set(output_failed_services)
    )

    blockers_match_failed_checks = exact_services
    blocker_actual: dict[str, Any] = {}
    for service in SERVICES:
        row = by_service.get(service, {})
        checks = row.get("checks", {})
        failed = (
            [name for name in CHECK_NAMES if checks.get(name) == "fail"]
            if isinstance(checks, Mapping)
            else []
        )
        blocker_actual[service] = row.get("blockers")
        blockers_match_failed_checks = (
            blockers_match_failed_checks and row.get("blockers") == failed
        )

    criteria = [
        _criterion(
            "C01",
            "effective policy revision",
            result.get("policy_revision") == policy["revision"],
            expected=policy["revision"],
            actual=result.get("policy_revision"),
            schema_valid=schema_valid,
        ),
        *[
            _criterion(
                f"C0{index}",
                f"{service} checks, decision, and blockers",
                service_matches[service],
                expected=expected[service],
                actual=by_service.get(service),
                schema_valid=schema_valid,
            )
            for index, service in enumerate(SERVICES, start=2)
        ],
        _criterion(
            "C05",
            "per-service evidence references",
            evidence_ok,
            expected={
                service: [policy_ref, report_refs[service]] for service in SERVICES
            },
            actual=evidence_actual,
            schema_valid=schema_valid,
        ),
        _criterion(
            "C06",
            "service set complete and unique",
            exact_services,
            expected=list(SERVICES),
            actual=[row.get("service") for row in rows if isinstance(row, Mapping)],
            schema_valid=schema_valid,
        ),
        _criterion(
            "C07",
            "overall decision",
            result.get("overall") == expected_overall,
            expected=expected_overall,
            actual=result.get("overall"),
            schema_valid=schema_valid,
        ),
        _criterion(
            "C08",
            "blocking services",
            blocking_exact,
            expected=expected_blocking,
            actual=blocking_actual,
            schema_valid=schema_valid,
        ),
        _criterion(
            "C09",
            "summary does not name atlas as a blocker",
            atlas_not_blocked,
            expected="atlas is not described as failing or blocking",
            actual=summary,
            schema_valid=schema_valid,
        ),
        _criterion(
            "C10",
            "summary contains only input-supported claims",
            supported_summary,
            expected="no external or contradictory factual claims",
            actual=summary,
            schema_valid=schema_valid,
        ),
        _criterion(
            "C11",
            "overall is consistent with per-service decisions",
            overall_consistent,
            expected={
                "overall": output_overall,
                "blocking_services": output_failed_services,
            },
            actual={
                "overall": result.get("overall"),
                "blocking_services": blocking_actual,
            },
            schema_valid=schema_valid,
        ),
        _criterion(
            "C12",
            "blockers equal failed check fields",
            blockers_match_failed_checks,
            expected="each blockers list equals its failed checks in schema order",
            actual=blocker_actual,
            schema_valid=schema_valid,
        ),
    ]
    score = sum(1 for item in criteria if item["passed"])
    passed = schema_valid and score == 12
    return {
        "condition_id": condition_id,
        "schema_valid": schema_valid,
        "schema_errors": schema_errors,
        "criteria": criteria,
        "score": score,
        "total": 12,
        "score_possible": 12,
        "threshold": 12,
        "critical_passed": passed,
        "passed": passed,
    }


__all__ = [
    "CHECK_NAMES",
    "DELIVERABLE_SCHEMA",
    "EvaluatorInputError",
    "SERVICES",
    "evaluate",
]
