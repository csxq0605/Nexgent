"""Tests for context management (Ch7 patterns)."""

import pytest
import json
import tempfile
import os
from mimo_harness.context import (
    Session, compact_context, load_memory,
    estimate_tokens,
    COMPRESS_TRIGGER_TOKENS,
    CheckpointManager,
    load_path_scoped_rules_for_file,
    load_memory_for_compaction, cleanup_old_sessions, cleanup_old_spill_files,
    load_topic_on_demand,
)


def _real_llm_client():
    """Create a real OpenAI client from env vars. Skip test if unavailable."""
    from openai import OpenAI
    from mimo_harness.config import MIMO_API_KEY, MIMO_BASE_URL, MIMO_MODEL
    if not MIMO_API_KEY or MIMO_API_KEY == "test-key-for-testing":
        pytest.skip("Real MIMO_API_KEY not set")
    return OpenAI(api_key=MIMO_API_KEY, base_url=MIMO_BASE_URL), MIMO_MODEL


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


class TestEstimateTokens:
    def test_estimates_basic_messages(self):
        messages = [{"role": "user", "content": "hello world"}]
        tokens = estimate_tokens(messages)
        assert tokens > 0
        assert tokens < 20

    def test_estimates_multiple_messages(self):
        messages = [{"role": "user", "content": "x" * 400}] * 10
        tokens = estimate_tokens(messages)
        # With tiktoken, more precise counting; with heuristic, ~900-1000
        assert tokens >= 400  # At minimum, should count something meaningful


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

        result, _, _, _, _ = compact_context(all_msgs, estimated_tokens=tokens)
        # Should have system marker + last 2 messages
        contents = [m.get("content", "") for m in result]
        assert any("recent question" in c for c in contents)
        assert any("recent answer" in c for c in contents)


class TestLoadMemory:
    def test_loads_existing_files(self, tmp_path):
        claude_md = tmp_path / "CLAUDE.md"
        claude_md.write_text("# Project rules\nBe concise.")

        result = load_memory(str(tmp_path))
        assert "CLAUDE.md" in result
        assert "Be concise" in result

    def test_respects_line_limit(self, tmp_path):
        claude_md = tmp_path / "CLAUDE.md"
        claude_md.write_text("\n".join([f"line {i}" for i in range(600)]))

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


class TestCompactContextWithLLM:
    def _make_big_messages(self, n, content_size=50000):
        """Create messages large enough to exceed token threshold (~850K)."""
        msgs = []
        for i in range(n):
            msgs.append({"role": "user", "content": f"q{i}" + "x" * content_size})
            msgs.append({"role": "assistant", "content": f"a{i}" + "x" * content_size})
        return msgs

    def test_uses_llm_when_tokens_exceed_threshold(self):
        client, model = _real_llm_client()
        messages = self._make_big_messages(75)
        tokens = estimate_tokens(messages)
        assert tokens > COMPRESS_TRIGGER_TOKENS

        result, attempts, _, _, _ = compact_context(
            messages, client=client, model=model, estimated_tokens=tokens,
        )
        # LLM compression should have been attempted
        assert attempts >= 1
        # Result should be shorter than input
        assert len(result) < len(messages)

    def test_falls_back_to_truncation_on_no_client(self):
        """Without client, falls back to truncation."""
        messages = self._make_big_messages(75)
        tokens = estimate_tokens(messages)
        assert tokens > COMPRESS_TRIGGER_TOKENS

        result, _, _, _, _ = compact_context(messages, estimated_tokens=tokens)
        # Fallback: system marker + system msg + last 15 messages
        assert len(result) <= 18
        assert result[0]["role"] == "system"

    def test_skips_compression_when_below_token_threshold(self):
        """Below token threshold, no compression needed."""
        messages = [{"role": "user", "content": "hi"}] * 10
        tokens = estimate_tokens(messages)
        assert tokens < COMPRESS_TRIGGER_TOKENS

        result, attempts, failures, _, _ = compact_context(messages, estimated_tokens=tokens)
        # No compression should have been attempted
        assert attempts == 0
        assert failures == 0
        assert len(result) == len(messages)

    # NOTE: test_backward_compatible_no_client removed — duplicate of
    # test_falls_back_to_truncation_on_no_client (same code path, same assertions)


