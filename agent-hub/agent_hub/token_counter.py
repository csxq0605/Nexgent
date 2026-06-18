"""Token counter - precise token counting with tiktoken, falling back to heuristic.

Implements Claude Code/Codex patterns:
- tiktoken-based precise counting for OpenAI-compatible models
- Heuristic fallback when tiktoken is unavailable
- Per-message and per-content-type counting
- Streaming token accumulation
- Token budget management with warnings
"""

import json
import logging
import threading
from dataclasses import dataclass, field
from typing import Optional

_logger = logging.getLogger("agent-hub.token_counter")

# ---------------------------------------------------------------------------
# tiktoken encoder cache (thread-safe)
# ---------------------------------------------------------------------------
_encoder_cache: dict[str, object] = {}
_tiktoken_available: Optional[bool] = None
_encoder_lock = threading.Lock()


def _is_tiktoken_available() -> bool:
    """Check if tiktoken is installed and importable (thread-safe)."""
    global _tiktoken_available
    if _tiktoken_available is None:
        with _encoder_lock:
            # Double-check after acquiring lock
            if _tiktoken_available is None:
                try:
                    import tiktoken
                    _tiktoken_available = True
                except ImportError:
                    _tiktoken_available = False
                    _logger.info("tiktoken not installed, using heuristic token estimation")
    return _tiktoken_available


def _get_encoder(model: str = "gpt-4"):
    """Get or create a tiktoken encoder for the given model (thread-safe, cached)."""
    if not _is_tiktoken_available():
        return None

    # Map model names to tiktoken encoding names
    # MiMo uses OpenAI-compatible format, so cl100k_base is appropriate
    encoding_name = "cl100k_base"

    if encoding_name not in _encoder_cache:
        with _encoder_lock:
            # Double-check after acquiring lock
            if encoding_name not in _encoder_cache:
                import tiktoken
                _encoder_cache[encoding_name] = tiktoken.get_encoding(encoding_name)

    return _encoder_cache[encoding_name]


# ---------------------------------------------------------------------------
# Precise token counting with tiktoken
# ---------------------------------------------------------------------------

def count_tokens_tiktoken(text: str, model: str = "gpt-4") -> int:
    """Count tokens precisely using tiktoken.

    Args:
        text: The text to count tokens for
        model: Model name (used to select encoding)

    Returns:
        Precise token count, or -1 if tiktoken unavailable
    """
    encoder = _get_encoder(model)
    if encoder is None:
        return -1

    try:
        return len(encoder.encode(text))
    except Exception as e:
        _logger.warning("tiktoken encode failed: %s", e)
        return -1


def count_message_tokens_tiktoken(message: dict, model: str = "gpt-4") -> int:
    """Count tokens for a single message using tiktoken.

    Follows OpenAI's token counting rules:
    - Each message has ~4 tokens overhead (role, separators)
    - Tool calls have additional overhead
    """
    encoder = _get_encoder(model)
    if encoder is None:
        return -1

    try:
        tokens = 0

        # Message overhead (role, separators)
        tokens += 4

        # Content
        content = message.get("content", "")
        if isinstance(content, str) and content:
            tokens += len(encoder.encode(content))
        elif isinstance(content, list):
            # Handle multimodal content (list of parts)
            for part in content:
                if isinstance(part, dict):
                    text = part.get("text", "")
                    if text:
                        tokens += len(encoder.encode(text))

        # Tool calls
        tool_calls = message.get("tool_calls")
        if tool_calls:
            for tc in tool_calls:
                if isinstance(tc, dict):
                    func = tc.get("function", {})
                    name = func.get("name", "")
                    args = func.get("arguments", "")
                    if name:
                        tokens += len(encoder.encode(name))
                    if args:
                        tokens += len(encoder.encode(args))
                    tokens += 7  # Tool call overhead

        # Tool result
        tool_call_id = message.get("tool_call_id")
        if tool_call_id:
            tokens += 4  # Tool result overhead

        return tokens
    except Exception as e:
        _logger.warning("tiktoken message count failed: %s", e)
        return -1


# ---------------------------------------------------------------------------
# Heuristic token estimation (fallback)
# ---------------------------------------------------------------------------

# Content type ratios (chars per token)
_RATIO_TOOL = 3.2       # Tool results are often JSON/code
_RATIO_SYSTEM = 3.8     # System prompts are structured text
_RATIO_CODE = 3.5       # Code-heavy content
_RATIO_NATURAL = 4.2    # Natural language
_RATIO_DEFAULT = 4.0    # Default

# Pre-built ratio lookup table (avoids rebuilding dict on every call)
_RATIO_LOOKUP = {
    "tool": _RATIO_TOOL,
    "system": _RATIO_SYSTEM,
    "code": _RATIO_CODE,
    "natural": _RATIO_NATURAL,
}

