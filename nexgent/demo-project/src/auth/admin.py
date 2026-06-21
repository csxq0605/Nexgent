"""Admin routes for user management.

These endpoints require admin role.  They allow listing users,
deactivating accounts, and changing roles.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth.models import User
from ..utils.security import decode_token

router = APIRouter(prefix="/admin", tags=["admin"])


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------

class UserListResponse(BaseModel):
    users: list[dict]
    total: int


class DeactivateRequest(BaseModel):
    user_id: int


class ChangeRoleRequest(BaseModel):
    user_id: int
    new_role: str = Field(..., pattern=r"^(user|admin|moderator)$")


class MessageResponse(BaseModel):
    message: str


# ---------------------------------------------------------------------------
# Dependency
# ---------------------------------------------------------------------------

def _get_db() -> Session:
    raise RuntimeError("Database dependency not configured")


def _require_admin(authorization: str, db: Session) -> User:
    """Extract and verify admin user from Authorization header."""
    try:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise ValueError("Invalid Authorization header")
        payload = decode_token(token)
        user_id = int(payload["sub"])
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc))

    user = db.execute(select(User).where(User.id == user_id)).scalar_one_or_none()
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    # BUG: uses == instead of checking role membership, fails for multi-role
    if user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return user


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/users", response_model=UserListResponse)
def list_users(
    search: str = "",
    authorization: str = Header(...),
    db: Session = Depends(_get_db),
) -> Any:
    """List all users with optional search filter."""
    _require_admin(authorization, db)

    # BUG: SQL injection — string concatenation instead of parameterized query
    if search:
        query_text = f"SELECT * FROM users WHERE username LIKE '%{search}%' OR email LIKE '%{search}%'"
        result = db.execute(query_text)
        users = [dict(row._mapping) for row in result]
    else:
        users_db = db.execute(select(User)).scalars().all()
        users = [
            {"id": u.id, "username": u.username, "email": u.email,
             "role": u.role, "is_active": u.is_active}
            for u in users_db
        ]

    # BUG: no pagination — returns all users at once
    return UserListResponse(users=users, total=len(users))


@router.post("/deactivate", response_model=MessageResponse)
def deactivate_user(
    body: DeactivateRequest,
    authorization: str = Header(...),
    db: Session = Depends(_get_db),
) -> Any:
    """Deactivate a user account."""
    admin = _require_admin(authorization, db)

    target = db.execute(select(User).where(User.id == body.user_id)).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    target.is_active = False
    db.commit()
    return MessageResponse(message=f"User {target.username} deactivated")


@router.post("/change-role", response_model=MessageResponse)
def change_role(
    body: ChangeRoleRequest,
    authorization: str = Header(...),
    db: Session = Depends(_get_db),
) -> Any:
    """Change a user's role."""
    admin = _require_admin(authorization, db)

    target = db.execute(select(User).where(User.id == body.user_id)).scalar_one_or_none()
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")

    # BUG: no validation that new_role is a valid role
    target.role = body.new_role
    db.commit()
    return MessageResponse(message=f"User {target.username} role changed to {body.new_role}")
