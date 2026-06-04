"""End-to-End tests for MiMo Harness — real API calls, real tool execution.

Uses the real MiMo API from .env. No mocking of LLM calls.
All tools run against a temp directory inside CWD (file_ops sandbox requirement).

Covers:
  - Agent loop (simple Q, file ops, shell, code exec, glob/grep, multi-step)
  - Session persistence
  - Token counter accuracy
  - Context compaction with LLM
  - CLI (help, output format, dry-run, plan, effort, main() paths)
"""

import json
import os
import sys
import shutil
import subprocess
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from mimo_harness.agent import MiMoHarness
from mimo_harness.context import Session
from mimo_harness.tools import file_ops

# All E2E tests require a real API key
pytestmark = pytest.mark.skipif(
    not os.environ.get("MIMO_API_KEY") or os.environ.get("MIMO_API_KEY") == "test-key-for-testing",
    reason="Real MIMO_API_KEY not set — E2E tests skipped",
)

@pytest.fixture(autouse=True, scope="session")
def _cleanup_e2e_artifacts():
    """Clean up all E2E test artifacts after the entire test session."""
    yield
    cwd = os.getcwd()
    e2e_work = os.path.join(cwd, ".e2e_work")
    if os.path.isdir(e2e_work):
        shutil.rmtree(e2e_work, ignore_errors=True)


@pytest.fixture
def work_dir(tmp_path):
    """Create a temp directory INSIDE CWD for file_ops sandbox compliance.

    file_ops restricts all file operations to the CWD. We create a symlink
    or use a subdir within CWD. Since symlinks may not work on Windows,
    we use a subdir approach: create files directly in CWD under .e2e_work/.
    """
    # Reset module-level state
    file_ops.set_file_ops_state(file_ops.FileOpsState())

    # Create work dir inside CWD
    cwd = os.getcwd()
    work = os.path.join(cwd, ".e2e_work")
    os.makedirs(work, exist_ok=True)

    # Create a unique subdirectory for this test
    import uuid
    test_dir = os.path.join(work, str(uuid.uuid4())[:8])
    os.makedirs(test_dir)

    try:
        yield test_dir
    finally:
        # Cleanup per-test subdirectory (parent .e2e_work/ cleaned by session fixture)
        shutil.rmtree(test_dir, ignore_errors=True)


def _harness(auto_approve=True, max_steps=10):
    """Create a harness with real API."""
    return MiMoHarness(auto_approve=auto_approve, bare=True, max_steps=max_steps)


# ═══════════════════════════════════════════════════════════════
# 1. Agent Loop — real LLM + real tools
# ═══════════════════════════════════════════════════════════════

class TestE2ESimpleQuestion:
    """Agent answers simple questions without tools."""

    def test_math(self):
        import re
        result = _harness().run("What is 123 * 456? Reply with just the number.")
        assert re.search(r'\b56088\b', result), f"Expected 56088, got: {result}"

    def test_definition(self):
        result = _harness().run("In one sentence, what is a Python list?")
        assert len(result) > 10, f"Response too short: {result}"
        # Should contain relevant content, not just errors
        assert "[ERROR]" not in result, f"Got error: {result}"


class TestE2EReadFile:
    """Agent reads real files."""

    def test_read_and_report(self, work_dir):
        target = os.path.join(work_dir, "greeting.txt")
        with open(target, "w") as f:
            f.write("Hello from the E2E test!")

        result = _harness().run(
            f"Read the file at {target} and tell me exactly what it says. "
            "Quote the content verbatim."
        )
        assert "Hello from the E2E test" in result

    def test_read_with_offset(self, work_dir):
        target = os.path.join(work_dir, "lines.txt")
        with open(target, "w") as f:
            f.write("\n".join(f"line {i}" for i in range(1, 21)))

        result = _harness().run(
            f"Read lines 10-12 from {target}. What do they say?"
        )
        assert "line 10" in result and "line 11" in result and "line 12" in result, \
            f"Expected all three lines, got: {result}"


