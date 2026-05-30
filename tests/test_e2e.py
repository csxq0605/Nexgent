"""
End-to-end tests for Stage 1-8 with real MiMo API calls.
Tests that each stage runs correctly and produces accurate results.
"""
import sys, os, json, time, asyncio, importlib, importlib.util
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))

from dotenv import load_dotenv
load_dotenv(REPO_ROOT / ".env")

results = {}


def load_module(name, path):
    """Import a module from a file path (handles hyphenated dirs)."""
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_stage(stage_name, test_fn):
    print(f"\n{'='*60}")
    print(f"  {stage_name}")
    print(f"{'='*60}")
    passed = 0
    failed = 0
    errors = []
    for name, fn in test_fn():
        try:
            fn()
            print(f"  [PASS] {name}")
            passed += 1
        except AssertionError as e:
            print(f"  [FAIL] {name}: {e}")
            failed += 1
            errors.append((name, str(e)))
        except Exception as e:
            print(f"  [ERROR] {name}: {type(e).__name__}: {e}")
            failed += 1
            errors.append((name, f"{type(e).__name__}: {e}"))
    total = passed + failed
    print(f"\n  结果: {passed}/{total} 通过, {failed} 失败")
    results[stage_name] = {"passed": passed, "total": total, "failed": failed, "errors": errors}


# ============================================================
# STAGE 1: Minimal Agent Loop
# ============================================================
def test_stage1():
    s1 = load_module("stage1", REPO_ROOT / "stage-1" / "minimal_agent.py")
    safe_eval = s1.safe_eval
    execute_tool = s1.execute_tool
    agent_loop = s1.agent_loop
    TOOLS = s1.TOOLS

    def t1():
        """API: 计算器 247*893"""
        import re
        r = agent_loop("What is 247 * 893? Reply with ONLY the number, nothing else.")
        assert re.search(r'\b220571\b', r), f"Expected 220571, got: {r}"

    def t2():
        """API: 计算器 sqrt(144)+10"""
        import re
        r = agent_loop("What is sqrt(144) + 10? Reply with ONLY the number.")
        assert re.search(r'\b22\b', r), f"Expected 22, got: {r}"

    def t3():
        """API: 知识问答 法国首都"""
        r = agent_loop("What is the capital of France? Reply with ONLY the city name.")
        assert r.strip().lower().rstrip('.') == "paris", f"Expected 'Paris', got: {r}"

    def t4():
        """safe_eval 基本运算"""
        assert safe_eval("2 + 3") == 5
        assert safe_eval("10 / 4") == 2.5
        assert safe_eval("2 ** 10") == 1024
        assert abs(safe_eval("sqrt(144)") - 12.0) < 1e-9

    def t5():
        """safe_eval 拒绝危险输入"""
        try:
            safe_eval("__import__('os')")
            assert False, "Should have raised"
        except (ValueError, SyntaxError):
            pass

    def t6():
        """execute_tool 计算器"""
        r = json.loads(execute_tool("calculator", {"expression": "3 * 7 + 1"}))
        assert r["result"] == 22

    def t7():
        """execute_tool search"""
        r = json.loads(execute_tool("search", {"query": "Python"}))
        assert "summary" in r

    def t8():
        """execute_tool 路径穿越防护"""
        r = json.loads(execute_tool("read_file", {"path": "/etc/passwd"}))
        assert "error" in r

    def t9():
        """工具定义完整"""
        tool_names = [t["function"]["name"] for t in TOOLS]
        assert "calculator" in tool_names
        assert "search" in tool_names
        assert "read_file" in tool_names

    return [
        ("API: 计算器 247*893", t1),
        ("API: 计算器 sqrt+加法", t2),
        ("API: 知识问答 法国首都", t3),
        ("safe_eval 基本运算", t4),
        ("safe_eval 拒绝危险输入", t5),
        ("execute_tool 计算器", t6),
        ("execute_tool search", t7),
        ("execute_tool 路径穿越防护", t8),
        ("工具定义完整", t9),
    ]

run_stage("Stage 1: Minimal Agent Loop", test_stage1)


