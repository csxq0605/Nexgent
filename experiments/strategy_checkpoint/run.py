"""Run the preregistered D1-C MiMo strategy-checkpoint mechanism probe.

The default command is an offline preflight.  Provider traffic requires the
explicit ``--live`` flag.  The four conditions, their order, all package/task
identities, and the host StrategyStart are frozen before the first live call.
See CONTRACT.md in this directory for the interpretation and stop rules.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import inspect
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import time
from urllib.parse import urlsplit

from nexgent.kernel.programs import digest
from nexgent.models import ModelGateway
from nexgent.models.config import ModelConfigurationError, Profile, load_profiles
from nexgent.models.gateway import ModelTransportError
from nexgent.models.worker import response_payload
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.strategy_decisions import (
    CANDIDATE_SET_SCHEMA,
    STRATEGY_START_SCHEMA,
    build_strategy_start,
    strategy_candidate_set_from_manifest,
)
from nexgent.tasks.tools import ToolRegistry, ToolSpec


SCHEMA = "nexgent.d1c-strategy-checkpoint-evidence.v1"
MANIFEST_SCHEMA = "nexgent.d1c-run-manifest.v1"
EXPECTED_MODEL = "mimo-v2.6-flash"
EXPECTED_ENDPOINT = "https://token-plan-cn.xiaomimimo.com/v1"
CREDENTIAL_REF = "NEXGENT_API_KEY"
ENTRY = "execute"
POLICY_ID = "d1c_experimental_intervention"
DAG_COMPONENT_ID = "checkpoint-release-dag"
ENTRY_COMPONENT_ID = "handoff-recovery-entry"
SELECTOR_COMPONENT_ID = "checkpoint-selector-role"
VALIDATOR_TOOL = "d1c.validate_release_draft"
CONDITION_ORDER = (
    "D1C-SWITCH-PRIMARY",
    "D1C-NO-GAP",
    "D1C-INFRA-CONTROL",
    "D1C-SWITCH-RECOVERY",
)
BUDGET = {
    "max_model_calls": 5,
    "max_completion_tokens": 12_000,
    "max_tool_calls": 1,
    "max_tool_work_units": 1,
    "max_nodes": 32,
}
CONSTRAINTS = {
    "wall_seconds": 180,
    "allowed_effects": ["local_compute"],
}
BATCH_CAPS = {
    "episodes": 4,
    "started_model_calls": 20,
    "completion_token_reservations": 48_000,
    "tool_calls": 4,
    "tool_work_units": 4,
    "nodes": 128,
}
RETRY_POLICY = {"sdk_automatic_retries": 0, "provider_attempts_per_call": 1}

PUBLIC_PROMPT = (
    "使用适用的发布政策逐项审查三份服务报告，并给出整个发布的结论。发布前可能出现经过验证的政策更新；"
    "最终审查必须使用最新适用政策并引用实际使用的输入工件。每个服务列出六项检查结果、是否通过及仅由输入支持的 "
    "blockers；总体结论严格应用 overall rule。按给定 schema 返回一个 JSON 对象。"
)

BASE_POLICY = {
    "revision": 1,
    "service_pass_requires": {
        "tests_passed": True,
        "coverage_at_least": 80,
        "open_sev1": 0,
        "open_sev2": 0,
        "rollback_minutes_at_most": 15,
        "evidence_age_hours_at_most": 24,
    },
    "overall_rule": "approve_only_if_every_service_passes",
}
SERVICE_REPORTS = {
    "atlas": {
        "service": "atlas", "tests_passed": True, "coverage": 91,
        "open_sev1": 0, "open_sev2": 0, "rollback_minutes": 12,
        "evidence_age_hours": 3,
    },
    "borealis": {
        "service": "borealis", "tests_passed": True, "coverage": 88,
        "open_sev1": 0, "open_sev2": 1, "rollback_minutes": 9,
        "evidence_age_hours": 2,
    },
    "cygnus": {
        "service": "cygnus", "tests_passed": True, "coverage": 82,
        "open_sev1": 0, "open_sev2": 0, "rollback_minutes": 18,
        "evidence_age_hours": 6,
    },
}
CHECK_NAMES = (
    "tests_passed", "coverage", "open_sev1", "open_sev2",
    "rollback_minutes", "evidence_age_hours",
)
ARTIFACT_NAMES = {
    "base_policy": "release_policy.json",
    "policy_update": "policy_update.json",
    "atlas": "atlas_report.json",
    "borealis": "borealis_report.json",
    "cygnus": "cygnus_report.json",
    "fault": "fault_injection.json",
}
RELEASE_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": [
        "policy_revision", "per_service", "overall", "blocking_services", "summary",
    ],
    "properties": {
        "policy_revision": {"type": "integer"},
        "per_service": {
            "type": "array",
            "items": {
                "type": "object", "additionalProperties": False,
                "required": ["service", "checks", "passed", "blockers", "evidence_refs"],
                "properties": {
                    "service": {"type": "string"},
                    "checks": {
                        "type": "object", "additionalProperties": False,
                        "required": list(CHECK_NAMES),
                        "properties": {
                            name: {"enum": ["pass", "fail"]} for name in CHECK_NAMES
                        },
                    },
                    "passed": {"type": "boolean"},
                    "blockers": {"type": "array", "items": {"type": "string"}},
                    "evidence_refs": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "overall": {"enum": ["approve", "hold"]},
        "blocking_services": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
    },
}

SELECTOR_PROMPT = """Select whether to continue the current DAG or enter a frozen entry.

