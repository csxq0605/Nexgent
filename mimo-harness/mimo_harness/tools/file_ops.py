"""File operation tools - read, write, edit, glob, grep.

Ch3 markers:
- read_file, glob_files, grep_files: read-only, concurrency-safe
- write_file, edit_file: write, NOT concurrency-safe
"""

import os
import json
import glob as glob_mod
import re
import threading
from pathlib import Path
from .registry import ToolDef
from ..permissions import Permission

_ALLOWED_WRITE_DIR = Path.cwd().resolve()

# Track files that have been read in this session (for read-before-edit check)
_read_files: set[str] = set()
_read_files_lock = threading.Lock()


def _validate_write_path(path: str) -> str | None:
    """Return error message if path is outside allowed directory, else None."""
    resolved = Path(path).resolve()
    if not resolved.is_relative_to(_ALLOWED_WRITE_DIR):
        return f"Path '{path}' is outside allowed directory '{_ALLOWED_WRITE_DIR}'"
    return None


def _validate_read_path(path: str) -> str | None:
    """Return error message if read path is outside allowed directory, else None."""
    resolved = Path(path).resolve()
    if not resolved.is_relative_to(_ALLOWED_WRITE_DIR):
        return f"Path '{path}' is outside allowed directory '{_ALLOWED_WRITE_DIR}'"
    return None


def read_file(params: dict) -> str:
    path = params.get("path", "")
    offset = params.get("offset", 0)
    limit = params.get("limit", 200)
    err = _validate_read_path(path)
    if err:
        return json.dumps({"error": err})
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
        total = len(lines)
        selected = lines[offset:offset + limit]
        numbered = [f"{i+offset+1}\t{l}" for i, l in enumerate(selected)]
        # Track that this file has been read (for read-before-edit check)
        with _read_files_lock:
            _read_files.add(os.path.abspath(path))
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
    replace_all = params.get("replace_all", False)
    err = _validate_write_path(path)
    if err:
        return json.dumps({"error": err})
    # Reject empty old_text — str.replace("", ...) is character-level and destructive
    if not old_text:
        return json.dumps({"error": "old_text must not be empty"})
    # Read-before-edit check: verify file was read in this session
    abs_path = os.path.abspath(path)
    with _read_files_lock:
        if abs_path not in _read_files:
            return json.dumps({"error": f"File '{path}' must be read before editing. Use read_file first."})
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
        if old_text not in content:
            return json.dumps({"error": "old_text not found in file"})
        count = content.count(old_text)
        # Uniqueness check: when replace_all=False, verify old_text appears exactly once
        if not replace_all and count > 1:
            return json.dumps({
                "error": f"old_text appears {count} times in file. Use replace_all=true to replace all, or provide more unique text.",
                "occurrences": count,
            })
        if replace_all:
            new_content = content.replace(old_text, new_text)
            replaced = count
        else:
            new_content = content.replace(old_text, new_text, 1)
            replaced = 1
        with open(path, "w", encoding="utf-8") as f:
            f.write(new_content)
        return json.dumps({"status": "edited", "path": path, "occurrences": count, "replaced": replaced})
    except Exception as e:
        return json.dumps({"error": str(e)})


def glob_files(params: dict) -> str:
    pattern = params.get("pattern", "")
    # Validate that the pattern's base directory is within allowed path
    base = pattern.split("*")[0].rstrip("/\\") or "."
    err = _validate_read_path(base)
    if err:
        return json.dumps({"error": err})
    try:
        matches = glob_mod.glob(pattern, recursive=True)
        return json.dumps({"pattern": pattern, "matches": matches[:100], "total": len(matches)})
    except Exception as e:
        return json.dumps({"error": str(e)})


