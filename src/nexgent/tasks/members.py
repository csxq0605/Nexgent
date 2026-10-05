"""Reusable members are existing package roles, executed as delegated Episodes."""
from copy import deepcopy

from .tools import ContractError


def resolve_member(package, name):
    role = package['manifest'].get('roles', {}).get(name)
    if not isinstance(role, dict) or not role.get('prompt_ref'):
        raise ContractError('Member must name a registered package role with a prompt resource')
    instructions = package['files'][role['prompt_ref']]
    if not instructions.strip() or len(instructions) > 3000:
        raise ContractError('Member instructions must contain at most 3000 characters')
    return {'name': name, 'instructions': instructions}


def member_inventory(package):
    members = []
    for name, role in sorted(package['manifest'].get('roles', {}).items()):
        if not role.get('prompt_ref'):
            continue
        instructions = package['files'][role['prompt_ref']]
        if not instructions.strip() or len(instructions) > 3000:
            continue
        members.append({**resolve_member(package, name), 'instructions': instructions[:600],
                        'description': str(role.get('description', name))[:300]})
        if len(members) == 16:
            break
    return members


def organization_changes(parent, candidate):
    """Describe an actual candidate's instructions; this does not imply release."""
    before = {member['name']: resolve_member(parent, member['name']) for member in member_inventory(parent)}
    after = {member['name']: resolve_member(candidate, member['name']) for member in member_inventory(candidate)}
    component = candidate['manifest'].get('components', {}).get('task-instructions', {})
    strategy = candidate['files'].get(component.get('ref'), '')
    marker = '\n\nReusable organization guidance:\n'
    return {'added': [after[name] for name in sorted(after.keys() - before.keys())],
            'updated': [{'name': name, 'before': before[name]['instructions'],
                         'instructions': after[name]['instructions']}
                        for name in sorted(before.keys() & after.keys())
                        if before[name]['instructions'] != after[name]['instructions']],
            'removed': [before[name] for name in sorted(before.keys() - after.keys())],
            'strategy': strategy.split(marker, 1)[1] if marker in strategy else ''}


def used_members(store, episode_ids, package):
    """Only completed, same-package delegated members are development evidence."""
    members = []
    seen = set()
    for identity in episode_ids:
        state = store.get(identity)
        agent = state['task'].get('context', {}).get('agent')
        if (not state['parent_episode_id'] or state['status'] != 'completed'
                or state['package_digest'] != package['digest'] or not state['output_refs']
                or not isinstance(agent, dict) or set(agent) != {'name', 'instructions'}):
            continue
        marker = (agent['name'], agent['instructions'])
        if marker in seen:
            continue
        seen.add(marker)
        members.append({'episode_id': identity, **deepcopy(agent)})
        if len(members) == 8:
            break
    return members
