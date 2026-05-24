"""Context management - progressive compression following Claude Code architecture.

Implements Ch7 patterns:
- Four-level progressive compression (snip → microcompact → collapse → autocompact)
- Circuit breaker for compression failures
- Compact boundary messages
- Token budget tracking
- Message chain continuity preservation
"""

import os
import json
import time
import platform
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Constants (Ch7: compression thresholds)
# ---------------------------------------------------------------------------
CONTEXT_WINDOW_TOKENS = 200_000          # Total context window (200K)
STARTUP_RESERVE_TOKENS = 10_000          # System prompt + memory + AGENTS.md
COMPRESSION_RESERVE_TOKENS = 20_000      # Space for LLM compression call + summary
COMPRESS_TRIGGER_RATIO = 0.85            # Trigger compression at 85% of usable window

SNIP_MAX_AGE_MESSAGES = 20  # Messages older than this get snipped
MICROCOMPACT_KEEP_RECENT = 5  # Keep last N tool results in microcompact
COMPRESS_MARKER = "[Old tool result content cleared]"
LLM_COMPRESS_KEEP_RECENT = 10 # Keep last N messages uncompressed

# Usable window = 200K - startup reserve - compression reserve
USABLE_CONTEXT_TOKENS = CONTEXT_WINDOW_TOKENS - STARTUP_RESERVE_TOKENS - COMPRESSION_RESERVE_TOKENS
# Compression triggers when conversation reaches this many tokens
COMPRESS_TRIGGER_TOKENS = int(USABLE_CONTEXT_TOKENS * COMPRESS_TRIGGER_RATIO)


# ---------------------------------------------------------------------------
# Session dataclass
# ---------------------------------------------------------------------------
@dataclass
class Session:
    session_id: str
    messages: list = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    working_dir: str = ""
    compaction_count: int = 0

    def add_message(self, role: str, content, **kwargs):
        msg = {"role": role, "content": content}
        msg.update(kwargs)
        self.messages.append(msg)

    def get_messages(self) -> list:
        return self.messages

    def save(self, path: str):
        with open(path, "w", encoding="utf-8") as f:
            json.dump({
                "session_id": self.session_id,
                "messages": self.messages,
                "created_at": self.created_at,
                "working_dir": self.working_dir,
                "compaction_count": self.compaction_count,
            }, f, ensure_ascii=False, indent=2)

    @classmethod
    def load(cls, path: str) -> "Session":
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return cls(
            session_id=data["session_id"],
            messages=data.get("messages", []),
            created_at=data.get("created_at", time.time()),
            working_dir=data.get("working_dir", ""),
            compaction_count=data.get("compaction_count", 0),
        )


# ---------------------------------------------------------------------------
# Level 1: Snip compression (Ch7: lightest, no LLM)
# ---------------------------------------------------------------------------
def snip_compress(messages: list, max_age: int = SNIP_MAX_AGE_MESSAGES) -> list:
    """Level 1: Replace old tool results with markers.

    Why markers instead of deletion? Deleting messages breaks the
    message chain — subsequent messages may reference earlier tool_call_ids.
    """
    if len(messages) <= max_age:
        return messages

    result = []
    cutoff = len(messages) - max_age
    for i, msg in enumerate(messages):
        if i < cutoff and isinstance(msg, dict) and msg.get("role") == "tool":
            # Snip: replace content with marker, preserve structure
            snipped = dict(msg)
            snipped["content"] = COMPRESS_MARKER
            result.append(snipped)
        else:
            result.append(msg)
    return result


# ---------------------------------------------------------------------------
# Level 2: Microcompact (Ch7: time-triggered, keep recent N tool results)
# ---------------------------------------------------------------------------
def microcompact(
    messages: list, keep_recent: int = MICROCOMPACT_KEEP_RECENT
) -> list:
    """Level 2: Keep only the most recent N tool results, clear the rest.

    Compressible tool types: any message with role="tool".
    """
    # Find indices of tool result messages
    tool_indices = [
        i for i, m in enumerate(messages)
        if isinstance(m, dict) and m.get("role") == "tool"
    ]

    if len(tool_indices) <= keep_recent:
        return messages

    # Indices to compress (all except the most recent N)
    compress_indices = set(tool_indices[:-keep_recent])

    result = []
    for i, msg in enumerate(messages):
        if i in compress_indices:
            compressed = dict(msg)
            compressed["content"] = COMPRESS_MARKER
            result.append(compressed)
        else:
            result.append(msg)
    return result


