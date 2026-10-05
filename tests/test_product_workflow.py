"""Ordinary user workflows, including restart and unfinished acceptance."""
from copy import deepcopy
import threading
import pytest

from nexgent import Nexgent
from nexgent.ui.main_window import MainWindow
from test_application import CheckResult, package, provider
from test_task_seed import ScriptedGatewayFactory


ANSWER = package("def execute(payload, context):\n    r=context.publish('answer',name='result')\n    return {'deliverables':{'result':r['id']}}\n")


def passed():
    return {'status': 'passed', 'score_available': True, 'score': 10, 'accepted': True,
            'feedback': 'Independently checked the delivery',
            'checks': [{'requirement': 'The supplied task is fulfilled', 'passed': True}]}


def test_evaluation_shares_original_task_budget_and_reports_all_calls(qtbot, tmp_path):
    gateway = ScriptedGatewayFactory(lambda *_: passed())
    runtime = Nexgent(tmp_path, package=ANSWER, gateway_factory=gateway)
    zero = runtime.run(runtime.create('Deliver answer', budget={'max_model_calls': 0})['id'])
    assert zero['status'] == 'completed' and zero['evaluation']['accepted'] is None
    assert zero['usage']['model_calls'] == 0
    task = runtime.run(runtime.create('Deliver answer', budget={'max_model_calls': 1})['id'])
    assert task['evaluation']['accepted'] is True
    assert task['evaluation']['verification_method'] == 'model_review'
    assert task['usage']['model_calls'] == 1
    evaluator = runtime.get(task['evaluation']['evaluation_episode_id'])
    assert evaluator['parent_episode_id'] == task['id']
    assert evaluator['root_episode_id'] == task['id']
    assert task['calls'] == evaluator['calls']
    assert len(runtime.list()) == 2
    window = MainWindow(tmp_path, runtime)
    qtbot.addWidget(window)
    window.show_task(task['id'])
    assert '模型审核通过' in window.status_label.text()
    assert '验收：模型审核通过' in window.delivery_view.toPlainText()


def test_numerical_verdict_without_verification_is_missing_evidence(tmp_path):
    strategy = package("def execute(payload, context):\n    value=context.tool('numbers.double',{'value':6})\n    r=context.publish(value,name='result')\n    return {'deliverables':{'result':r['id']}}\n")
    runtime = Nexgent(tmp_path, tools=provider(), package=strategy,
                      gateway_factory=ScriptedGatewayFactory(lambda *_: passed()))
    result = runtime.run(runtime.create('Double 6')['id'])
    assert result['evaluation']['accepted'] is None
    assert result['evaluation']['score_available'] is False
    assert result['evaluation']['status'] == 'verification_missing'
    assert result['usage']['model_calls'] == 5
    assert result['usage']['tool_calls'] == 1
    assert 'delivery_revision_id' not in result  # A reviewer failure is not agent rejection.


def test_developed_tool_does_not_break_independent_workspace_verification(tmp_path):
    strategy = package('''def execute(payload, context):
    context.develop_tool({
        'name': 'task.double', 'description': 'Double an integer',
        'source': 'def execute(payload, context):\\n    return {"value": payload["value"] * 2}\\n',
        'input_schema': {'type': 'object', 'properties': {'value': {'type': 'integer'}}, 'required': ['value']},
        'output_schema': {'type': 'object'}
    })
    value = context.tool('task.double', {'value': 6})
    ref = context.publish(value, name='result')
    return {'deliverables': {'result': ref['id']}}
''')
    def policy(number, payload):
        if number == 1:
            return {'tool': 'run_python', 'arguments': {
                'code': 'return {"value": payload["value"] * 2}', 'payload': {'value': 6}}}
        assert payload['verification_results'][0]['result']['value'] == {'value': 12}
        return passed()
    runtime = Nexgent(tmp_path, package=strategy, gateway_factory=ScriptedGatewayFactory(policy))
    result = runtime.run(runtime.create('Double 6 with a reusable tool')['id'])
    assert result['evaluation']['accepted'] is True
    assert result['usage']['tool_calls'] == 2


def test_evaluator_must_open_actual_file_before_accepting(tmp_path):
    strategy = package("def execute(payload, context):\n    file=context.tool('write_artifact',{'name':'result.txt','content':'answer'})\n    r=context.publish(file,name='result')\n    return {'deliverables':{'result':r['id']}}\n")
    def policy(number, payload):
        if number == 1:
            return passed()  # Premature assessment must be followed by an actual check.
        if number == 2:
            assert payload['verification_results'][-1]['missing_verification']
            path = payload['evidence']['deliverables']['result']['path']
            return {'tool': 'read_text', 'arguments': {'path': path}}
        assert payload['verification_results'][-1]['result']['content'] == 'answer'
        return passed()
    runtime = Nexgent(tmp_path, package=strategy, gateway_factory=ScriptedGatewayFactory(policy))
    result = runtime.run(runtime.create('Write answer to a file')['id'])
    assert result['evaluation']['accepted'] is True
    assert result['usage']['model_calls'] == 3
    assert result['usage']['tool_calls'] == 2


