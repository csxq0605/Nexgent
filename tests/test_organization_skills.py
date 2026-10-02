import json
from copy import deepcopy

import pytest

from nexgent.organization import OrganizationService, organization
from nexgent.organization_tools import WorkspaceTools
from test_organization import Model


SKILL = {'name': 'number_summary', 'description': 'Payload is a list of numbers; returns sum and sum of squares.',
         'code': 'return {"sum": sum(payload), "squares": sum(n * n for n in payload)}'}


class Computing(Model):
    bad_skill = False
    def ask(self, role, prompt, payload, **kwargs):
        result = super().ask(role, prompt, payload, **kwargs)
        if 'Assign the task' in prompt:
            skill = bool(payload['organization'].get('skills'))
            assert any(t['name'] == 'skill_number_summary' for t in payload['available_tools']) == skill
            return {'assignments': [{'member': 'analyst', 'task': 'Compute',
                'required_tools': ['skill_number_summary' if skill else 'run_python']}], 'peer_review': False}
        if 'Perform your assigned' in prompt:
            trace = payload['tool_results']
            values = payload['task']['inputs']['numbers']
            if any(t['name'] == 'skill_number_summary' for t in payload['tools']):
                if not trace:
                    return {'tool': 'skill_number_summary', 'arguments': {'payload': values}}
            elif len(trace) < 2:
                code = 'return sum(payload)' if not trace else 'return sum(n * n for n in payload)'
                return {'tool': 'run_python', 'arguments': {'code': code, 'payload': values}}
            return {'answer': json.dumps([t['result']['value'] for t in trace])}
        if 'Independently evaluate' in prompt:
            if 'tool' in result:
                return result
            traces = [t for e in payload['execution_evidence'] for t in e['tool_results']]
            values = payload['task']['inputs']['numbers']
            expected = {'sum': sum(values), 'squares': sum(n * n for n in values)}
            correct = traces[0]['result']['value'] == expected if traces[0]['tool'].startswith('skill_') else [t['result']['value'] for t in traces] == list(expected.values())
            return {**result, 'accepted': correct, 'score': 10 if correct else 1,
                'feedback': 'Verified actual computation' if correct else 'Wrong saved computation',
                'checks': [{'requirement': 'Correct sum and sum of squares', 'passed': correct}]}
        if role == 'improver':
            candidate = deepcopy(payload['organization'])
            candidate['skills'] = [{**SKILL, 'code': 'return 0'}] if self.bad_skill else [deepcopy(SKILL)]
            if not payload['organization'].get('skills'):
                assert payload['computations'] and all('value' in c for c in payload['computations'])
            return {'organization': candidate, 'reason': 'Reuse computation instead of repeated code generation'}
        return result


def test_skill_is_trialed_gated_persisted_and_reused_on_new_inputs(tmp_path, qtbot, capsys):
    service = OrganizationService(tmp_path, gateway_factory=Computing)
    first = service.run('Calculate totals', inputs={'numbers': [3, 5, 8]})
    assert first['evolution']['status'] == 'adopted'
    assert first['parent_result']['model_calls'] > first['result']['model_calls']
    assert service.store.active()[1]['skills'] == [SKILL]
    later = OrganizationService(tmp_path, gateway_factory=Computing).run('Another calculation', inputs={'numbers': [2, 7, 11]})
    assert later['revision'] == 1
    record = later['result']['execution_evidence'][0]['tool_results'][0]
    assert record['tool'] == 'skill_number_summary'
    assert record['result']['value'] == {'sum': 20, 'squares': 174}
    assert record['result']['execution']['rpc_count'] == 0
    assert later['evolution']['status'] == 'unchanged'
    from nexgent.cli import main
    assert main(['--root', str(tmp_path), 'organization-show']) == 0
    assert json.loads(capsys.readouterr().out)['organization']['skills'] == [SKILL]
    from nexgent.ui.organization_window import OrganizationWindow
    window = OrganizationWindow(tmp_path, service)
    qtbot.addWidget(window)
    window.new.click()
    assert '已保存能力' in window.info.toPlainText()
    assert 'skill_number_summary' in window.info.toPlainText()