# ============================================================
# STAGE 2: Research Assistant
# ============================================================
def test_stage2():
    s2 = load_module("stage2", REPO_ROOT / "stage-2" / "research_assistant.py")
    Memory = s2.Memory
    chunk_text = s2.chunk_text
    execute_tool = s2.execute_tool
    research_agent = s2.research_agent

    def t1():
        """Memory 存储和检索"""
        m = Memory()
        m.store_long_term("Python is a programming language", "wiki")
        m.store_long_term("JavaScript is for web", "mdn")
        results = m.search_long_term("Python programming")
        assert len(results) >= 1
        assert any("Python" in r["text"] for r in results)

    def t2():
        """chunk_text 分块正确性"""
        text = "A" * 1200
        chunks = chunk_text(text, chunk_size=500, overlap=50)
        assert len(chunks) >= 2
        assert chunks[0] == "A" * 500

    def t3():
        """chunk_text 空输入"""
        assert chunk_text("") == []

    def t4():
        """chunk_text 参数校验"""
        try:
            chunk_text("test", chunk_size=5, overlap=10)
            assert False
        except ValueError:
            pass

    def t5():
        """execute_code 执行成功"""
        m = Memory()
        r = json.loads(execute_tool("execute_code", {"code": "print(2+3)"}, m))
        assert "output" in r
        assert "5" in r["output"]

    def t6():
        """execute_code 错误处理"""
        m = Memory()
        r = json.loads(execute_tool("execute_code", {"code": "raise ValueError('test')"}, m))
        assert "error" in r

    def t7():
        """save+recall 联动"""
        m = Memory()
        execute_tool("save_to_memory", {"text": "The answer to everything is 42", "source": "hitchhiker"}, m)
        assert len(m.long_term_store) == 1
        r = json.loads(execute_tool("recall_memory", {"query": "answer 42"}, m))
        assert len(r["results"]) >= 1
        assert "42" in r["results"][0]

    def t8():
        """read_file 路径穿越防护"""
        m = Memory()
        r = json.loads(execute_tool("read_file", {"path": "/etc/passwd"}, m))
        assert "error" in r

    def t9():
        """API: 研究代理回答简单问题"""
        import re
        m = Memory()
        answer = research_agent("What is 2 + 2? Reply with only the number.", memory=m, max_steps=5, timeout_seconds=30)
        assert re.search(r'\b4\b', answer), f"Expected 4, got: {answer}"

    def t10():
        """API: 研究代理使用工具"""
        import re
        m = Memory()
        answer = research_agent("Use the execute_code tool to calculate 15 * 23. Tell me just the result number.", memory=m, max_steps=5, timeout_seconds=30)
        assert re.search(r'\b345\b', answer), f"Expected 345, got: {answer}"

    return [
        ("Memory 存储和检索", t1),
        ("chunk_text 分块", t2),
        ("chunk_text 空输入", t3),
        ("chunk_text 参数校验", t4),
        ("execute_code 成功", t5),
        ("execute_code 错误处理", t6),
        ("save+recall 联动", t7),
        ("read_file 路径穿越", t8),
        ("API: 研究代理回答问题", t9),
        ("API: 研究代理使用工具", t10),
    ]

run_stage("Stage 2: Research Assistant", test_stage2)


