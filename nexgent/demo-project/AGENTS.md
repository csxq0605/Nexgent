# Auth Service — Project Knowledge Base

## Project Structure

```
demo-project/
├── AGENTS.md                  # This file — project knowledge base
├── README.md                  # Usage guide and tutorials
├── docs/
│   ├── api-spec.md            # REST API endpoint specification
│   └── architecture.md        # System architecture and design decisions
├── src/
│   ├── __init__.py
│   ├── auth/
│   │   ├── __init__.py
│   │   ├── models.py          # SQLAlchemy ORM models
│   │   ├── routes.py          # FastAPI route definitions
│   │   ├── service.py         # Business logic layer
│   │   ├── admin.py           # Admin routes (list users, deactivate, change role)
│   │   ├── rate_limit.py      # In-memory sliding-window rate limiter
│   │   ├── audit.py           # Audit log (event recording and querying)
│   │   ├── roles.py           # RBAC (role-permission mapping)
│   │   ├── password_reset.py  # Password reset flow
│   │   └── email_verify.py    # Email verification flow
│   └── utils/
│       ├── __init__.py
│       └── security.py        # JWT and password hashing utilities
└── tests/
    ├── conftest.py            # Shared fixtures and sys.path setup
    ├── test_auth.py           # Auth flow tests
    ├── test_admin.py          # Admin route tests
    ├── test_rate_limit.py     # Rate limiter tests
    ├── test_audit.py          # Audit log tests
    └── test_roles.py          # RBAC tests
```

## Tech Stack

- **Python** 3.10+
- **FastAPI** — async web framework with automatic OpenAPI docs
- **SQLAlchemy** 2.0+ — ORM with `DeclarativeBase` style
- **PyJWT** — JWT encoding/decoding
- **bcrypt** — password hashing
- **pytest** — test runner with fixtures and parametrize

## Code Conventions

- Use **type hints** on all function signatures and class attributes.
- Models inherit from `DeclarativeBase` (SQLAlchemy 2.0 style).
- Routes are thin: parse input with Pydantic, delegate to service layer, return response.
- Service layer owns all business logic and database mutations.
- Security utilities are stateless — they receive arguments, never import DB sessions.
- Use **relative imports** within `src/` packages (e.g. `from ..auth.models import TokenBlacklist`).
- TODO stubs must raise `NotImplementedError` with a descriptive message.
- Constants (JWT secret, expiry) live in `src/utils/security.py` and are read from environment.

## Architecture

Three-layer design: Routes → Service → Models.

- Routes never call models directly; always go through the service.
- Service methods accept a SQLAlchemy `Session` (injected at init).
- Models define tables only — no business logic.

JWT tokens use HS256 with 15-minute access tokens and 7-day refresh tokens.
Refresh tokens carry a unique `jti` for per-token revocation.
Logout uses epoch-based bulk revocation (O(1) regardless of token count).
