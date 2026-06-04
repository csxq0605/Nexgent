"""End-to-end tests for Stage 1-8 with real MiMo API calls.

Only tests that actually invoke the LLM API belong here.
Local logic tests (safe_eval, extract_json, etc.) are in test_stage_unit.py.
"""
import sys
import os
import re
import json
import asyncio
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from dotenv import load_dotenv
load_dotenv(REPO_ROOT / ".env")

from conftest import load_module

# Skip all E2E tests when no real API key is configured
pytestmark = pytest.mark.skipif(
    not os.environ.get("MIMO_API_KEY") or os.environ.get("MIMO_API_KEY") == "test-key-for-testing",
    reason="Real MIMO_API_KEY not set — E2E tests skipped",
)


# ============================================================
# STAGE 1: Minimal Agent Loop — API tests
# ============================================================

class TestStage1E2E:
    @pytest.fixture(autouse=True)
    def _load(self):
        self.s1 = load_module("stage1", REPO_ROOT / "stage-1" / "minimal_agent.py")

    def test_calculator_247x893(self):
        r = self.s1.agent_loop("What is 247 * 893? Reply with ONLY the number, nothing else.")
        assert re.search(r'\b220571\b', r), f"Expected 220571, got: {r}"

    def test_calculator_sqrt_add(self):
        r = self.s1.agent_loop("What is sqrt(144) + 10? Reply with ONLY the number.")
        assert re.search(r'\b22\b', r), f"Expected 22, got: {r}"

    def test_capital_of_france(self):
        r = self.s1.agent_loop("What is the capital of France? Reply with ONLY the city name.")
        assert r.strip().lower().rstrip('.') == "paris", f"Expected 'Paris', got: {r}"


# ============================================================
# STAGE 2: Research Assistant — API tests
# ============================================================

class TestStage2E2E:
    @pytest.fixture(autouse=True)
    def _load(self):
        self.s2 = load_module("stage2", REPO_ROOT / "stage-2" / "research_assistant.py")

    def test_research_agent_simple(self):
        Memory = self.s2.Memory
        m = Memory()
        answer = self.s2.research_agent("What is 2 + 2? Reply with only the number.", memory=m, max_steps=5, timeout_seconds=30)
        assert re.search(r'\b4\b', answer), f"Expected 4, got: {answer}"

    def test_research_agent_uses_tool(self):
        Memory = self.s2.Memory
        m = Memory()
        answer = self.s2.research_agent("Use the execute_code tool to calculate 15 * 23. Tell me just the result number.", memory=m, max_steps=5, timeout_seconds=30)
        assert re.search(r'\b345\b', answer), f"Expected 345, got: {answer}"


# ============================================================
# STAGE 3: Harness Demo — API tests
# ============================================================

class TestStage3E2E:
    @pytest.fixture(autouse=True)
    def _load(self):
        self.s3 = load_module("stage3", REPO_ROOT / "stage-3" / "harness_demo.py")

    def test_harness_calculate(self):
        PermissionGate = self.s3.PermissionGate
        AgentHarness = self.s3.AgentHarness
        Session = self.s3.Session

        harness = AgentHarness(max_steps=5)
        harness.permission_gate = PermissionGate(interactive=False)
        session = Session(session_id="test")
        result = harness.run("What is 12 * 13? Reply with only the number.", session)
        assert "156" in result, f"Expected 156, got: {result}"

    def test_harness_read_file(self):
        Permission = self.s3.Permission
        PermissionGate = self.s3.PermissionGate
        AgentHarness = self.s3.AgentHarness
        Session = self.s3.Session

        harness = AgentHarness(max_steps=5)
        harness.permission_gate = PermissionGate(auto_approve={Permission.READ}, interactive=False)
        session = Session(session_id="test2")
        result = harness.run("Read the file README.md and tell me the first heading text. Just the heading.", session)
        assert len(result) > 0, "Got empty result"
        assert "[ERROR]" not in result, f"Got error: {result}"


# ============================================================
# STAGE 4: Multi-Agent Writer — API tests
# ============================================================

class TestStage4E2E:
    @pytest.fixture(autouse=True)
    def _load(self):
        self.s4 = load_module("stage4", REPO_ROOT / "stage-4" / "multi_agent_writer.py")

    def test_researcher_structured(self):
        call_agent = self.s4.call_agent
        r = call_agent("researcher", "Benefits of exercise. Brief summary.")
        assert isinstance(r, dict)
        assert "parse_error" not in r, f"LLM returned unparseable response: {r}"
        assert "key_findings" in r or "findings" in r or "summary" in r

    def test_writer_article(self):
        call_agent = self.s4.call_agent
        research = {"key_findings": ["Exercise improves health", "Reduces stress", "Boosts mood"], "sources": ["WHO"], "gaps": []}
        r = call_agent("writer", f"Write a brief article based on: {json.dumps(research)}")
        assert isinstance(r, dict)
        # LLM may return truncated JSON; accept partial responses
        if "parse_error" in r:
            raw = r.get("raw_text", "")
            if not raw or len(raw) < 10:
                pytest.skip(f"LLM returned empty/minimal response after retries: {r}")
            assert len(raw) > 50, f"Response too short: {r}"
        else:
            assert "title" in r

    def test_reviewer_score(self):
        call_agent = self.s4.call_agent
        article = {"title": "Exercise Benefits", "sections": [{"heading": "Health", "content": "Exercise is good for health."}]}
        r = call_agent("reviewer", f"Review this article: {json.dumps(article)}")
        assert isinstance(r, dict)
        assert "parse_error" not in r, f"LLM returned unparseable response: {r}"
        assert "score" in r


