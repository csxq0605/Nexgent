"""Default product composition: learn from real tasks, gate against frozen replays.

These are developmental project regressions, never unseen benchmark evidence.
The executor, improver, candidate release and rollback are the existing services.
"""
from copy import deepcopy
import json

from .delivery import ModelDeliveryEvaluator
from .tasks.benchmarks import BenchmarkDescriptor
from .tasks.feedback_trigger import AutoEvolutionService
from .tasks.improvers import ImproverService, active_improver_registration
from .tasks.improver_seed import default_improver_package
from .tasks.tools import ContractError


REPLAY_ID = 'nexgent.project-regression'
IMPROVER_CHANNEL = 'nexgent-project-improver-v6'
# At most five roots: planner, generator, two selection arms, one guard.
PHASE_BUDGET = {'max_model_calls': 40, 'max_completion_tokens': 160000,
                'max_tool_calls': 20, 'max_tool_work_units': 200000, 'max_nodes': 100}


def ordinary(state):
    task = state['task']
    return (not state['parent_episode_id']
            and task.get('context', {}).get('entry_surface') == 'main'
            and not task.get('context', {}).get('rsi_role'))


def task_unit(state, store):
    """Correction/replay of one user request is one historical task, not new data."""
    seen = set()
    while state['id'] not in seen:
        seen.add(state['id'])
        source_id = state['task'].get('context', {}).get('learning_source_id')
        if not source_id:
            return state['id']
        state = store.get(source_id)
    raise ContractError('Cyclic learning history cannot be a regression unit')


class ProjectRegression:
    id = REPLAY_ID
    descriptor = BenchmarkDescriptor(
        id=REPLAY_ID, version='1', title='Real project task regressions',
        splits=('development', 'selection', 'guard'), default_split='development',
        evidence_scope='Frozen historical task replays; development evidence only')

    def __init__(self, runtime, suite=None):
        self.runtime, self.suite = runtime, suite
        self.stop_event = None

    def with_stop_event(self, stop_event):
        self.stop_event = stop_event
        return self

    def describe(self):
        return self.descriptor.as_dict()

    def snapshot(self):
        return {'id': self.id, 'version': '1',
                'evaluator': ModelDeliveryEvaluator(self.runtime).snapshot(),
                'suite': deepcopy(self.suite)}

    def history(self, source):
        unit = task_unit(source, self.runtime.store)
        registration = source['task']['context']['package_channel_registration']
        candidates = []
        seen = {unit}
        for state in reversed(self.runtime.store.list()):
            reg = state['task'].get('context', {}).get('package_channel_registration', {})
            if (not ordinary(state) or state['status'] != 'completed'
                    or reg.get('channel') != registration['channel']
                    or reg.get('revision') != registration['revision']
                    or (state.get('evaluation') or {}).get('accepted') is not True
                    or self.runtime.store.benchmark_registration(state['id']) is not None
                    or task_unit(state, self.runtime.store) in seen):
                continue
            # Identical requests are not independent regression cases either.
            if (state['task']['objective'] == source['task']['objective']
                    and state['task']['inputs'] == source['task']['inputs']):
                continue
            seen.add(task_unit(state, self.runtime.store))
            candidates.append(state)
        return candidates

    def ready(self, work):
        source = self.runtime.store.get(work['source_episode_id'])
        if not self.history(source):
            return False, 'waiting_for_distinct_completed_task'
        return True, None

    def _case(self, state, *, feedback=False):
        task = deepcopy(state['task'])
        context = task['context']
        context.pop('package_channel_registration', None)
        context.pop('memory_binding_registration', None)
        context.pop('entry_surface', None)
        context.update(rsi_role='project_regression', memory_writeback=False)
        if feedback:
            context['learning_feedback'] = self.runtime.feedback_items(state['id'])
        # The original frozen input/context matters; never inject later conversation.
        return {key: task[key] for key in
                ('objective', 'inputs', 'context', 'constraints', 'deliverables', 'capabilities')} | {
                    'id': 'project:' + state['id']}

    def for_work(self, work):
        """Freeze once as an existing host artifact; reuse it after restart."""
        source_id = work['source_episode_id']
        name = 'project-regression-' + work['id']
        for artifact in self.runtime.store.artifacts(source_id):
            if (artifact.get('name') == name
                    and artifact['producer'].get('node_id') is None
                    and artifact['producer'].get('attempt_id') is None):
                return ProjectRegression(self.runtime, artifact['content'])
        source = self.runtime.store.get(source_id)
        history = self.history(source)
        if not history:
            raise ContractError('A distinct completed task is needed for regression guard')
        suite = {'source_episode_id': source_id, 'development': [self._case(source, feedback=True)],
                 'selection': [self._case(source, feedback=True)],
                 'guard': [self._case(history[0])],
                 'scope': 'Historical project regression; selection reuses development task'}
        self.runtime.store.publish(source_id, suite, name=name)
        return ProjectRegression(self.runtime, suite)

    def tasks(self, split='development', seed=0, **options):
        if self.suite is None or split not in ('development', 'selection', 'guard'):
            raise ContractError('Project regressions require a frozen work-specific suite')
        return deepcopy(self.suite[split])

    def evaluate(self, task_ref, deliverables, execution_view):
        return ModelDeliveryEvaluator(self.runtime, self.stop_event).evaluate(task_ref, deliverables, execution_view)


