import json

import pytest

from nexgent.organization import OrganizationService
from test_organization import Model


@pytest.mark.parametrize('reusable', [False, None])
def test_task_specific_or_unreviewed_change_does_not_replace_persistent_team(tmp_path, reusable):
    class SpecificChange(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if role == 'improver':
                result['organization']['members'][0]['role'] = 'Write queue-guide.md from Python deque documentation'
            if 'Independently evaluate' in prompt and 'proposed_organization' in payload:
                assert 'queue-guide.md' in payload['proposed_organization']['members'][0]['role']
                if reusable is None:
                    result.pop('organization_reusable')
                else:
                    result.update(organization_reusable=False, organization_feedback='Persistent role hard-codes this task output filename and topic')
            return result

    service = OrganizationService(tmp_path, gateway_factory=SpecificChange)
    run = service.run('Write and verify queue-guide.md')
    assert run['status'] == 'completed'
    assert run['assessment']['accepted']
    assert service.store.active()[0] == 0
    assert run['evolution']['status'] == ('failed' if reusable is None else 'rejected')
    if reusable is False:
        assert run['evolution']['assessment']['accepted']
        assert 'task-specific' in run['evolution']['gate_feedback']


def test_feedback_persists_and_reaches_later_work_and_improvement(tmp_path):
    service = OrganizationService(tmp_path, gateway_factory=Model)
    first = service.run('first task')
    revision = service.store.active()
    feedback = service.feedback(first['id'], 'Show the method before the conclusion.')
    assert service.store.active() == revision

    class FeedbackModel(Model):
        def ask(self, role, prompt, payload, **kwargs):
            if 'Assign the task' in prompt or 'Perform your assigned' in prompt:
                assert payload['task']['user_feedback'] == [feedback]
            if role == 'improver':
                assert payload['user_feedback'] == [feedback]
            return super().ask(role, prompt, payload, **kwargs)

    restored = OrganizationService(tmp_path, gateway_factory=FeedbackModel)
    later = restored.run('second task', conversation_id=first['conversation_id'])
    assert later['status'] == 'completed'
    assert later['user_feedback'] == [feedback]

    class OtherConversation(Model):
        def ask(self, role, prompt, payload, **kwargs):
            if 'Assign the task' in prompt:
                assert payload['task']['user_feedback'] == []
            if role == 'improver':
                assert payload['user_feedback'] == [feedback]
            return super().ask(role, prompt, payload, **kwargs)
    assert OrganizationService(tmp_path, gateway_factory=OtherConversation).run('unrelated task')['status'] == 'completed'


def test_feedback_cli_records_without_model_execution(tmp_path, capsys):
    from nexgent.cli import main
    service = OrganizationService(tmp_path, gateway_factory=Model)
    run = service.run('task')
    assert main(['--root', str(tmp_path), 'feedback', run['id'], 'Too much duplicated work.']) == 0
    saved = json.loads(capsys.readouterr().out)
    assert service.store.feedback() == [saved]
    assert saved['run_id'] == run['id']
    with pytest.raises(ValueError):
        service.feedback('absent', 'feedback')
    with pytest.raises(ValueError):
        service.feedback(run['id'], '')


def test_main_feedback_button_saves_completed_delivery(tmp_path):
    from PyQt6.QtWidgets import QApplication
    from nexgent.ui.organization_window import OrganizationWindow
    app = QApplication.instance() or QApplication([])
    service = OrganizationService(tmp_path, gateway_factory=Model)
    run = service.run('task')
    window = OrganizationWindow(tmp_path, service)
    assert window.feedback_button.isEnabled()
    window.composer.setPlainText('Give a shorter conclusion next time.')
    window.feedback_button.click()
    assert service.store.feedback()[0]['run_id'] == run['id']
    assert not window.composer.toPlainText()
    assert '反馈已保存' in window.messages.toPlainText()
    # Optional organization improvement does not block feedback on delivery.
    run['events'].append({'stage': 'evaluated'})
    window.worker = object()
    window.progress(run)
    window.composer.setPlainText('Feedback while optional improvement is running.')
    window.feedback_button.click()
    assert service.store.feedback()[0]['text'] == 'Feedback while optional improvement is running.'
    window.worker = None
    window.new_conversation()
    assert not window.feedback_button.isEnabled()
    window.close()
    app.processEvents()


def test_main_shows_delivered_team_when_candidate_is_rejected(tmp_path):
    from PyQt6.QtWidgets import QApplication
    from nexgent.ui.organization_window import OrganizationWindow
    app = QApplication.instance() or QApplication([])
    class Reject(Model):
        reject = True
    service = OrganizationService(tmp_path, gateway_factory=Reject)
    result = service.run('task')
    assert result['evolution']['status'] == 'rejected'
    window = OrganizationWindow(tmp_path, service)
    window.progress(result)
    assert 'checker' in window.info.toPlainText().split('运行进展')[0]
    window.close()
    app.processEvents()


def test_optional_peer_review_format_failure_preserves_work(tmp_path):
    from nexgent.models.gateway import ModelOutputFormatError
    class BrokenReview(Model):
        def ask(self, role, prompt, payload, **kwargs):
            if 'Read the shared findings' in prompt:
                raise ModelOutputFormatError('invalid review JSON', code='invalid_json')
            return super().ask(role, prompt, payload, **kwargs)
    result = OrganizationService(tmp_path, gateway_factory=BrokenReview).run('task')
    assert result['status'] == 'completed'
    assert any(e['stage'] == 'peer_review_failed' for e in result['events'])
    assert result['assessment']['accepted']


def test_failed_mandatory_check_cannot_be_accepted_or_adopted(tmp_path):
    class ContradictoryEvaluator(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if 'Independently evaluate' in prompt:
                result.update(accepted=True, score=9,
                              checks=[{'requirement': 'Verifier actually reads the new report', 'passed': False}])
            return result
    service = OrganizationService(tmp_path, gateway_factory=ContradictoryEvaluator)
    result = service.run('Verify and read the report')
    assert result['status'] == 'needs_revision'
    assert not result['assessment']['accepted']
    assert result['assessment']['score'] <= 4
    assert len(result['result']['attempts']) == 2
    assert service.store.active()[0] == 0


@pytest.mark.parametrize('executes', [True, False])
def test_member_cannot_finish_without_own_required_tool(tmp_path, executes):
    (tmp_path / 'facts.txt').write_text('actual facts', encoding='utf-8')
    class Premature(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if 'Assign the task' in prompt:
                return {'assignments': [{'member': 'checker', 'task': 'Actually read facts', 'depends_on': [], 'required_tools': ['read_text']}], 'peer_review': False}
            if 'Perform your assigned' in prompt:
                if executes and payload.get('next_action') and payload['missing_required_tools']:
                    return {'tool': 'read_text', 'arguments': {'path': 'facts.txt'}}
                return {'answer': 'Claimed done'}
            if role == 'improver':
                return {'organization': None, 'reason': 'Keep'}
            return result
    # The first premature answer is sent back for completion, not accepted.
    run = OrganizationService(tmp_path, gateway_factory=Premature).run('Read facts')
    assert run['status'] == ('completed' if executes else 'needs_revision')
    assert run['assessment']['accepted'] == executes
    assert bool(run['result']['unfulfilled_actions']) == (not executes)
    if executes:
        assert run['result']['execution_evidence'][0]['member'] == 'checker'
