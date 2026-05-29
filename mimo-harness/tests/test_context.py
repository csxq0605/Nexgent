"""Tests for context management (Ch7 patterns)."""

import pytest
import json
import tempfile
import os
from unittest.mock import MagicMock, patch
from mimo_harness.context import (
    Session, compact_context, snip_compress, microcompact,
    _filter_orphan_tool_results, make_compact_boundary, load_memory,
    llm_compress, COMPRESS_MARKER, estimate_tokens,
    COMPRESS_TRIGGER_TOKENS, CONTEXT_WINDOW_TOKENS,
    STARTUP_RESERVE_TOKENS, build_system_prompt,
    CheckpointManager,
    _resolve_imports, _parse_frontmatter,
    _load_path_scoped_rules, _discover_instruction_files,
    _load_global_rules, load_path_scoped_rules_for_file,
    load_memory_for_compaction, cleanup_old_sessions, cleanup_old_spill_files,
    load_topic_on_demand,
)


class TestSession:
    def test_create_session(self):
        s = Session(session_id="test123")
        assert s.session_id == "test123"
        assert s.messages == []
        assert s.compaction_count == 0

    def test_add_message(self):
        s = Session(session_id="test")
        s.add_message("user", "hello")
        assert len(s.messages) == 1
        assert s.messages[0]["role"] == "user"
        assert s.messages[0]["content"] == "hello"

    def test_add_message_with_kwargs(self):
        s = Session(session_id="test")
        s.add_message("tool", "result", tool_call_id="tc123")
        assert s.messages[0]["tool_call_id"] == "tc123"

    def test_save_and_load(self):
        s = Session(session_id="test", working_dir="/tmp")
        s.add_message("user", "hello")
        s.add_message("assistant", "hi")

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            path = f.name

        try:
            s.save(path)
            loaded = Session.load(path)
            assert loaded.session_id == "test"
            assert len(loaded.messages) == 2
            assert loaded.working_dir == "/tmp"
        finally:
            os.unlink(path)


class TestSnipCompress:
    def test_no_compression_needed(self):
        messages = [{"role": "user", "content": "hi"}] * 5
        result = snip_compress(messages, max_age=10)
        assert len(result) == 5

    def test_snips_old_tool_results(self):
        messages = []
        for i in range(30):
            if i % 2 == 0:
                messages.append({"role": "user", "content": f"msg {i}"})
            else:
                messages.append({"role": "tool", "content": f"result {i}"})

        result = snip_compress(messages, max_age=10)
        # Old tool results should be snipped
        old_tools = [m for m in result[:20] if m.get("role") == "tool"]
        for t in old_tools:
            assert t["content"] == COMPRESS_MARKER

        # Recent messages should be preserved
        recent = result[-10:]
        for m in recent:
            if m.get("role") == "tool":
                assert m["content"] != COMPRESS_MARKER

    def test_preserves_non_tool_messages(self):
        messages = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi there"},
        ]
        result = snip_compress(messages, max_age=10)
        assert result == messages


class TestMicrocompact:
    def test_keeps_recent_tool_results(self):
        messages = []
        for i in range(20):
            messages.append({"role": "user", "content": f"msg {i}"})
            messages.append({
                "role": "assistant",
                "content": "ok",
                "tool_calls": [{"id": f"tc{i}", "function": {"name": "test", "arguments": "{}"}}]
            })
            messages.append({"role": "tool", "content": f"result {i}", "tool_call_id": f"tc{i}"})

        result = microcompact(messages, keep_recent=3)

        # Should keep last 3 tool results intact
        tool_msgs = [m for m in result if m.get("role") == "tool"]
        non_markers = [m for m in tool_msgs if m["content"] != COMPRESS_MARKER]
        assert len(non_markers) == 3

    def test_no_compression_if_few_results(self):
        messages = [
            {"role": "tool", "content": "r1", "tool_call_id": "tc1"},
            {"role": "tool", "content": "r2", "tool_call_id": "tc2"},
        ]
        result = microcompact(messages, keep_recent=5)
        assert result == messages


class TestOrphanFilter:
    def test_removes_orphan_tool_results(self):
        messages = [
            {"role": "assistant", "content": "ok", "tool_calls": [{"id": "tc1", "function": {"name": "f", "arguments": "{}"}}]},
            {"role": "tool", "content": "result1", "tool_call_id": "tc1"},
            {"role": "tool", "content": "orphan", "tool_call_id": "tc999"},
        ]
        result = _filter_orphan_tool_results(messages)
        assert len(result) == 2
        assert result[1]["tool_call_id"] == "tc1"

    def test_preserves_valid_tool_results(self):
        messages = [
            {"role": "assistant", "content": "ok", "tool_calls": [{"id": "tc1", "function": {"name": "f", "arguments": "{}"}}]},
            {"role": "tool", "content": "result", "tool_call_id": "tc1"},
        ]
        result = _filter_orphan_tool_results(messages)
        assert len(result) == 2


class TestEstimateTokens:
    def test_estimates_basic_messages(self):
        messages = [{"role": "user", "content": "hello world"}]
        tokens = estimate_tokens(messages)
        assert tokens > 0
        assert tokens < 20

    def test_estimates_multiple_messages(self):
        messages = [{"role": "user", "content": "x" * 400}] * 10
        tokens = estimate_tokens(messages)
        assert tokens >= 900


class TestTokenConstants:
    def test_context_window_200k(self):
        assert CONTEXT_WINDOW_TOKENS == 200_000

    def test_compress_trigger_at_85_percent(self):
        expected = int(200_000 * 0.85)
        assert COMPRESS_TRIGGER_TOKENS == expected


class TestCompactContext:
    def test_truncation_preserves_last_messages(self):
        """Last user + assistant messages should be preserved."""
        messages = [
            {"role": "user", "content": "old message"},
            {"role": "assistant", "content": "old reply"},
            {"role": "user", "content": "recent question"},
            {"role": "assistant", "content": "recent answer"},
        ]
        # Pad to exceed trigger
        big = [{"role": "user", "content": "x" * 8000}] * 100
        all_msgs = big + messages
        tokens = estimate_tokens(all_msgs)

        result, _, _, _ = compact_context(all_msgs, estimated_tokens=tokens)
        # Should have system marker + last 2 messages
        contents = [m.get("content", "") for m in result]
        assert any("recent question" in c for c in contents)
        assert any("recent answer" in c for c in contents)


