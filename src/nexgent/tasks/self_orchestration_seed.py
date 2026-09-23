"""Opt-in, task-independent seed for model-authored execution graphs.

The seed commits only an architect barrier and a pending slot.  The architect
must choose the useful roles, operators, dependencies, joins, and outputs for
the current task; the host remains responsible for compiling and admitting the
proposed pending-graph operations.
"""

from __future__ import annotations

import json

from .packages import make_package


ARCHITECT_PROMPT = """You are the graph architect for a domain-neutral agent runtime.

Design the smallest useful execution graph for the supplied task. Select a team
topology from `available_roles`; roles are capabilities, not a mandatory cast,
and a role may be unused or instantiated more than once. Select operators only
from `available_operators`, the task's installed tools, and its registered
skills. Decide which work is independent, which evidence must flow between
nodes, where criticism or verification is useful, and when the task should
stop. Do not assume a fixed number of agents or a fixed propose-review pattern.

Return exactly one JSON object shaped as:
{"proposal":{"replaced_node_ids":["slot"],"operations":[...],"outputs":{...}}}

`operations` is an ordered list using only these forms:
- {"op":"add_node","node":{...}}
- {"op":"remove_node","node_id":"slot"}
- {"op":"replace_node","node_id":"...","node":{...}}
- {"op":"add_control_edge","edge":{"from":"...","to":"..."}}
- {"op":"remove_control_edge","edge":{...}}
- {"op":"add_artifact_edge","edge":{...}}
- {"op":"remove_artifact_edge","edge":{...}}

Every node uses `method`, never `operator`. An ask node has `id`, `method` set
to `ask`, an available `role_ref`, its matching `component_ref`, `params`, and
optional `bindings`. Put a node-specific instruction at `params.prompt`, never
at the top level of the node. Put `max_tokens` in `params`. Bind the complete
task with {"$input":""}; bind a complete prior result with
{"$node":"node_id"}, or a field with {"$node":"node_id.field"}.

Here is one complete, valid minimal response. Adapt role choice, instructions,
nodes, dependencies, deliverable names, and output shape to the actual task:
{"proposal":{"replaced_node_ids":["slot"],"operations":[
  {"op":"remove_node","node_id":"slot"},
  {"op":"add_node","node":{"id":"worker","method":"ask","role_ref":"generalist","component_ref":"generalist-role","params":{"max_tokens":1200,"prompt":"Solve the supplied task and return the requested result as JSON."},"bindings":{"payload":{"task":{"$input":""}}}}},
  {"op":"add_node","node":{"id":"publish","method":"publish","params":{"name":"result"},"bindings":{"content":{"$node":"worker"}}}},
  {"op":"add_control_edge","edge":{"from":"architect","to":"worker"}}
],"outputs":{"deliverables":{"result":{"$node":"publish.id"}}},"revision_rules":[]}}

Preserve the completed `architect` node and remove `slot`. Every added ask node
must name one available `role_ref` and its matching `component_ref`. Use
bindings and artifact edges to pass actual results rather than describing a
conversation in prose. Connect each new branch to the boundary at `architect`,
directly or through another new node. Set `outputs` to the final workflow output
bindings and make the deliverables match the task contract. The host will bind
the current base plan reference and will reject cycles, unavailable tools or
skills, unregistered roles, excessive work, and changes outside the pending
scope.

Prefer bindings for ordinary JSON results. Omit artifact-edge operations unless
both nodes expose real ports. A valid artifact edge has exactly
`producer_node`, `output_port`, `consumer_node`, and `input_port`, plus optional
`schema_ref`; its port paths do not use `$node` syntax.

When intermediate evidence may justify replanning, the proposal may also carry
`revision_rules`. Such a checkpoint must run before the subgraph it may replace,
emit another proposal under its declared `proposal_path`, and leave the graph a
DAG for each admitted revision. Set `revision_rules` to an empty list when no
future checkpoint is useful, so the bootstrap rule is not retained. Prefer
direct execution for simple tasks and add agents or checkpoints only when their
expected value exceeds their cost.

If the host supplies compiler feedback after rejecting a proposal, repair every
reported contract error and return the complete JSON object again, including a
full replacement `proposal`; never return a partial patch or prose explanation.
"""


