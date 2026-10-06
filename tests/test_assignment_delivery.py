"""Ordinary members receive the assignment facts and reviewers receive task data."""
import pytest

from nexgent import Nexgent
from nexgent.ui.main_window import MainWindow
from test_task_seed import ScriptedGatewayFactory


@pytest.mark.parametrize('brief', [None, 'Check the given fact: downloaded copies survive revocation.'])
def test_main_member_receives_facts_and_review_can_check_the_assignment(qtbot, tmp_path, brief):
    facts = 'Revoking shared access prevents future downloads; existing downloaded copies remain.'
    reviewed = []

    def policy(_, payload):
        task = payload['task']
        if task.get('context', {}).get('agent'):
            assignment = task['context']['assignment']
            assert facts in assignment['parent_objective']
            assert assignment['instructions'] == (brief or '')
            assert 'evaluator_reference_answer' not in task['context']
            return {'request': {'method': 'publish', 'params': {'name': 'result', 'content': facts}}}
        observations = [event for event in payload['history'] if event.get('kind') == 'observation' and event.get('ok')]
        if not observations:
            child = {'objective': 'Check the supplied facts.',
                     'agent': {'name': 'checker', 'instructions': 'Check the evidence and publish concise findings.'},
                     'capabilities': []}
            if brief is not None:
                child['instructions'] = brief
            return {'request': {'method': 'delegate', 'params': {'task': child}}}
        previous = observations[-1]
        if previous['request']['method'] == 'delegate':
            return {'request': {'method': 'read_artifact',
                                'params': {'artifact_id': previous['result']['output_refs']['result']}}}
        assert previous['request']['method'] == 'read_artifact'
        return {'request': {'method': 'publish', 'params': {'name': 'result', 'content': previous['result']['content']}}}

    class Evaluate:
        id = 'assignment-delivery-check'
        def snapshot(self):
            return {'version': 1}
        def evaluate(self, task, delivery, execution):
            reviewed.append(task)
            assert delivery == {'result': facts}
            assert facts in task['objective']
            assert len(execution['members']) == 1
            assert execution['members'][0]['status'] == 'completed'
            return {'status': 'passed', 'score_available': True, 'score': 9, 'accepted': True}

    runtime = Nexgent(tmp_path, gateway_factory=ScriptedGatewayFactory(policy), evaluator=Evaluate())
    runtime.set_auto_improve(False)
    window = MainWindow(tmp_path, service=runtime)
    qtbot.addWidget(window)
    window.show()
    window.composer.setPlainText('Have a member verify this fact, read its findings, then deliver: ' + facts)
    window.send_button.click()
    qtbot.waitUntil(lambda: window.worker is None, timeout=60000)
    result = runtime.get(window.selected_id)
    assert result['status'] == 'completed' and result['evaluation']['accepted'] is True
    [member] = runtime.team(result['id'])['assignments']
    assert member['status'] == 'completed'
    assert len(reviewed) == 1
    assert runtime.store.read(result['output_refs']['result'], result['id'])['content'] == facts
    child = runtime.store.get(member['episode_id'])
    assert child['capabilities'] == []
    assert child['root_episode_id'] == result['id']
    assert Nexgent(tmp_path).store.get(child['id'])['task']['context']['assignment'] == child['task']['context']['assignment']
