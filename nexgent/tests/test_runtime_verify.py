import dataclasses

from nexgent.runtime.contracts import RunStatus
from nexgent.runtime.recorder import RunRecorder
from nexgent.runtime.store import SQLiteRunStore
from nexgent.runtime.verify import load_export_jsonl, main, verify_export


def _golden_store(tmp_path):
    store = SQLiteRunStore(tmp_path / "runs")
    recorder = RunRecorder(store, tmp_path)
    context = recorder.start_run("golden trace", session_id="golden")
    recorder.record_runtime_event(
        context, "message_started", {"step": 1, "model": "test"}
    )
    recorder.record_runtime_event(
        context,
        "message_finished",
        {"step": 1, "model": "test", "tool_call_ids": ["call-1"]},
    )
    recorder.record_runtime_event(
        context,
        "tool_started",
        {"tool": "read_file", "tool_call_id": "call-1"},
    )
    recorder.record_runtime_event(
        context,
        "tool_finished",
        {"tool": "read_file", "tool_call_id": "call-1", "message": "ok"},
    )
    recorder.finish_unverified(context, "done")
    return store, context


def test_golden_trace_passes_independent_verifier(tmp_path):
    store, context = _golden_store(tmp_path)

    report = verify_export(
        store.export_run(context.run_id),
        required_event_kinds=("run", "model", "tool"),
        required_runtime_kinds=(
            "message_started",
            "message_finished",
            "tool_started",
            "tool_finished",
        ),
        strict_lifecycles=True,
    )

    assert report.ok, report.errors
    assert report.run_id == context.run_id
    assert report.counts["events"] == 6
    assert report.counts["dependency_edges"] == 3


def test_verifier_rejects_corrupt_sequence_secret_and_missing_cause(tmp_path):
    store, context = _golden_store(tmp_path)
    bundle = store.export_run(context.run_id)
    bundle["events"][1]["sequence"] = 99
    bundle["events"][1]["causation_event_id"] = "event-missing"
    bundle["events"][1]["payload"]["api_key"] = "exposed"

    report = verify_export(bundle, required_event_kinds=("simulator",))

    assert not report.ok
    combined = "\n".join(report.errors)
    assert "not contiguous" in combined
    assert "missing cause" in combined
    assert "unredacted secret" in combined
    assert "required event kind is missing: simulator" in combined


def test_succeeded_run_requires_accepting_verification(tmp_path):
    store, context = _golden_store(tmp_path)
    bundle = store.export_run(context.run_id)
    bundle["run"] = dataclasses.replace(
        store.get_run(context.run_id), status=RunStatus.SUCCEEDED
    ).to_dict()

    report = verify_export(bundle)

    assert not report.ok
    assert "succeeded run has no accepting verification" in report.errors


def test_verify_run_command_reports_machine_readable_result(tmp_path, capsys):
    store, context = _golden_store(tmp_path)

    exit_code = main(
        [
            "--store",
            str(store.root),
            "--run-id",
            context.run_id,
            "--require-event-kind",
            "tool",
            "--strict-lifecycles",
        ]
    )

    assert exit_code == 0
    assert '"ok": true' in capsys.readouterr().out


def test_jsonl_round_trip_and_corrupt_tail_recovery(tmp_path):
    store, context = _golden_store(tmp_path)
    jsonl = store.export_run_jsonl(context.run_id)

    restored, dropped = load_export_jsonl(jsonl)
    recovered, recovered_tail = load_export_jsonl(
        jsonl + '{"record_type":"events"',
        allow_corrupt_tail=True,
    )

    assert not dropped
    assert recovered_tail
    assert restored == recovered == store.export_run(context.run_id)


def test_jsonl_rejects_corruption_before_tail(tmp_path):
    store, context = _golden_store(tmp_path)
    lines = store.export_run_jsonl(context.run_id).splitlines()
    lines.insert(1, "{not-json")

    try:
        load_export_jsonl("\n".join(lines), allow_corrupt_tail=True)
    except ValueError as exc:
        assert "line 2" in str(exc)
    else:
        raise AssertionError("mid-stream corruption must not be discarded")


def test_verify_run_command_accepts_portable_jsonl(tmp_path, capsys):
    store, context = _golden_store(tmp_path)
    export_path = tmp_path / "golden.jsonl"
    export_path.write_text(store.export_run_jsonl(context.run_id), encoding="utf-8")

    exit_code = main(
        [
            "--jsonl",
            str(export_path),
            "--require-event-kind",
            "model",
            "--strict-lifecycles",
        ]
    )

    assert exit_code == 0
    assert '"ok": true' in capsys.readouterr().out