GENERIC_ROLE_PROMPTS = {
    "generalist": (
        "Solve the assigned part of the task from the supplied evidence. Return "
        "a compact JSON object with the result, reasoning summary, and uncertainty."
    ),
    "investigator": (
        "Inspect the assigned question or evidence gap. Return a JSON object with "
        "findings, evidence, open questions, and confidence."
    ),
    "operator": (
        "Plan or interpret tool-backed work for the assigned task. Use only supplied "
        "tool results as evidence and return a JSON object with result and failures."
    ),
    "critic": (
        "Challenge the supplied candidate against the objective and constraints. "
        "Return a JSON object with concrete findings and bounded repairs."
    ),
    "verifier": (
        "Verify the supplied candidate and evidence against the requested contract. "
        "Return a JSON object with passed, checks, findings, and confidence."
    ),
    "synthesizer": (
        "Integrate the supplied candidate results and evidence without hiding "
        "disagreement. Return a JSON object suitable for final publication."
    ),
}


AVAILABLE_OPERATORS = (
    "ask", "tool", "skill", "delegate", "read_artifact", "publish",
    "memory_search", "remember", "feedback", "parallel", "join", "loop",
)


def self_orchestration_package():
    """Return the opt-in seed whose task-time topology is model-authored."""
    available_roles = [
        {
            "role_ref": name,
            "component_ref": f"{name}-role",
            "purpose": prompt.split(". ", 1)[0] + ".",
        }
        for name, prompt in GENERIC_ROLE_PROMPTS.items()
    ]
    workflow = {
        "nodes": [
            {
                "id": "architect",
                "method": "ask",
                "role_ref": "architect",
                "component_ref": "architect-role",
                "params": {"max_tokens": 5000},
                "bindings": {
                    "payload": {
                        "task": {"$input": ""},
                        "available_roles": available_roles,
                        "available_operators": list(AVAILABLE_OPERATORS),
                    },
                },
            },
            {"id": "slot", "method": "join"},
        ],
        "control_edges": [{"from": "architect", "to": "slot"}],
        "revision_rules": [
            {
                "id": "architect-graph",
                "after_node": "architect",
                "when": {"path": "$status", "equals": "completed"},
                "proposal_path": "proposal",
                "max_compile_attempts": 3,
            },
        ],
        "outputs": {"deliverables": {"$node": "slot"}},
    }

    role_prompts = {"architect": ARCHITECT_PROMPT, **GENERIC_ROLE_PROMPTS}
    files = {
        "agent/main.py": (
            "def execute(payload, context):\n"
            "    raise RuntimeError('The registered workflow must execute')\n"
        ),
        "workflows/main.json": json.dumps(
            workflow, ensure_ascii=False, sort_keys=True),
        **{f"prompts/{name}.md": prompt
           for name, prompt in role_prompts.items()},
    }
    manifest = {
        "manifest_version": 2,
        "entries": {"execute": "agent/main.py:execute"},
        "skills": {},
        "roles": {
            name: {
                "prompt_ref": f"prompts/{name}.md",
                "capabilities": ["ask"],
            }
            for name in role_prompts
        },
        "workflows": {
            "main": {
                "ref": "workflows/main.json",
                "max_parallel": 8,
                "input_schema": {"type": "object"},
                "output_schema": {"type": "object"},
            },
        },
        "components": {
            "self-orchestration-workflow": {
                "class": "O", "kind": "workflow", "ref": "main",
            },
            **{
                f"{name}-role": {
                    "class": "S", "kind": "role", "ref": name,
                }
                for name in role_prompts
            },
        },
        "orchestrator": "self-orchestration-workflow",
    }
    return make_package(files, manifest, provenance={
        "origin": "nexgent.self-orchestration-seed",
        "scope": "domain-neutral task-time graph construction",
        "activation": "opt-in",
    })
