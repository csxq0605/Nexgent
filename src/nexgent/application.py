"""Public framework composition shared by Main, CLI and Python callers.

TaskService remains the only task executor. AgentPackage is the replaceable
execution strategy, ToolRegistry supplies capabilities, and an independent
adapter supplies feedback. Organization proposals are an optional application.
"""
from copy import deepcopy
from pathlib import Path
import time
import uuid

from .models.gateway import ModelGateway
from .tasks.auto_runtime import configure_auto_evolution, single_auto_channel
from .tasks.capability_authority import make_episode_authority
from .tasks.evolution import EvolutionService
from .tasks.runtime import TaskService
from .tasks.seed import default_package
from .tasks.packages import make_package
from .workspace import attach_files, validate_attachments, workspace_registry


MAIN_PACKAGE_CHANNEL = 'nexgent-main-runtime-v1'
MAIN_CAPABILITY_AUTHORITY = make_episode_authority(
    ['tool', 'service_provider'], ['local_compute', 'model_context'],
    max_definitions=32, max_invocations=128, version=2)


def framework_package():
    """Use the existing Python seed with the existing component/release SDK.

    Naming the loop and instructions permits ordinary tool/service adoption
    and execution-strategy patches without replacing the task runner.
    """
    seed = default_package()
    manifest = deepcopy(seed['manifest'])
    manifest.update(manifest_version=2, roles={}, workflows={}, orchestrator='task-loop',
                    components={
                        'task-loop': {'class': 'O', 'kind': 'entry', 'ref': 'execute'},
                        **{name: {'class': kind, 'kind': 'resource', 'ref': path}
                           for name, kind, path in (
                               ('decision-validation', 'O', 'agent/protocol.py'),
                               ('action-dispatch', 'O', 'agent/actions.py'),
                               ('decision-protocol', 'O', 'prompts/protocol.md'),
                               ('task-instructions', 'S', 'prompts/task.md'),
                               ('delivery-self-review', 'S', 'prompts/delivery_review.md'),
                               ('tool-development-guide', 'S', 'prompts/capability_development.md'),
                               ('service-development-guide', 'S', 'prompts/service_development.md'))},
                        **{'skill-' + name: {'class': 'S', 'kind': 'skill', 'ref': name}
                           for name in manifest['skills']}})
    return make_package(seed['files'], manifest, provenance=seed['provenance'])