class ProjectEvolution(AutoEvolutionService):
    """Default admission avoids spending on every successful delivery."""
    def _development_experience(self, work):
        # Reuse durable outcomes as development feedback, not a second memory
        # database. Freeze this projection in the existing development intent.
        with self.store.connect() as db:
            recent = db.execute(
                "SELECT id FROM task_feedback_outbox WHERE channel_id=? AND id<>? "
                "AND status IN ('completed','rolled_back','no_change','rejected') "
                "ORDER BY updated DESC,id DESC LIMIT 8",
                (work['channel_id'], work['id'])).fetchall()
        rows = [self.store.feedback_trigger(row[0]) for row in reversed(recent)]
        experience = []
        for row in rows:
            plan = row.get('development_plan') or {}
            proposal = {}
            if plan.get('artifact_id'):
                proposal = self.store.read(plan['artifact_id'], row['development_episode']['id'])['content']
            item = {'work_id': row['id'], 'parent_revision': row['parent_revision'],
                    'status': row['status'], 'reason': (row.get('reason') or '')[:200],
                    'candidate_type': plan.get('candidate_type'), 'source_ref': plan.get('source_ref'),
                    'hypothesis': {key: value[:500] for key, value in
                                   (proposal.get('hypothesis') or {}).items()},
                    'proposal_reason': proposal.get('reason', '')[:500]}
            if row.get('feedback_bundle'):
                with self.store.connect() as db:
                    receipt = db.execute(
                        "SELECT id FROM task_candidate_generations "
                        "WHERE json_extract(data,'$.feedback_bundle_id')=? "
                        "ORDER BY json_extract(data,'$.completed_at') DESC,id DESC LIMIT 1",
                        (row['feedback_bundle']['id'],)).fetchone()
                if receipt:
                    generated = self._services()[1].generation(receipt[0])
                    item['generation'] = {key: generated.get(key) for key in
                                          ('status', 'reason_type', 'public_patch_error_code')}
            evolution = row.get('evolution') or {}
            decision = evolution.get('selection_decision') or {}
            if decision.get('id'):
                result = self._services()[0].decision(decision['id'])
                measures = result['measurements']
                item['selection'] = {
                    'failed_gates': [key for key, passed in result['gates'].items() if not passed],
                    'parent': {key: measures['parent'][key] for key in ('quality', 'success_rate', 'cost')},
                    'candidate': {key: measures['candidate'][key] for key in ('quality', 'success_rate', 'cost')},
                    'regressions': measures['regressions']}
                if result.get('improvement_basis'):
                    item['selection']['improvement_basis'] = result['improvement_basis']
            guard = evolution.get('guard_assessment')
            if guard:
                item['guard'] = {key: guard[key] for key in ('degraded', 'rolled_back')}
            item['later_use_count'] = len(row.get('reuse_observed', []))
            experience.append(item)
        while len(json.dumps(experience, ensure_ascii=False).encode('utf-8')) > 24_000:
            experience.pop(0)
        return experience

    def _feedback_event_digest(self, episode):
        source_episode_id = episode['id']
        registration = self._registration(episode) or {}
        channel, parent_revision = registration.get('channel'), registration.get('revision')
        feedback = [event for event in self.store.events(source_episode_id)
                    if event['kind'] == 'user_feedback']
        if not feedback:
            return None
        latest = feedback[-1]['digest']
        # A pending observation can collect the new feedback. Once captured,
        # reuse it only for that feedback snapshot; later corrections get a
        # new work item instead of disappearing behind a terminal result.
        for work in self.store.feedback_triggers(limit=256):
            if (work['source_episode_id'] != source_episode_id
                    or work['channel_id'] != channel or work['parent_revision'] != parent_revision):
                continue
            if work['status'] == 'observed' and not work.get('feedback_bundle'):
                return work.get('feedback_event_digest')
            if work.get('feedback_bundle'):
                captured = self._services()[1].feedback(work['feedback_bundle']['id'])
                if any(item.get('event_digest') == latest
                       for ref in captured['episode_refs'] if ref['episode_id'] == source_episode_id
                       for item in ref.get('user_feedback', [])):
                    return work.get('feedback_event_digest')
        return latest

    def _candidate_options(self, work, episode, active):
        options = super()._candidate_options(work, episode, active)
        if ('orchestration' in work['policy']['candidate_types']
                and 'task-instructions' in active['package']['manifest'].get('components', {})):
            from .tasks.member_adoption import member_sources
            feedback = self._services()[1].feedback(work['feedback_bundle']['id'])
            members = member_sources(self.tasks, feedback, active['package'])
            if members:
                options.insert(0, {'candidate_type': 'orchestration', 'source_ref': 'task_members',
                                   'evidence': {'completed_members': [
                                       {**member, 'instructions': member['instructions'][:1000]} for member in members],
                                                'scope': 'Generalize responsibilities and coordination; gate before reuse'}})
            if any(ref.get('user_feedback') or ((ref.get('evaluation') or {}).get('public_metrics') or {}).get('accepted') is False
                   or ref.get('status') in {'failed', 'cancelled'} for ref in feedback['episode_refs']):
                from .tasks.members import member_inventory
                options.insert(0, {'candidate_type': 'orchestration', 'source_ref': 'organization_design',
                                   'evidence': {'deployed_members': member_inventory(active['package']),
                                                'scope': 'Create missing responsibilities, revise or retire deployed members '
                                                         'and improve coordination from feedback; gate before future use'}})
        return options

    def _dispatch_plan(self, work, plan, *, stop_event=None):
        if plan['source_ref'] in {'task_members', 'organization_design'}:
            from .tasks.member_adoption import generate_team
            evolution, generation = self._services()
            return generate_team(self.tasks, evolution, generation, work, plan, stop_event,
                                 organization_change=plan['source_ref'] == 'organization_design')
        return super()._dispatch_plan(work, plan, stop_event=stop_event)

    @staticmethod
    def _mutation_policy(parent):
        policy = AutoEvolutionService._mutation_policy(parent)
        if policy is not None and policy.get('patch_contract') == 'nexgent.package-patch.v3':
            # Start with the mature single-component replacement contract.
            # Explicit project policies retain multi-component graph evolution.
            return {'mutable_components': policy['mutable_components'],
                    'allowed_operations': ['replace'], 'max_patch_bytes': 300000}
        return policy

    @classmethod
    def _orchestration_mutation_policy(cls, parent):
        # Default composition does not schedule multi-attempt graph search.
        return None

    def observe_terminal(self, episode_id):
        state = self.store.get(episode_id)
        if not ordinary(state):
            return None
        if self.store.benchmark_registration(episode_id) is not None:
            return None
        registration = self._registration(state)
        if state['status'] in {'completed', 'failed', 'cancelled'}:
            self._record_reuse(state, registration)
        # Explicit zero model budget must never launch separately funded model work.
        if state['budget']['max_model_calls'] == 0 or state['budget']['max_completion_tokens'] == 0:
            return None
        feedback = self.tasks.feedback_items(episode_id)
        failed = ((state.get('evaluation') or {}).get('accepted') is False
                  or state['status'] == 'failed')
        creators = self._feedback_episode_ids({'source_episode_id': episode_id})
        with self.store.connect() as db:
            developed = db.execute('SELECT 1 FROM task_capability_definitions '
                                   'WHERE origin_episode IN (' + ','.join('?' for _ in creators)
                                   + ') LIMIT 1', tuple(creators)).fetchone()
        from .tasks.members import used_members
        parent = self.store.package(state['package_id'])
        members = [member for member in used_members(self.store, creators, parent)
                   if member['name'] not in parent['manifest'].get('roles', {})]
        if not feedback and not failed and not developed and not members:
            return None
        return super().observe_terminal(episode_id)

    def _process_locked(self, identity):
        work = self.store.feedback_trigger(identity)
        if work['status'] == 'observed':
            adapter = self.tasks._benchmark_registry().get(REPLAY_ID)
            if not adapter.ready(work)[0]:
                return work  # Remains pending; new real tasks can make it runnable.
            adapter.for_work(work)
        return super()._process_locked(identity)


