"""DSH's official SDK/profile, using MCP and the existing host model ledger.

DSH owns native agent/tool iteration. TaskService owns admission, capability
authority, artifacts, evaluation and version selection. The bridge never
receives provider credentials and never implements an additional agent loop.
"""
from contextlib import asynccontextmanager
from dataclasses import dataclass
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
import socket
import threading
import time

from ..tasks.package_runner import CapabilityAbort
from ..tasks.tools import ContractError


def configured_kernel(root, requested=None):
    path = Path(root).resolve() / '.nexgent' / 'kernel.json'
    config = json.loads(path.read_text(encoding='utf-8')) if path.is_file() else {}
    if not isinstance(config, dict) or not set(config) <= {'engine', 'binary'}:
        raise ValueError('Kernel settings support only engine and binary')
    engine = requested if requested is not None else config.get('engine')
    if engine not in {None, 'dsh'}:
        raise ValueError('Unsupported project kernel')
    if engine is None:
        return None, {}
    kernel = DshKernel(binary=config.get('binary'))
    if requested is not None and config.get('engine') != requested:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({**config, 'engine': engine})+'\n', encoding='utf-8')
    return engine, {'dsh': kernel}


def _schema(properties, required=()):
    return {'type': 'object', 'properties': properties, 'required': list(required),
            'additionalProperties': False}


# These are presentations of existing host capabilities, not a wire protocol.
# Each body still passes through TaskService's normal schema/authority checks.
STR = {'type': 'string'}
OBJ = {'type': 'object'}
INT = {'type': 'integer'}
MCP_CAPABILITIES = {
    'invoke_tool': ('tool', 'Invoke an installed or developed tool from the task inventory.',
                    _schema({'name': STR, 'arguments': OBJ}, ('name', 'arguments'))),
    'read_artifact': ('read_artifact', 'Read an actual input or published artifact visible to this task.',
                      _schema({'artifact_id': STR}, ('artifact_id',))),
    'publish': ('publish', 'Publish an additional artifact. Prefer the typed deliver_* tool for a required deliverable. JSON content must be an object/array, not serialized text.',
                _schema({'name': STR, 'content': {'description': 'Actual native JSON content, never JSON-encoded text for an object or array.'}, 'schema': {},
                         'input_refs': {'type': 'array', 'items': STR}}, ('name', 'content'))),
    'capability_inventory': ('capability_inventory', 'Refresh currently installed and task-local tools and services.',
                             _schema({})),
    'develop_tool': ('develop_tool', 'Develop and test a task-local parameterized tool using the supplied development guide.',
                     _schema({'proposal': OBJ}, ('proposal',))),
    'release_tool': ('release_tool', 'Release a task-local tool at its exact revision.',
                     _schema({'name': STR, 'expected_revision': INT}, ('name', 'expected_revision'))),
    'develop_service': ('develop_service', 'Develop a model-context provider using the supplied service guide.',
                        _schema({'proposal': OBJ}, ('proposal',))),
    'activate_service': ('activate_service', 'Activate a developed provider at its exact revision.',
                         _schema({'definition_id': STR, 'expected_revision': INT},
                                 ('definition_id', 'expected_revision'))),
    'release_service': ('release_service', 'Release the current task provider at its exact revision.',
                        _schema({'expected_revision': INT}, ('expected_revision',))),
    'memory_search': ('memory_search', 'Search the task memory snapshot.',
                      _schema({'query': STR, 'limit': INT}, ('query',))),
    'remember': ('remember', 'Record evidence-backed task experience.',
                 _schema({'content': {}, 'kind': STR, 'evidence': {}}, ('content',))),
    'delegate': ('delegate', 'Delegate a bounded task through the same executor and root budget.',
                 _schema({'task': OBJ, 'package_id': {'type': ['string', 'null']}}, ('task',))),
    'skill': ('skill', 'Invoke an available skill from the task package.',
              _schema({'name': STR, 'payload': {}}, ('name',))),
    'develop_skill': ('develop_skill', 'Develop a bounded task-local skill.',
                      _schema({'proposal': OBJ, 'constraints': OBJ}, ('proposal', 'constraints'))),
    'plan': ('plan', 'Execute a validated replaceable workflow if useful for this task.',
             _schema({'plan': OBJ}, ('plan',))),
    'feedback': ('feedback', 'Record feedback on the task.', _schema({'content': {}}, ('content',))),
}


