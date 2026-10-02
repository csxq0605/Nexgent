"""Observed discovery drives new work, with actual tools and resumable rounds."""
from pathlib import Path

import pytest

from nexgent.organization import OrganizationService, INITIAL_ORGANIZATION
from test_organization import Model


class DiscoveryModel(Model):
    @staticmethod
    def continuation():
        return {'recruits': [{'name': 'calculator', 'role': 'Compute and produce deliverables'}],
                'assignments': [
                    {'member': 'calculator', 'task': 'Compute and write', 'required_tools': ['query_csv', 'write_artifact']},
                    {'member': 'checker', 'task': 'Verify actual file', 'depends_on': ['calculator'],
                     'required_tools': ['query_csv', 'read_text']}], 'peer_review': False,
                'reason': 'Actual routing requires calculation, a report and independent verification'}

    def ask(self, role, prompt, payload, **kwargs):
        # Keep the ordinary mock's real receipt accounting for every new call.
        continued = 'Continue collaboration' in prompt
        result = super().ask(role, 'Assign the task' if continued else prompt, payload, **kwargs)
        if continued:
            assert payload['requests'][0]['member'] == 'analyst'
            discovery = payload['completed_results'][0]['tool_results'][0]['result']['content']
            assert discovery == 'Use source-alpha.csv; sum amount and save report.md.'
            return self.continuation()
        if 'Assign the task' in prompt:
            return {'assignments': [{'member': 'analyst', 'task': 'Discover routing', 'required_tools': ['read_text']}],
                    'peer_review': False}
        if 'Perform your assigned' in prompt:
            trace = payload['tool_results']
            task = payload['assignment']
            if task == 'Discover routing':
                if not trace:
                    return {'tool': 'read_text', 'arguments': {'path': 'routing.md'}}
                return {'answer': trace[0]['result']['content'], 'follow_up': 'The actual routing file requires a CSV computation, report and independent verification.'}
            if not trace:
                assert payload['upstream_results'][0]['member'] == 'analyst'
                return {'tool': 'query_csv', 'arguments': {'path': 'source-alpha.csv', 'sql': 'SELECT SUM(CAST(amount AS INTEGER)) FROM data'}}
            if len(trace) == 1:
                assert trace[0]['result']['rows'] == [(25,)]
                if task == 'Compute and write':
                    return {'tool': 'write_artifact', 'arguments': {'name': 'report.md', 'content': 'Total amount: 25'}}
                writer = next(f for f in payload['upstream_results'] if f['member'] == 'calculator')
                return {'tool': 'read_text', 'arguments': {'path': writer['artifacts'][0]['path']}}
            return {'answer': 'Actual total 25; report written/read and independently checked.'}
        if role == 'improver':
            return {'organization': None, 'reason': 'No persistent change justified'}
        return result


def discovery_service(root):
    (root / 'routing.md').write_text('Use source-alpha.csv; sum amount and save report.md.', encoding='utf-8')
    (root / 'source-alpha.csv').write_text('item,amount\na,17\nb,8\n', encoding='utf-8')
    return OrganizationService(root, gateway_factory=DiscoveryModel)


def test_discovery_recruits_then_executes_dependent_independent_work(tmp_path):
    service = discovery_service(tmp_path)
    run = service.run('Read routing.md and perform the discovered work with independent verification')
    assert run['status'] == 'completed'
    result = run['result']
    assert [a['member'] for a in result['assignments']] == ['analyst', 'calculator', 'checker']
    assert [a.get('round', 0) for a in result['assignments']] == [0, 1, 1]
    assert [m['name'] for m in result['organization']['members']] == ['analyst', 'calculator', 'checker']
    events = [(e['stage'], e.get('member')) for e in run['events']]
    assert events.index(('member_finished', 'analyst')) < events.index(('member_started', 'calculator'))
    assert events.index(('member_finished', 'calculator')) < events.index(('member_started', 'checker'))
    assert [r['tool'] for r in result['execution_evidence'][-1]['tool_results']] == ['query_csv', 'read_text']
    assert run['assessment']['verification_evidence'][0]['tool'] == 'query_csv'
    assert Path(result['artifacts'][0]['path']).read_text() == 'Total amount: 25'
    assert not result['unresolved_requests'] and not result['unfulfilled_actions']
    assert service.store.active() == (0, INITIAL_ORGANIZATION)  # Task recruitment is not persistent adoption.


class LeadModel(DiscoveryModel):
    unavailable = False

    def ask(self, role, prompt, payload, **kwargs):
        if 'Perform your assigned' in prompt and payload['collaboration_round'] == 1 and self.unavailable:
            raise RuntimeError('provider temporarily unavailable after lead continuation')
        result = super().ask(role, prompt, payload, **kwargs)
        if 'Perform your assigned' in prompt:
            result.pop('follow_up', None)  # Actual models sometimes express the gap only in prose.
        if 'Synthesize' in prompt and len(payload['organization']['members']) == 1:
            assert payload['execution_evidence'][0]['tool_results'][0]['tool'] == 'read_text'
            return self.continuation()
        return result