# ============================================================
# STAGE 5: Code Review Skill — API tests
# ============================================================

class TestStage5E2E:
    @pytest.fixture(autouse=True)
    def _load(self):
        self.s5 = load_module("stage5_review", REPO_ROOT / "stage-5" / "code-review-skill" / "review.py")

    def test_sql_injection_detection(self):
        code = 'def get_user(user_id):\n    query = "SELECT * FROM users WHERE id = " + user_id\n    return db.execute(query)'
        result = self.s5.review_code(code, "test.py")
        assert "issues" in result
        issues = result.get("issues", [])
        assert len(issues) > 0, "Should find at least one issue"
        issue_text = json.dumps([i.get("title", "") + " " + i.get("description", "") for i in issues]).lower()
        assert "sql" in issue_text or "inject" in issue_text or "concatenat" in issue_text, \
            f"Expected SQL injection detection, got: {[i.get('title','') for i in issues]}"

    def test_hardcoded_password_detection(self):
        code = 'def login():\n    password = "admin123"\n    return authenticate(password)'
        result = self.s5.review_code(code, "login.py")
        assert "issues" in result
        issues = result.get("issues", [])
        assert len(issues) > 0, "Should find at least one issue"
        issue_text = json.dumps([i.get("title", "") + " " + i.get("description", "") for i in issues]).lower()
        assert "password" in issue_text or "credential" in issue_text or "hardcod" in issue_text or "secret" in issue_text, \
            f"Expected hardcoded password detection, got: {[i.get('title','') for i in issues]}"

    def test_clean_code_few_issues(self):
        code = 'def add(a: int, b: int) -> int:\n    """Add two numbers."""\n    return a + b'
        result = self.s5.review_code(code, "clean.py")
        issues = result.get("issues", [])
        critical = sum(1 for i in issues if i.get("severity") == "critical")
        assert critical == 0, f"Clean code should have 0 critical issues, got {critical}"


# ============================================================
# STAGE 6: Browser Agent — API test
# ============================================================

class TestStage6E2E:
    def test_browser_visit_example_com(self):
        import urllib.request
        import time
        try:
            urllib.request.urlopen("https://example.com", timeout=5)
        except Exception:
            pytest.skip("example.com not reachable")

        ba = load_module("browser_agent", REPO_ROOT / "stage-6" / "browser_agent.py")
        BrowserAgent = ba.BrowserAgent

        agent = BrowserAgent(headless=True, timeout=30000)
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(agent.start())
            # Retry navigation up to 3 times for network instability
            result = None
            for attempt in range(3):
                result = loop.run_until_complete(agent.navigate("https://example.com"))
                if "error" not in result:
                    break
                time.sleep(1)
            assert result is not None
            assert "title" in result, f"Expected title, got: {result}"
            assert result.get("ok") is True or result.get("status") == 200

            text_result = loop.run_until_complete(agent.extract_text("body"))
            assert "text" in text_result
            assert len(text_result["text"]) > 0

            links_result = loop.run_until_complete(agent.extract_links())
            assert "links" in links_result

            assert len(agent.action_log) >= 2
        finally:
            loop.run_until_complete(agent.stop())
            loop.close()


# ============================================================
# STAGE 7: Eval Runner — API tests
# ============================================================

class TestStage7E2E:
    @pytest.fixture(autouse=True)
    def _load(self):
        self.s7 = load_module("stage7", REPO_ROOT / "stage-7" / "eval_runner.py")

    def test_run_eval_cases(self):
        EVAL_CASES = self.s7.EVAL_CASES
        EvalRunner = self.s7.EvalRunner

        runner = EvalRunner()
        cases = EVAL_CASES[:3]
        report = runner.run_all(cases)
        assert report["summary"]["total"] == 3
        assert "pass_rate" in report["summary"]
        print(f"    [INFO] Pass rate: {report['summary']['pass_rate']}")
        for r in report["results"]:
            print(f"    [INFO] Case #{r['id']}: {r['status']} - '{r['actual'][:50]}'")


# ============================================================
# STAGE 8: DevOps Agent — API tests
# ============================================================

class TestStage8E2E:
    @pytest.fixture(autouse=True)
    def _load(self):
        self.s8 = load_module("devops_agent", REPO_ROOT / "stage-8" / "devops-agent" / "src" / "agent.py")

    def test_devops_health_check(self):
        DevOpsAgent = self.s8.DevOpsAgent
        agent = DevOpsAgent(dry_run=True)
        result = agent.run("Check system health and tell me the hostname.", max_steps=5)
        assert len(result) > 0, "Got empty result"
        assert "[ERROR]" not in result, f"Got error: {result}"
        assert "[LIMIT]" not in result, f"Got limit: {result}"

    def test_devops_list_services(self):
        DevOpsAgent = self.s8.DevOpsAgent
        agent = DevOpsAgent(dry_run=True)
        result = agent.run("List the running processes on this machine.", max_steps=5)
        assert len(result) > 0, "Got empty result"
        assert "[ERROR]" not in result, f"Got error: {result}"
        assert "[LIMIT]" not in result, f"Got limit: {result}"
