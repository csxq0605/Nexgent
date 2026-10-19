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
    timeout = params.get("timeout", 60)
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write(code)
            tmp_path = f.name
        # Use Popen for explicit kill on timeout (subprocess.run may leave orphan)
        proc = subprocess.Popen(
            [sys.executable, tmp_path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding="utf-8", errors="replace",
        )
        try:
            stdout, stderr = proc.communicate(timeout=timeout)
            output = (stdout + stderr).strip()
            return json.dumps({
                "exit_code": proc.returncode,
                "output": output,
            })
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
            # Explicitly close pipe file descriptors to prevent FD leak
            if proc.stdout:
                proc.stdout.close()
            if proc.stderr:
                proc.stderr.close()
            return json.dumps({"error": f"Code execution timed out after {timeout}s"})
    except Exception as e:
        return json.dumps({"error": str(e)})
    finally:
        if tmp_path:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


def get_tools() -> list[ToolDef]:
    return [
        ToolDef(
            name="execute_python",
            description="Execute Python code in an isolated subprocess. Useful for calculations, data processing, and testing.",
            parameters={
                "type": "object",
                "properties": {
                    "code": {"type": "string", "description": "Python code to execute"},
                    "timeout": {"type": "integer", "description": "Timeout in seconds (default 60)"},
                },
                "required": ["code"]
            },
            handler=execute_python,
            permission=Permission.WRITE,
            is_read_only=False,
            is_concurrency_safe=False,
        ),
    ]
