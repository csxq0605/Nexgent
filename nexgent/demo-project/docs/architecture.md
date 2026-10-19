# Architecture

## Layered Design

The service follows a three-layer architecture:

```
HTTP Request
    │
    ▼
┌──────────────────┐
│   Routes Layer   │  FastAPI routers — input validation (Pydantic), HTTP status codes
│  (routes.py)     │
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│  Service Layer   │  Business logic — auth rules, token creation, DB transactions
│  (service.py)    │
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│   Model Layer    │  SQLAlchemy ORM — table definitions, column types, relationships
│  (models.py)     │
└──────────────────┘
```

**Rules:**

- Routes never import or call models directly; they go through the service.
- Service methods accept a SQLAlchemy `Session` (injected at init) and return domain objects or dicts.
- Models define tables only — no business logic.

---

## JWT Structure

### Access Token (short-lived)

| Claim  | Type   | Description                         |
|--------|--------|-------------------------------------|
| `sub`  | string | User ID (stringified integer)       |
| `exp`  | int    | Expiration — UTC epoch seconds      |
| `type` | string | `"access"`                          |

- **Algorithm:** HS256
- **Lifetime:** 15 minutes (`ACCESS_TOKEN_EXPIRE_MINUTES = 15`)
- **Secret:** `JWT_SECRET` environment variable

### Refresh Token (long-lived)

| Claim  | Type   | Description                         |
|--------|--------|-------------------------------------|
| `sub`  | string | User ID                             |
| `exp`  | int    | Expiration — UTC epoch seconds      |
| `type` | string | `"refresh"`                         |
| `jti`  | string | Unique token ID (UUID v4)           |

- **Algorithm:** HS256
- **Lifetime:** 7 days (`REFRESH_TOKEN_EXPIRE_DAYS = 7`)
- **Secret:** same `JWT_SECRET`

The `jti` claim enables per-token revocation: when a refresh token is revoked, its `jti` is stored in the `token_blacklist` table and checked on every refresh attempt.

---

## Security Requirements

1. **Passwords** are hashed with bcrypt before storage. Plaintext passwords are never persisted or logged.
2. **JWT secret** must be set via the `JWT_SECRET` environment variable. The application raises an error at startup if it is missing.
3. **Access tokens** are short-lived (15 min) to limit the blast radius of token theft.
4. **Refresh tokens** carry a unique `jti` so they can be individually revoked.
5. **Token blacklist** — the `token_blacklist` table stores revoked JTIs with an expiry date. Rows can be garbage-collected after their `expires_at` passes.
6. **Logout** revokes every refresh token for a user by inserting all known JTIs (or by marking the user's token epoch, depending on implementation).
7. **No token in response body for protected routes** — only `/login` and `/refresh` return tokens.
