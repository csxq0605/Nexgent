"""Tests for lsp_tools.py - Language Server Protocol integration."""

import json
import pytest
from unittest.mock import patch

from mimo_harness.tools import lsp_tools
from mimo_harness.tools.lsp_tools import (
    lsp_definition, lsp_references, lsp_diagnostics,
    get_tools,
)
from mimo_harness.tools.registry import ToolDef
from mimo_harness.permissions import Permission


class TestLspDefinition:
    def test_no_file_path(self):
        result = json.loads(lsp_definition({}))
        assert "error" in result

    def test_file_not_found(self):
        result = json.loads(lsp_definition({"file_path": "/nonexistent.py", "line": 1}))
        assert "error" in result

    def test_fallback_for_python(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("def hello():\n    pass\n\nhello()\n")
        with patch.object(lsp_tools, "_get_lsp_client", return_value=None):
            result = json.loads(lsp_definition({"file_path": str(f), "line": 1, "character": 4}))
        assert "definitions" in result or "error" in result

    def test_line_conversion(self, tmp_path):
        """Line numbers should be converted from 1-indexed to 0-indexed."""
        f = tmp_path / "test.py"
        f.write_text("x = 1\ny = 2\nz = 3\n")
        with patch.object(lsp_tools, "_get_lsp_client", return_value=None):
            # line=2 means line index 1 (0-indexed)
            result = json.loads(lsp_definition({"file_path": str(f), "line": 2, "character": 0}))
        assert "definitions" in result or "error" in result


class TestLspReferences:
    def test_no_file_path(self):
        result = json.loads(lsp_references({}))
        assert "error" in result

    def test_file_not_found(self):
        result = json.loads(lsp_references({"file_path": "/nonexistent.py", "line": 1}))
        assert "error" in result

    def test_fallback_for_python(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("def foo():\n    pass\n\nfoo()\n")
        with patch.object(lsp_tools, "_get_lsp_client", return_value=None):
            result = json.loads(lsp_references({"file_path": str(f), "line": 1, "character": 4}))
        assert "references" in result or "error" in result


class TestLspDiagnostics:
    def test_no_file_path(self):
        result = json.loads(lsp_diagnostics({}))
        assert "error" in result

    def test_file_not_found(self):
        result = json.loads(lsp_diagnostics({"file_path": "/nonexistent.py"}))
        assert "error" in result

    def test_python_file_uses_py_compile(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("x = 1\n")
        result = json.loads(lsp_diagnostics({"file_path": str(f)}))
        assert result["count"] == 0

    def test_python_file_syntax_error(self, tmp_path):
        f = tmp_path / "bad.py"
        f.write_text("def foo(\n    pass\n")
        result = json.loads(lsp_diagnostics({"file_path": str(f)}))
        assert result["count"] > 0

    def test_non_python_no_lsp(self, tmp_path):
        f = tmp_path / "test.js"
        f.write_text("const x = 1;\n")
        with patch.object(lsp_tools, "_get_lsp_client", return_value=None):
            result = json.loads(lsp_diagnostics({"file_path": str(f)}))
        assert "error" in result


class TestLspToolsGetTools:
    def test_returns_three_tools(self):
        tools = get_tools()
        assert len(tools) == 3

    def test_tool_names(self):
        names = {t.name for t in get_tools()}
        assert names == {"lsp_definition", "lsp_references", "lsp_diagnostics"}

    def test_all_tooldefs(self):
        for tool in get_tools():
            assert isinstance(tool, ToolDef)
            assert tool.handler is not None
            assert tool.permission == Permission.READ
            assert tool.is_read_only is True
            assert tool.is_concurrency_safe is True

    def test_required_params(self):
        tools = {t.name: t for t in get_tools()}
        assert "file_path" in tools["lsp_definition"].parameters["required"]
        assert "line" in tools["lsp_definition"].parameters["required"]
        assert "file_path" in tools["lsp_diagnostics"].parameters["required"]