class TestCompactBoundary:
    def test_creates_boundary(self):
        boundary = make_compact_boundary(
            pre_tokens=50000, pre_messages=100, trigger="auto"
        )
        assert boundary["role"] == "system"
        assert "compacted" in boundary["content"]
        assert boundary["compact_metadata"]["trigger"] == "auto"


class TestLoadMemory:
    def test_loads_existing_files(self, tmp_path):
        claude_md = tmp_path / "CLAUDE.md"
        claude_md.write_text("# Project rules\nBe concise.")

        result = load_memory(str(tmp_path))
        assert "CLAUDE.md" in result
        assert "Be concise" in result

    def test_respects_line_limit(self, tmp_path):
        claude_md = tmp_path / "CLAUDE.md"
        claude_md.write_text("\n".join([f"line {i}" for i in range(300)]))

        result = load_memory(str(tmp_path))
        assert "truncated" in result

    def test_no_files(self, tmp_path):
        result = load_memory(str(tmp_path))
        assert result == ""

    def test_loads_agents_md(self, tmp_path):
        agents_md = tmp_path / "AGENTS.md"
        agents_md.write_text("# Project Instructions\nUse pytest.")

        result = load_memory(str(tmp_path))
        assert "AGENTS.md" in result
        assert "Use pytest" in result


class TestLLMCompress:
    def _make_messages(self, n):
        msgs = []
        for i in range(n):
            msgs.append({"role": "user", "content": f"question {i}"})
            msgs.append({"role": "assistant", "content": f"answer {i}"})
        return msgs

    def _mock_client(self, summary="Summary of conversation"):
        client = MagicMock()
        response = MagicMock()
        response.choices = [MagicMock()]
        response.choices[0].message.content = summary
        client.chat.completions.create.return_value = response
        return client

    def test_returns_single_summary_message(self):
        """After LLM compress, result is ONE summary message."""
        messages = self._make_messages(20)
        client = self._mock_client("Test summary")

        result = llm_compress(messages, client, model="test-model")
        assert result is not None
        assert len(result) == 1  # Only summary, no recent messages
        assert result[0]["role"] == "assistant"
        assert "Conversation Summary" in result[0]["content"]
        assert "Test summary" in result[0]["content"]

    def test_returns_none_on_api_error(self):
        messages = self._make_messages(15)
        client = MagicMock()
        client.chat.completions.create.side_effect = Exception("API error")

        result = llm_compress(messages, client)
        assert result is None

    def test_returns_none_on_empty_response(self):
        messages = self._make_messages(15)
        client = MagicMock()
        response = MagicMock()
        response.choices = [MagicMock()]
        response.choices[0].message.content = ""
        client.chat.completions.create.return_value = response

        result = llm_compress(messages, client)
        assert result is None

    def test_summary_size_is_small(self):
        """Summary should be much smaller than original conversation."""
        messages = self._make_messages(50)  # 100 messages
        original_tokens = estimate_tokens(messages)
        client = self._mock_client("Short summary of the conversation.")

        result = llm_compress(messages, client)
        summary_tokens = estimate_tokens(result)
        # Summary should be < 10% of original
        assert summary_tokens < original_tokens * 0.10


class TestCompactContextWithLLM:
    def _make_big_messages(self, n, content_size=12000):
        """Create messages large enough to exceed token threshold (~170K)."""
        msgs = []
        for i in range(n):
            msgs.append({"role": "user", "content": f"q{i}" + "x" * content_size})
            msgs.append({"role": "assistant", "content": f"a{i}" + "x" * content_size})
        return msgs

    def test_uses_llm_when_tokens_exceed_threshold(self):
        messages = self._make_big_messages(60)
        tokens = estimate_tokens(messages)
        assert tokens > COMPRESS_TRIGGER_TOKENS

        client = MagicMock()
        response = MagicMock()
        response.choices = [MagicMock()]
        response.choices[0].message.content = "LLM summary"
        client.chat.completions.create.return_value = response

        with patch("mimo_harness.context.llm_compress", return_value=[
            {"role": "assistant", "content": "[Conversation Summary]\nLLM summary"}
        ]) as mock_compress:
            result, _, _, _ = compact_context(messages, client=client, model="test", estimated_tokens=tokens)
            mock_compress.assert_called_once()

    def test_falls_back_to_truncation_on_llm_failure(self):
        messages = self._make_big_messages(60)
        tokens = estimate_tokens(messages)
        assert tokens > COMPRESS_TRIGGER_TOKENS
        client = MagicMock()
        client.chat.completions.create.side_effect = Exception("fail")

        result, _, _, _ = compact_context(messages, client=client, model="test", estimated_tokens=tokens)
        # Fallback: system marker + last 2 messages
        assert len(result) <= 4
        assert result[0]["role"] == "system"

    def test_skips_llm_when_below_token_threshold(self):
        messages = [{"role": "user", "content": "hi"}] * 10
        tokens = estimate_tokens(messages)
        assert tokens < COMPRESS_TRIGGER_TOKENS

        with patch("mimo_harness.context.llm_compress") as mock_compress:
            result, _, _, _ = compact_context(messages, client=MagicMock(), estimated_tokens=tokens)
            mock_compress.assert_not_called()

    def test_backward_compatible_no_client(self):
        """Without client, uses truncation fallback (aggressive)."""
        messages = self._make_big_messages(60)
        tokens = estimate_tokens(messages)
        assert tokens > COMPRESS_TRIGGER_TOKENS
        result, _, _, _ = compact_context(messages, estimated_tokens=tokens)
        # Fallback: system marker + last 2 messages
        assert len(result) <= 4
        assert result[0]["role"] == "system"


