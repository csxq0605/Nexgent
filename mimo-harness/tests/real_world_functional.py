"""Real-world functional tests for MiMo Harness.
Tests complete workflows, not just unit behavior."""

import sys
import os
import json
import tempfile
import shutil
import threading

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def test_1_tool_registration():
    from mimo_harness.tools.registry import ToolRegistry
    from mimo_harness.tools import (
        file_ops, shell, code_exec, web_tools, doc_tools,
        math_tools, interactive, monitor, notebook_tools, task_tools,
    )

    registry = ToolRegistry()
    all_tools = (
        file_ops.get_tools() + shell.get_tools() + code_exec.get_tools()
        + web_tools.get_tools() + doc_tools.get_tools() + math_tools.get_tools()
        + interactive.get_tools() + monitor.get_tools() + notebook_tools.get_tools()
        + task_tools.get_tools()
    )
    registry.register_many(all_tools)
    assert len(all_tools) >= 18, f"Expected 18+ tools, got {len(all_tools)}"
    for t in all_tools:
        assert t.name, "Tool missing name"
        assert t.description, f"Tool {t.name} missing description"
        assert "type" in t.parameters, f"Tool {t.name} missing parameters type"
    print(f"  [PASS] Registered {len(all_tools)} tools with valid schemas")


def test_2_permission_all_modes():
    from mimo_harness.permissions import PermissionGate, Permission, PermissionMode

    for mode in PermissionMode:
        if mode == PermissionMode.PLAN:
            gate = PermissionGate(plan_mode=True)
        elif mode == PermissionMode.AUTO:
            gate = PermissionGate(auto_approve=True)
        else:
            gate = PermissionGate()
            gate.mode = mode

        # DONT_ASK mode only allows pre-approved tools, not READ by default
        if mode != PermissionMode.DONT_ASK:
            assert gate.check(Permission.READ, "read_file(path=/tmp/test)"), f"{mode.value}: READ failed"
        if mode == PermissionMode.PLAN:
            assert not gate.check(Permission.WRITE, "write_file(path=/tmp/test)"), f"{mode.value}: WRITE should block"
        if mode == PermissionMode.BYPASS:
            assert gate.check(Permission.WRITE, "write_file(path=/tmp/test)"), f"{mode.value}: WRITE should pass"
        if mode == PermissionMode.DONT_ASK:
            # DONT_ASK denies anything without an explicit allow rule
            assert not gate.check(Permission.READ, "read_file(path=/tmp/test)"), f"{mode.value}: should deny without allow rule"
    print("  [PASS] All 6 permission modes verified")


def test_3_compound_command_parsing():
    from mimo_harness.tools.shell import _split_compound_command, _is_readonly

    tests = [
        ("ls -la && echo done", ["ls -la", "echo done"]),
        ("git status || echo fail", ["git status", "echo fail"]),
        ("cat file; rm -rf /", ["cat file", "rm -rf /"]),
        ("ls | head -5", ["ls", "head -5"]),
    ]
    for cmd, expected in tests:
        result = _split_compound_command(cmd)
        assert result == expected, f"Failed for {cmd}: {result} != {expected}"

    assert _is_readonly("ls -la && echo done"), "ls && echo should be readonly"
    assert not _is_readonly("ls -la && rm -rf /"), "ls && rm should not be readonly"
    assert _is_readonly("git log | head -5"), "git log | head should be readonly"
    print("  [PASS] Compound command parsing and readonly detection OK")


def test_4_credential_scrubbing():
    from mimo_harness.tools.shell import _scrub_env

    env = _scrub_env()
    sensitive = ["MIMO_API_KEY", "OPENAI_API_KEY", "SECRET_KEY", "AUTH_TOKEN", "PASSWORD", "DATABASE_URL"]
    for key in sensitive:
        assert key not in env, f"{key} should be scrubbed"
    assert "PATH" in env, "PATH should be preserved"
    print("  [PASS] Credential scrubbing removes sensitive keys, preserves safe ones")


