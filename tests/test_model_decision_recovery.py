"""A received ambiguous decision can be regenerated once, before any action."""
import json

import pytest

from nexgent.models import ModelGateway
from nexgent.tasks.runtime import TaskService
from test_agents import configured
from test_application import package


ASK = package('''def execute(payload, context):
    answer = context.ask('worker', 'Answer the original question as JSON.',
                         {'question': 'Which facts were supplied?'}, max_tokens=100)
    ref = context.publish(answer, name='result')
    return {'deliverables': {'result': ref['id']}}
''')


@pytest.mark.parametrize('second,limit,completed,requests', [
    ('{"facts":["original"]}', 2, True, 2),
    ('{"facts":1,"facts":2}', 2, False, 2),
    ('{"facts":["original"]}', 1, False, 1),
])
def test_duplicate_decision_is_not_executed_and_recovery_is_budgeted(
        tmp_path, second, limit, completed, requests):
    configured(tmp_path)
    observed = []
    def transport(profile, params):
        observed.append(params)
        if len(observed) == 2:
            payload = json.loads(params['messages'][1]['content'])
            assert payload['original_context'] == {'question': 'Which facts were supplied?'}
            assert 'no action was executed' in payload['format_feedback']
        return {'content': '{"facts":1,"facts":2}' if len(observed) == 1 else second,
                'finish_reason': 'stop', 'response_id': 'received-test-response',
                'usage': {'prompt_tokens': 10, 'completion_tokens': 10, 'total_tokens': 20}}
    runtime = TaskService(tmp_path, gateway_factory=lambda reserve, stop:
        ModelGateway(tmp_path, reserve=reserve, stop_event=stop, transport=transport))
    result = runtime.run(runtime.create('Keep the original facts', package=ASK,
                                        budget={'max_model_calls': limit})['id'])
    assert (result['status'] == 'completed') is completed
    assert len(observed) == requests
    assert result['usage']['model_calls'] == requests
    assert result['calls'][0]['status'] == 'invalid'
    assert result['calls'][0]['format_error_code'] == 'duplicate_object_key'
    assert result['calls'][0]['usage']['total_tokens'] == 20
    if completed:
        assert runtime.store.read(result['output_refs']['result'], result['id'])['content'] == {'facts': ['original']}
        assert result['calls'][1]['call_phase'] == 'json-repair'
        refs = dict(result['output_refs'])
        restored = TaskService(tmp_path).run(result['id'])
        assert restored['output_refs'] == refs
        assert len(observed) == 2
    else:
        assert not result['output_refs']
