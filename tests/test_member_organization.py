"""Product team adoption uses ordinary tasks, real delegation and release gates."""
from copy import deepcopy

from nexgent import Nexgent
from nexgent.application import framework_package
from nexgent.tasks.packages import make_package
from nexgent.ui.main_window import MainWindow
from test_task_seed import ScriptedGatewayFactory


SOURCE = '''def execute(payload, context):
    task_context = payload.get('context', {})
    if task_context.get('agent'):
        agent = task_context['agent']
        result = context.ask('contributor', agent['instructions'], {'objective': payload['objective'], 'instructions': agent['instructions']})
        ref = context.publish(result['finding'], name='finding')
        return {'deliverables': {'finding': ref['id']}}
    instructions = context.resource('prompts/task.md')
    directory = task_context.get('organization', {}).get('members', [])
    members = [item['name'] for item in directory] or [
        {'name': 'analyst', 'instructions': 'Inspect the evidence for the assigned task.'},
        {'name': 'checker', 'instructions': 'Check the proposed result against the evidence.'}]
    requests = [{'method': 'delegate', 'params': {'task': {
        'objective': payload['objective'] + ' / distinct responsibility ' + str(index), 'agent': member,
        'input_refs': payload['input_refs'], 'deliverables': [{'name': 'finding', 'schema': {}}]}}} for index, member in enumerate(members)]
    results = context.parallel(requests)
    findings = [context.read_artifact(result['value']['output_refs']['finding'])['content'] for result in results]
    ref = context.publish({'findings': findings}, name='result')
    return {'deliverables': {'result': ref['id']}}
'''


def package():
    baseline = framework_package()
    return make_package({**baseline['files'], 'agent/main.py': SOURCE}, baseline['manifest'])


def policy(_, payload):
    if 'instructions' in payload:
        return {'finding': 'verified contribution' if 'reusable' in payload['instructions'] else 'initial contribution'}
    if 'candidate_options' in payload:
        assert any(option['source_ref'] == 'task_members' for option in payload['candidate_options'])
        return {'schema': 'nexgent.ordinary-development-plan.v1', 'candidate_type': 'orchestration',
                'source_ref': 'task_members', 'hypothesis': {
                    'failure_mechanism': 'Repeated work lacks reusable verification responsibilities',
                    'expected_behavior': 'Reuse members that verify evidence', 'applicability': 'Evidence-based tasks',
                    'falsifier': 'Later tasks lack verified contributions'}, 'reason': 'Reuse actual completed members'}
    if 'completed_members' in payload:
        return {'members': [{'name': member['name'], 'instructions': 'A reusable member must verify evidence and publish findings.'}
                            for member in payload['completed_members']],
                'strategy': 'Assign distinct evidence checks and read actual member findings before synthesis.'}
    assert 'evidence' in payload, payload
    changed = all(finding == 'verified contribution' for finding in payload['evidence']['deliverables']['result']['findings'])
    return {'status': 'passed', 'score_available': True, 'score': 9 if changed else 8,
            'accepted': True, 'feedback': 'Checked the actual member contributions',
            'checks': [{'requirement': 'Members deliver evidence-based findings', 'passed': True}]}


def test_main_team_design_gate_restart_and_real_member_reuse(qtbot, tmp_path):
    gateway = ScriptedGatewayFactory(policy)
    runtime = Nexgent(tmp_path, package=package(), gateway_factory=gateway)
    runtime.set_auto_improve(False)
    window = MainWindow(tmp_path, service=runtime)
    qtbot.addWidget(window)
    window.show()

    def send(text):
        window.composer.setPlainText(text)
        window.send_message()
        qtbot.waitUntil(lambda: window.worker is None, timeout=30000)
        return runtime.get(window.selected_id)

    source = send('Review the available project evidence')
    send('Review a different project context')
    assert not runtime.team()['members']
    assert len(runtime.team(source['id'])['assignments']) == 2
    assert all(row['status'] == 'completed' for row in runtime.team(source['id'])['assignments'])
    window.show_task(source['id'])
    assert 'analyst' in window.team_view.toPlainText()
    assert 'checker' in window.team_view.toPlainText()
    window.composer.setPlainText('Reuse verification responsibilities across future tasks')
    window.save_feedback()
    runtime.set_auto_improve(True)
    runtime.advance(source['id'])
    active = runtime.evolution.active(runtime.main_channel)
    assert active['revision'] == 1, runtime.improvement_status()
    assert len(runtime.team()['members']) == 2
    status = runtime.improvement_status(source['id'])
    assert status['items'][0]['status'] == 'completed', status
    window.close()

    restarted = Nexgent(tmp_path, gateway_factory=gateway)
    restarted.set_auto_improve(False)
    next_task = restarted.create('Review a third independent task')
    result = restarted.run(next_task['id'])
    assert result['package_digest'] == active['package_digest']
    assert len(restarted.team(result['id'])['assignments']) == 2
    assert {item['member']['name'] for item in restarted.team(result['id'])['assignments']} == {'analyst', 'checker'}
    delivery = restarted.store.read(result['output_refs']['result'], result['id'])['content']
    assert delivery['findings'] == ['verified contribution', 'verified contribution']
    role_paths = {role['prompt_ref'] for role in active['package']['manifest']['roles'].values()}
    assert role_paths <= set(restarted.store.get(result['id'])['execution']['loaded_modules'])
    assert all(event['content']['child_episode_id'] in result['child_episode_ids']
               for event in restarted.store.events(result['id']) if event['kind'] == 'package_member_activated')


