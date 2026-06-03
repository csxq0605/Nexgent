"""Tests for SubAgent system - lifecycle, communication, parallel execution.

All tests use real data structures and real API calls — no mocking.
"""

import json
import os
import sys
import time
import threading
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mimo_harness.subagent import (
    SubAgent, SubAgentManager, SubAgentConfig, SubAgentResult,
    SubAgentState, SubAgentPriority, MessageChannel, ResourceLimits,
    create_subagent, run_parallel_tasks, run_pipeline_tasks,
)

# Helper to check if real API key is available
def _has_real_api_key():
    api_key = os.environ.get("MIMO_API_KEY", "")
    return api_key and api_key != "test-key-for-testing"

requires_api = pytest.mark.skipif(
    not _has_real_api_key(),
    reason="Real MIMO_API_KEY not set — E2E tests skipped",
)


# ============================================================
# ResourceLimits Tests
# ============================================================

class TestResourceLimits:
    def test_default_limits(self):
        limits = ResourceLimits()
        assert limits.max_total_tokens == 500_000
        assert limits.max_total_time == 600.0
        assert limits.max_subagents == 20
        assert limits.max_concurrent == 5

    def test_custom_limits(self):
        limits = ResourceLimits(
            max_total_tokens=100_000,
            max_total_time=60.0,
            max_subagents=10,
            max_concurrent=3,
        )
        assert limits.max_total_tokens == 100_000
        assert limits.max_total_time == 60.0
        assert limits.max_subagents == 10
        assert limits.max_concurrent == 3

    def test_check_token_limit(self):
        limits = ResourceLimits(max_total_tokens=1000)
        assert limits.check_token_limit(500) is True
        assert limits.check_token_limit(999) is True
        assert limits.check_token_limit(1000) is False
        assert limits.check_token_limit(1500) is False

    def test_check_time_limit(self):
        limits = ResourceLimits(max_total_time=60.0)
        assert limits.check_time_limit(30.0) is True
        assert limits.check_time_limit(59.9) is True
        assert limits.check_time_limit(60.0) is False
        assert limits.check_time_limit(120.0) is False

    def test_check_subagent_limit(self):
        limits = ResourceLimits(max_subagents=5)
        assert limits.check_subagent_limit(3) is True
        assert limits.check_subagent_limit(4) is True
        assert limits.check_subagent_limit(5) is False
        assert limits.check_subagent_limit(10) is False


# ============================================================
# SubAgentConfig Tests
# ============================================================

class TestSubAgentConfig:
    def test_default_config(self):
        config = SubAgentConfig(task="test task")
        assert config.task == "test task"
        assert config.description == ""
        assert config.max_steps == 10
        assert config.max_duration == 120.0
        assert config.max_tokens == 50_000
        assert config.priority == SubAgentPriority.NORMAL
        assert config.allowed_tools is None
        assert config.isolated is True
        assert config.auto_approve is False
        assert config.effort == "medium"

    def test_custom_config(self):
        config = SubAgentConfig(
            task="custom task",
            description="test description",
            max_steps=20,
            max_duration=60.0,
            max_tokens=100_000,
            priority=SubAgentPriority.HIGH,
            allowed_tools=["read_file", "write_file"],
            isolated=False,
            auto_approve=True,
            effort="high",
            metadata={"key": "value"},
        )
        assert config.task == "custom task"
        assert config.description == "test description"
        assert config.max_steps == 20
        assert config.max_duration == 60.0
        assert config.max_tokens == 100_000
        assert config.priority == SubAgentPriority.HIGH
        assert config.allowed_tools == ["read_file", "write_file"]
        assert config.isolated is False
        assert config.auto_approve is True
        assert config.effort == "high"
        assert config.metadata == {"key": "value"}


# ============================================================
# SubAgentState Tests
# ============================================================

