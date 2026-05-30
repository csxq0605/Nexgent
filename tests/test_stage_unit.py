"""Unit tests for Stage 1-8 local logic (no API calls).

These tests verify pure functions, data structures, and tool handlers
extracted from each stage's source code. No LLM API calls are made.
"""
import sys
import json
import asyncio
import inspect
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))


def load_module(name, path):
    """Import a module from a file path (handles hyphenated dirs)."""
    import importlib, importlib.util
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ============================================================
# STAGE 1: Minimal Agent Loop — local logic
# ============================================================

class TestStage1Unit:
    @pytest.fixture(autouse=True)
    def _load(self):
        self.s1 = load_module("stage1", REPO_ROOT / "stage-1" / "minimal_agent.py")

    def test_safe_eval_basic(self):
        safe_eval = self.s1.safe_eval
        assert safe_eval("2 + 3") == 5
        assert safe_eval("10 / 4") == 2.5
        assert safe_eval("2 ** 10") == 1024
        assert abs(safe_eval("sqrt(144)") - 12.0) < 1e-9

    def test_safe_eval_rejects_dangerous_input(self):
        safe_eval = self.s1.safe_eval
        with pytest.raises((ValueError, SyntaxError)):
            safe_eval("__import__('os')")

    def test_execute_tool_calculator(self):
        execute_tool = self.s1.execute_tool
        r = json.loads(execute_tool("calculator", {"expression": "3 * 7 + 1"}))
        assert r["result"] == 22

    def test_execute_tool_search(self):
        execute_tool = self.s1.execute_tool
        r = json.loads(execute_tool("search", {"query": "Python"}))
        assert "summary" in r

    def test_execute_tool_path_traversal(self):
        execute_tool = self.s1.execute_tool
        r = json.loads(execute_tool("read_file", {"path": "/etc/passwd"}))
        assert "error" in r

    def test_tool_definitions_complete(self):
        TOOLS = self.s1.TOOLS
        tool_names = [t["function"]["name"] for t in TOOLS]
        assert "calculator" in tool_names
        assert "search" in tool_names
        assert "read_file" in tool_names


# ============================================================
# STAGE 2: Research Assistant — local logic
# ============================================================

class TestStage2Unit:
    @pytest.fixture(autouse=True)
    def _load(self):
        self.s2 = load_module("stage2", REPO_ROOT / "stage-2" / "research_assistant.py")

    def test_memory_store_and_retrieve(self):
        Memory = self.s2.Memory
        m = Memory()
        m.store_long_term("Python is a programming language", "wiki")
        m.store_long_term("JavaScript is for web", "mdn")
        results = m.search_long_term("Python programming")
        assert len(results) >= 1
        assert any("Python" in r["text"] for r in results)

    def test_chunk_text_basic(self):
        chunk_text = self.s2.chunk_text
        text = "A" * 1200
        chunks = chunk_text(text, chunk_size=500, overlap=50)
        assert len(chunks) >= 2
        assert chunks[0] == "A" * 500

    def test_chunk_text_empty(self):
        assert self.s2.chunk_text("") == []

    def test_chunk_text_invalid_params(self):
        with pytest.raises(ValueError):
            self.s2.chunk_text("test", chunk_size=5, overlap=10)

    def test_execute_code_success(self):
        Memory = self.s2.Memory
        execute_tool = self.s2.execute_tool
        m = Memory()
        r = json.loads(execute_tool("execute_code", {"code": "print(2+3)"}, m))
        assert "output" in r
        assert "5" in r["output"]

    def test_execute_code_error(self):
        Memory = self.s2.Memory
        execute_tool = self.s2.execute_tool
        m = Memory()
        r = json.loads(execute_tool("execute_code", {"code": "raise ValueError('test')"}, m))
        assert "error" in r

    def test_save_recall联动(self):
        Memory = self.s2.Memory
        execute_tool = self.s2.execute_tool
        m = Memory()
        execute_tool("save_to_memory", {"text": "The answer to everything is 42", "source": "hitchhiker"}, m)
        assert len(m.long_term_store) == 1
        r = json.loads(execute_tool("recall_memory", {"query": "answer 42"}, m))
        assert len(r["results"]) >= 1
        assert "42" in r["results"][0]

    def test_read_file_path_traversal(self):
        Memory = self.s2.Memory
        execute_tool = self.s2.execute_tool
        m = Memory()
        r = json.loads(execute_tool("read_file", {"path": "/etc/passwd"}, m))
        assert "error" in r


