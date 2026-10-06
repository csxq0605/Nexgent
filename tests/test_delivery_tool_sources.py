"""Review sees actual immutable tools, without gaining candidate execution rights."""
from copy import deepcopy
import threading

import pytest

from nexgent import Nexgent
from nexgent.delivery import _tool_source_evidence
from nexgent.tasks.runtime import TaskService
from test_package_capability_runtime import _tool_package
from test_task_capability_adoption import _tool_proposal


def executed_tools(runtime, identity):
    return [e['content'] for e in runtime.store.events(identity) if e['kind'] == 'tool']


def test_review_reads_only_called_dynamic_source_and_keeps_original_identity(tmp_path):
    runtime = Nexgent(tmp_path)
    state = runtime.create('Use a reusable computation')
    package = runtime.store.package(state['package_id'])
    def invoke(method, params, path):
        return runtime._dispatch(state['id'], package, method, params, path,
                                 threading.Event(), lambda: None)
    proposal = _tool_proposal()
    invoke('develop_tool', {'proposal': proposal}, 'develop.1')
    unused = {**proposal, 'name': 'task.unused'}
    invoke('develop_tool', {'proposal': unused}, 'develop.2')
    invoke('tool', {'name': proposal['name'], 'arguments': {'value': 21}}, 'compute.1')
    calls = executed_tools(runtime, state['id'])
    before = runtime.store.usage(state['id'])
    [evidence] = _tool_source_evidence(runtime.store, calls)
    assert evidence['name'] == proposal['name']
    assert evidence['source'] == proposal['source']
    assert evidence['package_digest'] == calls[0]['package_digest']
    assert evidence['input_schema'] == proposal['input_schema']
    assert runtime.store.usage(state['id']) == before
    assert _tool_source_evidence(Nexgent(tmp_path).store, calls) == [evidence]
    [bounded] = _tool_source_evidence(runtime.store, calls, max_characters=0)
    assert 'source' not in bounded and 'source_omitted' in bounded
    corrupt = deepcopy(calls)
    corrupt[0]['dynamic_capability']['definition_digest'] = 'incorrect'
    with pytest.raises(ValueError, match='identity changed'):
        _tool_source_evidence(runtime.store, corrupt)


def test_review_reads_adopted_package_tool_source_and_excludes_failed_calls(tmp_path):
    runtime = TaskService(tmp_path)
    package = _tool_package()
    result = runtime.run(runtime.create('Double the input', package=package)['id'])
    assert result['status'] == 'completed'
    calls = executed_tools(runtime, result['id'])
    [evidence] = _tool_source_evidence(runtime.store, calls)
    assert evidence['source'] == package['files']['capabilities/double.py']
    assert evidence['package_digest'] == package['digest']
    assert evidence['name'] == 'portable.double'
    assert _tool_source_evidence(runtime.store, [{**calls[0], 'status': 'failed'}]) == []
