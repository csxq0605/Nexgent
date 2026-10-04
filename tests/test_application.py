"""Integration contracts for interchangeable framework compositions."""
import json

from nexgent import Nexgent
from nexgent.tasks.packages import make_package
from nexgent.tasks.tools import ToolProvider, ToolRegistry, ToolSpec


class CheckResult:
    id = 'test.result'

    def __init__(self, expected):
        self.expected = expected
        self.seen = []

    def snapshot(self):
        return {'id': self.id, 'version': 1}

    def evaluate(self, task, delivered, execution):
        self.seen.append((task, delivered, execution))
        passed = delivered['result'] == self.expected
        return {'status': 'passed' if passed else 'failed', 'score_available': True,
                'score': 10 if passed else 0, 'accepted': passed}


def package(source):
    return make_package({'main.py': source}, {'entries': {'execute': 'main.py:execute'}})


def provider():
    tool = ToolSpec('numbers.double', {'type': 'object', 'required': ['value']},
                    {'type': 'object'}, 'local_compute',
                    lambda args, ctx: {'value': args['value'] * 2},
                    provider_id='test.numbers', provider_version='1', handler_digest='a' * 64)
    registry = ToolRegistry()
    registry.register_provider(ToolProvider('test.numbers', '1', (tool,)))
    return registry


def test_default_framework_package_uses_existing_component_and_release_interfaces(tmp_path):
    from nexgent.application import framework_package
    runtime = Nexgent(tmp_path)
    active = runtime.evolution.active(runtime.main_channel)['package']
    assert active == framework_package()
    assert active['manifest']['manifest_version'] == 2
    assert active['manifest']['components']['task-loop'] == {'class': 'O', 'kind': 'entry', 'ref': 'execute'}
    assert active['manifest']['workflows'] == {}
    assert {runtime.tools.get(n).provider_id for n in runtime.default_capabilities} == {'nexgent.workspace'}
    assert runtime.create('Use ordinary capabilities')['budget']['max_tool_work_units'] == 200_000
    assert runtime.create('Respect an explicit work limit',
                          budget={'max_tool_work_units': 0})['budget']['max_tool_work_units'] == 0


def test_registered_provider_and_python_strategy_execute_through_normal_entry(tmp_path):
    strategy = package('''def execute(payload, context):
    value = context.tool('numbers.double', {'value': 6})
    ref = context.publish(value, name='result')
    return {'deliverables': {'result': ref['id']}, 'summary': 'Doubled value'}
''')
    evaluator = CheckResult({'value': 12})
    runtime = Nexgent(tmp_path, tools=provider(), package=strategy, evaluator=evaluator)
    task = runtime.create('Double the supplied value')
    result = runtime.run(task['id'])
    assert result['status'] == 'completed'
    assert result['evaluation']['accepted']
    assert result['task']['capability_mode'] == 'leased'
    assert result['execution']['kind'] == 'controlled_code'
    assert evaluator.seen[0][2]['tool_calls'][0]['capability_descriptor']['provider_id'] == 'test.numbers'
    assert runtime.evolution.active(runtime.main_channel)['package_digest'] == strategy['digest']


TEAM = '''def execute(payload, context):
    agent = payload.get('context', {}).get('agent')
    if agent:
        data = context.read_artifact(payload['input_refs']['data'])['content']
        answer = context.tool('numbers.double', {'value': data['value']})
        ref = context.publish({'member': agent['name'], 'instructions': agent['instructions'],
                               'value': answer['value']}, name='result')
        return {'deliverables': {'result': ref['id']}, 'summary': agent['name']}
    results = context.parallel([
        {'method': 'delegate', 'params': {'task': {
            'objective': 'Compute the first contribution', 'inputs': {'data': {'value': 3}},
            'agent': {'name': 'first', 'instructions': 'Compute one distinct contribution'}}}},
        {'method': 'delegate', 'params': {'task': {
            'objective': 'Compute the second contribution', 'inputs': {'data': {'value': 4}},
            'agent': {'name': 'second', 'instructions': 'Compute the other contribution'}}}},
    ])
    findings = [context.read_artifact(item['value']['output_refs']['result'])['content'] for item in results]
    ref = context.publish({'value': sum(item['value'] for item in findings),
                           'members': [item['member'] for item in findings]}, name='result')
    return {'deliverables': {'result': ref['id']}, 'summary': 'Combined actual member results'}
'''


