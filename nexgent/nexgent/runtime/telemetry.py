"""Simulator, resource, and external-side-effect telemetry contracts.

Adapters translate domain-specific simulator state into a provider-neutral
snapshot.  The recorder keeps raw state as an artifact and a searchable event;
irreversible effects are rejected unless an approval event is already durable.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, Mapping, Optional, Protocol

from .contracts import DependencyKind, EventKind, SourceType
from .recorder import RunContext, RunRecorder


class UnsafeSideEffectError(RuntimeError):
    """Raised when an irreversible effect lacks explicit durable approval."""


class SimulatorAdapter(Protocol):
    adapter_id: str

    def snapshot(self) -> Mapping[str, Any]:
        """Return JSON-compatible internal simulator state."""


@dataclass(frozen=True)
class ResourceState:
    resource_id: str
    kind: str
    owner: str
    capacity: float
    used: float
    waiters: tuple[str, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)

    def validate(self) -> None:
        if not self.resource_id or not self.kind or not self.owner:
            raise ValueError("resource_id, kind, and owner are required")
        if self.capacity < 0 or self.used < 0:
            raise ValueError("resource capacity and use cannot be negative")


@dataclass(frozen=True)
class ExternalSideEffect:
    effect_id: str
    operation: str
    target: str
    reversible: bool
    idempotency_key: Optional[str] = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def validate(self) -> None:
        if not self.effect_id or not self.operation or not self.target:
            raise ValueError("effect_id, operation, and target are required")
        if not self.reversible and not self.idempotency_key:
            raise ValueError("irreversible effect needs an idempotency key")


class HarnessTelemetry:
    """Record domain telemetry with explicit causality and completeness."""

    def __init__(self, recorder: RunRecorder) -> None:
        self.recorder = recorder

    def record_simulator_snapshot(
        self,
        context: RunContext,
        adapter: SimulatorAdapter,
        *,
        causation_event_id: Optional[str] = None,
        required_fields: tuple[str, ...] = (),
    ):
        state = dict(adapter.snapshot())
        missing = tuple(sorted(field for field in required_fields if field not in state))
        raw = json.dumps(state, ensure_ascii=False, sort_keys=True).encode("utf-8")
        event = self.recorder.record(
            context,
            EventKind.SIMULATOR,
            SourceType.SIMULATOR,
            adapter.adapter_id,
            payload={
                "stage": "simulator_snapshot",
                "state": state,
                "required_fields": list(required_fields),
                "missing_fields": list(missing),
                "telemetry_complete": not missing,
            },
            causation_event_id=causation_event_id,
        )
        artifact = self.recorder.record_artifact(
            context,
            raw,
            role="simulator_state",
            media_type="application/json",
            producer_event_id=event.event_id,
            metadata={"adapter_id": adapter.adapter_id, "missing_fields": list(missing)},
        )
        if causation_event_id:
            self.recorder.link(
                context,
                causation_event_id,
                event.event_id,
                DependencyKind.DATA,
                evidence_event_id=event.event_id,
                metadata={"telemetry_complete": not missing},
            )
        return event, artifact

    def record_resource_state(
        self,
        context: RunContext,
        state: ResourceState,
        *,
        causation_event_id: Optional[str] = None,
    ):
        state.validate()
        oversubscribed = state.used > state.capacity
        event = self.recorder.record(
            context,
            EventKind.PROCESS,
            SourceType.RUNTIME,
            "resource-observer",
            payload={
                "stage": "resource_snapshot",
                "resource_id": state.resource_id,
                "kind": state.kind,
                "owner": state.owner,
                "capacity": state.capacity,
                "used": state.used,
                "waiters": list(state.waiters),
                "oversubscribed": oversubscribed,
                "metadata": state.metadata,
            },
            causation_event_id=causation_event_id,
        )
        if causation_event_id:
            self.recorder.link(
                context,
                causation_event_id,
                event.event_id,
                DependencyKind.RESOURCE,
                evidence_event_id=event.event_id,
            )
        return event

    def record_side_effect(
        self,
        context: RunContext,
        effect: ExternalSideEffect,
        *,
        causation_event_id: Optional[str] = None,
        approved: bool = False,
    ):
        effect.validate()
        if not effect.reversible and not approved:
            raise UnsafeSideEffectError(
                f"irreversible effect {effect.effect_id} requires approval"
            )
        if approved:
            self.recorder.record(
                context,
                EventKind.APPROVAL,
                SourceType.USER,
                "permission-gate",
                payload={
                    "effect_id": effect.effect_id,
                    "decision": "approved",
                    "target": effect.target,
                },
                causation_event_id=causation_event_id,
            )
        event = self.recorder.record(
            context,
            EventKind.TOOL,
            SourceType.TOOL,
            "external-side-effect",
            payload={
                "stage": "external_side_effect",
                "effect_id": effect.effect_id,
                "operation": effect.operation,
                "target": effect.target,
                "reversible": effect.reversible,
                "idempotency_key": effect.idempotency_key,
                "metadata": effect.metadata,
            },
            causation_event_id=causation_event_id,
        )
        if causation_event_id:
            self.recorder.link(
                context,
                causation_event_id,
                event.event_id,
                DependencyKind.CAUSAL,
                evidence_event_id=event.event_id,
                metadata={"external": True, "reversible": effect.reversible},
            )
        return event


class MappingSimulatorAdapter:
    """Small adapter useful for simulators that already expose a state map."""

    def __init__(self, adapter_id: str, state: Mapping[str, Any]) -> None:
        self.adapter_id = adapter_id
        self._state = dict(state)

    def snapshot(self) -> Mapping[str, Any]:
        return dict(self._state)