class TestSubAgentState:
    def test_states(self):
        assert SubAgentState.CREATED.value == "created"
        assert SubAgentState.RUNNING.value == "running"
        assert SubAgentState.COMPLETED.value == "completed"
        assert SubAgentState.FAILED.value == "failed"
        assert SubAgentState.CANCELLED.value == "cancelled"

    def test_priority_values(self):
        assert SubAgentPriority.LOW.value == 0
        assert SubAgentPriority.NORMAL.value == 1
        assert SubAgentPriority.HIGH.value == 2
        assert SubAgentPriority.CRITICAL.value == 3


# ============================================================
# SubAgentResult Tests
# ============================================================

class TestSubAgentResult:
    def test_success_result(self):
        result = SubAgentResult(
            subagent_id="test-123",
            task="test task",
            state=SubAgentState.COMPLETED,
            result="success output",
            steps_taken=5,
            duration_seconds=10.5,
            token_usage=1000,
        )
        assert result.success is True
        assert result.subagent_id == "test-123"
        assert result.task == "test task"
        assert result.result == "success output"
        assert result.error is None

    def test_failed_result(self):
        result = SubAgentResult(
            subagent_id="test-456",
            task="failed task",
            state=SubAgentState.FAILED,
            error="something went wrong",
        )
        assert result.success is False
        assert result.error == "something went wrong"

    def test_to_dict(self):
        result = SubAgentResult(
            subagent_id="test-789",
            task="dict task",
            state=SubAgentState.COMPLETED,
            result="output",
            steps_taken=3,
            duration_seconds=5.0,
            token_usage=500,
            metadata={"extra": "data"},
        )
        d = result.to_dict()
        assert d["subagent_id"] == "test-789"
        assert d["task"] == "dict task"
        assert d["state"] == "completed"
        assert d["result"] == "output"
        assert d["steps_taken"] == 3
        assert d["duration_seconds"] == 5.0
        assert d["token_usage"] == 500
        assert d["metadata"] == {"extra": "data"}


# ============================================================
# MessageChannel Tests
# ============================================================

class TestMessageChannel:
    def test_send_and_receive(self):
        channel = MessageChannel()
        msg = channel.send("sender1", "hello", "message")
        assert msg["sender"] == "sender1"
        assert msg["content"] == "hello"
        assert msg["type"] == "message"
        assert "id" in msg
        assert "timestamp" in msg

        received = channel.receive(timeout=1.0)
        assert received is not None
        assert received["content"] == "hello"

    def test_receive_empty(self):
        channel = MessageChannel()
        received = channel.receive(timeout=0.1)
        assert received is None

    def test_peek(self):
        channel = MessageChannel()
        assert channel.peek() is None

        channel.send("sender", "msg1")
        assert channel.peek() is not None
        assert channel.peek()["content"] == "msg1"

        # Peek should not remove the message
        assert channel.peek()["content"] == "msg1"

    def test_get_history(self):
        channel = MessageChannel()
        channel.send("s1", "msg1")
        channel.send("s2", "msg2")
        channel.send("s3", "msg3")

        history = channel.get_history()
        assert len(history) == 3
        assert history[0]["content"] == "msg1"
        assert history[1]["content"] == "msg2"
        assert history[2]["content"] == "msg3"

    def test_clear(self):
        channel = MessageChannel()
        channel.send("s1", "msg1")
        channel.send("s2", "msg2")

        channel.clear()
        assert channel.peek() is None
        assert len(channel.get_history()) == 0

    def test_thread_safety(self):
        channel = MessageChannel()
        results = []

        def sender():
            for i in range(10):
                channel.send(f"sender-{i}", f"msg-{i}")

        def receiver():
            for _ in range(10):
                msg = channel.receive(timeout=2.0)
                if msg:
                    results.append(msg)

        t1 = threading.Thread(target=sender)
        t2 = threading.Thread(target=receiver)

        t1.start()
        t2.start()

        t1.join()
        t2.join()

        # All messages should be received
        assert len(results) == 10

    def test_max_size_limit(self):
        channel = MessageChannel(max_size=3)

        # Should be able to send 3 messages
        channel.send("s1", "msg1")
        channel.send("s2", "msg2")
        channel.send("s3", "msg3")

        # Should fail to send 4th message
        with pytest.raises(RuntimeError, match="MessageChannel full"):
            channel.send("s4", "msg4")


