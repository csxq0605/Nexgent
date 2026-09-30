from pathlib import Path

import pytest

from nexgent.organization import OrganizationService
from test_organization import Model


class ResumeModel(Model):
    unavailable = True

    def ask(self, role, prompt, payload, **kwargs):
        if 'Perform your assigned' in prompt and payload['role'] == 'Verify' and self.unavailable:
            raise RuntimeError('temporary provider failure')
        result = super().ask(role, prompt, payload, **kwargs)
        if 'Assign the task' in prompt:
            return {'assignments': [{'member': 'analyst', 'task': 'Produce', 'depends_on': [], 'required_tools': ['write_artifact']},
                                    {'member': 'checker', 'task': 'Verify', 'depends_on': ['analyst'], 'required_tools': ['read_text']}],
                    'peer_review': False}
        if 'Perform your assigned' in prompt:
            trace = payload['tool_results']
            if not trace:
                if payload['role'] == 'Produce':
                    return {'tool': 'write_artifact', 'arguments': {'name': 'report.txt', 'content': 'real work'}}
                path = payload['upstream_results'][0]['artifacts'][0]['path']
                return {'tool': 'read_text', 'arguments': {'path': path}}
        if role == 'improver':
            return {'organization': None, 'reason': 'Keep'}
        return result


def failed_task(root):
    service = OrganizationService(root, gateway_factory=ResumeModel)
    with service.store.connect() as db:
        import json
        db.execute('UPDATE active SET value=?', (json.dumps({'members': [{'name': 'analyst', 'role': 'Produce'},
                                                                        {'name': 'checker', 'role': 'Verify'}], 'instructions': 'Work'}),))
    run = service.run('Produce and verify')
    assert run['status'] == 'failed'
    return service, run


def test_resume_reuses_completed_member_and_preserves_cost(tmp_path):
    service, first = failed_task(tmp_path)
    artifact = next(e['finding']['artifacts'][0] for e in first['events'] if e['stage'] == 'member_finished')
    class Available(ResumeModel):
        unavailable = False
        def ask(self, role, prompt, payload, **kwargs):
            assert 'acceptance rubric' not in prompt and 'Assign the task' not in prompt
            if 'Perform your assigned' in prompt:
                assert payload['role'] == 'Verify'
            return super().ask(role, prompt, payload, **kwargs)
    resumed = OrganizationService(tmp_path, gateway_factory=Available).resume(first['id'])
    assert resumed['status'] == 'completed'
    assert resumed['id'] == first['id']
    assert resumed['resume_count'] == 1
    assert any(e['stage'] == 'member_reused' for e in resumed['events'])
    assert resumed['result']['artifacts'] == [artifact]
    assert Path(artifact['path']).read_text() == 'real work'
    assert resumed['result']['model_calls'] == resumed['usage']['model_calls'] - 2  # rubric + improver
    assert resumed['usage']['model_calls'] > first['usage']['model_calls']
    with pytest.raises(ValueError):
        service.resume(resumed['id'])


def test_main_and_cli_resume_use_the_same_saved_task(tmp_path, qtbot, monkeypatch, capsys):
    from nexgent.ui.organization_window import OrganizationWindow
    from nexgent.cli import main
    service, first = failed_task(tmp_path)
    class Available(ResumeModel):
        unavailable = False
    service.gateway_factory = Available
    window = OrganizationWindow(tmp_path, service)
    qtbot.addWidget(window)
    assert window.resume_button.isEnabled()
    window.resume_button.click()
    qtbot.waitUntil(lambda: window.worker is None, timeout=10000)
    assert service.store.get(first['id'])['status'] == 'completed'
    assert not window.resume_button.isEnabled()

    service, another = failed_task(tmp_path)
    service.gateway_factory = Available
    monkeypatch.setattr('nexgent.organization.OrganizationService', lambda *args, **kwargs: service)
    assert main(['--root', str(tmp_path), 'run-resume', another['id']]) == 0
    import json
    assert json.loads(capsys.readouterr().out)['id'] == another['id']


def test_resume_rechecks_required_actions_against_actual_cached_tool_results(tmp_path):
    service, failed = failed_task(tmp_path)
    event = next(e for e in failed['events'] if e['stage'] == 'member_finished')
    original_path = event['finding']['artifacts'][0]['path']
    event['finding']['tool_results'] = []  # Older saved member prose claimed completion.
    event['finding'].pop('missing_tools', None)
    service.store.save(failed)

    class Available(ResumeModel):
        unavailable = False

    run = OrganizationService(tmp_path, gateway_factory=Available).resume(failed['id'])
    assert run['status'] == 'completed'
    assert not any(e['stage'] == 'member_reused' for e in run['events'])
    assert run['result']['artifacts'][0]['path'] != original_path
    assert Path(original_path).read_text() == 'real work'
    assert [e['tool_results'][0]['tool'] for e in run['result']['execution_evidence']] == ['write_artifact', 'read_text']
