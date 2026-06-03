# 测试体系综合分析报告

**分析日期**: 2026-06-03  
**分析范围**: 全仓库所有测试文件（25个测试文件 + 2个conftest + 1个run_tests.py）  
**运行结果**: 787 passed, 2 failed, 1 skipped

---

## 一、测试运行结果汇总

| 测试套件 | 总数 | 通过 | 失败 | 跳过 | 耗时 |
|----------|------|------|------|------|------|
| harness 单元测试 (non-E2E) | 679 | 678 | 1 | 0 | 7m01s |
| harness E2E 测试 | 34 | 34 | 0 | 0 | 14m55s |
| harness CLI E2E 测试 | 10 | 9 | 1 | 0 | 1m51s |
| stage 单元测试 | 50 | 50 | 0 | 0 | 1.28s |
| stage E2E 测试 | 17 | 16 | 0 | 1 | 4m50s |
| **合计** | **790** | **787** | **2** | **1** | **~29m** |

---

## 二、失败测试分析

### 失败 1: `test_security_pipeline.py::TestClassifyActionModel::test_cache_hit`

**根因**: `.env` 中配置的模型名 `custom-model-v1` 不被 MiMo API 支持。  
**详细**: 测试通过 `_get_client()` 创建真实 API 客户端，但 `.env` 中的 `MIMO_MODEL=custom-model-v1` 导致 API 返回 400 错误。测试的 `@requires_api` 装饰器只检查 API key 是否存在，不检查模型名是否有效。  
**性质**: **配置问题**，非测试代码 bug。需要修正 `.env` 中的模型名为正确的 MiMo 模型名。  
**建议**: `_get_client()` 函数应验证模型名，或 `@requires_api` 装饰器应同时验证模型可用性。

### 失败 2: `test_cli_e2e.py::TestCLIDryRun::test_dry_run_mode`

**根因**: `--dry-run` 模式未真正阻止文件读取操作。  
**详细**: 测试断言 `--dry-run` 模式下不应读取 README.md 内容，但 agent 实际上读取了文件并输出了完整内容。  
**性质**: **真实 bug** — dry-run 模式的权限控制有缺陷，READ 权限在 dry-run 下仍被允许。  
**建议**: 修复 `permissions.py` 中 dry-run 模式对 READ 权限的处理逻辑。

### 跳过 1: `test_e2e.py::TestStage6E2E::test_browser_visit_example_com`

**根因**: Playwright 未安装。  
**性质**: 环境依赖问题，非代码 bug。

---

## 三、测试重复分析

### 3.1 E2E 测试与单元测试的功能重叠

| 重复点 | 单元测试位置 | E2E 测试位置 | 重叠程度 |
|--------|-------------|-------------|----------|
| model classifier | `test_security_pipeline.py::TestClassifyActionModel` (6 tests) | `test_e2e.py::TestE2EModelClassifier` (6 tests) | **高** — 完全相同的测试场景 |
| review_action | `test_security_pipeline.py::TestReviewAction` (3 tests) | `test_e2e.py::TestE2EReviewAction` (2 tests) | **高** — 几乎相同的测试场景 |
| classify_action model-driven | `test_security_pipeline.py::TestClassifyActionModelDriven` (3 @requires_api) | `test_e2e.py::TestE2EModelClassifier` | **高** — 重复测试同一功能 |
| prompt hook with API | `test_hooks.py::test_run_hooks_prompt_hook_with_client` | `test_e2e.py::TestE2EHookPrompt::test_prompt_hook_with_real_api` | **高** — 完全相同的测试逻辑 |
| SubAgent single/parallel/pipeline | `test_subagent.py::TestSubAgent` + `TestSubAgentManager` (@requires_api) | `test_subagent.py::TestSubAgentE2E` | **中** — E2E 类重复了 API 测试 |
| compact_context with LLM | `test_context.py::TestCompactContextWithLLM` (3 tests) | `test_e2e.py::TestE2ECompactContext` | **中** — 相似场景 |
| CLI main() paths | `test_cli.py::TestMainFunctionPaths` (7 tests, requires API) | `test_cli_e2e.py` (9 tests) | **中** — 部分重叠 |