def test_members_are_executable_delegated_episodes_with_real_tools_and_results(tmp_path, monkeypatch):
    runtime = Nexgent(tmp_path, tools=provider(), package=package(TEAM),
                      evaluator=CheckResult({'value': 14, 'members': ['first', 'second']}))
    advanced = []
    def advance(identity, **kwargs):
        advanced.append(identity)
        return {'configured': True, 'work': [], 'rounds': 0}
    monkeypatch.setattr(runtime, 'advance', advance)
    result = runtime.run(runtime.create('Combine independent contributions')['id'])
    assert result['status'] == 'completed', result.get('last_error')
    assert result['evaluation']['accepted']
    assert len(result['children']) == 2
    assert {s['task']['context']['agent']['name'] for s in result['children']} == {'first', 'second'}
    assert result['usage']['tool_calls'] == 2
    assert result['usage']['model_calls'] == 0
    assert advanced == [result['id']]
    assert result['auto_evolution']['configured'] is True
    assert {m['agent']['name'] for m in runtime.evaluator.seen[0][2]['members']} == {'first', 'second'}


def test_strategy_and_evaluator_are_independently_replaceable(tmp_path):
    first = package("def execute(payload, context):\n    r=context.publish(1,name='result')\n    return {'deliverables':{'result':r['id']}}\n")
    second = package("def execute(payload, context):\n    r=context.publish(2,name='result')\n    return {'deliverables':{'result':r['id']}}\n")
    runtime = Nexgent(tmp_path, tools=provider(), package=first, evaluator=CheckResult(2))
    original = runtime.run(runtime.create('Deliver 2')['id'])
    assert original['status'] == 'completed' and not original['evaluation']['accepted']
    # Registering an independent baseline is composition, not claimed RSI adoption.
    runtime.evolution.register('alternate', second)
    changed = runtime.run(runtime.create('Deliver 2', package_channel='alternate')['id'])
    assert changed['evaluation']['accepted']
    assert changed['package_digest'] == second['digest']
    one_off = runtime.run(runtime.create('Deliver 2', package=second)['id'])
    assert one_off['evaluation']['accepted']
    assert 'package_channel_registration' not in one_off['task']['context']
    assert runtime.evolution.active(runtime.main_channel)['package_digest'] == first['digest']
    assert runtime.get(original['id'])['evaluation']['accepted'] is False


def test_feedback_and_conversation_survive_restart_and_learning_cannot_deploy(tmp_path):
    strategy = package("def execute(payload, context):\n    r=context.publish('answer',name='result')\n    return {'deliverables':{'result':r['id']},'summary':'answer'}\n")
    runtime = Nexgent(tmp_path, tools=provider(), package=strategy, evaluator=CheckResult('answer'))
    initial = runtime.run(runtime.create('Do the work', context={'conversation_id': 'conversation'})['id'])
    runtime.feedback(initial['id'], 'Use a separate checker when needed')
    restarted = Nexgent(tmp_path, tools=provider(), evaluator=CheckResult('answer'))
    next_task = restarted.create('Different work', context={'conversation_id': 'conversation'})
    assert next_task['task']['context']['conversation'][0]['deliverables'] == {'result': 'answer'}
    assert next_task['task']['context']['user_feedback'][0]['text'] == 'Use a separate checker when needed'
    replay = restarted.learn(initial['id'])
    assert replay['task']['context']['learning_source_id'] == initial['id']
    assert restarted.evolution.active(restarted.main_channel)['revision'] == 0
    assert restarted.advance(replay['id'])['configured'] is True
    assert restarted.improvement_status()['items'][0]['reason'] == 'waiting_for_distinct_completed_task'
    assert restarted.evolution.active(restarted.main_channel)['revision'] == 0


def test_workspace_provider_writes_and_reads_actual_output_without_special_executor(tmp_path):
    strategy = package('''def execute(payload, context):
    artifact = context.tool('write_artifact', {'name': 'result.txt', 'content': 'actual delivery'})
    read = context.tool('read_text', {'path': artifact['path']})
    ref = context.publish(read['content'], name='result')
    return {'deliverables': {'result': ref['id']}}
''')
    runtime = Nexgent(tmp_path, package=strategy, evaluator=CheckResult('actual delivery'))
    result = runtime.run(runtime.create('Write and read a text delivery')['id'])
    assert result['status'] == 'completed', result.get('last_error')
    assert result['evaluation']['accepted']
    assert list((tmp_path / '.nexgent' / 'workspace-outputs').glob('*/result.txt'))[0].read_text() == 'actual delivery'