class TestCompactContextEdgeCases:
    """Edge cases for compact_context."""

    def test_empty_messages(self):
        result, _, _, _, _ = compact_context([])
        assert result == []

    def test_single_message_no_compress(self):
        msg = [{"role": "user", "content": "hi"}]
        result, _, _, _, _ = compact_context(msg)
        assert result == msg

    def test_max_messages_legacy_path(self):
        """When max_messages is set and tokens are low, use message count."""
        messages = [{"role": "user", "content": f"msg {i}"} for i in range(100)]
        result, _, _, _, _ = compact_context(messages, max_messages=10)
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
        result, _, _, _, _ = compact_context(messages, max_messages=10)
        assert len(result) == 2  # orphan filtered

    def test_token_compress_with_tool_calls(self):
        """Token-based compression should handle tool_calls messages."""
        messages = []
        for i in range(200):
            messages.append({"role": "user", "content": f"task {i} " + "x" * 50000})
            messages.append({
                "role": "assistant",
                "content": "ok",
                "tool_calls": [{"id": f"tc{i}", "function": {"name": "test", "arguments": "{}"}}]
            })
            messages.append({"role": "tool", "content": f"result {i}", "tool_call_id": f"tc{i}"})

        tokens = estimate_tokens(messages)
        assert tokens > COMPRESS_TRIGGER_TOKENS

        result, _, _, _, _ = compact_context(messages, estimated_tokens=tokens)
        # Fallback: system marker + system msg + last 15 messages
        assert len(result) <= 18
        assert result[0]["role"] == "system"

    # NOTE: compact_context failure fallback is tested via E2E token budget
    # exhaustion test (TestE2ETokenBudgetExhaustion) which uses real API.

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

    def test_snapshot_creates_checkpoint_copy(self, tmp_path, monkeypatch):
        """S12: snapshot() creates a checkpoint copy of the file."""
        monkeypatch.chdir(tmp_path)
        source = tmp_path / "metadata.txt"
        source.write_text("content")

        mgr = CheckpointManager("test-session")
        checkpoint_path = mgr.snapshot(str(source))

        # Both files should exist
        assert os.path.exists(source)
        assert os.path.exists(checkpoint_path)
        # Checkpoint content should match source
        assert open(checkpoint_path).read() == "content"

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
    """R2: compact_context returns (messages, attempts, failures, thrashing, did_compress)."""

    def test_returns_five_element_tuple(self):
        messages = [{"role": "user", "content": "hi"}] * 5
        result = compact_context(messages)
        assert isinstance(result, tuple)
        assert len(result) == 5

    def test_attempts_and_failures_default_zero(self):
        messages = [{"role": "user", "content": "hi"}] * 5
        _, attempts, failures, thrashing, did_compress = compact_context(messages)
        assert attempts == 0
        assert failures == 0
        assert thrashing is False
        assert did_compress is False

    def test_attempts_increments_on_compression(self):
        """When LLM compression succeeds, attempts should increment."""
        client, model = _real_llm_client()
        big = "x" * 50000
        messages = [{"role": "user", "content": big}] * 150
        tokens = estimate_tokens(messages)
        assert tokens > COMPRESS_TRIGGER_TOKENS

        _, attempts, failures, thrashing, did_compress = compact_context(
            messages, client=client, model=model, estimated_tokens=tokens,
            compaction_attempts=0, compaction_failures=0,
        )
        assert attempts >= 1
        assert thrashing is False
        assert did_compress is True

    def test_failures_increment_when_no_client(self):
        """Without client, truncation fallback doesn't increment failures."""
        big = "x" * 50000
        messages = [{"role": "user", "content": big}] * 150
        tokens = estimate_tokens(messages)
        assert tokens > COMPRESS_TRIGGER_TOKENS

        _, attempts, failures, thrashing, did_compress = compact_context(
            messages, estimated_tokens=tokens,
            compaction_attempts=0, compaction_failures=0,
        )
        # No client = no LLM attempt = no failure increment
        assert failures == 0
        assert did_compress is True

    def test_thrashing_detected_after_three_failures(self):
        """Thrashing flag is True when compaction_failures >= 3."""
        big = "x" * 50000
        messages = [{"role": "user", "content": big}] * 150
        tokens = estimate_tokens(messages)
        assert tokens > COMPRESS_TRIGGER_TOKENS

        _, _, _, thrashing, did_compress = compact_context(
            messages, estimated_tokens=tokens,
            compaction_attempts=5, compaction_failures=3,
        )
        assert thrashing is True
        assert did_compress is False

    def test_no_compression_preserves_attempts_failures(self):
        """When no compression needed, attempts/failures are passed through."""
        messages = [{"role": "user", "content": "hi"}]
        _, attempts, failures, thrashing, did_compress = compact_context(
            messages, compaction_attempts=2, compaction_failures=1,
        )
        assert attempts == 2
        assert failures == 1
        assert thrashing is False
        assert did_compress is False


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


class TestLoadTopicOnDemand:
    """Tests load_topic_on_demand() — CWD-relative topic loading wrapper.
    NOTE: TestLoadTopic in test_memory.py tests the lower-level
    MemoryStore.load_topic() directly."""
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
        # With tiktoken: more precise counting (~133 tokens for 1000 'x' chars)
        # With heuristic: ~286 tokens
        assert 100 < tokens < 400

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