# ---------------------------------------------------------------------------
# Level 3: LLM-based semantic compression (Ch7: model-driven summarization)
# ---------------------------------------------------------------------------
SUMMARIZATION_PROMPT = """You are a conversation summarizer. Summarize the following conversation history into a concise but information-dense summary.

Rules:
- Preserve all key decisions, file paths, error messages, and action outcomes
- Preserve any code snippets that were discussed or modified
- Preserve the user's stated goals and current progress
- Use bullet points for clarity
- Do NOT include tool call IDs or internal metadata
- Do NOT fabricate information that was not in the conversation
- Maximum length: 500 words

Conversation to summarize:
{conversation_text}

Produce the summary now:"""


def llm_compress(
    messages: list,
    client,
    model: str = "mimo-v2.5-pro",
    keep_recent: int = LLM_COMPRESS_KEEP_RECENT,
    max_summary_tokens: int = 1024,
) -> list | None:
    """Level 3: LLM-based semantic compression.

    Sends old messages to the LLM with a summarization prompt,
    replacing them with a single assistant summary message.
    Recent messages are kept uncompressed for continuity.

    Returns: compressed message list, or None on failure (caller falls back).
    """
    if len(messages) <= keep_recent:
        return messages

    old_messages = messages[:-keep_recent]
    recent = messages[-keep_recent:]

    # Format old messages for summarization
    parts = []
    total_chars = 0
    max_chars = 30000
    for msg in old_messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role", "unknown")
        content = msg.get("content", "")
        if not isinstance(content, str):
            content = str(content) if content else ""
        # Truncate individual long messages (e.g. large tool results)
        if len(content) > 2000:
            content = content[:2000] + "... [truncated]"
        line = f"[{role}]: {content}"
        if total_chars + len(line) > max_chars:
            parts.append(f"[{role}]: ... [remaining messages omitted]")
            break
        parts.append(line)
        total_chars += len(line)

    conversation_text = "\n".join(parts)
    prompt = SUMMARIZATION_PROMPT.format(conversation_text=conversation_text)

    try:
        response = client.chat.completions.create(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            max_completion_tokens=max_summary_tokens,
            temperature=0.3,
        )
        summary = response.choices[0].message.content
        if not summary or not summary.strip():
            return None
        return [
            {"role": "assistant", "content": "[Conversation Summary]\n" + summary.strip()}
        ] + recent
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Orphan tool result filter (prevents sending unmatched tool results)
# ---------------------------------------------------------------------------
def _filter_orphan_tool_results(messages: list) -> list:
    """Remove tool results that don't have matching tool_calls in the window."""
    # Collect valid tool_call_ids from assistant messages
    valid_ids = set()
    for msg in messages:
        if isinstance(msg, dict):
            for tc in (msg.get("tool_calls") or []):
                tc_id = tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", None)
                if tc_id:
                    valid_ids.add(tc_id)

    result = []
    for msg in messages:
        if isinstance(msg, dict) and msg.get("role") == "tool":
            tc_id = msg.get("tool_call_id")
            if tc_id in valid_ids:
                result.append(msg)
            # else: orphan, skip
        else:
            result.append(msg)
    return result


# ---------------------------------------------------------------------------
# Main compaction entry point (Ch7: progressive compression)
# ---------------------------------------------------------------------------
def estimate_tokens(messages: list) -> int:
    """Estimate token count for a message list (~4 chars per token)."""
    import json as _json
    total_chars = sum(
        len(_json.dumps(m, ensure_ascii=False)) if isinstance(m, dict)
        else len(str(m))
        for m in messages
    )
    return total_chars // 4


