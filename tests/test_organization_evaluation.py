import pytest

from nexgent.organization import OrganizationService
from test_organization_skills import Computing


def test_independent_evaluator_computes_with_base_tools_not_the_candidate_skill(tmp_path):
    class Checked(Computing):
        def ask(self, role, prompt, payload, **kwargs):
            if 'Independently evaluate' in prompt:
                assert all(not t['name'].startswith('skill_') for t in payload['tools'])
                assert not any(t['name'] in {'write_artifact', 'fetch_url'} for t in payload['tools'])
            return super().ask(role, prompt, payload, **kwargs)
    run = OrganizationService(tmp_path, gateway_factory=Checked).run('Compute', inputs={'numbers': [3, 9]})
    assert run['evolution']['status'] == 'adopted'
    own = run['assessment']['verification_evidence']
    assert own[0]['tool'] == 'run_python'
    assert own[0]['result']['value'] == {'sum': 12, 'squares': 90}
    assert run['result']['execution_evidence'][0]['tool_results'][0]['tool'].startswith('skill_')


def test_model_assessment_without_required_computation_cannot_pass(tmp_path):
    class Guessing(Computing):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if 'Independently evaluate' in prompt:
                return {'score': 10, 'accepted': True, 'feedback': 'Guess correct',
                        'checks': [{'requirement': 'Correct computation', 'passed': True}]}
            return result
    run = OrganizationService(tmp_path, gateway_factory=Guessing).run('Compute', inputs={'numbers': [1, 8]})
    assert run['status'] == 'failed'
    assert 'required independent numerical verification' in run['error']
    assert not run.get('assessment')


def test_evaluator_is_told_to_assess_after_its_last_available_tool_call(tmp_path):
    class Rechecking(Computing):
        def ask(self, role, prompt, payload, **kwargs):
            if 'Independently evaluate' in prompt:
                if payload['remaining_verification_calls']:
                    super().ask(role, prompt, payload, **kwargs)
                    return {'tool': 'run_python', 'arguments': {'code': 'return sum(payload)', 'payload': [3, 9]}}
                assert payload['tools'] == []
                assert 'complete final assessment' in payload['next_action']
            return super().ask(role, prompt, payload, **kwargs)
    run = OrganizationService(tmp_path, gateway_factory=Rechecking).run('Compute', inputs={'numbers': [3, 9]})
    assert run['status'] == 'completed'
    assert len(run['assessment']['verification_evidence']) == 4


@pytest.mark.parametrize('bad_tool', ['write_artifact', {'name': 'run_python', 'arguments': {'code': 'return 8', 'payload': {}}}])
def test_evaluator_cannot_write_or_use_a_nested_tool_name_and_can_recover(tmp_path, bad_tool):
    class AttemptsWrite(Computing):
        def ask(self, role, prompt, payload, **kwargs):
            if 'Independently evaluate' in prompt and not payload.get('verification_results'):
                # Model receipts still go through the existing test gateway.
                super().ask(role, prompt, payload, **kwargs)
                return {'tool': bad_tool, 'arguments': {'name': 'unwanted.txt', 'content': 'no'}}
            if 'Independently evaluate' in prompt and len(payload['verification_results']) == 1:
                super().ask(role, prompt, payload, **kwargs)
                return {'tool': 'run_python', 'arguments': {'code': 'return sum(payload)', 'payload': [2, 6]}}
            return super().ask(role, prompt, payload, **kwargs)
    run = OrganizationService(tmp_path, gateway_factory=AttemptsWrite).run('Compute', inputs={'numbers': [2, 6]})
    assert run['status'] == 'completed'
    trace = run['assessment']['verification_evidence']
    assert 'error' in trace[0]
    assert trace[1]['result']['value'] == 8
    assert not list(tmp_path.rglob('unwanted.txt'))