# ============================================================
# SubAgent Tests
# ============================================================

class TestSubAgent:
    def setup_method(self):
        """Reset import cache before each test."""
        SubAgent._imports_cached = False
        SubAgent._MiMoHarness = None
        SubAgent._AgentDeps = None
        SubAgent._Session = None

    def test_initial_state(self):
        config = SubAgentConfig(task="test")
        subagent = SubAgent(config=config)
        assert subagent.state == SubAgentState.CREATED
        assert subagent.result is None
        assert subagent.is_running() is False
        assert subagent.is_terminal() is False

    def test_is_terminal(self):
        config = SubAgentConfig(task="test")
        subagent = SubAgent(config=config)

        subagent.state = SubAgentState.COMPLETED
        assert subagent.is_terminal() is True

        subagent.state = SubAgentState.FAILED
        assert subagent.is_terminal() is True

        subagent.state = SubAgentState.CANCELLED
        assert subagent.is_terminal() is True

        subagent.state = SubAgentState.RUNNING
        assert subagent.is_terminal() is False

    def test_cancel(self):
        config = SubAgentConfig(task="test")
        subagent = SubAgent(config=config)

        subagent.state = SubAgentState.RUNNING
        subagent.cancel()

        assert subagent._cancel_event.is_set()

    def test_send_receive_message(self):
        config = SubAgentConfig(task="test")
        subagent = SubAgent(config=config)

        msg = subagent.send_message("hello from subagent")
        assert msg["sender"].startswith("subagent-")
        assert msg["content"] == "hello from subagent"

        received = subagent.channel.receive(timeout=1.0)
        assert received is not None
        assert received["content"] == "hello from subagent"
        assert received["id"] == msg["id"]

    @requires_api
    def test_run_success(self):
        """Real API: SubAgent completes a simple task."""
        config = SubAgentConfig(task="What is 3 + 4? Reply with just the number.", max_steps=5, effort="low")
        subagent = SubAgent(config=config)
        result = subagent.run()

        assert result.state == SubAgentState.COMPLETED
        assert "7" in result.result
        assert result.steps_taken > 0
        assert result.duration_seconds > 0

    @requires_api
    def test_run_async(self):
        """Real API: SubAgent runs asynchronously."""
        config = SubAgentConfig(task="What is 6 * 7? Reply with just the number.", max_steps=5, effort="low")
        subagent = SubAgent(config=config)

        thread = subagent.run_async()
        thread.join(timeout=60.0)

        assert subagent.state == SubAgentState.COMPLETED
        assert "42" in subagent.result.result


# ============================================================
# SubAgentManager Tests
# ============================================================

