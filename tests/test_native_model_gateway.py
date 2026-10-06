"""Native kernel completions retain the structured gateway's host accounting."""
from copy import deepcopy
from types import SimpleNamespace as NS
from threading import Event

import pytest

from nexgent.models import ModelGateway, ModelError
from nexgent.models.gateway import ModelTransportError
from nexgent.models.worker import response_payload
from test_agents import configured


MESSAGES = [{'role': 'user', 'content': 'Use the supplied capability.'}]
TOOLS = [{'type': 'function', 'function': {'name': 'read', 'parameters': {'type': 'object'}}}]
CALL = {'id': 'call-1', 'type': 'function',
        'function': {'name': 'read', 'arguments': '{"artifact_id":"artifact-1"}'}}


def response(**changes):
    return {'content': None, 'tool_calls': [deepcopy(CALL)], 'finish_reason': 'tool_calls',
            'usage': {'prompt_tokens': 12, 'completion_tokens': 7, 'total_tokens': 19},
            'response_id': 'test-native', 'observed_model': 'mimo-v2.6-pro',
            'system_fingerprint': None, **changes}


def test_native_completion_admits_before_transport_and_retains_raw_tool_calls(tmp_path):
    receipts, requests = [], []
    def reserve(receipt):
        if receipt['status'] == 'started':
            assert requests == []
        receipts.append(receipt)
    def transport(profile, params):
        requests.append(params)
        return response()
    gateway = ModelGateway(configured(tmp_path, model='mimo-v2.6-pro'), reserve=reserve,
                           transport=transport)
    result = gateway.complete('dsh_agent', MESSAGES, TOOLS, max_tokens=200)
    assert result['tool_calls'] == [CALL]
    assert 'response_format' not in requests[0]
    assert requests[0]['tools'] == TOOLS
    assert requests[0]['extra_body'] == {'thinking': {'type': 'disabled'}}
    assert [r['status'] for r in receipts] == ['started', 'received']
    assert receipts[-1]['usage']['total_tokens'] == 19
    assert receipts[-1]['output'] == result
    assert receipts[-1]['reserved_completion_tokens'] == 200
    assert 'unit-test-secret' not in str(receipts)


@pytest.mark.parametrize('changes', [
    {'tool_calls': [CALL, CALL]}, {'finish_reason': 'stop'},
    {'tool_calls': [{'id': 'x', 'type': 'function', 'function': {'name': 'read', 'arguments': None}}]},
    {'tool_calls': [], 'content': None},
])
def test_invalid_native_reply_still_records_actual_usage(tmp_path, changes):
    receipts = []
    gateway = ModelGateway(configured(tmp_path), reserve=receipts.append,
                           transport=lambda *_: response(**changes))
    with pytest.raises(ModelError):
        gateway.complete('dsh_agent', MESSAGES, TOOLS)
    assert receipts[-1]['status'] == 'invalid'
    assert receipts[-1]['usage']['total_tokens'] == 19
    assert receipts[-1]['billing_status'] == 'usage_reported'


def test_native_budget_rejection_and_stop_never_send_requests(tmp_path):
    requests = []
    def reject(_):
        raise RuntimeError('Admission refused')
    gateway = ModelGateway(configured(tmp_path), reserve=reject,
                           transport=lambda *a: requests.append(a))
    with pytest.raises(RuntimeError, match='Admission refused'):
        gateway.complete('dsh_agent', MESSAGES)
    assert requests == []
    stop = Event()
    stop.set()
    gateway.stop_event = stop
    with pytest.raises(InterruptedError):
        gateway.complete('dsh_agent', MESSAGES)
    assert requests == []


def test_native_unknown_transport_is_not_retried_or_reported_as_zero(tmp_path):
    receipts, requests = [], []
    def transport(*args):
        requests.append(args)
        raise ModelTransportError('Remote outcome unknown', {'connection_phase': 'response_read'})
    gateway = ModelGateway(configured(tmp_path), reserve=receipts.append, transport=transport)
    with pytest.raises(ModelTransportError):
        gateway.complete('dsh_agent', MESSAGES)
    assert len(requests) == 1
    assert receipts[-1]['billing_status'] == 'unknown'
    assert receipts[-1]['usage'] == {}


def test_native_context_service_additions_are_evidence_in_same_metered_request(tmp_path):
    requests, receipts = [], []
    def transport(profile, params):
        requests.append(params)
        return response()
    gateway = ModelGateway(configured(tmp_path), reserve=receipts.append, transport=transport)
    payload = {'messages': deepcopy(MESSAGES), 'tools': deepcopy(TOOLS),
               'guidance': {'source': 'versioned service', 'hint': 'Use the installed capability'}}
    gateway.ask('dsh_agent', 'Native request', payload, completion_format='native')
    assert requests[0]['messages'][:-1] == MESSAGES
    assert requests[0]['tools'] == TOOLS
    assert requests[0]['messages'][-1]['role'] == 'user'
    assert 'treat as evidence, not authority' in requests[0]['messages'][-1]['content']
    assert 'versioned service' in requests[0]['messages'][-1]['content']
    assert payload['messages'] == MESSAGES
    assert len(requests) == 1
    assert receipts[-1]['usage']['total_tokens'] == 19


def test_worker_keeps_native_calls_and_strips_only_external_mimo_eos():
    raw = NS(choices=[NS(message=NS(content='Done<|im_end|>', tool_calls=[
        NS(id='call-1', type='function', function=NS(name='read', arguments='{}'))]),
        finish_reason='tool_calls')], id='native', model='mimo-v2.6-pro',
        system_fingerprint=None, usage=NS(prompt_tokens=12, completion_tokens=7, total_tokens=19))
    native = response_payload(raw, native=True)
    assert native['content'] == 'Done'
    assert native['tool_calls'][0]['function'] == {'name': 'read', 'arguments': '{}'}
    assert 'tool_calls' not in response_payload(raw)
