"""Member-created capabilities use the same public runtime and release gates.

Only the model boundary is deterministic for the context-service slice. Task,
delegation, workers, independent trials, promotion, guard and reload are real.
"""
import json
import uuid

import pytest

from nexgent import Nexgent
from nexgent.tasks.benchmarks import BenchmarkDescriptor
from nexgent.tasks.generation import GenerationService
from nexgent.tasks.improvers import ImproverService
from nexgent.tasks.packages import make_package
from nexgent.tasks.runtime import TaskService


HYPOTHESIS = {
    'failure_mechanism': 'A member capability is lost between task trees.',
    'expected_behavior': 'Later tasks load and use the portable component.',
    'applicability': 'Tasks needing the same transform contract.',
    'falsifier': 'Independent selection or guard rejects its actual use.',
}
TOOL = {
    'name': 'member.scale', 'description': 'Double an integer.',
    'source': "def execute(payload, context):\n    return {'value': payload['value'] * 2}\n",
    'input_schema': {'type': 'object', 'required': ['value']},
    'output_schema': {'type': 'object', 'required': ['value']},
}
SERVICE = {
    'name': 'member.scale_context', 'description': 'Supply a multiplier to model context.',
    'source': "def provide(payload, context):\n    value = payload['payload'].copy()\n    value['multiplier'] = 2\n    return {'payload': value, 'annotations': {}}\n",
}


def strategy(kind):
    source = f'''KIND = {kind!r}
TOOL = {TOOL!r}
SERVICE = {SERVICE!r}
def execute(payload, context):
    data = context.read_artifact(payload['input_refs']['data'])['content']
    member = payload.get('context', {{}}).get('agent')
    if member:
        if KIND == 'tool':
            context.develop_tool(TOOL)
        else:
            created = context.develop_service(SERVICE)
            context.activate_service(created['definition_id'], expected_revision=0)
    if not member and data.get('train'):
        child = context.delegate({{'objective': 'Build and use a reusable transform',
            'agent': {{'name': 'builder', 'instructions': 'Develop and use the transform'}},
            'inputs': {{'data': data}}}})
        answer = context.read_artifact(child['output_refs']['result'])['content']
    elif KIND == 'tool':
        tools = context.capability_inventory()['tools']
        if any(t['name'] == TOOL['name'] for t in tools):
            answer = context.tool(TOOL['name'], {{'value': data['value']}})
        else:
            answer = {{'value': data['value']}}
    else:
        answer = context.ask('transform', 'Apply the provided multiplier',
                             {{'value': data['value']}}, max_tokens=20)
    ref = context.publish(answer, name='result')
    return {{'deliverables': {{'result': ref['id']}}}}
'''
    return make_package({'main.py': source}, {
        'manifest_version': 2, 'entries': {'execute': 'main.py:execute'},
        'orchestrator': 'task-loop', 'roles': {}, 'workflows': {},
        'components': {'task-loop': {'class': 'O', 'kind': 'entry', 'ref': 'execute'}},
    })


def improver():
    source = f'''HYPOTHESIS = {HYPOTHESIS!r}
def execute(payload, context):
    options = context.read_artifact(payload['input_refs']['candidate_options'])['content']
    choice = next((o for o in options if o['candidate_type'] in ['tool', 'service_provider']), None)
    plan = {{'schema': 'nexgent.ordinary-development-plan.v1',
            'candidate_type': choice['candidate_type'] if choice else 'no_change',
            'source_ref': choice['source_ref'] if choice else None,
            'hypothesis': HYPOTHESIS if choice else None,
            'reason': 'Validate actual member contribution' if choice else 'No new reusable component'}}
    ref = context.publish(plan, name='development_plan')
    return {{'deliverables': {{'development_plan': ref['id']}}}}
def improve(payload, context):
    return {{'deliverables': {{}}}}
'''
    return make_package({'improver.py': source}, {
        'entries': {'execute': 'improver.py:execute', 'improve': 'improver.py:improve'}})


def gateway(reserve, stop):
    class Gateway:
        def ask(self, role, prompt, payload=None, max_tokens=4000):
            call_id = uuid.uuid4().hex
            reserve({'call_id': call_id, 'role': role, 'model': 'test-model',
                     'status': 'started', 'reserved_completion_tokens': max_tokens})
            reserve({'call_id': call_id, 'role': role, 'model': 'test-model',
                     'status': 'completed', 'billing_status': 'usage_reported',
                     'usage': {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2}})
            return {'value': payload['value'] * payload.get('multiplier', 1)}
    return Gateway()


