"""Business logic for authentication."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth.models import TokenBlacklist, User
from ..utils.security import (
    blacklist_all_user_tokens,
    blacklist_token,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    is_token_blacklisted,
    verify_password,
)


class AuthService:
    """Encapsulates all authentication operations."""

    def __init__(self, db: Session) -> None:
        self.db = db

    # ------------------------------------------------------------------
    # Implemented
    # ------------------------------------------------------------------

    def register(self, username: str, email: str, password: str) -> User:
        """Create a new user.

        Raises:
            ValueError: if the username or email is already taken.
        """
        existing = self.db.execute(
            select(User).where((User.username == username) | (User.email == email))
        ).scalar_one_or_none()

        if existing is not None:
            if existing.username == username:
                raise ValueError("Username already registered")
            raise ValueError("Email already registered")

        user = User(
            username=username,
            email=email,
            password_hash=hash_password(password),
        )
        self.db.add(user)
        self.db.commit()
        self.db.refresh(user)
        return user

    def login(self, username: str, password: str) -> dict[str, str]:
        """Authenticate a user and return tokens.

        Returns:
            A dict with ``access_token``, ``refresh_token``, and ``token_type``.

        Raises:
            ValueError: if the credentials are invalid.
        """
        user = self.db.execute(
            select(User).where(User.username == username)
        ).scalar_one_or_none()

        if user is None or not verify_password(password, user.password_hash):
            raise ValueError("Invalid username or password")

        if not user.is_active:
            raise ValueError("User account is inactive")

        access_token = create_access_token(str(user.id))
        refresh_token = create_refresh_token(str(user.id))

        return {
            "access_token": access_token,
            "refresh_token": refresh_token,
            "token_type": "bearer",
        }

    # ------------------------------------------------------------------
    # TODO — not yet implemented
    # ------------------------------------------------------------------

    def refresh(self, refresh_token: str) -> dict[str, str]:
        """Exchange a valid refresh token for a new access token.

        Steps that need to be implemented:
            1. Decode the *refresh_token* with ``decode_token``.
            2. Verify the decoded ``type`` claim equals ``"refresh"``.
            3. Check that the token's ``jti`` is not blacklisted via
               ``is_token_blacklisted``.
            4. Create and return a new access token via ``create_access_token``.

        Raises:
            ValueError: when the token is invalid, expired, wrong type, or revoked.
            NotImplementedError: always — this method is a stub.
        """
        raise NotImplementedError("Token refresh is not yet implemented")

    def revoke(self, token: str) -> None:
        """Revoke a single refresh token by blacklisting its ``jti``.

        Steps that need to be implemented:
            1. Decode the *token* with ``decode_token``.
            2. Extract the ``jti`` claim.
            3. Call ``blacklist_token(jti, user_id, expires_at)`` to persist
               the revocation.

        Raises:
            ValueError: when the token is invalid or already expired.
            NotImplementedError: always — this method is a stub.
        """
        raise NotImplementedError("Token revocation is not yet implemented")

    def logout(self, user_id: int) -> int:
        """Revoke **all** refresh tokens for *user_id*.

        Steps that need to be implemented:
            1. Call ``blacklist_all_user_tokens(user_id)``.
            2. Return the count of revoked tokens.

        Returns:
            The number of tokens revoked.

        Raises:
            NotImplementedError: always — this method is a stub.
        """
        raise NotImplementedError("Logout is not yet implemented")
