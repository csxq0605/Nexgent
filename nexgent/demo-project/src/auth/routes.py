"""FastAPI routes for authentication."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy.orm import Session

from ..auth.service import AuthService

router = APIRouter(prefix="/auth", tags=["auth"])


# ---------------------------------------------------------------------------
# Pydantic request / response models
# ---------------------------------------------------------------------------

class RegisterRequest(BaseModel):
    username: str = Field(..., min_length=3, max_length=64)
    email: EmailStr
    password: str = Field(..., min_length=8)


class RegisterResponse(BaseModel):
    id: int
    username: str
    email: str
    is_active: bool
    created_at: str


class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str


class RefreshRequest(BaseModel):
    refresh_token: str


class RevokeRequest(BaseModel):
    token: str


class MessageResponse(BaseModel):
    message: str


class LogoutResponse(BaseModel):
    revoked_count: int


# ---------------------------------------------------------------------------
# Dependency — replace with your real DB-session dependency
# ---------------------------------------------------------------------------

def _get_db() -> Session:  # pragma: no cover — override in app setup
    """Provide a SQLAlchemy session. Replace with a real implementation."""
    raise RuntimeError("Database dependency not configured")


def _get_service(db: Session = Depends(_get_db)) -> AuthService:
    return AuthService(db)


# ---------------------------------------------------------------------------
# Implemented routes
# ---------------------------------------------------------------------------

@router.post("/register", response_model=RegisterResponse, status_code=status.HTTP_201_CREATED)
def register(body: RegisterRequest, svc: AuthService = Depends(_get_service)) -> Any:
    """Create a new user account."""
    try:
        user = svc.register(body.username, body.email, body.password)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    return RegisterResponse(
        id=user.id,
        username=user.username,
        email=user.email,
        is_active=user.is_active,
        created_at=user.created_at.isoformat(),
    )


@router.post("/login", response_model=TokenResponse)
def login(body: LoginRequest, svc: AuthService = Depends(_get_service)) -> Any:
    """Authenticate and receive access + refresh tokens."""
    try:
        tokens = svc.login(body.username, body.password)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc))

    return TokenResponse(**tokens)


# ---------------------------------------------------------------------------
# TODO routes — not yet implemented
# ---------------------------------------------------------------------------

@router.post(
    "/refresh",
    response_model=TokenResponse,
    responses={501: {"model": MessageResponse, "description": "Not yet implemented"}},
)
def refresh(body: RefreshRequest, svc: AuthService = Depends(_get_service)) -> Any:
    """Exchange a refresh token for a new access token.

    TODO: This endpoint delegates to ``AuthService.refresh`` which is not
    yet implemented.  Once implemented it should:
      - Validate the refresh token and verify ``type == "refresh"``.
      - Ensure the token's ``jti`` is not blacklisted.
      - Return a fresh access token.
    """
    try:
        return svc.refresh(body.refresh_token)
    except NotImplementedError:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="Token refresh is not yet implemented",
        )


@router.post(
    "/revoke",
    response_model=MessageResponse,
    responses={501: {"model": MessageResponse, "description": "Not yet implemented"}},
)
def revoke(body: RevokeRequest, svc: AuthService = Depends(_get_service)) -> Any:
    """Revoke a single refresh token.

    TODO: This endpoint delegates to ``AuthService.revoke`` which is not
    yet implemented.  Once implemented it should:
      - Decode the token and extract the ``jti``.
      - Persist the ``jti`` in the blacklist table.
    """
    try:
        svc.revoke(body.token)
        return MessageResponse(message="Token revoked")
    except NotImplementedError:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="Token revocation is not yet implemented",
        )


@router.post(
    "/logout",
    response_model=LogoutResponse,
    responses={501: {"model": MessageResponse, "description": "Not yet implemented"}},
)
def logout(
    authorization: str = Header(..., description="Bearer <access_token>"),
    svc: AuthService = Depends(_get_service),
) -> Any:
    """Revoke all refresh tokens for the authenticated user.

    TODO: This endpoint extracts the user id from the ``Authorization``
    header (by decoding the access token) and delegates to
    ``AuthService.logout``.  Once implemented it should:
      - Parse the Bearer token from the header.
      - Decode it to get the ``sub`` (user id).
      - Call ``svc.logout(user_id)`` to revoke all refresh tokens.
    """
    try:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise ValueError("Invalid Authorization header")
        from ..utils.security import decode_token
        payload = decode_token(token)
        user_id = int(payload["sub"])
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc))

    try:
        revoked = svc.logout(user_id)
        return LogoutResponse(revoked_count=revoked)
    except NotImplementedError:
        raise HTTPException(
            status_code=status.HTTP_501_NOT_IMPLEMENTED,
            detail="Logout is not yet implemented",
        )