def test_member_roster_comes_from_frozen_package_and_reference_does_not_grant_tools(tmp_path):
    baseline = package()
    manifest = deepcopy(baseline['manifest'])
    manifest['roles']['reviewer'] = {'prompt_ref': 'members/reviewer.md', 'capabilities': []}
    manifest['components']['reviewer'] = {'class': 'O', 'kind': 'role', 'ref': 'reviewer'}
    registered = make_package({**baseline['files'], 'members/reviewer.md': 'A reusable member verifies evidence.'}, manifest)
    runtime = Nexgent(tmp_path, package=registered, gateway_factory=ScriptedGatewayFactory(policy))
    runtime.set_auto_improve(False)
    state = runtime.create('Inspect evidence', context={'organization': {'members': [{'name': 'forged'}]}}, capabilities=[])
    assert state['task']['context']['organization']['members'][0]['name'] == 'reviewer'
    result = runtime.run(state['id'])
    [assignment] = runtime.team(result['id'])['assignments']
    child = runtime.store.get(assignment['episode_id'])
    assert child['task']['capabilities'] == []
    assert child['root_episode_id'] == result['id']
    assert child['task']['context']['agent']['instructions'] == 'A reusable member verifies evidence.'


def test_product_team_cli_is_readable_without_model_calls(tmp_path, capsys):
    import json
    from nexgent import cli
    assert cli.main(['--root', str(tmp_path), 'team']) == 0
    assert json.loads(capsys.readouterr().out)['members'] == []


def test_directory_preview_does_not_activate_unused_role(tmp_path):
    initial = framework_package(members={'analyst': 'Use the complete evidence when assigned. ' * 40})
    source = "def execute(payload, context):\n    r=context.publish('done',name='result')\n    return {'deliverables':{'result':r['id']}}\n"
    initial = make_package({**initial['files'], 'agent/main.py': source}, initial['manifest'])
    runtime = Nexgent(tmp_path, package=initial)
    runtime.set_auto_improve(False)
    task = runtime.create('A direct task requiring no members', budget={'max_model_calls': 0})
    assert len(task['task']['context']['organization']['members'][0]['instructions']) == 600
    result = runtime.run(task['id'])
    assert not runtime.team(result['id'])['assignments']
    assert 'members/analyst.md' not in runtime.store.get(result['id'])['execution']['loaded_modules']
    assert not any(event['kind'] == 'package_member_activated' for event in runtime.store.events(result['id']))


def test_later_feedback_creates_new_attempt_but_same_feedback_does_not_repeat(tmp_path):
    from test_project_improvement import strategy

    def abstain(_, payload):
        if 'candidate_options' in payload:
            return {'schema': 'nexgent.ordinary-development-plan.v1', 'candidate_type': 'no_change',
                    'source_ref': None, 'hypothesis': None, 'reason': 'Current evidence does not justify a change'}
        return {'status': 'passed', 'score_available': True, 'score': 8, 'accepted': True,
                'feedback': 'Delivery checked', 'checks': [{'requirement': 'Task delivery is complete', 'passed': True}]}

    gateway = ScriptedGatewayFactory(abstain)
    runtime = Nexgent(tmp_path, package=strategy(), gateway_factory=gateway)
    source = runtime.run(runtime.create('Prepare the original task')['id'])
    runtime.run(runtime.create('A distinct historical task')['id'])
    runtime.feedback(source['id'], 'First improvement request')
    runtime.advance(source['id'])
    [first] = runtime.store.feedback_triggers()
    assert first['status'] == 'no_change'
    calls = len(gateway.calls)
    runtime.advance(source['id'])
    assert len(gateway.calls) == calls
    # Upgrade an existing project's original source-only uniqueness index.
    with runtime.store.connect() as db:
        db.execute('DROP INDEX task_feedback_outbox_source')
        db.execute('CREATE UNIQUE INDEX task_feedback_outbox_source '
                   'ON task_feedback_outbox(channel_id,parent_revision,source_episode) '
                   'WHERE channel_id IS NOT NULL AND parent_revision IS NOT NULL')
    runtime = Nexgent(tmp_path, gateway_factory=gateway)
    assert runtime.store.feedback_trigger(first['id'])['status'] == 'no_change'
    runtime.feedback(source['id'], 'A different correction for future work')
    assert len(runtime.store.feedback_triggers()) == 2
    runtime.advance(source['id'])
    assert len(gateway.calls) == calls + 1
    calls = len(gateway.calls)
    runtime.advance(source['id'])
    assert len(gateway.calls) == calls
    old_feedback = runtime.auto_evolution._services()[1].feedback(first['feedback_bundle']['id'])
    assert [item['text'] for item in old_feedback['episode_refs'][0]['user_feedback']] == ['First improvement request']


def test_main_budget_is_explicit_and_does_not_change_saved_tasks(qtbot, tmp_path):
    from test_project_improvement import strategy, policy as previous_policy
    runtime = Nexgent(tmp_path, package=strategy(), gateway_factory=ScriptedGatewayFactory(previous_policy))
    runtime.set_auto_improve(False)
    window = MainWindow(tmp_path, service=runtime)
    qtbot.addWidget(window)
    window.task_calls.setValue(7)
    window.composer.setPlainText('Complete a short task')
    window.send_message()
    qtbot.waitUntil(lambda: window.worker is None, timeout=30000)
    saved = runtime.store.get(window.selected_id)
    assert saved['budget']['max_model_calls'] == 7
    assert saved['budget']['max_completion_tokens'] == 28000
    window.task_calls.setValue(40)
    assert runtime.store.get(saved['id'])['budget']['max_model_calls'] == 7
    assert runtime.create('A new task')['budget']['max_model_calls'] == 40
