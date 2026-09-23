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

Design the smallest useful execution graph for the supplied task. You may use
`available_roles` or define task-specific roles whose identities and prompts
fit this task; the available roles are capabilities, not a mandatory cast, and
a role may be unused or instantiated more than once. Select operators only
from `available_operators`, the task's installed tools, and its registered
skills. Decide which work is independent, which evidence must flow between
nodes, where criticism or verification is useful, and when the task should
stop. Do not assume a fixed number of agents or a fixed propose-review pattern.

Return exactly one JSON object shaped as:
{"proposal":{"replaced_node_ids":["slot"],"task_roles":{...},"operations":[...],"outputs":{...}}}

`operations` is an ordered list using only these forms:
- {"op":"add_node","node":{...}}
- {"op":"remove_node","node_id":"slot"}
- {"op":"replace_node","node_id":"...","node":{...}}
- {"op":"add_control_edge","edge":{"from":"...","to":"..."}}
- {"op":"remove_control_edge","edge":{...}}
- {"op":"add_artifact_edge","edge":{...}}
- {"op":"remove_artifact_edge","edge":{...}}

Every node uses `method`, never `operator`. An ask node has `id`, `method` set
to `ask`, `role_ref`, `params`, and optional `bindings`. For an available role,
use its matching `component_ref`. To create a role for this task, add an entry
to top-level `task_roles`, for example
`"evidence_skeptic":{"identity":"Evidence skeptic","prompt":"Test the supplied claims against the evidence and return JSON.","capabilities":["ask"]}`,
then use `"role_ref":"task:evidence_skeptic"` and omit `component_ref`; the
host will assign immutable role and component identities. Task roles can only
call `ask`; their count shares the workflow's 256-node scale and a separate
registry text budget. Put `max_tokens` in `params`. An ask
node may pass only `role`, `prompt`, `payload`, and `max_tokens` to the model;
put task data beneath `bindings.payload`, not directly in `bindings`. Bind the
complete task with {"$input":""}; bind a complete prior result with
{"$node":"node_id"}, or a field with {"$node":"node_id.field"}.
For a task-created role, its declared `task_roles.<alias>.prompt` is frozen as
the node prompt. Omit `params.prompt` on every node that uses `task:<alias>`;
put node-specific context in `bindings.payload`. Supplying a different
`params.prompt` is a contract error and cannot override the role definition.

`available_skills` lists installed skills with `name`, `component_ref`, kind,
and input/output schemas. When one fits the task, add a `skill` node using the
listed `component_ref`, put its `name` in `params.name`, and bind the requested
payload. Do not recreate an installed skill or invent its component identity.

The task payload also contains the current `tools` inventory and, when the
Episode has service authority, the single `services.model_context.v1` slot.
`develop_service` source receives `provide(request, context)` where request
has `schema`, `role`, `node_id`, and `payload`. Copy `request['payload']`
and add context fields; keep every existing top-level field and value intact.
Returning only criteria or annotations drops task evidence and is rejected.
For graph bindings, use the equivalent path-safe
`{"$input":"model_context_service.revision"}`; the dotted interface key
itself cannot be addressed with the dot-separated binding syntax.
`task.input_refs` contains artifact IDs, not the artifacts' JSON contents.
When a worker or service needs actual input data, add a `read_artifact` node
with `artifact_id` bound from `{"$input":"input_refs.<name>"}`, then bind
its `{"$node":"<read_node>.content"}` into the later ask/tool payload.
Never treat an artifact ID as option values, measurements, or task evidence.
Verifier nodes must receive the same read content, not just a candidate
answer; do not invent measurements absent from the read artifact.
Capability-development operators are admitted only when the Episode authority
grants their kind and effect. These host nodes omit `role_ref` and
`component_ref`, execute serially, and use these exact argument contracts:
- `develop_tool`: `proposal` with exactly `name`, `description`, `source`,
  `input_schema`, and `output_schema`; source defines
  `execute(payload, context)` and cannot use `context`.
- `develop_service`: `proposal` with exactly `name`, `description`, and
  `source`; source defines `provide(payload, context)`, cannot use `context`,
  and returns exactly `payload` plus an `annotations` object.
- `activate_service`: `definition_id` and the service slot's
  `expected_revision`.
- `release_service`: the service slot's `expected_revision`.
- `capability_inventory`: no arguments.