# ============================================================
# STAGE 3: Harness Demo
# ============================================================
def test_stage3():
    s3 = load_module("stage3", REPO_ROOT / "stage-3" / "harness_demo.py")
    safe_eval = s3.safe_eval
    Permission = s3.Permission
    ToolDef = s3.ToolDef
    ToolRegistry = s3.ToolRegistry
    PermissionGate = s3.PermissionGate
    Session = s3.Session
    compact_context = s3.compact_context
    AgentHarness = s3.AgentHarness

    def t1():
        """ToolRegistry 注册执行"""
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

    def t2():
        """PermissionGate 权限分级"""
        gate = PermissionGate(auto_approve={Permission.NONE, Permission.READ}, interactive=False)
        assert gate.check(Permission.NONE) == True
        assert gate.check(Permission.READ) == True
        assert gate.check(Permission.WRITE) == False
        assert gate.check(Permission.EXECUTE) == False
        assert gate.check(Permission.DESTRUCTIVE) == False

    def t3():
        """Session 消息管理"""
        s = Session(session_id="test")
        s.add_message("user", "hello")
        s.add_message("assistant", "hi")
        msgs = s.get_messages()
        assert len(msgs) == 2
        assert msgs[0]["role"] == "user"

    def t4():
        """compact_context 截断"""
        msgs = [{"role": "user", "content": f"msg{i}"} for i in range(50)]
        result = compact_context(msgs, max_messages=10)
        assert len(result) == 10

    def t5():
        """compact_context 保留短消息"""
        msgs = [{"role": "user", "content": f"msg{i}"} for i in range(5)]
        result = compact_context(msgs, max_messages=20)
        assert len(result) == 5

    def t6():
        """safe_eval 复杂表达式"""
        assert safe_eval("sqrt(16) + 3**2") == 13.0

    def t7():
        """API: AgentHarness 计算任务"""
        harness = AgentHarness(max_steps=5)
        harness.permission_gate = PermissionGate(interactive=False)
        session = Session(session_id="test")
        result = harness.run("What is 12 * 13? Reply with only the number.", session)
        assert "156" in result, f"Expected 156, got: {result}"

    def t8():
        """API: AgentHarness 读文件"""
        harness = AgentHarness(max_steps=5)
        harness.permission_gate = PermissionGate(auto_approve={Permission.READ}, interactive=False)
        session = Session(session_id="test2")
        result = harness.run("Read the file README.md and tell me the first heading text. Just the heading.", session)
        assert len(result) > 0, "Got empty result"
        assert "[ERROR]" not in result, f"Got error: {result}"

    def t9():
        """工具列表包含4个工具"""
        harness = AgentHarness()
        tools = harness.registry.list_tools()
        names = [t["function"]["name"] for t in tools]
        assert "read_file" in names
        assert "write_file" in names
        assert "list_files" in names
        assert "calculator" in names

    return [
        ("ToolRegistry 注册执行", t1),
        ("PermissionGate 权限分级", t2),
        ("Session 消息管理", t3),
        ("compact_context 截断", t4),
        ("compact_context 保留短消息", t5),
        ("safe_eval 复杂表达式", t6),
        ("API: AgentHarness 计算任务", t7),
        ("API: AgentHarness 读文件", t8),
        ("工具列表完整", t9),
    ]

run_stage("Stage 3: Harness Demo", test_stage3)


# ============================================================
# STAGE 4: Multi-Agent Writer
# ============================================================
def test_stage4():
    s4 = load_module("stage4", REPO_ROOT / "stage-4" / "multi_agent_writer.py")
    extract_json = s4.extract_json
    format_article = s4.format_article
    PipelineState = s4.PipelineState
    call_agent = s4.call_agent

    def t1():
        """extract_json 直接解析"""
        r = extract_json('{"key": "value"}')
        assert r["key"] == "value"

    def t2():
        """extract_json markdown块"""
        r = extract_json('```json\n{"score": 8}\n```')
        assert r["score"] == 8

    def t3():
        """extract_json 嵌入文本"""
        r = extract_json('Here is: {"name": "test"} done.')
        assert r["name"] == "test"

    def t4():
        """extract_json 无效输入"""
        r = extract_json("not json at all")
        assert "parse_error" in r

    def t5():
        """format_article 正常"""
        result = {"article": {"title": "Test", "sections": [{"heading": "Intro", "content": "Hello"}]}}
        f = format_article(result)
        assert "# Test" in f
        assert "## Intro" in f

    def t6():
        """PipelineState 初始值"""
        s = PipelineState(topic="test", max_revisions=2)
        assert s.current_step == "init"
        assert s.revision_count == 0

    def t7():
        """API: researcher 返回结构化"""
        r = call_agent("researcher", "Benefits of exercise. Brief summary.")
        assert isinstance(r, dict)
        assert "parse_error" not in r, f"LLM returned unparseable response: {r}"
        assert "key_findings" in r or "findings" in r or "summary" in r

    def t8():
        """API: writer 返回文章"""
        research = {"key_findings": ["Exercise improves health", "Reduces stress", "Boosts mood"], "sources": ["WHO"], "gaps": []}
        r = call_agent("writer", f"Write a brief article based on: {json.dumps(research)}")
        assert isinstance(r, dict)
        assert "parse_error" not in r, f"LLM returned unparseable response: {r}"
        assert "title" in r

    def t9():
        """API: reviewer 返回评分"""
        article = {"title": "Exercise Benefits", "sections": [{"heading": "Health", "content": "Exercise is good for health."}]}
        r = call_agent("reviewer", f"Review this article: {json.dumps(article)}")
        assert isinstance(r, dict)
        assert "parse_error" not in r, f"LLM returned unparseable response: {r}"
        assert "score" in r

    return [
        ("extract_json 直接解析", t1),
        ("extract_json markdown块", t2),
        ("extract_json 嵌入文本", t3),
        ("extract_json 无效输入", t4),
        ("format_article 正常", t5),
        ("PipelineState 初始值", t6),
        ("API: researcher 结构化", t7),
        ("API: writer 文章", t8),
        ("API: reviewer 评分", t9),
    ]

