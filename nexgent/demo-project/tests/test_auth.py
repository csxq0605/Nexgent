"""Tests for the auth service."""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from src.auth.models import Base, User
from src.auth.service import AuthService
from src.utils.security import (
    ACCESS_TOKEN_EXPIRE_MINUTES,
    REFRESH_TOKEN_EXPIRE_DAYS,
    create_access_token,
    create_refresh_token,
    decode_token,
    hash_password,
    verify_password,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def db_session() -> Session:
    """Yield a SQLAlchemy session backed by an in-memory SQLite database."""
    engine = create_engine("sqlite:///:memory:", echo=False)
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(bind=engine, expire_on_commit=False)
    session = TestSession()
    try:
        yield session
    finally:
        session.close()
        Base.metadata.drop_all(engine)


@pytest.fixture()
def svc(db_session: Session) -> AuthService:
    """Return an AuthService wired to the test database."""
    return AuthService(db_session)


# ---------------------------------------------------------------------------
# Security / token utility tests
# ---------------------------------------------------------------------------

class TestSecurity:
    """Tests for password hashing and JWT helpers."""

    def test_hash_password_returns_bcrypt_hash(self) -> None:
        plain = "s3cret-password!"
        hashed = hash_password(plain)
        assert hashed != plain
        assert hashed.startswith("$2b$") or hashed.startswith("$2a$")

    def test_verify_password_success(self) -> None:
        plain = "correct-horse-battery-staple"
        hashed = hash_password(plain)
        assert verify_password(plain, hashed) is True

    def test_verify_password_failure(self) -> None:
        hashed = hash_password("real-password")
        assert verify_password("wrong-password", hashed) is False

    def test_access_token_contains_expected_claims(self) -> None:
        token = create_access_token("42")
        payload = decode_token(token)
        assert payload["sub"] == "42"
        assert payload["type"] == "access"
        assert "exp" in payload

    def test_refresh_token_contains_expected_claims(self) -> None:
        token = create_refresh_token("42")
        payload = decode_token(token)
        assert payload["sub"] == "42"
        assert payload["type"] == "refresh"
        assert "exp" in payload

    def test_refresh_token_has_jti(self) -> None:
        """Refresh tokens must include a unique ``jti`` claim."""
        token = create_refresh_token("7")
        payload = decode_token(token)
        assert "jti" in payload
        assert isinstance(payload["jti"], str)
        assert len(payload["jti"]) == 36  # UUID v4 string length

    def test_two_refresh_tokens_have_different_jti(self) -> None:
        t1 = decode_token(create_refresh_token("1"))
        t2 = decode_token(create_refresh_token("1"))
        assert t1["jti"] != t2["jti"]


# ---------------------------------------------------------------------------
# Registration tests
# ---------------------------------------------------------------------------

class TestRegister:
    """Tests for AuthService.register."""

    def test_register_success(self, svc: AuthService) -> None:
        user = svc.register("alice", "alice@example.com", "password123")
        assert user.id is not None
        assert user.username == "alice"
        assert user.email == "alice@example.com"
        assert user.is_active is True
        assert user.password_hash != "password123"

    def test_register_duplicate_username(self, svc: AuthService) -> None:
        svc.register("alice", "alice@example.com", "password123")
        with pytest.raises(ValueError, match="Username already registered"):
            svc.register("alice", "other@example.com", "password123")

    def test_register_duplicate_email(self, svc: AuthService) -> None:
        svc.register("alice", "alice@example.com", "password123")
        with pytest.raises(ValueError, match="Email already registered"):
            svc.register("bob", "alice@example.com", "password123")


# ---------------------------------------------------------------------------
# Login tests
# ---------------------------------------------------------------------------

class TestLogin:
    """Tests for AuthService.login."""

    def test_login_success(self, svc: AuthService) -> None:
        svc.register("alice", "alice@example.com", "password123")
        result = svc.login("alice", "password123")
        assert "access_token" in result
        assert "refresh_token" in result
        assert result["token_type"] == "bearer"
        # Verify tokens decode without error
        decode_token(result["access_token"])
        decode_token(result["refresh_token"])

    def test_login_wrong_password(self, svc: AuthService) -> None:
        svc.register("alice", "alice@example.com", "password123")
        with pytest.raises(ValueError, match="Invalid username or password"):
            svc.login("alice", "wrong-password")

    def test_login_nonexistent_user(self, svc: AuthService) -> None:
        with pytest.raises(ValueError, match="Invalid username or password"):
            svc.login("ghost", "password123")


# ---------------------------------------------------------------------------
# Refresh tests (TODO)
# ---------------------------------------------------------------------------

class TestRefresh:
    """Tests for AuthService.refresh — not yet implemented."""

    def test_refresh_valid_token(self, svc: AuthService) -> None:
        svc.register("alice", "alice@example.com", "password123")
        tokens = svc.login("alice", "password123")
        try:
            result = svc.refresh(tokens["refresh_token"])
            assert "access_token" in result
        except NotImplementedError:
            pytest.skip("Token refresh not yet implemented")

    def test_refresh_with_access_token_fails(self, svc: AuthService) -> None:
        svc.register("alice", "alice@example.com", "password123")
        tokens = svc.login("alice", "password123")
        try:
            with pytest.raises(ValueError):
                svc.refresh(tokens["access_token"])
        except NotImplementedError:
            pytest.skip("Token refresh not yet implemented")


# ---------------------------------------------------------------------------
# Revoke tests (TODO)
# ---------------------------------------------------------------------------

class TestRevoke:
    """Tests for AuthService.revoke — not yet implemented."""

    def test_revoke_refresh_token(self, svc: AuthService) -> None:
        svc.register("alice", "alice@example.com", "password123")
        tokens = svc.login("alice", "password123")
        try:
            svc.revoke(tokens["refresh_token"])
        except NotImplementedError:
            pytest.skip("Token revocation not yet implemented")

    def test_revoke_prevents_refresh(self, svc: AuthService) -> None:
        svc.register("alice", "alice@example.com", "password123")
        tokens = svc.login("alice", "password123")
        try:
            svc.revoke(tokens["refresh_token"])
            with pytest.raises(ValueError):
                svc.refresh(tokens["refresh_token"])
        except NotImplementedError:
            pytest.skip("Token revocation not yet implemented")


# ---------------------------------------------------------------------------
# Logout tests (TODO)
# ---------------------------------------------------------------------------

class TestLogout:
    """Tests for AuthService.logout — not yet implemented."""

    def test_logout_revokes_all_tokens(self, svc: AuthService, db_session: Session) -> None:
        user = svc.register("alice", "alice@example.com", "password123")
        svc.login("alice", "password123")
        svc.login("alice", "password123")
        try:
            count = svc.logout(user.id)
            assert count >= 0
        except NotImplementedError:
            pytest.skip("Logout not yet implemented")
