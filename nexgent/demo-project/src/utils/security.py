"""JWT and password-hashing utilities.

Constants are module-level so they can be imported directly:

    from src.utils.security import ACCESS_TOKEN_EXPIRE_MINUTES, create_access_token
"""

import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

import bcrypt
import jwt

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

JWT_SECRET: str = os.environ.get("JWT_SECRET", "change-me-in-production")
JWT_ALGORITHM: str = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES: int = 15
REFRESH_TOKEN_EXPIRE_DAYS: int = 7


# ---------------------------------------------------------------------------
# Password helpers
# ---------------------------------------------------------------------------

def hash_password(plain: str) -> str:
    """Hash a plaintext password with bcrypt and return the hash string."""
    return bcrypt.hashpw(plain.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """Return True if *plain* matches the bcrypt *hashed* password."""
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


# ---------------------------------------------------------------------------
# Token creation
# ---------------------------------------------------------------------------

def create_access_token(subject: str) -> str:
    """Create a short-lived access token.

    Claims:
        sub  — the user id (as a string)
        exp  — expiration timestamp (UTC)
        type — "access"
    """
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": subject,
        "exp": now + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
        "type": "access",
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def create_refresh_token(subject: str) -> str:
    """Create a long-lived refresh token.

    Claims:
        sub  — the user id (as a string)
        iat  — issued-at timestamp (UTC, integer seconds)
        exp  — expiration timestamp (UTC)
        type — "refresh"
        jti  — unique token id (UUID v4) used for per-token revocation
    """
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": subject,
        "iat": int(now.timestamp()),
        "exp": now + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
        "type": "refresh",
        "jti": str(uuid.uuid4()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


# ---------------------------------------------------------------------------
# Token decoding
# ---------------------------------------------------------------------------

def decode_token(token: str) -> dict[str, Any]:
    """Decode and verify a JWT.  Raises ``jwt.PyJWTError`` on failure."""
    return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])


# ---------------------------------------------------------------------------
# Blacklist helpers
# ---------------------------------------------------------------------------

def is_token_blacklisted(jti: str, db: Any = None) -> bool:
    """Check whether a token's *jti* has been revoked.

    Queries the ``token_blacklist`` table.  Returns ``False`` if no
    database session is provided (e.g. during stateless token decoding).
    """
    if db is None:
        return False
    from sqlalchemy import select
    from src.auth.models import TokenBlacklist
    result = db.execute(
        select(TokenBlacklist).where(TokenBlacklist.jti == jti)
    ).scalar_one_or_none()
    return result is not None


def blacklist_token(jti: str, user_id: int, expires_at: datetime, db: Any = None) -> None:
    """Add a token *jti* to the blacklist.

    INSERTs a row into ``token_blacklist`` with the given *jti*,
    *user_id*, and *expires_at*.
    """
    if db is None:
        return
    from src.auth.models import TokenBlacklist
    entry = TokenBlacklist(jti=jti, user_id=user_id, expires_at=expires_at)
    db.add(entry)
    db.commit()


def blacklist_all_user_tokens(user_id: int, db: Any = None) -> int:
    """Revoke every refresh token belonging to *user_id*.

    Strategy: maintain a ``token_epoch`` on the User model — set it to
    ``now() + 1s``.  Any refresh token with ``iat <= now`` is rejected.
    The +1s buffer ensures tokens issued in the same second as logout
    are also revoked (JWT ``iat`` is integer seconds).

    Returns the number of tokens logically revoked (1 for the epoch bump).
    """
    if db is None:
        return 0
    from sqlalchemy import update
    from src.auth.models import User
    # +1 second buffer: ensures tokens issued in the same second as logout
    # have iat < epoch and are properly rejected.
    now_plus_1 = datetime.utcnow().replace(microsecond=0) + timedelta(seconds=1)
    db.execute(
        update(User).where(User.id == user_id).values(token_epoch=now_plus_1)
    )
    db.commit()
    return 1