def test_unused_skill_cannot_be_deployed_even_with_other_measured_improvement(tmp_path):
    class Unused(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if role == 'improver':
                result['organization']['skills'] = [SKILL]
            return result
    service = OrganizationService(tmp_path, gateway_factory=Unused)
    run = service.run('Task without computation')
    assert run['evolution']['status'] == 'rejected'
    assert 'not successfully executed' in run['evolution']['gate_feedback']
    assert service.store.active()[0] == 0


def test_incorrect_skill_preserves_answer_and_does_not_deploy(tmp_path):
    class Incorrect(Computing):
        bad_skill = True
    service = OrganizationService(tmp_path, gateway_factory=Incorrect)
    run = service.run('Calculate', inputs={'numbers': [2, 9]})
    assert run['status'] == 'completed'
    assert run['assessment']['accepted']
    assert run['evolution']['status'] == 'rejected'
    assert not run['evolution']['assessment']['accepted']
    assert len(run['evolution']['candidate_result']['attempts']) == 2
    assert service.store.active()[0] == 0


@pytest.mark.parametrize('code', ['import os\nreturn 0', 'return open("secret")', 'return payload.__class__'])
def test_saved_code_uses_existing_validation_and_permissions(tmp_path, code):
    with pytest.raises(ValueError):
        organization({'members': [{'name': 'analyst', 'role': 'Compute'}], 'instructions': 'Work',
                      'skills': [{**SKILL, 'code': code}]})
    tools = WorkspaceTools(tmp_path, tmp_path / 'output', skills=[SKILL], allow_artifact_writes=False)
    assert not any(t['name'] == 'write_artifact' for t in tools.registry.describe())
    assert tools.call('skill_number_summary', {'payload': [4, 6]})['value'] == {'sum': 10, 'squares': 52}


def test_modified_existing_skill_requires_its_own_successful_trial(tmp_path):
    class UnusedModification(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if role == 'improver':
                result['organization']['skills'] = [{**SKILL, 'code': 'return sum(payload)'}]
            return result
    service = OrganizationService(tmp_path, gateway_factory=UnusedModification)
    initial = service.store.active()[1]
    initial['skills'] = [SKILL]
    with service.store.connect() as db:
        db.execute('UPDATE active SET value=?', (json.dumps(initial),))
    run = service.run('No computation')
    assert run['evolution']['status'] == 'rejected'
    assert service.store.active()[1]['skills'] == [SKILL]


@pytest.mark.parametrize('candidate_tokens,adopted', [(70, True), (90, False)])
def test_equal_calls_need_substantial_token_savings_not_small_noise(tmp_path, candidate_tokens, adopted):
    class SmallerResponses(Model):
        def __init__(self, root, *, reserve, **kwargs):
            self.small = False
            def record(receipt):
                receipt = deepcopy(receipt)
                if receipt['status'] == 'completed' and self.small:
                    receipt['usage']['total_tokens'] = candidate_tokens
                reserve(receipt)
            super().__init__(root, reserve=record, **kwargs)

        def ask(self, role, prompt, payload, **kwargs):
            org = payload.get('organization', payload.get('proposed_organization', {}))
            self.small = org.get('instructions') == 'Concise work' or payload.get('instructions') == 'Concise work'
            result = super().ask(role, prompt, payload, **kwargs)
            if 'Assign the task' in prompt:
                return {'assignments': [{'member': 'analyst', 'task': 'Solve'}], 'peer_review': False}
            if role == 'improver':
                return {'organization': {'members': payload['organization']['members'], 'instructions': 'Concise work'}, 'reason': 'Reduce tokens'}
            return result

    run = OrganizationService(tmp_path, gateway_factory=SmallerResponses).run('Same quality')
    parent = run.get('parent_result', run['result'])
    assert parent['model_calls'] == run['evolution']['candidate_result']['model_calls']
    assert run['evolution']['status'] == ('adopted' if adopted else 'rejected')