@dataclass(frozen=True)
class DshKernel:
    binary: str | None = None

    def __post_init__(self):
        if self.binary is not None and (not isinstance(self.binary, str)
                                        or not Path(self.binary).is_absolute()
                                        or not Path(self.binary).is_file()):
            raise ValueError('DSH binary must be an existing absolute executable path')

    def identity(self):
        adapter = Path(__file__).with_name('dsh_adapter.mjs')
        result = {'engine': 'dsh', 'profile': 'sdk-minimal', 'transport': 'official-python-sdk',
                  'capabilities': 'MCP Streamable HTTP',
                  'adapter_sha256': hashlib.sha256(adapter.read_bytes()).hexdigest()}
        if self.binary:
            result['binary_sha256'] = hashlib.sha256(Path(self.binary).read_bytes()).hexdigest()
        else:
            try:
                from deepseek_harness_runtime import resolve_bundled_launch_args
                launcher = resolve_bundled_launch_args()
                result['runtime_carrier'] = 'source-node' if len(launcher) > 1 else 'executable'
                result['launcher_sha256'] = [hashlib.sha256(Path(path).read_bytes()).hexdigest()
                                             for path in launcher]
            except ImportError:
                result['runtime_carrier'] = 'unavailable'
        return result

    def run(self, instructions, task, invoke, *, stop_event, root, on_event):
        try:
            from deepseek_harness import DeepSeekHarness
            from mcp import types
            from mcp.server.lowlevel import Server
            from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
            from starlette.applications import Starlette
            from starlette.responses import JSONResponse
            from starlette.routing import Mount, Route
            import uvicorn
        except ImportError as exc:
            raise ContractError('DSH requires its official Python SDK/runtime and nexgent[dsh] dependencies') from exc
        root = Path(root)
        root.mkdir(parents=True, exist_ok=True)
        token, fatal, halt = secrets.token_urlsafe(32), [], threading.Event()
        read_refs = set()
        mcp = Server('Nexgent authorized task capabilities')
        direct_tools = {}
        publish_targets = {}
        published = {}
        publication_lock = threading.Lock()

        def dispatch(method, arguments):
            from ..tasks.runtime import RecoveryRequired
            from ..tasks.store import BudgetExhausted, StateConflict
            try:
                if fatal:
                    raise fatal[0]
                if stop_event.is_set():
                    raise InterruptedError('Native agent was stopped')
                if method == 'publish':
                    # Bind completion to successful host receipts, including
                    # the most recent publication of each name. Serialize this
                    # update with publication so parallel MCP replies cannot
                    # replace a newer artifact with an earlier one.
                    with publication_lock:
                        value = invoke(method, arguments)
                        published[arguments['name']] = value['id']
                        return value
                return invoke(method, arguments)
            except CapabilityAbort as exc:
                fatal.append(exc)
                halt.set()
                raise
            except (BudgetExhausted, StateConflict, RecoveryRequired) as exc:
                abort = CapabilityAbort(exc)
                fatal.append(abort)
                halt.set()
                raise abort from exc
            except (InterruptedError, KeyboardInterrupt, SystemExit) as exc:
                fatal.append(exc)
                halt.set()
                raise

        @mcp.list_tools()
        async def list_tools():
            import asyncio
            inventory = await asyncio.to_thread(dispatch, 'capability_inventory', {})
            exposed = [types.Tool(name=name, description=description, inputSchema=schema)
                       for name, (_, description, schema) in MCP_CAPABILITIES.items()]
            for tool in inventory['tools']:
                alias = 'tool_'+hashlib.sha256(tool['name'].encode()).hexdigest()[:16]
                original = tool['input_schema']
                wrapped = not isinstance(original, dict) or original.get('type') != 'object'
                schema = _schema({'payload': original}, ('payload',)) if wrapped else original
                direct_tools[alias] = (tool['name'], wrapped)
                exposed.append(types.Tool(name=alias, description=tool['name']+': '+tool['description'],
                                          inputSchema=schema))
            for spec in task['deliverables']:
                alias = 'deliver_'+hashlib.sha256(spec['name'].encode()).hexdigest()[:16]
                publish_targets[alias] = spec['name']
                exposed.append(types.Tool(name=alias, description='Publish required deliverable '+spec['name'],
                                          inputSchema=_schema({'content': spec.get('schema', {}),
                                                               'input_refs': {'type': 'array', 'items': STR}},
                                                              ('content',))))
            return exposed

        @mcp.call_tool()
        async def call_tool(name, arguments):
            import asyncio
            if name not in MCP_CAPABILITIES and name not in direct_tools and name not in publish_targets:
                raise ValueError('Unknown host capability')
            method = (MCP_CAPABILITIES[name][0] if name in MCP_CAPABILITIES
                      else 'publish' if name in publish_targets else 'tool')
            arguments = dict(arguments or {})
            if name in direct_tools:
                tool_name, wrapped = direct_tools[name]
                arguments = {'name': tool_name, 'arguments': arguments['payload'] if wrapped else arguments}
            if name in publish_targets:
                arguments['name'] = publish_targets[name]
            if method == 'publish':
                arguments.setdefault('schema', 'application/json')
                arguments['input_refs'] = sorted(read_refs | set(arguments.get('input_refs', [])))
            try:
                value = await asyncio.to_thread(dispatch, method, arguments)
                if method == 'read_artifact':
                    read_refs.add(value['id'])
                if method in {'develop_tool', 'release_tool'}:
                    await mcp.request_context.session.send_tool_list_changed()
                return [types.TextContent(type='text', text=json.dumps(value, ensure_ascii=False))]
            except CapabilityAbort:
                return types.CallToolResult(isError=True, content=[types.TextContent(
                    type='text', text='Host stopped this task; automatic repetition refused.')])

        manager = StreamableHTTPSessionManager(app=mcp, json_response=False, stateless=False,
                                               max_request_body_size=1_000_000, max_sessions=4)

        async def mcp_endpoint(scope, receive, send):
            await manager.handle_request(scope, receive, send)

        async def completion(request):
            import asyncio
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 1_000_000:
                    return JSONResponse({'error': {'message': 'Request exceeds the host input bound'}}, status_code=413)
            try:
                data = json.loads(body)
                if not isinstance(data, dict) or set(data) != {'model', 'messages', 'tools', 'max_completion_tokens'}:
                    raise ContractError('Invalid native model request')
                if data['model'] != 'nexgent-configured':
                    raise ContractError('Native model route must use the host configuration')
                result = await asyncio.to_thread(dispatch, 'ask', {
                    'role': 'dsh_agent', 'prompt': 'Native DSH agent completion',
                    'payload': {'messages': data['messages'], 'tools': data['tools']},
                    'max_tokens': data['max_completion_tokens'], 'completion_format': 'native'})
                return JSONResponse({'id': 'nexgent-native', 'object': 'chat.completion',
                    'model': 'nexgent-configured', 'choices': [{'index': 0,
                    'finish_reason': result['finish_reason'], 'message': {
                    'role': 'assistant', 'content': result['content'], 'tool_calls': result['tool_calls']}}],
                    'usage': result['usage']})
            except BaseException as exc:
                # Provider secrets and arbitrary exception messages do not
                # cross into the native process or HTTP response.
                return JSONResponse({'error': {'message': type(exc).__name__}}, status_code=500)

        @asynccontextmanager
        async def lifespan(app):
            async with manager.run():
                yield

        app = Starlette(routes=[Mount('/mcp', app=mcp_endpoint),
                                Route('/v1/chat/completions', completion, methods=['POST'])], lifespan=lifespan)

        async def authorized(scope, receive, send):
            if scope['type'] == 'http':
                headers = dict(scope['headers'])
                expected = ('Bearer ' + token).encode()
                if not hmac.compare_digest(headers.get(b'authorization', b''), expected):
                    await JSONResponse({'error': 'Unauthorized'}, status_code=401)(scope, receive, send)
                    return
            await app(scope, receive, send)

        listener = socket.socket()
        listener.bind(('127.0.0.1', 0))
        listener.listen()
        url = 'http://127.0.0.1:' + str(listener.getsockname()[1])
        server = uvicorn.Server(uvicorn.Config(authorized, log_level='critical', access_log=False,
                                               lifespan='on', timeout_graceful_shutdown=5))
        serving = threading.Thread(target=lambda: server.run(sockets=[listener]), name='nexgent-dsh-host')
        patch = [
            {'id': name, 'disabled': True} for name in
            ('llm-deepseek', 'persistent-bash', 'persistent-pwsh')]
        patch.append({'insert': [
            {'id': 'nexgent-native-model', 'name': str(Path(__file__).with_name('dsh_adapter.mjs'))},
            {'id': 'nexgent-authorized-tools', 'name': '@deepseek-ai/dsh-mcp-client', 'config': {
                'transport': 'streamable-http', 'serverName': 'nexgent', 'url': url+'/mcp/',
                'headers': {'Authorization': 'Bearer '+token}, 'toolCallTimeoutMs': 180000,
                'failOnStartupError': True, 'reconnect': {'enabled': False}}}]})
        # JSON is valid YAML. Session-home patches remain host-owned, and no
        # provider key is written to this file or the native environment.
        patch_path = root / 'host.patch.yml'
        patch_path.write_text(json.dumps(patch, ensure_ascii=False), encoding='utf-8')
        harness = DeepSeekHarness(provider='nexgent-host', model='nexgent-configured', max_tokens=4000,
                                  dsh_bin=self.binary, profile='sdk-minimal', patches=(str(patch_path),),
                                  dsh_home=str(root / 'home'), cwd=str(root), runtime_cwd=str(root),
                                  env={**{key: '' for key in os.environ if key.upper() not in {
                                      'SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
                                      'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'LANG', 'LC_ALL'}},
                                       'NEXGENT_BRIDGE_URL': url, 'NEXGENT_BRIDGE_TOKEN': token},
                                  request_timeout_seconds=180, shutdown_timeout_seconds=2)
        result, errors = [], []
        def observe(notification):
            if notification.method == 'session.event':
                event = notification.payload.get('event', {})
                on_event({'type': event.get('type'), 'id': event.get('id')})
        def run():
            try:
                result.append(harness.run(instructions+'\n\nTask evidence:\n'+json.dumps(task, ensure_ascii=False),
                                          session_id=task['episode_id'], on_notification=observe))
            except BaseException as exc:
                errors.append(exc)
        runner = threading.Thread(target=run, name='nexgent-dsh-sdk')
        try:
            serving.start()
            deadline = time.monotonic()+10
            while not server.started:
                if not serving.is_alive() or time.monotonic() >= deadline:
                    raise ContractError('Native host server did not become ready')
                if stop_event.wait(0.02):
                    raise InterruptedError('Native agent startup stopped')
            runner.start()
            while runner.is_alive():
                runner.join(0.05)
                if stop_event.is_set() or halt.is_set():
                    harness.close()
                    runner.join()
                    if fatal:
                        raise fatal[0]
                    raise InterruptedError('Native agent stopped; runtime joined')
            if fatal:
                raise fatal[0]
            if errors:
                diagnostic = str(errors[0]).replace(token, '[redacted]')[:3000]
                raise ContractError('DSH SDK turn failed ('+type(errors[0]).__name__+'): '+diagnostic) from errors[0]
            turn = result[0]
            if turn.finish_reason != 'completed':
                raise ContractError('Native agent did not finish a complete turn')
            missing = [spec['name'] for spec in task['deliverables'] if spec['name'] not in published]
            if missing:
                raise ContractError('Native agent completed without publishing required deliverables: '+', '.join(missing))
            # Native turns can end with prose, Markdown or structured text.
            # None of it grants artifact authority. TaskService still reads
            # and validates these actual receipts and evaluates the delivery.
            return {'deliverables': dict(published), 'summary': turn.final_response, 'limitations': []}
        finally:
            harness.close()
            if runner.ident is not None:
                runner.join()
            server.should_exit = True
            if serving.ident is not None:
                serving.join()
            listener.close()
            # This short-lived token is a capability for this one server.
            # Remove it after the runtime has reached quiescence.
            patch_path.unlink(missing_ok=True)
