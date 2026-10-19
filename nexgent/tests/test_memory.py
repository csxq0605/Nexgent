"""Tests for the memory system (Ch6 patterns)."""

import pytest
import os
from nexgent.memory import (
    MemoryType, MemoryEntry, MemoryStore,
    MEMORY_INDEX_MAX_LINES, MEMORY_INDEX_MAX_BYTES,
)


class TestMemoryStore:
    def test_ensure_dir(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        store.ensure_dir()
        assert os.path.exists(store.memory_dir)

    def test_save_and_load(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        filepath = store.save_memory(
            name="test-memory",
            memory_type=MemoryType.USER,
            description="Test user memory",
            content="User is a senior Python developer",
        )
        assert os.path.exists(filepath)

        # Check frontmatter
        with open(filepath, "r") as f:
            content = f.read()
        assert "name: test-memory" in content
        assert "type: user" in content
        assert "User is a senior Python developer" in content

    def test_index_updated(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        store.save_memory(
            name="memory-1",
            memory_type=MemoryType.USER,
            description="First memory",
            content="Content 1",
        )
        store.save_memory(
            name="memory-2",
            memory_type=MemoryType.FEEDBACK,
            description="Second memory",
            content="Content 2",
        )

        index = store.load_index()
        assert "memory-1" in index
        assert "memory-2" in index

    def test_list_memories(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        store.save_memory(
            name="user-pref",
            memory_type=MemoryType.USER,
            description="User preferences",
            content="Prefers dark mode",
        )
        store.save_memory(
            name="project-state",
            memory_type=MemoryType.PROJECT,
            description="Project decision",
            content="Using event-driven architecture",
        )

        memories = store.list_memories()
        assert len(memories) == 2
        types = {m.memory_type for m in memories}
        assert MemoryType.USER in types
        assert MemoryType.PROJECT in types

    def test_delete_memory(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        store.save_memory(
            name="to-delete",
            memory_type=MemoryType.REFERENCE,
            description="Will be deleted",
            content="Temporary link",
        )
        assert store.delete_memory("to-delete")
        assert len(store.list_memories()) == 0

    def test_delete_nonexistent(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        assert not store.delete_memory("nonexistent")

    def test_validate_memory_stale_dates(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        entry = MemoryEntry(
            name="test",
            description="test",
            memory_type=MemoryType.PROJECT,
            content="Meeting next Thursday about the deadline",
        )
        warnings = store.validate_memory(entry)
        assert any("relative dates" in w.lower() for w in warnings)

    def test_validate_memory_missing_file_ref(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        entry = MemoryEntry(
            name="test",
            description="test",
            memory_type=MemoryType.PROJECT,
            content="The config is at file: /nonexistent/path/config.json",
        )
        warnings = store.validate_memory(entry)
        assert any("may not exist" in w.lower() for w in warnings)

    def test_validate_memory_ok(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        entry = MemoryEntry(
            name="test",
            description="test",
            memory_type=MemoryType.USER,
            content="User prefers TypeScript over JavaScript",
        )
        warnings = store.validate_memory(entry)
        assert len(warnings) == 0

    def test_path_security(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        # Path validation should reject paths outside memory dir
        err = store._validate_path("../../etc/passwd")
        assert err is not None

    def test_path_security_null_bytes(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        err = store._validate_path("foo\0.txt")
        assert err is not None

    def test_index_line_limit(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        # Create many memories to test line limit
        for i in range(250):
            store.save_memory(
                name=f"memory-{i:03d}",
                memory_type=MemoryType.PROJECT,
                description=f"Memory number {i}",
                content=f"Content {i}",
            )

        index = store.load_index()
        lines = index.strip().split("\n")
        # Should be capped at ~200 entries + header
        assert len(lines) <= MEMORY_INDEX_MAX_LINES + 3  # header + entries + truncation note

    def test_load_empty_index(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        assert store.load_index() == ""


class TestLoadTopic:
    """Tests MemoryStore.load_topic() — low-level topic file loading.
    NOTE: TestLoadTopicOnDemand in test_context.py tests the higher-level
    load_topic_on_demand() wrapper with CWD-relative path resolution."""
    def test_load_existing_topic(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        store.ensure_dir()
        topic_dir = store.memory_dir
        # Create a topic file
        topic_path = os.path.join(topic_dir, "my_topic.md")
        with open(topic_path, "w", encoding="utf-8") as f:
            f.write("---\nname: my_topic\n---\nTopic content here")

        result = store.load_topic("my_topic")
        assert "Topic content here" in result

    def test_load_topic_auto_appends_md(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        store.ensure_dir()
        topic_path = os.path.join(store.memory_dir, "no_ext.md")
        with open(topic_path, "w", encoding="utf-8") as f:
            f.write("content")

        result = store.load_topic("no_ext")
        assert "content" in result

    def test_load_topic_nonexistent(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        store.ensure_dir()
        result = store.load_topic("does_not_exist")
        assert result == ""

    def test_load_topic_path_traversal_blocked(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        store.ensure_dir()
        result = store.load_topic("../../etc/passwd")
        assert result == ""

    def test_load_topic_empty_dir(self, tmp_path):
        store = MemoryStore(str(tmp_path))
        result = store.load_topic("anything")
        assert result == ""


class TestMemoryIndexMaxBytes:
    """Test MEMORY_INDEX_MAX_BYTES limit for the memory index."""

    def test_index_respects_byte_limit(self, tmp_path):
        """Index should be truncated when it exceeds MEMORY_INDEX_MAX_BYTES."""
        store = MemoryStore(str(tmp_path))
        # Create memories with long descriptions to exceed 25KB
        for i in range(50):
            store.save_memory(
                name=f"large-memory-{i:03d}",
                memory_type=MemoryType.PROJECT,
                description=f"Description {i}: " + "x" * 500,
                content=f"Content {i}",
            )

        index = store.load_index()
        encoded_size = len(index.encode("utf-8"))
        # Should be capped at roughly MEMORY_INDEX_MAX_BYTES + some overhead
        assert encoded_size <= MEMORY_INDEX_MAX_BYTES + 2000  # allow header overhead

    def test_small_index_not_truncated(self, tmp_path):
        """Small index should not be truncated."""
        store = MemoryStore(str(tmp_path))
        store.save_memory(
            name="small",
            memory_type=MemoryType.USER,
            description="Short",
            content="Content",
        )
        index = store.load_index()
        assert "small" in index
        assert "Short" in index