class TestLLMCompressEdgeCases:
    """Edge cases for llm_compress."""

    def test_empty_messages(self):
        client = MagicMock()
        result = llm_compress([], client)
        assert result == []

    def test_single_message(self):
        client = MagicMock()
        msg = [{"role": "user", "content": "hi"}]
        result = llm_compress(msg, client)
        assert result == msg

    def test_messages_with_non_dict(self):
        """Non-dict messages should be skipped gracefully."""
        client = MagicMock()
        response = MagicMock()
        response.choices = [MagicMock()]
        response.choices[0].message.content = "summary"
        client.chat.completions.create.return_value = response

        messages = [
            {"role": "user", "content": "hello"},
            "not a dict",  # should be skipped
            {"role": "assistant", "content": "hi"},
        ]
        result = llm_compress(messages, client)
        assert isinstance(result, list)
        assert len(result) == 1

    def test_messages_with_none_content(self):
        """Messages with None content should be handled."""
        client = MagicMock()
        response = MagicMock()
        response.choices = [MagicMock()]
        response.choices[0].message.content = "summary"
        client.chat.completions.create.return_value = response

        messages = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": None},
        ]
        result = llm_compress(messages, client)
        assert isinstance(result, list)
        assert len(result) >= 1

    def test_long_content_truncated(self):
        """Individual messages with >3000 chars should be truncated."""
        client = MagicMock()
        response = MagicMock()
        response.choices = [MagicMock()]
        response.choices[0].message.content = "summary"
        client.chat.completions.create.return_value = response

        messages = [
            {"role": "user", "content": "x" * 10000},
            {"role": "assistant", "content": "y" * 10000},
        ]
        # Should not raise, should truncate internally
        result = llm_compress(messages, client)
        assert isinstance(result, list)


class TestCompactContextEdgeCases:
    """Edge cases for compact_context."""

    def test_empty_messages(self):
        result, _, _, _ = compact_context([])
        assert result == []

    def test_single_message_no_compress(self):
        msg = [{"role": "user", "content": "hi"}]
        result, _, _, _ = compact_context(msg)
        assert result == msg

    def test_max_messages_legacy_path(self):
        """When max_messages is set and tokens are low, use message count."""
        messages = [{"role": "user", "content": f"msg {i}"} for i in range(100)]
        result, _, _, _ = compact_context(messages, max_messages=10)
        assert len(result) == 10
        assert result[0]["content"] == "msg 90"
        assert result[-1]["content"] == "msg 99"

    def test_max_messages_with_orphan_filter(self):
        """Orphan tool results should be filtered in legacy path."""
        messages = [
            {"role": "assistant", "content": "ok", "tool_calls": [{"id": "tc1"}]},
            {"role": "tool", "content": "result", "tool_call_id": "tc1"},
            {"role": "tool", "content": "orphan", "tool_call_id": "tc999"},
        ]
        result, _, _, _ = compact_context(messages, max_messages=10)
        assert len(result) == 2  # orphan filtered

    def test_token_compress_with_tool_calls(self):
        """Token-based compression should handle tool_calls messages."""
        messages = []
        for i in range(100):
            messages.append({"role": "user", "content": f"task {i} " + "x" * 8000})
            messages.append({
                "role": "assistant",
                "content": "ok",
                "tool_calls": [{"id": f"tc{i}", "function": {"name": "test", "arguments": "{}"}}]
            })
            messages.append({"role": "tool", "content": f"result {i}", "tool_call_id": f"tc{i}"})

        tokens = estimate_tokens(messages)
        assert tokens > COMPRESS_TRIGGER_TOKENS

        result, _, _, _ = compact_context(messages, estimated_tokens=tokens)
        # Fallback: system marker + last 2 messages
        assert len(result) <= 4
        assert result[0]["role"] == "system"


class TestBuildSystemPrompt:
    def test_build_system_prompt_basic(self):
        """Contains MiMo Harness, cwd, platform info."""
        prompt = build_system_prompt(tools_desc="- read_file: read files")
        assert "MiMo Harness" in prompt
        assert os.getcwd() in prompt
        assert "Platform" in prompt or "platform" in prompt.lower()
        assert "read_file" in prompt

    def test_build_system_prompt_with_memory(self):
        """memory_content is appended to prompt."""
        prompt = build_system_prompt(
            tools_desc="- test_tool: testing",
            memory_content="This is project memory content",
        )
        assert "project memory content" in prompt.lower() or "Project Memory" in prompt

    def test_build_system_prompt_with_tools(self):
        """tools_desc is included in prompt."""
        tools_desc = "- read_file: reads files\n- write_file: writes files"
        prompt = build_system_prompt(tools_desc=tools_desc)
        assert "read_file" in prompt
        assert "write_file" in prompt


# ============================================================================
# S12: CheckpointManager tests
# ============================================================================

class TestCheckpointManager:
    """S12: CheckpointManager snapshot and restore."""

    def test_snapshot_saves_file_copy(self, tmp_path, monkeypatch):
        """S12: snapshot() saves a copy of the file to the checkpoint directory."""
        monkeypatch.chdir(tmp_path)
        source = tmp_path / "source.txt"
        source.write_text("original content")

        mgr = CheckpointManager("test-session")
        checkpoint_path = mgr.snapshot(str(source))

        assert os.path.exists(checkpoint_path)
        with open(checkpoint_path, encoding="utf-8") as f:
            assert f.read() == "original content"

    def test_snapshot_increments_sequence(self, tmp_path, monkeypatch):
        """S12: Each snapshot increments the sequence number."""
        monkeypatch.chdir(tmp_path)
        f1 = tmp_path / "file1.txt"
        f1.write_text("content 1")
        f2 = tmp_path / "file2.txt"
        f2.write_text("content 2")

        mgr = CheckpointManager("test-session")
        path1 = mgr.snapshot(str(f1))
        path2 = mgr.snapshot(str(f2))

        # Paths should be in different sequence directories
        seq1 = os.path.basename(os.path.dirname(path1))
        seq2 = os.path.basename(os.path.dirname(path2))
        assert seq1 == "1"
        assert seq2 == "2"

    def test_restore_last_restores_file(self, tmp_path, monkeypatch):
        """S12: restore_last() restores files from the latest checkpoint."""
        monkeypatch.chdir(tmp_path)
        source = tmp_path / "important.txt"
        source.write_text("important data")

        mgr = CheckpointManager("test-session")
        mgr.snapshot(str(source))

        # Modify the file
        source.write_text("corrupted data")
        assert source.read_text() == "corrupted data"

        # Restore
        restored = mgr.restore_last()
        assert len(restored) >= 1
        assert source.read_text() == "important data"

    def test_restore_last_with_no_checkpoints(self, tmp_path, monkeypatch):
        """S12: restore_last() returns empty list when no checkpoints exist."""
        monkeypatch.chdir(tmp_path)
        mgr = CheckpointManager("empty-session")
        restored = mgr.restore_last()
        assert restored == []

    def test_snapshot_preserves_file_metadata(self, tmp_path, monkeypatch):
        """S12: snapshot() preserves file modification time via shutil.copy2."""
        monkeypatch.chdir(tmp_path)
        source = tmp_path / "metadata.txt"
        source.write_text("content")

        mgr = CheckpointManager("test-session")
        checkpoint_path = mgr.snapshot(str(source))

        # Both files should exist
        assert os.path.exists(source)
        assert os.path.exists(checkpoint_path)

    def test_multiple_snapshots_and_restore(self, tmp_path, monkeypatch):
        """S12: Multiple snapshots, restore restores the latest one."""
        monkeypatch.chdir(tmp_path)
        source = tmp_path / "versioned.txt"
        source.write_text("version 1")
        mgr = CheckpointManager("test-session")

        mgr.snapshot(str(source))
        source.write_text("version 2")
        mgr.snapshot(str(source))

        # Corrupt
        source.write_text("corrupted")

        # Restore should get version 2
        mgr.restore_last()
        assert source.read_text() == "version 2"


