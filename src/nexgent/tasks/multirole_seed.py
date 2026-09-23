"""Domain-neutral, model-driven workflow package for orchestration studies.

The package is intentionally explicit: its O workflow and S role/skill files
are separate registered components.  A benchmark adapter supplies the task and
owns evaluation; this module never imports a task domain or its answer.
"""

from __future__ import annotations

from copy import deepcopy
import json

from .packages import make_package


PREPARE_SOURCE = '''def prepare(payload, context):
    inputs = {}
    for name, artifact_id in sorted(payload.get("input_refs", {}).items()):
        artifact = context.read_artifact(artifact_id)
        inputs[name] = artifact["content"]
    return {
        "objective": payload.get("objective", ""),
        "inputs": inputs,
        "deliverables": payload.get("deliverables", []),
        "constraints": payload.get("constraints", {}),
    }
'''


PUBLISH_SOURCE = '''def publish(payload, context):
    task = payload["task"]
    decision = payload["decision"]
    if not isinstance(decision, dict):
        raise ValueError("Adjudicator must return an object")
    required = [item["name"] for item in task["deliverables"]]
    contents = decision.get("deliverables")
    if not isinstance(contents, dict) and len(required) == 1:
        # A single deliverable may be returned as direct content or as a
        # name-to-content mapping. The frozen schema resolves this ambiguity;
        # the host validates the selected content again before publication.
        name = required[0]
        schema = task["deliverables"][0].get("schema", {})
        expected_object = schema.get("type") == "object"
        if set(decision) == {name} and (
                not expected_object or isinstance(decision[name], dict)):
            contents = {name: decision[name]}
        else:
            contents = {name: decision}
    if not isinstance(contents, dict):
        raise ValueError("Adjudicator must return a deliverables object")
    if set(contents) != set(required):
        raise ValueError("Adjudicator deliverables do not match the task contract")
    refs = {}
    for name in required:
        artifact = context.publish(contents[name], name=name)
        refs[name] = artifact["id"]
    return {"deliverables": refs}
'''


PROMPTS = {
    "proposer_a": (
        "You are an independent task solver. Use only the public task inputs. "
        "Return a JSON object with a deliverables mapping from each required name "
        "to content satisfying its schema. Explain any uncertainty briefly in a "
        "separate rationale field. Do not invent artifact IDs."
    ),
    "proposer_b": (
        "You are a second independent task solver. Work from the public task "
        "inputs, not from another agent's answer. Return a JSON object with a "
        "deliverables mapping matching every required schema. Include a brief "
        "rationale field. Do not invent artifact IDs."
    ),
    "adjudicator": (
        "Compare the two independent proposals against the public task and "
        "required schemas. Resolve disagreement from the inputs. Return only a "
        "JSON object with a deliverables mapping whose keys exactly match the "
        "required names and whose values are the final artifact contents."
    ),
}


def multirole_package():
    """Return a benchmark-agnostic, three-model-role AgentPackage.

    This is a fixed baseline and an O/S evolution parent, not evidence that
    the roles improve quality.  Evaluation remains with the benchmark host.
    """
    workflow = {
        "nodes": [
            {"id": "prepare", "method": "skill", "component_ref": "prepare-skill",
             "params": {"name": "prepare"}, "bindings": {"payload": {"$input": ""}}},
            {"id": "proposer_a", "method": "ask", "role_ref": "proposer_a",
             "component_ref": "proposer-a-role", "params": {"max_tokens": 1600},
             "bindings": {"payload": {"task": {"$node": "prepare"}}}},
            {"id": "proposer_b", "method": "ask", "role_ref": "proposer_b",
             "component_ref": "proposer-b-role", "params": {"max_tokens": 1600},
             "bindings": {"payload": {"task": {"$node": "prepare"}}}},
            {"id": "adjudicator", "method": "ask", "role_ref": "adjudicator",
             "component_ref": "adjudicator-role", "params": {"max_tokens": 1600},
             "bindings": {"payload": {
                 "task": {"$node": "prepare"},
                 "proposal_a": {"$node": "proposer_a"},
                 "proposal_b": {"$node": "proposer_b"}}}},
            {"id": "publish", "method": "skill", "component_ref": "publish-skill",
             "params": {"name": "publish"}, "bindings": {"payload": {
                 "task": {"$node": "prepare"},
                 "decision": {"$node": "adjudicator"}}}},
        ],
        "outputs": {"deliverables": {"$node": "publish.deliverables"},
                    "summary": "Independent proposals were adjudicated and published."},
    }
    files = {
        "agent/main.py": (
            "def execute(payload, context):\n"
            "    raise RuntimeError('The registered workflow must execute')\n"
        ),
        "skills/prepare.py": PREPARE_SOURCE,
        "skills/publish.py": PUBLISH_SOURCE,
        "workflows/main.json": json.dumps(workflow, ensure_ascii=False, sort_keys=True),
        **{f"prompts/{name}.md": prompt for name, prompt in PROMPTS.items()},
    }
    manifest = {
        "manifest_version": 2,
        "entries": {"execute": "agent/main.py:execute"},
        "skills": {
            "prepare": {"kind": "controlled_code", "ref": "skills/prepare.py:prepare",
                        "input_schema": {"type": "object"},
                        "output_schema": {"type": "object"}},
            "publish": {"kind": "controlled_code", "ref": "skills/publish.py:publish",
                        "input_schema": {"type": "object"},
                        "output_schema": {"type": "object"}},
        },
        "roles": {
            name: {"prompt_ref": f"prompts/{name}.md", "capabilities": ["ask"]}
            for name in PROMPTS
        },
        "workflows": {"main": {"ref": "workflows/main.json",
                               "max_parallel": 2,
                               "input_schema": {"type": "object"},
                               "output_schema": {"type": "object"}}},
        "components": {
            "main-workflow": {"class": "O", "kind": "workflow", "ref": "main"},
            "prepare-skill": {"class": "S", "kind": "skill", "ref": "prepare"},
            "publish-skill": {"class": "S", "kind": "skill", "ref": "publish"},
            **{f"{name.replace('_', '-')}-role": {
                "class": "S", "kind": "role", "ref": name} for name in PROMPTS},
        },
        "orchestrator": "main-workflow",
    }
    return make_package(files, manifest, provenance={
        "origin": "nexgent.multirole-fixed-baseline",
        "scope": "domain-neutral model-driven benchmark qualification",
    })


