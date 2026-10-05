"""An ordinary rejected change informs a later real gated release."""
from copy import deepcopy

from nexgent import Nexgent
from nexgent.ui.main_window import MainWindow
from test_project_improvement import strategy, policy, CHILD
from test_task_seed import ScriptedGatewayFactory


def test_main_learns_from_rejection_and_carries_selected_plan_through_restart(qtbot, tmp_path):
    first_source = CHILD.replace('clear structured delivery', 'verbose repetitive delivery')
    plans, generated = [], []

    def responder(number, payload):
        if 'candidate_options' in payload:
            assert payload['release_criteria']['min_cost_reduction'] == .2
            experience = payload['development_experience']
            assert 'PRIVATE_GUARD_MATERIAL' not in repr(payload)
            plan = policy(number, payload)
            if plans:
                assert len(experience) == 1
                assert experience[0]['status'] == 'rejected'
                assert 'quality' in experience[0]['selection']['failed_gates']
                assert experience[0]['selection']['candidate']['quality'] == 6
                plan['reason'] = 'Previous repetition reduced quality; improve structure without duplication'
                plan['hypothesis']['failure_mechanism'] = 'Repeated prose obscured the useful structure'
            plans.append(deepcopy(plan))
            return plan
        if 'parent_components' in payload:
            assert payload['development_context']['release_criteria']['min_cost_reduction'] == .2
            assert payload['development_context']['plan'] == plans[-1]
            assert 'PRIVATE_GUARD_MATERIAL' not in repr(payload)
            generated.append(deepcopy(payload['development_context']))
            patch = policy(number, payload)
            if len(generated) == 1:
                patch['operations'][0]['content'] = first_source
            return patch
        report = policy(number, payload)
        if payload['evidence']['deliverables']['result'] == 'verbose repetitive delivery':
            report.update(score=6, accepted=True, status='passed')
        return report

    gateway = ScriptedGatewayFactory(responder)
    runtime = Nexgent(tmp_path, package=strategy(), gateway_factory=gateway)
    window = MainWindow(tmp_path, runtime)
    qtbot.addWidget(window)
    window.show()

    def send(text):
        window.composer.setPlainText(text)
        window.send_button.click()
        qtbot.waitUntil(lambda: window.worker is None and window._recovery_worker is None, timeout=30000)
        return runtime.get(window.selected_id)

    original = send('Prepare a project summary')
    send('PRIVATE_GUARD_MATERIAL')
    window.show_task(original['id'])
    window.composer.setPlainText('Please structure future deliveries clearly')
    window.feedback_button.click()
    qtbot.waitUntil(lambda: window._recovery_worker is None, timeout=60000)
    [rejected] = runtime.store.feedback_triggers()
    assert rejected['status'] == 'rejected'
    assert runtime.team()['active_revision'] == 0
    window.close()

    restarted = Nexgent(tmp_path, gateway_factory=gateway)
    second_window = MainWindow(tmp_path, restarted)
    qtbot.addWidget(second_window)
    second_window.show()
    qtbot.waitUntil(lambda: second_window._recovery_worker is None, timeout=30000)
    second_window.show_task(original['id'])
    second_window.composer.setPlainText('Keep the useful structure and avoid repetition in future deliveries')
    second_window.feedback_button.click()
    qtbot.waitUntil(lambda: second_window._recovery_worker is None, timeout=60000)
    status = restarted.improvement_status()
    released = next(item for item in status['items'] if item['status'] == 'completed')
    assert status['active_revision'] == 1
    assert released['learning_from'] == [rejected['id']]
    assert '参考此前 1 次改进的实际结果' in second_window.improvement_view.toPlainText()
    work = restarted.store.feedback_trigger(released['id'])
    frozen = deepcopy(work['development_intent']['experience'])
    generation = restarted.auto_evolution._services()[1].generation(work['candidate']['generation_id'])
    generation_task = restarted.store.get(generation['episode_id'])
    context = generation_task['task']['inputs']['development_context']
    assert context == generated[-1] and context['experience'] == frozen
    calls = len(gateway.calls)
    restarted.advance()
    assert len(gateway.calls) == calls
    second_window.close()

    later_runtime = Nexgent(tmp_path, gateway_factory=gateway)
    later_runtime.set_auto_improve(False)
    later = later_runtime.run(later_runtime.create('Prepare another kind of delivery')['id'])
    assert later_runtime.store.read(later['output_refs']['result'], later['id'])['content'] == 'clear structured delivery'
    assert later_runtime.store.feedback_trigger(work['id'])['development_intent']['experience'] == frozen
    assert later_runtime.improvement_status(original['id'])['items'][-1]['reuse_episode_ids'] == [later['id']]
