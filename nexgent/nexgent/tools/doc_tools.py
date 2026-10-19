"""Document creation tools - markdown, CSV, and simple text documents.

Ch3 markers:
- create_doc, create_spreadsheet: write, NOT concurrency-safe
"""

import os
import json
import csv
from pathlib import Path
from datetime import datetime
from .registry import ToolDef
from .file_ops import _get_allowed_write_dir
from ..permissions import Permission


def _validate_output_dir(output_dir: str) -> str | None:
    """Return error message if output directory is outside allowed path."""
    try:
        resolved = Path(output_dir).resolve()
        if not resolved.is_relative_to(_get_allowed_write_dir()):
            return f"Output directory '{output_dir}' is outside allowed directory"
        return None
    except Exception as e:
        return f"Path validation error: {e}"


def create_doc(params: dict) -> str:
    title = params.get("title", "Untitled")
    content = params.get("content", "")
    fmt = params.get("format", "markdown")
    output_dir = params.get("output_dir", ".")

    err = _validate_output_dir(output_dir)
    if err:
        return json.dumps({"error": err})
    try:
        os.makedirs(output_dir, exist_ok=True)
        safe_title = "".join(c if c.isalnum() or c in "-_ " else "" for c in title).strip().replace(" ", "_") or "untitled"
        if fmt == "markdown":
            ext = "md"
            full_content = f"# {title}\n\n{content}\n"
        elif fmt == "txt":
            ext = "txt"
            full_content = f"{title}\n{'='*len(title)}\n\n{content}\n"
        else:
            ext = "md"
            full_content = f"# {title}\n\n{content}\n"

        path = os.path.join(output_dir, f"{safe_title}.{ext}")
        with open(path, "w", encoding="utf-8") as f:
            f.write(full_content)
        return json.dumps({"status": "created", "path": os.path.abspath(path), "format": fmt})
    except Exception as e:
        return json.dumps({"error": str(e)})


def create_spreadsheet(params: dict) -> str:
    title = params.get("title", "data")
    data = params.get("data", [])
    output_dir = params.get("output_dir", ".")

    err = _validate_output_dir(output_dir)
    if err:
        return json.dumps({"error": err})
    try:
        os.makedirs(output_dir, exist_ok=True)
        safe_title = "".join(c if c.isalnum() or c in "-_ " else "" for c in title).strip().replace(" ", "_") or "untitled"
        path = os.path.join(output_dir, f"{safe_title}.csv")

        with open(path, "w", encoding="utf-8", newline="") as f:
            if data and isinstance(data[0], dict):
                fieldnames = list(data[0].keys())
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(data)
            else:
                writer = csv.writer(f)
                for row in data:
                    writer.writerow(row if isinstance(row, list) else [row])

        return json.dumps({"status": "created", "path": os.path.abspath(path), "rows": len(data)})
    except Exception as e:
        return json.dumps({"error": str(e)})


def get_tools() -> list[ToolDef]:
    return [
        ToolDef(
            name="create_doc",
            description="Create a document (markdown or txt). Useful for notes, reports, and documentation.",
            parameters={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Document title"},
                    "content": {"type": "string", "description": "Document content"},
                    "format": {"type": "string", "enum": ["markdown", "txt"], "description": "Output format (default: markdown)"},
                    "output_dir": {"type": "string", "description": "Output directory (default: current dir)"},
                },
                "required": ["title", "content"]
            },
            handler=create_doc,
            permission=Permission.WRITE,
            is_read_only=False,
            is_concurrency_safe=False,
        ),
        ToolDef(
            name="create_spreadsheet",
            description="Create a CSV spreadsheet from structured data.",
            parameters={
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "Spreadsheet title/filename"},
                    "data": {
                        "type": "array",
                        "description": "Data rows. Each row can be a list or dict.",
                        "items": {"type": "object"}
                    },
                    "output_dir": {"type": "string", "description": "Output directory (default: current dir)"},
                },
                "required": ["title", "data"]
            },
            handler=create_spreadsheet,
            permission=Permission.WRITE,
            is_read_only=False,
            is_concurrency_safe=False,
        ),
    ]
