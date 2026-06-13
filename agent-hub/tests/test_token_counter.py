"""Tests for token counter module - precise token counting with tiktoken.

Tests follow TODO.md test requirements:
- Test estimate_tokens() function accuracy
- Test token counting for different content types
- Test streaming output statistics accumulation
- Compare tiktoken vs heuristic counting differences
- Analyze performance impact
"""

import pytest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from agent_hub.token_counter import (
    count_tokens,
    count_tokens_tiktoken,
    count_tokens_heuristic,
    count_message_tokens,
    count_messages_tokens,
    StreamingTokenCounter,
    TokenStats,
    estimate_compressed_tokens,
    estimate_compression_savings,
    _is_tiktoken_available,
    _detect_content_type,
    _get_ratio,
)
from agent_hub.agent import TokenBudget


# ============================================================================
# 1. tiktoken availability
# ============================================================================

class TestTiktokenAvailability:
    """Test tiktoken import and availability."""

    def test_tiktoken_available(self):
        """tiktoken should be importable and available."""
        result = _is_tiktoken_available()
        assert isinstance(result, bool)
        # tiktoken should be installed (we added it as dependency)
        assert result is True


# ============================================================================
# 2. Precise token counting (tiktoken) - main root function: count_tokens_tiktoken
# ============================================================================

class TestTiktokenCounting:
    """Test precise token counting with tiktoken."""

    def test_count_tokens_tiktoken_basic(self):
        """Basic token counting should return positive integer."""
        result = count_tokens_tiktoken("Hello, world!")
        assert result > 0
        assert isinstance(result, int)

    def test_count_tokens_tiktoken_empty(self):
        """Empty string should return 0."""
        result = count_tokens_tiktoken("")
        assert result == 0

    def test_count_tokens_tiktoken_longer_text(self):
        """Longer text should have more tokens."""
        short = count_tokens_tiktoken("Hello")
        long = count_tokens_tiktoken("Hello, this is a longer text with more words and sentences.")
        assert long > short

    def test_count_tokens_tiktoken_code(self):
        """Code should have reasonable token count."""
        code = 'def hello():\n    print("Hello")\n    return 42'
        result = count_tokens_tiktoken(code)
        assert 5 < result < 50

    def test_count_tokens_tiktoken_chinese(self):
        """Chinese text should be counted correctly."""
        result = count_tokens_tiktoken("你好，世界！这是一个测试。")
        assert result > 0
        # 8 Chinese chars + 2 punctuation should be 5-15 tokens
        assert 3 <= result <= 20, f"Chinese token count {result} outside expected range 3-20"

    def test_count_message_tokens_tiktoken_with_overhead(self):
        """Message token counting should include overhead (~4 tokens)."""
        message = {"role": "user", "content": "Hello, how are you?"}
        result = count_message_tokens(message)
        content_tokens = count_tokens_tiktoken("Hello, how are you?")
        assert result > content_tokens  # Should include message overhead

    def test_count_message_tokens_tiktoken_with_tool_calls(self):
        """Tool calls should add tokens."""
        message = {
            "role": "assistant",
            "content": "",
            "tool_calls": [{
                "id": "call_123",
                "function": {"name": "read_file", "arguments": '{"path": "/test/file.py"}'}
            }]
        }
        result = count_message_tokens(message)
        assert result > 10


# ============================================================================
# 3. Heuristic token counting (fallback) - main root function: count_tokens_heuristic
# ============================================================================

class TestHeuristicCounting:
    """Test heuristic token counting fallback."""

    def test_count_tokens_heuristic_basic(self):
        """Basic heuristic counting should return positive integer."""
        result = count_tokens_heuristic("Hello, world!")
        assert result > 0

    def test_count_tokens_heuristic_empty(self):
        """Empty string should return 0."""
        result = count_tokens_heuristic("")
        assert result == 0

    def test_count_tokens_heuristic_longer_text(self):
        """Longer text should have more tokens."""
        short = count_tokens_heuristic("Hello")
        long = count_tokens_heuristic("Hello, this is a longer text with more words.")
        assert long > short


# ============================================================================
# 4. Content type detection - affects heuristic estimation accuracy
# ============================================================================

