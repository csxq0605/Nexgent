"""Planning gets useful adoption semantics without confusing audit hashes with IDs."""
import json

from nexgent import Nexgent
from nexgent.tasks.packages import make_package
from test_application import CheckResult
from test_task_capability_adoption import _tool_proposal


def test_used_task_tool_is_an_opaque_candidate_for_gated_future_adoption(tmp_path):
    proposal = _tool_proposal()
    source = ("def execute(payload, context):\n"
              "    definition = context.develop_tool("+repr(proposal)+")\n"
              "    result = context.tool(definition['name'], {'value': 21})\n"
              "    artifact = context.publish(result, name='result')\n"
              "    return {'deliverables': {'result': artifact['id']}}\n")
    package = make_package({'main.py': source}, {'entries': {'execute': 'main.py:execute'}})
    runtime = Nexgent(tmp_path, package=package, evaluator=CheckResult({'answer': 42}))
    runtime.set_auto_improve(False)
    runtime.run(runtime.create('A historical use of the general computation')['id'])
    result = runtime.run(runtime.create('The current use of the general computation',
                         context={'private_evaluator_answer': 'PRIVATE-ANSWER'})['id'])
    assert result['evaluation']['accepted'] is True
    runtime.feedback(result['id'], 'Reuse this capability for future tasks after independent checks.')
    runtime.auto_evolution.drain()
    work = next(w for w in runtime.store.feedback_triggers()
                if w['source_episode_id'] == result['id'] and w.get('feedback_bundle'))
    options = runtime.auto_evolution._candidate_options(
        work, runtime.get_private(result['id']), runtime.evolution.active(runtime.main_channel))
    [tool] = [o for o in options if o['candidate_type'] == 'tool']
    definition = runtime.store.tool_definition(tool['source_ref'])
    assert tool['source_ref'] == definition['id']
    assert tool['source_ref'] != 'definition-' + definition['digest']
    assert tool['evidence']['description'] == proposal['description']
    assert tool['evidence']['current_scope'] == 'creator_episode'
    assert tool['evidence']['effect_class'] == 'local_compute'
    assert 'future authorized tasks' in tool['evidence']['proposed_change']
    assert 'definition_digest' not in tool['evidence']
    assert 'PRIVATE-ANSWER' not in json.dumps(options)
    assert proposal['source'] not in json.dumps(options)
    assert runtime.evolution.active(runtime.main_channel)['revision'] == 0