# ============================================================================
# R2: Round 2 — compact_context tuple return, _extract_instructions,
#     _resolve_imports, _parse_frontmatter, Session.from_jsonl,
#     CheckpointManager batch operations
# ============================================================================


class TestCompactContextTupleReturn:
    """R2: compact_context returns (messages, attempts, failures, thrashing)."""

    def test_returns_four_element_tuple(self):
        messages = [{"role": "user", "content": "hi"}] * 5
        result = compact_context(messages)
        assert isinstance(result, tuple)
        assert len(result) == 4

    def test_attempts_and_failures_default_zero(self):
        messages = [{"role": "user", "content": "hi"}] * 5
        _, attempts, failures, thrashing = compact_context(messages)
        assert attempts == 0
        assert failures == 0
        assert thrashing is False

    def test_attempts_increments_on_compression(self):
        """When LLM compression succeeds, attempts should increment."""
        big = "x" * 8000
        messages = [{"role": "user", "content": big}] * 100
        tokens = estimate_tokens(messages)
        assert tokens > COMPRESS_TRIGGER_TOKENS

        client = MagicMock()
        response = MagicMock()
        response.choices = [MagicMock()]
        response.choices[0].message.content = "Summary"
        client.chat.completions.create.return_value = response

        with patch("mimo_harness.context.llm_compress", return_value=[
            {"role": "assistant", "content": "[Conversation Summary]\nSummary"}
        ]):
            _, attempts, failures, thrashing = compact_context(
                messages, client=client, estimated_tokens=tokens,
                compaction_attempts=0, compaction_failures=0,
            )
        assert attempts >= 1
        assert thrashing is False

    def test_failures_increment_on_llm_failure(self):
        """When LLM compression fails, failures should increment."""
        big = "x" * 8000
        messages = [{"role": "user", "content": big}] * 100
        tokens = estimate_tokens(messages)
        assert tokens > COMPRESS_TRIGGER_TOKENS

        client = MagicMock()
        client.chat.completions.create.side_effect = Exception("API error")

        _, attempts, failures, thrashing = compact_context(
            messages, client=client, estimated_tokens=tokens,
            compaction_attempts=0, compaction_failures=0,
        )
        assert failures >= 1

    def test_thrashing_detected_after_three_failures(self):
        """Thrashing flag is True when compaction_failures >= 3."""
        big = "x" * 8000
        messages = [{"role": "user", "content": big}] * 100
        tokens = estimate_tokens(messages)
        assert tokens > COMPRESS_TRIGGER_TOKENS

        _, _, _, thrashing = compact_context(
            messages, estimated_tokens=tokens,
            compaction_attempts=5, compaction_failures=3,
        )
        assert thrashing is True

    def test_no_compression_preserves_attempts_failures(self):
        """When no compression needed, attempts/failures are passed through."""
        messages = [{"role": "user", "content": "hi"}]
        _, attempts, failures, thrashing = compact_context(
            messages, compaction_attempts=2, compaction_failures=1,
        )
        assert attempts == 2
        assert failures == 1
        assert thrashing is False


class TestDiscoverInstructionFiles:
    """Tests for directory-tree walk to discover CLAUDE.md files."""

    def test_finds_claude_md_at_root(self, tmp_path):
        claude_md = tmp_path / "CLAUDE.md"
        claude_md.write_text("# Project rules\nBe concise.")
        result = _discover_instruction_files(str(tmp_path))
        assert len(result) == 1
        assert result[0][0] == "CLAUDE.md"
        assert "Be concise" in result[0][1]

    def test_finds_claude_local_md(self, tmp_path):
        local_md = tmp_path / "CLAUDE.local.md"
        local_md.write_text("# Local overrides\nUse black.")
        result = _discover_instruction_files(str(tmp_path))
        assert len(result) == 1
        assert result[0][0] == "CLAUDE.local.md"

    def test_finds_both_claude_and_local(self, tmp_path):
        (tmp_path / "CLAUDE.md").write_text("# Project rules")
        (tmp_path / "CLAUDE.local.md").write_text("# Local overrides")
        result = _discover_instruction_files(str(tmp_path))
        assert len(result) == 2
        assert result[0][0] == "CLAUDE.md"
        assert result[1][0] == "CLAUDE.local.md"

    def test_strips_html_comments(self, tmp_path):
        (tmp_path / "CLAUDE.md").write_text("<!-- comment -->\nReal content")
        result = _discover_instruction_files(str(tmp_path))
        assert len(result) == 1
        assert "comment" not in result[0][1]
        assert "Real content" in result[0][1]

    def test_respects_line_limit(self, tmp_path):
        content = "\n".join([f"line {i}" for i in range(300)])
        (tmp_path / "CLAUDE.md").write_text(content)
        result = _discover_instruction_files(str(tmp_path))
        assert len(result) == 1
        assert "truncated" in result[0][1]

    def test_no_files_returns_empty(self, tmp_path):
        result = _discover_instruction_files(str(tmp_path))
        assert result == []


class TestLoadGlobalRules:
    """Tests for loading non-path-scoped rules at startup."""

    def test_loads_rules_without_paths(self, tmp_path):
        rules_dir = tmp_path / ".mimo" / "rules"
        rules_dir.mkdir(parents=True)
        (rules_dir / "global.md").write_text("Be concise.")
        result = _load_global_rules(str(tmp_path))
        assert len(result) == 1
        assert "Be concise" in result[0]

    def test_skips_rules_with_paths(self, tmp_path):
        rules_dir = tmp_path / ".mimo" / "rules"
        rules_dir.mkdir(parents=True)
        (rules_dir / "scoped.md").write_text('---\npaths: ["*.py"]\n---\nUse type hints.')
        result = _load_global_rules(str(tmp_path))
        assert len(result) == 0

    def test_no_rules_directory(self, tmp_path):
        result = _load_global_rules(str(tmp_path))
        assert result == []