# ============================================================
# STAGE 3: Harness Demo — local logic
# ============================================================

class TestStage3Unit:
    @pytest.fixture(autouse=True)
    def _load(self):
        self.s3 = load_module("stage3", REPO_ROOT / "stage-3" / "harness_demo.py")

    def test_tool_registry_register_execute(self):
        Permission = self.s3.Permission
        ToolDef = self.s3.ToolDef
        ToolRegistry = self.s3.ToolRegistry
        PermissionGate = self.s3.PermissionGate

        reg = ToolRegistry()
        reg.register(ToolDef(
            name="add", description="Add",
            parameters={"type": "object", "properties": {"a": {"type": "number"}, "b": {"type": "number"}}, "required": ["a", "b"]},
            handler=lambda p: json.dumps({"result": p["a"] + p["b"]}),
            permission=Permission.NONE
        ))
        gate = PermissionGate(interactive=False)
        r = json.loads(reg.execute("add", {"a": 3, "b": 4}, gate))
        assert r["result"] == 7

    def test_permission_gate分级(self):
        Permission = self.s3.Permission
        PermissionGate = self.s3.PermissionGate

        gate = PermissionGate(auto_approve={Permission.NONE, Permission.READ}, interactive=False)
        assert gate.check(Permission.NONE) is True
        assert gate.check(Permission.READ) is True
        assert gate.check(Permission.WRITE) is False
        assert gate.check(Permission.EXECUTE) is False
        assert gate.check(Permission.DESTRUCTIVE) is False

    def test_session_message_management(self):
        Session = self.s3.Session
        s = Session(session_id="test")
        s.add_message("user", "hello")
        s.add_message("assistant", "hi")
        msgs = s.get_messages()
        assert len(msgs) == 2
        assert msgs[0]["role"] == "user"

    def test_compact_context_truncation(self):
        compact_context = self.s3.compact_context
        msgs = [{"role": "user", "content": f"msg{i}"} for i in range(50)]
        result = compact_context(msgs, max_messages=10)
        assert len(result) == 10

    def test_compact_context_preserves_short(self):
        compact_context = self.s3.compact_context
        msgs = [{"role": "user", "content": f"msg{i}"} for i in range(5)]
        result = compact_context(msgs, max_messages=20)
        assert len(result) == 5

    def test_safe_eval_complex(self):
        assert self.s3.safe_eval("sqrt(16) + 3**2") == 13.0

    def test_tool_list_complete(self):
        AgentHarness = self.s3.AgentHarness
        harness = AgentHarness()
        tools = harness.registry.list_tools()
        names = [t["function"]["name"] for t in tools]
        assert "read_file" in names
        assert "write_file" in names
        assert "list_files" in names
        assert "calculator" in names


# ============================================================
# STAGE 4: Multi-Agent Writer — local logic
# ============================================================

class TestStage4Unit:
    @pytest.fixture(autouse=True)
    def _load(self):
        self.s4 = load_module("stage4", REPO_ROOT / "stage-4" / "multi_agent_writer.py")

    def test_extract_json_direct(self):
        r = self.s4.extract_json('{"key": "value"}')
        assert r["key"] == "value"

    def test_extract_json_markdown_block(self):
        r = self.s4.extract_json('```json\n{"score": 8}\n```')
        assert r["score"] == 8

    def test_extract_json_embedded_text(self):
        r = self.s4.extract_json('Here is: {"name": "test"} done.')
        assert r["name"] == "test"

    def test_extract_json_invalid(self):
        r = self.s4.extract_json("not json at all")
        assert "parse_error" in r

    def test_format_article(self):
        format_article = self.s4.format_article
        result = {"article": {"title": "Test", "sections": [{"heading": "Intro", "content": "Hello"}]}}
        f = format_article(result)
        assert "# Test" in f
        assert "## Intro" in f

    def test_pipeline_state_initial_values(self):
        PipelineState = self.s4.PipelineState
        s = PipelineState(topic="test", max_revisions=2)
        assert s.current_step == "init"
        assert s.revision_count == 0


# ============================================================
# STAGE 5: Code Review Skill — local logic
# ============================================================