class FlakyEvaluator(CheckResult):
    def __init__(self):
        super().__init__('answer')
        self.attempts = 0

    def evaluate(self, *args):
        self.attempts += 1
        if self.attempts == 1:
            raise TimeoutError('Temporarily unavailable')
        return super().evaluate(*args)


def test_main_continue_retries_unavailable_evaluation_without_reexecuting(qtbot, tmp_path):
    evaluator = FlakyEvaluator()
    runtime = Nexgent(tmp_path, package=ANSWER, evaluator=evaluator)
    initial = runtime.run(runtime.create('Deliver answer')['id'])
    outputs = deepcopy(initial['output_refs'])
    window = MainWindow(tmp_path, runtime)
    qtbot.addWidget(window)
    window.show_task(initial['id'])
    assert window.continue_button.isEnabled()
    assert '待验收' in window.status_label.text()
    window.continue_button.click()
    qtbot.waitUntil(lambda: window.worker is None, timeout=20000)
    final = runtime.get(initial['id'])
    assert final['evaluation']['accepted'] is True
    assert final['output_refs'] == outputs
    assert evaluator.attempts == 2
    assert '验收通过' in window.status_label.text()
    assert not window.continue_button.isEnabled()


def test_stopped_default_evaluation_reuses_its_completed_model_call(tmp_path):
    strategy = package("def execute(payload, context):\n    r=context.publish({'value':12},name='result')\n    return {'deliverables':{'result':r['id']}}\n")
    def policy(number, payload):
        if number == 1:
            return {'tool': 'numbers.double', 'arguments': {'value': 6}}
        assert payload['verification_results'][0]['result']['value'] == 12
        return passed()
    gateway = ScriptedGatewayFactory(policy)
    runtime = Nexgent(tmp_path, tools=provider(), package=strategy, gateway_factory=gateway)
    stop = threading.Event()
    def update(state):
        if any(c['status'] == 'completed' for c in state.get('calls', [])):
            stop.set()
    first = runtime.run(runtime.create('Double 6')['id'], on_update=update, stop_event=stop)
    assert first['evaluation']['accepted'] is None
    reviewer_id = first['evaluation']['evaluation_episode_id']
    assert runtime.store.get(reviewer_id)['status'] == 'paused'
    final = Nexgent(tmp_path, tools=provider(), gateway_factory=gateway).run(first['id'])
    assert final['evaluation']['accepted'] is True
    assert final['evaluation']['evaluation_episode_id'] == reviewer_id
    assert final['usage']['model_calls'] == 2
    assert final['usage']['tool_calls'] == 1
    assert len(final['children']) == 1


def test_conversation_attachments_survive_restart_and_many_deliveries(qtbot, tmp_path):
    runtime = Nexgent(tmp_path, package=ANSWER, evaluator=CheckResult('answer'))
    original_file = tmp_path / 'notes.txt'
    original_file.write_text('Original facts', encoding='utf-8')
    attachments = runtime.attach_files([original_file])
    context = {'conversation_id': 'conversation'}
    first = runtime.run(runtime.create('Save original facts', inputs={'attachments': attachments}, context=context)['id'])
    original_file.write_text('Changed external source', encoding='utf-8')
    for index in range(5):
        runtime.run(runtime.create('Continue ' + str(index), context=context)['id'])
    restarted = Nexgent(tmp_path, evaluator=CheckResult('Original facts'))
    reader = package("def execute(payload, context):\n    files=context.read_artifact(payload['input_refs']['attachments'])['content']\n    text=context.tool('read_text',{'path':files[0]['path']})['content']\n    r=context.publish(text,name='result')\n    return {'deliverables':{'result':r['id']}}\n")
    restored = restarted.create('Read original attachment', context=context, package=reader)
    assert restored['task']['inputs']['attachments'] == attachments
    result = restarted.run(restored['id'])
    assert result['evaluation']['accepted'] is True
    window = MainWindow(tmp_path, restarted)
    qtbot.addWidget(window)
    window.show_task(result['id'])
    assert window.attachments == attachments
    assert 'notes.txt' in window.run_view.toPlainText()
    window.new_conversation()
    assert window.attachments == []
    assert restarted.create('Unrelated conversation')['task']['inputs'].get('attachments', []) == []


def test_feedback_replay_keeps_original_context_and_inputs(tmp_path):
    runtime = Nexgent(tmp_path, package=ANSWER, evaluator=CheckResult('answer'))
    initial = runtime.run(runtime.create('Original job', inputs={'facts': ['original']},
        context={'conversation_id': 'conversation', 'domain_hint': 'original custom context'})['id'])
    runtime.feedback(initial['id'], 'Use the original facts')
    runtime.run(runtime.create('Future job', inputs={'facts': ['future']},
                               context={'conversation_id': 'conversation'})['id'])
    replay = Nexgent(tmp_path, evaluator=CheckResult('answer')).learn(initial['id'])
    assert replay['task']['inputs'] == initial['task']['inputs']
    for key in ('domain_hint', 'conversation', 'user_feedback'):
        assert replay['task']['context'][key] == initial['task']['context'][key]
    assert replay['task']['context']['learning_feedback'][0]['text'] == 'Use the original facts'
    assert 'future' not in str(replay['task']['inputs'])
    assert runtime.evolution.active(runtime.main_channel)['revision'] == 0