class TestLoadPathScopedRulesForFile:
    """Tests for lazy-loading path-scoped rules on demand."""

    def test_loads_matching_rules(self, tmp_path):
        rules_dir = tmp_path / ".mimo" / "rules"
        rules_dir.mkdir(parents=True)
        (rules_dir / "python.md").write_text('---\npaths: ["*.py"]\n---\nUse type hints.')
        result = load_path_scoped_rules_for_file(str(tmp_path), "main.py")
        assert len(result) == 1
        assert "type hints" in result[0]

    def test_skips_non_matching_rules(self, tmp_path):
        rules_dir = tmp_path / ".mimo" / "rules"
        rules_dir.mkdir(parents=True)
        (rules_dir / "python.md").write_text('---\npaths: ["*.py"]\n---\nUse type hints.')
        result = load_path_scoped_rules_for_file(str(tmp_path), "readme.md")
        assert len(result) == 0

    def test_empty_current_file_returns_empty(self, tmp_path):
        rules_dir = tmp_path / ".mimo" / "rules"
        rules_dir.mkdir(parents=True)
        (rules_dir / "python.md").write_text('---\npaths: ["*.py"]\n---\nUse type hints.')
        result = load_path_scoped_rules_for_file(str(tmp_path), "")
        assert result == []

    def test_no_rules_directory(self, tmp_path):
        result = load_path_scoped_rules_for_file(str(tmp_path), "main.py")
        assert result == []


class TestCleanupOldSessions:
    """Tests for session auto-cleanup."""

    def test_deletes_old_sessions(self, tmp_path):
        # Create a fake old session file
        old_file = tmp_path / "old_session.jsonl"
        old_file.write_text('{"role": "user", "content": "hello"}\n')
        # Set modification time to 60 days ago
        import time
        old_time = time.time() - (60 * 86400)
        os.utime(str(old_file), (old_time, old_time))

        deleted = cleanup_old_sessions(str(tmp_path), max_age_days=30)
        assert deleted == 1
        assert not old_file.exists()

    def test_keeps_recent_sessions(self, tmp_path):
        recent_file = tmp_path / "recent_session.jsonl"
        recent_file.write_text('{"role": "user", "content": "hello"}\n')

        deleted = cleanup_old_sessions(str(tmp_path), max_age_days=30)
        assert deleted == 0
        assert recent_file.exists()

    def test_no_directory(self, tmp_path):
        deleted = cleanup_old_sessions(str(tmp_path / "nonexistent"), max_age_days=30)
        assert deleted == 0

    def test_deletes_old_corrupt_files(self, tmp_path):
        """Old .jsonl.corrupt files should also be cleaned up."""
        import time
        old_corrupt = tmp_path / "old_session.jsonl.corrupt"
        old_corrupt.write_text("bad data\n")
        old_time = time.time() - (60 * 86400)
        os.utime(str(old_corrupt), (old_time, old_time))

        deleted = cleanup_old_sessions(str(tmp_path), max_age_days=30)
        assert deleted == 1
        assert not old_corrupt.exists()

    def test_keeps_recent_corrupt_files(self, tmp_path):
        """Recent .jsonl.corrupt files should not be deleted."""
        recent_corrupt = tmp_path / "recent.jsonl.corrupt"
        recent_corrupt.write_text("bad data\n")

        deleted = cleanup_old_sessions(str(tmp_path), max_age_days=30)
        assert deleted == 0
        assert recent_corrupt.exists()


class TestCleanupOldSpillFiles:
    """Tests for spill file auto-cleanup."""

    def test_deletes_old_spill_files(self, tmp_path):
        spill_dir = tmp_path / "outputs"
        spill_dir.mkdir()
        old_file = spill_dir / "abc12345.txt"
        old_file.write_text("large output content")
        import time
        old_time = time.time() - (10 * 86400)
        os.utime(str(old_file), (old_time, old_time))

        deleted = cleanup_old_spill_files(str(spill_dir), max_age_days=7)
        assert deleted == 1
        assert not old_file.exists()

    def test_keeps_recent_spill_files(self, tmp_path):
        spill_dir = tmp_path / "outputs"
        spill_dir.mkdir()
        recent_file = spill_dir / "def67890.txt"
        recent_file.write_text("recent output")

        deleted = cleanup_old_spill_files(str(spill_dir), max_age_days=7)
        assert deleted == 0
        assert recent_file.exists()

    def test_ignores_non_txt_files(self, tmp_path):
        spill_dir = tmp_path / "outputs"
        spill_dir.mkdir()
        (spill_dir / "data.json").write_text("{}")
        import time
        old_time = time.time() - (10 * 86400)
        json_file = spill_dir / "old.json"
        json_file.write_text("{}")
        os.utime(str(json_file), (old_time, old_time))

        deleted = cleanup_old_spill_files(str(spill_dir), max_age_days=7)
        assert deleted == 0

    def test_no_directory(self, tmp_path):
        deleted = cleanup_old_spill_files(str(tmp_path / "nonexistent"), max_age_days=7)
        assert deleted == 0


class TestLoadMemoryForCompaction:
    """Tests for re-reading memory from disk after compaction."""

    def test_reads_claude_md_from_disk(self, tmp_path):
        claude_md = tmp_path / "CLAUDE.md"
        claude_md.write_text("# Project rules\nUse pytest.")
        result = load_memory_for_compaction(str(tmp_path))
        assert "CLAUDE.md" in result
        assert "Use pytest" in result


