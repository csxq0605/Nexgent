"""Memory system - typed, persistent memory following Claude Code architecture.

Implements Ch6 patterns:
- Four memory types: user, feedback, project, reference
- MEMORY.md index with 200-line / 25KB limits
- Memory file frontmatter format (YAML)
- Memory validation (clue not conclusion)
- Path security validation
"""

import os
import re
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Optional


class MemoryType(Enum):
    """Ch6: closed four-type classification system."""
    USER = "user"          # Who is the user? Role, preferences, knowledge
    FEEDBACK = "feedback"  # What practices are validated? Corrections + confirmations
    PROJECT = "project"    # Why is it done this way? Decisions, deadlines
    REFERENCE = "reference"  # Where to find external info? Links, dashboards


@dataclass
class MemoryEntry:
    """A single memory file's metadata."""
    name: str
    description: str
    memory_type: MemoryType
    content: str
    file_path: str = ""
    created_at: float = field(default_factory=time.time)


# Ch6: MEMORY.md capacity limits
MEMORY_INDEX_MAX_LINES = 200
MEMORY_INDEX_MAX_BYTES = 25 * 1024  # 25KB

# Ch6: excluded content types (derivable from project state)
_EXCLUDED_PATTERNS = [
    r"file (structure|listing|tree)",  # Can be obtained via ls
    r"git (log|history|blame)",        # Can be obtained via git
    r"(api|endpoint) list",            # Can be read from code
    r"(package|library) version",      # Can be read from package.json
]

# YAML special characters that require quoting
_YAML_NEEDS_QUOTE = set(':#,{}[]&*?|<>!=%@`\'"\n\r\t')


def _yaml_escape(val: str) -> str:
    """Escape YAML special characters in a value string.

    Only quotes the value if it contains truly problematic YAML characters.
    """
    if any(c in _YAML_NEEDS_QUOTE for c in val):
        escaped = val.replace(chr(10), " ").replace(chr(13), "").replace('"', '\\"')
        return f'"{escaped}"'
    return val