def test_cli_and_main_use_same_framework_composition(tmp_path, monkeypatch, capsys, qtbot):
    from nexgent.cli import main
    from nexgent.ui.main_window import MainWindow
    strategy = package("def execute(payload, context):\n    r=context.publish('framework',name='result')\n    return {'deliverables':{'result':r['id']},'summary':'framework'}\n")
    runtime = Nexgent(tmp_path, tools=provider(), package=strategy, evaluator=CheckResult('framework'))
    monkeypatch.setattr('nexgent.application.Nexgent', lambda *args, **kwargs: runtime)
    assert main(['--root', str(tmp_path), 'run', 'Ordinary CLI task']) == 0
    cli_result = json.loads(capsys.readouterr().out)
    window = MainWindow(tmp_path, runtime)
    qtbot.addWidget(window)
    window.composer.setPlainText('Ordinary Main task')
    window.send_button.click()
    qtbot.waitUntil(lambda: window.worker is None, timeout=20000)
    gui_result = runtime.get(window.selected_id)
    assert cli_result['package_digest'] == gui_result['package_digest'] == strategy['digest']
    assert gui_result['evaluation']['accepted']
    assert 'framework' in window.messages.toPlainText()


def test_default_host_evaluator_uses_separate_package_and_readonly_capabilities(tmp_path):
    from test_task_seed import ScriptedGatewayFactory
    strategy = package("def execute(payload, context):\n    r=context.publish({'value':12},name='result')\n    return {'deliverables':{'result':r['id']}}\n")
    def policy(number, payload):
        if number == 1:
            assert all(t['effect_class'] in {'read', 'local_compute'} for t in payload['tools'])
            return {'tool': 'numbers.double', 'arguments': {'value': 6}}
        assert payload['verification_results'][0]['result']['value'] == 12
        return {'status': 'passed', 'score_available': True, 'score': 10, 'accepted': True,
                'feedback': 'Verified independently',
                'checks': [{'requirement': 'The doubled value equals 12', 'passed': True}]}
    gateway = ScriptedGatewayFactory(policy)
    runtime = Nexgent(tmp_path, tools=provider(), package=strategy, gateway_factory=gateway)
    result = runtime.run(runtime.create('Double 6')['id'])
    assert result['evaluation']['accepted'], result['evaluation']
    evaluation = runtime.get(result['evaluation']['evaluation_episode_id'])
    assert evaluation['package_digest'] != strategy['digest']
    assert evaluation['task']['context']['memory_writeback'] is False
    assert len(runtime.list()) == 1
    assert len(evaluation['calls']) == 2


def test_configured_evolution_runs_from_sdk_without_a_ui_or_cli_coordinator(tmp_path):
    from test_auto_runtime import _write_config
    from test_task_seed import ScriptedGatewayFactory
    from nexgent.application import framework_package
    _write_config(tmp_path)
    seed = framework_package()
    files = dict(seed['files'])
    files['agent/main.py'] = "def execute(payload, context):\n    r=context.publish(1,name='result')\n    return {'deliverables':{'result':r['id']}}\n"
    strategy = make_package(files, seed['manifest'])
    def policy(number, payload):
        assert 'feedback_bundle' in payload and 'candidate_options' in payload
        return {'schema': 'nexgent.ordinary-development-plan.v1',
                'candidate_type': 'no_change', 'source_ref': None,
                'hypothesis': None, 'reason': 'No change is justified by the evidence'}
    gateway = ScriptedGatewayFactory(policy)
    runtime = Nexgent(tmp_path, tools=provider(), package=strategy,
                      evaluator=CheckResult(1), gateway_factory=gateway)
    result = runtime.run(runtime.create('Deliver 1')['id'])
    assert result['evaluation']['accepted']
    assert result['auto_evolution']['configured']
    assert result['auto_evolution']['work'][0]['status'] == 'no_change'
    assert len(gateway.calls) == 1
    assert runtime.evolution.active(runtime.main_channel)['package_digest'] == strategy['digest']