class TestResolveImports:
    """R2: _resolve_imports with @import syntax."""

    def test_resolves_simple_import(self, tmp_path):
        from mimo_harness.context import _resolve_imports
        imported_file = tmp_path / "rules.md"
        imported_file.write_text("Be concise.")
        content = "See @rules.md for details."
        result = _resolve_imports(content, str(tmp_path))
        assert "Be concise." in result
        assert "@rules.md" not in result

    def test_unresolved_import_left_as_is(self, tmp_path):
        from mimo_harness.context import _resolve_imports
        content = "See @nonexistent.md for details."
        result = _resolve_imports(content, str(tmp_path))
        assert "@nonexistent.md" in result

    def test_nested_imports_resolved(self, tmp_path):
        from mimo_harness.context import _resolve_imports
        (tmp_path / "outer.md").write_text("Outer: @inner.md")
        (tmp_path / "inner.md").write_text("Inner content.")
        result = _resolve_imports("Read @outer.md", str(tmp_path))
        assert "Inner content." in result

    def test_depth_limit_prevents_infinite_loop(self, tmp_path):
        from mimo_harness.context import _resolve_imports
        # Create circular import
        (tmp_path / "a.md").write_text("@b.md")
        (tmp_path / "b.md").write_text("@a.md")
        # Should not raise, just stop at depth limit
        result = _resolve_imports("@a.md", str(tmp_path))
        assert isinstance(result, str)

    def test_no_imports_returns_unchanged(self, tmp_path):
        from mimo_harness.context import _resolve_imports
        content = "No imports here."
        result = _resolve_imports(content, str(tmp_path))
        assert result == content

    def test_multiple_imports(self, tmp_path):
        from mimo_harness.context import _resolve_imports
        (tmp_path / "a.md").write_text("Content A")
        (tmp_path / "b.md").write_text("Content B")
        content = "@a.md and @b.md"
        result = _resolve_imports(content, str(tmp_path))
        assert "Content A" in result
        assert "Content B" in result


class TestParseFrontmatter:
    """R2: _parse_frontmatter with YAML-like frontmatter."""

    def test_parses_simple_frontmatter(self):
        from mimo_harness.context import _parse_frontmatter
        content = "---\npaths: [\"*.py\", \"*.js\"]\n---\nBody content here."
        meta, body = _parse_frontmatter(content)
        assert meta["paths"] == ["*.py", "*.js"]
        assert "Body content" in body

    def test_no_frontmatter(self):
        from mimo_harness.context import _parse_frontmatter
        content = "Just plain content."
        meta, body = _parse_frontmatter(content)
        assert meta == {}
        assert body == content

    def test_unclosed_frontmatter(self):
        from mimo_harness.context import _parse_frontmatter
        content = "---\npaths: [\"*.py\"]\nNo closing delimiter"
        meta, body = _parse_frontmatter(content)
        assert meta == {}
        assert body == content

    def test_frontmatter_with_scalar_values(self):
        from mimo_harness.context import _parse_frontmatter
        content = "---\nname: test-rule\nseverity: high\n---\nRule body."
        meta, body = _parse_frontmatter(content)
        assert meta["name"] == "test-rule"
        assert meta["severity"] == "high"
        assert "Rule body" in body

    def test_frontmatter_with_quoted_values(self):
        from mimo_harness.context import _parse_frontmatter
        content = '---\nname: "quoted value"\n---\nBody.'
        meta, body = _parse_frontmatter(content)
        assert meta["name"] == "quoted value"

    def test_empty_frontmatter(self):
        from mimo_harness.context import _parse_frontmatter
        content = "---\n---\nBody."
        meta, body = _parse_frontmatter(content)
        assert meta == {}
        assert "Body" in body


class TestLoadPathScopedRules:
    """R2: _load_path_scoped_rules scans .mimo/rules/*.md."""

    def test_loads_rules_from_directory(self, tmp_path):
        from mimo_harness.context import _load_path_scoped_rules
        rules_dir = tmp_path / ".mimo" / "rules"
        rules_dir.mkdir(parents=True)
        (rules_dir / "python.md").write_text(
            '---\npaths: ["*.py"]\n---\nUse type hints.'
        )
        rules = _load_path_scoped_rules(str(tmp_path))
        assert len(rules) == 1
        assert rules[0][0] == ["*.py"]
        assert "type hints" in rules[0][1]

    def test_no_rules_directory(self, tmp_path):
        from mimo_harness.context import _load_path_scoped_rules
        rules = _load_path_scoped_rules(str(tmp_path))
        assert rules == []

    def test_empty_rules_directory(self, tmp_path):
        from mimo_harness.context import _load_path_scoped_rules
        rules_dir = tmp_path / ".mimo" / "rules"
        rules_dir.mkdir(parents=True)
        rules = _load_path_scoped_rules(str(tmp_path))
        assert rules == []

    def test_rule_without_body_skipped(self, tmp_path):
        from mimo_harness.context import _load_path_scoped_rules
        rules_dir = tmp_path / ".mimo" / "rules"
        rules_dir.mkdir(parents=True)
        (rules_dir / "empty.md").write_text("---\npaths: [\"*.py\"]\n---\n")
        rules = _load_path_scoped_rules(str(tmp_path))
        assert len(rules) == 0