run_stage("Stage 4: Multi-Agent Writer", test_stage4)


# ============================================================
# STAGE 5: Code Review Skill
# ============================================================
def test_stage5():
    s5 = load_module("stage5_review", REPO_ROOT / "stage-5" / "code-review-skill" / "review.py")
    extract_json = s5.extract_json
    format_report = s5.format_report
    review_code = s5.review_code

    def t1():
        """extract_json 直接"""
        r = extract_json('{"issues": []}')
        assert "issues" in r

    def t2():
        """extract_json 无效"""
        r = extract_json("not json")
        assert "parse_error" in r

    def t3():
        """format_report 标准"""
        r = {
            "issues": [{"severity": "critical", "file": "test.py", "line": 1, "category": "bug", "title": "Bug", "description": "desc", "suggestion": "fix"}],
            "summary": {"files_reviewed": 1, "critical": 1, "warning": 0, "info": 0, "overall_quality": "needs_work"}
        }
        report = format_report(r)
        assert "CRITICAL" in report
        assert "needs_work" in report

    def t4():
        """format_report 解析失败"""
        r = {"raw": "some output", "parse_error": True}
        report = format_report(r)
        assert "some output" in report

    def t5():
        """API: review_code SQL注入检测"""
        code = 'def get_user(user_id):\n    query = "SELECT * FROM users WHERE id = " + user_id\n    return db.execute(query)'
        result = review_code(code, "test.py")
        assert "issues" in result
        issues = result.get("issues", [])
        assert len(issues) > 0, "Should find at least one issue"
        # Check only issue titles/descriptions, not the entire result (which may echo code)
        issue_text = json.dumps([i.get("title", "") + " " + i.get("description", "") for i in issues]).lower()
        assert "sql" in issue_text or "inject" in issue_text or "concatenat" in issue_text, \
            f"Expected SQL injection detection, got: {[i.get('title','') for i in issues]}"

    def t6():
        """API: review_code 硬编码密码"""
        code = 'def login():\n    password = "admin123"\n    return authenticate(password)'
        result = review_code(code, "login.py")
        assert "issues" in result
        issues = result.get("issues", [])
        assert len(issues) > 0, "Should find at least one issue"
        # Check only issue titles/descriptions, not the entire result (which echoes code)
        issue_text = json.dumps([i.get("title", "") + " " + i.get("description", "") for i in issues]).lower()
        assert "password" in issue_text or "credential" in issue_text or "hardcod" in issue_text or "secret" in issue_text, \
            f"Expected hardcoded password detection, got: {[i.get('title','') for i in issues]}"

    def t7():
        """API: review_code 干净代码少issue"""
        code = 'def add(a: int, b: int) -> int:\n    """Add two numbers."""\n    return a + b'
        result = review_code(code, "clean.py")
        issues = result.get("issues", [])
        critical = sum(1 for i in issues if i.get("severity") == "critical")
        assert critical == 0, f"Clean code should have 0 critical issues, got {critical}"

    return [
        ("extract_json 直接", t1),
        ("extract_json 无效", t2),
        ("format_report 标准", t3),
        ("format_report 解析失败", t4),
        ("API: SQL注入检测", t5),
        ("API: 硬编码密码检测", t6),
        ("API: 干净代码少issue", t7),
    ]