class IndependentCheck:
    id = 'member-capability-check'
    descriptor = BenchmarkDescriptor(id=id, version='1', title='Member capability integration',
        splits=('development', 'selection', 'guard'), default_split='development',
        allowed_suite_roles=('qualification',))

    def __init__(self, guard_regression=False):
        self.guard_regression = guard_regression

    def snapshot(self):
        return {'version': 1, 'guard_regression': self.guard_regression}

    def describe(self):
        return {'id': self.id}

    def tasks(self, split='selection', seed=0):
        return [{'id': f'{split}/{seed}', 'objective': 'Apply the reusable transform',
                 'inputs': {'data': {'value': 13, 'train': False}}, 'capabilities': [],
                 'deliverables': [{'name': 'result', 'schema': {'type': 'object'}}],
                 'context': {'split': split}}]

    def evaluate(self, task, delivered, execution):
        passed = delivered['result']['value'] == task['inputs']['data']['value'] * 2
        if self.guard_regression and task.get('context', {}).get('split') == 'guard':
            passed = False
        return {'status': 'passed' if passed else 'failed', 'score_available': True,
                'score': int(passed), 'accepted': passed}


def system(root, kind, guard_regression=False):
    evaluator = IndependentCheck(guard_regression)
    bootstrap = TaskService(root)
    ImproverService(bootstrap).register('members-r0', improver(),
        {'mutable_paths': ['improver.py'], 'allowed_operations': ['replace']})
    config = {'schema': 'nexgent.auto-evolution-config.v1', 'improver_channel': 'members-r0',
              'bootstrap_default_improver': False, 'default_channel': 'members',
              'channels': {'members': {'evaluator_id': evaluator.id,
                  'candidate_types': [kind, 'no_change'],
                  'budget': {'max_model_calls': 4, 'max_completion_tokens': 100,
                             'max_tool_calls': 4, 'max_nodes': 48,
                             'max_tool_work_units': 200000},
                  'promotion_policy': {'min_quality_delta': .5, 'max_cost_ratio': 20,
                      'max_absolute_cost_when_parent_zero': 100,
                      'monitor_min_score': .5}}}}
    (root / 'nexgent.auto-evolution.json').write_text(json.dumps(config), encoding='utf-8')
    return Nexgent(root, package=strategy(kind), evaluator=evaluator,
                   benchmarks={evaluator.id: evaluator}, gateway_factory=gateway)


@pytest.mark.parametrize('kind', ['tool', 'service_provider'])
def test_member_capability_passes_existing_gates_and_new_runtime_reuses_it(tmp_path, kind):
    runtime = system(tmp_path, kind)
    original = runtime.run(runtime.create('Delegate development and use to a member',
        inputs={'data': {'value': 7, 'train': True}})['id'])
    assert original['status'] == 'completed', original.get('last_error')
    assert original['evaluation']['accepted']
    [work] = [w for w in runtime.store.feedback_triggers(limit=20)
              if w['source_episode_id'] == original['id']]
    assert work['status'] == 'completed', work
    bundle = GenerationService(runtime, runtime.evolution).feedback(work['feedback_bundle']['id'])
    member_id = original['children'][0]['id']
    assert {e['episode_id'] for e in bundle['episode_refs']} == {original['id'], member_id}
    assert runtime.evolution.active('members')['revision'] == 1
    assert [s['id'] for s in runtime.list()] == [original['id']]
    generation = GenerationService(runtime, runtime.evolution).generation(work['candidate']['generation_id'])
    assert generation['status'] == 'generated'
    evaluator = IndependentCheck()
    restarted = Nexgent(tmp_path, evaluator=evaluator,
                        benchmarks={evaluator.id: evaluator}, gateway_factory=gateway)
    reused = restarted.run(restarted.create('Use the released transform on different data',
        inputs={'data': {'value': 19, 'train': False}})['id'])
    assert reused['evaluation']['accepted']
    assert reused['package_id'] == work['candidate']['candidate_package_id']
    assert not reused['children']
    assert reused['execution']['activated_components']
    assert restarted.store.read(reused['output_refs']['result'], reused['id'])['content'] == {'value': 38}


def test_member_release_rolls_back_when_independent_guard_rejects_it(tmp_path):
    runtime = system(tmp_path, 'tool', guard_regression=True)
    parent = runtime.evolution.active('members')['package_id']
    original = runtime.run(runtime.create('Develop a member capability',
        inputs={'data': {'value': 7, 'train': True}})['id'])
    [work] = [w for w in runtime.store.feedback_triggers(limit=20)
              if w['source_episode_id'] == original['id']]
    assert work['status'] == 'rolled_back', work
    assert runtime.evolution.active('members')['package_id'] == parent
    assert original['evaluation']['accepted']