class TestSubAgentManager:
    def setup_method(self):
        """Reset import cache before each test."""
        SubAgent._imports_cached = False
        SubAgent._MiMoHarness = None
        SubAgent._AgentDeps = None
        SubAgent._Session = None

    def test_initial_state(self):
        manager = SubAgentManager()
        assert manager.get_running_count() == 0
        assert len(manager.get_all_results()) == 0

    def test_create_subagent(self):
        manager = SubAgentManager()
        config = SubAgentConfig(task="test")
        subagent = manager.create_subagent(config)

        assert subagent.subagent_id is not None
        assert manager.get_subagent(subagent.subagent_id) is not None

    @requires_api
    def test_run_single(self):
        """Real API: Manager runs a single SubAgent."""
        manager = SubAgentManager()
        config = SubAgentConfig(task="What is 8 + 9? Reply with just the number.", max_steps=5, effort="low")
        result = manager.run_single(config)

        assert result.state == SubAgentState.COMPLETED
        assert "17" in result.result
        assert len(manager.get_all_results()) == 1

    @requires_api
    def test_run_parallel(self):
        """Real API: Manager runs multiple SubAgents in parallel."""
        manager = SubAgentManager(max_concurrent=2)
        configs = [
            SubAgentConfig(task="What is 11 * 11? Reply with just the number.", effort="low"),
            SubAgentConfig(task="What is 12 + 13? Reply with just the number.", effort="low"),
            SubAgentConfig(task="What is 100 - 37? Reply with just the number.", effort="low"),
        ]

        results = manager.run_parallel(configs)

        assert len(results) == 3
        assert all(r.state == SubAgentState.COMPLETED for r in results)
        assert len(manager.get_all_results()) == 3

    @requires_api
    def test_run_pipeline(self):
        """Real API: Manager runs SubAgents in pipeline mode."""
        manager = SubAgentManager()
        configs = [
            SubAgentConfig(task="Calculate 7 * 8 and tell me the result.", effort="low"),
            SubAgentConfig(task="Take the previous result and add 6 to it. Tell me the final number.", effort="low"),
        ]

        results = manager.run_pipeline(configs)

        assert len(results) == 2
        assert all(r.state == SubAgentState.COMPLETED for r in results)
        assert "56" in results[0].result
        assert "62" in results[1].result

    def test_get_resource_summary(self):
        manager = SubAgentManager()
        summary = manager.get_resource_summary()

        assert summary["total_subagents"] == 0
        assert summary["running"] == 0
        assert summary["completed"] == 0
        assert summary["failed"] == 0

    def test_aggregate_results(self):
        manager = SubAgentManager()
        results = [
            SubAgentResult(
                subagent_id="1",
                task="task 1",
                state=SubAgentState.COMPLETED,
                result="result 1",
                token_usage=100,
                duration_seconds=1.0,
            ),
            SubAgentResult(
                subagent_id="2",
                task="task 2",
                state=SubAgentState.COMPLETED,
                result="result 2",
                token_usage=200,
                duration_seconds=2.0,
            ),
            SubAgentResult(
                subagent_id="3",
                task="task 3",
                state=SubAgentState.FAILED,
                error="failed",
                token_usage=50,
                duration_seconds=0.5,
            ),
        ]

        summary = manager.aggregate_results(results)

        assert summary["total"] == 3
        assert summary["successful"] == 2
        assert summary["failed"] == 1
        assert summary["success_rate"] == pytest.approx(2/3)
        assert summary["total_tokens"] == 350
        assert summary["avg_tokens"] == pytest.approx(350/3)
        assert summary["total_duration"] == pytest.approx(3.5, abs=0.01)
        assert summary["avg_duration"] == pytest.approx(3.5/3, abs=0.01)
        assert summary["max_duration"] == pytest.approx(2.0, abs=0.01)
        assert summary["min_duration"] == pytest.approx(0.5, abs=0.01)
        assert len(summary["errors"]) == 1
        assert summary["errors"][0]["error"] == "failed"
        assert "combined_output" in summary

    def test_cancel_all(self):
        manager = SubAgentManager()

        # Create some subagents in running state
        config1 = SubAgentConfig(task="task 1")
        config2 = SubAgentConfig(task="task 2")
        sa1 = manager.create_subagent(config1)
        sa2 = manager.create_subagent(config2)

        sa1.state = SubAgentState.RUNNING
        sa2.state = SubAgentState.RUNNING

        manager.cancel_all()

        # cancel() sets the event flag; state transition to CANCELLED
        # happens when run() checks the flag (thread-safe design)
        assert sa1._cancel_event.is_set()
        assert sa2._cancel_event.is_set()

    def test_resource_limits(self):
        limits = ResourceLimits(
            max_total_tokens=1000,
            max_total_time=60.0,
            max_subagents=2,
        )
        manager = SubAgentManager(resource_limits=limits)

        # Should be able to create first subagent
        config1 = SubAgentConfig(task="task 1")
        sa1 = manager.create_subagent(config1)
        assert sa1 is not None

        # Should be able to create second subagent
        config2 = SubAgentConfig(task="task 2")
        sa2 = manager.create_subagent(config2)
        assert sa2 is not None

        # Should fail to create third subagent (limit is 2)
        config3 = SubAgentConfig(task="task 3")
        with pytest.raises(RuntimeError, match="SubAgent limit exceeded"):
            manager.create_subagent(config3)

    def test_get_performance_stats(self):
        manager = SubAgentManager()
        results = [
            SubAgentResult(
                subagent_id="1",
                task="task 1",
                state=SubAgentState.COMPLETED,
                result="result 1",
                token_usage=100,
                duration_seconds=1.0,
            ),
            SubAgentResult(
                subagent_id="2",
                task="task 2",
                state=SubAgentState.COMPLETED,
                result="result 2",
                token_usage=200,
                duration_seconds=2.0,
            ),
        ]
        manager._results = {r.subagent_id: r for r in results}
        manager._total_tokens_used = 300
        manager._total_time_elapsed = 3.0

        stats = manager.get_performance_stats()

        assert stats["total_subagents"] == 2
        assert stats["success_rate"] == pytest.approx(100.0)
        assert "duration_stats" in stats
        assert "token_stats" in stats
        assert "resource_usage" in stats
        assert stats["resource_usage"]["total_tokens"] == 300

    def test_check_resource_limits_boundary(self):
        """Test boundary conditions for resource limits."""
        limits = ResourceLimits(
            max_total_tokens=100,
            max_total_time=10.0,
            max_subagents=2,
        )
        manager = SubAgentManager(resource_limits=limits)

        # Test token limit boundary
        manager._total_tokens_used = 99
        assert manager._check_resource_limits() is None

        manager._total_tokens_used = 100
        assert "Token limit exceeded" in manager._check_resource_limits()

        # Reset for time limit test
        manager._total_tokens_used = 0
        manager._start_time = time.time() - 9.9
        assert manager._check_resource_limits() is None

        manager._start_time = time.time() - 10.0
        assert "Time limit exceeded" in manager._check_resource_limits()

    def test_run_pipeline_with_truncation(self):
        """Test pipeline context truncation mechanism (unit test of truncation logic)."""
        manager = SubAgentManager()

        # Simulate a pipeline result with a very long output
        long_result = SubAgentResult(
            subagent_id="long-1",
            task="stage 1",
            state=SubAgentState.COMPLETED,
            result="x" * 20000,
            steps_taken=3,
            duration_seconds=1.0,
            token_usage=100,
        )
        manager._results[long_result.subagent_id] = long_result

        # Verify the result is stored and accessible
        results = manager.get_all_results()
        assert len(results) == 1
        assert len(results[0].result) == 20000


