"""A bounded review must request a verdict without weakening receipt checks."""
import pytest

from nexgent.delivery import ModelDeliveryEvaluator
from nexgent.tasks.runtime import TaskService
from nexgent.tasks.tools import ToolRegistry, ToolSpec
from test_task_seed import ScriptedGatewayFactory


@pytest.mark.parametrize('capacity,repeat_action', [(1, False), (0, False), (1, True)])
def test_final_assessment_closes_actions_and_preserves_missing_evidence(tmp_path, capacity, repeat_action):
    tool = ToolSpec('independent.compute', {'type': 'object'}, {'type': 'object'},
                    'local_compute', lambda arguments, context: {'answer': 42})
    report = {'status': 'passed', 'score_available': True, 'score': 10,
              'accepted': True, 'checks': [{'requirement': 'Independent calculation', 'passed': True}]}

    def policy(number, payload):
        if payload['remaining_tool_calls']:
            return {'tool': tool.name, 'arguments': {}}
        assert payload['tools'] == []
        assert len(payload['verification_results']) == capacity
        if capacity:
            assert payload['verification_results'][0]['result'] == {'answer': 42}
        return {'tool': tool.name, 'arguments': {}} if repeat_action else report

    gateway = ScriptedGatewayFactory(policy)
    runtime = TaskService(tmp_path, tools=ToolRegistry([tool]), gateway_factory=gateway)
    state = runtime.create('Review a supplied delivery', package=ModelDeliveryEvaluator.package(),
        inputs={'evidence': {'verification_requirements': {'computation': True, 'files': []}},
                'verification_capacity': {'tool_calls': capacity}},
        deliverables=[{'name': 'assessment', 'schema': {'type': 'object'}}], capabilities=[tool.name])
    result = runtime.run(state['id'])
    final = gateway.calls[-1]
    assert final['role'] == 'evaluator'
    assert 'This is the final assessment turn' in final['prompt']
    assert 'Return {"tool"' not in final['prompt']
    assert len(gateway.calls) == capacity + 1
    assert result['usage']['tool_calls'] == capacity
    if repeat_action:
        assert result['status'] == 'failed'
        assert 'Evaluator did not return an assessment' in result['last_error']
        assert result['output_refs'] == {}
    else:
        assert result['status'] == 'completed'
        assessment = runtime.store.read(result['output_refs']['assessment'], state['id'])['content']
        if capacity:
            assert assessment == report
        else:
            assert assessment['status'] == 'verification_missing'
            assert assessment['accepted'] is None and assessment['score_available'] is False
