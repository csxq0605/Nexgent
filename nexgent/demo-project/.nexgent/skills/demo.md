---
name: demo
description: Demonstrate all Nexgent features on this project
user_invocable: true
---

You are running a full Nexgent feature showcase on this project. Execute every step below — each step demonstrates a different Nexgent capability.

## Step 1: Project Understanding (AGENTS.md)
Read `AGENTS.md` and summarize what this project is, its tech stack, and code conventions.

## Step 2: Run Tests (Shell Tool)
Run `python -m pytest tests/ -v --tb=short` and report results.

## Step 3: Code Review (SubAgents)
Run three parallel code reviews:
- Review `src/auth/admin.py` for security issues
- Review `src/auth/rate_limit.py` for concurrency bugs
- Review `src/auth/roles.py` for logic errors

For each file, report findings with severity and line numbers.

## Step 4: Fix a Bug (File Tools + Checkpoint)
Pick the most critical bug you found and fix it using `edit_file`. After fixing, run tests to verify.

## Step 5: Implement a Feature (TODO Stub)
Read `src/auth/password_reset.py` — it has a `NotImplementedError` stub. Implement `create_reset_token` following the docstring instructions. Run tests after.

## Step 6: Store Memory (Memory System)
Store this memory: "The demo-project uses epoch-based bulk revocation for logout — O(1) regardless of token count. The rate limiter has a known race condition that needs a threading.Lock."

## Step 7: Create a Rule (Rules System)
Create a security rule for `src/auth/` files: "Never use string concatenation in SQL queries. Always use parameterized queries or SQLAlchemy select()."

## Step 8: Workflow (Workflow Engine)
Run this workflow to review all remaining source files:
```
/workflow run examples/workflow-full-review.py
```

## Step 9: Final Verification (Goal)
Run all tests one final time and report: total, passed, failed, skipped. Summarize everything you demonstrated.
