"""Trusted workspace computation uses the same worker meter as reusable tools."""
import threading

import pytest

from nexgent import Nexgent
from nexgent.kernel.store import BudgetExhausted
from nexgent.organization_tools import compute_package
from nexgent.tasks.packages import PackageError
from nexgent.tasks.package_runner import run_package


def invoke(runtime, identity, code):
    state = runtime.store.get(identity)
    return runtime._dispatch(identity, runtime.store.package(state['package_id']),
                             'tool', {'name': 'run_python', 'arguments': {'code': code, 'payload': {'value': 6}}},
                             'compute.1', threading.Event(), lambda: None)


def test_workspace_charges_the_actual_worker_count_and_preserves_it_on_restart(tmp_path):
    code = "return {'value': payload['value'] * 7}"
    measured = run_package(compute_package(code), 'execute', {'value': 6})['execution']['instructions']
    runtime = Nexgent(tmp_path)
    identity = runtime.create('Compute', budget={'max_tool_work_units': 100})['id']
    result = invoke(runtime, identity, code)
    assert result['value'] == {'value': 42}
    assert runtime.get(identity)['usage']['charged_tool_work_units'] == measured > 0
    assert Nexgent(tmp_path).get(identity)['usage']['charged_tool_work_units'] == measured


def test_zero_work_budget_refuses_workspace_compute_before_worker_execution(tmp_path):
    runtime = Nexgent(tmp_path)
    identity = runtime.create('Compute', budget={'max_tool_work_units': 0})['id']
    assert 'run_python' not in runtime.store.get(identity)['capabilities']
    with pytest.raises(PermissionError):
        invoke(runtime, identity, 'return 42')
    assert not [e for e in runtime.store.events(identity) if e['kind'] == 'tool']
    assert runtime.get(identity)['usage']['tool_calls'] == 0


def test_failed_workspace_compute_still_records_measured_work(tmp_path):
    runtime = Nexgent(tmp_path)
    identity = runtime.create('Compute')['id']
    with pytest.raises(PackageError):
        invoke(runtime, identity, "raise ValueError('computation failed')")
    result = runtime.get(identity)
    assert result['usage']['charged_tool_work_units'] > 0
    assert result['usage']['usage_complete'] is True


def test_workspace_timeout_keeps_missing_measurement_unknown(tmp_path, monkeypatch):
    from nexgent.tasks import runtime as module
    runtime = Nexgent(tmp_path)
    identity = runtime.create('Compute')['id']
    def timeout(*args, **kwargs):
        raise TimeoutError('Worker produced no measurement')
    monkeypatch.setattr(module, 'run_package', timeout)
    with pytest.raises(TimeoutError):
        invoke(runtime, identity, 'return 42')
    result = runtime.get(identity)
    assert result['usage']['usage_complete'] is False
    assert result['usage']['tool_usage_missing_call_ids']
