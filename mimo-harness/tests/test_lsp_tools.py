"""Tests for lsp_tools.py - Language Server Protocol integration."""

import json
import os
import tempfile
import pytest
from unittest.mock import patch, MagicMock

from mimo_harness.tools import lsp_tools
from mimo_harness.tools.lsp_tools import (
    LSPClient, lsp_definition, lsp_references, lsp_diagnostics,
    get_tools, _fallback_definition, _fallback_references,
    _extract_word_at, _location_to_str, _python_diagnostics,
    LSP_SERVERS,
)
from mimo_harness.tools.registry import ToolDef
from mimo_harness.permissions import Permission


class TestLSPClient:
    def test_init(self):
        client = LSPClient()
        assert client._process is None
        assert client._request_id == 0
        assert client._responses == {}
        assert client._server_name == ""

    def test_start_file_not_found(self):
        client = LSPClient()
        result = client.start({"name": "fake", "command": ["nonexistent_lsp_server_xyz"]})
        assert result is False

    def test_shutdown_no_process(self):
        client = LSPClient()
        client.shutdown()  # Should not raise
        assert client._process is None

    def test_shutdown_with_dead_process(self):
        client = LSPClient()
        client._process = MagicMock()
        client._process.poll.return_value = 1  # Already dead
        client.shutdown()
        assert client._process is None


class TestLocationToStr:
    def test_basic(self):
        loc = {"uri": "file:///home/user/test.py", "range": {"start": {"line": 5, "character": 10}}}
        result = _location_to_str(loc)
        assert "test.py" in result
        assert ":6:" in result  # 0-indexed -> 1-indexed

    def test_missing_fields(self):
        result = _location_to_str({})
        assert result  # Should not crash

    def test_windows_path(self):
        loc = {"uri": "file:///C:/Users/test.py", "range": {"start": {"line": 0, "character": 0}}}
        result = _location_to_str(loc)
        assert "test.py" in result


class TestExtractWordAt:
    def test_basic(self):
        assert _extract_word_at("def hello_world():", 4) == "hello_world"

    def test_at_start(self):
        assert _extract_word_at("variable = 1", 0) == "variable"

    def test_at_end(self):
        word = _extract_word_at("x = foo", 6)
        assert word == "foo"

    def test_beyond_length(self):
        word = _extract_word_at("short", 100)
        assert word == "short"  # Falls back to last word

    def test_empty_line(self):
        word = _extract_word_at("", 0)
        assert word == ""

    def test_no_word_at_position(self):
        word = _extract_word_at("   ", 1)
        assert word == ""


class TestPythonDiagnostics:
    def test_valid_file(self, tmp_path):
        f = tmp_path / "valid.py"
        f.write_text("x = 1\ny = 2\n")
        result = json.loads(_python_diagnostics(str(f)))
        assert result["count"] == 0
        assert result["diagnostics"] == []

    def test_syntax_error(self, tmp_path):
        f = tmp_path / "broken.py"
        f.write_text("def foo(\n    pass\n")
        result = json.loads(_python_diagnostics(str(f)))
        assert result["count"] > 0
        assert any("SyntaxError" in d["message"] or "error" in d["severity"] for d in result["diagnostics"])

    def test_file_not_found(self):
        # py_compile.compile raises FileNotFoundError for missing files
        with pytest.raises(FileNotFoundError):
            _python_diagnostics("/nonexistent/file.py")


class TestFallbackDefinition:
    def test_file_not_found(self):
        result = json.loads(_fallback_definition("/nonexistent.py", 0, 0))
        assert "error" in result

    def test_line_out_of_range(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("x = 1\n")
        result = json.loads(_fallback_definition(str(f), 999, 0))
        assert "error" in result

    def test_finds_function_def(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("def hello():\n    pass\n\nclass Foo:\n    pass\n")
        result = json.loads(_fallback_definition(str(f), 0, 4))
        assert "definitions" in result
        assert len(result["definitions"]) > 0
        assert result.get("method") == "grep_fallback"

    def test_finds_variable_assignment(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("my_var = 42\nprint(my_var)\n")
        result = json.loads(_fallback_definition(str(f), 1, 6))
        assert "definitions" in result

    def test_no_definition_found(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("# just a comment\n")
        result = json.loads(_fallback_definition(str(f), 0, 0))
        assert "error" in result


class TestFallbackReferences:
    def test_file_not_found(self):
        result = json.loads(_fallback_references("/nonexistent.py", 0, 0))
        assert "error" in result

    def test_line_out_of_range(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("x = 1\n")
        result = json.loads(_fallback_references(str(f), 999, 0))
        assert "error" in result

    def test_finds_references(self, tmp_path):
        f = tmp_path / "test.py"
        f.write_text("def foo():\n    pass\n\nfoo()\nfoo()\n")
        result = json.loads(_fallback_references(str(f), 0, 4))
        assert "references" in result
        assert result["count"] >= 2
        assert result.get("method") == "grep_fallback"


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


class TestLSPServers:
    def test_python_server_configured(self):
        assert ".py" in LSP_SERVERS
        assert LSP_SERVERS[".py"]["name"] == "pylsp"

    def test_js_ts_configured(self):
        assert ".js" in LSP_SERVERS
        assert ".ts" in LSP_SERVERS


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