run_stage("Stage 5: Code Review Skill", test_stage5)


# ============================================================
# STAGE 6: Browser Agent
# ============================================================
def test_stage6():
    ba = load_module("browser_agent", REPO_ROOT / "stage-6" / "browser_agent.py")
    BrowserAgent = ba.BrowserAgent

    def t1():
        """BrowserAgent 初始化"""
        agent = BrowserAgent(headless=True, timeout=10000)
        assert agent.headless == True
        assert agent.timeout == 10000
        assert agent.action_log == []

    def t2():
        """日志功能"""
        agent = BrowserAgent()
        agent._log("test", {"key": "val"})
        assert len(agent.action_log) == 1
        assert agent.action_log[0]["action"] == "test"

    def t3():
        """navigate 拒绝非HTTP"""
        agent = BrowserAgent()
        result = asyncio.run(agent.navigate("ftp://evil.com"))
        assert "error" in result

    def t4():
        """navigate 拒绝file://"""
        agent = BrowserAgent()
        result = asyncio.run(agent.navigate("file:///etc/passwd"))
        assert "error" in result

    def t5():
        """安全: 文本截断5000字符"""
        import inspect
        src = inspect.getsource(BrowserAgent.extract_text)
        # Verify truncation is applied (text[:N] pattern)
        assert "[:5000]" in src or "[: 5000]" in src, "extract_text should truncate at 5000 chars"

    def t6():
        """安全: 链接限制50条"""
        import inspect
        src = inspect.getsource(BrowserAgent.extract_links)
        # Verify link count limit (links[:N] pattern)
        assert "[:50]" in src or "[: 50]" in src, "extract_links should limit to 50 links"

    def t7():
        """安全: 拒绝表单提交"""
        import inspect
        src = inspect.getsource(BrowserAgent.click)
        # Verify form/submit detection logic exists
        assert '"form"' in src or "'form'" in src, "click should check for form tags"
        assert '"submit"' in src or "'submit'" in src, "click should check for submit buttons"

    def t8():
        """API: 浏览器访问 example.com"""
        import urllib.request
        try:
            urllib.request.urlopen("https://example.com", timeout=5)
        except Exception:
            print("  [SKIP] t8: example.com not reachable")
            return

        agent = BrowserAgent(headless=True, timeout=15000)
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(agent.start())
            result = loop.run_until_complete(agent.navigate("https://example.com"))
            assert "title" in result, f"Expected title, got: {result}"
            assert result.get("ok") == True or result.get("status") == 200

            text_result = loop.run_until_complete(agent.extract_text("body"))
            assert "text" in text_result
            assert len(text_result["text"]) > 0

            links_result = loop.run_until_complete(agent.extract_links())
            assert "links" in links_result

            assert len(agent.action_log) >= 2
        finally:
            loop.run_until_complete(agent.stop())
            loop.close()

    return [
        ("BrowserAgent 初始化", t1),
        ("日志功能", t2),
        ("navigate 拒绝非HTTP", t3),
        ("navigate 拒绝file://", t4),
        ("安全: 文本截断", t5),
        ("安全: 链接限制", t6),
        ("安全: 拒绝表单", t7),
        ("API: 浏览器访问example.com", t8),
    ]

run_stage("Stage 6: Browser Agent", test_stage6)


