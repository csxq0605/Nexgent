"""A lead must not turn an unknown provider outcome into a fresh delegation."""
from nexgent.models.gateway import ModelTransportError
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService


SOURCE = '''def execute(payload, context):
    if payload['objective'] == 'member assignment':
        value = context.ask('member', 'Process assigned evidence', max_tokens=8)
        ref = context.publish(value, name='result')
        return {'deliverables': {'result': ref['id']}}
    for attempt in range(3):
        result = context.delegate({'objective': 'member assignment',
                                   'agent': {'name': 'analyst', 'instructions': 'Inspect assigned evidence.'}})
        if result['status'] == 'completed':
            value = context.read_artifact(result['output_refs']['result'])['content']
            ref = context.publish(value, name='result')
            return {'deliverables': {'result': ref['id']}}
    raise ValueError('Member attempts exhausted')
'''


def test_unknown_terminal_transport_receipt_pauses_lead_and_reuses_child_after_restart(tmp_path):
    calls = []

    def factory(reserve, stop):
        class Gateway:
            def ask(self, **params):
                calls.append(params)
                receipt = {'call_id': 'member-timeout', 'role': params['role'], 'status': 'started',
                           'billing_status': 'unknown', 'reserved_completion_tokens': params['max_tokens']}
                reserve(receipt)
                reserve({**receipt, 'status': 'failed', 'error_type': 'ModelTransportError',
                         'transport_diagnostics': {'connection_phase': 'unknown', 'stage': 'worker_wait'}})
                raise ModelTransportError('Remote completion is unknown', {'connection_phase': 'unknown'})
        return Gateway()

    tasks = TaskService(tmp_path, gateway_factory=factory)
    package = make_package({'main.py': SOURCE}, {'entries': {'execute': 'main.py:execute'}})
    parent = tasks.create('Lead task', package=package)
    result = tasks.run(parent['id'])
    assert result['status'] == 'waiting_input'
    assert len(calls) == 1
    assert len(result['child_episode_ids']) == 1
    child_id = result['child_episode_ids'][0]
    assert tasks.store.get(parent['id'])['task']['context']['delegation_scope']['remaining_depth'] == 2
    assert tasks.store.get(child_id)['task']['context']['delegation_scope']['assignment'] == 'member'
    assert tasks.store.get(child_id)['task']['context']['delegation_scope']['remaining_depth'] == 1
    assert tasks.store.get(child_id)['status'] == 'waiting_input'
    assert 'reconciliation' in tasks.store.get(child_id)['last_error']
    restarted = TaskService(tmp_path, gateway_factory=factory)
    resumed = restarted.run(parent['id'])
    assert resumed['status'] == 'waiting_input'
    assert resumed['child_episode_ids'] == [child_id]
    assert len(calls) == 1
    assert resumed['usage']['model_calls'] == 1
    assert resumed['usage']['usage_complete'] is False


def test_known_connection_failure_remains_failed_without_unknown_recovery(tmp_path):
    def factory(reserve, stop):
        class Gateway:
            def ask(self, **params):
                raise ModelTransportError('No connection established', {'connection_phase': 'connect'})
        return Gateway()
    tasks = TaskService(tmp_path, gateway_factory=factory)
    package = make_package({'main.py': SOURCE}, {'entries': {'execute': 'main.py:execute'}})
    result = tasks.run(tasks.create('member assignment', package=package)['id'])
    assert result['status'] == 'failed'
    assert result['failure_domain'] == 'infrastructure'