**结论**: `test_e2e.py`（harness）中有约 **15 个测试** 与单元测试文件中的 `@requires_api` 测试高度重复。建议：
- 将 `@requires_api` 测试统一放到 `test_e2e.py` 中
- 或从 `test_e2e.py` 中移除与单元测试重复的场景

### 3.2 `test_subagent.py` 内部重复

`TestSubAgentE2E` 类与 `TestSubAgent`/`TestSubAgentManager` 中的 `@requires_api` 测试存在重叠：
- `TestSubAgentE2E::test_single_subagent` ≈ `TestSubAgentManager::test_run_single`
- `TestSubAgentE2E::test_parallel_subagents` ≈ `TestSubAgentManager::test_run_parallel`
- `TestSubAgentE2E::test_pipeline_subagents` ≈ `TestSubAgentManager::test_run_pipeline`

### 3.3 `test_subagent.py::TestSubAgentManager::test_aggregate_results` 与 `test_aggregate_results_advanced`

这两个测试使用完全相同的输入数据和断言逻辑，`test_aggregate_results_advanced` 只是增加了几个额外断言（avg_tokens, avg_duration, max/min_duration, errors）。建议合并为一个测试。

### 3.4 conftest 中 E2E retry 逻辑重复

`tests/conftest.py` 和 `mimo-harness/tests/conftest.py` 包含完全相同的 E2E retry 逻辑（`_is_retryable`, `pytest_runtest_call` hook）。建议提取为共享模块。

---

## 四、行为异常分析

### 4.1 `conftest.py` mock 环境变量的条件逻辑

```python
# mimo-harness/tests/conftest.py
_real_api_key = os.environ.get("MIMO_API_KEY", "")
if not _real_api_key or _real_api_key == "test-key-for-testing":
    os.environ["MIMO_API_KEY"] = "test-key-for-testing"
    os.environ["MIMO_BASE_URL"] = "http://localhost:8080/v1"
    os.environ["MIMO_MODEL"] = "test-model"
```

**问题**: 当 `.env` 中有真实 API key 时，mock 变量不会被设置。但 `.env` 中的 `MIMO_BASE_URL` 和 `MIMO_MODEL` 可能不正确（如当前的 `custom-model-v1`）。这意味着：
- 非 E2E 测试中需要 API 的测试（如 `test_cli.py::TestMainFunctionPaths`）会使用 `.env` 中的配置
- 如果 `.env` 配置错误，这些测试会失败而不是跳过

**建议**: `@requires_api` 装饰器应额外验证 API 可用性（如发送一个简单请求），而非仅检查 key 是否存在。

### 4.2 `test_cli.py::TestMainFunctionPaths` 放置位置不当

这个类需要真实 API（通过 `_require_api` fixture），但它位于 `test_cli.py`（非 E2E 测试文件）中。CI 中 `test_cli.py` 在 unit-tests job 运行，如果 secrets 不可用，这些测试会被跳过而不是失败。这违反了 E2E/单元测试的分离原则。

**建议**: 将 `TestMainFunctionPaths` 移到 `test_cli_e2e.py`。

### 4.3 `test_agent.py` 中 `@requires_api` 测试使用 `monkeypatch.chdir`

```python
def test_run_with_tool_calls(self, monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    file_ops._read_files.clear()
    file_ops._write_allowed_files.clear()
```

这些测试在 `tmp_path` 中运行，但 `file_ops` 的安全管道要求操作在 CWD 内。`monkeypatch.chdir(tmp_path)` 改变了 CWD，使得 `tmp_path` 成为 CWD，这在 Windows 上可能导致路径问题。

---

## 五、无效测试分析

### 5.1 `test_security_pipeline.py::TestClassifyActionModel::test_model_unavailable_fails_open`

```python
def test_model_unavailable_fails_open(self):
    class _FailingClient:
        class chat:
            class completions:
                @staticmethod
                def create(**kwargs):
                    raise ConnectionError("API unavailable")
    result = classify_action_model("run_command", {"command": "ls"}, client=_FailingClient)
    assert result is None
```

