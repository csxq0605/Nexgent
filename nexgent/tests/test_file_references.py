"""Tests for the File References module."""

import os
import tempfile
import pytest
from pathlib import Path

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from nexgent.file_references import (
    FileReferenceParser, FileReferenceResolver
)


@pytest.fixture(autouse=True)
def restore_cwd():
    """Restore original working directory after each test."""
    original_cwd = os.getcwd()
    yield
    os.chdir(original_cwd)


class TestFileReferenceParser:
    """Test file reference parsing."""

    def test_parse_simple_reference(self):
        """Test parsing simple @ reference."""
        text = "Please read @README.md"
        references = FileReferenceParser.parse_references(text)
        assert len(references) == 1
        assert references[0][0] == "README.md"

    def test_parse_path_reference(self):
        """Test parsing @ reference with path."""
        text = "Check @src/main.py"
        references = FileReferenceParser.parse_references(text)
        assert len(references) == 1
        assert references[0][0] == "src/main.py"

    def test_parse_wildcard_reference(self):
        """Test parsing @ reference with wildcard."""
        text = "Show me @*.py"
        references = FileReferenceParser.parse_references(text)
        assert len(references) == 1
        assert references[0][0] == "*.py"

    def test_parse_multiple_references(self):
        """Test parsing multiple @ references."""
        text = "Compare @file1.py and @file2.py"
        references = FileReferenceParser.parse_references(text)
        assert len(references) == 2
        assert references[0][0] == "file1.py"
        assert references[1][0] == "file2.py"

    def test_parse_no_references(self):
        """Test parsing text without references."""
        text = "No references here"
        references = FileReferenceParser.parse_references(text)
        assert len(references) == 0

    def test_parse_folder_reference(self):
        """Test parsing folder reference."""
        text = "List @src/"
        references = FileReferenceParser.parse_references(text)
        assert len(references) == 1
        assert references[0][0] == "src/"

    def test_has_references(self):
        """Test checking for references."""
        assert FileReferenceResolver.has_references("Check @file.py") is True
        assert FileReferenceResolver.has_references("No references") is False


class TestFileReferenceResolver:
    """Test file reference resolution."""

    def test_resolve_existing_file(self, tmp_path):
        """Test resolving an existing file."""
        # Create test file
        test_file = tmp_path / "test.txt"
        test_file.write_text("Hello, World!")

        resolved = FileReferenceParser.resolve_reference("test.txt", str(tmp_path))
        assert len(resolved) == 1
        assert resolved[0] == str(test_file)

    def test_resolve_nonexistent_file(self, tmp_path):
        """Test resolving a non-existent file."""
        resolved = FileReferenceParser.resolve_reference("nonexistent.txt", str(tmp_path))
        assert len(resolved) == 0

    def test_resolve_directory(self, tmp_path):
        """Test resolving a directory."""
        # Create test directory
        test_dir = tmp_path / "src"
        test_dir.mkdir()

        resolved = FileReferenceParser.resolve_reference("src", str(tmp_path))
        assert len(resolved) == 1
        assert resolved[0] == str(test_dir)

    def test_resolve_wildcard(self, tmp_path):
        """Test resolving wildcard reference."""
        # Create test files
        (tmp_path / "file1.py").write_text("# file1")
        (tmp_path / "file2.py").write_text("# file2")
        (tmp_path / "file3.txt").write_text("file3")

        resolved = FileReferenceParser.resolve_reference("*.py", str(tmp_path))
        assert len(resolved) == 2
        filenames = [os.path.basename(r) for r in resolved]
        assert "file1.py" in filenames
        assert "file2.py" in filenames

    def test_read_file_content(self, tmp_path):
        """Test reading file content."""
        test_file = tmp_path / "test.py"
        test_file.write_text("print('hello')")

        content = FileReferenceParser.read_file_content(str(test_file))
        assert content == "print('hello')"

    def test_read_file_content_with_limit(self, tmp_path):
        """Test reading file content with line limit."""
        test_file = tmp_path / "large.py"
        test_file.write_text("\n".join([f"line{i}" for i in range(100)]))

        content = FileReferenceParser.read_file_content(str(test_file), max_lines=10)
        assert content is not None
        assert "truncated" in content

    def test_read_directory_structure(self, tmp_path):
        """Test reading directory structure."""
        # Create test structure
        (tmp_path / "file1.py").write_text("")
        (tmp_path / "file2.txt").write_text("")
        src_dir = tmp_path / "src"
        src_dir.mkdir()
        (src_dir / "main.py").write_text("")

        structure = FileReferenceParser.read_directory_structure(str(tmp_path))
        assert structure is not None
        assert "file1.py" in structure
        assert "file2.txt" in structure
        assert "src/" in structure

    def test_resolve_and_format_file(self, tmp_path):
        """Test resolving and formatting file reference."""
        test_file = tmp_path / "test.py"
        test_file.write_text("print('hello')")

        os.chdir(tmp_path)
        result = FileReferenceResolver.resolve_and_format("Check @test.py")
        assert "[File: @test.py]" in result
        assert "print('hello')" in result

    def test_resolve_and_format_not_found(self, tmp_path):
        """Test resolving and formatting non-existent reference."""
        os.chdir(tmp_path)
        result = FileReferenceResolver.resolve_and_format("Check @nonexistent.py")
        assert "[File not found: @nonexistent.py]" in result

    def test_resolve_and_format_directory(self, tmp_path):
        """Test resolving and formatting directory reference."""
        src_dir = tmp_path / "src"
        src_dir.mkdir()
        (src_dir / "main.py").write_text("")

        os.chdir(tmp_path)
        result = FileReferenceResolver.resolve_and_format("Check @src/")
        assert "[Directory: @src/]" in result


