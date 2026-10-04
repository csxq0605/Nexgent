"""Default product RSI across ordinary tasks, feedback, release and restart."""
from nexgent import Nexgent
from nexgent.project_improvement import REPLAY_ID, ProjectEvolution
from nexgent.tasks.packages import make_package
from nexgent.ui.main_window import MainWindow
from test_task_seed import ScriptedGatewayFactory


SOURCE = "def execute(payload, context):\n    r=context.publish('concise delivery',name='result')\n    return {'deliverables':{'result':r['id']}}\n"
CHILD = SOURCE.replace('concise delivery', 'clear structured delivery')


def strategy():
    return make_package({'main.py': SOURCE}, {
        'manifest_version': 2, 'entries': {'execute': 'main.py:execute'},
        'roles': {}, 'workflows': {}, 'skills': {}, 'orchestrator': 'task-loop',
        'components': {'task-loop': {'class': 'O', 'kind': 'entry', 'ref': 'execute'}}})


def policy(_, payload):
    if 'candidate_options' in payload:
        feedback = payload['feedback_bundle']['episode_refs'][0]
        assert feedback['user_feedback'][0]['text'] == 'Please structure future deliveries clearly'
        assert 'guard' not in repr(payload)  # Historical guard task is host-owned.
        return {'schema': 'nexgent.ordinary-development-plan.v1',
                'candidate_type': 'orchestration', 'source_ref': 'package_patch',
                'hypothesis': {'failure_mechanism': 'Delivery lacks useful structure',
                               'expected_behavior': 'Clearly structured deliveries',
                               'applicability': 'General task output presentation',
                               'falsifier': 'Later deliveries do not improve'},
                'reason': 'Apply the explicit public user feedback'}
    if 'parent_components' in payload:
        parent = strategy()
        return {'schema': 'nexgent.behavior-patch.v2',
                'hypothesis': {'component_id': 'task-loop',
                               'failure_mechanism': 'Unclear deliveries',
                               'expected_behavior': 'Clear deliveries',
                               'applicability': 'General task outputs',
                               'falsifier': 'Quality fails to improve'},
                'operations': [{'op': 'replace', 'component_id': 'task-loop',
                                'old_digest': parent['component_digests']['main.py'],
                                'content': CHILD}],
                'activation_probe': {'kind': 'component_loaded', 'component_id': 'task-loop'}}
    evidence = payload['evidence']
    correction = bool(evidence['task']['context'].get('learning_feedback'))
    changed = evidence['deliverables']['result'] == 'clear structured delivery'
    passed = not correction or changed
    return {'status': 'passed' if passed else 'failed', 'score_available': True,
            'score': 9 if changed else (7 if correction else 8), 'accepted': passed,
            'feedback': 'Checked original task and feedback',
            'checks': [{'requirement': 'Clear delivery when requested', 'passed': passed}]}


def test_default_main_feedback_gates_release_and_restart_reuses(qtbot, tmp_path):
    gateway = ScriptedGatewayFactory(policy)
    runtime = Nexgent(tmp_path, package=strategy(), gateway_factory=gateway)
    assert isinstance(runtime.auto_evolution, ProjectEvolution)
    window = MainWindow(tmp_path, service=runtime)
    qtbot.addWidget(window)
    window.show()

    def send(text):
        window.composer.setPlainText(text)
        window.send_message()
        qtbot.waitUntil(lambda: window.worker is None and window._recovery_worker is None, timeout=30000)
        return runtime.get(window.selected_id)

    source = send('Prepare a project summary')
    send('Describe the follow-up process')
    window.show_task(source['id'])
    window.composer.setPlainText('Please structure future deliveries clearly')
    window.save_feedback()
    qtbot.waitUntil(lambda: window._recovery_worker is None, timeout=30000)
    status = runtime.improvement_status()
    assert status['active_revision'] == 1, status
    [item] = status['items']
    assert item['status'] == 'completed' and item['promotion']['revision'] == 1
    assert '已发布' in window.improvement_view.toPlainText()
    assert status['usage']['model_calls'] == 5  # planner, generator, two arms, guard
    assert len(status['root_episode_ids']) == 5
    assert status['usage']['usage_complete']
    assert source['id'] not in status['root_episode_ids']
    calls = len(gateway.calls)
    runtime.advance()
    assert len(gateway.calls) == calls  # Durable phase evidence is not replayed.
    window.close()

    restarted = Nexgent(tmp_path, gateway_factory=gateway)
    later = restarted.run(restarted.create('Prepare a different deliverable')['id'])
    assert later['package_digest'] == status['items'][0]['promotion']['package_digest']
    assert restarted.store.read(later['output_refs']['result'], later['id'])['content'] == 'clear structured delivery'
    reuse = restarted.improvement_status()['items'][0]['reuse_episode_ids']
    assert reuse == [later['id']]
    assert restarted.improvement_status()['usage'] == status['usage']


