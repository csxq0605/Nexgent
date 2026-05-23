"""Context management - session state, message compaction, system prompt assembly."""

import os
import json
import time
import platform
from dataclasses import dataclass, field


@dataclass
class Session:
    session_id: str
    messages: list = field(default_factory=list)
    created_at: float = field(default_factory=time.time)
    working_dir: str = ""

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
        )


def compact_context(messages: list, max_messages: int = 30) -> list:
    """Keep last N messages, filtering orphan tool results."""
    if len(messages) <= max_messages:
        return messages

    result = []
    tail = messages[-max_messages:]

    # Collect valid tool_call_ids from remaining messages
    valid_ids = set()
    for msg in tail:
        if isinstance(msg, dict):
            for tc in (msg.get("tool_calls") or []):
                tc_id = tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", None)
                if tc_id:
                    valid_ids.add(tc_id)

    for msg in tail:
        if isinstance(msg, dict) and msg.get("role") == "tool":
            tc_id = msg.get("tool_call_id")
            if tc_id in valid_ids:
                result.append(msg)
        else:
            result.append(msg)

    return result


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

## Available Tools
{tools_desc}"""

    if memory_content:
        prompt += f"\n\n## Project Memory\n{memory_content}"

    return prompt


def load_memory(project_dir: str) -> str:
    """Load project memory files (MEMORY.md, CLAUDE.md, etc.)."""
    memory_parts = []
    for name in ["MEMORY.md", "CLAUDE.md", ".mimo/memory.md"]:
        path = os.path.join(project_dir, name)
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    content = f.read().strip()
                if content:
                    memory_parts.append(f"### {name}\n{content}")
            except Exception:
                pass
    return "\n\n".join(memory_parts)
