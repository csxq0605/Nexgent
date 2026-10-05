"""Compile a model-designed reusable team through the existing package gates.

The model describes responsibilities, rather than authoring manifest deltas.
Completed members and explicit feedback supply organization evidence. Generation,
paired evaluation, promotion and rollback remain owned by existing services.
"""
from copy import deepcopy

from ..kernel.programs import digest
from .members import used_members, member_inventory, resolve_member
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

ORGANIZATION_PROMPT = '''Design a bounded change to the reusable organization from
the supplied task evidence, independent feedback and explicit human feedback.
You may create a missing responsibility, improve an editable deployed member,
or retire a redundant editable member. Existing members omitted from the change
remain installed. New member names must start with an ASCII letter and contain
only ASCII letters, digits, underscore, dot or hyphen, at most 60 characters.
Return exactly {"members": [{"name": "member name", "instructions": "general
responsibility and method"}], "remove": ["editable deployed member name"],
"strategy": "general member selection, evidence sharing and synthesis guidance"}.
At most eight upserts and eight removals; members may be empty. Never upsert and
remove the same member. The final directory has at most sixteen members.
Instructions are nonempty and at most 3000 characters; strategy is nonempty and
at most 2000 characters. Do not persist task-specific facts, answers, names or
attachments. Do not change executor, tools, permissions, evaluator or gates.
Creating a member does not prove it useful: independent trials must actually
use each changed member and demonstrate improvement before release.'''