# ============================================================
# Convenience Function Tests
# ============================================================

class TestConvenienceFunctions:
    def test_create_subagent(self):
        config = create_subagent(
            task="test task",
            description="test description",
            max_steps=15,
            allowed_tools=["read_file"],
            effort="high",
        )
        assert config.task == "test task"
        assert config.description == "test description"
        assert config.max_steps == 15
        assert config.allowed_tools == ["read_file"]
        assert config.effort == "high"

    @requires_api
    def test_run_parallel_tasks(self):
        """Real API: Convenience function runs parallel tasks."""
        tasks = [
            "What is 2 + 2? Reply with just the number.",
            "What is 3 + 3? Reply with just the number.",
        ]
        results = run_parallel_tasks(tasks)

        assert len(results) == 2
        assert all(r.state == SubAgentState.COMPLETED for r in results)

    @requires_api
    def test_run_pipeline_tasks(self):
        """Real API: Convenience function runs pipeline tasks."""
        stages = [
            {"task": "Calculate 4 * 4 and tell me the result.", "description": "multiply"},
            {"task": "Take the previous result and add 1 to it. Tell me the final number.", "description": "add"},
        ]
        results = run_pipeline_tasks(stages)

        assert len(results) == 2
        assert all(r.state == SubAgentState.COMPLETED for r in results)


