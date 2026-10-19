"""Audit log — records security-relevant events."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..auth.models import AuditLog


def record_event(
    db: Session,
    action: str,
    user_id: int | None = None,
    detail: str = "",
    ip_address: str = "",
) -> AuditLog:
    """Record an audit event.

    Args:
        db: Database session.
        action: Event type (e.g. "login_success", "login_failed", "token_revoked").
        user_id: User involved, if any.
        detail: Human-readable description.
        ip_address: Client IP address.
    """
    entry = AuditLog(
        user_id=user_id,
        action=action,
        detail=detail,
        ip_address=ip_address,
    )
    db.add(entry)
    db.commit()
    return entry


def get_audit_logs(
    db: Session,
    user_id: int | None = None,
    action: str | None = None,
    limit: int = 100,
    offset: int = 0,
) -> list[dict[str, Any]]:
    """Query audit logs with optional filters.

    Args:
        db: Database session.
        user_id: Filter by user.
        action: Filter by action type.
        limit: Max results to return.
        offset: Pagination offset.

    Returns:
        List of audit log dicts.
    """
    query = select(AuditLog)
    if user_id is not None:
        query = query.where(AuditLog.user_id == user_id)
    if action is not None:
        query = query.where(AuditLog.action == action)
    # BUG: no index on created_at, slow for large tables
    query = query.order_by(AuditLog.created_at.desc())
    # BUG: no upper bound on limit — caller can request millions of rows
    query = query.limit(limit).offset(offset)

    results = db.execute(query).scalars().all()
    return [
        {
            "id": r.id,
            "user_id": r.user_id,
            "action": r.action,
            "detail": r.detail,
            "ip_address": r.ip_address,
            "created_at": r.created_at.isoformat(),
        }
        for r in results
    ]
