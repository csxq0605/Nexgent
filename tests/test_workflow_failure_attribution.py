"""A failed graph reports the operation that failed before downstream fallout."""

from nexgent.tasks.workflows import run_workflow


def test_failed_node_is_reported_before_skipped_deliverable_binding():
    workflow = {
        "nodes": [
            {"id": "load", "method": "read_artifact"},
            {"id": "publish", "method": "publish",
             "bindings": {"content": {"$node": "load"}}},
        ],
        "control_edges": [{"from": "load", "to": "publish"}],
        "outputs": {"result": {"$node": "publish.id"}},
    }

    def invoke(method, params, path):
        if method == "read_artifact":
            raise KeyError("artifact_id")
        raise AssertionError("publish should not be invoked")

    result = run_workflow(workflow, {}, invoke)

    assert result["status"] == "failed"
    assert result["nodes"]["publish"]["status"] == "skipped"
    assert result["error"] == "Node load failed: KeyError: 'artifact_id'"
    assert "Binding refers to skipped node: publish" in result["output_error"]


def test_output_contract_failure_remains_visible_without_failed_node():
    workflow = {
        "nodes": [{"id": "answer", "method": "ask"}],
        "outputs": {"result": {"$node": "answer.missing"}},
    }
    result = run_workflow(
        workflow, {}, lambda method, params, path: {"present": True})

    assert result["status"] == "failed"
    assert result["nodes"]["answer"]["status"] == "completed"
    assert result["error"] == result["output_error"]
    assert "Binding path is unavailable" in result["error"]