def test_insufficient_history_waits_without_model_work_and_toggle_survives(tmp_path):
    gateway = ScriptedGatewayFactory(policy)
    runtime = Nexgent(tmp_path, package=strategy(), gateway_factory=gateway)
    source = runtime.run(runtime.create('Prepare a project summary')['id'])
    runtime.feedback(source['id'], 'Please structure future deliveries clearly')
    calls = len(gateway.calls)
    runtime.advance()
    assert len(gateway.calls) == calls
    status = runtime.improvement_status()
    assert status['items'][0]['status'] == 'observed'
    assert status['items'][0]['reason'] == 'waiting_for_distinct_completed_task'
    runtime.set_auto_improve(False)
    restarted = Nexgent(tmp_path, gateway_factory=gateway)
    assert not restarted.auto_improve_enabled
    restarted.run(restarted.create('A different completed task')['id'])
    calls = len(gateway.calls)
    assert restarted.advance()['enabled'] is False
    assert len(gateway.calls) == calls
    assert restarted.evolution.active(restarted.main_channel)['revision'] == 0
    restarted.set_auto_improve(True)
    restarted.advance()
    assert restarted.evolution.active(restarted.main_channel)['revision'] == 1


def test_regression_suite_freezes_inputs_feedback_and_disjoint_guard(tmp_path):
    gateway = ScriptedGatewayFactory(policy)
    runtime = Nexgent(tmp_path, package=strategy(), gateway_factory=gateway)
    runtime.set_auto_improve(False)
    source = runtime.run(runtime.create('Prepare a project summary', inputs={'facts': 'original'},
                         context={'custom': 'frozen'})['id'])
    guard = runtime.run(runtime.create('Another independent user request')['id'])
    runtime.feedback(source['id'], 'Please structure future deliveries clearly')
    [work] = runtime.store.feedback_triggers()
    runtime.store.publish(source['id'], {'guard': [], 'selection': []},
                          name='project-regression-' + work['id'], node_id='agent-publish')
    adapter = runtime.benchmark_adapters[REPLAY_ID].for_work(work)
    frozen = adapter.snapshot()
    assert adapter.tasks('selection')[0]['context']['custom'] == 'frozen'
    assert adapter.tasks('selection')[0]['inputs']['facts'] == 'original'
    assert adapter.tasks('guard')[0]['id'] == 'project:' + guard['id']
    assert adapter.tasks('selection')[0]['id'] != adapter.tasks('guard')[0]['id']
    runtime.feedback(source['id'], 'Later feedback must not change the admitted suite')
    runtime.run(runtime.create('Third new request')['id'])
    restarted = Nexgent(tmp_path, gateway_factory=gateway)
    assert restarted.benchmark_adapters[REPLAY_ID].for_work(work).snapshot() == frozen


