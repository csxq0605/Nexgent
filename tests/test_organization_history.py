import json

import pytest

from nexgent.organization import OrganizationService
from test_organization import Model


class KeepOrganization(Model):
    def ask(self, role, prompt, payload, **kwargs):
        result = super().ask(role, prompt, payload, **kwargs)
        return {'organization': None, 'reason': 'Keep'} if role == 'improver' else result


def saved_conversations(root):
    service = OrganizationService(root, gateway_factory=KeepOrganization)
    first = service.run('Earlier separate conversation')
    service.feedback(first['id'], 'Feedback on earlier task')
    second = service.run('Latest separate conversation')
    for i in range(21):
        service.feedback(second['id'], f'Latest feedback {i}')
    return service, first, second


def test_main_opens_previous_conversation_and_continues_its_context(tmp_path, qtbot):
    from nexgent.ui.organization_window import OrganizationWindow
    service, first, second = saved_conversations(tmp_path)
    window = OrganizationWindow(tmp_path, service)
    qtbot.addWidget(window)
    assert window.conversation_id == second['conversation_id']
    assert window.history_box.count() == 3
    window.history_box.setCurrentIndex(window.history_box.findData(first['conversation_id']))
    assert window.conversation_id == first['conversation_id']
    assert window._feedback_run_id == first['id']
    assert first['objective'] in window.messages.toPlainText()
    assert second['objective'] not in window.messages.toPlainText()
    assert 'Feedback on earlier task' in window.messages.toPlainText()
    window.composer.setPlainText('Continue earlier conversation')
    window.send.click()
    assert not window.history_box.isEnabled()
    qtbot.waitUntil(lambda: window.worker is None, timeout=10000)
    assert window.history_box.isEnabled()
    latest = service.store.list()[0]
    assert latest['conversation_id'] == first['conversation_id']
    assert [t['user'] for t in latest['context']] == [first['objective']]
    assert window.history_box.count() == 3
    window.new.click()
    assert window.conversation_id is None
    assert window.history_box.currentIndex() == 0
    assert not window.feedback_button.isEnabled()


def test_cli_saved_runs_and_feedback_are_read_without_model_calls(tmp_path, capsys):
    from nexgent.cli import main
    service, first, second = saved_conversations(tmp_path)
    receipts = service.store.receipts(first['id'])
    assert main(['--root', str(tmp_path), 'run-list']) == 0
    assert [r['id'] for r in json.loads(capsys.readouterr().out)] == [second['id'], first['id']]
    assert main(['--root', str(tmp_path), 'run-list', '--conversation', first['conversation_id']]) == 0
    assert [r['id'] for r in json.loads(capsys.readouterr().out)] == [first['id']]
    assert main(['--root', str(tmp_path), 'run-show', first['id']]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result['answer'] == first['answer']
    assert result['feedback'][0]['text'] == 'Feedback on earlier task'
    assert service.store.receipts(first['id']) == receipts
    assert main(['--root', str(tmp_path), 'run-show', second['id']]) == 0
    assert len(json.loads(capsys.readouterr().out)['feedback']) == 21
    with pytest.raises(SystemExit) as failure:
        main(['--root', str(tmp_path), 'run-show', 'missing'])
    assert failure.value.code == 2