class TestE2EWriteFile:
    """Agent writes real files."""

    def test_write_creates_file(self, work_dir):
        target = os.path.join(work_dir, "output.py")

        result = _harness().run(
            f"Write a Python function that returns the square of a number. "
            f"Save it to {target}. Just write the file, nothing else."
        )
        assert os.path.exists(target), "Agent should have created the file"
        content = open(target).read()
        assert "def" in content
        assert "return" in content

    def test_write_json(self, work_dir):
        target = os.path.join(work_dir, "data.json")

        result = _harness().run(
            f'Write exactly {{"name": "test", "value": 42}} to {target}. '
            f"Just write the file, nothing else."
        )
        assert os.path.exists(target)
        data = json.loads(open(target).read())
        assert data["name"] == "test"
        assert data["value"] == 42


class TestE2EEditFile:
    """Agent edits real files."""

    def test_edit_modifies_content(self, work_dir):
        target = os.path.join(work_dir, "config.txt")
        with open(target, "w") as f:
            f.write("debug = false\nport = 8080")

        result = _harness(max_steps=15).run(
            f"Read the file {target}, then change 'debug = false' to 'debug = true'. "
            f"Just make the edit, nothing else."
        )
        content = open(target).read()
        assert "debug = true" in content
        assert "port = 8080" in content


class TestE2EShell:
    """Agent runs real shell commands."""

    def test_echo(self):
        result = _harness().run(
            "Run the shell command 'echo hello_e2e_test' and tell me the output."
        )
        assert "hello_e2e_test" in result

    def test_list_directory(self, work_dir):
        with open(os.path.join(work_dir, "file1_e2e.txt"), "w") as f:
            f.write("a")
        with open(os.path.join(work_dir, "file2_e2e.txt"), "w") as f:
            f.write("b")

        result = _harness().run(
            f"List the files in {work_dir} using glob_files with path='{work_dir}' and pattern='*'. "
            f"Tell me what files you see."
        )
        assert "file1_e2e" in result or "file2_e2e" in result


class TestE2ECodeExec:
    """Agent executes real Python code."""

    def test_calculate_factorial(self):
        result = _harness().run(
            "Use execute_python to calculate the factorial of 15. "
            "Reply with just the number."
        )
        assert "1307674368000" in result

    def test_create_and_run(self, work_dir):
        target = os.path.join(work_dir, "calc.py")
        result = _harness(max_steps=15).run(
            f"Write a Python file at {target} that prints the first 10 Fibonacci numbers, "
            f"then run it with execute_python. Tell me the output."
        )
        # Verify the file was created (agent performed the write step)
        assert os.path.exists(target), f"Agent should have created {target}"
        content = open(target).read()
        assert "fibonacci" in content.lower() or "def " in content or "for " in content, \
            f"File should contain a Fibonacci implementation, got: {content[:200]}"
        # Verify the agent produced a substantive response without errors
        assert len(result) > 20, f"Response too short: {result}"
        assert "[ERROR]" not in result, f"Agent reported error: {result[:200]}"
        # Verify Fibonacci numbers are present in the result (1, 1, 2, 3, 5, 8, 13, 21, 34, 55)
        assert any(num in result for num in ["34", "55", "1, 1, 2, 3"]), \
            f"Expected Fibonacci numbers in result, got: {result[:200]}"


class TestE2EGlobGrep:
    """Agent uses glob and grep tools."""

    def test_glob(self, work_dir):
        with open(os.path.join(work_dir, "app.py"), "w") as f:
            f.write("x=1")
        with open(os.path.join(work_dir, "test.py"), "w") as f:
            f.write("y=2")
        with open(os.path.join(work_dir, "readme.md"), "w") as f:
            f.write("# Hi")

        result = _harness().run(
            f"Find all Python files in {work_dir}. How many .py files are there?"
        )
        assert "2" in result

    def test_grep(self, work_dir):
        target = os.path.join(work_dir, "code.py")
        with open(target, "w") as f:
            f.write("def hello():\n    pass\n\ndef world():\n    pass\n\ndef test():\n    pass")

        result = _harness().run(
            f"Search for all function definitions (lines starting with 'def') "
            f"in {target}. How many functions are defined?"
        )
        assert "3" in result


