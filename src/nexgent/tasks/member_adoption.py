"""Compile a model-designed reusable team through the existing package gates.

The model describes responsibilities, rather than authoring manifest deltas.
Actual completed members supply the available source identities. Generation,
paired evaluation, promotion and rollback remain owned by existing services.
"""
from copy import deepcopy

from ..kernel.programs import digest
from .members import used_members
from .packages import IDENTIFIER, make_package
from .tools import ContractError


DESIGN_PROMPT = '''Design reusable member responsibilities and coordination from
the completed members and explicit human feedback supplied as data. Never copy
task-specific facts, names, answers or attachments into persistent instructions.
Select only relevant members; omit those that do not justify reuse. Keep names
from the supplied source identities. Return exactly {"members": [{"name":
"source name", "instructions": "general responsibility and method"}],
"strategy": "general guidance on choosing members, sharing evidence and synthesis"}.
At most eight members; instructions at most 3000 characters, strategy at most
2000 characters. Do not change the executor, permissions, evaluator or gates.
Independent trials will decide whether this organization helps future work.'''


DESIGN_SOURCE = '''def execute(payload, context):
    return {'deliverables': {}}

def improve(payload, context):
    feedback = context.read_artifact(payload['input_refs']['feedback_bundle'])['content']
    design = context.ask('rsi_team_designer', context.resource('design.md'), {
        'completed_members': SOURCES, 'feedback_bundle': feedback,
    }, max_tokens=5000)
    if (not isinstance(design, dict) or set(design) != set(['members', 'strategy'])
            or not isinstance(design['members'], list) or not 1 <= len(design['members']) <= 8
            or not isinstance(design['strategy'], str) or not design['strategy'].strip()
            or len(design['strategy']) > 2000):
        raise ValueError('Reusable team design needs members and a bounded strategy')
    patch = PATCH.copy()
    manifest = MANIFEST.copy()
    manifest['roles'] = MANIFEST['roles'].copy()
    manifest['components'] = MANIFEST['components'].copy()
    operations = []
    targets = []
    seen = []
    for member in design['members']:
        if (not isinstance(member, dict) or set(member) != set(['name', 'instructions'])
                or member.get('name') not in MAPPINGS or member['name'] in seen
                or not isinstance(member.get('instructions'), str)
                or not member['instructions'].strip() or len(member['instructions']) > 3000):
            raise ValueError('Reusable member must name a supplied source and bounded instructions')
        seen.append(member['name'])
        mapping = MAPPINGS[member['name']]
        if mapping['op'] == 'replace' and member['instructions'] == mapping['original_content']:
            continue
        manifest['roles'][mapping['role']] = mapping['role_definition']
        manifest['components'][mapping['component']] = mapping['component_definition']
        operation = {'op': mapping['op'], 'component_id': mapping['component'],
                     'content': member['instructions']}
        if mapping['op'] == 'replace':
            operation['old_digest'] = mapping['old_digest']
        else:
            operation['path'] = mapping['path']
        operations.append(operation)
        targets.append(mapping['component'])
    content = TASK_PROMPT + '\\n\\nReusable organization guidance:\\n' + design['strategy']
    operations.append({'op': 'replace', 'component_id': TASK_COMPONENT,
                       'old_digest': TASK_DIGEST, 'content': content})
    targets.append(TASK_COMPONENT)
    patch['operations'] = operations
    patch['child_manifest'] = manifest
    patch['activation_targets'] = targets
    patch['hypothesis'] = HYPOTHESIS.copy()
    patch['hypothesis']['component_ids'] = targets
    artifact = context.publish(patch, name='behavior_patch', schema='nexgent.package-patch.v3')
    return {'deliverables': {'behavior_patch': artifact['id']}}
'''


def member_sources(tasks, feedback, parent):
    return used_members(tasks.store, [ref['episode_id'] for ref in feedback['episode_refs']], parent)


def generate_team(tasks, evolution, generation, work, plan, stop_event=None):
    parent = evolution.active(work['channel_id'])['package']
    feedback = generation.feedback(work['feedback_bundle']['id'])
    sources = member_sources(tasks, feedback, parent)
    component = parent['manifest'].get('components', {}).get('task-instructions', {})
    if not sources or component.get('kind') != 'resource':
        raise ContractError('Team adoption requires completed members and mutable task instructions')
    mappings = {}
    for member in sources:
        name = member['name']
        if name in mappings:
            continue
        # Reuse an existing adopted role when it executes again in later work.
        role = parent['manifest'].get('roles', {}).get(name)
        registered = next((key for key, item in parent['manifest']['components'].items()
                           if item.get('kind') == 'role' and item.get('ref') == name), None)
        if role and role.get('prompt_ref') and registered:
            path = role['prompt_ref']
            mappings[name] = {'role': name, 'component': registered, 'path': path,
                              'op': 'replace', 'old_digest': parent['component_digests'][path],
                              'original_content': parent['files'][path],
                              'role_definition': deepcopy(role),
                              'component_definition': deepcopy(parent['manifest']['components'][registered])}
        else:
            suffix = digest({'name': name})[:16]
            role_name = name if IDENTIFIER.fullmatch(name) else 'member-' + suffix
            path = 'members/' + suffix + '.md'
            if role_name in parent['manifest']['roles'] or path in parent['files']:
                raise ContractError('Member identity collides with an existing package resource')
            component_id = 'member-' + suffix
            mappings[name] = {'role': role_name, 'component': component_id, 'path': path, 'op': 'add',
                              'role_definition': {'prompt_ref': path, 'description': name, 'capabilities': []},
                              'component_definition': {'class': 'O', 'kind': 'role', 'ref': role_name}}
    constants = {'SOURCES': sources, 'MAPPINGS': mappings, 'MANIFEST': deepcopy(parent['manifest']),
                 'PATCH': {'schema': 'nexgent.package-patch.v3', 'parent_package_digest': parent['digest']},
                 'HYPOTHESIS': deepcopy(plan['hypothesis']), 'TASK_COMPONENT': 'task-instructions',
                 'TASK_DIGEST': parent['component_digests'][component['ref']],
                 'TASK_PROMPT': parent['files'][component['ref']].split('\n\nReusable organization guidance:\n', 1)[0]}
    program = '\n'.join(name + ' = ' + repr(value) for name, value in constants.items()) + '\n' + DESIGN_SOURCE
    improver = make_package({'team.py': program, 'design.md': DESIGN_PROMPT},
                            {'entries': {'execute': 'team.py:execute', 'improve': 'team.py:improve'}, 'skills': {}},
                            provenance={'origin': 'completed-member-adoption', 'feedback_digest': feedback['digest']})
    from .feedback_trigger import AutoEvolutionService
    policy = AutoEvolutionService._mutation_policy(parent)
    return generation.generate(work['channel_id'], feedback['id'], improver, policy,
                               work['parent_revision'], budget=deepcopy(work['policy']['budget']),
                               stop_event=stop_event)
