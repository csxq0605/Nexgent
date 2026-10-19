"""Password reset flow — TODO stub.

Allows users to reset their password via a time-limited token
sent to their email address.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth.models import User
from ..utils.security import JWT_SECRET, JWT_ALGORITHM, hash_password


# Token lifetime for password reset
RESET_TOKEN_EXPIRE_MINUTES = 30


def create_reset_token(user_id: int, email: str) -> str:
    """Create a short-lived password reset token.

    The token contains:
        - sub: user ID
        - email: user email (for verification)
        - type: "password_reset"
        - exp: expiration timestamp

    Raises:
        NotImplementedError: always — this method is a stub.
    """
    raise NotImplementedError("Password reset token creation is not yet implemented")


def verify_reset_token(token: str) -> dict[str, Any]:
    """Verify a password reset token and return its payload.

    Steps:
        1. Decode the token with ``jwt.decode``.
        2. Verify ``type == "password_reset"``.
        3. Verify the token has not expired.

    Returns:
        The decoded payload dict.

    Raises:
        ValueError: when the token is invalid, expired, or wrong type.
        NotImplementedError: always — this method is a stub.
    """
    raise NotImplementedError("Password reset token verification is not yet implemented")


def reset_password(db: Session, token: str, new_password: str) -> None:
    """Reset a user's password using a valid reset token.

    Steps:
        1. Call ``verify_reset_token(token)`` to get the payload.
        2. Look up the user by ``payload["sub"]``.
        3. Verify the user's email matches ``payload["email"]``.
        4. Hash the new password with ``hash_password``.
        5. Update the user's ``password_hash``.
        6. Bump ``token_epoch`` to revoke all existing tokens.

    Raises:
        ValueError: when the token is invalid or user not found.
        NotImplementedError: always — this method is a stub.
    """
    raise NotImplementedError("Password reset is not yet implemented")