def grep_files(params: dict) -> str:
    pattern = params.get("pattern", "")
    path = params.get("path", ".")
    file_glob = params.get("glob", "*")
    context = params.get("context", 0)
    before_context = params.get("before_context", 0)
    after_context = params.get("after_context", 0)
    multiline = params.get("multiline", False)
    err = _validate_read_path(path)
    if err:
        return json.dumps({"error": err})
    # Resolve context: explicit before/after override generic context
    ctx_before = before_context if before_context > 0 else context
    ctx_after = after_context if after_context > 0 else context
    try:
        flags = re.IGNORECASE | re.DOTALL if multiline else re.IGNORECASE
        regex = re.compile(pattern, flags)
        results = []
        for root, dirs, files in os.walk(path):
            dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "__pycache__", ".venv"}]
            for fname in files:
                if not glob_mod.fnmatch.fnmatch(fname, file_glob):
                    continue
                fpath = os.path.join(root, fname)
                try:
                    with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                        lines = f.readlines()
                    if multiline:
                        # Multiline: join all lines and match against the whole content
                        content = "".join(lines)
                        for m in regex.finditer(content):
                            # Find line number of match start
                            line_num = content[:m.start()].count("\n") + 1
                            match_text = m.group(0)[:200]
                            entry = {"file": fpath, "line": line_num, "content": match_text}
                            # Add context lines
                            if ctx_before > 0 or ctx_after > 0:
                                all_lines = lines
                                start = max(0, line_num - 1 - ctx_before)
                                end = min(len(all_lines), line_num + ctx_after)
                                entry["before_context"] = [l.rstrip()[:200] for l in all_lines[start:line_num - 1]]
                                entry["after_context"] = [l.rstrip()[:200] for l in all_lines[line_num:end]]
                            results.append(entry)
                            if len(results) >= 50:
                                return json.dumps({"pattern": pattern, "results": results, "truncated": True})
                    else:
                        for i, line in enumerate(lines, 1):
                            if regex.search(line):
                                entry = {"file": fpath, "line": i, "content": line.rstrip()[:200]}
                                # Add context lines
                                if ctx_before > 0 or ctx_after > 0:
                                    start = max(0, i - 1 - ctx_before)
                                    end = min(len(lines), i + ctx_after)
                                    entry["before_context"] = [l.rstrip()[:200] for l in lines[start:i - 1]]
                                    entry["after_context"] = [l.rstrip()[:200] for l in lines[i:end]]
                                results.append(entry)
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
            is_read_only=True,
            is_concurrency_safe=True,
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
            is_read_only=False,
            is_concurrency_safe=False,
        ),
        ToolDef(
            name="edit_file",
            description="Replace old_text with new_text in a file. Requires read_file first. When replace_all is false (default), old_text must appear exactly once.",
            parameters={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "Absolute file path"},
                    "old_text": {"type": "string", "description": "Text to find"},
                    "new_text": {"type": "string", "description": "Text to replace with"},
                    "replace_all": {"type": "boolean", "description": "Replace all occurrences (default false)"},
                },
                "required": ["path", "old_text", "new_text"]
            },
            handler=edit_file,
            permission=Permission.WRITE,
            is_read_only=False,
            is_concurrency_safe=False,
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
            is_read_only=True,
            is_concurrency_safe=True,
        ),
        ToolDef(
            name="grep_files",
            description="Search file contents with regex pattern. Supports context lines and multiline matching.",
            parameters={
                "type": "object",
                "properties": {
                    "pattern": {"type": "string", "description": "Regex pattern to search"},
                    "path": {"type": "string", "description": "Directory to search (default: current dir)"},
                    "glob": {"type": "string", "description": "File name filter (default: '*')"},
                    "context": {"type": "integer", "description": "Lines of context before and after each match (default 0)"},
                    "before_context": {"type": "integer", "description": "Lines of context before each match (default 0)"},
                    "after_context": {"type": "integer", "description": "Lines of context after each match (default 0)"},
                    "multiline": {"type": "boolean", "description": "Enable multiline matching (default false)"},
                },
                "required": ["pattern"]
            },
            handler=grep_files,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=True,
        ),
    ]
