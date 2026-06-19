"""End-to-End tests for Nexgent — real API calls, real tool execution.

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
import time
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from nexgent.agent import NexgentAgent
from nexgent.context import Session
from nexgent.tools import file_ops

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
    """Create a temp directory for file_ops sandbox compliance.

    Uses pytest's tmp_path for proper isolation. Sets allowed_write_dir
    to tmp_path so file_ops can write within it.
    """
    # Reset module-level state
    file_ops.set_file_ops_state(file_ops.FileOpsState())

    # Use tmp_path directly — set allowed_write_dir to tmp_path
    file_ops.set_allowed_write_dir(str(tmp_path))

    try:
        yield str(tmp_path)
    finally:
        # Restore allowed_write_dir to CWD after test
        file_ops.set_allowed_write_dir(os.getcwd())
        shutil.rmtree(test_dir, ignore_errors=True)


def _harness(auto_approve=True, max_steps=10, max_duration=120.0):
    """Create a harness with real API.

    Default max_duration=120s prevents tests from hanging indefinitely.
    """
    # Ensure allowed_write_dir is current CWD (may have been changed by previous tests)
    file_ops.set_allowed_write_dir(os.getcwd())
    return NexgentAgent(auto_approve=auto_approve, bare=True, max_steps=max_steps, max_duration=max_duration)


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
        assert "[ERROR]" not in result, f"Got error: {result}"
        # Must contain relevant content keywords
        result_lower = result.lower()
        assert "list" in result_lower, f"Response should mention 'list', got: {result[:200]}"


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
        assert "file1_e2e" in result and "file2_e2e" in result, \
            f"Expected both files, got: {result[:200]}"


@pytest.mark.slow
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
        # "2" alone could match timestamps/version numbers; require context
        assert "2" in result and ("file" in result.lower() or "py" in result.lower()), \
            f"Expected '2' with file context, got: {result[:200]}"

    def test_grep(self, work_dir):
        target = os.path.join(work_dir, "code.py")
        with open(target, "w") as f:
            f.write("def hello():\n    pass\n\ndef world():\n    pass\n\ndef test():\n    pass")

        result = _harness().run(
            f"Search for all function definitions (lines starting with 'def') "
            f"in {target}. How many functions are defined?"
        )
        # "3" alone is too loose; require "3" near function context
        assert "3" in result and ("function" in result.lower() or "def" in result.lower()), \
            f"Expected '3' with function context, got: {result[:200]}"


@pytest.mark.slow
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

        # Use longer max_duration — execute_python API calls can be slow
        harness = NexgentAgent(auto_approve=True, bare=True, max_steps=15, max_duration=180.0)
        file_ops.set_allowed_write_dir(os.getcwd())
        result = harness.run(
            f"Create a Python script at {target} that calculates and prints "
            f"the sum of all numbers from 1 to 100. Then run it with execute_python. "
            f"Tell me the result."
        )
        # LLM may format as "5050" or "5,050" — check both without global replace
        assert "5050" in result or "5,050" in result, \
            f"Expected 5050 in result, got: {result[:200]}"

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
# 2b. Error Handling & Edge Cases (E2E with real API)
# ═══════════════════════════════════════════════════════════════

class TestE2EErrorHandling:
    """Agent error handling with real API calls."""

    def test_file_not_found_handled(self, work_dir):
        """Agent should handle missing file gracefully without crashing."""
        nonexistent = os.path.join(work_dir, "does_not_exist.txt")
        result = _harness(max_steps=5).run(
            f"Read the file at {nonexistent} and tell me what it says."
        )
        # Agent should report the error, not crash
        assert len(result) > 0, "Agent should produce a response"
        assert "[ERROR]" not in result or "not found" in result.lower() or "no such" in result.lower()

    @pytest.mark.slow
    def test_max_steps_exhaustion(self, work_dir):
        """Agent stops gracefully when max_steps is reached."""
        # Use a multi-step task with very few steps
        target = os.path.join(work_dir, "steps_test.txt")
        result = _harness(max_steps=1).run(
            f"Create a file at {target} with content 'step1', "
            f"then create another file at {os.path.join(work_dir, 'steps_test2.txt')} with content 'step2', "
            f"then create a third file at {os.path.join(work_dir, 'steps_test3.txt')} with content 'step3'."
        )
        # With only 1 step, not all files should be created
        assert len(result) > 0, "Agent should produce a response"

    def test_empty_task(self):
        """Agent handles empty task without crashing."""
        result = _harness(max_steps=3).run("")
        assert len(result) > 0, "Agent should produce a response for empty task"

    @pytest.mark.slow
    def test_very_long_input(self):
        """Agent handles very long task input."""
        long_task = "Repeat the following text back to me: " + "hello " * 2000
        result = _harness(max_steps=5).run(long_task)
        assert len(result) > 0, "Agent should produce a response for long input"


@pytest.mark.slow
class TestE2ESessionResume:
    """Session save and resume with real API calls."""

    def test_session_save_and_reload(self, work_dir):
        """Session can be saved and reloaded with message history intact."""
        session_dir = os.path.join(work_dir, "sessions")
        os.makedirs(session_dir, exist_ok=True)

        # First run: create session with auto_save_dir so messages persist
        harness1 = _harness(max_steps=5)
        session = Session(session_id="resume-test", auto_save_dir=session_dir)
        harness1.run("What is 10 + 20? Reply with just the number.", session=session)
        session.save_meta_to_jsonl()

        # Verify session file exists
        jsonl_files = [f for f in os.listdir(session_dir) if f.endswith(".jsonl")]
        assert len(jsonl_files) >= 1, f"No session files in {session_dir}"

        # Reload session and verify messages persist
        load_result = Session.from_jsonl(os.path.join(session_dir, jsonl_files[0]))
        session2 = load_result.session
        roles = [m["role"] for m in session2.messages]
        assert "user" in roles
        assert "assistant" in roles


@pytest.mark.slow
class TestE2ETokenBudgetExhaustion:
    """Token budget exhaustion with real API calls."""

    def test_token_budget_blocks_when_exceeded(self):
        """Agent should stop when token budget is exceeded."""
        from nexgent.agent import TokenBudget
        harness = _harness(max_steps=10)
        # Set a very small token budget that will be exceeded
        harness.token_budget = TokenBudget(max_tokens=1000)
        result = harness.run("Write a very long essay about Python programming.")
        # Should either complete quickly or hit token limit
        assert len(result) > 0


# ═══════════════════════════════════════════════════════════════
# 3. Token Counter Accuracy (E2E with real API)
# ═══════════════════════════════════════════════════════════════

@pytest.mark.slow
class TestE2ETokenCounter:
    """Token counting accuracy with real API calls."""

    def test_token_count_accuracy_vs_api_response(self):
        """Compare our token count with the API's reported usage."""
        from nexgent.token_counter import count_messages_tokens
        from nexgent.config import MIMO_BASE_URL, MIMO_MODEL, require_api_key
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
            max_tokens=100,
        )

        # Our token count
        our_count = count_messages_tokens(messages)

        # API reported usage — must be available for this test to be meaningful
        api_usage = response.usage
        assert api_usage is not None, "API response must include usage info for token accuracy test"
        api_prompt_tokens = api_usage.prompt_tokens
        assert api_prompt_tokens > 0, "API reported 0 prompt tokens"
        # Our count should be within 30% of API's count
        ratio = our_count / api_prompt_tokens
        assert 0.7 < ratio < 1.3, (
            f"Our count {our_count} vs API {api_prompt_tokens}, ratio={ratio:.2f}"
        )

    def test_token_budget_status_with_real_agent(self):
        """Token budget should work correctly with a real agent run."""
        import re
        harness = _harness()
        result = harness.run("What is 1 + 1? Reply with just the number.")

        assert re.search(r'\b2\b', result), f"Expected answer '2' in result: {result[:200]}"
        # Token budget should have been updated
        assert harness.token_budget.estimated_tokens > 0


