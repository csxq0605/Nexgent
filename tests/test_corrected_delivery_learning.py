"""A rescued ordinary delivery still teaches the cross-task framework."""
import pytest

from nexgent import Nexgent
from nexgent.delivery import ModelDeliveryEvaluator
from nexgent.tasks.packages import make_package
from nexgent.ui.main_window import MainWindow
from test_task_seed import ScriptedGatewayFactory


SOURCE = '''def execute(payload, context):
    corrected = payload['context'].get('rsi_role') == 'delivery_revision'
    correct = corrected or payload['objective'] == 'Control request'
    ref = context.publish('supported statement' if correct else 'unsupported statement', name='result')
    return {'deliverables': {'result': ref['id']}}
'''
CHILD = '''def execute(payload, context):
    ref = context.publish('supported statement', name='result')
    return {'deliverables': {'result': ref['id']}}
'''


@pytest.mark.parametrize('upgrade_grader', [False, True])
def test_main_correction_triggers_feedback_release_without_human_prompt(qtbot, tmp_path, monkeypatch, upgrade_grader):
    parent = make_package({'main.py': SOURCE}, {
        'manifest_version': 2, 'entries': {'execute': 'main.py:execute'},
        'roles': {}, 'workflows': {}, 'skills': {}, 'orchestrator': 'task-loop',
        'components': {'task-loop': {'class': 'O', 'kind': 'entry', 'ref': 'execute'}}})
    captured = []

    def policy(_, payload):
        if 'candidate_options' in payload:
            root = payload['feedback_bundle']['episode_refs'][0]
            assert root['evaluation']['public_metrics']['accepted'] is True
            assert root['user_feedback'] == []
            history = root['delivery_feedback_history']
            assert [item['accepted'] for item in history] == [False, True]
            assert 'Claims exceed supplied evidence' in history[0]['text']
            assert root['delivery_feedback']['checks'][0]['passed'] is True
            assert 'PRIVATE_ADAPTER_DIAGNOSTIC' not in repr(payload)
            captured.append(payload['feedback_bundle'])
            return {'schema': 'nexgent.ordinary-development-plan.v1', 'candidate_type': 'orchestration',
                    'source_ref': 'package_patch', 'hypothesis': {
                        'failure_mechanism': 'The original strategy exceeded evidence before host correction',
                        'expected_behavior': 'Ground the initial delivery in evidence',
                        'applicability': 'Evidence-based deliveries', 'falsifier': 'Initial unsupported claims persist'},
                    'reason': 'Successful rescue did not correct the deployed strategy'}
        if 'parent_components' in payload:
            return {'schema': 'nexgent.behavior-patch.v2', 'hypothesis': {
                **payload['development_context']['plan']['hypothesis'], 'component_id': 'task-loop'},
                'operations': [{'op': 'replace', 'component_id': 'task-loop',
                                'old_digest': parent['component_digests']['main.py'], 'content': CHILD}],
                'activation_probe': {'kind': 'component_loaded', 'component_id': 'task-loop'}}
        passed = payload['evidence']['deliverables']['result'] == 'supported statement'
        return {'status': 'passed' if passed else 'failed', 'score_available': True,
                'score': 10 if passed else 3, 'accepted': passed,
                'feedback': 'Grounded result' if passed else 'Claims exceed supplied evidence',
                'checks': [{'requirement': 'Ground all claims in supplied evidence', 'passed': passed}]}

    gateway = ScriptedGatewayFactory(policy)
    runtime = Nexgent(tmp_path, package=parent, gateway_factory=gateway)
    runtime.set_auto_improve(False)
    window = MainWindow(tmp_path, runtime)
    qtbot.addWidget(window)
    window.show()

    def send(text):
        window.composer.setPlainText(text)
        window.send_button.click()
        qtbot.waitUntil(lambda: window.worker is None, timeout=30000)
        return runtime.get(window.selected_id)

    send('Control request')
    source = send('Prepare a grounded summary')
    assert source['evaluation']['accepted'] is True
    assert source.get('delivery_revision_id')
    [work] = runtime.store.feedback_triggers()
    assert work['status'] == 'observed'
    assert runtime.feedback_items(source['id']) == []
    if upgrade_grader:
        class PrivateAdapter:
            id = 'test.private-adapter'

            def snapshot(self):
                return {'id': self.id, 'version': 1}

            def evaluate(self, task, deliverables, execution):
                return {'status': 'passed', 'score_available': True, 'score': 10,
                        'accepted': True, 'feedback': 'PRIVATE_ADAPTER_DIAGNOSTIC',
                        'checks': [{'requirement': 'PRIVATE_ADAPTER_DIAGNOSTIC', 'passed': True}],
                        'evaluation_episode_id': source['evaluation']['evaluation_episode_id']}

        runtime.evaluate(source['id'], PrivateAdapter(), source['task'])
        old = ModelDeliveryEvaluator.package()
        changed = make_package({**old['files'], 'review.md': old['files']['review.md'] + '\nUpdated host instructions.'},
                               old['manifest'], provenance=old['provenance'])
        monkeypatch.setattr(ModelDeliveryEvaluator, 'package', staticmethod(lambda: changed))
        assert changed['digest'] != old['digest']
    window.improve_toggle.setChecked(True)
    qtbot.waitUntil(lambda: window._recovery_worker is None, timeout=60000)
    assert captured
    [item] = runtime.improvement_status()['items']
    assert item['status'] == 'completed', item
    assert runtime.team()['active_revision'] == 1
    calls = len(gateway.calls)
    runtime.advance()
    assert len(gateway.calls) == calls
    window.close()
    restarted = Nexgent(tmp_path, gateway_factory=gateway)
    restarted.set_auto_improve(False)
    later = restarted.run(restarted.create('A later independent delivery')['id'])
    assert later['evaluation']['accepted'] is True
    assert not later.get('delivery_revision_id')
    assert later['package_digest'] == item['promotion']['package_digest']
    assert restarted.improvement_status()['items'][0]['reuse_episode_ids'] == [later['id']]