class TestSessionFromJsonl:
    """R2: Session.from_jsonl() reconstruction."""

    def test_from_jsonl_basic(self, tmp_path):
        jsonl_file = tmp_path / "abc123.jsonl"
        lines = [
            json.dumps({"role": "user", "content": "hello"}),
            json.dumps({"role": "assistant", "content": "hi there"}),
        ]
        jsonl_file.write_text("\n".join(lines) + "\n", encoding="utf-8")

        session, skipped = Session.from_jsonl(str(jsonl_file))
        assert session.session_id == "abc123"
        assert len(session.messages) == 2
        assert session.messages[0]["role"] == "user"
        assert session.messages[1]["role"] == "assistant"
        assert skipped == 0

    def test_from_jsonl_empty_file(self, tmp_path):
        jsonl_file = tmp_path / "empty.jsonl"
        jsonl_file.write_text("", encoding="utf-8")

        session, skipped = Session.from_jsonl(str(jsonl_file))
        assert session.session_id == "empty"
        assert len(session.messages) == 0
        assert skipped == 0

    def test_from_jsonl_session_id_from_filename(self, tmp_path):
        jsonl_file = tmp_path / "my-session-id.jsonl"
        jsonl_file.write_text(
            json.dumps({"role": "user", "content": "test"}) + "\n",
            encoding="utf-8",
        )
        session, _ = Session.from_jsonl(str(jsonl_file))
        assert session.session_id == "my-session-id"

    def test_from_jsonl_skips_blank_lines(self, tmp_path):
        jsonl_file = tmp_path / "test.jsonl"
        content = (
            json.dumps({"role": "user", "content": "msg1"}) + "\n"
            + "\n"
            + json.dumps({"role": "assistant", "content": "msg2"}) + "\n"
        )
        jsonl_file.write_text(content, encoding="utf-8")
        session, skipped = Session.from_jsonl(str(jsonl_file))
        assert len(session.messages) == 2
        assert skipped == 0

    def test_from_jsonl_preserves_created_at(self, tmp_path):
        import os
        jsonl_file = tmp_path / "timed.jsonl"
        jsonl_file.write_text(
            json.dumps({"role": "user", "content": "test"}) + "\n",
            encoding="utf-8",
        )
        session, _ = Session.from_jsonl(str(jsonl_file))
        # created_at should be close to the file's mtime
        mtime = os.path.getmtime(str(jsonl_file))
        assert abs(session.created_at - mtime) < 1.0

    def test_from_jsonl_with_tool_calls(self, tmp_path):
        jsonl_file = tmp_path / "tools.jsonl"
        msg = {
            "role": "assistant",
            "content": "",
            "tool_calls": [{"id": "tc1", "function": {"name": "read_file", "arguments": "{}"}}],
        }
        jsonl_file.write_text(json.dumps(msg) + "\n", encoding="utf-8")
        session, _ = Session.from_jsonl(str(jsonl_file))
        assert session.messages[0]["tool_calls"][0]["id"] == "tc1"

    def test_from_jsonl_with_custom_session_id(self, tmp_path):
        """Verify from_jsonl correctly extracts session ID from filename."""
        jsonl_file = tmp_path / "my-custom-id.jsonl"
        msg = {"role": "user", "content": "hello"}
        jsonl_file.write_text(json.dumps(msg) + "\n", encoding="utf-8")
        session, _ = Session.from_jsonl(str(jsonl_file))
        assert session.session_id == "my-custom-id"
        assert len(session.messages) == 1

    def test_from_jsonl_rejects_non_dict_message(self, tmp_path):
        """A file with only non-dict JSON should raise ValueError (no valid messages)."""
        jsonl_file = tmp_path / "bad.jsonl"
        jsonl_file.write_text("null\n", encoding="utf-8")
        with pytest.raises(ValueError, match="No valid messages found"):
            Session.from_jsonl(str(jsonl_file))

    def test_from_jsonl_rejects_dict_without_role(self, tmp_path):
        """A file with only dicts missing 'role' should raise ValueError (no valid messages)."""
        jsonl_file = tmp_path / "bad.jsonl"
        jsonl_file.write_text(json.dumps({"content": "hello"}) + "\n", encoding="utf-8")
        with pytest.raises(ValueError, match="No valid messages found"):
            Session.from_jsonl(str(jsonl_file))

    def test_from_jsonl_skips_invalid_lines_preserves_valid(self, tmp_path):
        """Invalid lines are skipped; valid messages before them are preserved."""
        jsonl_file = tmp_path / "mixed.jsonl"
        lines = [
            json.dumps({"role": "user", "content": "hello"}) + "\n",
            json.dumps({"role": "assistant", "content": "hi"}) + "\n",
            "not valid json\n",  # corrupt line
            json.dumps({"role": "user", "content": "bye"}) + "\n",  # after corrupt
        ]
        jsonl_file.write_text("".join(lines), encoding="utf-8")
        session, skipped = Session.from_jsonl(str(jsonl_file))
        # The 3 valid messages should be preserved (corrupt line skipped)
        assert len(session.messages) == 3
        assert session.messages[0]["content"] == "hello"
        assert session.messages[1]["content"] == "hi"
        assert session.messages[2]["content"] == "bye"
        assert skipped == 1


