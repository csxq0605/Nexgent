"""Code execution tool - run Python code in isolated subprocess.

Ch3 markers:
- execute_python: write (side effects), NOT concurrency-safe
"""

import os
import sys
import json
import tempfile
import subprocess
from .registry import ToolDef
from ..permissions import Permission


def execute_python(params: dict) -> str:
    code = params.get("code", "")
    timeout = params.get("timeout", 10)
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            tmp_path = f.name
        try:
            result = subprocess.run(
                [sys.executable, tmp_path],
                capture_output=True, text=True, timeout=timeout,
                encoding="utf-8", errors="replace"
            )
            output = (result.stdout + result.stderr).strip()
            if len(output) > 5000:
                output = output[:5000] + "\n... [truncated]"
            return json.dumps({
                "exit_code": result.returncode,
                "output": output,
            })
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass  # Windows: file may still be locked by subprocess
    except subprocess.TimeoutExpired:
        return json.dumps({"error": f"Code execution timed out after {timeout}s"})
    except Exception as e:
        return json.dumps({"error": str(e)})


def get_tools() -> list[ToolDef]:
    return [
        ToolDef(
            name="execute_python",
            description="Execute Python code in an isolated subprocess. Useful for calculations, data processing, and testing.",
            parameters={
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "Python code to execute"},
                    "timeout": {"type": "integer", "description": "Timeout in seconds (default 10)"},
                },
                "required": ["code"]
            },
            handler=execute_python,
            permission=Permission.WRITE,
            is_read_only=False,
            is_concurrency_safe=False,
        ),
    ]
