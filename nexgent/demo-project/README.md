# Provider 驱动的交互式功能沙箱

`demo-project` 是一套带预置缺陷与 TODO 的 FastAPI 认证仓库，用于交互展示 Nexgent 的
Skills、工具、并行 SubAgent、Workflow、记忆、规则和普通目标执行。它需要配置 Provider，
不是验证持久故障闭环的离线 Demo。

无需 API Key 的正式 Harness 闭环演示位于
`../examples/harness_fault_recovery_demo.py`。

## 快速开始

```bash
cd Nexgent/nexgent
pip install -e ".[demo]"
cd demo-project
nexgent
```

## 一键演示

```
nexgent> /demo
```

## 手动体验

```
nexgent> Read AGENTS.md
nexgent> Run the tests
nexgent> Review src/auth/admin.py for security issues
nexgent> /parallel Review admin.py | Review rate_limit.py | Review roles.py
nexgent> Fix the most critical bug you found
nexgent> Implement the refresh feature in service.py
nexgent> /goal All tests pass and no NotImplementedError stubs remain
nexgent> /workflow run examples/workflow-full-review.py
nexgent> Remember: we use bcrypt for passwords, never plaintext
nexgent> /mode plan
nexgent> Refactor the admin routes to extract a service layer
```

## 项目结构

```
src/auth/
├── models.py          # SQLAlchemy ORM 模型
├── routes.py          # FastAPI 路由
├── service.py         # 业务逻辑
├── admin.py           # 用户管理接口
├── rate_limit.py      # 限流器
├── audit.py           # 审计日志
├── roles.py           # 权限控制
├── password_reset.py  # 密码重置
├── email_verify.py    # 邮箱验证
└── ...
tests/
└── ...                # 测试套件
```

## 运行测试

```bash
python -m pytest tests/ -v
```
