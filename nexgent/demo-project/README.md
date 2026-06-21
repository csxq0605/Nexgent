# Demo Project

A FastAPI auth service with bugs to find and features to implement. Use Nexgent to work on it.

## Quick Start

```bash
cd nexgent && pip install -e .
cd demo-project
nexgent
```

## One Command Demo

```
nexgent> /demo
```

Runs through all Nexgent features: project analysis, parallel code review, bug fixing, feature implementation, memory, rules, workflow engine, and verification.

## Or Try Manually

```
nexgent> Read AGENTS.md
nexgent> Run the tests
nexgent> Review src/auth/admin.py for security issues
nexgent> /parallel Review admin.py | Review rate_limit.py | Review roles.py
nexgent> Fix the most critical bug
nexgent> Implement the refresh feature in service.py
nexgent> Remember: we use bcrypt for passwords, never plaintext
nexgent> /goal All tests pass and no NotImplementedError stubs remain
```

## What's in the Project

| Module | What it does |
|--------|-------------|
| `auth/` | Register, login, token management |
| `admin.py` | User management endpoints |
| `rate_limit.py` | Sliding-window rate limiter |
| `audit.py` | Security event logging |
| `roles.py` | Role-based access control |
| `password_reset.py` | Password reset (TODO stub) |
| `email_verify.py` | Email verification (TODO stub) |
