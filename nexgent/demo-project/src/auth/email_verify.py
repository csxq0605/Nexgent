"""Email verification flow — TODO stub.

Sends a verification email after registration and verifies
the token when the user clicks the link.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth.models import User
from ..utils.security import JWT_SECRET, JWT_ALGORITHM


# Token lifetime for email verification
VERIFY_TOKEN_EXPIRE_HOURS = 24


def create_verify_token(user_id: int, email: str) -> str:
    """Create an email verification token.

    The token contains:
        - sub: user ID
        - email: user email
        - type: "email_verify"
        - exp: expiration timestamp

    Raises:
        NotImplementedError: always — this method is a stub.
    """
    raise NotImplementedError("Email verification token creation is not yet implemented")


def verify_email(db: Session, token: str) -> None:
    """Verify a user's email address using the token from the verification link.

    Steps:
        1. Decode the token with ``jwt.decode``.
        2. Verify ``type == "email_verify"``.
        3. Look up the user by ``payload["sub"]``.
        4. Verify the user's email matches ``payload["email"]``.
        5. Set ``user.email_verified = True``.

    Raises:
        ValueError: when the token is invalid, expired, or user not found.
        NotImplementedError: always — this method is a stub.
    """
    raise NotImplementedError("Email verification is not yet implemented")