class MemoryStore:
    """File-based persistent memory store (Ch6: memdir pattern).

    Directory structure:
        <project_dir>/.mimo/memory/
            MEMORY.md          <- Index file (loaded into context)
            user_profile.md    <- user type
            feedback_rules.md  <- feedback type
            project_state.md   <- project type
            external_links.md  <- reference type
    """

    def __init__(self, project_dir: str = "."):
        self.project_dir = os.path.abspath(project_dir)
        self.memory_dir = os.path.join(self.project_dir, ".mimo", "memory")
        self.index_path = os.path.join(self.memory_dir, "MEMORY.md")

    def ensure_dir(self):
        os.makedirs(self.memory_dir, exist_ok=True)

    def _validate_path(self, path: str) -> Optional[str]:
        """Ch6: path security validation against directory traversal."""
        # Reject null bytes first (before Path operations which may fail on Linux)
        if "\0" in path:
            return "Path contains null bytes"

        resolved = Path(path).resolve()
        memory_resolved = Path(self.memory_dir).resolve()

        # Must be under memory directory
        if not resolved.is_relative_to(memory_resolved):
            return f"Path '{path}' is outside memory directory"

        return None

    def save_memory(
        self,
        name: str,
        memory_type: MemoryType,
        description: str,
        content: str,
    ) -> str:
        """Save a memory to its own file with frontmatter."""
        self.ensure_dir()

        # Sanitize filename
        safe_name = re.sub(r'[^a-z0-9_-]', '', name.lower().replace(' ', '-'))
        if not safe_name:
            safe_name = f"memory-{int(time.time())}"
        filename = f"{safe_name}.md"
        filepath = os.path.join(self.memory_dir, filename)

        # Build frontmatter content (Ch6: YAML frontmatter format)
        # L4: Escape YAML special characters in name and description
        file_content = f"""---
name: {_yaml_escape(name)}
description: {_yaml_escape(description)}
metadata:
  type: {memory_type.value}
  created: {time.strftime('%Y-%m-%d %H:%M:%S')}
---

{content}
"""

        with open(filepath, "w", encoding="utf-8") as f:
            f.write(file_content)

        # Update index
        self._update_index()
        return filepath

    def _update_index(self):
        """Rebuild MEMORY.md index from all memory files.

        Ch6: index entries are one line each, max 150 chars.
        """
        self.ensure_dir()
        entries = []

        for filename in sorted(os.listdir(self.memory_dir)):
            if not filename.endswith(".md") or filename == "MEMORY.md":
                continue
            filepath = os.path.join(self.memory_dir, filename)
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    content = f.read()

                # Parse frontmatter
                name, description = self._parse_frontmatter(content, filename)
                # Ch6: index entry format, max 150 chars
                hook = description[:140] if len(description) > 140 else description
                entries.append(f"- [{name}]({filename}) — {hook}")
            except Exception:
                continue

        # Ch6: dual capacity protection
        # First: line limit (200 lines)
        if len(entries) > MEMORY_INDEX_MAX_LINES:
            entries = entries[:MEMORY_INDEX_MAX_LINES]
            entries.append("... [truncated to 200 entries]")

        # Write index
        index_content = "# Memory Index\n\n" + "\n".join(entries) + "\n"

        # Second: byte limit (25KB) — truncate at character boundary to avoid
        # corrupting multi-byte UTF-8 characters (e.g. Chinese, emoji).
        encoded = index_content.encode("utf-8")
        if len(encoded) > MEMORY_INDEX_MAX_BYTES:
            lo, hi = 0, len(index_content)
            while lo < hi:
                mid = (lo + hi + 1) // 2
                if len(index_content[:mid].encode("utf-8")) <= MEMORY_INDEX_MAX_BYTES:
                    lo = mid
                else:
                    hi = mid - 1
            index_content = index_content[:lo] + "\n... [truncated to 25KB]\n"

        with open(self.index_path, "w", encoding="utf-8") as f:
            f.write(index_content)

    def _parse_frontmatter(self, content: str, filename: str) -> tuple[str, str]:
        """Parse YAML frontmatter from a memory file."""
        if content.startswith("---"):
            parts = re.split(r'^---\s*$', content, maxsplit=2, flags=re.MULTILINE)
            if len(parts) >= 3:
                frontmatter = parts[1].strip()
                name = filename.replace(".md", "")
                description = ""
                for line in frontmatter.split("\n"):
                    if line.startswith("name:"):
                        name = line.split(":", 1)[1].strip()
                    elif line.startswith("description:"):
                        description = line.split(":", 1)[1].strip()
                return name, description
        return filename.replace(".md", ""), ""

    def load_index(self) -> str:
        """Load MEMORY.md index content for context injection.

        Ch6: Only the index is loaded at session start (first 200 lines / 25KB).
        Topic files are loaded on-demand via load_topic().
        """
        if os.path.exists(self.index_path):
            try:
                with open(self.index_path, "r", encoding="utf-8") as f:
                    content = f.read().strip()
                if content:
                    return content
            except Exception:
                pass
        return ""

    def load_topic(self, topic_name: str) -> str:
        """Load a specific topic file on-demand (Ch6: tiered loading pattern).

        Topic files like 'debugging.md' are NOT loaded at session start.
        Claude reads them via tools when needed. This method supports that
        by providing programmatic access to a single topic's content.

        Args:
            topic_name: Name of the topic file (with or without .md extension)

        Returns:
            Topic file content, or empty string if not found.
        """
        if not topic_name.endswith(".md"):
            topic_name = f"{topic_name}.md"
        filepath = os.path.join(self.memory_dir, topic_name)
        # Path security — validate before existence check to prevent oracle
        error = self._validate_path(filepath)
        if error:
            return ""
        if not os.path.exists(filepath):
            return ""
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                return f.read().strip()
        except Exception:
            return ""

    def list_topic_names(self) -> list[str]:
        """List available topic file names (for tool descriptions)."""
        if not os.path.exists(self.memory_dir):
            return []
        names = []
        for filename in sorted(os.listdir(self.memory_dir)):
            if filename.endswith(".md") and filename != "MEMORY.md":
                names.append(filename)
        return names

    def list_memories(self) -> list[MemoryEntry]:
        """List all stored memories."""
        if not os.path.exists(self.memory_dir):
            return []

        entries = []
        for filename in sorted(os.listdir(self.memory_dir)):
            if not filename.endswith(".md") or filename == "MEMORY.md":
                continue
            filepath = os.path.join(self.memory_dir, filename)
            try:
                with open(filepath, "r", encoding="utf-8") as f:
                    content = f.read()
                name, description = self._parse_frontmatter(content, filename)

                # L5: Parse type from frontmatter only (between --- markers)
                memory_type = MemoryType.PROJECT  # default
                in_frontmatter = False
                for line in content.split("\n"):
                    if line.strip() == "---":
                        in_frontmatter = not in_frontmatter
                        continue
                    if in_frontmatter and "type:" in line:
                        for mt in MemoryType:
                            if mt.value in line:
                                memory_type = mt
                                break
                        break

                entries.append(MemoryEntry(
                    name=name,
                    description=description,
                    memory_type=memory_type,
                    content=content,
                    file_path=filepath,
                ))
            except Exception:
                continue
        return entries

    def delete_memory(self, name: str) -> bool:
        """Delete a memory file by name."""
        safe_name = re.sub(r'[^a-z0-9_-]', '', name.lower().replace(' ', '-'))
        filename = f"{safe_name}.md"
        filepath = os.path.join(self.memory_dir, filename)
        if os.path.exists(filepath):
            os.remove(filepath)
            self._update_index()
            return True
        return False

    def validate_memory(self, entry: MemoryEntry) -> list[str]:
        """Ch6: validate memory is still current (clue not conclusion).

        Returns list of validation warnings.
        """
        warnings = []
        content = entry.content.lower()

        # Check if referenced files still exist
        file_refs = re.findall(r'(?:file|path|directory):\s*[`"]?([^\s`"]+)', content)
        for ref in file_refs:
            if not os.path.exists(ref):
                warnings.append(f"Referenced path may not exist: {ref}")

        # Check for stale relative dates
        relative_date_patterns = [
            r'\b(yesterday|today|tomorrow|last (week|month|year)|next (week|month|year))\b',
            r'\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b',
        ]
        for pattern in relative_date_patterns:
            if re.search(pattern, content):
                warnings.append("Contains relative dates — should use absolute dates")
                break

        return warnings
