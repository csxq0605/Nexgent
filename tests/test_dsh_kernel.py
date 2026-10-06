"""Real DSH/SDK/MCP engineering tests; scripted provider, no RSI claims.

Opt in with NEXGENT_DSH_TESTS=1 after installing the pinned official runtime.
The default suite still exercises configuration and portable package contracts.
"""
import json
import hashlib
import os
from pathlib import Path
import threading

import pytest

from nexgent import Nexgent
from nexgent.application import framework_package
from nexgent.kernel.dsh import configured_kernel
from nexgent.models import ModelGateway
from nexgent.models.gateway import ModelTransportError
from test_agents import configured
from test_product_workflow import CheckResult


def test_kernel_choice_persists_without_changing_existing_active_package(tmp_path):
    original = Nexgent(tmp_path, evaluator=CheckResult('unused'))
    digest = original.evolution.active(original.main_channel)['package_digest']
    selected = Nexgent(tmp_path, evaluator=CheckResult('unused'), kernel='dsh')
    assert selected.evolution.active(selected.main_channel)['package_digest'] == digest
    assert Nexgent(tmp_path).native_kernels.keys() == {'dsh'}
    fresh = Nexgent(tmp_path/'fresh', kernel='dsh')
    assert 'context.native_agent' in fresh.evolution.active(fresh.main_channel)['package']['files']['agent/main.py']
    assert framework_package()['digest'] != framework_package(kernel='dsh')['digest']


def test_kernel_settings_cannot_supply_arbitrary_launch_arguments(tmp_path):
    settings = tmp_path/'.nexgent'/'kernel.json'
    settings.parent.mkdir()
    settings.write_text(json.dumps({'engine': 'dsh', 'launch_args': ['node', 'untrusted.js']}))
    with pytest.raises(ValueError, match='only engine and binary'):
        configured_kernel(tmp_path)


live = pytest.mark.skipif(os.environ.get('NEXGENT_DSH_TESTS') != '1',
                          reason='Explicit official DSH runtime integration test')


def reply(content=None, *, tool=None):
    calls = [] if tool is None else [{'id': 'native-'+tool[0], 'type': 'function', 'function': {
        'name': 'mcp__nexgent__'+tool[0], 'arguments': json.dumps(tool[1])}}]
    return {'content': content, 'tool_calls': calls, 'finish_reason': 'tool_calls' if calls else 'stop',
            'usage': {'prompt_tokens': 12, 'completion_tokens': 7, 'total_tokens': 19},
            'response_id': 'test-native', 'observed_model': 'mimo-v2.6-pro', 'system_fingerprint': None}


def runtime_for(tmp_path, transport):
    configured(tmp_path, model='mimo-v2.6-pro')
    return Nexgent(tmp_path, kernel='dsh', evaluator=CheckResult({'value': 42}),
                   gateway_factory=lambda reserve, stop: ModelGateway(
                       tmp_path, reserve=reserve, stop_event=stop, transport=transport))


@live
def test_real_native_loop_reads_computes_and_publishes_on_one_host_ledger(tmp_path):
    requests = []
    def transport(profile, params):
        requests.append(params)
        number = len(requests)
        if number == 1:
            return reply(tool=('read_artifact', {'artifact_id': state['input_refs']['numbers']}))
        observed = json.loads(params['messages'][-1]['content'])
        if number == 2:
            assert observed['content'] == {'left': 6, 'right': 7}
            alias = 'tool_'+hashlib.sha256(b'run_python').hexdigest()[:16]
            return reply(tool=(alias, {
                'code': "return {'value': payload['left'] * payload['right']}",
                'payload': observed['content']}))
        if number == 3:
            assert observed['value'] == {'value': 42}
            alias = 'deliver_'+hashlib.sha256(b'result').hexdigest()[:16]
            schema = next(t['function']['parameters'] for t in params['tools']
                          if t['function']['name'] == 'mcp__nexgent__'+alias)
            assert schema['properties']['content'] == {'type': 'object'}
            return reply(tool=(alias, {'content': observed['value']}))
        assert number == 4
        return reply(json.dumps({'deliverables': {'result': observed['id']},
                                  'summary': 'Computed and published', 'limitations': []}))
    runtime = runtime_for(tmp_path, transport)
    task = runtime.create('Multiply the input numbers and deliver JSON.',
                          inputs={'numbers': {'left': 6, 'right': 7}},
                          deliverables=[{'name': 'result', 'schema': {'type': 'object'}}],
                          budget={'max_model_calls': 4})
    state = runtime.store.get(task['id'])
    result = runtime.run(task['id'])
    assert result['status'] == 'completed', result.get('last_error')
    assert result['evaluation']['accepted'] is True
    artifact = runtime.store.read(result['output_refs']['result'], result['id'])
    assert artifact['content'] == {'value': 42}
    assert state['input_refs']['numbers'] in artifact['input_artifact_refs']
    assert result['usage']['model_calls'] == 4
    assert result['usage']['tool_calls'] == 1
    assert result['usage']['charged_tool_work_units'] > 0
    assert result['usage']['known_usage']['total_tokens'] == 76
    assert result['usage']['usage_complete'] is True
    assert any(e['kind'] == 'native_kernel_event' and e['content']['event']['type'] == 'turn/end'
               for e in result['events'])
    restored = Nexgent(tmp_path).run(task['id'])
    assert restored['output_refs'] == result['output_refs']
    assert len(requests) == 4
    assert not [t for t in threading.enumerate() if t.name.startswith('nexgent-dsh-')]
    assert not list((tmp_path/'.nexgent'/'dsh').rglob('host.patch.yml'))


@live
@pytest.mark.parametrize('unknown', [False, True])
def test_native_budget_and_unknown_provider_outcome_do_not_repeat(tmp_path, unknown):
    requests = []
    def transport(*args):
        requests.append(args)
        raise ModelTransportError('Unknown remote completion', {'connection_phase': 'response_read'})
    runtime = runtime_for(tmp_path, transport)
    task = runtime.create('Deliver a result', budget={'max_model_calls': 1 if unknown else 0})
    result = runtime.run(task['id'])
    assert result['status'] == ('waiting_input' if unknown else 'failed'), result.get('last_error')
    assert len(requests) == (1 if unknown else 0)
    if unknown:
        assert result['usage']['usage_complete'] is False
        assert result['usage']['billing_unknown_call_ids']
        resumed = runtime.run(task['id'])
        assert resumed['status'] == 'waiting_input'
        assert len(requests) == 1
    assert not [t for t in threading.enumerate() if t.name.startswith('nexgent-dsh-')]