def configure_project_improvement(runtime):
    runtime.benchmark_adapters[REPLAY_ID] = ProjectRegression(runtime)
    improvers = ImproverService(runtime)
    try:
        registration = active_improver_registration(runtime.store, IMPROVER_CHANNEL)
    except KeyError:
        improvers.register(IMPROVER_CHANNEL, default_improver_package(),
                          {'mutable_paths': ['improver.py'], 'allowed_operations': ['replace']})
        registration = active_improver_registration(runtime.store, IMPROVER_CHANNEL)
    trigger = ProjectEvolution(runtime, policies={runtime.main_channel: {
        'evaluator_id': REPLAY_ID,
        'candidate_types': ['orchestration', 'tool', 'service_provider', 'no_change'],
        'budget': deepcopy(PHASE_BUDGET),
        'improver': {key: registration[key] for key in
                     ('channel', 'revision', 'package_id', 'package_digest')},
        'promotion_policy': {'min_quality_delta': 0.1, 'min_success_rate': 1,
                             'max_cost_ratio': 1.25, 'max_regressions': 0,
                             'min_cost_reduction': 0.2,
                             'monitor_min_score': 7, 'monitor_min_success_rate': 1}}})
    trigger.default_channel = runtime.main_channel
    from .application import MAIN_CAPABILITY_AUTHORITY
    trigger.capability_authority = deepcopy(MAIN_CAPABILITY_AUTHORITY)
    return trigger