DESIGN_SOURCE = '''def execute(payload, context):
    return {'deliverables': {}}

def improve(payload, context):
    feedback = context.read_artifact(payload['input_refs']['feedback_bundle'])['content']
    design = context.ask('rsi_team_designer', context.resource('design.md'), {
        'completed_members': SOURCES, 'deployed_members': DIRECTORY,
        'editable_members': EDITABLE, 'feedback_bundle': feedback,
    }, max_tokens=5000)
    fields = ['members', 'remove', 'strategy'] if ORGANIZATION_CHANGE else ['members', 'strategy']
    minimum = 0 if ORGANIZATION_CHANGE else 1
    if (not isinstance(design, dict) or not set(fields) <= set(design)
            or not isinstance(design['members'], list) or not minimum <= len(design['members']) <= 8
            or not isinstance(design['strategy'], str) or not design['strategy'].strip()
            or len(design['strategy']) > 2000):
        raise ValueError('Reusable team design needs members and a bounded strategy')
    removals = design.get('remove', [])
    if (not isinstance(removals, list) or len(removals) > 8
            or any(not isinstance(name, str) or name not in EDITABLE for name in removals)
            or len(set(removals)) != len(removals)):
        raise ValueError('Only editable deployed members can be retired')
    patch = PATCH.copy()
    manifest = MANIFEST.copy()
    manifest['roles'] = MANIFEST['roles'].copy()
    manifest['components'] = MANIFEST['components'].copy()
    operations = []
    targets = []
    seen = []
    for name in removals:
        mapping = MAPPINGS[name]
        del manifest['roles'][mapping['role']]
        del manifest['components'][mapping['component']]
        operations.append({'op': 'remove', 'component_id': mapping['component'],
                           'old_digest': mapping['old_digest']})
        targets.append(mapping['component'])
    for member in design['members']:
        # Extra explanation fields are inert: only name and instructions are
        # compiled. The model never owns manifest declarations or permissions.
        if (not isinstance(member, dict) or not set(['name', 'instructions']) <= set(member)
                or not isinstance(member.get('name'), str) or member['name'] in seen
                or member['name'] in removals
                or not isinstance(member.get('instructions'), str)
                or not member['instructions'].strip() or len(member['instructions']) > 3000):
            raise ValueError('Reusable member must name a supplied source and bounded instructions')
        name = member['name']
        seen.append(name)
        if name in MAPPINGS:
            mapping = MAPPINGS[name]
        else:
            letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
            allowed = letters + '0123456789_.-'
            if (not ORGANIZATION_CHANGE or not name or len(name) > 60
                    or name[0] not in letters or any(char not in allowed for char in name)):
                raise ValueError('New members need a bounded identifier')
            path = 'members/' + name + '.md'
            component_id = 'member-' + name
            if (name in MANIFEST['roles'] or path in FILE_PATHS
                    or component_id in MANIFEST['components']):
                raise ValueError('New member collides with a deployed package identity')
            mapping = {'role': name, 'component': component_id, 'path': path, 'op': 'add',
                       'role_definition': {'prompt_ref': path, 'description': name, 'capabilities': []},
                       'component_definition': {'class': 'O', 'kind': 'role', 'ref': name}}
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
    if sum(1 for role in manifest['roles'].values() if role.get('prompt_ref')) > 16:
        raise ValueError('Reusable organization is limited to sixteen members')
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


def generate_team(tasks, evolution, generation, work, plan, stop_event=None, *, organization_change=False):
    parent = evolution.active(work['channel_id'])['package']
    feedback = generation.feedback(work['feedback_bundle']['id'])
    sources = member_sources(tasks, feedback, parent)
    component = parent['manifest'].get('components', {}).get('task-instructions', {})
    if (not organization_change and not sources) or component.get('kind') != 'resource':
        raise ContractError('Team adoption requires member evidence or feedback and mutable task instructions')
    mappings = {}
    from .generation import _component_registry_snapshot
    registry = _component_registry_snapshot(parent)['components']
    directory = member_inventory(parent)
    editable = []
    evidence = sources + ([resolve_member(parent, member['name']) for member in directory]
                          if organization_change else [])
    for member in evidence:
        name = member['name']
        if name in mappings:
            continue
        # Reuse an existing adopted role when it executes again in later work.
        role = parent['manifest'].get('roles', {}).get(name)
        registered = next((key for key, item in parent['manifest']['components'].items()
                           if item.get('kind') == 'role' and item.get('ref') == name), None)
        if role and role.get('prompt_ref') and registered:
            path = role['prompt_ref']
            owners = [key for key, item in registry.items() if path in item.get('files', [])]
            if owners != [registered] or parent['manifest']['components'][registered].get('class') != 'O':
                continue
            mappings[name] = {'role': name, 'component': registered, 'path': path,
                              'op': 'replace', 'old_digest': parent['component_digests'][path],
                              'original_content': parent['files'][path],
                              'role_definition': deepcopy(role),
                              'component_definition': deepcopy(parent['manifest']['components'][registered])}
            editable.append(name)
        else:
            suffix = digest({'name': name})[:16]
            role_name = name if IDENTIFIER.fullmatch(name) else 'member-' + suffix
            path = 'members/' + suffix + '.md'
            if (role_name in parent['manifest']['roles'] or path in parent['files']
                    or 'member-' + suffix in parent['manifest']['components']):
                raise ContractError('Member identity collides with an existing package resource')
            component_id = 'member-' + suffix
            mappings[name] = {'role': role_name, 'component': component_id, 'path': path, 'op': 'add',
                              'role_definition': {'prompt_ref': path, 'description': name, 'capabilities': []},
                              'component_definition': {'class': 'O', 'kind': 'role', 'ref': role_name}}
    constants = {'SOURCES': sources, 'MAPPINGS': mappings, 'MANIFEST': deepcopy(parent['manifest']),
                 'DIRECTORY': directory, 'EDITABLE': editable, 'FILE_PATHS': list(parent['files']),
                 'ORGANIZATION_CHANGE': organization_change,
                 'PATCH': {'schema': 'nexgent.package-patch.v3', 'parent_package_digest': parent['digest']},
                 'HYPOTHESIS': deepcopy(plan['hypothesis']), 'TASK_COMPONENT': 'task-instructions',
                 'TASK_DIGEST': parent['component_digests'][component['ref']],
                 'TASK_PROMPT': parent['files'][component['ref']].split('\n\nReusable organization guidance:\n', 1)[0]}
    program = '\n'.join(name + ' = ' + repr(value) for name, value in constants.items()) + '\n' + DESIGN_SOURCE
    improver = make_package({'team.py': program, 'design.md': ORGANIZATION_PROMPT if organization_change else DESIGN_PROMPT},
                            {'entries': {'execute': 'team.py:execute', 'improve': 'team.py:improve'}, 'skills': {}},
                            provenance={'origin': 'feedback-organization-design' if organization_change else 'completed-member-adoption',
                                        'feedback_digest': feedback['digest']})
    from .feedback_trigger import AutoEvolutionService
    policy = AutoEvolutionService._mutation_policy(parent)
    policy['mutable_components'] = sorted(set([mapping['component'] for mapping in mappings.values()
                                              if mapping['op'] == 'replace'] + ['task-instructions']))
    policy['allow_remove'] = organization_change
    return generation.generate(work['channel_id'], feedback['id'], improver, policy,
                               work['parent_revision'], budget=deepcopy(work['policy']['budget']),
                               stop_event=stop_event)