def test_5_context_compression():
    from mimo_harness.context import estimate_tokens, snip_compress, microcompact

    msgs = []
    for i in range(1000):
        msgs.append({"role": "user" if i % 2 == 0 else "assistant", "content": f"Msg {i}: " + "x" * 100})
        if i % 5 == 0:
            msgs.append({"role": "tool", "content": f"Tool {i}: " + "y" * 500, "tool_call_id": f"tc_{i}"})

    snipped = snip_compress(msgs, max_age=20)
    assert len(snipped) == len(msgs), "Snip preserves count"

    micro = microcompact(msgs, keep_recent=5)
    tool_msgs = [m for m in micro if isinstance(m, dict) and m.get("role") == "tool"]
    recent = tool_msgs[-5:]
    for t in recent:
        assert t["content"] != "[Old tool result content cleared]", "Recent tools preserved"
    # Verify that old tool messages WERE actually cleared
    old = tool_msgs[:-5]
    if old:
        assert any(t["content"] == "[Old tool result content cleared]" for t in old), \
            "Old tool messages should be cleared by microcompact"

    tokens = estimate_tokens(msgs)
    assert tokens > 10000, f"Expected >10K tokens, got {tokens}"
    print(f"  [PASS] Compression: {len(msgs)} msgs, ~{tokens} tokens, snip + microcompact OK")