def test_explicit_zero_never_starts_improvement_and_bare_success_is_not_a_signal(tmp_path):
    from test_application import CheckResult
    runtime = Nexgent(tmp_path, package=strategy(), evaluator=CheckResult('concise delivery'))
    for objective in ('First', 'Second'):
        runtime.run(runtime.create(objective)['id'])
    assert runtime.store.feedback_triggers() == []
    source = runtime.run(runtime.create('Zero calls', budget={'max_model_calls': 0})['id'])
    runtime.feedback(source['id'], 'Please structure future deliveries clearly')
    runtime.advance()
    assert runtime.store.feedback_triggers() == []
    assert runtime.improvement_status()['usage']['model_calls'] == 0


def test_default_guard_failure_rolls_back_and_counts_all_improvement_roots(tmp_path):
    def reject_guard(number, payload):
        report = policy(number, payload)
        evidence = payload.get('evidence', {})
        if (evidence.get('task', {}).get('objective') == 'Different guard request'
                and evidence.get('deliverables', {}).get('result') == 'clear structured delivery'):
            report.update(accepted=False, status='failed', score=2,
                          checks=[{'requirement': 'Guard remains fulfilled', 'passed': False}])
        return report
    gateway = ScriptedGatewayFactory(reject_guard)
    runtime = Nexgent(tmp_path, package=strategy(), gateway_factory=gateway)
    source = runtime.run(runtime.create('Prepare a project summary')['id'])
    runtime.run(runtime.create('Different guard request')['id'])
    runtime.feedback(source['id'], 'Please structure future deliveries clearly')
    runtime.advance()
    status = runtime.improvement_status()
    assert status['items'][0]['status'] == 'rolled_back'
    assert status['usage']['model_calls'] == 5
    assert len(status['root_episode_ids']) == 5
    assert runtime.evolution.active(runtime.main_channel)['package_digest'] == strategy()['digest']
    calls = len(gateway.calls)
    Nexgent(tmp_path, gateway_factory=gateway).advance()
    assert len(gateway.calls) == calls


def test_successful_member_capability_is_a_default_improvement_signal(tmp_path):
    from test_member_capability_evolution import strategy as member_strategy
    from test_application import CheckResult
    runtime = Nexgent(tmp_path, package=member_strategy('tool'), evaluator=CheckResult({'value': 6}))
    runtime.set_auto_improve(False)
    result = runtime.run(runtime.create('Develop and use a reusable capability',
                         inputs={'data': {'train': True, 'value': 3}})['id'])
    assert result['evaluation']['accepted'] is True
    [work] = runtime.store.feedback_triggers()
    assert work['source_episode_id'] == result['id']
    assert len(result['child_episode_ids']) == 1
    assert runtime.feedback_items(result['id']) == []


def test_product_improve_cli_reads_and_disables_without_model_calls(tmp_path, capsys):
    import json
    from nexgent import cli
    assert cli.main(['--root', str(tmp_path), 'improve', '--enable', 'off']) == 0
    status = json.loads(capsys.readouterr().out)
    assert status['configured'] and not status['enabled']
    assert status['usage']['model_calls'] == 0
    assert cli.main(['--root', str(tmp_path), 'improve', '--advance']) == 0
    status = json.loads(capsys.readouterr().out)
    assert not status['enabled'] and status['usage']['model_calls'] == 0


def test_main_renders_delivery_markdown_without_loading_output_links(qtbot, tmp_path):
    runtime = Nexgent(tmp_path)
    window = MainWindow(tmp_path, service=runtime)
    qtbot.addWidget(window)
    window._append('main', '# Result\n\n**Clear answer**\n\n[Reference](file:///private.txt)\n\n![image](file:///private.png)')
    text = window.messages.toPlainText()
    assert 'Result' in text and 'Clear answer' in text and 'Reference' in text
    assert '# Result' not in text and '**Clear answer**' not in text
    rendered = window.messages.toHtml()
    assert '<img' not in rendered and 'file:///private' not in rendered
    window._append('main', '- A delivered item')
    window._append('system', 'Separate run record')
    assert window.messages.textCursor().currentList() is None