class Nexgent(TaskService):
    """A composed RSI runtime, without prescribing a particular organization.

    Supply a ToolRegistry, generation-zero AgentPackage, evaluator adapter, or
    configured evolution policy to compose an application. These dependencies
    are used by ordinary tasks, not a separate demo or test execution path.
    """
    def __init__(self, root, *, tools=None, package=None, channel=None,
                 evaluator=None, benchmarks=None, model_root=None, gateway_factory=None):
        self.model_root = Path(model_root or root).resolve()
        self.benchmark_adapters = dict(benchmarks or {})
        if gateway_factory is None:
            gateway_factory = lambda reserve, stop: ModelGateway(
                self.model_root, reserve=reserve, stop_event=stop,
                timeout=90, max_completion_tokens=12000)
        super().__init__(root, tools=tools if tools is not None else workspace_registry(root),
                         gateway_factory=gateway_factory)
        self.default_capabilities = [t['name'] for t in self.tools.describe()
                                     if t['effect_class'] != 'external_compute'
                                     and (tools is not None or self.tools.get(t['name']).provider_id == 'nexgent.workspace')]
        self.evaluator = evaluator
        # Register the Python strategy before attaching the existing auto-RSI
        # driver so it cannot quietly substitute a fixed graph baseline.
        from .tasks.auto_runtime import load_auto_evolution_config
        config = load_auto_evolution_config(self.project_root)
        self.main_channel = channel or (config or {}).get('default_channel') or MAIN_PACKAGE_CHANNEL
        self.evolution = EvolutionService(self)
        try:
            self.evolution.active(self.main_channel)
        except KeyError:
            self.evolution.register(self.main_channel, package or framework_package())
        else:
            if package is not None and self.evolution.active(self.main_channel)['package_digest'] != package['digest']:
                raise ValueError('The channel already owns another package; use a new channel or gated evolution')
        self.auto_evolution = configure_auto_evolution(self)
        if config and not channel and single_auto_channel(self.auto_evolution) is None:
            raise ValueError('Main requires default_channel when several evolution policies are configured')

    def _benchmark_registry(self):
        registry = super()._benchmark_registry()
        if not self.benchmark_adapters:
            return registry
        from .tasks.benchmarks import BenchmarkRegistry
        adapters = registry.adapters()
        if set(adapters) & set(self.benchmark_adapters):
            raise ValueError('Injected benchmarks must use distinct installed identities')
        return BenchmarkRegistry.from_mapping(
            {**adapters, **self.benchmark_adapters}, project_root=self.project_root)

    def package_selection(self):
        return {'package_channel': self.main_channel}

    def attach_files(self, paths):
        return attach_files(self.project_root, paths)

    def create(self, objective, inputs=None, deliverables=None, budget=None,
               capabilities=None, package=None, context=None, *,
               _inherit_conversation=True, **options):
        # Delegation, benchmarks and improvement jobs retain the caller's exact
        # package and authority. Only the ordinary entry supplies defaults.
        ordinary = (options.get('parent_episode_id') is None
                    and options.get('benchmark_registration') is None
                    and not (context or {}).get('rsi_role'))
        if ordinary:
            # Portable package tools charge their actual worker instructions.
            # The legacy task API defaults to zero work units, which would
            # prevent a newly adopted tool from running in the next task.
            budget = deepcopy(budget or {})
            budget.setdefault('max_tool_work_units', 200_000)
            inputs = deepcopy(inputs or {})
            context = deepcopy(context or {})
            conversation_id = context.get('conversation_id') or uuid.uuid4().hex
            context['conversation_id'] = conversation_id
            context['entry_surface'] = 'main'
            history = [s for s in self.store.list()
                     if s['task'].get('context', {}).get('conversation_id') == conversation_id
                     and not s['parent_episode_id']
                     and not s['task'].get('context', {}).get('rsi_role')]
            prior = [s for s in history if s.get('output_refs')][:4]
            if _inherit_conversation:
                # Files belong to the conversation, independent of the small
                # model context window. Only stored snapshot identities grant access.
                attached = {item['path']: deepcopy(item) for s in reversed(history)
                            for item in s['task']['inputs'].get('attachments', [])}
                attached.update({item['path']: item for item in inputs.get('attachments', [])})
                if attached:
                    inputs['attachments'] = list(attached.values())
                context['conversation'] = [self._delivery(s) for s in reversed(prior)]
                context['user_feedback'] = [f for s in prior for f in self.feedback_items(s['id'])]
            validate_attachments(self.project_root, inputs)
            if _inherit_conversation and context['conversation']:
                # Keep prior deliveries available as actual input artifacts,
                # rather than relying on a context projection retaining text.
                inputs['conversation'] = deepcopy(context['conversation'])
            if package is None:
                options.setdefault('package_channel', self.main_channel)
            options.setdefault('capability_authority', deepcopy(MAIN_CAPABILITY_AUTHORITY))
            if capabilities is None:
                capabilities = list(self.default_capabilities)
            if all(self.tools.get(n).provider_id for n in capabilities):
                options.setdefault('initially_active_capabilities', list(capabilities))
        return super().create(objective, inputs, deliverables, budget, capabilities,
                              package, context, **options)

    def _delivery(self, state):
        return {'episode_id': state['id'], 'objective': state['task']['objective'],
                'summary': (state.get('outcome') or {}).get('summary', ''),
                'deliverables': {name: self.store.read(ref, state['id'])['content']
                                 for name, ref in state.get('output_refs', {}).items()}}

    def list(self):
        return [s for s in super().list()
                if not s['task'].get('context', {}).get('rsi_role')
                and self.store.benchmark_registration(s['id']) is None]

    def run(self, identity, on_update=None, stop_event=None):
        result = super().run(identity, on_update, stop_event)
        state = self.store.get(identity)
        if (state['task'].get('context', {}).get('entry_surface') == 'main'
                and not state['parent_episode_id'] and result['status'] == 'completed'
                and (state.get('evaluation') or {}).get('accepted') is None
                and not (stop_event is not None and stop_event.is_set())):
            from .delivery import ModelDeliveryEvaluator
            adapter = self.evaluator if self.evaluator is not None else ModelDeliveryEvaluator(self, stop_event, on_update)
            self.store.event(identity, 'delivery_evaluation_started', {'evaluator': adapter.id})
            if on_update:
                on_update(self.get(identity))
            self.evaluate(identity, adapter, deepcopy(state['task']))
            result = self.get(identity)
            if state.get('delivery_revision_id') and (result.get('evaluation') or {}).get('accepted') is not None:
                child = self.store.get(state['delivery_revision_id'])
                if child['status'] == 'completed' and state['output_refs'] == child['output_refs']:
                    self._change(identity, lambda s: s.update(delivery_revision_evaluated=True))
                    result = self.get(identity)
            if on_update:
                on_update(result)
        if (state['task'].get('context', {}).get('entry_surface') == 'main'
                and not state['parent_episode_id'] and result['status'] == 'completed'
                and (result.get('evaluation') or {}).get('accepted') is False
                and not (stop_event is not None and stop_event.is_set())):
            result = self._revise_delivery(identity, on_update, stop_event)
        if (state['task'].get('context', {}).get('entry_surface') == 'main'
                and not state['parent_episode_id']
                and (result['status'] in {'failed', 'cancelled'}
                     or (result['status'] == 'completed'
                         and (result.get('evaluation') or {}).get('accepted') is not None))
                and not (stop_event is not None and stop_event.is_set())):
            try:
                evolution = self.advance(identity, stop_event=stop_event)
            except Exception as exc:
                # Optional improvement cannot discard task delivery. The
                # existing durable driver owns recovery of unfinished work.
                evolution = {'configured': self.auto_evolution is not None,
                             'status': 'interrupted', 'error_type': type(exc).__name__}
            self._change(identity, lambda s: s.update(auto_evolution=evolution))
            result = self.get(identity)
            if on_update:
                on_update(result)
        return result

    def _revise_delivery(self, identity, on_update, stop_event):
        """Finish the user's task after independent rejection, within its budget.

        This is a task-local correction, not a package release or a new user job.
        Persist the child identity so stopping/resuming does not repeat completed work.
        """
        source = self.store.get(identity)
        child_id = source.get('delivery_revision_id')
        if source.get('delivery_revision_evaluated'):
            return self.get(identity)
        if child_id is None:
            task = source['task']
            inputs = deepcopy(task['inputs'])
            inputs['previous_delivery'] = self._delivery(source)['deliverables']
            inputs['independent_feedback'] = deepcopy(source['evaluation'])
            context = deepcopy(task['context'])
            context.pop('package_channel_registration', None)
            context.update(rsi_role='delivery_revision',
                           revision_instruction='Correct the rejected delivery using the independent feedback. '
                                                'Preserve the original objective and facts; publish the corrected result.')
            capabilities = task['capabilities']
            if task.get('capability_mode') == 'leased':
                capabilities = [l['name'] for l in self.store.capability_leases(identity, active_only=True)]
            child = TaskService.create(self, task['objective'], inputs=inputs,
                deliverables=task['deliverables'], capabilities=capabilities,
                package=self.store.package(source['package_id']), context=context,
                constraints=task['constraints'], parent_episode_id=identity,
                capability_authority=task.get('capability_authority'))
            child_id = child['id']
            def link(state):
                state['delivery_revision_id'] = child_id
                state['child_episode_ids'].append(child_id)
            self._change(identity, link)
            self.store.event(identity, 'delivery_revision_started', {'episode_id': child_id})
        if on_update:
            on_update(self.get(identity))
        revised = TaskService.run(self, child_id, on_update=lambda _: on_update(self.get(identity)) if on_update else None,
                                  stop_event=stop_event)
        if revised['status'] != 'completed':
            self.store.event(identity, 'delivery_revision_stopped', {'episode_id': child_id,
                                                                   'status': revised['status']})
            return self.get(identity)
        def replace_delivery(state):
            state.update(output_refs=deepcopy(revised['output_refs']), evaluation=None,
                         outcome=deepcopy(revised['outcome']))
        self._change(identity, replace_delivery)
        if stop_event is not None and stop_event.is_set():
            return self.get(identity)
        from .delivery import ModelDeliveryEvaluator
        adapter = self.evaluator if self.evaluator is not None else ModelDeliveryEvaluator(self, stop_event, on_update)
        self.evaluate(identity, adapter, deepcopy(source['task']))
        if (self.store.get(identity).get('evaluation') or {}).get('accepted') is not None:
            self._change(identity, lambda s: s.update(delivery_revision_evaluated=True))
        self.store.event(identity, 'delivery_revision_finished', {'episode_id': child_id})
        result = self.get(identity)
        if on_update:
            on_update(result)
        return result

    def get(self, identity):
        state = super().get(identity)
        # A corrected artifact can be produced by the revision child. Present
        # the actual final delivery on Main, retaining the original artifacts.
        known = {a['id'] for a in state.get('artifacts', [])}
        for ref in state.get('output_refs', {}).values():
            if ref not in known:
                state['artifacts'].append(self.store.read(ref, identity))
        return state

    def feedback_items(self, identity):
        return [deepcopy(e['content']) for e in self.store.events(identity)
                if e['kind'] == 'user_feedback']

    def feedback(self, identity, text):
        state = self.store.get(identity)
        if not isinstance(text, str) or not text.strip() or len(text) > 3000:
            raise ValueError('Feedback requires nonempty text up to 3000 characters')
        if state['status'] != 'completed' or not state['output_refs']:
            raise ValueError('Feedback requires a delivered task')
        record = {'episode_id': identity, 'text': text.strip(), 'created': time.time()}
        self.store.event(identity, 'user_feedback', record)
        return record

    def learn(self, identity):
        """Replay a delivered task under the current version and saved feedback.

        Existing configured AutoEvolution policies handle proposals and gates;
        replay itself never edits active registrations or deploys a candidate.
        """
        source = self.store.get(identity)
        if source['status'] != 'completed':
            raise ValueError('Learning requires a delivered task')
        task = source['task']
        context = deepcopy(task['context'])
        context.pop('package_channel_registration', None)
        context.update(learning_source_id=identity, learning_feedback=self.feedback_items(identity))
        return self.create(task['objective'], inputs=task['inputs'],
                           deliverables=task['deliverables'], capabilities=task['capabilities'],
                           context=context, constraints=task['constraints'], budget=task['budget'],
                           _inherit_conversation=False)

    def advance(self, identity=None, *, stop_event=None):
        from .tasks.auto_runtime import advance_auto_evolution
        return advance_auto_evolution(self.auto_evolution, source_episode_id=identity,
                                      stop_event=stop_event)