# ============================================================
# STAGE 7: Eval Runner
# ============================================================
def test_stage7():
    s7 = load_module("stage7", REPO_ROOT / "stage-7" / "eval_runner.py")
    judge_response = s7.judge_response
    EvalCase = s7.EvalCase
    EvalResult = s7.EvalResult
    EVAL_CASES = s7.EVAL_CASES
    EvalRunner = s7.EvalRunner

    def t1():
        """judge_response 精确匹配"""
        assert judge_response("2+3?", "5", "The answer is 5") == True

    def t2():
        """judge_response 包含匹配"""
        assert judge_response("Language?", "C", "Written in C") == True

    def t3():
        """judge_response 拒绝类"""
        assert judge_response("How to hack?", "refuse", "I cannot help with that") == True

    def t4():
        """judge_response JSON数组"""
        assert judge_response("Colors?", '["red","blue","yellow"]', '["red","blue","yellow"]') == True

    def t5():
        """judge_response 逗号分隔"""
        assert judge_response("States?", "solid,liquid,gas", "solid, liquid, gas") == True

    def t6():
        """EVAL_CASES 结构完整"""
        assert len(EVAL_CASES) == 15
        for c in EVAL_CASES:
            assert isinstance(c, EvalCase)
            assert c.id > 0
            assert len(c.category) > 0

    def t7():
        """EvalRunner generate_report"""
        runner = EvalRunner()
        runner.results = [
            EvalResult(case_id=1, status="pass", actual="220571", duration_seconds=1.0),
            EvalResult(case_id=2, status="fail", actual="Wrong", duration_seconds=1.5, failure_class="hallucination"),
        ]
        report = runner.generate_report()
        assert report["summary"]["total"] == 2
        assert report["summary"]["passed"] == 1
        assert report["summary"]["pass_rate"] == "50.0%"

    def t8():
        """API: 运行3个eval case"""
        runner = EvalRunner()
        cases = EVAL_CASES[:3]
        report = runner.run_all(cases)
        assert report["summary"]["total"] == 3
        assert "pass_rate" in report["summary"]
        print(f"    [INFO] Pass rate: {report['summary']['pass_rate']}")
        for r in report["results"]:
            print(f"    [INFO] Case #{r['id']}: {r['status']} - '{r['actual'][:50]}'")

    def t9():
        """failure_class 分类覆盖"""
        classes = set(c.failure_class for c in EVAL_CASES)
        assert "wrong_tool" in classes
        assert "hallucination" in classes
        assert "permission_violation" in classes
        assert "format_error" in classes

    return [
        ("judge_response 精确匹配", t1),
        ("judge_response 包含匹配", t2),
        ("judge_response 拒绝类", t3),
        ("judge_response JSON数组", t4),
        ("judge_response 逗号分隔", t5),
        ("EVAL_CASES 结构完整", t6),
        ("EvalRunner generate_report", t7),
        ("API: 运行3个eval case", t8),
        ("failure_class 分类覆盖", t9),
    ]

run_stage("Stage 7: Eval Runner", test_stage7)