# ============================================================================
# snip_compress / microcompact independent boundary tests
# ============================================================================

from mimo_harness.context import snip_compress, microcompact, COMPRESS_MARKER


class TestSnipCompress:
    """Boundary tests for snip_compress (Level 1 compression)."""

    def test_empty_messages(self):
        assert snip_compress([]) == []

    def test_messages_within_limit(self):
        msgs = [{"role": "user", "content": "hi"}] * 5
        result = snip_compress(msgs, max_age=10)
        assert result == msgs

    def test_old_tool_messages_snipped(self):
        """Old tool messages should be replaced with markers."""
        msgs = [
            {"role": "user", "content": "q1"},
            {"role": "assistant", "content": "ok", "tool_calls": [{"id": "tc1"}]},
            {"role": "tool", "content": "old result", "tool_call_id": "tc1"},
            {"role": "user", "content": "q2"},
            {"role": "assistant", "content": "ok2"},
        ]
        result = snip_compress(msgs, max_age=2)
        # The tool message at index 2 is older than max_age=2 from end
        assert result[2]["content"] == COMPRESS_MARKER
        assert result[2]["tool_call_id"] == "tc1"  # preserved
        # Non-tool messages unchanged
        assert result[0]["content"] == "q1"
        assert result[3]["content"] == "q2"

    def test_recent_messages_preserved(self):
        """Messages within max_age should not be snipped."""
        msgs = [
            {"role": "tool", "content": "recent result", "tool_call_id": "tc2"},
            {"role": "user", "content": "q"},
        ]
        result = snip_compress(msgs, max_age=5)
        assert result[0]["content"] == "recent result"

    def test_non_tool_messages_never_snipped(self):
        """User/assistant messages are never snipped, even if old."""
        msgs = [
            {"role": "user", "content": "old question"},
            {"role": "assistant", "content": "old answer"},
            {"role": "user", "content": "recent"},
        ]
        result = snip_compress(msgs, max_age=1)
        assert result[0]["content"] == "old question"
        assert result[1]["content"] == "old answer"

    def test_preserves_message_count(self):
        """snip_compress preserves the total number of messages."""
        msgs = [
            {"role": "user", "content": "q"},
            {"role": "assistant", "content": "a", "tool_calls": [{"id": "tc1"}]},
            {"role": "tool", "content": "r", "tool_call_id": "tc1"},
        ] * 10
        result = snip_compress(msgs, max_age=5)
        assert len(result) == len(msgs)


class TestMicrocompact:
    """Boundary tests for microcompact (Level 2 compression)."""

    def test_empty_messages(self):
        assert microcompact([]) == []

    def test_no_tool_messages(self):
        """Messages without tool results should pass through unchanged."""
        msgs = [
            {"role": "user", "content": "q"},
            {"role": "assistant", "content": "a"},
        ]
        result = microcompact(msgs, keep_recent=5)
        assert result == msgs

    def test_tool_messages_within_limit(self):
        """Tool messages within keep_recent should not be compressed."""
        msgs = [
            {"role": "tool", "content": "result1", "tool_call_id": "tc1"},
            {"role": "tool", "content": "result2", "tool_call_id": "tc2"},
        ]
        result = microcompact(msgs, keep_recent=5)
        assert result[0]["content"] == "result1"
        assert result[1]["content"] == "result2"

    def test_old_tool_messages_compressed(self):
        """Old tool messages should be replaced with markers."""
        msgs = [
            {"role": "tool", "content": "old1", "tool_call_id": "tc1"},
            {"role": "tool", "content": "old2", "tool_call_id": "tc2"},
            {"role": "tool", "content": "recent1", "tool_call_id": "tc3"},
            {"role": "tool", "content": "recent2", "tool_call_id": "tc4"},
        ]
        result = microcompact(msgs, keep_recent=2)
        assert result[0]["content"] == COMPRESS_MARKER
        assert result[1]["content"] == COMPRESS_MARKER
        assert result[2]["content"] == "recent1"
        assert result[3]["content"] == "recent2"

    def test_preserves_non_tool_messages(self):
        """Non-tool messages should pass through unchanged."""
        msgs = [
            {"role": "user", "content": "question"},
            {"role": "tool", "content": "old", "tool_call_id": "tc1"},
            {"role": "assistant", "content": "answer"},
            {"role": "tool", "content": "recent", "tool_call_id": "tc2"},
        ]
        result = microcompact(msgs, keep_recent=1)
        assert result[0]["content"] == "question"
        assert result[2]["content"] == "answer"
        assert result[1]["content"] == COMPRESS_MARKER
        assert result[3]["content"] == "recent"

    def test_preserves_message_count(self):
        """microcompact preserves the total number of messages."""
        msgs = [
            {"role": "tool", "content": f"r{i}", "tool_call_id": f"tc{i}"}
            for i in range(20)
        ]
        result = microcompact(msgs, keep_recent=3)
        assert len(result) == 20

    def test_single_tool_message(self):
        """Single tool message should not be compressed (within keep_recent)."""
        msgs = [{"role": "tool", "content": "only", "tool_call_id": "tc1"}]
        result = microcompact(msgs, keep_recent=1)
        assert result[0]["content"] == "only"