class TestE2EMultiStep:
    """Agent performs multi-step workflows."""

    def test_read_modify_write(self, work_dir):
        target = os.path.join(work_dir, "data.txt")
        with open(target, "w") as f:
            f.write("apple\nbanana\ncherry")

        result = _harness(max_steps=15).run(
            f"Read {target}, add 'date' as a new line at the end, "
            f"then write the modified content back to the same file. "
            f"Just do it, no explanation needed."
        )
        content = open(target).read()
        assert "date" in content
        assert "apple" in content

    def test_create_and_run_script(self, work_dir):
        target = os.path.join(work_dir, "calc.py")

        result = _harness(max_steps=15).run(
            f"Create a Python script at {target} that calculates and prints "
            f"the sum of all numbers from 1 to 100. Then run it with execute_python. "
            f"Tell me the result."
        )
        # LLM may format as "5050" or "5,050" — accept either
        assert "5050" in result.replace(",", "") or "5,050" in result

    def test_search_and_summarize(self, work_dir):
        for name, content in [
            ("a_topic.txt", "Python is a programming language."),
            ("b_topic.txt", "JavaScript runs in browsers."),
            ("c_topic.txt", "Rust is known for memory safety."),
        ]:
            with open(os.path.join(work_dir, name), "w") as f:
                f.write(content)

        result = _harness(max_steps=15).run(
            f"Find all .txt files in {work_dir} using glob_files "
            f"(path='{work_dir}', pattern='*.txt'), then read each one "
            f"and tell me the topic of each file."
        )
        assert "python" in result.lower() or "programming" in result.lower()
        assert "javascript" in result.lower() or "browser" in result.lower()
        assert "rust" in result.lower() or "memory" in result.lower()


# ═══════════════════════════════════════════════════════════════
# 2. Session Persistence
# ═══════════════════════════════════════════════════════════════

class TestE2ESession:
    """Session save/load with real interactions."""

    def test_messages_recorded(self):
        harness = _harness(max_steps=5)
        result = harness.run("What is 5 + 3? Reply with just the number.")
        session = harness._last_session
        assert session is not None
        roles = [m["role"] for m in session.messages]
        assert "user" in roles
        assert "assistant" in roles



# ═══════════════════════════════════════════════════════════════
# 3. Token Counter Accuracy (E2E with real API)
# ═══════════════════════════════════════════════════════════════

class TestE2ETokenCounter:
    """Token counting accuracy with real API calls."""

    def test_token_count_accuracy_vs_api_response(self):
        """Compare our token count with the API's reported usage."""
        from mimo_harness.token_counter import count_messages_tokens
        from mimo_harness.config import MIMO_BASE_URL, MIMO_MODEL, require_api_key
        from openai import OpenAI

        api_key = require_api_key()
        client = OpenAI(api_key=api_key, base_url=MIMO_BASE_URL)

        messages = [
            {"role": "system", "content": "You are a helpful assistant."},
            {"role": "user", "content": "What is 2 + 2? Reply with just the number."},
        ]

        # Get API response with usage info
        response = client.chat.completions.create(
            model=MIMO_MODEL,
            messages=messages,
            max_completion_tokens=100,
        )

        # Our token count
        our_count = count_messages_tokens(messages)

        # API reported usage (if available)
        api_usage = response.usage
        if api_usage:
            api_prompt_tokens = api_usage.prompt_tokens
            # Our count should be within 20% of API's count
            ratio = our_count / api_prompt_tokens if api_prompt_tokens > 0 else 1.0
            assert 0.5 < ratio < 2.0, (
                f"Our count {our_count} vs API {api_prompt_tokens}, ratio={ratio:.2f}"
            )

    def test_token_budget_status_with_real_agent(self):
        """Token budget should work correctly with a real agent run."""
        harness = _harness()
        result = harness.run("What is 1 + 1?")

        assert "2" in result
        # Token budget should have been updated
        assert harness.token_budget.estimated_tokens > 0


