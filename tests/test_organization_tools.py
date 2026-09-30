from pathlib import Path

import pytest

from nexgent.organization_tools import WorkspaceTools
from nexgent.organization import OrganizationService
from test_organization import Model


def test_python_computation_uses_existing_worker(tmp_path):
    tools = WorkspaceTools(tmp_path, tmp_path / 'output', allow_artifact_writes=False)
    result = tools.call('run_python', {'code': '''def execute(payload, context):
    best = {0: (0, [])}
    for item in payload['items']:
        for weight, state in list(best.items()):
            next_weight = weight + item['weight']
            value = state[0] + item['value']
            if next_weight <= payload['capacity'] and value > best.get(next_weight, (-1, []))[0]:
                best[next_weight] = (value, state[1] + [item['name']])
    return max(best.values(), key=lambda state: state[0])
''', 'payload': {'capacity': 5, 'items': [{'name': 'a', 'weight': 3, 'value': 7}, {'name': 'b', 'weight': 2, 'value': 6}, {'name': 'c', 'weight': 5, 'value': 12}]}})
    assert result['value'] == [13, ['a', 'b']]
    assert result['execution']['rpc_count'] == 0
    assert not (tmp_path / 'output').exists()
    for code in ['import os\ndef execute(payload, context):\n    return 0',
                 'def execute(payload, context):\n    return context.tool("read_text", {})']:
        with pytest.raises(ValueError):
            tools.call('run_python', {'code': code, 'payload': {}})


def test_python_worker_observes_task_cancellation(tmp_path):
    import threading
    stop = threading.Event()
    stop.set()
    tools = WorkspaceTools(tmp_path, tmp_path / 'output', stop_event=stop)
    with pytest.raises(InterruptedError):
        tools.call('run_python', {'code': 'def execute(payload, context):\n    return payload', 'payload': {}})


def test_real_csv_query_and_isolated_artifacts(tmp_path):
    (tmp_path / "sales.csv").write_text("item,amount\na,12\nb,8\na,5\n", encoding="utf-8")
    tools = WorkspaceTools(tmp_path, tmp_path / ".nexgent" / "outputs" / "test")
    result = tools.call("query_csv", {"path": "sales.csv", "sql": "SELECT item, SUM(CAST(amount AS INTEGER)) FROM data GROUP BY item ORDER BY item"})
    assert result["rows"] == [("a", 17), ("b", 8)]
    artifact = tools.call("write_artifact", {"name": "report.txt", "content": "total 25"})
    assert Path(artifact["path"]).read_text() == "total 25"
    assert not (tmp_path / "report.txt").exists()
    assert tools.call("read_text", {"path": artifact["path"]})["content"] == "total 25"
    for path in ["../outside.txt", ".env", "models.json"]:
        with pytest.raises(ValueError):
            tools.call("read_text", {"path": path})
    with pytest.raises(Exception):
        tools.call("query_csv", {"path": "sales.csv", "sql": "ATTACH DATABASE 'escaped.db' AS other"})
    assert not (tmp_path / "escaped.db").exists()


def test_tools_reach_evaluator_and_candidate_outputs_are_separate(tmp_path):
    (tmp_path / "facts.txt").write_text("actual evidence", encoding="utf-8")
    class ToolModel(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if "Perform your assigned" in prompt:
                trace = payload["tool_results"]
                if not trace:
                    return {"tool": "read_text", "arguments": {"path": "facts.txt"}}
                if len(trace) == 1:
                    return {"tool": "write_artifact", "arguments": {"name": "report.txt", "content": trace[0]["result"]["content"]}}
            if "Independently evaluate" in prompt:
                assert payload["execution_evidence"]
                for artifact in payload["artifacts"]:
                    assert Path(artifact["path"]).read_text() == "actual evidence"
            return result
    run = OrganizationService(tmp_path, gateway_factory=ToolModel).run("Read facts.txt and save report")
    assert run["status"] == "completed"
    assert run["evolution"]["status"] == "adopted"
    paths = [a["path"] for a in run["parent_result"]["artifacts"] + run["result"]["artifacts"]]
    assert len(set(paths)) == 3
    assert all(Path(p).is_file() for p in paths)


def test_member_can_recover_from_tool_error(tmp_path):
    (tmp_path / "facts.txt").write_text("available", encoding="utf-8")
    class Recover(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if "Perform your assigned" in prompt:
                trace = payload["tool_results"]
                if not trace:
                    return {"tool": "read_text", "arguments": {"path": "missing.txt"}}
                if len(trace) == 1:
                    assert "error" in trace[0]
                    return {"tool": "read_text", "arguments": {"path": "facts.txt"}}
                assert trace[1]["result"]["content"] == "available"
            return result
    run = OrganizationService(tmp_path, gateway_factory=Recover).run("Read available facts")
    assert run["status"] == "completed"
    events = [e for e in run["events"] if e["stage"] == "tool_executed"]
    assert any(not e["succeeded"] for e in events)
    assert any(e["succeeded"] for e in events)