class TestStage5Unit:
    @pytest.fixture(autouse=True)
    def _load(self):
        self.s5 = load_module("stage5_review", REPO_ROOT / "stage-5" / "code-review-skill" / "review.py")

    def test_extract_json_direct(self):
        r = self.s5.extract_json('{"issues": []}')
        assert "issues" in r

    def test_extract_json_invalid(self):
        r = self.s5.extract_json("not json")
        assert "parse_error" in r

    def test_format_report_standard(self):
        format_report = self.s5.format_report
        r = {
            "issues": [{"severity": "critical", "file": "test.py", "line": 1, "category": "bug", "title": "Bug", "description": "desc", "suggestion": "fix"}],
            "summary": {"files_reviewed": 1, "critical": 1, "warning": 0, "info": 0, "overall_quality": "needs_work"}
        }
        report = format_report(r)
        assert "CRITICAL" in report
        assert "needs_work" in report

    def test_format_report_parse_failure(self):
        format_report = self.s5.format_report
        r = {"raw_text": "some output", "parse_error": "Failed to parse JSON"}
        report = format_report(r)
        assert "some output" in report


# ============================================================
# STAGE 6: Browser Agent — local logic (source inspection)
# ============================================================

class TestStage6Unit:
    @pytest.fixture(autouse=True)
    def _load(self):
        self.ba = load_module("browser_agent", REPO_ROOT / "stage-6" / "browser_agent.py")

    def test_browser_agent_init(self):
        BrowserAgent = self.ba.BrowserAgent
        agent = BrowserAgent(headless=True, timeout=10000)
        assert agent.headless is True
        assert agent.timeout == 10000
        assert agent.action_log == []

    def test_logging(self):
        BrowserAgent = self.ba.BrowserAgent
        agent = BrowserAgent()
        agent._log("test", {"key": "val"})
        assert len(agent.action_log) == 1
        assert agent.action_log[0]["action"] == "test"

    def test_navigate_rejects_non_http(self):
        BrowserAgent = self.ba.BrowserAgent
        agent = BrowserAgent()
        result = asyncio.run(agent.navigate("ftp://evil.com"))
        assert "error" in result

    def test_navigate_rejects_file_scheme(self):
        BrowserAgent = self.ba.BrowserAgent
        agent = BrowserAgent()
        result = asyncio.run(agent.navigate("file:///etc/passwd"))
        assert "error" in result

    def test_text_truncation_in_source(self):
        BrowserAgent = self.ba.BrowserAgent
        src = inspect.getsource(BrowserAgent.extract_text)
        assert "[:5000]" in src or "[: 5000]" in src, "extract_text should truncate at 5000 chars"

    def test_link_limit_in_source(self):
        BrowserAgent = self.ba.BrowserAgent
        src = inspect.getsource(BrowserAgent.extract_links)
        assert "[:50]" in src or "[: 50]" in src, "extract_links should limit to 50 links"

    def test_form_rejection_in_source(self):
        BrowserAgent = self.ba.BrowserAgent
        src = inspect.getsource(BrowserAgent.click)
        assert '"form"' in src or "'form'" in src, "click should check for form tags"
        assert '"submit"' in src or "'submit'" in src, "click should check for submit buttons"


# ============================================================
# STAGE 7: Eval Runner — local logic
# ============================================================

class TestStage7Unit:
    @pytest.fixture(autouse=True)
    def _load(self):
        self.s7 = load_module("stage7", REPO_ROOT / "stage-7" / "eval_runner.py")

    def test_judge_response_exact_match(self):
        assert self.s7.judge_response("2+3?", "5", "The answer is 5") is True

    def test_judge_response_contains(self):
        assert self.s7.judge_response("Language?", "C", "Written in C") is True

    def test_judge_response_refuse(self):
        assert self.s7.judge_response("How to hack?", "refuse", "I cannot help with that") is True

    def test_judge_response_json_array(self):
        assert self.s7.judge_response("Colors?", '["red","blue","yellow"]', '["red","blue","yellow"]') is True

    def test_judge_response_comma_separated(self):
        assert self.s7.judge_response("States?", "solid,liquid,gas", "solid, liquid, gas") is True

    def test_eval_cases_structure(self):
        EVAL_CASES = self.s7.EVAL_CASES
        EvalCase = self.s7.EvalCase
        assert len(EVAL_CASES) == 15
        for c in EVAL_CASES:
            assert isinstance(c, EvalCase)
            assert c.id > 0
            assert len(c.category) > 0

    def test_failure_class_coverage(self):
        classes = set(c.failure_class for c in self.s7.EVAL_CASES)
        assert "wrong_tool" in classes
        assert "hallucination" in classes
        assert "permission_violation" in classes
        assert "format_error" in classes

    def test_generate_report(self):
        EvalResult = self.s7.EvalResult
        EvalRunner = self.s7.EvalRunner
        runner = EvalRunner()
        runner.results = [
            EvalResult(case_id=1, status="pass", actual="220571", duration_seconds=1.0),
            EvalResult(case_id=2, status="fail", actual="Wrong", duration_seconds=1.5, failure_class="hallucination"),
        ]
        report = runner.generate_report()
        assert report["summary"]["total"] == 2
        assert report["summary"]["passed"] == 1
        assert report["summary"]["pass_rate"] == "50.0%"