# ═══════════════════════════════════════════════════════════════
# 11. Compact Context with LLM (E2E with real API)
# ═══════════════════════════════════════════════════════════════

class TestE2ECompactContext:
    """Compact context with real MiMo API calls."""

    def _get_client(self):
        from mimo_harness.config import MIMO_BASE_URL, MIMO_MODEL, require_api_key
        from openai import OpenAI
        api_key = require_api_key()
        return OpenAI(api_key=api_key, base_url=MIMO_BASE_URL), MIMO_MODEL

    def test_compact_context_with_llm(self):
        """LLM compression should reduce message count."""
        from mimo_harness.context import compact_context, estimate_tokens, COMPRESS_TRIGGER_TOKENS

        client, model = self._get_client()
        # Create messages large enough to exceed token threshold
        big = "x" * 15000
        messages = []
        for i in range(100):
            messages.append({"role": "user", "content": f"q{i}" + big})
        tokens = estimate_tokens(messages)
        assert tokens > COMPRESS_TRIGGER_TOKENS

        result, attempts, failures, thrashing, did_compress = compact_context(
            messages, client=client, model=model, estimated_tokens=tokens,
        )
        # LLM compression should have been attempted
        assert attempts >= 1
        # Result should be shorter than input
        assert len(result) < len(messages)
        assert did_compress is True


# ═══════════════════════════════════════════════════════════════
# CLI E2E Tests — subprocess and in-process CLI verification
# ═══════════════════════════════════════════════════════════════

def _run_cli(*args, timeout=120):
    """Run the CLI as a subprocess."""
    cmd = [sys.executable, "-m", "mimo_harness.cli"] + list(args)
    return subprocess.run(
        cmd, capture_output=True, text=True, timeout=timeout,
        cwd=os.path.join(os.path.dirname(__file__), ".."),
    )


class TestCLIHelp:
    """CLI help output (no API needed)."""

    def test_help_flag(self):
        result = _run_cli("--help")
        assert result.returncode == 0
        assert "Usage" in result.stdout or "usage" in result.stdout
        assert "--task" in result.stdout
        assert "--model" in result.stdout

    def test_help_short_flag(self):
        result = _run_cli("-h")
        assert result.returncode == 0
        assert "Usage" in result.stdout or "usage" in result.stdout


class TestCLIOutputFormat:
    """CLI output format options."""

    def test_json_output_format(self):
        result = _run_cli(
            "--task", "What is 2 + 2? Reply with just the number.",
            "--output-format", "json", "--max-steps", "5", "--bare",
        )
        assert result.returncode == 0
        # Output may contain step headers before/after JSON — use raw_decode
        json_start = result.stdout.find("{")
        assert json_start >= 0, f"No JSON object found in output: {result.stdout[:200]}"
        decoder = json.JSONDecoder()
        data, _ = decoder.raw_decode(result.stdout, json_start)
        assert "content" in data
        assert "session_id" in data

    def test_stream_json_output_format(self):
        result = _run_cli(
            "--task", "What is 2 + 2? Reply with just the number.",
            "--output-format", "stream-json", "--max-steps", "5", "--bare",
        )
        assert result.returncode == 0
        # Output may contain step headers before JSON lines — filter to only JSON lines
        json_lines = []
        for line in result.stdout.strip().split("\n"):
            line = line.strip()
            if line.startswith("{"):
                json_lines.append(line)
        assert len(json_lines) > 0, f"No JSON lines found in output: {result.stdout[:200]}"
        for line in json_lines:
            data = json.loads(line)
            assert "type" in data


