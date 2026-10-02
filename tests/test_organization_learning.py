import json

import pytest

from nexgent.organization import OrganizationService
from test_organization import Model


class Keep(Model):
    def ask(self, role, prompt, payload, **kwargs):
        result = super().ask(role, prompt, payload, **kwargs)
        return {'organization': None, 'reason': 'Keep'} if role == 'improver' else result


def test_learning_replays_original_context_and_uses_new_feedback_then_persists_change(tmp_path):
    service = OrganizationService(tmp_path, gateway_factory=Keep)
    source = service.run('First task', inputs={'fact': 17})
    service.run('Later unrelated task', conversation_id=source['conversation_id'])
    feedback = service.feedback(source['id'], 'Avoid duplicate contributions, use fewer members where possible')

    class Learn(Model):
        def ask(self, role, prompt, payload, **kwargs):
            assert 'acceptance rubric' not in prompt
            task = payload.get('task', {})
            if task.get('objective') == source['objective']:
                assert task['conversation'] == source['context']
                assert task['inputs'] == source['inputs']
                assert task['user_feedback'] == [feedback]
                assert 'learning_request' in task
            return super().ask(role, prompt, payload, **kwargs)

    service.gateway_factory = Learn
    learned = service.learn(source['id'])
    assert learned['id'] != source['id']
    assert learned['learning_source_id'] == source['id']
    assert learned['rubric'] == source['rubric']
    assert service.store.get(source['id']) == source
    assert learned['evolution']['status'] == 'adopted'
    assert learned['evolution']['regression']['passed']
    later = OrganizationService(tmp_path, gateway_factory=Model).run('Another different task')
    assert later['revision'] == 1
    assert len(later['organization']['members']) == 1


def test_rejected_learning_preserves_original_delivery_and_active_team(tmp_path):
    service = OrganizationService(tmp_path, gateway_factory=Keep)
    source = service.run('Original')
    class BadChange(Model):
        reject = True
    service.gateway_factory = BadChange
    learned = service.learn(source['id'])
    assert learned['status'] == 'completed'
    assert learned['evolution']['status'] == 'rejected'
    assert service.store.active()[0] == 0
    assert service.store.get(source['id']) == source


def test_learning_keeps_target_feedback_outside_recent_project_window(tmp_path):
    service = OrganizationService(tmp_path, gateway_factory=Keep)
    source = service.run('Old task')
    feedback = service.feedback(source['id'], 'Still relevant to this saved task')
    other = service.run('Other conversation')
    for i in range(21):
        service.feedback(other['id'], str(i))
    learned = service.learn(source['id'])
    assert feedback in learned['user_feedback']
    assert len(learned['user_feedback']) <= 20


def test_main_and_cli_can_explicitly_learn_saved_feedback(tmp_path, qtbot, monkeypatch, capsys):
    from nexgent.ui.organization_window import OrganizationWindow
    from nexgent.cli import main
    service = OrganizationService(tmp_path, gateway_factory=Keep)
    source = service.run('Saved task')
    window = OrganizationWindow(tmp_path, service)
    qtbot.addWidget(window)
    assert window.learn_button.isEnabled()
    window.composer.setPlainText('Save this feedback before learning')
    window.learn_button.click()
    assert not window.learn_button.isEnabled()
    qtbot.waitUntil(lambda: window.worker is None, timeout=10000)
    learned = service.store.list()[0]
    assert learned['learning_source_id'] == source['id']
    assert learned['user_feedback'][0]['text'] == 'Save this feedback before learning'
    assert service.store.feedback(source['id'])[0]['text'] == 'Save this feedback before learning'
    assert window.learn_button.isEnabled()
    monkeypatch.setattr('nexgent.organization.OrganizationService', lambda *args, **kwargs: service)
    assert main(['--root', str(tmp_path), 'learn', source['id']]) == 0
    assert json.loads(capsys.readouterr().out)['learning_source_id'] == source['id']


def test_learning_can_resume_and_counts_all_work_without_a_new_rubric(tmp_path):
    from test_organization_resume import ResumeModel
    class Available(ResumeModel):
        unavailable = False
    service = OrganizationService(tmp_path, gateway_factory=Available)
    with service.store.connect() as db:
        db.execute('UPDATE active SET value=?', (json.dumps({'members': [{'name': 'analyst', 'role': 'Produce'},
                                                                       {'name': 'checker', 'role': 'Verify'}], 'instructions': 'Work'}),))
    source = service.run('Produce and verify')
    assert source['status'] == 'completed'
    service.gateway_factory = ResumeModel
    failed = service.learn(source['id'])
    assert failed['status'] == 'failed'
    service.gateway_factory = Available
    resumed = service.resume(failed['id'])
    assert resumed['status'] == 'completed'
    assert resumed['learning_source_id'] == source['id']
    assert resumed['result']['model_calls'] == resumed['usage']['model_calls'] - 1  # improver only
    assert service.store.get(source['id']) == source


def test_unfinished_task_cannot_be_used_as_learning_source(tmp_path):
    service = OrganizationService(tmp_path, gateway_factory=Keep)
    source = service.run('Original')
    source.update(status='failed', answer=None, assessment=None)
    service.store.save(source)
    with pytest.raises(ValueError, match='evaluated task'):
        service.learn(source['id'])
    assert len(service.store.list()) == 1


def test_main_displays_delivered_organization_instead_of_similar_regression_assignment(tmp_path, qtbot):
    from nexgent.ui.organization_window import OrganizationWindow
    service = OrganizationService(tmp_path, gateway_factory=Model)
    run = service.run('Solve task')
    assert run['evolution']['status'] == 'adopted'
    run['events'].insert(-1, {'stage': 'assigned', 'arm': 'regression_candidate',
        'assignments': run['result']['assignments'], 'members': [{'name': 'analyst', 'role': 'Historical role'}]})
    window = OrganizationWindow(tmp_path, service)
    qtbot.addWidget(window)
    window.progress(run)
    displayed = window.info.toPlainText().split('运行进展')[0]
    assert '使用组织版本：1' in displayed
    assert run['result']['organization']['members'][0]['role'] in displayed
    assert 'Historical role' not in displayed


@pytest.mark.parametrize('has_history', [False, True])
def test_equal_current_work_requires_measured_improvement_elsewhere(tmp_path, has_history):
    class CurrentNeedsOne(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if 'Assign the task' in prompt and payload['task']['objective'] == 'Current task':
                return {'assignments': [{'member': 'analyst', 'task': 'Solve'}], 'peer_review': False}
            return result

    service = OrganizationService(tmp_path, gateway_factory=CurrentNeedsOne)
    if has_history:
        service.store.save({'id': 'previous', 'created': 0, 'conversation_id': 'other', 'objective': 'Previous task',
                            'inputs': {}, 'context': [], 'answer': 'accepted answer', 'assessment': {'accepted': True},
                            'rubric': {'criteria': 'Correct answer'}, 'evolution': {'status': 'abstained'}})
    run = service.run('Current task')
    parent = run.get('parent_result', run['result'])
    candidate = run['evolution']['candidate_result']
    assert parent['model_calls'] == candidate['model_calls']
    assert run['evolution']['status'] == ('adopted' if has_history else 'rejected')
    if has_history:
        regression = run['evolution']['regression']
        assert regression['passed']
        assert regression['work']['candidate']['model_calls'] < regression['work']['parent']['model_calls']