# Code markers for content type detection
_CODE_MARKERS = ["```", "def ", "class ", "import ", "function ", "const ", "let ", "var ", "from "]


def _detect_content_type(message: dict) -> str:
    """Detect content type for heuristic estimation.

    Uses more conservative code detection:
    - Requires code block markers (```) OR multiple code keywords
    - Avoids false positives from natural language containing single keywords
    """
    role = message.get("role", "")
    content = message.get("content", "")

    if role == "tool":
        return "tool"
    elif role == "system":
        return "system"
    elif isinstance(content, str):
        # Code block markers are strong signal
        if "```" in content:
            return "code"
        # Count code keyword matches (require at least 2)
        code_keyword_count = sum(1 for marker in _CODE_MARKERS[1:] if marker in content)
        if code_keyword_count >= 2:
            return "code"
    return "natural"


def _get_ratio(content_type: str) -> float:
    """Get chars/token ratio for content type."""
    return _RATIO_LOOKUP.get(content_type, _RATIO_DEFAULT)


def count_tokens_heuristic(text: str) -> int:
    """Estimate token count using character-based heuristic.

    This is the fallback when tiktoken is unavailable.
    Uses _RATIO_DEFAULT (4.0) for consistency with count_message_tokens_heuristic.
    """
    if not text:
        return 0
    # Use _RATIO_DEFAULT for consistency
    return max(1, int(len(text) / _RATIO_DEFAULT))


