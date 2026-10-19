import subprocess
import sys

import pytest

from nexgent.runtime.contracts import AttemptStatus, AttemptTrigger
from nexgent.runtime.recorder import RunRecorder
from nexgent.runtime.store import LeaseConflictError, SQLiteRunStore
from nexgent.runtime.verify import verify_export


def test_fresh_process_resumes_without_replaying_open_tool(tmp_path):
    store_dir = tmp_path / "runs"
    script = """
import sys
from nexgent.runtime.recorder import RunRecorder
from nexgent.runtime.store import SQLiteRunStore

root, store_dir = sys.argv[1], sys.argv[2]
store = SQLiteRunStore(store_dir)
recorder = RunRecorder(store, root)
context = recorder.start_run("survive process exit")
recorder.record_runtime_event(context, "message_started", {"step": 1, "model": "test"})
recorder.record_runtime_event(context, "message_finished", {"step": 1, "model": "test", "tool_call_ids": ["call-1"]})
recorder.record_runtime_event(context, "tool_started", {"tool": "solver", "tool_call_id": "call-1"})
print(context.run_id)
"""
    completed = subprocess.run(
        [sys.executable, "-c", script, str(tmp_path), str(store_dir)],
        check=True,
        capture_output=True,
        text=True,
    )
    run_id = completed.stdout.strip()

    reopened_store = SQLiteRunStore(store_dir)
    recorder = RunRecorder(reopened_store, tmp_path)
    before_resume = reopened_store.list_events(run_id)
    original_tool_start = next(
        event
        for event in before_resume
        if event.payload.get("runtime_kind") == "tool_started"
    )
    context = recorder.resume_run(run_id, lease_holder="replacement-process")
    recorder.record_runtime_event(
        context,
        "tool_finished",
        {"tool": "solver", "tool_call_id": "call-1", "message": "reconciled"},
    )
    recorder.finish_unverified(context, "done")

    attempts = reopened_store.list_attempts(run_id)
    assert [attempt.trigger for attempt in attempts] == [
        AttemptTrigger.INITIAL,
        AttemptTrigger.RESUME,
    ]
    assert [attempt.status for attempt in attempts] == [
        AttemptStatus.ABORTED,
        AttemptStatus.SUCCEEDED,
    ]
    events = reopened_store.list_events(run_id)
    tool_starts = [
        event
        for event in events
        if event.payload.get("runtime_kind") == "tool_started"
    ]
    tool_finish = next(
        event
        for event in events
        if event.payload.get("runtime_kind") == "tool_finished"
    )
    assert tool_starts == [original_tool_start]
    assert tool_finish.causation_event_id == original_tool_start.event_id
    assert [event.sequence for event in events] == list(range(1, len(events) + 1))
    report = verify_export(
        reopened_store.export_run(run_id),
        required_event_kinds=("run", "attempt", "model", "tool"),
        strict_lifecycles=True,
    )
    assert report.ok, report.errors


def test_waiting_approval_run_can_reenter_runtime_without_replaying_effects(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    recorder = RunRecorder(store, tmp_path)
    original = recorder.start_run("approval continuation")
    recorder.pause(original, "operator approval required", waiting_approval=True)

    resumed = RunRecorder(SQLiteRunStore(tmp_path / "runs"), tmp_path).resume_run(
        original.run_id,
        lease_holder="approved-runtime",
    )
    RunRecorder(store, tmp_path).finish_unverified(resumed, "approval state restored")

    attempts = store.list_attempts(original.run_id)
    assert [attempt.trigger for attempt in attempts] == [
        AttemptTrigger.INITIAL,
        AttemptTrigger.RESUME,
    ]
    assert [attempt.status for attempt in attempts] == [
        AttemptStatus.PAUSED,
        AttemptStatus.SUCCEEDED,
    ]


def test_resume_lease_rejects_a_second_runtime(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    first_recorder = RunRecorder(store, tmp_path)
    interrupted = first_recorder.start_run("single owner")
    resumed = RunRecorder(SQLiteRunStore(tmp_path / "runs"), tmp_path).resume_run(
        interrupted.run_id,
        lease_holder="runtime-a",
    )

    with pytest.raises(LeaseConflictError, match="runtime-a"):
        RunRecorder(SQLiteRunStore(tmp_path / "runs"), tmp_path).resume_run(
            interrupted.run_id,
            lease_holder="runtime-b",
        )

    first_recorder.store.release_lease(interrupted.run_id, resumed.lease_holder)