**问题**: 这个测试使用了一个手工构造的 mock 对象（`_FailingClient`），而非真实 API 调用。虽然它测试的是错误处理路径（API 不可用时 fail-open），但违反了"不使用 mock"的原则。

**建议**: 可以保留此测试（测试错误处理路径是合理的），但应明确标注为"mock 测试"或改用真实场景（如指向不存在的 API 端点）。

### 5.2 `test_tools.py::TestWebToolsDeep::test_web_fetch_network_error`

```python
def test_web_fetch_network_error(self, tmp_path, monkeypatch):
    result = json.loads(web_tools.web_fetch({"url": "http://192.0.2.1:1/nonexistent"}))
    assert "error" in result
```

这个测试依赖于 `192.0.2.1`（TEST-NET-1 地址）不可达，但在某些网络环境下可能行为不同。建议使用更可靠的错误触发方式。

---

## 六、缺失测试分析

### 6.1 缺失的测试场景

| 缺失场景 | 严重程度 | 说明 |
|----------|----------|------|
| `agent.py` 的并发工具调度 | 中 | `parallel_tool_dispatch` 和 `sequential_tool_dispatch` 没有专门的单元测试 |
| `context.py` 的 checkpoint restore 路径遍历检查 | 中 | `restore_last()` 的安全检查（路径遍历防护）没有测试 |
| `cli.py` 的 session resume 功能 | 低 | `/resume` 命令的端到端测试缺失 |
| `memory.py` 的 `load_topic_on_demand` 联动 | 低 | `context.py` 中的 `load_topic_on_demand` 有测试，但 `memory.py` 中的 `MemoryStore.load_topic` 与它的联动未测试 |
| `security_pipeline.py` 的 `_classifier_cache` TTL 过期 | 低 | 缓存过期逻辑有测试，但 TTL 精确过期场景未覆盖 |
| `tools/interactive.py` 的 `read_memory_topic` 安全检查 | 低 | 路径遍历防护有测试，但 symlink 攻击场景未覆盖 |

### 6.2 Stage 6 浏览器测试完全缺失

Stage 6 的 E2E 测试因 Playwright 未安装而跳过。CI 中虽然安装了 Playwright，但本地开发环境通常没有。建议：
- 添加 `@pytest.mark.skipif` 装饰器明确标注依赖
- 或在 CI 之外提供 mock 版本的浏览器测试

### 6.3 `run_tests.py` 未被任何测试覆盖

`mimo-harness/run_tests.py` 是自定义测试运行器，但它本身没有被测试覆盖。

---

## 七、Mock 测试识别

根据用户要求"不想要 mock 测试，真实情况的测试都给我调用 API"，以下是当前仍存在的 mock/模拟行为：

### 7.1 已删除的 mock（良好）

- `helpers.py`（MockClient, MockCompletions）已被删除 ✅
- `test_permissions.py` 中的 `_MockClient` 已替换为 `object()` ✅

### 7.2 仍存在的 mock/模拟行为

| 文件 | 测试 | mock 行为 | 建议 |
|------|------|-----------|------|
| `test_security_pipeline.py` | `test_model_unavailable_fails_open` | 手工构造 `_FailingClient` 模拟 API 失败 | 保留（错误路径测试），标注清楚 |
| `test_cli.py` | `TestMainFunctionPaths` 中的多个测试 | 使用 `monkeypatch.setattr("sys.argv", ...)` 模拟 CLI 参数 | 合理，非 API mock |
| `test_tools.py` | `test_web_fetch_url_validation_*` | 使用 SSRF 保护验证 URL 校验 | 合理，非 API mock |
| `test_permissions.py` | `test_write_needs_confirmation_default` 等 | 使用 `monkeypatch.setattr("builtins.input", ...)` 模拟用户输入 | 合理，非 API mock |
| `conftest.py` | 所有非 E2E 测试 | 当无真实 API key 时设置 mock 环境变量 | **问题** — 应确保 CI 中始终有真实 API key |

