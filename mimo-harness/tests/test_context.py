"""Tests for context management (Ch7 patterns)."""

import pytest
import json
import tempfile
import os
from unittest.mock import MagicMock, patch
from mimo_harness.context import (
    Session, compact_context, snip_compress, microcompact,
    _filter_orphan_tool_results, make_compact_boundary, load_memory,
    llm_compress, COMPRESS_MARKER,
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


class TestCompactContext:
    def test_within_limits(self):
        messages = [{"role": "user", "content": "hi"}] * 5
        result = compact_context(messages, max_messages=30)
        assert len(result) == 5

    def test_applies_compression(self):
        messages = []
        for i in range(50):
            messages.append({"role": "user", "content": f"msg {i}"})
            messages.append({"role": "assistant", "content": f"reply {i}"})

        result = compact_context(messages, max_messages=30)
        assert len(result) <= 30


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

    def test_returns_summary_and_recent(self):
        messages = self._make_messages(20)  # 40 messages
        client = self._mock_client("Test summary")

        result = llm_compress(messages, client, model="test-model", keep_recent=6)
        assert result is not None
        assert result[0]["role"] == "assistant"
        assert "Conversation Summary" in result[0]["content"]
        assert "Test summary" in result[0]["content"]
        # Recent messages preserved
        assert len(result) == 1 + 6  # summary + 6 recent

    def test_preserves_recent_messages(self):
        messages = self._make_messages(15)
        client = self._mock_client("summary")

        result = llm_compress(messages, client, keep_recent=4)
        # Last 4 messages should be preserved verbatim
        assert result[-4:] == messages[-4:]

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

    def test_short_messages_returned_as_is(self):
        messages = self._make_messages(3)  # 6 messages, less than keep_recent
        client = self._mock_client()

        result = llm_compress(messages, client, keep_recent=10)
        assert result == messages


class TestCompactContextWithLLM:
    def _make_messages(self, n):
        msgs = []
        for i in range(n):
            msgs.append({"role": "user", "content": f"q{i}"})
            msgs.append({"role": "assistant", "content": f"a{i}"})
        return msgs

    def test_uses_llm_when_threshold_exceeded(self):
        messages = self._make_messages(25)  # 50 messages > threshold
        client = MagicMock()
        response = MagicMock()
        response.choices = [MagicMock()]
        response.choices[0].message.content = "LLM summary"
        client.chat.completions.create.return_value = response

        with patch("mimo_harness.context.llm_compress", return_value=[
            {"role": "assistant", "content": "[Conversation Summary]\nLLM summary"}
        ] + messages[-10:]) as mock_compress:
            result = compact_context(messages, client=client, model="test")
            mock_compress.assert_called_once()

    def test_falls_back_to_truncation_on_llm_failure(self):
        messages = self._make_messages(25)  # 50 messages
        client = MagicMock()
        client.chat.completions.create.side_effect = Exception("fail")

        result = compact_context(messages, client=client, model="test")
        # Should still produce a result via truncation
        assert len(result) <= 30
        assert len(result) > 0

    def test_skips_llm_when_below_threshold(self):
        messages = self._make_messages(10)  # 20 messages < threshold (30)

        with patch("mimo_harness.context.llm_compress") as mock_compress:
            result = compact_context(messages, client=MagicMock())
            mock_compress.assert_not_called()

    def test_backward_compatible_no_client(self):
        messages = self._make_messages(25)  # 50 messages
        result = compact_context(messages)  # no client
        assert len(result) <= 30
        assert len(result) > 0