`develop_tool` returns `name` and mounts that task-local tool immediately. A
later `tool` node may bind `name` from that receipt and bind or set
`arguments`; the host still verifies the active Definition and Instance at
execution. `develop_service` only stages a Definition, so bind its
`definition_id` into `activate_service`. Only later `ask` nodes observe the
activated provider. Use control edges or result bindings to keep lifecycle
nodes ordered, and never put development, activation, or release in a
parallel branch. Creating either capability consumes the Episode's bounded
definition and invocation authority; use it only for a task-grounded missing
capability whose effect can be checked downstream.

A valid tool development chain has this shape (proposal fields abbreviated):
`develop_tool(proposal) -> tool(name=$node.develop.name, arguments=...)`.
A valid service chain has this shape:
`develop_service(proposal) -> activate_service(definition_id=$node.develop.definition_id,
expected_revision=$input.model_context_service.revision) -> ask`.

Here is one complete, valid minimal response. Adapt role choice, instructions,
nodes, dependencies, deliverable names, and output shape to the actual task:
{"proposal":{"replaced_node_ids":["slot"],"operations":[
  {"op":"remove_node","node_id":"slot"},
  {"op":"add_node","node":{"id":"worker","method":"ask","role_ref":"generalist","component_ref":"generalist-role","params":{"max_tokens":1200,"prompt":"Solve the supplied task and return the requested result as JSON."},"bindings":{"payload":{"task":{"$input":""}}}}},
  {"op":"add_node","node":{"id":"publish","method":"publish","params":{"name":"result"},"bindings":{"content":{"$node":"worker"}}}},
  {"op":"add_control_edge","edge":{"from":"architect","to":"worker"}}
],"outputs":{"deliverables":{"result":{"$node":"publish.id"}}},"revision_rules":[]}}

If a missing reusable capability is worth creating during this task, add an
`ask` node whose prompt requests a JSON `task-skill-proposal`, then a
`develop_skill` node, then a `delegate` node. The proposal must have `schema`
`nexgent.task-skill-proposal.v1`, `skill` with `name`, `entrypoint`, Python
`source` defining `entrypoint(payload, context)`, `input_schema`, and
`output_schema`, `deliverable_name`, and `hypothesis` with
`failure_mechanism`, `expected_behavior`, `applicability`, and `falsifier`.
The proposal envelope is exact: use `schema`, not `schema_version`; use
`skill.source`, not `skill.python_source`; keep both schemas inside `skill`.
No extra top-level keys are accepted. A valid coder output has this shape:
{"schema":"nexgent.task-skill-proposal.v1","skill":{"name":"transform",
"entrypoint":"solve","source":"def solve(payload, context):\\n    return {'answer': 1}\\n",
"input_schema":{"type":"object"},"output_schema":{"type":"object"}},
"deliverable_name":"result","hypothesis":{"failure_mechanism":"missing transform",
"expected_behavior":"computed result","applicability":"same input shape",
"falsifier":"wrong output"}}.
The host binds `parent_package_digest`; do not invent it. Give the coder the
task and exact proposal contract in `params.prompt`. Bind its entire JSON
result to `develop_skill` as `{"proposal":{"$node":"coder"}}` and set
`params.constraints` to the minimum required `allowed_rpc_methods`,
`allowed_tools`, and `max_patch_bytes`. These are host RPC method names, not
Python libraries: pure computation needs `allowed_rpc_methods:[]`;
`context.read_artifact` needs `["read_artifact"]`. Never name `python` as an RPC
method. To let the compiler return a rejected proposal to a model, also set
`params.repair` to `{"role":"generalist","max_attempts":2,"max_tokens":1200}`
using an ask-capable available role. The attempt bound includes the coder's
initial proposal. Repair receives the same TaskSpec, the full prior proposal,
and the compiler diagnostic, and must return a corrected full proposal. Omit
`repair` when no model repair call is authorized. For a child that needs the
parent's input artifacts, bind the
delegate's `package_id` to
`{"$node":"develop.package_id"}` and its `task` to an object containing
`objective`, `input_refs`, `deliverables`, and `capabilities` from `$input`.
The child skill receives the child TaskSpec as `payload`; input values are
artifact refs under `payload['input_refs']`, so Python reads, for example,
`context.read_artifact(payload['input_refs']['numbers'])['content']`.
Use the child's `output_refs.<deliverable_name>` for the final output. The
child package executes only in that delegated Episode. Do not invent a skill
when the task can be completed directly with existing roles and capabilities.
Set `params.mode` on `develop_skill` to `planner_preserving` when the delegated
child should retain this generic architect workflow and choose the installed
skill itself. Omit it for the direct `skill -> publish` execution child.