def count_message_tokens_heuristic(message: dict) -> int:
    """Estimate tokens for a single message using heuristic."""
    if not isinstance(message, dict):
        return max(1, len(str(message)) // 4)

    # Serialize full message to capture all fields
    raw = json.dumps(message, ensure_ascii=False)
    char_count = len(raw)

    # Detect content type and get ratio
    content_type = _detect_content_type(message)
    ratio = _get_ratio(content_type)

    return max(1, int(char_count / ratio))


# ---------------------------------------------------------------------------
# Main token counting interface
# ---------------------------------------------------------------------------

def count_tokens(text: str, model: str = "gpt-4", use_tiktoken: bool = True) -> int:
    """Count tokens for text, using tiktoken if available.

    Args:
        text: Text to count tokens for
        model: Model name for tiktoken encoding selection
        use_tiktoken: Whether to try tiktoken first

    Returns:
        Token count
    """
    if use_tiktoken:
        precise = count_tokens_tiktoken(text, model)
        if precise >= 0:
            return precise

    # Fallback to heuristic
    return count_tokens_heuristic(text)


def count_message_tokens(message: dict, model: str = "gpt-4", use_tiktoken: bool = True) -> int:
    """Count tokens for a single message.

    Args:
        message: Message dict with role, content, etc.
        model: Model name for tiktoken encoding selection
        use_tiktoken: Whether to try tiktoken first

    Returns:
        Token count
    """
    if use_tiktoken:
        precise = count_message_tokens_tiktoken(message, model)
        if precise >= 0:
            return precise

    # Fallback to heuristic
    return count_message_tokens_heuristic(message)


def count_messages_tokens(messages: list, model: str = "gpt-4", use_tiktoken: bool = True) -> int:
    """Count total tokens for a list of messages.

    Args:
        messages: List of message dicts
        model: Model name for tiktoken encoding selection
        use_tiktoken: Whether to try tiktoken first

    Returns:
        Total token count
    """
    if not messages:
        return 0

    total = 0
    for msg in messages:
        if isinstance(msg, dict):
            total += count_message_tokens(msg, model, use_tiktoken)
        else:
            # Non-dict messages, use basic heuristic
            total += max(1, len(str(msg)) // 4)

    return max(total, 1)


# ---------------------------------------------------------------------------
# Streaming token accumulator
# ---------------------------------------------------------------------------

@dataclass
class StreamingTokenCounter:
    """Accumulate token counts during streaming output.

    Usage:
        counter = StreamingTokenCounter()
        for chunk in stream:
            counter.add_text(chunk.content)
        print(f"Total tokens: {counter.total_tokens}")
    """

    model: str = "gpt-4"
    use_tiktoken: bool = True
    total_tokens: int = 0
    total_chars: int = 0
    _buffer: str = field(default_factory=str, repr=False)
    _precise_count: int = 0  # Track precise count separately

    def add_text(self, text: str) -> int:
        """Add text chunk and return incremental token count.

        Accumulates text in buffer and periodically counts tokens precisely
        using tiktoken when buffer reaches threshold.

        Returns:
            Incremental tokens added by this chunk (0 if no flush occurred)
        """
        if not text:
            return 0

        self._buffer += text
        self.total_chars += len(text)

        # Periodically flush buffer and count precisely
        if len(self._buffer) >= 200:
            prev_total = self.total_tokens
            self._flush_buffer()
            # Update total tokens (never decrease — clamp to previous value)
            buffer_estimate = count_tokens_heuristic(self._buffer) if self._buffer else 0
            new_total = self._precise_count + buffer_estimate
            self.total_tokens = max(prev_total, new_total)
            return max(0, self.total_tokens - prev_total)

        # No flush, just update estimate (not counted as incremental, never decrease)
        buffer_estimate = count_tokens_heuristic(self._buffer) if self._buffer else 0
        self.total_tokens = max(self.total_tokens, self._precise_count + buffer_estimate)
        return 0

    def _flush_buffer(self):
        """Flush buffer and count tokens precisely."""
        if not self._buffer:
            return

        # Save buffer content and clear before counting to avoid double-counting
        buffer_content = self._buffer
        self._buffer = ""

        if self.use_tiktoken:
            precise = count_tokens_tiktoken(buffer_content, self.model)
            if precise >= 0:
                self._precise_count += precise
            else:
                self._precise_count += count_tokens_heuristic(buffer_content)
        else:
            self._precise_count += count_tokens_heuristic(buffer_content)

    def reset(self):
        """Reset the accumulator."""
        self.total_tokens = 0
        self.total_chars = 0
        self._buffer = ""
        self._precise_count = 0


# ---------------------------------------------------------------------------
# Token statistics
# ---------------------------------------------------------------------------

@dataclass
class TokenStats:
    """Token usage statistics for a session."""

    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0
    message_count: int = 0
    tool_call_count: int = 0
    compression_count: int = 0
    compression_saved_tokens: int = 0

    @property
    def average_message_tokens(self) -> float:
        """Average tokens per message."""
        return self.total_tokens / self.message_count if self.message_count > 0 else 0

    @property
    def compression_ratio(self) -> float:
        """Ratio of tokens saved by compression."""
        if self.compression_saved_tokens == 0:
            return 0.0
        return self.compression_saved_tokens / (self.total_tokens + self.compression_saved_tokens)

    def to_dict(self) -> dict:
        """Convert to dictionary for reporting."""
        return {
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "total_tokens": self.total_tokens,
            "message_count": self.message_count,
            "tool_call_count": self.tool_call_count,
            "compression_count": self.compression_count,
            "compression_saved_tokens": self.compression_saved_tokens,
            "average_message_tokens": round(self.average_message_tokens, 1),
            "compression_ratio": f"{self.compression_ratio:.1%}",
        }

    def format_report(self) -> str:
        """Format statistics as a human-readable report."""
        lines = [
            "## Token Usage Report",
            "",
            f"- **Total tokens**: {self.total_tokens:,}",
            f"- **Input tokens**: {self.input_tokens:,}",
            f"- **Output tokens**: {self.output_tokens:,}",
            f"- **Messages**: {self.message_count}",
            f"- **Tool calls**: {self.tool_call_count}",
            f"- **Avg tokens/message**: {self.average_message_tokens:.1f}",
        ]

        if self.compression_count > 0:
            lines.extend([
                f"- **Compressions**: {self.compression_count}",
                f"- **Tokens saved**: {self.compression_saved_tokens:,}",
                f"- **Compression ratio**: {self.compression_ratio:.1%}",
            ])

        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Compression estimation
# ---------------------------------------------------------------------------

def estimate_compressed_tokens(messages: list, target_ratio: float = 0.12) -> int:
    """Estimate token count after compression.

    Claude Code's compression produces summaries that are ~12% of original tokens.
    This function estimates the compressed size without actually compressing.

    Args:
        messages: Original messages
        target_ratio: Target compression ratio (default 12%)

    Returns:
        Estimated token count after compression (at least 1)
    """
    original_tokens = count_messages_tokens(messages)

    # LLM summaries tend to be 10-15% of original, capped at ~15K tokens
    estimated_compressed = int(original_tokens * target_ratio)
    max_compressed = 15_000  # Cap at 15K tokens

    return max(1, min(estimated_compressed, max_compressed))


def estimate_compression_savings(messages: list, target_ratio: float = 0.12) -> dict:
    """Estimate compression savings.

    Args:
        messages: Original messages
        target_ratio: Target compression ratio

    Returns:
        Dictionary with compression estimates
    """
    original_tokens = count_messages_tokens(messages)

    # Handle empty messages
    if not messages or original_tokens == 0:
        return {
            "original_tokens": 0,
            "estimated_compressed_tokens": 0,
            "estimated_savings": 0,
            "estimated_ratio": "0%",
        }

    compressed_tokens = estimate_compressed_tokens(messages, target_ratio)
    savings = original_tokens - compressed_tokens

    return {
        "original_tokens": original_tokens,
        "estimated_compressed_tokens": compressed_tokens,
        "estimated_savings": savings,
        "estimated_ratio": f"{savings / original_tokens:.1%}" if original_tokens > 0 else "0%",
    }


# Note: TokenBudget is defined in agent.py to avoid duplication.
# Use agent.TokenBudget for budget tracking.
