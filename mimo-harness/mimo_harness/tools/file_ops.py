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
import fnmatch
from pathlib import Path
from .registry import ToolDef
from ..permissions import Permission

_ALLOWED_WRITE_DIR = None  # Lazily initialized on first use

# Track files that have been read in this session (for read-before-edit check)
_read_files: set[str] = set()
_read_files_lock = threading.Lock()

# Track files that have been read (for read-before-write check on existing files)
_write_allowed_files: set[str] = set()
_write_allowed_files_lock = threading.Lock()


def _get_allowed_write_dir() -> Path:
    """Return the allowed write directory, lazily initialized to CWD."""
    global _ALLOWED_WRITE_DIR
    if _ALLOWED_WRITE_DIR is None:
        _ALLOWED_WRITE_DIR = Path.cwd().resolve()
    return _ALLOWED_WRITE_DIR


def _validate_write_path(path: str) -> str | None:
    """Return error message if path is outside allowed directory, else None."""
    resolved = Path(path).resolve()
    allowed = _get_allowed_write_dir()
    if not resolved.is_relative_to(allowed):
        return f"Path '{path}' is outside allowed directory '{allowed}'"
    return None


def _validate_read_path(path: str) -> str | None:
    """Return error message if read path is outside allowed directory, else None."""
    resolved = Path(path).resolve()
    allowed = _get_allowed_write_dir()
    if not resolved.is_relative_to(allowed):
        return f"Path '{path}' is outside allowed directory '{allowed}'"
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
        abs_path = os.path.abspath(path)
        with _read_files_lock:
            _read_files.add(abs_path)
        # Also allow writing to this file (for read-before-write check)
        with _write_allowed_files_lock:
            _write_allowed_files.add(abs_path)
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
    # Read-before-write check: existing files must be read first
    abs_path = os.path.abspath(path)
    if os.path.exists(abs_path):
        with _write_allowed_files_lock:
            if abs_path not in _write_allowed_files:
                return json.dumps({"error": f"File '{path}' must be read before writing. Use read_file first."})
    try:
        os.makedirs(os.path.dirname(abs_path), exist_ok=True)
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


