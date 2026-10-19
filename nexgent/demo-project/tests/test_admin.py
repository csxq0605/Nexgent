"""Tests for admin routes.

Note: some tests intentionally pass despite planted bugs in admin.py.
The agent should discover these mismatches during code review.
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine, text
from sqlalchemy.orm import Session, sessionmaker

from src.auth.models import Base, User
from src.auth.admin import _require_admin


@pytest.fixture()
def db_session() -> Session:
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
def admin_user(db_session: Session) -> User:
    user = User(
        username="admin", email="admin@test.com",
        password_hash="hashed", role="admin",
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


@pytest.fixture()
def regular_user(db_session: Session) -> User:
    user = User(
        username="alice", email="alice@test.com",
        password_hash="hashed", role="user",
    )
    db_session.add(user)
    db_session.commit()
    db_session.refresh(user)
    return user


class TestAdminAccess:
    """Test admin access control."""

    def test_admin_can_access_admin_endpoints(self, db_session, admin_user):
        """Admin users should have access to admin routes."""
        # This test passes because admin.role == "admin" matches the == check
        assert admin_user.role == "admin"

    def test_regular_user_cannot_access_admin_endpoints(self, db_session, regular_user):
        """Regular users should be denied admin access."""
        # This test passes, but the bug is that multi-role users
        # (e.g. "admin,moderator") would fail the == check
        assert regular_user.role != "admin"

    def test_moderator_role_check(self, db_session):
        """Moderator with comma-separated roles should be handled."""
        user = User(
            username="mod", email="mod@test.com",
            password_hash="hashed", role="admin,moderator",
        )
        db_session.add(user)
        db_session.commit()
        # BUG: this would fail the == check even though user has admin role
        # The test documents the expected behavior but the implementation is wrong
        assert user.role == "admin,moderator"  # not == "admin"


class TestUserSearch:
    """Test user search functionality."""

    def test_search_returns_matching_users(self, db_session, admin_user, regular_user):
        """Search should return users matching the query."""
        # Note: the actual search uses string concatenation (SQL injection bug)
        # but this test only verifies the function exists and returns data
        users = db_session.execute(text("SELECT * FROM users")).fetchall()
        assert len(users) >= 2

    def test_search_empty_returns_all(self, db_session, admin_user, regular_user):
        """Empty search should return all users."""
        users = db_session.execute(text("SELECT * FROM users")).fetchall()
        assert len(users) >= 2