Use only the host supplied task projection, deterministic feedback, frozen
candidate identities, remaining root budget, completed artifacts, bounded
pending plan, and target entry capability projection.  A material protocol gap
that the pending DAG cannot repair should select handoff-recovery-entry.  Return
exactly {"target_component_id":"handoff-recovery-entry|null","reason":"..."}.
"""

DRAFT_PROMPT = """Draft the release review from the base policy and three reports.
Use only supplied evidence. Return exactly one JSON object matching the supplied
deliverable schema. evidence_refs must name release_policy.json and the matching
service report. This is a pre-update draft; do not invent facts.
"""

REPAIR_PROMPT = """Repair a release-review draft using the durable handoff.
Apply the verified updated policy and its validator failures. Return exactly one
release_review.json object matching the public schema and using policy revision 2.
Use only the evidence in the handoff.
"""

REVIEW_PROMPT = """Independently review the proposed release review against the
updated policy, reports, and validator feedback in the durable handoff. Return
exactly {"approved":true|false,"reason":"nonempty text"}. Approve only an exact,
fully supported result.
"""

ENTRY_SOURCE = r'''
def execute(task, context):
    handoff = context.read_artifact(task['strategy_handoff_ref'])
    content = handoff['content']
    receipts = content['completed_receipts']
    validator = receipts['validate_update']['value']
    repaired = context.ask(
        'release_repair',
        context.resource('prompts/repair.md'),
        {
            'schema': 'nexgent.d1c-release-repair-request.v1',
            'public_task': {
                'objective': task['objective'],
                'deliverables': task['deliverables'],
                'input_refs': task['input_refs'],
            },
            'handoff': content,
            'validator': validator,
        },
        max_tokens=3500,
    )
    review = context.ask(
        'release_reviewer',
        context.resource('prompts/reviewer.md'),
        {'schema': 'nexgent.d1c-release-review-request.v1',
         'proposal': repaired, 'handoff': content},
        max_tokens=1000,
    )
    if (not isinstance(review, dict) or review.get('approved') is not True
            or not isinstance(review.get('reason'), str) or not review['reason'].strip()):
        raise ValueError('Independent reviewer rejected the repaired deliverable')
    confirmed = context.read_artifact(task['strategy_handoff_ref'])
    if (confirmed['id'] != handoff['id']
            or confirmed['content_digest'] != handoff['content_digest']):
        raise ValueError('Strategy handoff identity changed before publication')
    artifact = context.publish(
        repaired, name='release_review.json', schema=task['deliverables'][0]['schema'])
    return {
        'deliverables': {'release_review.json': artifact['id']},
        'summary': 'Repaired the review from the verified durable handoff.',
        'limitations': [],
    }
'''

ARTIFACT_READER_SOURCE = r'''
def read_named_artifact(payload, context):
    name = payload['name']
    refs = payload['input_refs']
    if name not in refs:
        raise ValueError('Frozen input artifact is absent: ' + name)
    return context.read_artifact(refs[name])
'''


def _canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False)


def _sha_value(value):
    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _sha_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _policy_update(material):
    update = deepcopy(BASE_POLICY)
    update["revision"] = 2
    if material:
        update["service_pass_requires"]["coverage_at_least"] = 90
    return update


def _condition_spec(condition_id):
    if condition_id not in CONDITION_ORDER:
        raise ValueError("Unknown preregistered condition")
    material = condition_id in {"D1C-SWITCH-PRIMARY", "D1C-SWITCH-RECOVERY"}
    fault = "infrastructure" if condition_id == "D1C-INFRA-CONTROL" else None
    inputs = {
        ARTIFACT_NAMES["base_policy"]: deepcopy(BASE_POLICY),
        ARTIFACT_NAMES["policy_update"]: _policy_update(material),
        **{ARTIFACT_NAMES[name]: deepcopy(report)
           for name, report in SERVICE_REPORTS.items()},
        ARTIFACT_NAMES["fault"]: {"feedback_domain": fault},
    }
    return {
        "condition_id": condition_id,
        "objective": PUBLIC_PROMPT,
        "inputs": inputs,
        "deliverables": [{"name": "release_review.json", "schema": RELEASE_SCHEMA}],
        "fault_injection_point": (
            "after_checkpoint_commit_before_target_entry"
            if condition_id == "D1C-SWITCH-RECOVERY" else None
        ),
    }


def _public_evaluator_inputs(spec):
    inputs = spec["inputs"]
    return {
        "effective_policy": deepcopy(inputs[ARTIFACT_NAMES["policy_update"]]),
        "service_reports": {
            name: deepcopy(inputs[ARTIFACT_NAMES[name]])
            for name in ("atlas", "borealis", "cygnus")
        },
        "evidence_refs": {
            "policy": ARTIFACT_NAMES["policy_update"],
            "services": {
                name: ARTIFACT_NAMES[name]
                for name in ("atlas", "borealis", "cygnus")
            },
        },
    }


def _checks(policy, reports):
    limits = policy["service_pass_requires"]
    result = {}
    for service in ("atlas", "borealis", "cygnus"):
        report = reports[service]
        values = {
            "tests_passed": report["tests_passed"] is limits["tests_passed"],
            "coverage": report["coverage"] >= limits["coverage_at_least"],
            "open_sev1": report["open_sev1"] == limits["open_sev1"],
            "open_sev2": report["open_sev2"] == limits["open_sev2"],
            "rollback_minutes": (
                report["rollback_minutes"] <= limits["rollback_minutes_at_most"]),
            "evidence_age_hours": (
                report["evidence_age_hours"] <= limits["evidence_age_hours_at_most"]),
        }
        result[service] = values
    return result


def _draft_matches(policy, reports, draft, *, policy_ref):
    if not isinstance(draft, dict) or not isinstance(draft.get("per_service"), list):
        return False, {"envelope": "fail"}
    rows = [row for row in draft["per_service"] if isinstance(row, dict)]
    by_service = {row.get("service"): row for row in rows}
    expected = _checks(policy, reports)
    details = {"schema": not list(
        __import__("jsonschema").Draft202012Validator(RELEASE_SCHEMA).iter_errors(draft))}
    for service, checks in expected.items():
        row = by_service.get(service, {})
        expected_checks = {
            field: "pass" if passed else "fail" for field, passed in checks.items()
        }
        blockers = [field for field in CHECK_NAMES if not checks[field]]
        details[service] = {
            "checks_match": row.get("checks") == expected_checks,
            "passed_match": row.get("passed") is (not blockers),
            "blockers_match": row.get("blockers") == blockers,
            "evidence_refs_match": row.get("evidence_refs") == [
                policy_ref, ARTIFACT_NAMES[service]],
        }
    blockers = [service for service, checks in expected.items() if not all(checks.values())]
    summary = draft.get("summary")
    summary_ok = (isinstance(summary, str) and summary.strip()
                  and "atlas" in summary.lower()
                  and all(service in summary.lower() for service in blockers)
                  and not any(marker in summary.lower() for marker in (
                      "customer", "user impact", "region", "data loss", "用户", "地区")))
    details["overall"] = {
        "policy_revision_match": draft.get("policy_revision") == policy["revision"],
        "overall_match": draft.get("overall") == ("hold" if blockers else "approve"),
        "blocking_services_match": draft.get("blocking_services") == blockers,
        "summary_supported": bool(summary_ok),
    }
    passed = (len(rows) == 3 and set(by_service) == set(expected)
              and details["schema"]
              and all(all(item.values()) for item in details.values()
                      if isinstance(item, dict)))
    return passed, details


def _substantive_projection(draft):
    if not isinstance(draft, dict):
        return draft
    rows = draft.get("per_service")
    projected_rows = ([
        {key: deepcopy(row.get(key)) for key in (
            "service", "checks", "passed", "blockers")}
        if isinstance(row, dict) else deepcopy(row)
        for row in rows
    ] if isinstance(rows, list) else deepcopy(rows))
    return {
        "per_service": projected_rows,
        "overall": deepcopy(draft.get("overall")),
        "blocking_services": deepcopy(draft.get("blocking_services")),
        "summary": deepcopy(draft.get("summary")),
    }


def _route_blind_quality(policy, reports, draft, *, policy_ref):
    """Apply the independent 12/12 gate without returning private criteria."""
    from experiments.strategy_checkpoint.evaluator import evaluate
    frozen_inputs = {
        "effective_policy": deepcopy(policy),
        "service_reports": deepcopy(reports),
        "evidence_refs": {
            "policy": policy_ref,
            "services": {
                service: ARTIFACT_NAMES[service]
                for service in ("atlas", "borealis", "cygnus")
            },
        },
    }
    result = evaluate("D1C-HOST-VALIDATOR", deepcopy(draft), frozen_inputs)
    passed = (result.get("passed") is True
              and result.get("score") == 12
              and result.get("score_possible", result.get("total")) == 12)
    return passed, _sha_value(result)


def validate_release_draft(arguments, context):
    """Host deterministic base/update checker; no route expectation is accepted."""
    del context
    required = {"base_policy", "policy_update", "service_reports", "draft", "fault"}
    if not isinstance(arguments, dict) or set(arguments) != required:
        raise ValueError("D1-C validator requires the exact frozen input envelope")
    base = deepcopy(arguments["base_policy"])
    update = deepcopy(arguments["policy_update"])
    reports = deepcopy(arguments["service_reports"])
    draft = deepcopy(arguments["draft"])
    fault = deepcopy(arguments["fault"])
    base_diagnostic_passed, base_checks = _draft_matches(
        base, reports, draft, policy_ref=ARTIFACT_NAMES["base_policy"])
    base_passed, base_quality_digest = _route_blind_quality(
        base, reports, draft, policy_ref=ARTIFACT_NAMES["base_policy"])
    if base_passed != base_diagnostic_passed:
        base_checks["independent_quality_disagreement"] = True
    changed_fields = [
        field for field in (
            "revision", "service_pass_requires.tests_passed",
            "service_pass_requires.coverage_at_least",
            "service_pass_requires.open_sev1",
            "service_pass_requires.open_sev2",
            "service_pass_requires.rollback_minutes_at_most",
            "service_pass_requires.evidence_age_hours_at_most", "overall_rule",
        )
        if ((base.get(field) != update.get(field)) if "." not in field else
            base["service_pass_requires"].get(field.rsplit(".", 1)[1])
            != update["service_pass_requires"].get(field.rsplit(".", 1)[1]))
    ]
    publishable = deepcopy(draft)
    if isinstance(publishable, dict):
        publishable["policy_revision"] = update.get("revision")
        for row in publishable.get("per_service", []):
            if isinstance(row, dict) and row.get("service") in reports:
                row["evidence_refs"] = [
                    ARTIFACT_NAMES["policy_update"], ARTIFACT_NAMES[row["service"]],
                ]
    update_diagnostic_passed, update_checks = _draft_matches(
        update, reports, publishable, policy_ref=ARTIFACT_NAMES["policy_update"])
    update_passed, updated_quality_digest = _route_blind_quality(
        update, reports, publishable, policy_ref=ARTIFACT_NAMES["policy_update"])
    if update_passed != update_diagnostic_passed:
        update_checks["independent_quality_disagreement"] = True
    substantive_unchanged = (
        _substantive_projection(draft) == _substantive_projection(publishable))
    if not substantive_unchanged:
        raise ValueError("Metadata normalization changed substantive review fields")
    evidence_refs = [
        ARTIFACT_NAMES["base_policy"], ARTIFACT_NAMES["policy_update"],
        ARTIFACT_NAMES["atlas"], ARTIFACT_NAMES["borealis"],
        ARTIFACT_NAMES["cygnus"],
    ]
    if not base_passed:
        verdict = "precondition_failure"
        feedback = {
            "verdict": verdict, "changed_fields": changed_fields,
            "failed_checks": base_checks, "evidence_refs": evidence_refs,
        }
    elif fault.get("feedback_domain") == "infrastructure":
        verdict = "infrastructure"
        feedback = {
            "verdict": verdict, "failure_domain": "infrastructure",
            "changed_fields": changed_fields, "failed_checks": {},
            "evidence_refs": evidence_refs,
        }
    elif update_passed:
        verdict = "compatible"
        feedback = {
            "verdict": verdict, "changed_fields": changed_fields,
            "failed_checks": {}, "evidence_refs": evidence_refs,
        }
    else:
        verdict = "material_protocol_gap"
        feedback = {
            "verdict": verdict, "failure_domain": "protocol",
            "changed_fields": changed_fields, "failed_checks": update_checks,
            "evidence_refs": evidence_refs,
        }
    return {
        "verdict": verdict,
        "base_policy_digest": _sha_value(base),
        "updated_policy_digest": _sha_value(update),
        "draft_digest": _sha_value(draft),
        "base_quality_digest": base_quality_digest,
        "updated_quality_digest": updated_quality_digest,
        "base_passed": base_passed,
        "updated_passed": update_passed,
        "base_checks": base_checks,
        "updated_checks": update_checks,
        "changed_fields": changed_fields,
        "evidence_refs": evidence_refs,
        "feedback": feedback,
        "publishable_draft": publishable,
        "normalization": {
            "allowed_fields": ["policy_revision", "per_service.*.evidence_refs.0"],
            "before_digest": _sha_value(draft),
            "after_digest": _sha_value(publishable),
            "changed_fields": ["policy_revision", "per_service.*.evidence_refs.0"],
            "substantive_before_digest": _sha_value(_substantive_projection(draft)),
            "substantive_after_digest": _sha_value(_substantive_projection(publishable)),
            "substantive_unchanged": substantive_unchanged,
        },
    }


def validator_tool():
    return ToolSpec(
        VALIDATOR_TOOL,
        {"type": "object", "additionalProperties": True},
        {"type": "object", "required": [
            "verdict", "base_policy_digest", "updated_policy_digest", "draft_digest",
            "base_quality_digest", "updated_quality_digest",
            "base_passed", "updated_passed", "base_checks", "updated_checks",
            "changed_fields", "evidence_refs", "feedback", "publishable_draft",
            "normalization",
        ]},
        "local_compute",
        validate_release_draft,
        description="Deterministically compare a draft under base and updated policy.",
        work_units_per_call=1,
    )


def _workflow():
    read_nodes = [{
        "id": "read_" + name,
        "method": "skill", "component_ref": "artifact-reader-skill",
        "params": {"name": "artifact_reader"},
        "bindings": {"payload": {
            "input_refs": {"$input": "input_refs"}, "name": ARTIFACT_NAMES[name],
        }},
    } for name in ("atlas", "borealis", "cygnus")]
    nodes = [{
        "id": "read_base_policy", "method": "skill",
        "component_ref": "artifact-reader-skill",
        "params": {"name": "artifact_reader"},
        "bindings": {"payload": {
            "input_refs": {"$input": "input_refs"},
            "name": ARTIFACT_NAMES["base_policy"],
        }},
    }, *read_nodes, {
        "id": "draft_review", "method": "ask",
        "role_ref": "release_drafter", "component_ref": "release-drafter-role",
        "params": {"max_tokens": 3500},
        "bindings": {"payload": {
            "schema": "nexgent.d1c-release-draft-request.v1",
            "base_policy": {"$node": "read_base_policy.content"},
            "service_reports": {
                name: {"$node": f"read_{name}.content"}
                for name in ("atlas", "borealis", "cygnus")
            },
            "deliverable_schema": {"$input": "deliverables.0.schema"},
        }},
    }, {
        "id": "publish_draft", "method": "publish",
        "params": {"name": "release_review.draft.json"},
        "bindings": {"content": {"$node": "draft_review"}},
    }, {
        "id": "read_policy_update", "method": "skill",
        "component_ref": "artifact-reader-skill",
        "params": {"name": "artifact_reader"},
        "bindings": {"payload": {
            "input_refs": {"$input": "input_refs"},
            "name": ARTIFACT_NAMES["policy_update"],
        }},
    }, {
        "id": "read_fault", "method": "skill",
        "component_ref": "artifact-reader-skill",
        "params": {"name": "artifact_reader"},
        "bindings": {"payload": {
            "input_refs": {"$input": "input_refs"},
            "name": ARTIFACT_NAMES["fault"],
        }},
    }, {
        "id": "read_published_draft", "method": "read_artifact",
        "bindings": {"artifact_id": {"$node": "publish_draft.id"}},
    }, {
        "id": "validate_update", "method": "tool",
        "params": {"name": VALIDATOR_TOOL},
        "bindings": {"arguments": {
            "base_policy": {"$node": "read_base_policy.content"},
            "policy_update": {"$node": "read_policy_update.content"},
            "service_reports": {
                name: {"$node": f"read_{name}.content"}
                for name in ("atlas", "borealis", "cygnus")
            },
            "draft": {"$node": "read_published_draft.content"},
            "fault": {"$node": "read_fault.content"},
        }},
    }, {
        "id": "publish_final", "method": "publish",
        "params": {"name": "release_review.json", "schema": RELEASE_SCHEMA},
        "bindings": {"content": {"$node": "validate_update.publishable_draft"}},
    }]
    return {
        "nodes": nodes,
        "control_edges": [
            *[{"from": "read_base_policy", "to": "draft_review"}],
            *[{"from": f"read_{name}", "to": "draft_review"}
              for name in ("atlas", "borealis", "cygnus")],
            {"from": "draft_review", "to": "publish_draft"},
            {"from": "publish_draft", "to": "read_policy_update"},
            {"from": "publish_draft", "to": "read_fault"},
            {"from": "publish_draft", "to": "read_published_draft"},
            {"from": "read_policy_update", "to": "validate_update"},
            {"from": "read_fault", "to": "validate_update"},
            {"from": "read_published_draft", "to": "validate_update"},
            {"from": "validate_update", "to": "publish_final"},
        ],
        "outputs": {
            "deliverables": {"release_review.json": {"$node": "publish_final.id"}},
            "summary": "Validated the draft against the policy update.",
        },
        "strategy_checkpoint_rules": [{
            "id": "policy-update-feedback",
            "after_node": "validate_update",
            "feedback_path": "feedback",
        }],
    }


def framework_package():
    workflow = _workflow()
    files = {
        "agent/recovery.py": ENTRY_SOURCE,
        "skills/artifact_reader.py": ARTIFACT_READER_SOURCE,
        "workflows/release_checkpoint.json": _canonical(workflow),
        "prompts/draft.md": DRAFT_PROMPT,
        "prompts/checkpoint_selector.md": SELECTOR_PROMPT,
        "prompts/repair.md": REPAIR_PROMPT,
        "prompts/reviewer.md": REVIEW_PROMPT,
    }
    manifest = {
        "manifest_version": 2,
        "entries": {ENTRY: "agent/recovery.py:execute"},
        "skills": {
            "artifact_reader": {
                "kind": "controlled_code",
                "ref": "skills/artifact_reader.py:read_named_artifact",
                "input_schema": {
                    "type": "object", "required": ["input_refs", "name"],
                },
                "output_schema": {"type": "object", "required": ["id", "content"]},
                "allowed_rpc_methods": ["read_artifact"],
                "allowed_tools": [],
            },
        },
        "roles": {
            "release_drafter": {
                "prompt_ref": "prompts/draft.md", "capabilities": ["ask"],
            },
            "release_repair": {
                "prompt_ref": "prompts/repair.md", "capabilities": ["ask"],
            },
            "release_reviewer": {
                "prompt_ref": "prompts/reviewer.md", "capabilities": ["ask"],
            },
            "checkpoint_selector": {
                "prompt_ref": "prompts/checkpoint_selector.md", "capabilities": ["ask"],
            },
        },
        "workflows": {"release_checkpoint": {
            "ref": "workflows/release_checkpoint.json", "max_parallel": 4,
            "input_schema": {"type": "object"}, "output_schema": {"type": "object"},
        }},
        "components": {
            DAG_COMPONENT_ID: {
                "class": "O", "kind": "workflow", "ref": "release_checkpoint",
            },
            ENTRY_COMPONENT_ID: {"class": "O", "kind": "entry", "ref": ENTRY},
            "release-drafter-role": {
                "class": "S", "kind": "role", "ref": "release_drafter",
            },
            "artifact-reader-skill": {
                "class": "S", "kind": "skill", "ref": "artifact_reader",
            },
            SELECTOR_COMPONENT_ID: {
                "class": "S", "kind": "role", "ref": "checkpoint_selector",
            },
        },
        "orchestrator": DAG_COMPONENT_ID,
        "strategy_candidates": {
            "schema": CANDIDATE_SET_SCHEMA,
            "component_ids": [DAG_COMPONENT_ID, ENTRY_COMPONENT_ID],
            "selector_component_id": SELECTOR_COMPONENT_ID,
        },
    }
    return make_package(files, manifest, provenance={
        "origin": "nexgent.d1c-preregistered-framework",
        "scope": "task-agnostic checkpoint mechanism in the frozen release-review setting",
    })


def strategy_start():
    return {
        "schema": STRATEGY_START_SCHEMA,
        "policy_id": POLICY_ID,
        "selected_component_id": DAG_COMPONENT_ID,
    }


def _models_path(root):
    paths = [root / "models.json", root / ".nexgent" / "models.json"]
    return next((path for path in paths if path.is_file()), None)


def _normalized_endpoint(value):
    parsed = urlsplit(value.strip())
    if (parsed.scheme.lower() != "https"
            or parsed.hostname != "token-plan-cn.xiaomimimo.com"
            or parsed.username is not None or parsed.password is not None
            or parsed.query or parsed.fragment or parsed.port not in (None, 443)
            or parsed.path.rstrip("/") != "/v1"):
        raise ModelConfigurationError("MiMo endpoint differs from the preregistration")
    return EXPECTED_ENDPOINT


def _load_profile(model_project, model):
    model_project = model_project.resolve()
    if model != EXPECTED_MODEL:
        raise ModelConfigurationError(f"The preregistered model is exactly {EXPECTED_MODEL}")
    models_path = _models_path(model_project)
    if models_path is None:
        raise ModelConfigurationError("The live probe requires a versioned models.json")
    raw = json.loads(models_path.read_text(encoding="utf-8-sig"))
    provider = raw.get("providers", {}).get("mimo")
    if not isinstance(provider, dict):
        raise ModelConfigurationError("models.json has no mimo provider")
    if provider.get("api_key") not in {"${NEXGENT_API_KEY}", "$NEXGENT_API_KEY"}:
        raise ModelConfigurationError("MiMo credential must reference NEXGENT_API_KEY")
    endpoint = _normalized_endpoint(provider.get("base_url", ""))
    profiles, _ = load_profiles(model_project)
    sources = [profile for profile in profiles.values()
               if profile.id.startswith("mimo/")
               and _normalized_endpoint(profile.base_url) == endpoint]
    if not sources:
        raise ModelConfigurationError("No configured MiMo provider profile")
    source = sources[0]
    if not source.api_key or source.api_key.startswith("$"):
        raise ModelConfigurationError("NEXGENT_API_KEY is not configured")
    if any(candidate.api_key != source.api_key for candidate in sources):
        raise ModelConfigurationError("MiMo profiles disagree on credential identity")
    profile = Profile(f"mimo/{model}", model, endpoint, source.api_key)
    identity = {
        "provider": "mimo", "base_url": endpoint, "configured_model": model,
        "profile_id": profile.id, "credential_ref": CREDENTIAL_REF,
        "credential_source_profile_id": source.id,
        "models_json_sha256": _sha_file(models_path),
    }
    return profile, identity, _sha_value(identity)


def _execution_source_hashes(repo_root):
    source_hashes = {}
    for path in sorted((repo_root / "src" / "nexgent").rglob("*.py")):
        source_hashes[path.relative_to(repo_root).as_posix()] = _sha_file(path)
    experiment = repo_root / "experiments" / "strategy_checkpoint"
    for name in ("__init__.py", "run.py", "evaluator.py"):
        path = experiment / name
        if path.is_file():
            source_hashes[path.relative_to(repo_root).as_posix()] = _sha_file(path)
    return source_hashes


def _git_identity(repo_root):
    def run(*args):
        return subprocess.run(
            ["git", *args], cwd=repo_root, check=True, capture_output=True,
            text=True, encoding="utf-8",
        ).stdout.rstrip()
    status = run("status", "--porcelain=v1", "--untracked-files=all")
    return {
        "commit": run("rev-parse", "HEAD"), "dirty": bool(status),
        "dirty_paths": [line[3:].replace("\\", "/") for line in status.splitlines()],
        "executed_source_sha256": _execution_source_hashes(repo_root),
    }


def _manifest(repo_root, package, profile_identity=None, profile_digest=None,
              preflight_result=None):
    candidates = strategy_candidate_set_from_manifest(package)
    conditions = []
    for condition_id in CONDITION_ORDER:
        spec = _condition_spec(condition_id)
        conditions.append({
            "condition_id": condition_id,
            "canonical_task_sha256": _sha_value({
                key: spec[key] for key in ("objective", "inputs", "deliverables")
            }),
            "inputs_sha256": _sha_value(spec["inputs"]),
            "fault_injection_point": spec["fault_injection_point"],
        })
    start = strategy_start()
    start_record = build_strategy_start(start, candidates)
    validator_source = "\n".join(inspect.getsource(item) for item in (
        _checks, _draft_matches, _substantive_projection, _route_blind_quality,
        validate_release_draft, validator_tool,
    ))
    evaluator_path = repo_root / "experiments" / "strategy_checkpoint" / "evaluator.py"
    body = {
        "schema": MANIFEST_SCHEMA,
        "contract_revision": "2026-09-24/D1-C.2",
        "contract_sha256": _sha_file(
            repo_root / "experiments" / "strategy_checkpoint" / "CONTRACT.md"),
        "created_at": _utc_now(),
        "git": _git_identity(repo_root),
        "package": {
            "id": package["id"], "digest": package["digest"], "entry": ENTRY,
            "entry_ref": package["manifest"]["entries"][ENTRY],
            "candidate_set": candidates,
            "workflow_sha256": _sha_value(_workflow()),
            "entry_source_sha256": _sha_value(ENTRY_SOURCE),
            "selector_prompt_sha256": _sha_value(SELECTOR_PROMPT),
            "prompt_sha256": {
                "draft": _sha_value(DRAFT_PROMPT),
                "checkpoint_selector": _sha_value(SELECTOR_PROMPT),
                "repair": _sha_value(REPAIR_PROMPT),
                "reviewer": _sha_value(REVIEW_PROMPT),
            },
        },
        "strategy_start": {
            "option": start,
            "schema": STRATEGY_START_SCHEMA,
            "option_digest": _sha_value(start),
            "record": start_record,
            "record_digest": start_record["strategy_start_digest"],
            "budget_digest": _sha_value(BUDGET),
            "constraints_digest": _sha_value(CONSTRAINTS),
            "initial_component_id": DAG_COMPONENT_ID,
            "initial_component_source_digest": next(
                row["source_digest"] for row in candidates["candidates"]
                if row["component_id"] == DAG_COMPONENT_ID),
        },
        "validator": {
            "tool": VALIDATOR_TOOL,
            "source_sha256": hashlib.sha256(validator_source.encode("utf-8")).hexdigest(),
        },
        "task": {
            "prompt_sha256": _sha_value(PUBLIC_PROMPT),
            "schema_sha256": _sha_value(RELEASE_SCHEMA),
        },
        "evaluator": {
            "source_sha256": _sha_file(evaluator_path) if evaluator_path.is_file() else None,
            "interface": "evaluate(condition_id, final_content, frozen_inputs)",
            "route_blind": True,
        },
        "conditions": conditions,
        "episode_order": list(CONDITION_ORDER),
        "model_profile": profile_identity,
        "profile_digest": profile_digest,
        "retry_policy": RETRY_POLICY,
        "budget_per_episode": BUDGET,
        "constraints_per_episode": CONSTRAINTS,
        "batch_caps": BATCH_CAPS,
        "preflight": deepcopy(preflight_result),
    }
    return {**body, "manifest_digest": _sha_value(body)}


def _identity_drift(manifest, repo_root, package, condition_id):
    """Return frozen pre-Episode identity differences without provider traffic."""
    drift = []
    current_commit = subprocess.run(
        ["git", "rev-parse", "HEAD"], cwd=repo_root, check=True,
        capture_output=True, text=True, encoding="utf-8",
    ).stdout.rstrip()
    if manifest.get("git", {}).get("commit") != current_commit:
        drift.append("git_commit")
    package_identity = manifest.get("package") or {}
    if (package_identity.get("id") != package.get("id")
            or package_identity.get("digest") != package.get("digest")):
        drift.append("package")
    candidates = strategy_candidate_set_from_manifest(package)
    if package_identity.get("candidate_set") != candidates:
        drift.append("candidate_set")
    contract_path = repo_root / "experiments" / "strategy_checkpoint" / "CONTRACT.md"
    if (not contract_path.is_file()
            or manifest.get("contract_sha256") != _sha_file(contract_path)):
        drift.append("contract")
    if (manifest.get("git", {}).get("executed_source_sha256")
            != _execution_source_hashes(repo_root)):
        drift.append("executed_source")
    evaluator_path = repo_root / "experiments" / "strategy_checkpoint" / "evaluator.py"
    evaluator_digest = _sha_file(evaluator_path) if evaluator_path.is_file() else None
    if manifest.get("evaluator", {}).get("source_sha256") != evaluator_digest:
        drift.append("evaluator")
    validator_source = "\n".join(inspect.getsource(item) for item in (
        _checks, _draft_matches, _substantive_projection, _route_blind_quality,
        validate_release_draft, validator_tool,
    ))
    if (manifest.get("validator", {}).get("source_sha256")
            != hashlib.sha256(validator_source.encode("utf-8")).hexdigest()):
        drift.append("validator")
    start_record = build_strategy_start(strategy_start(), candidates)
    if (manifest.get("strategy_start", {}).get("record") != start_record
            or manifest.get("strategy_start", {}).get("budget_digest")
            != _sha_value(BUDGET)
            or manifest.get("strategy_start", {}).get("constraints_digest")
            != _sha_value(CONSTRAINTS)
            or manifest.get("budget_per_episode") != BUDGET
            or manifest.get("constraints_per_episode") != CONSTRAINTS):
        drift.append("strategy_start")
    spec = _condition_spec(condition_id)
    task_digest = _sha_value({
        key: spec[key] for key in ("objective", "inputs", "deliverables")
    })
    frozen = {row.get("condition_id"): row
              for row in manifest.get("conditions", [])}
    if frozen.get(condition_id, {}).get("canonical_task_sha256") != task_digest:
        drift.append("task")
    if (manifest.get("task", {}).get("prompt_sha256") != _sha_value(PUBLIC_PROMPT)
            or manifest.get("task", {}).get("schema_sha256")
            != _sha_value(RELEASE_SCHEMA)):
        drift.append("task_contract")
    return sorted(set(drift))


def _transport_diagnostics(exc):
    causes, seen, current = [], set(), exc
    status, number = None, None
    while current is not None and id(current) not in seen and len(causes) < 8:
        seen.add(id(current)); causes.append(type(current).__name__[:80])
        value = getattr(current, "status_code", None)
        if type(value) is int and 100 <= value <= 599:
            status = value
        value = getattr(current, "errno", None)
        if type(value) is int and -100000 <= value <= 100000:
            number = value
        current = current.__cause__ or current.__context__
    return {"cause_types": causes, "stage": "request", "connection_phase": "unknown",
            "http_status": status, "errno": number}


def _one_attempt_transport(profile, params):
    client = None
    try:
        from openai import OpenAI
        client = OpenAI(api_key=profile.api_key, base_url=profile.base_url,
                        timeout=90, max_retries=0)
        return response_payload(client.chat.completions.create(**deepcopy(params)))
    except Exception as exc:
        raise ModelTransportError(
            "Live provider request failed; no retry was attempted",
            _transport_diagnostics(exc),
        ) from None
    finally:
        if client is not None:
            client.close()


def _gateway_factory(model_project, profile, profile_identity, profile_digest):
    def factory(reserve, stop_event):
        def audited_reserve(receipt):
            enriched = deepcopy(receipt)
            enriched["profile_identity"] = deepcopy(profile_identity)
            enriched["profile_digest"] = profile_digest
            reserve(enriched)
            observed = enriched.get("observed_provider_model")
            if observed is not None and observed != EXPECTED_MODEL:
                raise ModelConfigurationError(
                    "Observed provider model differs from the preregistration")
        gateway = ModelGateway(
            model_project,
            reserve=audited_reserve,
            stop_event=stop_event,
            timeout=90,
            transport=lambda selected, params: _one_attempt_transport(selected, params),
            max_completion_tokens=3500,
        )
        gateway.profiles = {profile.id: profile}
        gateway.defaults = {role: profile.id for role in (
            "release_drafter", "release_repair", "release_reviewer",
            "checkpoint_selector", "strategy_selector", "main", "subagent",
        )}
        return gateway
    return factory


def _service(root, gateway_factory):
    return TaskService(
        root,
        tools=ToolRegistry([validator_tool()]),
        gateway_factory=gateway_factory,
    )


def _create_episode(service, package, spec):
    return service.create(
        spec["objective"],
        inputs=spec["inputs"],
        deliverables=spec["deliverables"],
        budget=deepcopy(BUDGET),
        capabilities=[VALIDATOR_TOOL],
        constraints=deepcopy(CONSTRAINTS),
        package=package,
        strategy_start=strategy_start(),
    )


def _snapshot(service, episode_id, label):
    state = service.get_private(episode_id)
    checkpoint = state.get("strategy_checkpoint")
    return {
        "label": label, "captured_at": _utc_now(), "status": state.get("status"),
        "deadline": deepcopy(service.store.start_deadline(episode_id)),
        "usage": deepcopy(state.get("usage")),
        "checkpoint_digest": checkpoint.get("checkpoint_digest") if checkpoint else None,
        "handoff_ref": checkpoint.get("handoff_artifact", {}).get("ref") if checkpoint else None,
        "selector_call_ids": [
            row.get("call_id") for row in state.get("calls", [])
            if row.get("role") in {"checkpoint_selector", "strategy_selector"}
        ],
        "artifact_ids": [row.get("id") for row in state.get("artifacts", [])],
        "output_refs": deepcopy(state.get("output_refs", {})),
    }


def _run_recovery(root, gateway_factory, episode_id):
    service = _service(root, gateway_factory)
    original = service.store.commit_strategy_checkpoint
    tripped = {"value": False}

    def interrupt_after_commit(*args, **kwargs):
        committed = original(*args, **kwargs)
        if not tripped["value"]:
            tripped["value"] = True
            raise RuntimeError("D1-C frozen crash after checkpoint/handoff commit")
        return committed

    service.store.commit_strategy_checkpoint = interrupt_after_commit
    first = service.run(episode_id, stop_event=threading.Event())
    before = _snapshot(service, episode_id, "after-checkpoint-before-entry")
    service = _service(root, gateway_factory)
    final = service.run(episode_id, stop_event=threading.Event())
    after = _snapshot(service, episode_id, "recovered-complete")
    checks = {
        "injection_reached": first.get("status") == "failed",
        "selector_not_replayed": (len(before["selector_call_ids"]) == 1
                                  and before["selector_call_ids"] == after["selector_call_ids"]),
        "checkpoint_identity_stable": (before["checkpoint_digest"] is not None
                                       and before["checkpoint_digest"] == after["checkpoint_digest"]),
        "handoff_identity_stable": (before["handoff_ref"] is not None
                                    and before["handoff_ref"] == after["handoff_ref"]),
        "deadline_stable": before["deadline"] == after["deadline"],
        "usage_not_reset": all(
            after["usage"].get(key, 0) >= value
            for key, value in before["usage"].items()
            if type(value) in (int, float)),
        "artifacts_preserved": set(before["artifact_ids"]) <= set(after["artifact_ids"]),
        "completed": final.get("status") == "completed",
    }
    return service, final, {"before": before, "after": after,
                            "checks": checks, "passed": all(checks.values())}


def _safe_model_receipt(row):
    allowed = (
        "call_id", "episode_id", "node_id", "role", "model", "provider_model",
        "configured_provider_model", "observed_provider_model", "provider_revision",
        "profile_digest", "profile_identity", "status", "finish_reason",
        "billing_status", "started_at", "finished_at", "max_completion_tokens",
        "reserved_completion_tokens", "request_digest", "response_digest", "usage",
        "attempt_count", "transport_diagnostics",
    )
    return {key: deepcopy(row.get(key)) for key in allowed if key in row}


def _evaluate(condition_id, content, spec, evaluator=None):
    if evaluator is None:
        from experiments.strategy_checkpoint.evaluator import evaluate
        evaluator = evaluate
    frozen = _public_evaluator_inputs(spec)
    return evaluator(condition_id, deepcopy(content), frozen)


def _episode_evidence(service, condition_id, episode_id, spec, *, recovery=None,
                      evaluator=None):
    state = service.get_private(episode_id)
    output_ref = state.get("output_refs", {}).get("release_review.json")
    artifact = service.store.read(output_ref, episode_id) if output_ref else None
    evaluator_error = None
    if artifact:
        try:
            quality = _evaluate(
                condition_id, artifact["content"], spec, evaluator=evaluator)
        except Exception as exc:
            evaluator_error = f"{type(exc).__name__}: {str(exc)[:1000]}"
            quality = {
                "condition_id": condition_id, "score": 0, "total": 12,
                "score_possible": 12, "passed": False, "schema_valid": False,
                "criteria": [], "failure": "evaluator_error",
                "error": evaluator_error,
            }
    else:
        quality = {"condition_id": condition_id, "score": 0, "total": 12,
                   "score_possible": 12, "passed": False, "schema_valid": False,
                   "criteria": [], "failure": "deliverable_missing"}
    events = deepcopy(state.get("events", []))
    checkpoint = deepcopy(state.get("strategy_checkpoint"))
    validator_events = [event["content"] for event in events
                        if event.get("kind") == "tool"
                        and (event.get("content") or {}).get("name") == VALIDATOR_TOOL]
    validator_receipt = validator_events[-1] if validator_events else None
    validator_result = (validator_receipt.get("result")
                        if isinstance(validator_receipt, dict) else None)
    selector_calls = [row for row in state.get("calls", [])
                      if row.get("role") in {"checkpoint_selector", "strategy_selector"}]
    selector_rpc_journals = deepcopy(
        service.store.rpc_under(episode_id, "strategy/segments/2/"))
    start_decisions = [event["content"] for event in events
                       if event.get("kind") == "strategy_decision"]
    entered = [event["content"] for event in events
               if event.get("kind") == "strategy_entered"]
    raw_calls = deepcopy(state.get("calls", []))
    calls = [_safe_model_receipt(row) for row in raw_calls]
    remote_outcome_unknown = (
        state.get("status") == "waiting_input"
        or any(row.get("status") in {"started", "reserved"} for row in raw_calls)
        or any(row.get("error_type") == "ModelTransportError"
               and (row.get("transport_diagnostics") or {}).get(
                   "connection_phase") == "unknown"
               for row in raw_calls)
    )
    model_identity_ok = all(
        row.get("configured_provider_model") == EXPECTED_MODEL
        and row.get("observed_provider_model") in {None, EXPECTED_MODEL}
        for row in raw_calls
    )
    limits = deepcopy(state.get("budget"))
    usage = deepcopy(state.get("usage"))
    deadline = deepcopy(service.store.start_deadline(episode_id))
    active = deepcopy((state.get("execution") or {}).get("active_strategy"))
    handoff = None
    if checkpoint:
        handoff = service.store.read(checkpoint["handoff_artifact"]["ref"], episode_id)
    pending_publisher = service.store.rpc_find(episode_id, "plan/nodes/publish_final")
    failure_class = None
    if state.get("status") != "completed":
        failure_class = state.get("failure_domain") or "runtime_failure"
    elif not quality.get("passed"):
        failure_class = "quality_failure"
    return {
        "condition_id": condition_id,
        "episode_id": episode_id,
        "root_episode_id": state.get("root_episode_id"),
        "created_at": state.get("created_at"),
        "ended_at": state.get("updated_at"),
        "status": state.get("status"),
        "task_digest": _sha_value({
            key: spec[key] for key in ("objective", "inputs", "deliverables")
        }),
        "identity_digests": {
            "package": state.get("package_digest"),
            "inputs": _sha_value(spec["inputs"]),
            "prompt": _sha_value(spec["objective"]),
            "schema": _sha_value(spec["deliverables"]),
        },
        "strategy_start": deepcopy(state["task"].get("strategy_start")),
        "strategy_decisions": start_decisions,
        "strategy_checkpoint": checkpoint,
        "strategy_entered": entered,
        "active_strategy": active,
        "handoff": ({"id": handoff["id"], "content_digest": handoff["content_digest"],
                     "content": deepcopy(handoff["content"])} if handoff else None),
        "handoff_read_events": [event["content"] for event in events
                                if event.get("kind") == "artifact_read"
                                and checkpoint and (event.get("content") or {}).get("artifact_id")
                                == checkpoint["handoff_artifact"]["ref"]],
        "validator_receipt": validator_receipt,
        "validator_result": validator_result,
        "model_receipts": raw_calls,
        "model_receipt_summaries": calls,
        "model_identity_ok": model_identity_ok,
        "selector_receipt_count": len(selector_calls),
        "selector_rpc_journals": selector_rpc_journals,
        "budget": limits,
        "usage": usage,
        "deadline": deadline,
        "output_artifact": ({"id": artifact["id"],
                             "content_digest": artifact["content_digest"]}
                            if artifact else None),
        "old_pending_publisher_ran": pending_publisher is not None,
        "quality": quality,
        "evaluator_error": evaluator_error,
        "recovery": deepcopy(recovery),
        "failure": {
            "class": failure_class,
            "stage": ("evaluation" if failure_class == "quality_failure" else "runtime"),
            "remote_outcome_unknown": remote_outcome_unknown,
            "last_error": state.get("last_error"),
            "last_event": deepcopy(events[-1]) if events else None,
            "resumed": recovery is not None,
        } if failure_class else None,
        "event_ledger": events,
    }


def _result_row(evidence):
    checkpoint = evidence.get("strategy_checkpoint") or {}
    resolution = checkpoint.get("resolution") or {}
    validator = evidence.get("validator_result") or {}
    active = evidence.get("active_strategy") or {}
    usage = evidence.get("usage") or {}
    return {
        "condition": evidence["condition_id"],
        "task_digest": evidence["task_digest"],
        "start_strategy": (evidence.get("strategy_start") or {}).get(
            "selected_component_id"),
        "feedback_verdict": validator.get("verdict"),
        "selector_receipt": evidence.get("selector_receipt_count"),
        "checkpoint_action": resolution.get("action", "continue_without_selector"),
        "target_backend": active.get("backend"),
        "handoff_consumed": bool(evidence.get("handoff_read_events")),
        "model_calls": usage.get("model_calls", 0),
        "reserved_tokens": usage.get("reserved_completion_tokens", 0),
        "deadline_stable": ((evidence.get("recovery") or {}).get("checks") or {}).get(
            "deadline_stable", True),
        "artifact_digest": (evidence.get("output_artifact") or {}).get("content_digest"),
        "quality": (evidence.get("quality") or {}).get("passed", False),
        "failure_class": (evidence.get("failure") or {}).get("class"),
    }


def _batch_usage(rows):
    return {
        "episodes": len(rows),
        "started_model_calls": sum(
            len(row.get("model_receipts", [])) for row in rows),
        "completion_token_reservations": sum(
            (row.get("usage") or {}).get("reserved_completion_tokens", 0) for row in rows),
        "tool_calls": sum((row.get("usage") or {}).get("tool_calls", 0) for row in rows),
        "tool_work_units": sum(
            (row.get("usage") or {}).get("charged_tool_work_units", 0) for row in rows),
        "nodes": sum((row.get("usage") or {}).get("nodes", 0) for row in rows),
    }


def _batch_within_caps(usage):
    return all(usage[key] <= limit for key, limit in BATCH_CAPS.items())


def _batch_has_capacity(usage):
    """A new Episode may start only while every hard batch counter is below cap."""
    return all(usage[key] < limit for key, limit in BATCH_CAPS.items())


def _prestart_failure(spec, failure_class, error):
    condition_id = spec["condition_id"]
    return {
        "condition_id": condition_id, "episode_id": None, "root_episode_id": None,
        "status": "not_started",
        "task_digest": _sha_value({key: spec[key]
                                   for key in ("objective", "inputs", "deliverables")}),
        "model_receipts": [], "model_receipt_summaries": [], "usage": {},
        "quality": {"condition_id": condition_id, "score": 0, "total": 12,
                    "score_possible": 12, "passed": False,
                    "schema_valid": False, "criteria": []},
        "failure": {"class": failure_class, "stage": "pre_episode",
                    "remote_outcome_unknown": False, "last_error": error,
                    "last_event": None, "resumed": False},
    }


def run_batch(run_root, gateway_factory, *, package=None, evaluator=None,
              frozen_manifest=None, repo_root=None, identity_checker=None):
    package = framework_package() if package is None else package
    rows = []
    for index, condition_id in enumerate(CONDITION_ORDER):
        if identity_checker is not None:
            drift = list(identity_checker(condition_id))
        elif frozen_manifest is not None:
            if repo_root is None:
                raise ValueError("Frozen manifest validation requires repo_root")
            drift = _identity_drift(
                frozen_manifest, repo_root, package, condition_id)
        else:
            drift = []
        if drift:
            for remaining_id in CONDITION_ORDER[index:]:
                rows.append(_prestart_failure(
                    _condition_spec(remaining_id), "identity_drift",
                    "Frozen identity changed before Episode: " + ", ".join(drift),
                ))
            break
        if not _batch_has_capacity(_batch_usage(rows)):
            spec = _condition_spec(condition_id)
            rows.append(_prestart_failure(
                spec, "batch_budget_exhausted",
                "A batch hard cap was reached before Episode admission.",
            ))
            continue
        spec = _condition_spec(condition_id)
        service = episode = None
        try:
            service = _service(run_root, gateway_factory)
            episode = _create_episode(service, package, spec)
            recovery = None
            if condition_id == "D1C-SWITCH-RECOVERY":
                service, _, recovery = _run_recovery(
                    run_root, gateway_factory, episode["id"])
            else:
                service.run(episode["id"], stop_event=threading.Event())
            rows.append(_episode_evidence(
                service, condition_id, episode["id"], spec,
                recovery=recovery, evaluator=evaluator,
            ))
        except Exception as exc:
            error = f"{type(exc).__name__}: {str(exc)[:1200]}"
            if service is not None and episode is not None:
                try:
                    row = _episode_evidence(
                        service, condition_id, episode["id"], spec,
                        evaluator=evaluator,
                    )
                    row["failure"] = {
                        "class": "runner_failure", "stage": "runner",
                        "remote_outcome_unknown": False, "last_error": error,
                        "last_event": row.get("event_ledger", [])[-1]
                        if row.get("event_ledger") else None,
                        "resumed": condition_id == "D1C-SWITCH-RECOVERY",
                    }
                    rows.append(row)
                    continue
                except Exception:
                    pass
            rows.append({
                "condition_id": condition_id,
                "episode_id": episode.get("id") if episode else None,
                "root_episode_id": episode.get("root_episode_id") if episode else None,
                "status": "not_started" if episode is None else "runner_failed",
                "task_digest": _sha_value({key: spec[key]
                                           for key in ("objective", "inputs", "deliverables")}),
                "model_receipts": [], "usage": {},
                "quality": {"condition_id": condition_id, "score": 0, "total": 12,
                            "score_possible": 12, "passed": False,
                            "schema_valid": False, "criteria": []},
                "failure": {"class": "runner_failure", "stage": "runner",
                            "remote_outcome_unknown": False, "last_error": error,
                            "last_event": None,
                            "resumed": condition_id == "D1C-SWITCH-RECOVERY"},
            })
    return rows


class OfflineGatewayFactory:
    """Deterministic gateway double used by preflight and tests; never uses network."""

    def __init__(self):
        self.calls = []

    def __call__(self, reserve, stop_event):
        del stop_event
        owner = self

        class Gateway:
            def ask(self, role, prompt, payload=None, max_tokens=4000):
                number = len(owner.calls) + 1
                owner.calls.append({
                    "role": role, "prompt_digest": _sha_value(prompt),
                    "payload": deepcopy(payload), "max_tokens": max_tokens,
                })
                receipt = {
                    "call_id": f"d1c-offline-{number}", "role": role,
                    "model": "D1C-OFFLINE-GATEWAY-DOUBLE",
                    "configured_provider_model": "D1C-OFFLINE-GATEWAY-DOUBLE",
                    "observed_provider_model": "D1C-OFFLINE-GATEWAY-DOUBLE",
                    "status": "started", "request_digest": _sha_value({
                        "role": role, "prompt": prompt, "payload": payload,
                    }),
                    "reserved_completion_tokens": max_tokens,
                    "max_completion_tokens": max_tokens,
                    "attempt_count": 1,
                }
                reserve(receipt)
                if role == "release_drafter":
                    result = _expected_review(BASE_POLICY)
                elif role in {"checkpoint_selector", "strategy_selector"}:
                    result = {
                        "target_component_id": ENTRY_COMPONENT_ID,
                        "reason": "The host validator found a material protocol gap.",
                    }
                elif role == "release_repair":
                    result = _expected_review(_policy_update(True))
                elif role == "release_reviewer":
                    result = {"approved": True, "reason": "All updated checks match."}
                else:
                    raise AssertionError(f"Unexpected offline role: {role}")
                reserve({
                    **receipt, "status": "completed", "finish_reason": "stop",
                    "billing_status": "usage_reported", "response_digest": _sha_value(result),
                    "usage": {"prompt_tokens": 1, "completion_tokens": 1,
                              "total_tokens": 2},
                })
                return result

        return Gateway()


def _expected_review(policy, *, policy_ref=None):
    policy_ref = (ARTIFACT_NAMES["base_policy"]
                  if policy_ref is None and policy["revision"] == 1
                  else ARTIFACT_NAMES["policy_update"] if policy_ref is None
                  else policy_ref)
    checks = _checks(policy, SERVICE_REPORTS)
    rows = []
    blockers = []
    for service in ("atlas", "borealis", "cygnus"):
        service_checks = checks[service]
        failed = [name for name in CHECK_NAMES if not service_checks[name]]
        if failed:
            blockers.append(service)
        rows.append({
            "service": service,
            "checks": {name: "pass" if value else "fail"
                       for name, value in service_checks.items()},
            "passed": not failed,
            "blockers": failed,
            "evidence_refs": [policy_ref, ARTIFACT_NAMES[service]],
        })
    return {
        "policy_revision": policy["revision"],
        "per_service": rows,
        "overall": "hold" if blockers else "approve",
        "blocking_services": blockers,
        "summary": ("Hold: borealis and cygnus have policy blockers. "
                    "Atlas passes all applicable checks."),
    }


def offline_preflight(*, evaluator=None):
    package = framework_package()
    gateway = OfflineGatewayFactory()
    with tempfile.TemporaryDirectory(
            prefix="nexgent-d1c-offline-", ignore_cleanup_errors=True) as root:
        rows = run_batch(Path(root), gateway, package=package, evaluator=evaluator)
    by_id = {row["condition_id"]: row for row in rows}
    switch_ids = {"D1C-SWITCH-PRIMARY", "D1C-SWITCH-RECOVERY"}
    checks = {
        "four_rows_fixed_order": [row["condition_id"] for row in rows]
        == list(CONDITION_ORDER),
        "all_completed": all(row.get("status") == "completed" for row in rows),
        "host_start_exact": all(
            (row.get("strategy_start") or {}).get("policy_id") == POLICY_ID
            and (row.get("strategy_start") or {}).get("selected_component_id")
            == DAG_COMPONENT_ID for row in rows),
        "switch_only_on_material_gap": all(
            ((row.get("strategy_checkpoint") is not None) ==
             (row["condition_id"] in switch_ids)) for row in rows),
        "controls_never_call_selector": all(
            by_id[name].get("selector_receipt_count") == 0
            for name in ("D1C-NO-GAP", "D1C-INFRA-CONTROL")),
        "validator_once_each": all(
            (row.get("usage") or {}).get("tool_calls") == 1 for row in rows),
        "switch_handoff_first_and_rechecked": all(
            len(by_id[name].get("handoff_read_events") or []) == 2
            for name in switch_ids),
        "old_publisher_skipped_after_switch": all(
            not by_id[name].get("old_pending_publisher_ran") for name in switch_ids),
        "recovery_exactly_once": bool(
            (by_id["D1C-SWITCH-RECOVERY"].get("recovery") or {}).get("passed")),
        "all_quality_full_pass": all(
            (row.get("quality") or {}).get("passed") for row in rows),
        "episode_caps_respected": all(
            (row.get("usage") or {}).get("model_calls", 0) <= BUDGET["max_model_calls"]
            and (row.get("usage") or {}).get("reserved_completion_tokens", 0)
            <= BUDGET["max_completion_tokens"] for row in rows),
        "batch_caps_respected": _batch_within_caps(_batch_usage(rows)),
        "no_external_model_called": True,
    }
    selector_payloads = [call["payload"] for call in gateway.calls
                         if call["role"] in {"checkpoint_selector", "strategy_selector"}]
    checks["selector_projection_bounded"] = all(
        isinstance(payload.get("pending_nodes"), list)
        and isinstance(payload.get("target_entry_candidates"), list)
        for payload in selector_payloads
    )
    return {
        "passed": all(checks.values()),
        "checks": checks,
        "test_names": [
            "test_offline_batch_exercises_all_frozen_conditions",
            "test_route_blind_evaluator_boundary",
            "test_invalid_selector_has_no_fallback",
            "test_recovery_preserves_checkpoint_handoff_budget_and_deadline",
        ],
        "rows": [_result_row(row) for row in rows],
        "batch_usage": _batch_usage(rows),
        "external_model_called": False,
    }


def _write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2,
                               sort_keys=True, allow_nan=False) + "\n", encoding="utf-8")


def _prepare_run_root(value):
    if value is None:
        return Path(tempfile.mkdtemp(prefix="nexgent-d1c-checkpoint-")).resolve()
    root = value.resolve()
    if root.exists() and any(root.iterdir()):
        raise FileExistsError("--run-root must be absent or empty; evidence is append-only")
    root.mkdir(parents=True, exist_ok=True)
    return root


def _leak_free(root, serialized, secret):
    if not secret or secret in serialized:
        return False
    needle = secret.encode("utf-8")
    return all(needle not in path.read_bytes() for path in root.rglob("*") if path.is_file())


def run_live(args):
    repo_root = Path(__file__).resolve().parents[2]
    profile, profile_identity, profile_digest = _load_profile(
        args.model_project, args.model)
    preflight_result = offline_preflight()
    if not preflight_result["passed"]:
        raise RuntimeError("D1-C offline preflight failed; provider calls are forbidden")
    package = framework_package()
    manifest = _manifest(
        repo_root, package, profile_identity, profile_digest, preflight_result)
    if manifest["evaluator"]["source_sha256"] is None:
        raise RuntimeError("D1-C evaluator source is absent; provider calls are forbidden")
    run_root = _prepare_run_root(args.run_root)
    manifest_path = run_root / "run_manifest.json"
    _write_json(manifest_path, manifest)
    manifest_path.chmod(0o444)
    factory = _gateway_factory(
        args.model_project, profile, profile_identity, profile_digest)
    rows = run_batch(
        run_root, factory, package=package,
        frozen_manifest=manifest, repo_root=repo_root,
    )
    result_rows = [_result_row(row) for row in rows]
    with (run_root / "results.jsonl").open("x", encoding="utf-8") as stream:
        for row in result_rows:
            stream.write(_canonical(row) + "\n")
    evidence = {
        "schema": SCHEMA,
        "created_at": _utc_now(),
        "manifest_digest": manifest["manifest_digest"],
        "run_root": str(run_root),
        "episode_order": list(CONDITION_ORDER),
        "batch_usage": _batch_usage(rows),
        "batch_caps_respected": _batch_within_caps(_batch_usage(rows)),
        "episodes": rows,
        "result_rows": result_rows,
        "no_cherry_pick": len(rows) == 4
        and [row["condition_id"] for row in rows] == list(CONDITION_ORDER),
    }
    serialized = _canonical(evidence)
    if not _leak_free(run_root, serialized, profile.api_key):
        raise RuntimeError("Credential leak check failed; evidence was not finalized")
    _write_json(run_root / "evidence.json", evidence)
    return evidence


def preflight(args):
    repo_root = Path(__file__).resolve().parents[2]
    profile_identity = profile_digest = None
    if args.model_project is not None:
        _, profile_identity, profile_digest = _load_profile(
            args.model_project, args.model)
    offline = offline_preflight()
    manifest = _manifest(
        repo_root, framework_package(), profile_identity, profile_digest, offline)
    return {"preflight": offline, "manifest": manifest}


def _parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true",
                        help="run the frozen four-Episode live batch")
    parser.add_argument("--model-project", type=Path,
                        help="project containing the audited models.json")
    parser.add_argument("--model", default=EXPECTED_MODEL)
    parser.add_argument("--run-root", type=Path,
                        help="new empty append-only evidence directory")
    return parser


def main(argv=None):
    args = _parser().parse_args(argv)
    if args.live:
        if args.model_project is None:
            raise SystemExit("--live requires --model-project")
        result = run_live(args)
        print(json.dumps({"schema": result["schema"],
                          "run_root": result["run_root"],
                          "result_rows": result["result_rows"]},
                         ensure_ascii=False, indent=2))
        return 0
    result = preflight(args)
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if result["preflight"]["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