# ============================================================
# STAGE 8: DevOps Agent
# ============================================================
def test_stage8():
    s8 = load_module("devops_agent", REPO_ROOT / "stage-8" / "devops-agent" / "src" / "agent.py")
    CostTracker = s8.CostTracker
    Permission = s8.Permission
    PermissionGate = s8.PermissionGate
    retry_with_backoff = s8.retry_with_backoff
    TraceLogger = s8.TraceLogger
    create_tools = s8.create_tools
    DevOpsAgent = s8.DevOpsAgent

    def t1():
        """CostTracker 计数"""
        ct = CostTracker(max_tool_calls=5, max_duration_seconds=60)
        ct.record_tool_call()
        ct.record_tool_call()
        assert ct.tool_calls == 2
        assert ct.check_limits() is None

    def t2():
        """CostTracker 超限"""
        ct = CostTracker(max_tool_calls=2, max_duration_seconds=60)
        ct.record_tool_call()
        ct.record_tool_call()
        ct.record_tool_call()
        assert ct.check_limits() is not None

    def t3():
        """PermissionGate READ自动通过"""
        gate = PermissionGate(dry_run=False)
        assert gate.check(Permission.READ, "read test") == True

    def t4():
        """PermissionGate DELETE自动拒绝"""
        gate = PermissionGate(dry_run=False)
        assert gate.check(Permission.DELETE, "delete test") == False

    def t5():
        """PermissionGate dry_run"""
        gate = PermissionGate(dry_run=True)
        assert gate.check(Permission.DEPLOY, "deploy test") == False

    def t6():
        """retry 成功"""
        count = [0]
        def fn():
            count[0] += 1
            return "ok"
        assert retry_with_backoff(fn, max_retries=3, base_delay=0.01) == "ok"
        assert count[0] == 1

    def t7():
        """retry 瞬态错误重试"""
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

    def t8():
        """retry 非瞬态不重试"""
        count = [0]
        def fn():
            count[0] += 1
            e = Exception("bad request")
            e.status_code = 400
            raise e
        try:
            retry_with_backoff(fn, max_retries=3, base_delay=0.01)
            assert False
        except Exception as ex:
            assert "bad request" in str(ex)
        assert count[0] == 1

    def t9():
        """create_tools 4个工具"""
        logger = TraceLogger(log_file="logs/test_e2e.log")
        perms = PermissionGate(dry_run=True)
        tools, handlers = create_tools(logger, perms)
        assert len(tools) == 4
        assert "check_system_health" in handlers

    def t10():
        """check_system_health"""
        logger = TraceLogger(log_file="logs/test_e2e2.log")
        perms = PermissionGate(dry_run=True)
        _, handlers = create_tools(logger, perms)
        r = json.loads(handlers["check_system_health"]({}))
        assert "hostname" in r
        assert "platform" in r

    def t11():
        """list_services"""
        logger = TraceLogger(log_file="logs/test_e2e3.log")
        perms = PermissionGate(dry_run=True)
        _, handlers = create_tools(logger, perms)
        r = json.loads(handlers["list_services"]({}))
        assert "output" in r

    def t12():
        """API: DevOpsAgent 健康检查"""
        agent = DevOpsAgent(dry_run=True)
        result = agent.run("Check system health and tell me the hostname.", max_steps=5)
        assert len(result) > 0, "Got empty result"
        assert "[ERROR]" not in result, f"Got error: {result}"
        assert "[LIMIT]" not in result, f"Got limit: {result}"

    def t13():
        """API: DevOpsAgent 列出服务"""
        agent = DevOpsAgent(dry_run=True)
        result = agent.run("List the running processes on this machine.", max_steps=5)
        assert len(result) > 0, "Got empty result"
        assert "[ERROR]" not in result, f"Got error: {result}"
        assert "[LIMIT]" not in result, f"Got limit: {result}"

    return [
        ("CostTracker 计数", t1),
        ("CostTracker 超限", t2),
        ("PermissionGate READ", t3),
        ("PermissionGate DELETE", t4),
        ("PermissionGate dry_run", t5),
        ("retry 成功", t6),
        ("retry 瞬态重试", t7),
        ("retry 非瞬态不重试", t8),
        ("create_tools 4个", t9),
        ("check_system_health", t10),
        ("list_services", t11),
        ("API: 健康检查", t12),
        ("API: 列出服务", t13),
    ]

run_stage("Stage 8: DevOps Agent", test_stage8)


# ============================================================
# FINAL SUMMARY
# ============================================================
print(f"\n{'='*60}")
print("  总 结")
print(f"{'='*60}")
total_pass = 0
total_fail = 0
for stage, r in results.items():
    status = "PASS" if r["failed"] == 0 else "FAIL"
    print(f"  [{status}] {stage}: {r['passed']}/{r['total']} 通过")
    total_pass += r["passed"]
    total_fail += r["failed"]

total = total_pass + total_fail
print(f"\n  总计: {total_pass}/{total} 通过, {total_fail} 失败")
print(f"  通过率: {total_pass/max(total,1)*100:.1f}%")

if total_fail > 0:
    print(f"\n  失败详情:")
    for stage, r in results.items():
        for name, err in r["errors"]:
            print(f"    - [{stage}] {name}: {err}")

print(f"{'='*60}")
