"""LSP tools - Language Server Protocol integration.

Implements code intelligence tools:
- lsp_definition: Jump to symbol definition
- lsp_references: Find all references to a symbol
- lsp_diagnostics: Get type errors and warnings for a file

Uses subprocess communication with language servers via LSP protocol.
Supports Python (pylsp/pyright) and can be extended for other languages.
"""

import json
import os
import platform
import re
import subprocess
import threading
import time
from typing import Optional
from urllib.parse import urlparse, unquote

from .registry import ToolDef
from ..permissions import Permission


# LSP server configurations per language
LSP_SERVERS = {
    ".py": {
        "name": "pylsp",
        "command": ["pylsp"],
        "language_id": "python",
    },
    ".js": {
        "name": "typescript-language-server",
        "command": ["typescript-language-server", "--stdio"],
        "language_id": "javascript",
    },
    ".ts": {
        "name": "typescript-language-server",
        "command": ["typescript-language-server", "--stdio"],
        "language_id": "typescript",
    },
}


class LSPClient:
    """Minimal LSP client for tool integration."""

    MAX_CONTENT_LENGTH = 10 * 1024 * 1024  # 10MB max response size

    def __init__(self):
        self._process: Optional[subprocess.Popen] = None
        self._request_id = 0
        self._responses: dict[int, dict] = {}
        self._response_events: dict[int, threading.Event] = {}
        self._reader_thread: Optional[threading.Thread] = None
        self._lock = threading.Lock()
        self._server_name = ""
        self._opened_files: set[str] = set()

    def __del__(self):
        """Cleanup on garbage collection."""
        self.shutdown()

    def _find_server_for_file(self, file_path: str) -> Optional[dict]:
        """Find the appropriate LSP server for a file."""
        ext = os.path.splitext(file_path)[1].lower()
        return LSP_SERVERS.get(ext)

    def start(self, server_config: dict) -> bool:
        """Start an LSP server process."""
        try:
            self._process = subprocess.Popen(
                server_config["command"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
            )
            self._server_name = server_config["name"]
            self._start_reader()
            # Send initialize request
            resp = self._send_request("initialize", {
                "processId": os.getpid(),
                "capabilities": {},
                "rootUri": f"file://{os.getcwd()}",
            })
            if resp and "result" in resp:
                self._send_notification("initialized", {})
                return True
            return False
        except FileNotFoundError:
            return False

    def _start_reader(self):
        """Start background thread to read LSP responses."""
        def _reader():
            while self._process and self._process.poll() is None:
                try:
                    # Read Content-Length header
                    line = self._process.stdout.readline()
                    if not line:
                        break
                    if line.startswith(b"Content-Length:"):
                        length = int(line.split(b":")[1].strip())
                        # Validate Content-Length to prevent memory exhaustion
                        if length > self.MAX_CONTENT_LENGTH:
                            # Skip this oversized message — read ALL bytes to avoid corrupting the stream
                            self._process.stdout.readline()  # skip empty line
                            self._process.stdout.read(length)  # consume entire message
                            continue
                        # Read empty line
                        self._process.stdout.readline()
                        # Read body
                        body = self._process.stdout.read(length)
                        if body:
                            msg = json.loads(body)
                            msg_id = msg.get("id")
                            if msg_id is not None:
                                self._responses[msg_id] = msg
                                # Signal waiting thread
                                event = self._response_events.get(msg_id)
                                if event:
                                    event.set()
                except Exception as e:
                    logging.getLogger(__name__).debug("LSP reader error: %s", e)
                    break

        self._reader_thread = threading.Thread(target=_reader, daemon=True)
        self._reader_thread.start()

    def _send_request(self, method: str, params: dict, timeout: float = 5.0) -> Optional[dict]:
        """Send an LSP request and wait for response."""
        if not self._process or self._process.poll() is not None:
            return None

        with self._lock:
            self._request_id += 1
            req_id = self._request_id

            msg = {
                "jsonrpc": "2.0",
                "id": req_id,
                "method": method,
                "params": params,
            }
            body = json.dumps(msg)
            header = f"Content-Length: {len(body)}\r\n\r\n"

            try:
                self._process.stdin.write((header + body).encode())
                self._process.stdin.flush()
            except Exception:
                return None

        # Wait for response using event (no busy-wait)
        event = threading.Event()
        self._response_events[req_id] = event
        try:
            event.wait(timeout=timeout)
            return self._responses.pop(req_id, None)
        finally:
            self._response_events.pop(req_id, None)

    def _send_notification(self, method: str, params: dict):
        """Send an LSP notification (no response expected)."""
        if not self._process or self._process.poll() is not None:
            return

        msg = {
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }
        body = json.dumps(msg)
        header = f"Content-Length: {len(body)}\r\n\r\n"

        try:
            self._process.stdin.write((header + body).encode())
            self._process.stdin.flush()
        except Exception:
            pass

    def open_file(self, file_path: str, content: Optional[str] = None):
        """Notify the server about an opened file (only once per file)."""
        if file_path in self._opened_files:
            return
        self._opened_files.add(file_path)
        if content is None:
            try:
                with open(file_path, "r", encoding="utf-8") as f:
                    content = f.read()
            except Exception:
                return

        ext = os.path.splitext(file_path)[1].lower()
        server_config = LSP_SERVERS.get(ext, {})
        language_id = server_config.get("language_id", "plaintext")

        uri = f"file://{os.path.abspath(file_path).replace(os.sep, '/')}"
        self._send_notification("textDocument/didOpen", {
            "textDocument": {
                "uri": uri,
                "languageId": language_id,
                "version": 1,
                "text": content,
            }
        })

    def definition(self, file_path: str, line: int, character: int) -> Optional[dict]:
        """Request definition location for a symbol."""
        uri = f"file://{os.path.abspath(file_path).replace(os.sep, '/')}"
        return self._send_request("textDocument/definition", {
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": character},
        })

    def references(self, file_path: str, line: int, character: int) -> Optional[dict]:
        """Request all references to a symbol."""
        uri = f"file://{os.path.abspath(file_path).replace(os.sep, '/')}"
        return self._send_request("textDocument/references", {
            "textDocument": {"uri": uri},
            "position": {"line": line, "character": character},
            "context": {"includeDeclaration": True},
        })

    def diagnostics(self, file_path: str) -> list[dict]:
        """Request diagnostics (errors/warnings) for a file."""
        # Note: diagnostics are typically pushed by the server, not requested.
        # For a tool, we do a workaround: open the file and check for
        # any diagnostic notifications that arrived.
        self.open_file(file_path)
        time.sleep(0.1)  # Brief wait for diagnostics to arrive
        # In a real implementation, we'd collect diagnostic notifications.
        # For now, return empty and let the server push them.
        return []

    def shutdown(self):
        """Shutdown the LSP server."""
        if self._process and self._process.poll() is None:
            try:
                self._send_request("shutdown", {}, timeout=2.0)
                self._send_notification("exit", {})
                self._process.wait(timeout=3)
            except Exception:
                try:
                    self._process.kill()
                except Exception:
                    pass
        self._process = None


# Global LSP client instance and lock
_lsp_client: Optional[LSPClient] = None
_lsp_lock = threading.Lock()


def _get_lsp_client(file_path: str) -> Optional[LSPClient]:
    """Get or create an LSP client for the given file."""
    global _lsp_client

    server_config = None
    for ext, config in LSP_SERVERS.items():
        if file_path.endswith(ext):
            server_config = config
            break

    if not server_config:
        return None

    with _lsp_lock:
        # Reuse existing client if it's for the same server
        if _lsp_client and _lsp_client._server_name == server_config["name"]:
            if _lsp_client._process and _lsp_client._process.poll() is None:
                return _lsp_client

        # Shutdown old client
        if _lsp_client:
            _lsp_client.shutdown()

        # Start new client
        _lsp_client = LSPClient()
        if _lsp_client.start(server_config):
            return _lsp_client
        _lsp_client = None
        return None


def _location_to_str(loc: dict) -> str:
    """Convert an LSP location to a readable string."""
    uri = loc.get("uri", "")
    range_info = loc.get("range", {})
    start = range_info.get("start", {})
    # Use urlparse for correct path extraction on all platforms
    parsed = urlparse(uri)
    file_path = unquote(parsed.path)
    # On Windows, urlparse returns /C:/path — strip leading /
    if platform.system() == "Windows" and file_path.startswith("/") and len(file_path) > 2 and file_path[2] == ":":
        file_path = file_path[1:]
    file_path = file_path.replace("/", os.sep)
    line = start.get("line", 0) + 1  # LSP is 0-indexed
    char = start.get("character", 0)
    return f"{file_path}:{line}:{char}"


def lsp_definition(params: dict) -> str:
    """Jump to the definition of a symbol at a given position.

    Args:
        params: dict with keys:
            - file_path (str): Path to the file
            - line (int): Line number (1-indexed)
            - character (int): Column number (0-indexed)

    Returns:
        Definition location(s) as JSON string.
    """
    file_path = params.get("file_path", "")
    line = max(0, params.get("line", 1) - 1)  # Convert to 0-indexed
    character = params.get("character", 0)

    if not file_path:
        return json.dumps({"error": "No file_path provided"})

    if not os.path.exists(file_path):
        return json.dumps({"error": f"File not found: {file_path}"})

    client = _get_lsp_client(file_path)
    if not client:
        # Fallback: try grep-based approach for Python files
        return _fallback_definition(file_path, line, character)

    client.open_file(file_path)
    resp = client.definition(file_path, line, character)

    if not resp or "result" not in resp:
        return json.dumps({"error": "No definition found or LSP server not responding"})

    result = resp["result"]
    if not result:
        return json.dumps({"error": "No definition found"})

    # Handle single location or array
    locations = result if isinstance(result, list) else [result]
    formatted = [_location_to_str(loc) for loc in locations]
    return json.dumps({"definitions": formatted})


def lsp_references(params: dict) -> str:
    """Find all references to a symbol at a given position.

    Args:
        params: dict with keys:
            - file_path (str): Path to the file
            - line (int): Line number (1-indexed)
            - character (int): Column number (0-indexed)

    Returns:
        Reference locations as JSON string.
    """
    file_path = params.get("file_path", "")
    line = max(0, params.get("line", 1) - 1)
    character = params.get("character", 0)

    if not file_path:
        return json.dumps({"error": "No file_path provided"})

    if not os.path.exists(file_path):
        return json.dumps({"error": f"File not found: {file_path}"})

    client = _get_lsp_client(file_path)
    if not client:
        return _fallback_references(file_path, line, character)

    client.open_file(file_path)
    resp = client.references(file_path, line, character)

    if not resp or "result" not in resp:
        return json.dumps({"error": "No references found or LSP server not responding"})

    result = resp["result"]
    if not result:
        return json.dumps({"references": [], "count": 0})

    formatted = [_location_to_str(loc) for loc in result]
    return json.dumps({"references": formatted, "count": len(formatted)})


def lsp_diagnostics(params: dict) -> str:
    """Get diagnostics (errors, warnings) for a file.

    Note: Diagnostics are typically pushed by the LSP server.
    This tool provides a best-effort check.

    Args:
        params: dict with keys:
            - file_path (str): Path to the file

    Returns:
        Diagnostics as JSON string.
    """
    file_path = params.get("file_path", "")

    if not file_path:
        return json.dumps({"error": "No file_path provided"})

    if not os.path.exists(file_path):
        return json.dumps({"error": f"File not found: {file_path}"})

    # For Python files, try using py_compile as a fallback
    if file_path.endswith(".py"):
        return _python_diagnostics(file_path)

    client = _get_lsp_client(file_path)
    if not client:
        return json.dumps({"error": "No LSP server available for this file type"})

    client.open_file(file_path)
    # Wait a bit for diagnostics to be pushed
    time.sleep(1)
    return json.dumps({
        "note": "LSP diagnostics are pushed asynchronously. Check server output.",
        "file": file_path,
    })


def _fallback_definition(file_path: str, line: int, character: int) -> str:
    """Grep-based fallback for definition lookup."""
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            lines = f.readlines()

        if line >= len(lines):
            return json.dumps({"error": "Line number out of range"})

        # Extract the word at the cursor position
        current_line = lines[line]
        word = _extract_word_at(current_line, character)
        if not word:
            return json.dumps({"error": "Could not identify symbol at position"})

        # Search for definition patterns
        patterns = [
            rf'^\s*(def|class|async\s+def)\s+{re.escape(word)}\b',
            rf'^\s*{re.escape(word)}\s*=',
            rf'^\s*(?:from|import)\s+.*\b{re.escape(word)}\b',
        ]

        results = []
        for i, l in enumerate(lines):
            for pat in patterns:
                if re.search(pat, l):
                    results.append(f"{file_path}:{i+1}:0")
                    break

        if results:
            return json.dumps({"definitions": results, "method": "grep_fallback"})

        # Search in the same directory
        search_dir = os.path.dirname(file_path)
        for root, _, files in os.walk(search_dir):
            for fname in files:
                if not fname.endswith(".py"):
                    continue
                fpath = os.path.join(root, fname)
                if fpath == file_path:
                    continue
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        for i, l in enumerate(f.readlines()):
                            for pat in patterns:
                                if re.search(pat, l):
                                    results.append(f"{fpath}:{i+1}:0")
                                    break
                except Exception:
                    pass
            if len(results) >= 10:
                break

        if results:
            return json.dumps({"definitions": results, "method": "grep_fallback"})

        return json.dumps({"error": f"No definition found for '{word}'"})
    except Exception as e:
        return json.dumps({"error": str(e)})


def _fallback_references(file_path: str, line: int, character: int) -> str:
    """Grep-based fallback for reference lookup."""
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            lines = f.readlines()

        if line >= len(lines):
            return json.dumps({"error": "Line number out of range"})

        current_line = lines[line]
        word = _extract_word_at(current_line, character)
        if not word:
            return json.dumps({"error": "Could not identify symbol at position"})

        pattern = rf'\b{re.escape(word)}\b'
        results = []

        search_dir = os.path.dirname(file_path)
        for root, _, files in os.walk(search_dir):
            for fname in files:
                if not fname.endswith(".py"):
                    continue
                fpath = os.path.join(root, fname)
                try:
                    with open(fpath, "r", encoding="utf-8") as f:
                        for i, l in enumerate(f.readlines()):
                            if re.search(pattern, l):
                                results.append(f"{fpath}:{i+1}:0")
                except Exception:
                    pass
            if len(results) >= 50:
                break

        return json.dumps({"references": results, "count": len(results), "method": "grep_fallback"})
    except Exception as e:
        return json.dumps({"error": str(e)})


def _extract_word_at(line: str, character: int) -> str:
    """Extract the word at a given character position in a line."""
    if character >= len(line):
        # Try to get the last word
        words = re.findall(r'\b\w+\b', line)
        return words[-1] if words else ""

    # Find word boundaries around the character
    start = character
    end = character
    while start > 0 and (line[start - 1].isalnum() or line[start - 1] == '_'):
        start -= 1
    while end < len(line) and (line[end].isalnum() or line[end] == '_'):
        end += 1

    return line[start:end].strip()


def _python_diagnostics(file_path: str) -> str:
    """Use py_compile for basic Python diagnostics."""
    import py_compile

    errors = []
    try:
        py_compile.compile(file_path, doraise=True)
    except py_compile.PyCompileError as e:
        errors.append({
            "severity": "error",
            "message": str(e),
            "file": file_path,
        })

    # Also try ast.parse for syntax errors
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            source = f.read()
        import ast
        ast.parse(source, file_path)
    except SyntaxError as e:
        errors.append({
            "severity": "error",
            "message": f"SyntaxError: {e.msg}",
            "file": file_path,
            "line": e.lineno,
            "column": e.offset,
        })

    return json.dumps({
        "file": file_path,
        "diagnostics": errors,
        "count": len(errors),
    })


def get_tools() -> list[ToolDef]:
    return [
        ToolDef(
            name="lsp_definition",
            description=(
                "Jump to the definition of a symbol (function, class, variable) at a given "
                "position in a file. Uses LSP when available, falls back to grep-based search."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Absolute path to the file",
                    },
                    "line": {
                        "type": "integer",
                        "description": "Line number (1-indexed)",
                    },
                    "character": {
                        "type": "integer",
                        "description": "Column number (0-indexed, defaults to 0)",
                    },
                },
                "required": ["file_path", "line"],
            },
            handler=lsp_definition,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=True,
        ),
        ToolDef(
            name="lsp_references",
            description=(
                "Find all references to a symbol at a given position in a file. "
                "Uses LSP when available, falls back to grep-based search."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Absolute path to the file",
                    },
                    "line": {
                        "type": "integer",
                        "description": "Line number (1-indexed)",
                    },
                    "character": {
                        "type": "integer",
                        "description": "Column number (0-indexed, defaults to 0)",
                    },
                },
                "required": ["file_path", "line"],
            },
            handler=lsp_references,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=True,
        ),
        ToolDef(
            name="lsp_diagnostics",
            description=(
                "Get diagnostics (errors, warnings) for a file. "
                "For Python files, uses py_compile and ast.parse. "
                "For other files, uses LSP server when available."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "file_path": {
                        "type": "string",
                        "description": "Absolute path to the file",
                    },
                },
                "required": ["file_path"],
            },
            handler=lsp_diagnostics,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=False,  # mutates _opened_files and calls time.sleep
        ),
    ]