class TestScanCompletions:
    """Test scan_completions for interactive @ file completion."""

    def test_basic_match(self, tmp_path):
        from nexgent.file_references import scan_completions
        (tmp_path / "README.md").write_text("# Hi")
        (tmp_path / "requirements.txt").write_text("py")
        results = scan_completions("README", str(tmp_path))
        assert len(results) == 1
        assert results[0] == "README.md"

    def test_partial_match(self, tmp_path):
        from nexgent.file_references import scan_completions
        (tmp_path / "app.py").write_text("")
        (tmp_path / "api.py").write_text("")
        (tmp_path / "test.txt").write_text("")
        results = scan_completions("a", str(tmp_path))
        assert len(results) == 2
        assert "app.py" in results
        assert "api.py" in results

    def test_directory_slash_suffix(self, tmp_path):
        from nexgent.file_references import scan_completions
        (tmp_path / "src").mkdir()
        (tmp_path / "src" / "main.py").write_text("")
        results = scan_completions("", str(tmp_path))
        dirs = [r for r in results if r.endswith('/')]
        assert "src/" in dirs

    def test_nested_path(self, tmp_path):
        from nexgent.file_references import scan_completions
        src = tmp_path / "src"
        src.mkdir()
        (src / "main.py").write_text("")
        (src / "models.py").write_text("")
        results = scan_completions("src/m", str(tmp_path))
        assert "src/main.py" in results
        assert "src/models.py" in results

    def test_hidden_files_excluded(self, tmp_path):
        from nexgent.file_references import scan_completions
        (tmp_path / ".hidden").write_text("")
        (tmp_path / "visible.py").write_text("")
        results = scan_completions("", str(tmp_path))
        assert ".hidden" not in results
        assert "visible.py" in results

    def test_empty_prefix_lists_all(self, tmp_path):
        from nexgent.file_references import scan_completions
        (tmp_path / "a.py").write_text("")
        (tmp_path / "b.py").write_text("")
        results = scan_completions("", str(tmp_path))
        assert len(results) == 2

    def test_no_match(self, tmp_path):
        from nexgent.file_references import scan_completions
        (tmp_path / "a.py").write_text("")
        results = scan_completions("zzz", str(tmp_path))
        assert len(results) == 0

    def test_limit(self, tmp_path):
        from nexgent.file_references import scan_completions
        for i in range(20):
            (tmp_path / f"f{i:02d}.py").write_text("")
        results = scan_completions("f", str(tmp_path), limit=5)
        assert len(results) == 5

    def test_path_traversal_blocked(self, tmp_path):
        from nexgent.file_references import scan_completions
        results = scan_completions("../../etc", str(tmp_path))
        assert len(results) == 0

    def test_case_insensitive(self, tmp_path):
        from nexgent.file_references import scan_completions
        (tmp_path / "README.md").write_text("")
        results = scan_completions("readme", str(tmp_path))
        assert "README.md" in results

    def test_nonexistent_dir(self, tmp_path):
        from nexgent.file_references import scan_completions
        results = scan_completions("f", str(tmp_path / "nope"))
        assert len(results) == 0


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