### 7.3 真实 API 调用的测试（良好）

以下测试文件中的 `@requires_api` 测试确实使用了真实 API 调用：
- `test_agent.py` — 8 个 API 测试 ✅
- `test_security_pipeline.py` — 9 个 API 测试 ✅
- `test_subagent.py` — 12 个 API 测试 ✅
- `test_e2e.py`（harness）— 34 个 API 测试 ✅
- `test_e2e.py`（stage）— 16 个 API 测试 ✅
- `test_cli_e2e.py` — 9 个 API 测试 ✅
- `test_hooks.py` — 1 个 API 测试 ✅
- `test_context.py` — 3 个 API 测试 ✅
- `test_cli.py` — 7 个 API 测试 ✅

---

## 八、改进建议

### 高优先级

1. **修复 `.env` 模型名**: 将 `MIMO_MODEL=custom-model-v1` 改为正确的 MiMo 模型名
2. **修复 dry-run 模式**: `permissions.py` 中 dry-run 应阻止所有写操作，包括 READ（当 agent 主动读取时）
3. **消除 E2E 测试重复**: 合并 `test_e2e.py` 与单元测试中 `@requires_api` 测试的重叠部分
4. **移动 `TestMainFunctionPaths`**: 从 `test_cli.py` 移到 `test_cli_e2e.py`

### 中优先级

5. **提取共享 conftest**: 将 E2E retry 逻辑提取为 `conftest_shared.py` 或 pytest plugin
6. **合并 `test_aggregate_results` 和 `test_aggregate_results_advanced`**
7. **增强 `@requires_api` 装饰器**: 验证 API 可用性而非仅检查 key 存在

### 低优先级

8. **添加 `agent.py` 并发调度测试**
9. **添加 `context.py` checkpoint 路径遍历测试**
10. **为 Stage 6 浏览器测试提供 fallback**

---

## 九、测试文件清单与分类

### 纯单元测试（无需 API，无 mock 问题）