def single_role_equal_calls_package():
    """One solver with three sequential calls and the same per-call ceiling.

    The frozen hard budget and actual usage still need checking per Episode;
    this package alone does not make a statistically fair comparison.
    """
    multi = multirole_package()
    files = deepcopy(multi["files"])
    manifest = deepcopy(multi["manifest"])
    for name in PROMPTS:
        del files[f"prompts/{name}.md"]
    files["prompts/solver.md"] = (
        "You are the only task solver. Use the public inputs and your prior "
        "drafts to verify and refine your answer. Return a JSON object with "
        "content for every required deliverable. Respect its schema; do not "
        "invent artifact IDs."
    )
    workflow = {
        "nodes": [
            {"id": "prepare", "method": "skill", "component_ref": "prepare-skill",
             "params": {"name": "prepare"}, "bindings": {"payload": {"$input": ""}}},
            {"id": "draft", "method": "ask", "role_ref": "solver",
             "component_ref": "solver-role", "params": {"max_tokens": 1600},
             "bindings": {"payload": {"task": {"$node": "prepare"}}}},
            {"id": "review", "method": "ask", "role_ref": "solver",
             "component_ref": "solver-role", "params": {"max_tokens": 1600},
             "bindings": {"payload": {"task": {"$node": "prepare"},
                                      "previous_draft": {"$node": "draft"}}}},
            {"id": "finalize", "method": "ask", "role_ref": "solver",
             "component_ref": "solver-role", "params": {"max_tokens": 1600},
             "bindings": {"payload": {"task": {"$node": "prepare"},
                                      "previous_draft": {"$node": "draft"},
                                      "review": {"$node": "review"}}}},
            {"id": "publish", "method": "skill", "component_ref": "publish-skill",
             "params": {"name": "publish"}, "bindings": {"payload": {
                 "task": {"$node": "prepare"},
                 "decision": {"$node": "finalize"}}}},
        ],
        "outputs": {"deliverables": {"$node": "publish.deliverables"},
                    "summary": "One solver drafted, reviewed, and finalized."},
    }
    files["workflows/main.json"] = json.dumps(
        workflow, ensure_ascii=False, sort_keys=True)
    manifest["roles"] = {
        "solver": {"prompt_ref": "prompts/solver.md", "capabilities": ["ask"]}}
    manifest["components"] = {
        "main-workflow": {"class": "O", "kind": "workflow", "ref": "main"},
        "prepare-skill": {"class": "S", "kind": "skill", "ref": "prepare"},
        "publish-skill": {"class": "S", "kind": "skill", "ref": "publish"},
        "solver-role": {"class": "S", "kind": "role", "ref": "solver"},
    }
    manifest["workflows"]["main"]["max_parallel"] = 1
    return make_package(files, manifest, provenance={
        "origin": "nexgent.single-role-equal-calls-baseline",
        "scope": "domain-neutral model-driven benchmark qualification",
    })