def compact_context(
    messages: list,
    max_messages: int = 0,
    client=None,
    model: str = "",
    estimated_tokens: int = 0,
) -> list:
    """Progressive context compression (Ch7: lightweight → heavyweight).

    Token-based compression (Claude Code style):
    - Context window: 200K tokens
    - Reserve 10K for startup (system prompt, memory, AGENTS.md)
    - Reserve 20K for compression summary output
    - Trigger LLM compression at 85% of usable window (~144.5K tokens)
    - Fallback to truncation if LLM fails

    Args:
        messages: conversation messages
        max_messages: legacy message-count limit (0 = auto from token budget)
        client: OpenAI-compatible client for LLM compression
        model: model name for LLM compression
        estimated_tokens: pre-computed token count (avoids re-estimation)
    """
    # Estimate tokens if not provided
    tokens = estimated_tokens if estimated_tokens > 0 else estimate_tokens(messages)

    # Check if compression is needed (token-based or message-count fallback)
    if tokens < COMPRESS_TRIGGER_TOKENS and (max_messages <= 0 or len(messages) <= max_messages):
        return _filter_orphan_tool_results(messages)

    # Level 3: LLM-based semantic compression (preferred)
    if client is not None:
        llm_result = llm_compress(messages, client, model or "mimo-v2.5-pro")
        if llm_result is not None:
            return llm_result
        # LLM failed, fall through to truncation

    # Fallback: progressive truncation
    # Level 1: Snip old tool results
    snipped = snip_compress(messages)

    # Level 2: Microcompact (keep recent 5 tool results)
    compacted = microcompact(snipped, keep_recent=MICROCOMPACT_KEEP_RECENT)

    # Trim: keep messages that fit within usable window
    # Estimate tokens after snip/microcompact and trim accordingly
    # Target: stay below COMPRESS_TRIGGER_TOKENS to avoid re-triggering
    target_tokens = COMPRESS_TRIGGER_TOKENS
    if max_messages > 0:
        trimmed = compacted[-max_messages:]
    else:
        # Trim until tokens fit within trigger threshold
        trimmed = compacted
        while estimate_tokens(trimmed) > target_tokens and len(trimmed) > 2:
            # Remove oldest 10% of messages at a time
            remove_count = max(1, len(trimmed) // 10)
            trimmed = trimmed[remove_count:]

    # Filter orphans after compaction
    return _filter_orphan_tool_results(trimmed)


# ---------------------------------------------------------------------------
# Compact boundary message (Ch7: metadata marker)
# ---------------------------------------------------------------------------
def make_compact_boundary(
    pre_tokens: int, pre_messages: int, trigger: str = "auto"
) -> dict:
    """Create a compact boundary message with compression metadata."""
    return {
        "role": "system",
        "content": (
            f"[Context compacted: {pre_messages} messages → "
            f"{pre_tokens} tokens, trigger={trigger}]"
        ),
        "compact_metadata": {
            "trigger": trigger,
            "pre_tokens": pre_tokens,
            "pre_messages": pre_messages,
            "timestamp": time.time(),
        },
    }


# ---------------------------------------------------------------------------
# System prompt builder
# ---------------------------------------------------------------------------
def build_system_prompt(tools_desc: str, memory_content: str = "") -> str:
    """Assemble dynamic system prompt with environment context."""
    cwd = os.getcwd()
    env_info = f"{platform.system()} {platform.release()}"

    prompt = f"""You are MiMo Harness, a capable AI assistant powered by Xiaomi MiMo model.

## Environment
- Working directory: {cwd}
- Platform: {env_info}
- Python: {platform.python_version()}

## Capabilities
You can help with:
- File operations (read, write, edit, search)
- Code writing and execution
- Web search and content fetching
- Document creation (markdown, CSV)
- Mathematical calculations
- Shell command execution

## Rules
- Use absolute file paths
- Ask for confirmation before write/deploy operations
- Explain what you're doing before using tools
- Be concise but thorough
- If a task is ambiguous, ask for clarification
- When a tool fails, analyze the error and try a different approach

## Available Tools
{tools_desc}"""

    if memory_content:
        prompt += f"\n\n## Project Memory\n{memory_content}"

    return prompt


# ---------------------------------------------------------------------------
# Memory loader (Ch6: MEMORY.md, CLAUDE.md, .mimo/memory.md)
# ---------------------------------------------------------------------------
def load_memory(project_dir: str) -> str:
    """Load project memory files.

    Reads MEMORY.md index, CLAUDE.md instructions, and .mimo/memory.md.
    Respects capacity limits: max 200 lines per file.
    """
    memory_parts = []
    for name in ["MEMORY.md", "CLAUDE.md", "AGENTS.md", ".mimo/memory.md"]:
        path = os.path.join(project_dir, name)
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    lines = f.readlines()
                # Ch6: dual capacity protection — 200 line limit
                if len(lines) > 200:
                    lines = lines[:200] + ["... [truncated to 200 lines]\n"]
                content = "".join(lines).strip()
                if content:
                    memory_parts.append(f"### {name}\n{content}")
            except Exception:
                pass
    return "\n\n".join(memory_parts)