def _load_gitignore_patterns(path: str) -> list[str]:
    """S11: Read .gitignore file and return list of patterns."""
    gitignore_path = os.path.join(path, ".gitignore")
    patterns = []
    try:
        with open(gitignore_path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                # Skip empty lines and comments
                if not line or line.startswith("#"):
                    continue
                patterns.append(line)
    except (FileNotFoundError, PermissionError):
        pass
    return patterns


def _matches_gitignore(rel_path: str, patterns: list[str]) -> bool:
    """S11: Check if a relative path matches any gitignore pattern."""
    # Normalize to forward slashes for consistent matching
    rel_path = rel_path.replace("\\", "/")
    for pattern in patterns:
        # Strip leading slash (anchored to gitignore dir)
        pat = pattern.lstrip("/")
        # If pattern has no slash (or only trailing), match against basename too
        if "/" not in pat.rstrip("/"):
            basename = os.path.basename(rel_path)
            if fnmatch.fnmatch(basename, pat.rstrip("/")):
                return True
        # Match against the full relative path
        if fnmatch.fnmatch(rel_path, pat) or fnmatch.fnmatch(rel_path, pat + "/"):
            return True
    return False


def glob_files(params: dict) -> str:
    pattern = params.get("pattern", "")
    respect_gitignore = params.get("respect_gitignore", False)
    # Validate that the pattern's base directory is within allowed path
    base = pattern.split("*")[0].rstrip("/\\") or "."
    err = _validate_read_path(base)
    if err:
        return json.dumps({"error": err})
    try:
        matches = glob_mod.glob(pattern, recursive=True)
        # S11: filter by .gitignore if requested
        if respect_gitignore:
            search_dir = base if os.path.isdir(base) else os.path.dirname(base) or "."
            gitignore_patterns = _load_gitignore_patterns(search_dir)
            if gitignore_patterns:
                abs_search = os.path.abspath(search_dir)
                filtered = []
                for m in matches:
                    try:
                        rel = os.path.relpath(m, abs_search)
                    except ValueError:
                        # Different drive on Windows
                        filtered.append(m)
                        continue
                    if not _matches_gitignore(rel, gitignore_patterns):
                        filtered.append(m)
                matches = filtered
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
    # S10: output mode parameters
    output_mode = params.get("output_mode", "files_with_matches")
    head_limit = params.get("head_limit", 250)
    offset = params.get("offset", 0)
    show_line_numbers = params.get("-n", True)
    case_insensitive = params.get("-i", False)
    only_matching = params.get("-o", False)
    err = _validate_read_path(path)
    if err:
        return json.dumps({"error": err})
    # Resolve context: explicit before/after override generic context
    ctx_before = before_context if before_context > 0 else context
    ctx_after = after_context if after_context > 0 else context
    try:
        # S10: build flags based on -i and multiline
        flags = re.DOTALL if multiline else 0
        if case_insensitive:
            flags |= re.IGNORECASE
        regex = re.compile(pattern, flags)

        # S10: "count" mode tracks per-file counts
        count_map: dict[str, int] = {}
        # "files_with_matches" tracks which files matched (no duplicates)
        files_matched: list[str] = []
        files_matched_set: set[str] = set()
        # "content" mode or legacy: full entry list
        results: list[dict] = []

        total_raw = 0  # total results before offset/limit

        for root, dirs, files in os.walk(path):
            dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "__pycache__", ".venv"}]
            for fname in files:
                if not glob_mod.fnmatch.fnmatch(fname, file_glob):
                    continue
                fpath = os.path.join(root, fname)
                try:
                    with open(fpath, "r", encoding="utf-8", errors="replace") as f:
                        lines = f.readlines()
                    file_match_count = 0
                    if multiline:
                        content = "".join(lines)
                        for m in regex.finditer(content):
                            line_num = content[:m.start()].count("\n") + 1
                            total_raw += 1
                            file_match_count += 1
                            # S10: count mode just tallies
                            if output_mode == "count":
                                continue
                            # S10: files_with_matches mode just tracks file
                            if output_mode == "files_with_matches":
                                if fpath not in files_matched_set:
                                    files_matched_set.add(fpath)
                                    files_matched.append(fpath)
                                continue
                            # content mode (or default legacy behavior)
                            if only_matching:
                                match_text = m.group(0)[:200]
                            else:
                                match_text = m.group(0)[:200]
                            entry: dict = {"file": fpath}
                            if show_line_numbers:
                                entry["line"] = line_num
                            entry["content"] = match_text
                            if ctx_before > 0 or ctx_after > 0:
                                start = max(0, line_num - 1 - ctx_before)
                                end = min(len(lines), line_num + ctx_after)
                                entry["before_context"] = [l.rstrip()[:200] for l in lines[start:line_num - 1]]
                                entry["after_context"] = [l.rstrip()[:200] for l in lines[line_num:end]]
                            results.append(entry)
                    else:
                        for i, line in enumerate(lines, 1):
                            if regex.search(line):
                                total_raw += 1
                                file_match_count += 1
                                # S10: count mode just tallies
                                if output_mode == "count":
                                    continue
                                # S10: files_with_matches mode just tracks file
                                if output_mode == "files_with_matches":
                                    if fpath not in files_matched_set:
                                        files_matched_set.add(fpath)
                                        files_matched.append(fpath)
                                    continue
                                # content mode
                                if only_matching:
                                    content_match = m.group(0) if (m := regex.search(line)) else line.rstrip()[:200]
                                else:
                                    content_match = line.rstrip()[:200]
                                entry = {"file": fpath}
                                if show_line_numbers:
                                    entry["line"] = i
                                entry["content"] = content_match[:200]
                                if ctx_before > 0 or ctx_after > 0:
                                    start = max(0, i - 1 - ctx_before)
                                    end = min(len(lines), i + ctx_after)
                                    entry["before_context"] = [l.rstrip()[:200] for l in lines[start:i - 1]]
                                    entry["after_context"] = [l.rstrip()[:200] for l in lines[i:end]]
                                results.append(entry)
                    # S10: accumulate count
                    if output_mode == "count" and file_match_count > 0:
                        count_map[fpath] = file_match_count
                except Exception:
                    continue

        # S10: return based on output_mode
        if output_mode == "count":
            return json.dumps({"pattern": pattern, "counts": count_map, "total_files": len(count_map)})

        if output_mode == "files_with_matches":
            # Apply offset and head_limit
            sliced = files_matched[offset:offset + head_limit] if head_limit > 0 else files_matched[offset:]
            return json.dumps({
                "pattern": pattern,
                "files": sliced,
                "total": len(files_matched),
                "truncated": (head_limit > 0 and offset + head_limit < len(files_matched)),
            })

        # content mode: apply offset and head_limit
        if head_limit > 0:
            sliced = results[offset:offset + head_limit]
            truncated = offset + head_limit < len(results)
        else:
            sliced = results[offset:]
            truncated = False
        return json.dumps({
            "pattern": pattern,
            "results": sliced,
            "total": len(results),
            "truncated": truncated,
        })
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
            description="Write content to a file. Creates parent directories if needed. Existing files must be read first with read_file.",
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
                    "respect_gitignore": {"type": "boolean", "description": "Filter out paths matching .gitignore rules (default false)"},
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
            description="Search file contents with regex pattern. Supports context lines, multiline matching, and multiple output modes.",
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
                    "output_mode": {"type": "string", "enum": ["files_with_matches", "content", "count"], "description": "Output mode (default: files_with_matches)"},
                    "head_limit": {"type": "integer", "description": "Max total results (default 250, 0=unlimited)"},
                    "offset": {"type": "integer", "description": "Skip first N results (default 0)"},
                    "-n": {"type": "boolean", "description": "Show line numbers (default true)"},
                    "-i": {"type": "boolean", "description": "Case insensitive search (default false)"},
                    "-o": {"type": "boolean", "description": "Show only matching parts (default false)"},
                },
                "required": ["pattern"]
            },
            handler=grep_files,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=True,
        ),
    ]