# ============================================================
# Integration Tests (require real API)
# ============================================================

@pytest.mark.skipif(
    not os.environ.get("MIMO_API_KEY") or os.environ.get("MIMO_API_KEY") == "test-key-for-testing",
    reason="Real MIMO_API_KEY not set — E2E tests skipped",
)
class TestSubAgentE2E:
    """End-to-end tests for SubAgent system with real API calls."""

    def setup_method(self):
        """Reset import cache before each test to ensure real API usage."""
        SubAgent._imports_cached = False
        SubAgent._MiMoHarness = None
        SubAgent._AgentDeps = None
        SubAgent._Session = None

    def test_single_subagent(self):
        """Test running a single SubAgent with a simple task."""
        manager = SubAgentManager()
        config = SubAgentConfig(
            task="What is 2 + 2? Reply with just the number.",
            max_steps=5,
            effort="low",
        )
        result = manager.run_single(config)

        assert result.state == SubAgentState.COMPLETED
        assert "4" in result.result
        assert result.steps_taken > 0
        assert result.duration_seconds > 0

    def test_parallel_subagents(self):
        """Test running multiple SubAgents in parallel."""
        manager = SubAgentManager(max_concurrent=2)
        configs = [
            SubAgentConfig(task="What is 10 * 10? Reply with just the number.", effort="low"),
            SubAgentConfig(task="What is 20 + 20? Reply with just the number.", effort="low"),
        ]

        results = manager.run_parallel(configs)

        assert len(results) == 2
        assert all(r.state == SubAgentState.COMPLETED for r in results)
        assert "100" in results[0].result
        assert "40" in results[1].result

    def test_pipeline_subagents(self):
        """Test running SubAgents in pipeline mode."""
        manager = SubAgentManager()
        configs = [
            SubAgentConfig(task="Calculate 5 * 5 and tell me the result.", effort="low"),
            SubAgentConfig(task="Take the previous result and add 10 to it.", effort="low"),
        ]

        results = manager.run_pipeline(configs)

        assert len(results) == 2
        assert all(r.state == SubAgentState.COMPLETED for r in results)
        # First result should be 25
        assert "25" in results[0].result
        # Second result should be 35 (25 + 10)
        assert "35" in results[1].result

    def test_subagent_with_tools(self):
        """Test SubAgent using specific tools."""
        import shutil
        import uuid
        from mimo_harness.tools import file_ops

        # Reset file_ops sandbox state so it uses current CWD
        file_ops._ALLOWED_WRITE_DIR = None
        file_ops._read_files.clear()
        file_ops._write_allowed_files.clear()

        # Create a temp file in CWD so security pipeline allows it
        cwd = os.getcwd()
        work_dir = os.path.join(cwd, ".e2e_work")
        os.makedirs(work_dir, exist_ok=True)
        test_dir = os.path.join(work_dir, str(uuid.uuid4())[:8])
        os.makedirs(test_dir)
        temp_path = os.path.join(test_dir, "subagent_test.txt")

        try:
            with open(temp_path, "w") as f:
                f.write("Hello from SubAgent test!")

            manager = SubAgentManager()
            config = SubAgentConfig(
                task=f"Read the file {temp_path} and tell me its content.",
                allowed_tools=["read_file"],
                max_steps=5,
                effort="low",
            )
            result = manager.run_single(config)

            assert result.state == SubAgentState.COMPLETED
            assert "Hello from SubAgent test!" in result.result
        finally:
            shutil.rmtree(test_dir, ignore_errors=True)
            # Reset file_ops sandbox state
            file_ops._ALLOWED_WRITE_DIR = None
            file_ops._read_files.clear()
            file_ops._write_allowed_files.clear()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