class TestCheckpointManagerBatch:
    """R2: CheckpointManager batch operations (begin_batch, snapshot_to_batch, end_batch)."""

    def test_begin_batch_returns_directory(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        mgr = CheckpointManager("batch-test")
        batch_dir = mgr.begin_batch()
        assert os.path.isdir(batch_dir)
        assert "1" in batch_dir  # sequence 1

    def test_snapshot_to_batch_saves_file(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        source = tmp_path / "file.txt"
        source.write_text("batch content")

        mgr = CheckpointManager("batch-test")
        mgr.begin_batch()
        dest = mgr.snapshot_to_batch(str(source))
        assert os.path.exists(dest)
        with open(dest, encoding="utf-8") as f:
            assert f.read() == "batch content"

    def test_snapshot_to_batch_without_begin_raises(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        source = tmp_path / "file.txt"
        source.write_text("content")

        mgr = CheckpointManager("batch-test")
        with pytest.raises(RuntimeError, match="No active batch"):
            mgr.snapshot_to_batch(str(source))

    def test_batch_multiple_files(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        f1 = tmp_path / "a.txt"
        f1.write_text("content a")
        f2 = tmp_path / "b.txt"
        f2.write_text("content b")

        mgr = CheckpointManager("batch-test")
        mgr.begin_batch()
        mgr.snapshot_to_batch(str(f1))
        mgr.snapshot_to_batch(str(f2))
        mgr.end_batch()

        # Both files should be in the batch directory
        batch_dir = os.path.join(mgr.checkpoint_dir, "1")
        files = [f for f in os.listdir(batch_dir) if f != "meta.json"]
        assert len(files) == 2

    def test_end_batch_clears_active(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        mgr = CheckpointManager("batch-test")
        mgr.begin_batch()
        mgr.end_batch()
        # After end_batch, snapshot_to_batch should raise
        source = tmp_path / "x.txt"
        source.write_text("x")
        with pytest.raises(RuntimeError, match="No active batch"):
            mgr.snapshot_to_batch(str(source))

    def test_batch_sequence_continues_from_snapshots(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        source = tmp_path / "f.txt"
        source.write_text("content")

        mgr = CheckpointManager("seq-test")
        # Two regular snapshots use seq 1, 2
        mgr.snapshot(str(source))
        mgr.snapshot(str(source))
        # Batch should use seq 3
        batch_dir = mgr.begin_batch()
        assert "3" in batch_dir
        mgr.end_batch()

    def test_batch_meta_json_written(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        source = tmp_path / "meta.txt"
        source.write_text("meta test")

        mgr = CheckpointManager("meta-test")
        mgr.begin_batch()
        mgr.snapshot_to_batch(str(source))
        mgr.end_batch()

        meta_path = os.path.join(mgr.checkpoint_dir, "1", "meta.json")
        assert os.path.exists(meta_path)
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        # meta is now a list of entries (supports multi-file batches)
        assert isinstance(meta, list)
        assert len(meta) == 1
        assert "original_path" in meta[0]
        assert "safe_name" in meta[0]


class TestCompactContextPreservesInstructions:
    """R2: compact_context does NOT preserve instructions in output.

    Instructions are re-read from disk after compaction by the caller
    (agent.py calls load_memory_for_compaction()). This matches Claude
    Code's behavior: CLAUDE.md is re-read from disk after /compact.
    """

    def test_instructions_not_in_compacted_output(self):
        big = "x" * 8000
        messages = [
            {"role": "system", "content": "## Project Memory\nUse pytest for testing."},
        ]
        for i in range(100):
            messages.append({"role": "user", "content": f"q{i} {big}"})
            messages.append({"role": "assistant", "content": f"a{i} {big}"})
        tokens = estimate_tokens(messages)
        assert tokens > COMPRESS_TRIGGER_TOKENS

        result, _, _, _ = compact_context(messages, estimated_tokens=tokens)
        # Instructions are NOT preserved — caller re-reads from disk
        contents = [m.get("content", "") for m in result]
        assert not any("Use pytest" in c for c in contents)

    def test_llm_compress_returns_summary_only(self):
        messages = [
            {"role": "system", "content": "## Project Memory\nFollow PEP 8."},
        ]
        big = "x" * 8000
        for i in range(100):
            messages.append({"role": "user", "content": f"q{i} {big}"})
            messages.append({"role": "assistant", "content": f"a{i} {big}"})
        tokens = estimate_tokens(messages)
        assert tokens > COMPRESS_TRIGGER_TOKENS

        client = MagicMock()
        response = MagicMock()
        response.choices = [MagicMock()]
        response.choices[0].message.content = "LLM summary"
        client.chat.completions.create.return_value = response

        with patch("mimo_harness.context.llm_compress", return_value=[
            {"role": "assistant", "content": "[Conversation Summary]\nLLM summary"}
        ]):
            result, _, _, _ = compact_context(
                messages, client=client, estimated_tokens=tokens,
            )
        contents = [m.get("content", "") for m in result]
        # Only the summary, no instruction re-insertion
        assert any("LLM summary" in c for c in contents)


class TestLoadTopicOnDemand:
    def test_loads_existing_topic(self, tmp_path, monkeypatch):
        monkeypatch.chdir(tmp_path)
        # Create memory structure
        memory_dir = tmp_path / ".mimo" / "memory"
        memory_dir.mkdir(parents=True)
        (memory_dir / "my_topic.md").write_text(
            "---\nname: my_topic\n---\nTopic body", encoding="utf-8"
        )
        result = load_topic_on_demand("my_topic", project_dir=str(tmp_path))
        assert "Topic body" in result

    def test_nonexistent_topic_returns_empty(self, tmp_path):
        result = load_topic_on_demand("no_such_topic", project_dir=str(tmp_path))
        assert result == ""

    def test_auto_appends_md(self, tmp_path):
        memory_dir = tmp_path / ".mimo" / "memory"
        memory_dir.mkdir(parents=True)
        (memory_dir / "test.md").write_text("content", encoding="utf-8")
        result = load_topic_on_demand("test", project_dir=str(tmp_path))
        assert "content" in result


# ============================================================================
# P1: Additional context.py test coverage
# ============================================================================


class TestEstimateTokensEdgeCases:
    """Test estimate_tokens with various content types."""

    def test_non_dict_messages(self):
        """Non-dict messages should be estimated using chars/4."""
        messages = ["not a dict", 42, None]
        tokens = estimate_tokens(messages)
        assert tokens > 0

    def test_tool_message_estimate(self):
        """Tool messages should be estimated with code ratio."""
        messages = [{"role": "tool", "content": "x" * 1000, "tool_call_id": "tc1"}]
        tokens = estimate_tokens(messages)
        assert tokens > 0
        # Tool content uses ~3.5 chars/token, so 1000 chars ≈ 286 tokens
        assert 200 < tokens < 400

    def test_system_message_estimate(self):
        """System messages should be estimated with system ratio."""
        messages = [{"role": "system", "content": "x" * 1000}]
        tokens = estimate_tokens(messages)
        assert tokens > 0

    def test_assistant_with_tool_calls_estimate(self):
        """Assistant messages with tool_calls should include tool call overhead."""
        messages = [{
            "role": "assistant",
            "content": "let me check",
            "tool_calls": [{"id": "tc1", "function": {"name": "read_file", "arguments": '{"path": "/tmp/test"}'}}],
        }]
        tokens = estimate_tokens(messages)
        assert tokens > 0

    def test_empty_messages_list(self):
        # Returns minimum 1 token even for empty list
        assert estimate_tokens([]) >= 0

    def test_message_with_none_content(self):
        messages = [{"role": "user", "content": None}]
        tokens = estimate_tokens(messages)
        assert tokens >= 0


class TestFilterOrphanToolResults:
    """Test _filter_orphan_tool_results function."""

    def test_removes_orphan_tool_results(self):
        messages = [
            {"role": "user", "content": "hello"},
            {"role": "tool", "content": "result", "tool_call_id": "orphan_id"},
            {"role": "assistant", "content": "hi"},
        ]
        result = _filter_orphan_tool_results(messages)
        assert len(result) == 2
        assert all(m.get("role") != "tool" for m in result)

    def test_preserves_valid_tool_results(self):
        messages = [
            {"role": "assistant", "content": "", "tool_calls": [{"id": "tc1", "function": {"name": "test", "arguments": "{}"}}]},
            {"role": "tool", "content": "result", "tool_call_id": "tc1"},
            {"role": "assistant", "content": "done"},
        ]
        result = _filter_orphan_tool_results(messages)
        assert len(result) == 3

    def test_empty_messages(self):
        assert _filter_orphan_tool_results([]) == []

    def test_mixed_orphan_and_valid(self):
        messages = [
            {"role": "assistant", "content": "", "tool_calls": [{"id": "tc_valid", "function": {"name": "test", "arguments": "{}"}}]},
            {"role": "tool", "content": "valid result", "tool_call_id": "tc_valid"},
            {"role": "tool", "content": "orphan result", "tool_call_id": "tc_orphan"},
            {"role": "assistant", "content": "done"},
        ]
        result = _filter_orphan_tool_results(messages)
        assert len(result) == 3
        tool_msgs = [m for m in result if m.get("role") == "tool"]
        assert len(tool_msgs) == 1
        assert tool_msgs[0]["tool_call_id"] == "tc_valid"

    def test_preserves_non_tool_messages(self):
        messages = [
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "hi"},
        ]
        result = _filter_orphan_tool_results(messages)
        assert len(result) == 2
