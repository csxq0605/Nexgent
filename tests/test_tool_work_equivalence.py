"""Task-local and adopted tools share measured work, including failures."""
import threading

import pytest

from nexgent.kernel.store import BudgetExhausted
from nexgent.tasks.capability_authority import make_episode_authority
from nexgent.tasks.capability_definitions import build_tool_definition
from nexgent.tasks.packages import make_package, PackageError
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ContractError


SCHEMA = {'type': 'object', 'properties': {'value': {'type': 'integer'}},
          'required': ['value'], 'additionalProperties': False}
SOURCE = "def execute(payload, context):\n    return {'value': payload['value'] * 2}\n"


def setup_tool(root, kind, source=SOURCE, budget=1000):
    files = {'main.py': 'def execute(payload, context):\n    return {}\n'}
    manifest = {'entries': {'execute': 'main.py:execute'}}
    if kind == 'package':
        files['tool.py'] = source
        manifest.update(manifest_version=2, roles={}, workflows={}, skills={}, services={},
                        components={'loop': {'class': 'O', 'kind': 'entry', 'ref': 'execute'},
                                    'double': {'class': 'S', 'kind': 'tool', 'ref': 'test.double'}},
                        orchestrator='loop', tools={'test.double': {
                            'description': 'Double an integer', 'ref': 'tool.py:execute',
                            'input_schema': SCHEMA, 'output_schema': SCHEMA,
                            'effect_class': 'local_compute', 'runtime': 'controlled-python-v1',
                            'work_units_per_call': 0}})  # Actual adoption emits a zero declaration.
    package = make_package(files, manifest)
    service = TaskService(root)
    episode = service.create('Exercise a tool', package=package, capabilities=[],
                             budget={'max_tool_work_units': budget},
                             capability_authority=make_episode_authority(
                                 ['tool'], ['local_compute'], max_definitions=2, max_invocations=3))
    if kind == 'dynamic':
        definition, bundle = build_tool_definition({
            'name': 'test.double', 'description': 'Double an integer', 'source': source,
            'input_schema': SCHEMA, 'output_schema': SCHEMA}, episode['id'])
        service.store.stage_tool_definition(episode['id'], definition, bundle)
        service.store.mount_tool_definition(episode['id'], definition['id'])
    return service, episode['id'], package


def invoke(service, identity, package, path='call'):
    return service._invoke(identity, package, 'tool',
                           {'name': 'test.double', 'arguments': {'value': 21}},
                           path, threading.Event(), lambda: None)


def receipt(service, identity):
    return [e['content'] for e in service.store.events(identity) if e['kind'] == 'tool'][-1]


def test_same_algorithm_has_same_cost_before_and_after_adoption_and_restart(tmp_path):
    units = []
    for kind in ('dynamic', 'package'):
        service, identity, package = setup_tool(tmp_path / kind, kind)
        assert invoke(service, identity, package) == {'value': 42}
        event = receipt(service, identity)
        usage = TaskService(tmp_path / kind).store.usage(identity)
        assert usage['usage_complete'] is True
        assert usage['tool_work_units'] == event['worker_instructions'] > 0
        assert usage['charged_tool_work_units'] == usage['tool_work_units']
        units.append(usage['tool_work_units'])
    assert units[0] == units[1]


@pytest.mark.parametrize('kind', ['dynamic', 'package'])
@pytest.mark.parametrize('source,error', [
    ("def execute(payload, context):\n    return {'wrong': 42}\n", ContractError),
    ("def execute(payload, context):\n    raise ValueError('broken')\n", PackageError),
])
def test_failed_tools_charge_work_before_output_validation_or_exception(tmp_path, kind, source, error):
    service, identity, package = setup_tool(tmp_path, kind, source)
    with pytest.raises(error):
        invoke(service, identity, package)
    event = receipt(service, identity)
    assert event['status'] == 'failed'
    assert event['work_accounting']['usage_complete'] is True
    assert event['work_accounting']['charged_work_units'] == event['worker_instructions'] > 0


@pytest.mark.parametrize('kind', ['dynamic', 'package'])
def test_explicit_zero_budget_prevents_execution(tmp_path, kind):
    service, identity, package = setup_tool(tmp_path, kind, budget=0)
    with pytest.raises(BudgetExhausted):
        invoke(service, identity, package)
    assert service.store.usage(identity)['tool_calls'] == 0


@pytest.mark.parametrize('kind', ['dynamic', 'package'])
def test_instruction_exhaustion_is_bounded_recorded_and_not_retried(tmp_path, kind):
    source = 'def execute(payload, context):\n    while True:\n        value = 1\n'
    service, identity, package = setup_tool(tmp_path, kind, source, budget=10)
    with pytest.raises(BudgetExhausted):
        invoke(service, identity, package)
    event = receipt(service, identity)
    assert event['worker_instruction_limit'] == 10
    assert event['worker_instructions'] == 11  # Includes the event that stops execution.
    assert event['work_accounting']['charged_work_units'] == 11
    assert event['work_accounting']['usage_complete'] is True
    with pytest.raises(BudgetExhausted):
        invoke(service, identity, package, path='retry')
    assert service.store.usage(identity)['tool_calls'] == 1


@pytest.mark.parametrize('kind', ['dynamic', 'package'])
def test_killed_worker_does_not_fabricate_complete_zero_work(tmp_path, monkeypatch, kind):
    service, identity, package = setup_tool(tmp_path, kind)
    def timeout(*args, **kwargs):
        raise TimeoutError('worker terminated without a measurement')
    monkeypatch.setattr('nexgent.tasks.runtime.run_package', timeout)
    with pytest.raises(TimeoutError):
        invoke(service, identity, package)
    assert receipt(service, identity)['work_accounting']['usage_complete'] is False
    usage = service.store.usage(identity)
    assert usage['tool_work_units'] is None and usage['usage_complete'] is False
    assert usage['tool_usage_missing_call_ids'] == [identity + '/call']