def improvement_status(runtime, identity=None):
    """Project existing records into product state, with disjoint root costs."""
    enabled = runtime.auto_improve_enabled
    rows = runtime.store.feedback_triggers(limit=256)
    rows = [r for r in rows if r.get('channel_id') == runtime.main_channel]
    roots, items = set(), []
    for row in rows:
        if identity and row['source_episode_id'] != identity:
            continue
        evolution = row.get('evolution') or {}
        reason = row.get('reason')
        if row['status'] == 'observed' and isinstance(runtime.auto_evolution, ProjectEvolution):
            reason = runtime.benchmark_adapters[REPLAY_ID].ready(row)[1]
        plan = row.get('development_plan') or {}
        detail = None
        if plan.get('artifact_id'):
            episode_id = row['development_episode']['id']
            detail = runtime.store.read(plan['artifact_id'], episode_id)['content']
        episode_id = (row.get('development_episode') or {}).get('id')
        if episode_id:
            roots.add(runtime.store.get(episode_id)['root_episode_id'])
        generation_id = (row.get('candidate') or {}).get('generation_id')
        organization = None
        if generation_id:
            generated = runtime.auto_evolution._services()[1].generation(generation_id)
            if generated.get('episode_id'):
                roots.add(runtime.store.get(generated['episode_id'])['root_episode_id'])
            if (plan.get('source_ref') in {'task_members', 'organization_design'}
                    and row['candidate'].get('candidate_package_id')):
                from .tasks.members import organization_changes
                organization = organization_changes(runtime.store.package(row['source']['package_id']),
                                                    runtime.store.package(row['candidate']['candidate_package_id']))
        selection = evolution.get('selection_trial') or {}
        if selection.get('id'):
            trial = runtime.evolution.trial(selection['id'])
            roots.update(p[arm]['episode_id'] for p in trial['pairs'] for arm in ('parent', 'candidate'))
        roots.update((evolution.get('guard_run') or {}).get('episode_ids') or [])
        decision_ref = evolution.get('selection_decision') or {}
        selection_report = None
        if decision_ref.get('id'):
            decision = runtime.evolution.decision(decision_ref['id'])
            selection_report = {key: deepcopy(decision[key]) for key in ('gates', 'measurements')}
            selection_report['improvement_basis'] = decision.get('improvement_basis')
        items.append({'id': row['id'], 'source_episode_id': row['source_episode_id'],
                      'source_objective': runtime.store.get(row['source_episode_id'])['task']['objective'],
                      'status': row['status'], 'reason': reason,
                      'proposal': deepcopy(detail), 'promotion': deepcopy(evolution.get('promotion')),
                      'organization_change': organization,
                      'learning_from': [item['work_id'] for item in
                                        (row.get('development_intent') or {}).get('experience', [])],
                      'selection': selection_report,
                      'reuse_episode_ids': [r['episode_id'] for r in row.get('reuse_observed', [])]})
    # Include already admitted roots even if the process stopped before storing a phase result.
    work_ids = {item['id'] for item in items}
    bundle_ids = {row['feedback_bundle']['id'] for row in rows
                  if row['id'] in work_ids and row.get('feedback_bundle')}
    selection_ids = {(row.get('evolution', {}).get('selection_plan') or {}).get('id')
                     for row in rows if row['id'] in work_ids}
    guard_ids = {(row.get('evolution', {}).get('guard_plan') or {}).get('id')
                 for row in rows if row['id'] in work_ids}
    for state in runtime.store.list():
        context = state['task'].get('context', {})
        registration = context.get('evolution_registration') or {}
        monitor = context.get('monitoring_registration') or {}
        if (context.get('feedback_work_id') in work_ids
                or context.get('feedback_bundle_id') in bundle_ids
                or (registration.get('plan_id') is not None and registration['plan_id'] in selection_ids)
                or (monitor.get('monitor_plan_id') is not None and monitor['monitor_plan_id'] in guard_ids)):
            roots.add(state['root_episode_id'])
    usages = [runtime.store.usage(root) for root in sorted(roots)]
    usage = {key: sum(u.get(key, 0) for u in usages)
             for key in ('model_calls', 'tool_calls', 'charged_completion_tokens')}
    usage['known_total_tokens'] = sum(u['known_usage']['total_tokens'] for u in usages)
    usage['usage_complete'] = all(u['usage_complete'] for u in usages)
    return {'enabled': enabled, 'configured': runtime.auto_evolution is not None,
            'mode': 'project_regression' if isinstance(runtime.auto_evolution, ProjectEvolution) else 'configured',
            'active_revision': runtime.evolution.active(runtime.main_channel)['revision'],
            'items': items, 'usage': usage, 'root_episode_ids': sorted(roots),
            'phase_budget': deepcopy(PHASE_BUDGET) if isinstance(runtime.auto_evolution, ProjectEvolution) else None}


def load_enabled(runtime):
    path = runtime.project_root / '.nexgent' / 'product-settings.json'
    if not path.is_file():
        return True
    value = json.loads(path.read_text(encoding='utf-8'))
    if not isinstance(value, dict) or type(value.get('auto_improve')) is not bool:
        raise ValueError('Invalid product improvement setting')
    return value['auto_improve']


def save_enabled(runtime, enabled):
    if type(enabled) is not bool:
        raise ValueError('auto_improve must be boolean')
    path = runtime.project_root / '.nexgent' / 'product-settings.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps({'auto_improve': enabled}), encoding='utf-8')
    temp.replace(path)
    runtime.auto_improve_enabled = enabled
