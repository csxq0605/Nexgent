"""Tests for notebook_edit tool (replace/insert/delete modes)."""

import json
import os
import pytest
from nexgent.tools.notebook_tools import notebook_edit, get_tools
from nexgent.tools import file_ops


@pytest.fixture(autouse=True)
def _allow_tmp_path(tmp_path, monkeypatch):
    """Allow notebook tools to write to the test temp directory."""
    monkeypatch.setattr(file_ops, "_ALLOWED_WRITE_DIR", tmp_path)


def _make_notebook(cells=None, tmp_path=None, filename="test.ipynb"):
    """Helper to create a minimal .ipynb file and return its path."""
    nb = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {"kernelspec": {"display_name": "Python 3"}},
        "cells": cells or [
            {
                "cell_type": "code",
                "id": "cell-1",
                "source": ["print('hello')"],
                "metadata": {},
                "outputs": [],
            },
            {
                "cell_type": "code",
                "id": "cell-2",
                "source": ["x = 42"],
                "metadata": {},
                "outputs": [],
            },
            {
                "cell_type": "markdown",
                "id": "cell-3",
                "source": ["# Title"],
                "metadata": {},
                "outputs": None,
            },
        ],
    }
    path = tmp_path / filename
    path.write_text(json.dumps(nb, indent=1), encoding="utf-8")
    return str(path)


class TestNotebookEditReplace:
    """Test replace mode."""

    def test_replace_by_cell_id(self, tmp_path):
        path = _make_notebook(tmp_path=tmp_path)
        result = json.loads(notebook_edit({
            "notebook_path": path,
            "cell_id": "cell-1",
            "new_source": "print('world')",
            "edit_mode": "replace",
        }))
        assert result["status"] == "edited"
        assert result["mode"] == "replace"

        # Verify file was updated
        with open(path, encoding="utf-8") as f:
            nb = json.load(f)
        assert nb["cells"][0]["source"] == ["print('world')"]

    def test_replace_by_index(self, tmp_path):
        path = _make_notebook(tmp_path=tmp_path)
        result = json.loads(notebook_edit({
            "notebook_path": path,
            "cell_id": "1",
            "new_source": "y = 99",
            "edit_mode": "replace",
        }))
        assert result["status"] == "edited"

        with open(path, encoding="utf-8") as f:
            nb = json.load(f)
        assert nb["cells"][1]["source"] == ["y = 99"]

    def test_replace_changes_cell_type(self, tmp_path):
        path = _make_notebook(tmp_path=tmp_path)
        result = json.loads(notebook_edit({
            "notebook_path": path,
            "cell_id": "cell-1",
            "new_source": "# Markdown header",
            "cell_type": "markdown",
            "edit_mode": "replace",
        }))
        assert result["status"] == "edited"

        with open(path, encoding="utf-8") as f:
            nb = json.load(f)
        assert nb["cells"][0]["cell_type"] == "markdown"

    def test_replace_preserves_cell_type_when_not_specified(self, tmp_path):
        path = _make_notebook(tmp_path=tmp_path)
        result = json.loads(notebook_edit({
            "notebook_path": path,
            "cell_id": "cell-1",
            "new_source": "print('updated')",
            "edit_mode": "replace",
        }))
        assert result["status"] == "edited"

        with open(path, encoding="utf-8") as f:
            nb = json.load(f)
        assert nb["cells"][0]["cell_type"] == "code"

    def test_replace_missing_cell_id_returns_error(self, tmp_path):
        path = _make_notebook(tmp_path=tmp_path)
        result = json.loads(notebook_edit({
            "notebook_path": path,
            "cell_id": "nonexistent-cell",
            "new_source": "content",
            "edit_mode": "replace",
        }))
        assert "error" in result
        assert "not found" in result["error"].lower() or "Cannot replace" in result["error"]


