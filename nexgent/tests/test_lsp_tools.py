"""Tests for lsp_tools.py - Language Server Protocol integration."""

import json
import pytest

from nexgent.tools import lsp_tools
from nexgent.tools.lsp_tools import (
    lsp_definition, lsp_references, lsp_diagnostics,
    get_tools,
)
from nexgent.tools.registry import ToolDef
from nexgent.permissions import Permission


class TestLspDefinition:
    def test_no_file_path(self):
        result = json.loads(lsp_definition({}))
        assert "error" in result

    def test_file_not_found(self):
        result = json.loads(lsp_definition({"file_path": "/nonexistent.py", "line": 1}))
        assert "error" in result

    def test_fallback_for_python(self, tmp_path, monkeypatch):
        f = tmp_path / "test.py"
        f.write_text("def hello():\n    pass\n\nhello()\n")
        monkeypatch.setattr(lsp_tools, "_get_lsp_client", lambda _: None)
        result = json.loads(lsp_definition({"file_path": str(f), "line": 1, "character": 4}))
        assert "definitions" in result
        assert len(result["definitions"]) > 0
        assert result.get("method") == "grep_fallback"

    def test_line_conversion(self, tmp_path, monkeypatch):
        """Line numbers should be converted from 1-indexed to 0-indexed."""
        f = tmp_path / "test.py"
        f.write_text("x = 1\nhello = 2\nz = hello\n")
        monkeypatch.setattr(lsp_tools, "_get_lsp_client", lambda _: None)
        # line=2 means 1-indexed line 2, which is "hello = 2" (0-indexed line 1)
        result = json.loads(lsp_definition({"file_path": str(f), "line": 2, "character": 0}))
        assert "definitions" in result


class TestLspReferences:
    def test_no_file_path(self):
        result = json.loads(lsp_references({}))
        assert "error" in result

    def test_file_not_found(self):
        result = json.loads(lsp_references({"file_path": "/nonexistent.py", "line": 1}))
        assert "error" in result

    def test_fallback_for_python(self, tmp_path, monkeypatch):
        f = tmp_path / "test.py"
        f.write_text("def foo():\n    pass\n\nfoo()\n")
        monkeypatch.setattr(lsp_tools, "_get_lsp_client", lambda _: None)
        result = json.loads(lsp_references({"file_path": str(f), "line": 1, "character": 4}))
        assert "references" in result


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

    def test_non_python_no_lsp(self, tmp_path, monkeypatch):
        f = tmp_path / "test.js"
        f.write_text("const x = 1;\n")
        monkeypatch.setattr(lsp_tools, "_get_lsp_client", lambda _: None)
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
            # lsp_diagnostics is NOT concurrency-safe (mutates _opened_files, calls sleep)
            expected_safe = tool.name != "lsp_diagnostics"
            assert tool.is_concurrency_safe is expected_safe, f"{tool.name} concurrency_safe mismatch"

    def test_required_params(self):
        tools = {t.name: t for t in get_tools()}
        assert "file_path" in tools["lsp_definition"].parameters["required"]
        assert "line" in tools["lsp_definition"].parameters["required"]
        assert "file_path" in tools["lsp_diagnostics"].parameters["required"]
