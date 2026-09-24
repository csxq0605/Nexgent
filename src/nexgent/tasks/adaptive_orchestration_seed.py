"""Pre-selection seed containing both existing task execution strategies.

This module deliberately does not select a strategy.  It assembles the real
open-loop entry from :mod:`nexgent.tasks.seed` and the real Main workflow from
:mod:`nexgent.tasks.self_orchestration_seed` into one manifest-v2 package.  The
legacy ``orchestrator`` remains the workflow, so existing TaskService behavior
is unchanged until a later host-side StrategyDecision implementation exists.
"""

from __future__ import annotations

from copy import deepcopy

from .packages import PackageError, make_package, split_ref, verify_package
from .seed import default_package
from .self_orchestration_seed import self_orchestration_package
from .strategy_decisions import CANDIDATE_SET_SCHEMA, build_strategy_candidate_set
from .tools import ContractError


STRATEGY_CANDIDATE_SET_SCHEMA = CANDIDATE_SET_SCHEMA
OPEN_LOOP_COMPONENT_ID = "ordinary-open-loop"
MAIN_DAG_COMPONENT_ID = "self-orchestration-workflow"


def _merge_unique(target, additions, label):
    """Merge a registry or file tree without resolving conflicts implicitly."""
    for name, value in additions.items():
        if name in target and target[name] != value:
            raise PackageError(f"Adaptive seed has conflicting {label}: {name!r}")
        target[name] = deepcopy(value)


def strategy_candidate_bindings(package):
    """Resolve the frozen candidate IDs to authoritative component identities.

    This is structural validation only.  It does not claim that a selector or
    per-task StrategyDecision exists, and it never falls back to
    ``manifest.orchestrator`` when candidate metadata is malformed.
    """
    verify_package(package)
    manifest = package["manifest"]
    candidate_set = manifest.get("strategy_candidates")
    if (not isinstance(candidate_set, dict)
            or set(candidate_set) != {"schema", "component_ids"}
            or candidate_set.get("schema") != STRATEGY_CANDIDATE_SET_SCHEMA):
        raise PackageError("Adaptive seed needs an exact versioned strategy candidate set")
    component_ids = candidate_set.get("component_ids")
    if (not isinstance(component_ids, list) or len(component_ids) < 2
            or any(not isinstance(item, str) for item in component_ids)
            or len(component_ids) != len(set(component_ids))):
        raise PackageError("Strategy candidate IDs must be a unique list")
    try:
        candidates = build_strategy_candidate_set(package, component_ids)["candidates"]
    except ContractError as exc:
        raise PackageError("Strategy candidate: " + str(exc)) from exc
    fields = ("component_id", "kind", "ref", "source_path", "source_digest")
    return [{key: candidate[key] for key in fields} for candidate in candidates]


def adaptive_orchestration_package(*, open_loop_package=None, main_dag_package=None):
    """Return a manifest-v2 package with real code and DAG O components.

    Optional package arguments exist for focused construction tests.  Every
    collision is rejected unless the complete value is identical.
    """
    open_loop = default_package() if open_loop_package is None else open_loop_package
    main_dag = (
        self_orchestration_package()
        if main_dag_package is None else main_dag_package
    )
    verify_package(open_loop)
    verify_package(main_dag)

    open_manifest = open_loop["manifest"]
    dag_manifest = main_dag["manifest"]
    if open_manifest.get("manifest_version", 1) != 1:
        raise PackageError("Adaptive seed expects the existing manifest-v1 open-loop package")
    if dag_manifest.get("manifest_version") != 2:
        raise PackageError("Adaptive seed expects the existing manifest-v2 Main DAG package")
    if set(open_manifest["entries"]) != {"execute"}:
        raise PackageError("Adaptive seed open-loop package must expose only execute")

    dag_orchestrator = dag_manifest.get("orchestrator")
    dag_component = dag_manifest.get("components", {}).get(dag_orchestrator)
    if (dag_orchestrator != MAIN_DAG_COMPONENT_ID
            or not isinstance(dag_component, dict)
            or dag_component.get("class") != "O"
            or dag_component.get("kind") != "workflow"):
        raise PackageError("Adaptive seed requires the existing Main workflow orchestrator")

    open_entry_ref = open_manifest["entries"]["execute"]
    dag_entry_ref = dag_manifest["entries"].get("execute")
    if dag_entry_ref != open_entry_ref:
        raise PackageError("Adaptive seed entry references disagree")
    open_source_path, _ = split_ref(open_entry_ref, open_loop["files"])
    dag_placeholder_path, _ = split_ref(dag_entry_ref, main_dag["files"])
    if open_source_path != dag_placeholder_path:
        raise PackageError("Adaptive seed entry source paths disagree")

    # Start with every real open-loop program/resource.  The DAG package's
    # execute file is intentionally excluded: it is a guard placeholder, not a
    # strategy candidate.  All other DAG resources merge fail closed.
    files = deepcopy(open_loop["files"])
    dag_resources = {
        path: content for path, content in main_dag["files"].items()
        if path != dag_placeholder_path
    }
    _merge_unique(files, dag_resources, "package file")

    skills = deepcopy(open_manifest.get("skills", {}))
    _merge_unique(skills, dag_manifest.get("skills", {}), "skill name")
    components = deepcopy(dag_manifest["components"])
    if OPEN_LOOP_COMPONENT_ID in components:
        raise PackageError(
            f"Adaptive seed has conflicting component id: {OPEN_LOOP_COMPONENT_ID!r}")
    components[OPEN_LOOP_COMPONENT_ID] = {
        "class": "O", "kind": "entry", "ref": "execute",
    }
    for skill_name in open_manifest.get("skills", {}):
        component_id = f"default-{skill_name}-skill"
        component = {"class": "S", "kind": "skill", "ref": skill_name}
        if component_id in components and components[component_id] != component:
            raise PackageError(
                f"Adaptive seed has conflicting component id: {component_id!r}")
        components[component_id] = component

    manifest = {
        "manifest_version": 2,
        "entries": deepcopy(open_manifest["entries"]),
        "skills": skills,
        "roles": deepcopy(dag_manifest["roles"]),
        "workflows": deepcopy(dag_manifest["workflows"]),
        "components": components,
        # Compatibility default only.  This field is not a task-time choice.
        "orchestrator": dag_orchestrator,
        "strategy_candidates": {
            "schema": STRATEGY_CANDIDATE_SET_SCHEMA,
            "component_ids": [OPEN_LOOP_COMPONENT_ID, MAIN_DAG_COMPONENT_ID],
        },
    }
    for registry in ("tools", "services"):
        combined = deepcopy(open_manifest.get(registry, {}))
        _merge_unique(combined, dag_manifest.get(registry, {}), registry[:-1] + " name")
        if combined:
            manifest[registry] = combined

    package = make_package(files, manifest, provenance={
        "origin": "nexgent.adaptive-orchestration-seed",
        "scope": "pre-selection package with frozen open-loop and Main DAG candidates",
        "activation": "opt-in; task-time selection is not implemented",
        "sources": {
            "open_loop": {"id": open_loop["id"], "digest": open_loop["digest"]},
            "main_dag": {"id": main_dag["id"], "digest": main_dag["digest"]},
        },
    })
    strategy_candidate_bindings(package)
    return package