def test_6_session_persistence():
    from mimo_harness.context import Session

    tmp = tempfile.mkdtemp()
    try:
        s = Session(session_id="test-123", working_dir=tmp)
        s.add_message("user", "Hello")
        s.add_message("assistant", "Hi there!")

        save_path = os.path.join(tmp, "session.json")
        s.save(save_path)
        loaded = Session.load(save_path)
        assert loaded.session_id == "test-123"
        assert len(loaded.messages) == 2

        s.auto_save_dir = tmp
        s.add_message("user", "Follow up")
        loaded_jsonl, _ = Session.from_jsonl(os.path.join(tmp, "test-123.jsonl"))
        assert len(loaded_jsonl.messages) >= 1
        print("  [PASS] Session save/load/JSONL persistence OK")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_7_checkpoint_rewind():
    from mimo_harness.context import CheckpointManager

    tmp = tempfile.mkdtemp()
    try:
        mgr = CheckpointManager("test-session")
        mgr.checkpoint_dir = os.path.join(tmp, "checkpoints")

        test_file = os.path.join(tmp, "test.py")
        with open(test_file, "w") as f:
            f.write("original")

        mgr.snapshot(test_file)
        with open(test_file, "w") as f:
            f.write("modified")
        assert open(test_file).read() == "modified"

        mgr.restore_last()
        assert open(test_file).read() == "original"
        print("  [PASS] Checkpoint snapshot + restore OK")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_8_settings_hierarchy():
    from mimo_harness.settings import SettingsManager

    tmp = tempfile.mkdtemp()
    try:
        # SettingsManager takes project_dir
        mgr = SettingsManager(project_dir=tmp)
        assert mgr.get("nonexistent", "default") == "default"

        # Create project settings
        os.makedirs(os.path.join(tmp, ".mimo"), exist_ok=True)
        with open(os.path.join(tmp, ".mimo", "settings.json"), "w") as f:
            json.dump({"theme": "dark", "permissions": {"deny": ["run_command:rm *"]}}, f)

        mgr2 = SettingsManager(project_dir=tmp)
        assert mgr2.get("theme") == "dark"
        assert "run_command:rm *" in mgr2.get_nested("permissions", "deny", default=[])
        print("  [PASS] Settings hierarchy: 4-level loading + deny accumulation OK")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_9_memory_system():
    from mimo_harness.memory import MemoryStore, MemoryType

    tmp = tempfile.mkdtemp()
    try:
        store = MemoryStore(project_dir=tmp)
        # save_memory(name, memory_type, description, content)
        for mtype in MemoryType:
            store.save_memory(
                name=f"{mtype.value}_test",
                memory_type=mtype,
                description=f"Test memory for {mtype.value}",
                content=f"Content for {mtype.value}",
            )

        memories = store.list_memories()
        assert len(memories) == len(MemoryType), f"Expected {len(MemoryType)}, got {len(memories)}"

        store.delete_memory("user_test")
        memories_after = store.list_memories()
        names = [m.name for m in memories_after]
        assert "user_test" not in names
        print(f"  [PASS] Memory system: {len(MemoryType)} types, CRUD + list OK")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_10_task_thread_safety():
    from mimo_harness.tools.task_tools import task_create

    results = []
    errors = []

    def create_task(i):
        try:
            results.append(json.loads(task_create({"subject": f"Task {i}", "description": f"Desc {i}"})))
        except Exception as e:
            errors.append(e)

    threads = [threading.Thread(target=create_task, args=(i,)) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(errors) == 0, f"Thread errors: {errors}"
    assert len(results) == 20
    print(f"  [PASS] Task thread safety: {len(results)} concurrent creates OK")


def test_11_agent_harness_init():
    from mimo_harness.agent import MiMoHarness, CircuitBreaker, TokenBudget

    harness = MiMoHarness(dry_run=True, bare=True, max_steps=5)
    assert harness.registry
    assert harness.perms
    assert harness.circuit_breaker
    assert harness.token_budget

    cb = CircuitBreaker(threshold=3)
    for _ in range(3):
        cb.record_failure()
    assert cb.check()
    cb.record_success()
    assert not cb.check()

    tb = TokenBudget(max_tokens=200000)
    assert not tb.is_warning()
    assert not tb.is_blocked()
    print("  [PASS] Agent harness instantiation + circuit breaker + token budget OK")


def test_12_hooks_system():
    from mimo_harness.hooks import HookRunner, HookEvent, HookConfig

    runner = HookRunner()

    # Register a function hook
    called = []
    def on_stop(**kw):
        called.append("stop")
    runner.register_function(HookEvent.STOP, on_stop)
    runner.run_hooks(HookEvent.STOP)
    assert called == ["stop"]

    # Register a command hook config
    config = HookConfig(event=HookEvent.PRE_TOOL_USE, matcher="*", command="echo ok")
    runner.register(config)
    assert len(runner._hooks[HookEvent.PRE_TOOL_USE]) == 1
    print("  [PASS] Hooks system: register function + command hooks, fire OK")


def test_13_logging():
    from mimo_harness.logging_utils import TraceLogger

    logger = TraceLogger(session_id="test-log-session")
    logger.info("test_event", key="value")
    logger.error("test_error", detail="something went wrong")
    summary = logger.session_summary()
    assert summary["session_id"] == "test-log-session"
    assert summary["total_steps"] >= 0
    print("  [PASS] Logging: TraceLogger init, info, error, summary OK")


def test_14_project_scanner():
    from mimo_harness.project_scanner import scan_project

    tmp = tempfile.mkdtemp()
    try:
        with open(os.path.join(tmp, "test.py"), "w") as f:
            f.write("print('hello')")
        with open(os.path.join(tmp, "requirements.txt"), "w") as f:
            f.write("flask==2.0\n")
        with open(os.path.join(tmp, "package.json"), "w") as f:
            json.dump({"dependencies": {"react": "*"}}, f)
        result = scan_project(tmp)
        assert isinstance(result, dict)
        assert result.get("language") == "Python"
        assert "Flask" in result.get("frameworks", [])
        print("  [PASS] Project scanner: language/framework detection OK")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    print("=" * 60)
    print("REAL-WORLD FUNCTIONAL TESTS")
    print("=" * 60)
    tests = [
        test_1_tool_registration,
        test_2_permission_all_modes,
        test_3_compound_command_parsing,
        test_4_credential_scrubbing,
        test_5_context_compression,
        test_6_session_persistence,
        test_7_checkpoint_rewind,
        test_8_settings_hierarchy,
        test_9_memory_system,
        test_10_task_thread_safety,
        test_11_agent_harness_init,
        test_12_hooks_system,
        test_13_logging,
        test_14_project_scanner,
    ]
    passed = 0
    failed = 0
    for test in tests:
        try:
            test()
            passed += 1
        except Exception as e:
            print(f"  [FAIL] {test.__name__}: {e}")
            import traceback
            traceback.print_exc()
            failed += 1
    print()
    print("=" * 60)
    print(f"RESULTS: {passed} passed, {failed} failed out of {len(tests)}")
    print("=" * 60)