class TestNotebookEditInsert:
    """Test insert mode."""

    def test_insert_after_cell_id(self, tmp_path):
        path = _make_notebook(tmp_path=tmp_path)
        result = json.loads(notebook_edit({
            "notebook_path": path,
            "cell_id": "cell-1",
            "new_source": "print('inserted')",
            "cell_type": "code",
            "edit_mode": "insert",
        }))
        assert result["status"] == "edited"
        assert result["mode"] == "insert"

        with open(path, encoding="utf-8") as f:
            nb = json.load(f)
        # Should have 4 cells now
        assert len(nb["cells"]) == 4
        # New cell should be at index 1 (after cell-1)
        assert nb["cells"][1]["source"] == ["print('inserted')"]
        assert nb["cells"][1]["cell_type"] == "code"

    def test_insert_markdown_cell(self, tmp_path):
        path = _make_notebook(tmp_path=tmp_path)
        result = json.loads(notebook_edit({
            "notebook_path": path,
            "cell_id": "cell-1",
            "new_source": "## Subheading",
            "cell_type": "markdown",
            "edit_mode": "insert",
        }))
        assert result["status"] == "edited"

        with open(path, encoding="utf-8") as f:
            nb = json.load(f)
        inserted = nb["cells"][1]
        assert inserted["cell_type"] == "markdown"
        assert inserted["source"] == ["## Subheading"]
        assert inserted["outputs"] is None

    def test_insert_without_cell_id_appends(self, tmp_path):
        path = _make_notebook(tmp_path=tmp_path)
        result = json.loads(notebook_edit({
            "notebook_path": path,
            "new_source": "print('appended')",
            "cell_type": "code",
            "edit_mode": "insert",
        }))
        assert result["status"] == "edited"

        with open(path, encoding="utf-8") as f:
            nb = json.load(f)
        assert len(nb["cells"]) == 4
        assert nb["cells"][3]["source"] == ["print('appended')"]

    def test_insert_default_cell_type_is_code(self, tmp_path):
        path = _make_notebook(tmp_path=tmp_path)
        result = json.loads(notebook_edit({
            "notebook_path": path,
            "cell_id": "cell-1",
            "new_source": "pass",
            "edit_mode": "insert",
        }))
        assert result["status"] == "edited"

        with open(path, encoding="utf-8") as f:
            nb = json.load(f)
        assert nb["cells"][1]["cell_type"] == "code"
        assert nb["cells"][1]["outputs"] == []


class TestNotebookEditDelete:
    """Test delete mode."""

    def test_delete_by_cell_id(self, tmp_path):
        path = _make_notebook(tmp_path=tmp_path)
        result = json.loads(notebook_edit({
            "notebook_path": path,
            "cell_id": "cell-2",
            "new_source": "",
            "edit_mode": "delete",
        }))
        assert result["status"] == "edited"
        assert result["mode"] == "delete"

        with open(path, encoding="utf-8") as f:
            nb = json.load(f)
        assert len(nb["cells"]) == 2
        # cell-2 should be gone
        ids = [c.get("id") for c in nb["cells"]]
        assert "cell-2" not in ids

    def test_delete_by_index(self, tmp_path):
        path = _make_notebook(tmp_path=tmp_path)
        result = json.loads(notebook_edit({
            "notebook_path": path,
            "cell_id": "0",
            "new_source": "",
            "edit_mode": "delete",
        }))
        assert result["status"] == "edited"

        with open(path, encoding="utf-8") as f:
            nb = json.load(f)
        assert len(nb["cells"]) == 2
        # First cell (cell-1) should be gone
        assert nb["cells"][0].get("id") == "cell-2"

    def test_delete_nonexistent_cell_returns_error(self, tmp_path):
        path = _make_notebook(tmp_path=tmp_path)
        result = json.loads(notebook_edit({
            "notebook_path": path,
            "cell_id": "nonexistent",
            "new_source": "",
            "edit_mode": "delete",
        }))
        assert "error" in result
        # The cell lookup fails first ("Cell 'nonexistent' not found")
        # before the delete logic runs
        assert "not found" in result["error"].lower() or "Cannot delete" in result["error"]


class TestNotebookEditErrors:
    """Test error cases."""

    def test_missing_file_returns_error(self):
        result = json.loads(notebook_edit({
            "notebook_path": "/nonexistent/path/notebook.ipynb",
            "cell_id": "cell-1",
            "new_source": "content",
            "edit_mode": "replace",
        }))
        assert "error" in result

    def test_invalid_cell_id_returns_error(self, tmp_path):
        path = _make_notebook(tmp_path=tmp_path)
        result = json.loads(notebook_edit({
            "notebook_path": path,
            "cell_id": "not-an-id-or-index",
            "new_source": "content",
            "edit_mode": "replace",
        }))
        assert "error" in result

    def test_replace_with_no_cell_id_and_no_cells(self, tmp_path):
        """Replace mode with empty cell list and no cell_id."""
        path = _make_notebook(cells=[], tmp_path=tmp_path)
        result = json.loads(notebook_edit({
            "notebook_path": path,
            "new_source": "content",
            "edit_mode": "replace",
        }))
        assert "error" in result

    def test_invalid_notebook_json(self, tmp_path):
        """File exists but is not valid JSON."""
        bad_file = tmp_path / "bad.ipynb"
        bad_file.write_text("{invalid json!!!", encoding="utf-8")
        result = json.loads(notebook_edit({
            "notebook_path": str(bad_file),
            "cell_id": "cell-1",
            "new_source": "content",
        }))
        assert "error" in result


class TestNotebookToolsGetTools:
    """Test get_tools() returns proper ToolDef."""

    def test_get_tools_returns_list(self):
        tools = get_tools()
        assert isinstance(tools, list)
        assert len(tools) == 1

    def test_tool_def_properties(self):
        tool = get_tools()[0]
        assert tool.name == "notebook_edit"
        assert "notebook" in tool.description.lower()
        assert tool.handler == notebook_edit
        assert not tool.is_read_only
        assert not tool.is_concurrency_safe
        assert "notebook_path" in tool.parameters["properties"]
        assert "new_source" in tool.parameters["properties"]