def test_lead_normal_synthesis_can_continue_without_member_help_field(tmp_path):
    service = discovery_service(tmp_path)
    original = service.run('Do discovered work')
    service.gateway_factory = LeadModel
    run = service.run('Do discovered work again')
    assert run['status'] == 'completed'
    assert run['usage']['model_calls'] == original['usage']['model_calls']
    assert any(e['stage'] == 'follow_up_requested' and e['requests'][0]['member'] == 'lead' for e in run['events'])
    assert [a.get('round', 0) for a in run['result']['assignments']] == [0, 1, 1]


def test_resume_reuses_lead_initiated_plan_without_redeciding(tmp_path):
    discovery_service(tmp_path)
    class Unavailable(LeadModel):
        unavailable = True
    first = OrganizationService(tmp_path, gateway_factory=Unavailable).run('Do discovered work')
    assert first['status'] == 'failed'
    class Available(LeadModel):
        def ask(self, role, prompt, payload, **kwargs):
            if 'Synthesize' in prompt:
                assert len(payload['organization']['members']) == 3  # No new decision for cached discovery.
            assert 'Assign the task' not in prompt and 'Continue collaboration' not in prompt
            return super().ask(role, prompt, payload, **kwargs)
    run = OrganizationService(tmp_path, gateway_factory=Available).resume(first['id'])
    assert run['status'] == 'completed'
    assert [e['round'] for e in run['events'] if e['stage'] == 'member_reused'] == [0]


class ReassignModel(Model):
    unavailable = False

    def ask(self, role, prompt, payload, **kwargs):
        continued = 'Continue collaboration' in prompt
        result = super().ask(role, 'Assign the task' if continued else prompt, payload, **kwargs)
        if continued:
            return {'recruits': [], 'assignments': [{'member': 'analyst', 'task': 'Correct report',
                                                     'required_tools': ['write_artifact']}], 'peer_review': False}
        if 'Assign the task' in prompt:
            return {'assignments': [{'member': 'analyst', 'task': 'First report', 'required_tools': ['write_artifact']}],
                    'peer_review': False}
        if 'Perform your assigned' in prompt:
            if payload['collaboration_round'] == 1 and self.unavailable:
                raise RuntimeError('provider temporarily unavailable in new assignment')
            trace = payload['tool_results']
            if not trace:
                if payload['collaboration_round']:
                    previous = payload['upstream_results'][0]['artifacts'][0]
                    assert Path(previous['path']).read_text() == 'Draft needs correction'
                return {'tool': 'write_artifact', 'arguments': {'name': 'report.md',
                    'content': 'Corrected report' if payload['collaboration_round'] else 'Draft needs correction'}}
            if not payload['collaboration_round']:
                return {'answer': 'Initial evidence saved', 'follow_up': 'Correct the discovered incomplete draft'}
            return {'answer': 'Correction actually saved in a fresh directory'}
        if role == 'improver':
            return {'organization': None, 'reason': 'Keep defaults'}
        return result


def test_reassignment_preserves_old_file_and_both_execution_traces(tmp_path):
    run = OrganizationService(tmp_path, gateway_factory=ReassignModel).run('Produce a complete report')
    assert run['status'] == 'completed'
    artifacts = run['result']['artifacts']
    assert len({a['path'] for a in artifacts}) == 2
    assert [Path(a['path']).read_text() for a in artifacts] == ['Draft needs correction', 'Corrected report']
    assert [e['member'] for e in run['result']['execution_evidence']] == ['analyst', 'analyst']


def test_reassigned_actor_cannot_claim_its_earlier_tool_call_as_new_work(tmp_path):
    class FabricatesCorrection(ReassignModel):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if 'Perform your assigned' in prompt and payload['collaboration_round'] == 1:
                return {'answer': 'I wrote a report in the previous round, so correction is complete'}
            return result
    run = OrganizationService(tmp_path, gateway_factory=FabricatesCorrection).run('Produce a complete report')
    assert run['status'] == 'needs_revision'
    assert run['result']['unfulfilled_actions'] == [{'member': 'analyst', 'tools': ['write_artifact'], 'round': 1}]
    assert not run['assessment']['accepted']