Preserve the completed `architect` node and remove `slot`. Every added ask node
must name either an available role with its matching component or a declared
task role. Use
bindings and artifact edges to pass actual results rather than describing a
conversation in prose. Connect each new branch to the boundary at `architect`,
directly or through another new node. Set `outputs` to the final workflow output
bindings and make the deliverables match the task contract. The host will bind
the current base plan reference and will reject cycles, unavailable tools or
skills, unregistered roles, excessive work, and changes outside the pending
scope. Omit `task_roles` when the available roles already fit the work.
In a later operations-based revision, `task_roles` adds new aliases to the
existing task registry; it cannot redefine a role already used by admitted
work. Keep completed and running nodes on their original role identities.

Prefer bindings for ordinary JSON results. Omit artifact-edge operations unless
both nodes expose real ports. A valid artifact edge has exactly
`producer_node`, `output_port`, `consumer_node`, and `input_port`, plus optional
`schema_ref`; its port paths do not use `$node` syntax.
For an explicit message between agents, add `message` to an artifact edge as
`{"topic":"review.finding","payload_schema":{"type":"object"}}`.
The producer's selected output must match that schema; the receiver gets an
addressed envelope under its `input_port` (typically `payload.inbox.finding`).
Message edges are optional; ordinary data bindings remain valid.

When intermediate evidence may justify replanning, the proposal may also carry
`revision_rules`. Such a checkpoint must run before the subgraph it may replace,
emit another proposal under its declared `proposal_path`, and leave the graph a
DAG for each admitted revision. Set `revision_rules` to an empty list when no
future checkpoint is useful, so the bootstrap rule is not retained. Prefer
direct execution for simple tasks and add agents or checkpoints only when their
expected value exceeds their cost.

A rule may instead set `planner_role_ref` to an available role or a declared
`task:<alias>`. The host then calls that frozen role after the rule's durable
success or failure condition matches. Its payload contains the task, current
workflow, base plan reference, trigger node, and exact trigger receipt; it must
return `{"proposal":{...}}`. Use this form when the observed worker cannot emit
a graph proposal itself. Set optional `planner_max_tokens` from 1 to 6000 when
the default 4000 is insufficient. `planner_role_ref`, `proposal_path`, and
`workflow_ref` are mutually exclusive revision sources. A task-created planner
still has only the `ask` capability and is content-addressed before execution.

For a worker receipt that should trigger a task-created planner, use a rule
like this exact shape (replace ids and condition for the actual task):
`{"id":"inspect-after-gather","after_node":"gather","when":{"path":"$status","equals":"completed"},"planner_role_ref":"task:planner","replace_node_ids":["analysis","publish"],"max_compile_attempts":2}`.
Declare `planner` in `task_roles`. The rule itself is the checkpoint; do not
add a synthetic `feedback` node to call the planner. Do not include
`proposal_path` or `workflow_ref` in this rule. The trigger node must precede
the pending nodes the planner may replace.
When writing the task-created planner's prompt, explain the graph operation
dialect: use `replace_node` once to change an existing pending node, and
`add_node` only for a new id. Never use `remove_node` plus `add_node` for the
same id, and never add an existing node or edge a second time. The planner may
leave valid pending nodes unchanged when evidence does not justify replacing
them; remove the spent revision rule from the next graph when replanning is done.

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
    "ask", "tool", "skill", "develop_skill", "develop_tool",
    "develop_service", "activate_service", "release_service",
    "capability_inventory", "delegate", "read_artifact", "publish",
    "memory_search", "remember", "feedback", "parallel", "join", "loop",
)

_OPERATOR_AUTHORITY = {
    "develop_tool": ("tool", "local_compute"),
    "develop_service": ("service_provider", "model_context"),
    "activate_service": ("service_provider", "model_context"),
    "release_service": ("service_provider", "model_context"),
}


def available_operators_for_authority(authority):
    """Project only operators that the current Episode can admit."""
    kinds = set(authority.get("allowed_kinds", [])) if isinstance(authority, dict) else set()
    effects = (
        set(authority.get("allowed_effects", []))
        if isinstance(authority, dict) else set()
    )
    return [
        operator for operator in AVAILABLE_OPERATORS
        if operator not in _OPERATOR_AUTHORITY
        or (_OPERATOR_AUTHORITY[operator][0] in kinds
            and _OPERATOR_AUTHORITY[operator][1] in effects)
    ]


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
                        "available_operators": {"$input": "available_operators"},
                        "available_skills": {"$input": "available_skills"},
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