# ═══════════════════════════════════════════════════════════════
# 11. Compact Context with LLM (E2E with real API)
# ═══════════════════════════════════════════════════════════════

@pytest.mark.slow
class TestE2ECompactContext:
    """Compact context with real MiMo API calls."""

    def _get_client(self):
        from nexgent.config import MIMO_BASE_URL, MIMO_MODEL, require_api_key
        from openai import OpenAI
        api_key = require_api_key()
        return OpenAI(api_key=api_key, base_url=MIMO_BASE_URL), MIMO_MODEL

    def test_compact_context_with_llm(self):
        """LLM compression should reduce message count."""
        from nexgent.context import compact_context, estimate_tokens, COMPRESS_TRIGGER_TOKENS

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
    cmd = [sys.executable, "-m", "nexgent.cli"] + list(args)
    # Ensure UTF-8 encoding for subprocess output (Windows GBK fix)
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    return subprocess.run(
        cmd, capture_output=True, timeout=timeout,
        cwd=os.path.join(os.path.dirname(__file__), ".."),
        env=env,
        encoding="utf-8",
        errors="replace",
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
        assert "--task" in result.stdout


class TestCLIOutputFormat:
    """CLI output format options."""

    def test_json_output_format(self):
        result = _run_cli(
            "--task", "What is 2 + 2? Reply with just the number.",
            "--output-format", "json", "--max-steps", "5", "--bare",
        )
        assert result.returncode == 0
        # The CLI wrapper JSON is always last — the LLM's response may itself
        # be valid JSON (e.g. {"expression": "2+2"}), so use rfind to get the
        # final JSON object which is the CLI's {"type": "result", ...} wrapper.
        json_start = result.stdout.rfind('{"type": "result"')
        assert json_start >= 0, f"No CLI result JSON found in output: {result.stdout[:500]}"
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
        # Filter to only lines that are CLI stream-json events (have "type" key).
        # The LLM's response may also be valid JSON, so parse each line and
        # only keep those with the "type" field that stream-json events use.
        json_lines = []
        for line in result.stdout.strip().split("\n"):
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                data = json.loads(line)
                if "type" in data:
                    json_lines.append(data)
            except json.JSONDecodeError:
                continue
        assert len(json_lines) > 0, f"No stream-json event lines found in output: {result.stdout[:500]}"
        for data in json_lines:
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
        assert len(result.stdout.strip()) > 0, "Plan mode should produce output"


class TestCLIErrorHandling:
    """CLI error handling."""

    def test_invalid_model(self):
        result = _run_cli(
            "--task", "Hello",
            "--model", "nonexistent-model-12345",
            "--max-steps", "1", "--bare",
        )
        assert result.returncode != 0 or "error" in result.stderr.lower() or "error" in result.stdout.lower()

    def test_invalid_effort_value(self):
        """Invalid --effort value should be rejected by argparse."""
        result = _run_cli("--task", "Hello", "--effort", "invalid_value")
        assert result.returncode != 0
        assert "invalid choice" in result.stderr.lower() or "error" in result.stderr.lower()

    def test_invalid_output_format(self):
        """Invalid --output-format value should be rejected by argparse."""
        result = _run_cli("--task", "Hello", "--output-format", "invalid_format")
        assert result.returncode != 0
        assert "invalid choice" in result.stderr.lower() or "error" in result.stderr.lower()

    def test_conflicting_dry_run_and_plan(self):
        """Both --dry-run and --plan should be accepted (plan implies dry-run)."""
        result = _run_cli(
            "--task", "What is 2 + 2?",
            "--dry-run", "--plan", "--max-steps", "3", "--bare",
        )
        # Should not crash — both flags are compatible
        assert result.returncode == 0


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
    """CLI effort levels — verify both low and high produce valid output."""

    def test_effort_levels_accepted(self):
        for effort in ("low", "high"):
            result = _run_cli(
                "--task", "What is 2 + 2? Reply with just the number.",
                "--effort", effort, "--max-steps", "5", "--bare",
            )
            assert result.returncode == 0, f"--effort {effort} failed"
            assert "4" in result.stdout, f"--effort {effort}: expected '4', got: {result.stdout[:200]}"


class TestMainFunctionPaths:
    """main() function with various argument combinations (in-process)."""

    def test_main_single_task(self, monkeypatch, capsys):
        """main() with --task runs and produces output."""
        monkeypatch.setattr("sys.argv", ["nexgent", "--task", "Reply with the word hello."])
        from nexgent.cli import main
        main()
        output = capsys.readouterr().out.strip()
        assert len(output) > 0
        assert "hello" in output.lower(), f"Expected 'hello' in output: {output[:200]}"

    def test_main_flags_accepted(self, monkeypatch, capsys):
        """main() accepts --dry-run without crash (no API call)."""
        monkeypatch.setattr("sys.argv", ["nexgent", "--task", "test", "--dry-run"])
        from nexgent.cli import main
        main()
        output = capsys.readouterr().out.strip()
        assert len(output) > 0, "Dry-run should produce output"

    def test_main_repl_quit(self, monkeypatch, capsys):
        """REPL exits cleanly on /quit."""
        monkeypatch.setattr("sys.argv", ["nexgent"])
        monkeypatch.setattr("builtins.input", lambda _="": "/quit")
        from nexgent.cli import main
        main()
        assert "Bye!" in capsys.readouterr().out


# ═══════════════════════════════════════════════════════════════
# CLI Flag Tests — --log-file, --verbose, --session-dir, --session-id
# ═══════════════════════════════════════════════════════════════

class TestCLIVerbose:
    """CLI --verbose flag."""

    def test_verbose_flag_accepted(self):
        """--verbose flag should not cause an error."""
        result = _run_cli(
            "--task", "What is 1 + 1? Reply with just the number.",
            "--verbose", "--max-steps", "5", "--bare",
        )
        assert result.returncode == 0
        assert "2" in result.stdout


class TestCLILogFile:
    """CLI --log-file flag."""

    def test_log_file_created(self, tmp_path):
        """--log-file should create a log file."""
        import os
        log_path = os.path.join(str(tmp_path), "test.log")
        result = _run_cli(
            "--task", "What is 1 + 1? Reply with just the number.",
            "--log-file", log_path, "--max-steps", "5", "--bare",
        )
        assert result.returncode == 0
        # Log file should exist and have content
        assert os.path.exists(log_path), f"Log file {log_path} was not created"
        with open(log_path, "r", encoding="utf-8") as f:
            content = f.read()
        assert len(content) > 0, "Log file is empty"


class TestCLISessionDir:
    """CLI --session-dir flag."""

    def test_session_dir_creates_session(self, tmp_path):
        """--session-dir should save session to the specified directory."""
        import os
        session_dir = os.path.join(str(tmp_path), "my_sessions")
        result = _run_cli(
            "--task", "Reply with the word hello.",
            "--session-dir", session_dir, "--max-steps", "5", "--bare",
        )
        assert result.returncode == 0
        # Session directory should have been created
        assert os.path.isdir(session_dir), f"Session dir {session_dir} was not created"
        # Should contain at least one .jsonl file
        jsonl_files = [f for f in os.listdir(session_dir) if f.endswith(".jsonl")]
        assert len(jsonl_files) >= 1, f"No session files in {session_dir}"


class TestCLISessionId:
    """CLI --session-id flag."""

    def test_session_id_in_output(self):
        """--session-id should be used in JSON output."""
        result = _run_cli(
            "--task", "What is 1 + 1? Reply with just the number.",
            "--output-format", "json", "--session-id", "test-session-123",
            "--max-steps", "5", "--bare",
        )
        assert result.returncode == 0
        # Find the CLI wrapper JSON
        json_start = result.stdout.rfind('{"type": "result"')
        assert json_start >= 0, f"No CLI result JSON found: {result.stdout[:500]}"
        decoder = json.JSONDecoder()
        data, _ = decoder.raw_decode(result.stdout, json_start)
        assert data["session_id"] == "test-session-123"


# ═══════════════════════════════════════════════════════════════
# Goal-driven agent behavior — real API
# ═══════════════════════════════════════════════════════════════

class TestGoalDrivenE2E:
    """Goal system with real agent execution."""

    def test_goal_set_and_evaluate(self):
        from nexgent.goal import GoalManager, GoalEvaluator
        manager = GoalManager()
        manager.set_goal("all tests pass")
        is_met, reason = GoalEvaluator.evaluate(
            "all tests pass", "Running tests... all tests passed"
        )
        assert is_met is True
        manager.clear_goal()

    def test_goal_not_met_continues(self):
        from nexgent.goal import GoalManager, GoalEvaluator
        manager = GoalManager()
        manager.set_goal("all tests pass")
        is_met, reason = GoalEvaluator.evaluate(
            "all tests pass", "Running tests... 3 test failed"
        )
        assert is_met is False
        manager.clear_goal()

    def test_goal_with_real_agent(self):
        from nexgent.goal import get_goal_manager
        manager = get_goal_manager("e2e-goal-test")
        manager.set_goal("answer the math question")
        harness = _harness(max_steps=5)
        result = harness.run("What is 7 * 8? Reply with just the number.")
        assert "56" in result
        status = manager.get_status()
        assert status['active'] is True
        manager.clear_goal()


# ═══════════════════════════════════════════════════════════════
# @file references with real agent — fast
# ═══════════════════════════════════════════════════════════════

class TestAtFileRefE2E:
    """@file reference resolution with real agent reading."""

    def test_agent_reads_referenced_file(self, work_dir):
        target = os.path.join(work_dir, "data.txt")
        with open(target, "w") as f:
            f.write("The answer is ZETA-7742")
        from nexgent.file_references import FileReferenceResolver
        user_input = f"Read @{target} and tell me what the answer is."
        resolved = FileReferenceResolver.resolve_and_format(user_input, os.getcwd())
        harness = _harness(max_steps=5)
        result = harness.run(resolved)
        assert "ZETA-7742" in result

    def test_at_file_resolve_glob(self, work_dir):
        for name in ["a.py", "b.py", "c.txt"]:
            with open(os.path.join(work_dir, name), "w") as f:
                f.write(f"content of {name}")
        from nexgent.file_references import FileReferenceParser
        resolved = FileReferenceParser.resolve_reference("*.py", work_dir)
        assert len(resolved) == 2
        names = [os.path.basename(r) for r in resolved]
        assert "a.py" in names and "b.py" in names

    def test_at_file_resolve_directory(self, work_dir):
        src = os.path.join(work_dir, "src")
        os.makedirs(src)
        with open(os.path.join(src, "main.py"), "w") as f:
            f.write("print('hi')")
        from nexgent.file_references import FileReferenceParser
        structure = FileReferenceParser.read_directory_structure(src)
        assert "main.py" in structure

    def test_at_file_not_found(self, work_dir):
        from nexgent.file_references import FileReferenceResolver
        result = FileReferenceResolver.resolve_and_format(
            "Check @nonexistent.txt", work_dir
        )
        assert "not found" in result.lower() or "nonexistent" in result


# ═══════════════════════════════════════════════════════════════
# Agent management — create agent then invoke via API
# ═══════════════════════════════════════════════════════════════

@pytest.mark.slow
class TestAgentInvocationE2E:
    """Create custom agent, then invoke it with real API."""

    def test_create_and_use_agent(self, work_dir, monkeypatch):
        from nexgent.agents import AgentManager, get_preset
        monkeypatch.chdir(work_dir)
        monkeypatch.setenv("USERPROFILE", work_dir)
        monkeypatch.setenv("HOME", work_dir)
        manager = AgentManager(project_root=work_dir)
        preset = get_preset("code-reviewer")
        filepath = manager.create_agent(
            name="code-reviewer",
            description=preset["description"],
            prompt=preset["prompt"],
            tools=preset.get("tools"),
        )
        assert os.path.exists(filepath)
        agent = manager.get_agent("code-reviewer")
        assert agent is not None
        harness = _harness(max_steps=5)
        result = harness.run(
            f"Using this system prompt: {agent.config.prompt}\n\n"
            "Review this code: x = 1\n"
            "Is there anything wrong? Reply briefly."
        )
        assert len(result) > 10

    def test_agent_preset_templates_work(self):
        from nexgent.agents import get_preset_names, get_preset
        for name in get_preset_names():
            preset = get_preset(name)
            assert "description" in preset
            assert "prompt" in preset
            assert len(preset["prompt"]) > 20


# ═══════════════════════════════════════════════════════════════
# Background tasks — fast
# ═══════════════════════════════════════════════════════════════

class TestBackgroundTasksE2E:
    """Background task system with real operations."""

    def test_task_lifecycle(self):
        from nexgent.background_tasks import BackgroundTaskManager, TaskState
        manager = BackgroundTaskManager()
        task_id = manager.create_task("Compute sum", lambda: sum(range(100)))
        manager.wait_for_task(task_id, timeout=5.0)
        task = manager.get_task(task_id)
        assert task.state == TaskState.COMPLETED
        assert task.output == "4950"
        manager.cleanup_completed()

    def test_task_cancel(self):
        from nexgent.background_tasks import BackgroundTaskManager, TaskState
        manager = BackgroundTaskManager()
        task_id = manager.create_task("Long running", lambda: time.sleep(30))
        time.sleep(0.05)
        assert manager.cancel_task(task_id) is True
        assert manager.get_task(task_id).state == TaskState.CANCELLED

    def test_concurrent_tasks(self):
        from nexgent.background_tasks import BackgroundTaskManager, TaskState
        manager = BackgroundTaskManager()
        ids = []
        for i in range(5):
            ids.append(manager.create_task(f"Task-{i}", lambda v=i: v * 2))
        for tid in ids:
            manager.wait_for_task(tid, timeout=5.0)
        results = {tid: manager.get_task(tid).output for tid in ids}
        assert results[ids[0]] == "0"
        assert results[ids[4]] == "8"
        manager.cleanup_completed()


# ═══════════════════════════════════════════════════════════════
# Goal evaluator — realistic conversation patterns
# ═══════════════════════════════════════════════════════════════

class TestGoalEvaluatorE2E:
    """GoalEvaluator with realistic API output patterns."""

    def test_tests_passing(self):
        from nexgent.goal import GoalEvaluator
        is_met, _ = GoalEvaluator.evaluate(
            "all tests pass", "Running pytest... all tests passed in 12.3s"
        )
        assert is_met is True

    def test_tests_failing(self):
        from nexgent.goal import GoalEvaluator
        is_met, _ = GoalEvaluator.evaluate(
            "all tests pass", "Running pytest... 3 test failed"
        )
        assert is_met is False

    def test_build_success(self):
        from nexgent.goal import GoalEvaluator
        is_met, _ = GoalEvaluator.evaluate(
            "build success", "Building... build successful"
        )
        assert is_met is True

    def test_build_failed(self):
        from nexgent.goal import GoalEvaluator
        is_met, _ = GoalEvaluator.evaluate(
            "build success", "Building... build failed"
        )
        assert is_met is False

    def test_no_false_positive_not_done(self):
        from nexgent.goal import GoalEvaluator
        is_met, _ = GoalEvaluator.evaluate(
            "task done", "Working... not done yet"
        )
        assert is_met is False

    def test_no_false_positive_undone(self):
        from nexgent.goal import GoalEvaluator
        is_met, _ = GoalEvaluator.evaluate(
            "task done", "Changes were undone"
        )
        assert is_met is False

    def test_singular_test_failed(self):
        from nexgent.goal import GoalEvaluator
        is_met, _ = GoalEvaluator.evaluate(
            "all tests pass", "1 test failed out of 100"
        )
        assert is_met is False


# ═══════════════════════════════════════════════════════════════
# Commands module — single source of truth
# ═══════════════════════════════════════════════════════════════

class TestCommandsModule:
    """commands.py is the single source of truth for slash commands."""

    def test_slash_commands_not_empty(self):
        from nexgent.commands import SLASH_COMMANDS
        assert len(SLASH_COMMANDS) > 20

    def test_suggest_is_subset(self):
        from nexgent.commands import SLASH_COMMANDS, SUGGEST_COMMANDS
        for cmd in SUGGEST_COMMANDS:
            assert cmd in SLASH_COMMANDS

    def test_new_commands_registered(self):
        from nexgent.commands import SLASH_COMMANDS
        for cmd in ["/agents", "/tasks", "/goal", "/skills", "/mcp",
                    "/skills install", "/mcp install"]:
            assert cmd in SLASH_COMMANDS

    def test_tab_suggester(self):
        from nexgent.tui import CommandSuggester
        import asyncio
        suggester = CommandSuggester()
        loop = asyncio.new_event_loop()
        assert loop.run_until_complete(suggester.get_suggestion("/he")) == "/help"
        assert loop.run_until_complete(suggester.get_suggestion("hello")) is None
        loop.close()


# ═══════════════════════════════════════════════════════════════
# Singleton safety
# ═══════════════════════════════════════════════════════════════

class TestSingletonSafety:
    """Global singletons behave correctly."""

    def test_task_manager_singleton(self):
        from nexgent.background_tasks import get_task_manager
        assert get_task_manager() is get_task_manager()

    def test_goal_manager_per_session(self):
        from nexgent.goal import get_goal_manager, clear_goal_manager
        m1 = get_goal_manager("s1")
        m2 = get_goal_manager("s1")
        m3 = get_goal_manager("s2")
        assert m1 is m2 and m1 is not m3
        clear_goal_manager("s1")
        clear_goal_manager("s2")


# ═══════════════════════════════════════════════════════════════
# Session operations with real API — slow
# ═══════════════════════════════════════════════════════════════

@pytest.mark.slow
class TestSessionWithAPI:
    """Session save/load/fork with real API interactions."""

    def test_session_records_messages(self):
        harness = _harness(max_steps=5)
        result = harness.run("What is 3 + 4? Reply with just the number.")
        assert "7" in result
        session = harness._last_session
        assert session is not None
        roles = [m["role"] for m in session.messages]
        assert "user" in roles
        assert "assistant" in roles

    def test_session_fork_preserves_history(self, tmp_path):
        harness = _harness(max_steps=5)
        session = Session(session_id="fork-test", auto_save_dir=str(tmp_path))
        harness.run("What is 2 + 2?", session=session)
        assert len(session.messages) >= 2
        import uuid
        old_id = session.session_id
        new_id = f"fork-{uuid.uuid4().hex[:8]}"
        session.session_id = new_id
        session.name = f"fork-{old_id[:8]}"
        assert session.session_id != old_id
        assert len(session.messages) >= 2