def test_later_planning_cannot_expand_past_four_active_members(tmp_path):
    class TooMany(DiscoveryModel):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if 'Continue collaboration' in prompt:
                result['recruits'] = [{'name': n, 'role': 'Additional expertise'} for n in ['a', 'b', 'c', 'd']]
                result['assignments'] = [{'member': n, 'task': 'Work'} for n in ['a', 'b', 'c', 'd']]
            return result
    discovery_service(tmp_path)
    run = OrganizationService(tmp_path, gateway_factory=TooMany).run('Read routing.md and do the discovered work')
    assert run['status'] == 'failed'
    assert 'four distinct active members' in run['error']
    assert [e['member'] for e in run['events'] if e['stage'] == 'member_started'] == ['analyst']


def test_resume_caches_per_round_not_just_member_name(tmp_path):
    class Unavailable(ReassignModel):
        unavailable = True
    first = OrganizationService(tmp_path, gateway_factory=Unavailable).run('Produce a complete report')
    assert first['status'] == 'failed'
    original = next(e['finding']['artifacts'][0] for e in first['events'] if e['stage'] == 'member_finished')

    class Recover(ReassignModel):
        def ask(self, role, prompt, payload, **kwargs):
            assert 'Assign the task' not in prompt and 'Continue collaboration' not in prompt
            if 'Perform your assigned' in prompt:
                assert payload['collaboration_round'] == 1
            return super().ask(role, prompt, payload, **kwargs)

    run = OrganizationService(tmp_path, gateway_factory=Recover).resume(first['id'])
    assert run['status'] == 'completed'
    assert run['result']['artifacts'][0] == original
    assert Path(run['result']['artifacts'][1]['path']).read_text() == 'Corrected report'
    reused = [e for e in run['events'] if e['stage'] == 'member_reused']
    assert [e['round'] for e in reused] == [0]
    assert run['usage']['model_calls'] > first['usage']['model_calls']


@pytest.mark.parametrize('decline', [False, True])
def test_unresolved_help_cannot_be_accepted_and_rounds_are_bounded(tmp_path, decline):
    class Unresolved(Model):
        def ask(self, role, prompt, payload, **kwargs):
            continued = 'Continue collaboration' in prompt
            result = super().ask(role, 'Assign the task' if continued else prompt, payload, **kwargs)
            if continued and decline:
                return {'assignments': [], 'reason': 'Cannot resolve blocker'}
            if 'Assign the task' in prompt or continued:
                return {'assignments': [{'member': 'analyst', 'task': 'Attempt'}], 'peer_review': False}
            if 'Perform your assigned' in prompt:
                return {'answer': 'Still blocked', 'follow_up': 'Necessary work remains'}
            if role == 'improver':
                return {'organization': None, 'reason': 'No improvement'}
            return result
    run = OrganizationService(tmp_path, gateway_factory=Unresolved).run('Task with unresolved work')
    assert run['status'] == 'needs_revision'
    assert not run['assessment']['accepted']
    assert 'Necessary follow-up work remains unresolved' in run['assessment']['feedback']
    assert len(run['result']['attempts']) == 2
    assert max(e['round'] for e in run['events'] if e['stage'] == 'member_started') <= 2


def test_main_displays_actual_additional_team_and_round(qtbot, tmp_path):
    from nexgent.ui.organization_window import OrganizationWindow
    service = discovery_service(tmp_path)
    window = OrganizationWindow(tmp_path, service)
    qtbot.addWidget(window)
    window.composer.setPlainText('Read routing.md and complete the discovered work')
    window.send.click()
    qtbot.waitUntil(lambda: window.worker is None, timeout=10000)
    assert service.store.list()[0]['status'] == 'completed'
    assert 'calculator' in window.info.toPlainText()
    assert '追加第1轮' in window.info.toPlainText()


def test_invalid_improvement_feedback_reaches_next_proposer(tmp_path):
    class InvalidSkill(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if role == 'improver':
                result['organization']['skills'] = [{'name': 'count', 'description': 'Count payload values',
                    'code': 'def execute(payload, context):\n    total = 0\n    def add():\n        nonlocal total\n        total += 1\n    add()\n    return total'}]
            return result
    first = OrganizationService(tmp_path, gateway_factory=InvalidSkill).run('First task')
    assert first['status'] == 'completed' and first['evolution']['status'] == 'failed'
    assert 'Nonlocal' in first['error']

    class LearnFailure(Model):
        def ask(self, role, prompt, payload, **kwargs):
            result = super().ask(role, prompt, payload, **kwargs)
            if role == 'improver':
                feedback = payload['prior_feedback'][0]
                assert feedback['status'] == 'failed' and 'Nonlocal' in feedback['error']
                return {'organization': None, 'reason': 'Avoid repeating unsupported code'}
            return result
    next_run = OrganizationService(tmp_path, gateway_factory=LearnFailure).run('Different next task')
    assert next_run['status'] == 'completed' and next_run['evolution']['status'] == 'abstained'
