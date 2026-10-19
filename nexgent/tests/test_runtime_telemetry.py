import pytest

from nexgent.runtime.recorder import RunRecorder
from nexgent.runtime.store import SQLiteRunStore
from nexgent.runtime.telemetry import (
    ExternalSideEffect,
    HarnessTelemetry,
    MappingSimulatorAdapter,
    ResourceState,
    UnsafeSideEffectError,
)


def test_simulator_resource_and_missing_telemetry_are_durable(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    recorder = RunRecorder(store, tmp_path)
    context = recorder.start_run("trace simulator internals")
    telemetry = HarnessTelemetry(recorder)

    simulator, artifact = telemetry.record_simulator_snapshot(
        context,
        MappingSimulatorAdapter("heat-solver", {"step": 4, "residual": 0.01}),
        required_fields=("step", "residual", "temperature_max"),
    )
    resource = telemetry.record_resource_state(
        context,
        ResourceState(
            resource_id="gpu-0",
            kind="gpu_memory_gb",
            owner="solver-a",
            capacity=8,
            used=9,
            waiters=("solver-b",),
        ),
        causation_event_id=simulator.event_id,
    )

    assert simulator.payload["telemetry_complete"] is False
    assert simulator.payload["missing_fields"] == ["temperature_max"]
    assert artifact.role == "simulator_state"
    assert resource.payload["oversubscribed"] is True
    assert any(edge.kind.value == "resource" for edge in store.list_dependencies(context.run_id))


def test_irreversible_external_effect_requires_and_records_approval(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    recorder = RunRecorder(store, tmp_path)
    context = recorder.start_run("guard external effect")
    telemetry = HarnessTelemetry(recorder)
    effect = ExternalSideEffect(
        effect_id="publish-result",
        operation="publish",
        target="remote://research/result",
        reversible=False,
        idempotency_key="result-v1",
    )

    with pytest.raises(UnsafeSideEffectError, match="requires approval"):
        telemetry.record_side_effect(context, effect)

    event = telemetry.record_side_effect(context, effect, approved=True)
    events = store.list_events(context.run_id)
    assert event.payload["reversible"] is False
    assert any(item.kind.value == "approval" for item in events)