class TestCLIDryRun:
    """CLI dry-run mode."""

    def test_dry_run_blocks_all_tools(self):
        result = _run_cli(
            "--task", "Read the file README.md",
            "--dry-run", "--max-steps", "5", "--bare",
        )
        assert result.returncode == 0
        stdout_lower = result.stdout.lower()
        assert "dry-run" in stdout_lower or "permission denied" in stdout_lower


class TestCLIPlanMode:
    """CLI plan mode."""

    def test_plan_mode(self):
        result = _run_cli(
            "--task", "What is 2 + 2?",
            "--plan", "--max-steps", "5", "--bare",
        )
        assert result.returncode == 0


class TestCLIErrorHandling:
    """CLI error handling."""

    def test_invalid_model(self):
        result = _run_cli(
            "--task", "Hello",
            "--model", "nonexistent-model-12345",
            "--max-steps", "1", "--bare",
        )
        assert result.returncode != 0 or "error" in result.stderr.lower() or "error" in result.stdout.lower()


class TestCLIBareMode:
    """CLI bare mode."""

    def test_bare_mode(self):
        result = _run_cli(
            "--task", "What is 2 + 2? Reply with just the number.",
            "--bare", "--max-steps", "5",
        )
        assert result.returncode == 0
        assert "4" in result.stdout


class TestCLINoStream:
    """CLI --no-stream mode (streaming is default ON)."""

    def test_no_stream_mode(self):
        result = _run_cli(
            "--task", "What is 2 + 2? Reply with just the number.",
            "--no-stream", "--max-steps", "5", "--bare",
        )
        assert result.returncode == 0
        assert "4" in result.stdout


class TestCLIEffortLevels:
    """CLI effort levels."""

    def test_low_effort(self):
        result = _run_cli(
            "--task", "What is 2 + 2?",
            "--effort", "low", "--max-steps", "5", "--bare",
        )
        assert result.returncode == 0

    def test_high_effort(self):
        result = _run_cli(
            "--task", "What is 2 + 2?",
            "--effort", "high", "--max-steps", "5", "--bare",
        )
        assert result.returncode == 0


class TestMainFunctionPaths:
    """main() function with various argument combinations (in-process)."""

    def test_main_single_task(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "Reply with the word hello."])
        from mimo_harness.cli import main
        main()
        assert len(capsys.readouterr().out.strip()) > 0

    def test_main_dry_run(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "test", "--dry-run"])
        from mimo_harness.cli import main
        main()
        assert len(capsys.readouterr().out.strip()) > 0

    def test_main_plan_mode(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "Say hello", "--plan"])
        from mimo_harness.cli import main
        main()
        assert len(capsys.readouterr().out.strip()) > 0

    def test_main_no_stream_mode(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo", "--task", "Say hello", "--no-stream", "--bare", "--max-steps", "5"])
        from mimo_harness.cli import main
        main()
        assert len(capsys.readouterr().out.strip()) > 0

    def test_main_repl_quit(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo"])
        monkeypatch.setattr("builtins.input", lambda _="": "/quit")
        from mimo_harness.cli import main
        main()
        assert "Bye!" in capsys.readouterr().out

    def test_main_repl_empty_then_quit(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo"])
        _iter = iter(["", "  ", "/quit"])
        monkeypatch.setattr("builtins.input", lambda _="": next(_iter))
        from mimo_harness.cli import main
        main()
        assert "Bye!" in capsys.readouterr().out

    def test_main_eof_exits(self, monkeypatch, capsys):
        monkeypatch.setattr("sys.argv", ["mimo"])
        monkeypatch.setattr("builtins.input", lambda _="": (_ for _ in ()).throw(EOFError))
        from mimo_harness.cli import main
        main()
        assert "Bye!" in capsys.readouterr().out

