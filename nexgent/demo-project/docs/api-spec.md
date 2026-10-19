# Auth API Specification

Base URL: `/auth`

All request/response bodies are JSON (`Content-Type: application/json`).

---

## POST /auth/register

Create a new user account.

**Request body:**

```json
{
  "username": "string (3-64 chars)",
  "email": "string (valid email)",
  "password": "string (8+ chars)"
}
```

**Responses:**

| Code | Description                              |
|------|------------------------------------------|
| 201  | User created. Returns user object.       |
| 400  | Username or email already registered.    |
| 422  | Validation error (Pydantic).             |

**201 response body:**

```json
{
  "id": 1,
  "username": "alice",
  "email": "alice@example.com",
  "is_active": true,
  "created_at": "2026-01-15T10:30:00Z"
}
```

---

## POST /auth/login

Authenticate and receive tokens.

**Request body:**

```json
{
  "username": "string",
  "password": "string"
}
```

**Responses:**

| Code | Description                      |
|------|----------------------------------|
| 200  | Returns access and refresh JWTs. |
| 401  | Invalid credentials.             |

**200 response body:**

```json
{
  "access_token": "eyJ...",
  "refresh_token": "eyJ...",
  "token_type": "bearer"
}
```

---

## POST /auth/refresh  *(TODO — not yet implemented)*

Exchange a valid refresh token for a new access token.

**Request body:**

```json
{
  "refresh_token": "eyJ..."
}
```

**Responses:**

| Code | Description                                        |
|------|----------------------------------------------------|
| 200  | New access token issued.                           |
| 401  | Refresh token expired, revoked, or of wrong type.  |
| 501  | Endpoint not yet implemented.                      |

---

## POST /auth/revoke  *(TODO — not yet implemented)*

Revoke a single refresh token by adding its `jti` to the blacklist.

**Request body:**

```json
{
  "token": "eyJ..."
}
```

**Responses:**

| Code | Description                      |
|------|----------------------------------|
| 200  | Token revoked successfully.      |
| 401  | Token invalid or already expired.|
| 501  | Endpoint not yet implemented.    |

---

## POST /auth/logout  *(TODO — not yet implemented)*

Revoke **all** refresh tokens for the authenticated user. Requires a valid access token in the `Authorization` header.

**Request headers:**

```
Authorization: Bearer <access_token>
```

**Responses:**

| Code | Description                           |
|------|---------------------------------------|
| 200  | All tokens revoked.                   |
| 401  | Missing or invalid access token.      |
| 501  | Endpoint not yet implemented.         |

**200 response body:**

```json
{
  "revoked_count": 3
}
```