CORRECTION = package('''def execute(payload, context):
    value = 'wrong'
    if 'independent_feedback' in payload['input_refs']:
        feedback = context.read_artifact(payload['input_refs']['independent_feedback'])['content']
        previous = context.read_artifact(payload['input_refs']['previous_delivery'])['content']
        if feedback['accepted'] is False and previous['result'] == 'wrong':
            value = 'correct'
    r = context.publish(value, name='result')
    return {'deliverables': {'result': r['id']}}
''')


def test_rejected_delivery_is_corrected_and_rechecked_in_same_user_task(tmp_path):
    evaluator = CheckResult('correct')
    runtime = Nexgent(tmp_path, package=CORRECTION, evaluator=evaluator)
    result = runtime.run(runtime.create('Deliver correct result')['id'])
    assert result['evaluation']['accepted'] is True
    assert result['delivery_revision_evaluated'] is True
    child = runtime.get(result['delivery_revision_id'])
    assert child['parent_episode_id'] == result['id']
    assert child['package_digest'] == result['package_digest']
    assert runtime.store.read(result['output_refs']['result'], result['id'])['content'] == 'correct'
    assert any(a['id'] == result['output_refs']['result'] and a['content'] == 'correct'
               for a in result['artifacts'])
    assert len(evaluator.seen) == 2
    assert len(runtime.list()) == 1
    runtime.run(result['id'])
    assert len(evaluator.seen) == 2
    assert runtime.evolution.active(runtime.main_channel)['revision'] == 0


def test_resumed_revised_delivery_keeps_a_definite_rejection_without_repeated_review(tmp_path):
    class MissingSecondReview(CheckResult):
        def __init__(self):
            super().__init__('still missing')
            self.attempts = 0
        def evaluate(self, *args):
            self.attempts += 1
            if self.attempts == 2:
                raise TimeoutError('Second review temporarily unavailable')
            return super().evaluate(*args)
    evaluator = MissingSecondReview()
    runtime = Nexgent(tmp_path, package=CORRECTION, evaluator=evaluator)
    original = runtime.create('Deliver a correct result')
    first = runtime.run(original['id'])
    assert first['evaluation']['accepted'] is None
    final = runtime.run(original['id'])
    assert final['evaluation']['accepted'] is False
    assert final['delivery_revision_evaluated'] is True
    assert evaluator.attempts == 3
    runtime.run(original['id'])
    assert evaluator.attempts == 3


def test_stopped_correction_resumes_its_persisted_child_after_restart(tmp_path):
    runtime = Nexgent(tmp_path, package=CORRECTION, evaluator=CheckResult('correct'))
    stop = threading.Event()
    def update(state):
        if state.get('delivery_revision_id'):
            stop.set()
    original = runtime.create('Deliver correct result')
    interrupted = runtime.run(original['id'], on_update=update, stop_event=stop)
    child_id = interrupted['delivery_revision_id']
    assert interrupted['evaluation']['accepted'] is False
    assert runtime.store.get(child_id)['status'] == 'paused'
    restarted = Nexgent(tmp_path, evaluator=CheckResult('correct'))
    final = restarted.run(original['id'])
    assert final['delivery_revision_id'] == child_id
    assert final['evaluation']['accepted'] is True
    assert len(final['children']) == 1


@pytest.mark.parametrize('action_envelope', [False, True])
def test_main_default_strategy_finishes_published_work_in_both_completion_forms(qtbot, tmp_path, action_envelope):
    from test_task_seed import published_id
    def policy(number, payload):
        if number == 1:
            return {'request': {'method': 'publish', 'params': {'name': 'result', 'content': 'answer'}}}
        done = {'deliverables': {'result': published_id(payload)}, 'summary': 'Actual published answer',
                'limitations': []}
        return {'request': {'method': 'done', 'params': done}} if action_envelope else {'done': done}
    runtime = Nexgent(tmp_path, evaluator=CheckResult('answer'), gateway_factory=ScriptedGatewayFactory(policy))
    window = MainWindow(tmp_path, runtime)
    qtbot.addWidget(window)
    window.composer.setPlainText('Deliver answer')
    window.send_button.click()
    qtbot.waitUntil(lambda: window.worker is None, timeout=20000)
    final = runtime.get(window.selected_id)
    assert final['status'] == 'completed', final.get('last_error')
    assert final['evaluation']['accepted'] is True
    assert final['usage']['model_calls'] == 2
    assert len(final['calls']) == 2
    assert all(call['status'] in {'received', 'completed'} for call in final['calls'])
    assert len(runtime.list()) == 1