# ═══════════════════════════════════════════════════════════════
# _parse_frontmatter tests
# ═══════════════════════════════════════════════════════════════

class TestParseFrontmatter:
    """Test _parse_frontmatter YAML-like frontmatter parser."""

    def test_simple_key_value(self):
        from mimo_harness.context import _parse_frontmatter
        content = "---\npaths: *.py\n---\nBody content here"
        meta, body = _parse_frontmatter(content)
        assert meta["paths"] == "*.py"
        assert body == "Body content here"

    def test_list_value(self):
        from mimo_harness.context import _parse_frontmatter
        content = '---\npaths: ["*.py", "*.js"]\n---\nBody'
        meta, body = _parse_frontmatter(content)
        assert meta["paths"] == ["*.py", "*.js"]
        assert body == "Body"

    def test_multiple_keys(self):
        from mimo_harness.context import _parse_frontmatter
        content = "---\npaths: *.py\nname: test-rule\n---\nBody"
        meta, body = _parse_frontmatter(content)
        assert meta["paths"] == "*.py"
        assert meta["name"] == "test-rule"

    def test_no_frontmatter(self):
        from mimo_harness.context import _parse_frontmatter
        content = "No frontmatter here"
        meta, body = _parse_frontmatter(content)
        assert meta == {}
        assert body == content

    def test_unclosed_frontmatter(self):
        from mimo_harness.context import _parse_frontmatter
        content = "---\npaths: *.py\nNo closing delimiter"
        meta, body = _parse_frontmatter(content)
        assert meta == {}
        assert body == content

    def test_empty_frontmatter(self):
        from mimo_harness.context import _parse_frontmatter
        content = "---\n---\nBody"
        meta, body = _parse_frontmatter(content)
        assert meta == {}
        assert body == "Body"

    def test_quoted_values(self):
        from mimo_harness.context import _parse_frontmatter
        content = '---\nname: "quoted value"\n---\nBody'
        meta, body = _parse_frontmatter(content)
        assert meta["name"] == "quoted value"


# ═══════════════════════════════════════════════════════════════
# _resolve_imports tests
# ═══════════════════════════════════════════════════════════════

class TestResolveImports:
    """Test _resolve_imports @import directive resolver."""

    def test_basic_import(self, tmp_path):
        from mimo_harness.context import _resolve_imports
        (tmp_path / "helper.md").write_text("Helper content")
        content = "Before\n@helper.md\nAfter"
        result = _resolve_imports(content, str(tmp_path))
        assert "Helper content" in result
        assert "Before" in result
        assert "After" in result

    def test_import_nonexistent_file(self, tmp_path):
        from mimo_harness.context import _resolve_imports
        content = "Before\n@nonexistent.md\nAfter"
        result = _resolve_imports(content, str(tmp_path))
        # Unresolved imports left as-is
        assert "@nonexistent.md" in result

    def test_import_path_traversal_blocked(self, tmp_path):
        from mimo_harness.context import _resolve_imports
        content = "@../outside.md"
        result = _resolve_imports(content, str(tmp_path))
        # Should not resolve — path traversal blocked
        assert "@../outside.md" in result

    def test_import_nested(self, tmp_path):
        from mimo_harness.context import _resolve_imports
        (tmp_path / "a.md").write_text("Content from A\n@b.md")
        (tmp_path / "b.md").write_text("Content from B")
        content = "@a.md"
        result = _resolve_imports(content, str(tmp_path))
        assert "Content from A" in result
        assert "Content from B" in result

    def test_import_depth_limit(self, tmp_path):
        from mimo_harness.context import _resolve_imports
        # Create a chain of 10 imports (depth limit is 5)
        for i in range(10):
            next_file = f"level{i+1}.md" if i < 9 else "final.md"
            (tmp_path / f"level{i}.md").write_text(f"@{next_file}")
        (tmp_path / "final.md").write_text("FINAL")
        result = _resolve_imports("@level0.md", str(tmp_path))
        # Should not infinite loop; final content may or may not be reached
        # depending on depth, but should not crash
        assert isinstance(result, str)

    def test_no_imports(self, tmp_path):
        from mimo_harness.context import _resolve_imports
        content = "No imports here, just plain text."
        result = _resolve_imports(content, str(tmp_path))
        assert result == content

