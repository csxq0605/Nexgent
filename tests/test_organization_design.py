"""Organization changes come from ordinary feedback, not a demo contract."""
import pytest

from nexgent import Nexgent
from nexgent.application import framework_package
from nexgent.tasks.packages import make_package
from nexgent.ui.main_window import MainWindow
from test_task_seed import ScriptedGatewayFactory


SOURCE = '''def execute(payload, context):
    task_context = payload.get('context', {})
    if task_context.get('agent'):
        agent = task_context['agent']
        answer = context.ask('contributor', agent['instructions'], {'instructions': agent['instructions']})
        ref = context.publish(answer['finding'], name='finding')
        return {'deliverables': {'finding': ref['id']}}
    context.resource('prompts/task.md')
    findings = []
    for member in task_context.get('organization', {}).get('members', []):
        result = context.delegate({'objective': payload['objective'], 'agent': member['name'],
                                   'input_refs': payload['input_refs'],
                                   'deliverables': [{'name': 'finding', 'schema': {}}]})
        findings.append(context.read_artifact(result['output_refs']['finding'])['content'])
    ref = context.publish({'findings': findings}, name='result')
    return {'deliverables': {'result': ref['id']}}
'''


def package(members):
    initial = framework_package(members=members)
    return make_package({**initial['files'], 'agent/main.py': SOURCE}, initial['manifest'])


def policy(_, payload):
    if 'candidate_options' in payload:
        assert any(option['source_ref'] == 'organization_design' for option in payload['candidate_options'])
        return {'schema': 'nexgent.ordinary-development-plan.v1', 'candidate_type': 'orchestration',
                'source_ref': 'organization_design', 'hypothesis': {
                    'failure_mechanism': 'Missing evidence verification responsibility',
                    'expected_behavior': 'Use a member to verify evidence', 'applicability': 'Evidence-based tasks',
                    'falsifier': 'Actual member findings do not improve'}, 'reason': 'Address explicit feedback'}
    if 'completed_members' in payload:
        return {'members': [{'name': 'verifier', 'instructions': 'Verify evidence and publish reusable findings.',
                             'instructions_note': 'An inert model annotation', 'capabilities': ['ungranted_tool']}],
                'remove': [name for name in payload['editable_members'] if name == 'obsolete'],
                'strategy': 'Choose the verifier for evidence checks and read actual findings before synthesis.'}
    if 'instructions' in payload:
        return {'finding': 'verified contribution' if 'Verify evidence' in payload['instructions'] else 'initial contribution'}
    changed = payload['evidence']['deliverables']['result']['findings'] == ['verified contribution']
    return {'status': 'passed', 'score_available': True, 'score': 9 if changed else 8,
            'accepted': True, 'feedback': 'Checked actual deliverables',
            'checks': [{'requirement': 'Deliver the assigned result', 'passed': True}]}


@pytest.mark.parametrize('members', [{}, {'obsolete': 'Give a generic initial contribution.'}])
def test_main_feedback_creates_member_retires_redundancy_and_restart_uses_it(qtbot, tmp_path, members):
    gateway = ScriptedGatewayFactory(policy)
    runtime = Nexgent(tmp_path, package=package(members), gateway_factory=gateway)
    runtime.set_auto_improve(False)
    window = MainWindow(tmp_path, service=runtime)
    qtbot.addWidget(window)
    window.show()

    def send(text):
        window.composer.setPlainText(text)
        window.send_button.click()
        qtbot.waitUntil(lambda: window.worker is None, timeout=30000)
        return runtime.get(window.selected_id)

    original = send('Prepare the original result')
    send('Prepare a distinct result')
    window.show_task(original['id'])
    window.composer.setPlainText('Create an evidence verifier for future work and retire redundant generic members.')
    window.feedback_button.click()
    assert runtime.team()['active_revision'] == 0
    window.improve_toggle.setChecked(True)
    qtbot.waitUntil(lambda: window._recovery_worker is None, timeout=120000)
    active = runtime.evolution.active(runtime.main_channel)
    if not members:
        # A correct creation proposal can still be too expensive for the
        # ordinary gate. Creating a member must not bypass that comparison.
        [work] = runtime.store.feedback_triggers()
        assert work['status'] == 'rejected', runtime.improvement_status()
        decision = runtime.evolution.decision(work['evolution']['selection_decision']['id'])
        assert decision['gates']['behavior_activated'] is True
        assert decision['gates']['quality'] is True
        assert decision['gates']['cost'] is False
        [item] = runtime.improvement_status()['items']
        assert item['organization_change']['added'][0]['name'] == 'verifier'
        assert '候选组织修改' in window.improvement_view.toPlainText()
        assert active['revision'] == 0
        calls = len(gateway.calls)
        runtime.advance()
        assert len(gateway.calls) == calls
        window.close()
        restarted = Nexgent(tmp_path, gateway_factory=gateway)
        assert restarted.team()['members'] == []
        assert restarted.team()['active_revision'] == 0
        return
    assert active['revision'] == 1, runtime.improvement_status()
    assert [member['name'] for member in runtime.team()['members']] == ['verifier']
    assert active['package']['manifest']['roles']['verifier']['capabilities'] == []
    [item] = runtime.improvement_status()['items']
    assert item['organization_change']['added'][0]['name'] == 'verifier'
    assert item['organization_change']['removed'][0]['name'] == 'obsolete'
    assert len(runtime.team(original['id'])['assignments']) == len(members)
    assert 'verifier' in window.team_view.toPlainText()
    assert original['package_digest'] != active['package_digest']
    if members:
        assert 'members/obsolete.md' not in active['package']['files']
        assert 'member-obsolete' not in active['package']['manifest']['components']
    calls = len(gateway.calls)
    runtime.advance()
    assert len(gateway.calls) == calls
    window.close()

    restarted = Nexgent(tmp_path, gateway_factory=gateway)
    restarted.set_auto_improve(False)
    result = restarted.run(restarted.create('A later independent task')['id'])
    [assignment] = restarted.team(result['id'])['assignments']
    assert assignment['member']['name'] == 'verifier'
    assert assignment['status'] == 'completed'
    assert result['package_digest'] == active['package_digest']
    assert restarted.store.read(result['output_refs']['result'], result['id'])['content'] == {'findings': ['verified contribution']}
    assert 'members/verifier.md' in restarted.store.get(result['id'])['execution']['loaded_modules']
    assert restarted.improvement_status()['items'][0]['reuse_episode_ids'] == [result['id']]
