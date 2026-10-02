"""Workspace capabilities adapted to the existing Episode tool interface.

File formats belong to this provider, not to the task executor or evaluator.
Applications may replace it, or supply an entirely different ToolRegistry.
"""
from dataclasses import replace
import hashlib
from pathlib import Path
import uuid

from .organization_tools import WorkspaceTools, artifact_matches
from .tasks.tools import ToolProvider, ToolRegistry


def attach_files(root, paths):
    paths = list(paths)
    if not 1 <= len(paths) <= 8:
        raise ValueError("Select one to eight files")
    selected = []
    for source in map(lambda p: Path(p).resolve(), paths):
        if (source.suffix.lower() not in {'.xlsx', '.csv', '.txt', '.md', '.json'}
                or not source.is_file() or source.stat().st_size > 1_000_000):
            raise ValueError("Attachments support .xlsx, .csv, .txt, .md and .json files up to 1 MB each")
        data = source.read_bytes()
        if len(data) > 1_000_000:
            raise ValueError("Attachment exceeds 1 MB")
        selected.append((source.name, data))
    items = []
    for name, data in selected:
        path = Path(root).resolve() / '.nexgent' / 'inputs' / uuid.uuid4().hex / name
        path.parent.mkdir(parents=True)
        path.write_bytes(data)
        items.append({'path': str(path), 'name': name, 'size_bytes': len(data),
                      'sha256': hashlib.sha256(data).hexdigest()})
    return items


def validate_attachments(root, inputs):
    items = inputs.get('attachments', [])
    if not isinstance(items, list) or len(items) > 8:
        raise ValueError("A task supports at most eight snapshotted attachments")
    directory = (Path(root) / '.nexgent' / 'inputs').resolve()
    for item in items:
        if (not isinstance(item, dict) or not isinstance(item.get('path'), str)
                or not Path(item['path']).resolve().is_relative_to(directory)
                or not artifact_matches(item)):
            raise ValueError("Attachment snapshot is missing, changed or outside the input directory")
    return items


def _file_refs(value):
    if isinstance(value, dict):
        if isinstance(value.get('path'), str):
            yield value
        else:
            for item in value.values():
                yield from _file_refs(item)
    elif isinstance(value, list):
        for item in value:
            yield from _file_refs(item)


def workspace_provider(root):
    root = Path(root).resolve()
    output_root = root / '.nexgent' / 'workspace-outputs'
    prototype = WorkspaceTools(root, output_root)
    # Bind the provider declaration to its shipped adapter and implementation.
    fingerprint = hashlib.sha256(Path(__file__).read_bytes() +
                                 Path(__file__).with_name('organization_tools.py').read_bytes() +
                                 Path(__file__).with_name('organization_spreadsheets.py').read_bytes()).hexdigest()

    def handler(name):
        def invoke(arguments, context):
            context.check_stop()
            state = context.service.store.get(context.episode_id)
            shared = list(validate_attachments(root, state['task'].get('inputs', {})))
            # Share only host-produced files in this task tree. A sibling's
            # prose or an arbitrary path in model-supplied input is not a grant.
            for episode in context.service.store.list():
                if episode['root_episode_id'] != state['root_episode_id']:
                    continue
                for event in context.service.store.events(episode['id']):
                    content = event.get('content', {})
                    descriptor = content.get('capability_descriptor', {})
                    if (event['kind'] == 'tool' and content.get('status') == 'completed'
                            and (descriptor.get('provider_id') == 'nexgent.workspace'
                                 or context.service.tools.get(content['name']).provider_id == 'nexgent.workspace')):
                        shared.extend(ref for ref in _file_refs(content.get('result'))
                                      if Path(ref['path']).resolve().is_relative_to(output_root))
            # Evaluation and conversation inputs may contain prior deliveries;
            # they can grant only this provider's output directory.
            shared.extend(ref for ref in _file_refs(state['task'].get('inputs', {}))
                          if Path(ref['path']).resolve().is_relative_to(output_root))
            shared.extend(ref for ref in _file_refs(state['task'].get('context', {}).get('conversation', []))
                          if Path(ref['path']).resolve().is_relative_to(output_root))
            directory = output_root / context.episode_id
            toolkit = WorkspaceTools(root, directory, shared_artifacts=shared,
                                     stop_event=context.stop_event)
            return toolkit.call(name, arguments)
        return invoke

    tools = tuple(replace(prototype.registry.get(d['name']),
                          handler=handler(d['name']), provider_id='nexgent.workspace',
                          provider_version='1', handler_digest=fingerprint)
                  for d in prototype.registry.describe())
    return ToolProvider('nexgent.workspace', '1', tools)


def workspace_registry(root):
    registry = ToolRegistry.discover()
    registry.register_provider(workspace_provider(root))
    return registry
