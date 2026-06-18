import json
import os
import uuid
from pathlib import Path
from .registry import ToolDef
from .file_ops import _validate_read_path, _validate_write_path
from ..permissions import Permission


def notebook_edit(params: dict) -> str:
    """Edit a Jupyter notebook cell."""
    notebook_path = params.get("notebook_path", "")
    cell_id = params.get("cell_id", "")
    new_source = params.get("new_source", "")
    cell_type = params.get("cell_type", None)
    edit_mode = params.get("edit_mode", "replace")  # replace, insert, delete

    # new_source is required for replace and insert modes
    if edit_mode in ("replace", "insert") and not new_source:
        return json.dumps({"error": f"new_source is required for {edit_mode} mode"})

    # Validate path before any file operations
    read_err = _validate_read_path(notebook_path)
    if read_err:
        return json.dumps({"error": read_err})
    write_err = _validate_write_path(notebook_path)
    if write_err:
        return json.dumps({"error": write_err})

    try:
        with open(notebook_path, "r", encoding="utf-8") as f:
            nb = json.load(f)
    except Exception as e:
        return json.dumps({"error": str(e)})

    cells = nb.get("cells", [])

    # Find cell by id or index
    target_idx = None
    if cell_id:
        for i, cell in enumerate(cells):
            if cell.get("id") == cell_id:
                target_idx = i
                break
        if target_idx is None:
            # Try as integer index
            try:
                target_idx = int(cell_id)
            except ValueError:
                return json.dumps({"error": f"Cell '{cell_id}' not found"})

    if edit_mode == "delete":
        if target_idx is not None and 0 <= target_idx < len(cells):
            cells.pop(target_idx)
        else:
            return json.dumps({"error": "Cannot delete: cell not found"})
    elif edit_mode == "insert":
        # Format source as list of lines with trailing newlines (Jupyter convention)
        if isinstance(new_source, str):
            lines = new_source.split("\n")
            source_lines = [line + "\n" for line in lines[:-1]] + [lines[-1]] if lines else [""]
        else:
            source_lines = new_source
        new_cell = {
            "id": uuid.uuid4().hex[:8],
            "cell_type": cell_type or "code",
            "source": source_lines,
            "metadata": {},
            "outputs": [] if (cell_type or "code") == "code" else None,
        }
        if target_idx is not None:
            cells.insert(target_idx + 1, new_cell)
        else:
            cells.append(new_cell)
    else:  # replace
        if target_idx is not None and 0 <= target_idx < len(cells):
            # Jupyter format: each line except the last ends with \n
            if isinstance(new_source, str):
                lines = new_source.split("\n")
                source_lines = [line + "\n" for line in lines[:-1]] + [lines[-1]]
            else:
                source_lines = new_source
            cells[target_idx]["source"] = source_lines
            if cell_type:
                cells[target_idx]["cell_type"] = cell_type
        else:
            return json.dumps({"error": "Cannot replace: cell not found"})

    nb["cells"] = cells
    try:
        with open(notebook_path, "w", encoding="utf-8") as f:
            json.dump(nb, f, indent=1, ensure_ascii=False)
        return json.dumps({"status": "edited", "mode": edit_mode, "cell_id": cell_id})
    except Exception as e:
        return json.dumps({"error": str(e)})


def get_tools() -> list[ToolDef]:
    return [
        ToolDef(
            name="notebook_edit",
            description="Edit a Jupyter notebook cell. Supports replace, insert, and delete modes.",
            parameters={
                "type": "object",
                "properties": {
                    "notebook_path": {"type": "string", "description": "Path to .ipynb file"},
                    "cell_id": {"type": "string", "description": "Cell ID or index"},
                    "new_source": {"type": "string", "description": "New cell source content"},
                    "cell_type": {"type": "string", "description": "Cell type: code or markdown"},
                    "edit_mode": {"type": "string", "description": "replace, insert, or delete", "enum": ["replace", "insert", "delete"]},
                },
                "required": ["notebook_path"]
            },
            handler=notebook_edit,
            permission=Permission.WRITE,
            is_read_only=False,
            is_concurrency_safe=False,
        ),
    ]
