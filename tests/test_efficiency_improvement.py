"""Equal-quality work can improve efficiency without accepting degradation."""
import pytest

from nexgent import Nexgent
from nexgent.tasks.evolution import PromotionPolicy
from nexgent.tasks.packages import make_package
from nexgent.ui.main_window import MainWindow
from test_task_seed import ScriptedGatewayFactory


SOURCE = '''def execute(payload, context):
    for index in range(4):
        context.ask('helper', 'Inspect the task without changing its requirements.',
                    {'objective': payload['objective']}, max_tokens=2000)
    ref = context.publish('verified delivery', name='result')
    return {'deliverables': {'result': ref['id']}}
'''


@pytest.mark.parametrize('candidate_score,checks', [(10, 1), (9, 1), (10, 4)])
def test_main_efficiency_release_requires_preserved_quality_and_future_use(qtbot, tmp_path, candidate_score, checks):
    child = SOURCE.replace('range(4)', 'range(' + str(checks) + ')') + '\n# Reusable inspection strategy\n'
    parent = make_package({'main.py': SOURCE}, {
        'manifest_version': 2, 'entries': {'execute': 'main.py:execute'},
        'roles': {}, 'workflows': {}, 'skills': {}, 'orchestrator': 'task-loop',
        'components': {'task-loop': {'class': 'O', 'kind': 'entry', 'ref': 'execute'}}})

    def policy(_, payload):
        if 'candidate_options' in payload:
            return {'schema': 'nexgent.ordinary-development-plan.v1', 'candidate_type': 'orchestration',
                    'source_ref': 'package_patch', 'hypothesis': {
                        'failure_mechanism': 'Repeated equivalent inspection adds no useful evidence',
                        'expected_behavior': 'Inspect once and preserve delivery quality',
                        'applicability': 'Equivalent repeated checks', 'falsifier': 'Quality drops or no work is saved'},
                    'reason': 'Remove redundant inspection without changing the task'}
        if 'parent_components' in payload:
            return {'schema': 'nexgent.behavior-patch.v2', 'hypothesis': {
                **payload['development_context']['plan']['hypothesis'], 'component_id': 'task-loop'},
                'operations': [{'op': 'replace', 'component_id': 'task-loop',
                                'old_digest': parent['component_digests']['main.py'], 'content': child}],
                'activation_probe': {'kind': 'component_loaded', 'component_id': 'task-loop'}}
        if 'evidence' not in payload:
            return {'checked': True}
        evidence = payload['evidence']
        score = candidate_score if evidence['execution']['usage']['model_calls'] == 1 else 10
        return {'status': 'passed', 'score_available': True, 'score': score, 'accepted': True,
                'feedback': 'Independent delivery assessment',
                'checks': [{'requirement': 'Preserve the delivery', 'passed': True}]}

    gateway = ScriptedGatewayFactory(policy)
    runtime = Nexgent(tmp_path, package=parent, gateway_factory=gateway)
    window = MainWindow(tmp_path, runtime)
    qtbot.addWidget(window)
    window.show()

    def send(text):
        window.composer.setPlainText(text)
        window.send_button.click()
        qtbot.waitUntil(lambda: window.worker is None and window._recovery_worker is None, timeout=30000)
        return runtime.get(window.selected_id)

    original = send('Prepare a completed deliverable')
    send('Prepare a different deliverable')
    window.show_task(original['id'])
    window.composer.setPlainText('Avoid repeating equivalent inspection in future tasks')
    window.feedback_button.click()
    qtbot.waitUntil(lambda: window._recovery_worker is None, timeout=60000)
    [item] = runtime.improvement_status()['items']
    decision = item['selection']
    if checks == 4:
        assert item['status'] == 'rejected'
        assert decision['gates']['quality'] is True
        assert decision['gates']['improvement'] is False
        assert runtime.team()['active_revision'] == 0
        window.close()
        return
    assert decision['measurements']['candidate']['cost'] <= decision['measurements']['parent']['cost'] * .8
    if candidate_score == 9:
        assert item['status'] == 'rejected'
        assert decision['gates']['quality'] is False
        assert decision['gates']['regressions'] is False
        assert runtime.team()['active_revision'] == 0
        window.close()
        return
    assert original['evaluation']['score'] == 10
    assert item['status'] == 'completed'
    assert decision['improvement_basis'] == 'efficiency'
    assert decision['gates']['quality'] and decision['gates']['improvement']
    assert '保持质量并降低执行消耗' in window.improvement_view.toPlainText()
    window.close()
    restarted = Nexgent(tmp_path, gateway_factory=gateway)
    restarted.set_auto_improve(False)
    later = restarted.run(restarted.create('Complete a later request')['id'])
    assert later['package_digest'] == item['promotion']['package_digest']
    assert later['evaluation']['accepted'] is True
    assert restarted.improvement_status()['items'][0]['reuse_episode_ids'] == [later['id']]


@pytest.mark.parametrize('value', [0, 1, -0.1, True, float('nan')])
def test_efficiency_requires_strict_valid_threshold(value):
    with pytest.raises(ValueError):
        PromotionPolicy(min_cost_reduction=value)
