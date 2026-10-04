"""Ordinary execution proposes completion from published artifacts, then reviews."""
from nexgent import Nexgent
from nexgent.tasks.seed import default_package
from nexgent.tasks.runtime import TaskService
from test_task_seed import ScriptedGatewayFactory


def test_main_finishes_after_declared_publication_without_repeated_model_publication(tmp_path):
    calls = []

    def publish(_, payload):
        calls.append(payload)
        return {'request': {'method': 'publish', 'params': {'name': 'result', 'content': 'complete answer'}}}

    class Evaluate:
        id = 'publication-check'
        def snapshot(self):
            return {'version': 1}
        def evaluate(self, task, delivery, execution):
            assert delivery == {'result': 'complete answer'}
            return {'status': 'passed', 'score_available': True, 'score': 9, 'accepted': True}

    gateway = ScriptedGatewayFactory(publish)
    app = Nexgent(tmp_path, gateway_factory=gateway, evaluator=Evaluate())
    app.set_auto_improve(False)
    result = app.run(app.create('Deliver the complete answer')['id'])
    assert result['status'] == 'completed' and result['evaluation']['accepted']
    assert len(calls) == 1
    assert [item['role'] for item in gateway.calls] == ['task_agent', 'task_reviewer']
    assert len([a for a in app.store.artifacts(result['id']) if a['name'] == 'result']) == 1


def test_review_rejects_early_publication_and_agent_repairs_before_completion(tmp_path):
    observations = []
    def policy(_, payload):
        observations.append(payload)
        content = 'partial answer' if len(observations) == 1 else 'complete answer'
        return {'request': {'method': 'publish', 'params': {'name': 'result', 'content': content}}}

    def review(payload):
        complete = payload['candidate']['artifacts']['result']['content'] == 'complete answer'
        return {'approved': complete, 'findings': [] if complete else ['Required content is missing'],
                'repairs': [] if complete else ['Add the required content']}

    gateway = ScriptedGatewayFactory(policy, reviewer_policy=review)
    tasks = TaskService(tmp_path, gateway_factory=gateway)
    task = tasks.create('Deliver complete content', package=default_package(review_on_publication=True))
    result = tasks.run(task['id'])
    assert result['status'] == 'completed'
    assert tasks.store.read(result['output_refs']['result'], result['id'])['content'] == 'complete answer'
    assert len(observations) == 2
    assert 'Required content is missing' in str(observations[1]['history'])
    assert [call['role'] for call in gateway.calls] == ['task_agent', 'task_reviewer', 'task_agent', 'task_reviewer']


def test_intermediate_publication_does_not_complete_a_multi_deliverable_task(tmp_path):
    def policy(number, payload):
        name = 'first' if number == 1 else 'second'
        return {'request': {'method': 'publish', 'params': {'name': name, 'content': name + ' answer'}}}
    gateway = ScriptedGatewayFactory(policy)
    tasks = TaskService(tmp_path, gateway_factory=gateway)
    task = tasks.create('Deliver both outputs', package=default_package(review_on_publication=True),
                        deliverables=[{'name': 'first', 'schema': {}}, {'name': 'second', 'schema': {}}])
    result = tasks.run(task['id'])
    assert result['status'] == 'completed'
    assert set(result['output_refs']) == {'first', 'second'}
    assert [call['role'] for call in gateway.calls] == ['task_agent', 'task_agent', 'task_reviewer']


def test_final_allowed_decision_can_publish_and_complete_without_an_extra_agent_call(tmp_path):
    def policy(number, payload):
        name = 'result' if number == 20 else 'draft-' + str(number)
        return {'request': {'method': 'publish', 'params': {'name': name, 'content': 'Draft iteration ' + str(number)}}}
    gateway = ScriptedGatewayFactory(policy)
    tasks = TaskService(tmp_path, gateway_factory=gateway)
    task = tasks.create('Prepare drafts then publish the final result',
                        package=default_package(review_on_publication=True),
                        budget={'max_model_calls': 21})
    result = tasks.run(task['id'])
    assert result['status'] == 'completed'
    assert len([call for call in gateway.calls if call['role'] == 'task_agent']) == 20
    assert gateway.calls[-1]['role'] == 'task_reviewer'
    assert tasks.store.read(result['output_refs']['result'], result['id'])['content'] == 'Draft iteration 20'
