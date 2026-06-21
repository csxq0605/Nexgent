"""Tests for audit log."""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from src.auth.models import Base, User
from src.auth.audit import record_event, get_audit_logs


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
def user(db_session: Session) -> User:
    u = User(username="alice", email="alice@test.com", password_hash="hashed")
    db_session.add(u)
    db_session.commit()
    db_session.refresh(u)
    return u


class TestRecordEvent:
    """Test audit event recording."""

    def test_record_creates_entry(self, db_session, user):
        entry = record_event(db_session, "login_success", user_id=user.id, detail="OK")
        assert entry.id is not None
        assert entry.action == "login_success"
        assert entry.user_id == user.id

    def test_record_without_user(self, db_session):
        entry = record_event(db_session, "system_start", detail="Server started")
        assert entry.user_id is None
        assert entry.action == "system_start"

    def test_record_with_ip(self, db_session, user):
        entry = record_event(
            db_session, "login_failed", user_id=user.id,
            detail="Wrong password", ip_address="192.168.1.1"
        )
        assert entry.ip_address == "192.168.1.1"


class TestGetAuditLogs:
    """Test audit log querying."""

    def test_get_all_logs(self, db_session, user):
        record_event(db_session, "login_success", user_id=user.id)
        record_event(db_session, "token_refresh", user_id=user.id)
        record_event(db_session, "logout", user_id=user.id)

        logs = get_audit_logs(db_session)
        assert len(logs) == 3

    def test_filter_by_user(self, db_session, user):
        other = User(username="bob", email="bob@test.com", password_hash="hashed")
        db_session.add(other)
        db_session.commit()

        record_event(db_session, "login_success", user_id=user.id)
        record_event(db_session, "login_success", user_id=other.id)

        logs = get_audit_logs(db_session, user_id=user.id)
        assert len(logs) == 1
        assert logs[0]["user_id"] == user.id

    def test_filter_by_action(self, db_session, user):
        record_event(db_session, "login_success", user_id=user.id)
        record_event(db_session, "login_failed", user_id=user.id)

        logs = get_audit_logs(db_session, action="login_failed")
        assert len(logs) == 1
        assert logs[0]["action"] == "login_failed"

    def test_pagination(self, db_session, user):
        for i in range(10):
            record_event(db_session, "test_event", user_id=user.id, detail=f"Event {i}")

        page1 = get_audit_logs(db_session, limit=3, offset=0)
        page2 = get_audit_logs(db_session, limit=3, offset=3)
        assert len(page1) == 3
        assert len(page2) == 3
        assert page1[0]["id"] != page2[0]["id"]

    def test_logs_ordered_by_created_at_desc(self, db_session, user):
        record_event(db_session, "first", user_id=user.id)
        record_event(db_session, "second", user_id=user.id)

        logs = get_audit_logs(db_session)
        # Most recent first
        assert logs[0]["action"] == "second"
        assert logs[1]["action"] == "first"
