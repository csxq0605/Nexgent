"""File operation tools - read, write, edit, glob, grep."""

import os
import json
import glob as glob_mod
import re
from pathlib import Path
from .registry import ToolDef
from ..permissions import Permission

_ALLOWED_WRITE_DIR = Path.cwd().resolve()


def _validate_write_path(path: str) -> str | None:
    """Return error message if path is outside allowed directory, else None."""
    resolved = Path(path).resolve()
    if not str(resolved).startswith(str(_ALLOWED_WRITE_DIR)):
        return f"Path '{path}' is outside allowed directory '{_ALLOWED_WRITE_DIR}'"
    return None


def read_file(params: dict) -> str:
    path = params.get("path", "")
    offset = params.get("offset", 0)
    limit = params.get("limit", 200)
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        total = len(lines)
        selected = lines[offset:offset + limit]
        numbered = [f"{i+offset+1}\t{l}" for i, l in enumerate(selected)]
        return json.dumps({
            "path": path,
            "total_lines": total,
            "showing": f"{offset+1}-{min(offset+limit, total)}",
            "content": "".join(numbered)
        })
    except Exception as e:
        return json.dumps({"error": str(e)})


def write_file(params: dict) -> str:
    path = params.get("path", "")
    content = params.get("content", "")
    err = _validate_write_path(path)
    if err:
        return json.dumps({"error": err})
    try:
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return json.dumps({"status": "written", "path": path, "bytes": len(content.encode("utf-8"))})
    except Exception as e:
        return json.dumps({"error": str(e)})


def edit_file(params: dict) -> str:
    path = params.get("path", "")
    old_text = params.get("old_text", "")
    new_text = params.get("new_text", "")
    err = _validate_write_path(path)
    if err:
        return json.dumps({"error": err})
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        if old_text not in content:
            return json.dumps({"error": "old_text not found in file"})
        count = content.count(old_text)
        new_content = content.replace(old_text, new_text, 1)
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return json.dumps({"status": "edited", "path": path, "occurrences": count, "replaced": 1})
    except Exception as e:
        return json.dumps({"error": str(e)})


def glob_files(params: dict) -> str:
    pattern = params.get("pattern", "")
    try:
        matches = glob_mod.glob(pattern, recursive=True)
        return json.dumps({"pattern": pattern, "matches": matches[:100], "total": len(matches)})
    except Exception as e:
        return json.dumps({"error": str(e)})


def grep_files(params: dict) -> str:
    pattern = params.get("pattern", "")
    path = params.get("path", ".")
    file_glob = params.get("glob", "*")
    try:
        regex = re.compile(pattern, re.IGNORECASE)
        results = []
        for root, dirs, files in os.walk(path):
            dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "__pycache__", ".venv"}]
            for fname in files:
                if not glob_mod.fnmatch.fnmatch(fname, file_glob):
                    continue
                fpath = os.path.join(root, fname)
                try:
                    with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                        for i, line in enumerate(f, 1):
                            if regex.search(line):
                                results.append({"file": fpath, "line": i, "content": line.rstrip()[:200]})
                                if len(results) >= 50:
                                    return json.dumps({"pattern": pattern, "results": results, "truncated": True})
                except Exception:
                    continue
        return json.dumps({"pattern": pattern, "results": results, "total": len(results)})
    except Exception as e:
        return json.dumps({"error": str(e)})


def get_tools() -> list[ToolDef]:
    return [
        ToolDef(
            name="read_file",
            description="Read a file's contents with optional line range. Returns numbered lines.",
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute file path"},
                    "offset": {"type": "integer", "description": "Start line (0-based, default 0)"},
                    "limit": {"type": "integer", "description": "Max lines to read (default 200)"},
                },
                "required": ["path"]
            },
            handler=read_file,
            permission=Permission.READ,
        ),
        ToolDef(
            name="write_file",
            description="Write content to a file. Creates parent directories if needed.",
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute file path"},
                    "content": {"type": "string", "description": "Content to write"},
                },
                "required": ["path", "content"]
            },
            handler=write_file,
            permission=Permission.WRITE,
        ),
        ToolDef(
            name="edit_file",
            description="Replace the first occurrence of old_text with new_text in a file.",
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute file path"},
                    "old_text": {"type": "string", "description": "Text to find"},
                    "new_text": {"type": "string", "description": "Text to replace with"},
                },
                "required": ["path", "old_text", "new_text"]
            },
            handler=edit_file,
            permission=Permission.WRITE,
        ),
        ToolDef(
            name="glob_files",
            description="Find files matching a glob pattern. Examples: '**/*.py', 'src/**/*.js'",
            parameters={
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Glob pattern"},
                },
                "required": ["pattern"]
            },
            handler=glob_files,
            permission=Permission.READ,
        ),
        ToolDef(
            name="grep_files",
            description="Search file contents with regex pattern.",
            parameters={
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regex pattern to search"},
                    "path": {"type": "string", "description": "Directory to search (default: current dir)"},
                    "glob": {"type": "string", "description": "File name filter (default: '*')"},
                },
                "required": ["pattern"]
            },
            handler=grep_files,
            permission=Permission.READ,
        ),
    ]