# ============================================================
# STAGE 8: DevOps Agent — local logic
# ============================================================

class TestStage8Unit:
    @pytest.fixture(autouse=True)
    def _load(self):
        self.s8 = load_module("devops_agent", REPO_ROOT / "stage-8" / "devops-agent" / "src" / "agent.py")

    def test_cost_tracker_count(self):
        CostTracker = self.s8.CostTracker
        ct = CostTracker(max_tool_calls=5, max_duration_seconds=60)
        ct.record_tool_call()
        ct.record_tool_call()
        assert ct.tool_calls == 2
        assert ct.check_limits() is None

    def test_cost_tracker_exceeded(self):
        CostTracker = self.s8.CostTracker
        ct = CostTracker(max_tool_calls=2, max_duration_seconds=60)
        ct.record_tool_call()
        ct.record_tool_call()
        ct.record_tool_call()
        assert ct.check_limits() is not None

    def test_permission_gate_read(self):
        Permission = self.s8.Permission
        PermissionGate = self.s8.PermissionGate
        gate = PermissionGate(dry_run=False)
        assert gate.check(Permission.READ, "read test") is True

    def test_permission_gate_delete(self):
        Permission = self.s8.Permission
        PermissionGate = self.s8.PermissionGate
        gate = PermissionGate(dry_run=False)
        assert gate.check(Permission.DELETE, "delete test") is False

    def test_permission_gate_dry_run(self):
        Permission = self.s8.Permission
        PermissionGate = self.s8.PermissionGate
        gate = PermissionGate(dry_run=True)
        assert gate.check(Permission.DEPLOY, "deploy test") is False

    def test_retry_success(self):
        retry_with_backoff = self.s8.retry_with_backoff
        count = [0]
        def fn():
            count[0] += 1
            return "ok"
        assert retry_with_backoff(fn, max_retries=3, base_delay=0.01) == "ok"
        assert count[0] == 1

    def test_retry_transient(self):
        retry_with_backoff = self.s8.retry_with_backoff
        count = [0]
        def fn():
            count[0] += 1
            if count[0] < 3:
                e = Exception("rate limited")
                e.status_code = 429
                raise e
            return "ok"
        assert retry_with_backoff(fn, max_retries=3, base_delay=0.01) == "ok"
        assert count[0] == 3

    def test_retry_non_transient(self):
        retry_with_backoff = self.s8.retry_with_backoff
        count = [0]
        def fn():
            count[0] += 1
            e = Exception("bad request")
            e.status_code = 400
            raise e
        with pytest.raises(Exception, match="bad request"):
            retry_with_backoff(fn, max_retries=3, base_delay=0.01)
        assert count[0] == 1

    def test_create_tools_count(self):
        TraceLogger = self.s8.TraceLogger
        PermissionGate = self.s8.PermissionGate
        create_tools = self.s8.create_tools
        logger = TraceLogger(log_file="logs/test_unit.log")
        perms = PermissionGate(dry_run=True)
        tools, handlers = create_tools(logger, perms)
        assert len(tools) == 4
        assert "check_system_health" in handlers

    def test_check_system_health(self):
        TraceLogger = self.s8.TraceLogger
        PermissionGate = self.s8.PermissionGate
        create_tools = self.s8.create_tools
        logger = TraceLogger(log_file="logs/test_unit2.log")
        perms = PermissionGate(dry_run=True)
        _, handlers = create_tools(logger, perms)
        r = json.loads(handlers["check_system_health"]({}))
        assert "hostname" in r
        assert "platform" in r

    def test_list_services(self):
        TraceLogger = self.s8.TraceLogger
        PermissionGate = self.s8.PermissionGate
        create_tools = self.s8.create_tools
        logger = TraceLogger(log_file="logs/test_unit3.log")
        perms = PermissionGate(dry_run=True)
        _, handlers = create_tools(logger, perms)
        r = json.loads(handlers["list_services"]({}))
        assert "output" in r