class TestContentTypeDetection:
    """Test content type detection for heuristic estimation."""

    def test_detect_content_types(self):
        """All content types should be detected correctly."""
        assert _detect_content_type({"role": "tool", "content": '{"result": "ok"}'}) == "tool"
        assert _detect_content_type({"role": "system", "content": "You are helpful."}) == "system"
        # Code blocks (```) are strong signal
        assert _detect_content_type({"role": "user", "content": "```python\ndef hello(): pass\n```"}) == "code"
        # Multiple code keywords required (at least 2)
        assert _detect_content_type({"role": "user", "content": "def hello():\n    import os"}) == "code"
        # Single keyword is not enough
        assert _detect_content_type({"role": "user", "content": "def hello(): pass"}) == "natural"
        assert _detect_content_type({"role": "user", "content": "Hello, how are you?"}) == "natural"

    def test_get_ratio_ordering(self):
        """Ratios should be ordered: tool < code < system < natural."""
        assert _get_ratio("tool") < _get_ratio("code")
        assert _get_ratio("code") < _get_ratio("natural")
        assert _get_ratio("system") < _get_ratio("natural")


# ============================================================================
# 5. Main counting interface - root function: count_messages_tokens
# ============================================================================

class TestCountTokens:
    """Test main counting interface."""

    def test_count_tokens_with_tiktoken(self):
        """count_tokens should use tiktoken when available."""
        result = count_tokens("Hello, world!", use_tiktoken=True)
        assert result > 0

    def test_count_tokens_without_tiktoken(self):
        """count_tokens should fall back to heuristic."""
        result = count_tokens("Hello, world!", use_tiktoken=False)
        assert result > 0

    def test_count_messages_tokens(self):
        """count_messages_tokens should count total."""
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]
        result = count_messages_tokens(messages)
        assert result > 0

    def test_count_messages_tokens_empty(self):
        """Empty message list should return 0."""
        result = count_messages_tokens([])
        assert result == 0


# ============================================================================
# 6. Streaming token counter - for real-time statistics during streaming
# ============================================================================

class TestStreamingTokenCounter:
    """Test streaming token accumulation."""

    def test_streaming_basic(self):
        """Basic streaming should accumulate tokens."""
        counter = StreamingTokenCounter()
        counter.add_text("Hello")
        counter.add_text(", world!")
        assert counter.total_tokens > 0
        assert counter.total_chars > 0

    def test_streaming_reset(self):
        """Reset should clear accumulated tokens."""
        counter = StreamingTokenCounter()
        counter.add_text("Hello")
        assert counter.total_tokens > 0
        counter.reset()
        assert counter.total_tokens == 0
        assert counter.total_chars == 0

    def test_streaming_accumulation(self):
        """Multiple chunks should accumulate."""
        counter = StreamingTokenCounter()
        for i in range(10):
            counter.add_text(f"Chunk {i} ")
        assert counter.total_tokens > 10
        assert counter.total_chars > 50


# ============================================================================
# 7. Token statistics - for session reporting
# ============================================================================

class TestTokenStats:
    """Test token statistics tracking."""

    def test_stats_initialization(self):
        """Stats should initialize with zeros."""
        stats = TokenStats()
        assert stats.input_tokens == 0
        assert stats.output_tokens == 0
        assert stats.total_tokens == 0
        assert stats.message_count == 0

    def test_stats_average_message_tokens(self):
        """Average should be calculated correctly."""
        stats = TokenStats(total_tokens=100, message_count=5)
        assert stats.average_message_tokens == 20.0

    def test_stats_compression_ratio(self):
        """Compression ratio should be calculated correctly."""
        stats = TokenStats(compression_saved_tokens=50, total_tokens=100)
        assert stats.compression_ratio == pytest.approx(0.333, rel=0.1)

    def test_stats_to_dict(self):
        """to_dict should return dictionary."""
        stats = TokenStats(input_tokens=100, output_tokens=50, total_tokens=150)
        result = stats.to_dict()
        assert isinstance(result, dict)
        assert result["input_tokens"] == 100
        assert result["output_tokens"] == 50

    def test_stats_format_report(self):
        """format_report should return string."""
        stats = TokenStats(input_tokens=100, output_tokens=50, total_tokens=150)
        report = stats.format_report()
        assert isinstance(report, str)
        assert "Token Usage Report" in report


