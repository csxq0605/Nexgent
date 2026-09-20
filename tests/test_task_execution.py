"""Vertical task paths from registered inputs to validated user deliverables."""

import json

from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ToolRegistry


OBJECT_DELIVERY = [{"name": "result", "schema": {"type": "object"}}]


def package(source, *, extra=None, skills=None):
    files = {"agent/main.py": source, **(extra or {})}
    return make_package(files, {"entries": {"execute": "agent/main.py:execute"},
                                "skills": skills or {}})


def test_ordinary_task_consumes_input_artifact_and_delivers_validated_output(tmp_path):
    candidate = package("""def execute(payload, context):
    source = context.read_artifact(payload['input_refs']['source'])
    result = {'count': len(source['content']['rows']), 'source_digest': source['content_digest']}
    artifact = context.publish(result, name='result')
    return {'deliverables': {'result': artifact['id']}, 'summary': 'Counted supplied rows.'}
""")
    service = TaskService(tmp_path, tools=ToolRegistry())
    state = service.create("Count the supplied rows", {"source": {"rows": [1, 2, 3]}},
                           OBJECT_DELIVERY, package=candidate)
    result = service.run(state["id"])
    assert result["status"] == "completed"
    delivered = service.store.read(result["output_refs"]["result"], state["id"])
    assert delivered["content"]["count"] == 3
    assert delivered["input_artifact_refs"] == [state["input_refs"]["source"]]
    assert delivered["validation"]["schema_status"] == "passed"
    assert result["outcome"]["acceptance_status"] == "not_evaluated"
    assert any(event["kind"] == "artifact_read" for event in result["events"])


def test_declared_workflow_skill_executes_through_same_runtime(tmp_path):
    workflow = {"input_schema": {"type": "object", "required": ["ref"]},
                "nodes": [{"id": "load", "method": "read_artifact",
                           "bindings": {"artifact_id": {"$input": "ref"}}}],
                "outputs": {"content": {"$node": "load.content"}}}
    candidate = package("""def execute(payload, context):
    flow = context.skill('load_input', {'ref': payload['input_refs']['source']})
    artifact = context.publish({'copied': flow['outputs']['content']}, name='result')
    return {'deliverables': {'result': artifact['id']}}
""", extra={"skills/load.json": json.dumps(workflow)}, skills={"load_input": {
        "kind": "workflow", "ref": "skills/load.json",
        "input_schema": {"type": "object", "required": ["ref"]},
        "output_schema": {"type": "object", "required": ["status", "outputs", "nodes"]}}})
    service = TaskService(tmp_path, tools=ToolRegistry())
    state = service.create("Copy a managed input", {"source": {"evidence": [4, 5]}},
                           OBJECT_DELIVERY, package=candidate)
    result = service.run(state["id"])
    assert result["status"] == "completed", result.get("last_error")
    assert service.store.read(result["output_refs"]["result"], state["id"])["content"] == {
        "copied": {"evidence": [4, 5]}}
    assert "rpc.1/nodes/load" in result["nodes"]


def test_candidate_memory_is_not_trusted_by_a_later_episode(tmp_path):
    candidate = package("""def execute(payload, context):
    if payload['objective'] == 'teach':
        item = context.remember({'lesson': 'verify provenance before aggregation'}, 'procedure')
        artifact = context.publish({'remembered': item['id']}, name='result')
    else:
        items = context.memory_search('verify provenance', 5)
        artifact = context.publish({'lessons': [item['content'] for item in items]}, name='result')
    return {'deliverables': {'result': artifact['id']}}
""")
    service = TaskService(tmp_path, tools=ToolRegistry())
    first = service.create("teach", deliverables=OBJECT_DELIVERY, package=candidate,
                           context={"memory_namespace": "contract", "split": "development"})
    assert service.run(first["id"])["status"] == "completed"
    second = service.create("reuse", deliverables=OBJECT_DELIVERY, package=candidate,
                            context={"memory_namespace": "contract", "split": "development"})
    result = service.run(second["id"])
    content = service.store.read(result["output_refs"]["result"], second["id"])["content"]
    assert content == {"lessons": []}
    consumed = [event for event in result["events"] if event["kind"] == "memory_consumed"]
    assert len(consumed) == 1 and consumed[0]["content"]["item_ids"] == []