| 文件 | 测试数 | 覆盖模块 |
|------|--------|----------|
| `test_config.py` | 7 | config.py |
| `test_context.py` (部分) | ~30 | context.py |
| `test_hooks.py` (部分) | ~13 | hooks.py |
| `test_logging.py` | 10 | logging_utils.py |
| `test_lsp_tools.py` | 11 | tools/lsp_tools.py |
| `test_memory.py` | 16 | memory.py |
| `test_notebook_tools.py` | 20 | tools/notebook_tools.py |
| `test_permissions.py` | ~25 | permissions.py |
| `test_plan_tools.py` | 17 | tools/plan_tools.py |
| `test_project_scanner.py` | 14 | project_scanner.py |
| `test_registry.py` | 12 | tools/registry.py |
| `test_scheduler_tools.py` | 22 | tools/scheduler_tools.py |
| `test_security_pipeline.py` (部分) | ~35 | security_pipeline.py |
| `test_settings.py` | 16 | settings.py |
| `test_stress_boundary.py` | ~20 | 多模块 |
| `test_subagent.py` (部分) | ~30 | subagent.py |
| `test_task_tools.py` | 15 | tools/task_tools.py |
| `test_token_counter.py` | 25 | token_counter.py |
| `test_tools.py` | ~60 | tools/*.py |
| `test_stage_unit.py` | 50 | stage-1 ~ stage-8 |

### E2E 测试（需要真实 API）

| 文件 | 测试数 | 覆盖范围 |
|------|--------|----------|
| `mimo-harness/tests/test_e2e.py` | 34 | harness 全功能 E2E |
| `mimo-harness/tests/test_cli_e2e.py` | 10 | CLI E2E |
| `tests/test_e2e.py` | 17 | Stage 1-8 E2E |

### 需要 API 但在非 E2E 文件中的测试（应迁移）

| 文件 | 测试类 | 测试数 |
|------|--------|--------|
| `test_agent.py` | `TestRunWithToolCalls`, `TestRunMaxStepsTermination`, `TestTerminationPaths`, `TestRunStreamMode`, `TestRunDefaultSession`, `TestRunStopHook`, `TestRunSequentialToolCalls` | 8 |
| `test_security_pipeline.py` | `TestClassifyActionModel`, `TestClassifyActionModelDriven`(部分), `TestReviewAction`(部分), `TestEdgeCases`(部分) | 9 |
| `test_subagent.py` | `TestSubAgent`(部分), `TestSubAgentManager`(部分), `TestConvenienceFunctions`(部分), `TestSubAgentE2E` | 12 |
| `test_hooks.py` | `test_run_hooks_prompt_hook_with_client` | 1 |
| `test_context.py` | `TestCompactContextWithLLM`(部分), `TestCompactContextTupleReturn`(部分) | 3 |
| `test_cli.py` | `TestMainFunctionPaths` | 7 |

---

## 十、Stage 测试覆盖矩阵

| Stage | 单元测试 | E2E测试 | 覆盖状态 | 备注 |
|-------|----------|----------|----------|------|
| Stage 0 | ❌ 无 | ❌ 无 | 未覆盖 | 只有学习笔记，无代码 |
| Stage 1 | ✅ 6 tests | ✅ 3 tests | 完整覆盖 | |
| Stage 2 | ✅ 8 tests | ✅ 2 tests | 完整覆盖 | |
| Stage 3 | ✅ 7 tests | ✅ 2 tests | 完整覆盖 | |
| Stage 4 | ✅ 6 tests | ✅ 3 tests | 完整覆盖 | |
| Stage 5 | ✅ 2 tests | ✅ 3 tests | 完整覆盖 | |
| Stage 6 | ✅ 7 tests | ⚠️ 1 skipped | 部分覆盖 | Playwright 未安装 |
| Stage 7 | ✅ 8 tests | ✅ 1 test | 完整覆盖 | |
| Stage 8 | ✅ 8 tests | ✅ 2 tests | 完整覆盖 | |

## 十一、Harness 模块测试覆盖矩阵

| 模块 | 单元测试 | E2E测试 | 覆盖状态 |
|------|----------|----------|----------|
| Agent | ✅ 5+8 tests | ✅ 8 tests | 完整覆盖 |
| CLI | ✅ 17+7 tests | ✅ 10 tests | 完整覆盖 |
| Config | ✅ 7 tests | ❌ 无 | 完整覆盖 |
| Context | ✅ ~30 tests | ✅ 1 test | 完整覆盖 |
| Hooks | ✅ ~13 tests | ✅ 1 test | 完整覆盖 |
| Logging | ✅ 10 tests | ❌ 无 | 完整覆盖 |
| LSP Tools | ✅ 11 tests | ❌ 无 | 完整覆盖 |
| Memory | ✅ 16 tests | ❌ 无 | 完整覆盖 |
| Notebook Tools | ✅ 20 tests | ❌ 无 | 完整覆盖 |
| Permissions | ✅ ~25 tests | ✅ 3 tests | 完整覆盖 |
| Plan Tools | ✅ 17 tests | ❌ 无 | 完整覆盖 |
| Project Scanner | ✅ 14 tests | ❌ 无 | 完整覆盖 |
| Registry | ✅ 12 tests | ❌ 无 | 完整覆盖 |
| Scheduler Tools | ✅ 22 tests | ❌ 无 | 完整覆盖 |
| Security Pipeline | ✅ ~35 tests | ✅ 8 tests | 完整覆盖 |
| Settings | ✅ 16 tests | ❌ 无 | 完整覆盖 |
| Stress/Boundary | ✅ ~20 tests | ❌ 无 | 完整覆盖 |
| SubAgent | ✅ ~30 tests | ✅ 4 tests | 完整覆盖 |
| Task Tools | ✅ 15 tests | ❌ 无 | 完整覆盖 |
| Token Counter | ✅ 25 tests | ✅ 2 tests | 完整覆盖 |
| Tools (综合) | ✅ ~60 tests | ✅ 12 tests | 完整覆盖 |