# ============================================================================
# 8. Token budget - for warning and blocking
# ============================================================================

class TestTokenBudget:
    """Test token budget management."""

    def test_budget_initialization(self):
        """Budget should initialize correctly."""
        budget = TokenBudget(max_tokens=1_000_000)
        assert budget.max_tokens == 1_000_000
        assert budget.effective_max == 1_000_000 - 50000

    def test_budget_usage_ratio(self):
        """Usage ratio should be calculated correctly."""
        budget = TokenBudget(max_tokens=1_000_000)
        budget.estimated_tokens = 500000
        ratio = budget.usage_ratio()
        expected = 500000 / budget.effective_max
        assert ratio == pytest.approx(expected, rel=0.01)

    def test_budget_warning_threshold(self):
        """Warning at 85% — no blocking, just warning like Claude Code."""
        budget = TokenBudget(max_tokens=1_000_000)
        # Below warning threshold
        budget.estimated_tokens = 700000
        assert not budget.is_warning()
        # Above warning
        budget.estimated_tokens = 850000
        assert budget.is_warning()
        # High usage still just warns
        budget.estimated_tokens = 940000
        assert budget.is_warning()


# ============================================================================
# 9. Compression estimation - for optimizing context compression
# ============================================================================

class TestCompressionEstimation:
    """Test compression token estimation."""

    def test_estimate_compressed_tokens(self):
        """Compressed tokens should be ~12% of original, capped at 15K."""
        messages = [{"role": "user", "content": "x" * 1000}] * 100
        original = count_messages_tokens(messages)
        compressed = estimate_compressed_tokens(messages)

        # Should be less than original
        assert compressed < original
        # Should be around 12% of original
        assert compressed == pytest.approx(original * 0.12, rel=0.2)
        # Should be capped at 15K
        assert compressed <= 15000

    def test_estimate_compressed_tokens_small_input(self):
        """Small inputs should return proportionally small estimates."""
        messages = [{"role": "user", "content": "Hello"}]
        compressed = estimate_compressed_tokens(messages)
        assert compressed > 0
        assert compressed < 100

    def test_estimate_compression_savings(self):
        """Savings should be calculated correctly."""
        messages = [{"role": "user", "content": "x" * 1000}] * 50
        savings = estimate_compression_savings(messages)

        assert "original_tokens" in savings
        assert "estimated_compressed_tokens" in savings
        assert "estimated_savings" in savings
        assert "estimated_ratio" in savings
        assert savings["estimated_savings"] > 0
        assert savings["original_tokens"] > savings["estimated_compressed_tokens"]

    def test_compression_savings_empty_messages(self):
        """Empty messages should handle gracefully."""
        savings = estimate_compression_savings([])
        assert savings["original_tokens"] == 0
        assert savings["estimated_compressed_tokens"] == 0


# ============================================================================
# 10. Integration tests
# ============================================================================

class TestIntegration:
    """Integration tests for token counting."""

    def test_full_message_list(self):
        """Counting a full message list should work."""
        messages = [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "What is 2 + 2?"},
            {"role": "assistant", "content": "The answer is 4."},
            {"role": "user", "content": "Thanks!"},
        ]
        result = count_messages_tokens(messages)
        assert result > 0
        assert isinstance(result, int)

    def test_message_list_with_tool_calls(self):
        """Message list with tool calls should be counted."""
        messages = [
            {"role": "user", "content": "Read the file test.py"},
            {
                "role": "assistant",
                "content": "",
                "tool_calls": [{
                    "id": "call_1",
                    "function": {"name": "read_file", "arguments": '{"path": "test.py"}'}
                }]
            },
            {
                "role": "tool",
                "tool_call_id": "call_1",
                "content": '{"content": "print(\'hello\')"}'
            },
            {"role": "assistant", "content": "The file contains a print statement."},
        ]
        result = count_messages_tokens(messages)
        assert result > 20

    def test_budget_with_real_messages(self):
        """Budget should work with real message list."""
        messages = [
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]
        budget = TokenBudget(max_tokens=1_000_000)
        budget.update(messages)
        ratio = budget.usage_ratio()
        assert 0 < ratio < 1


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
