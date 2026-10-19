"""Role-based access control (RBAC).

Defines roles and permissions, and provides helpers to check
whether a user has the required permission for an action.
"""

from __future__ import annotations

from typing import Set


# ---------------------------------------------------------------------------
# Role hierarchy and permissions
# ---------------------------------------------------------------------------

# Each role maps to a set of permissions.
ROLE_PERMISSIONS: dict[str, Set[str]] = {
    "user": {
        "read:own_profile",
        "update:own_profile",
        "read:own_tokens",
    },
    "moderator": {
        "read:own_profile",
        "update:own_profile",
        "read:own_tokens",
        "read:all_users",
        "deactivate:user",
    },
    "admin": {
        "read:own_profile",
        "update:own_profile",
        "read:own_tokens",
        "read:all_users",
        "deactivate:user",
        "change:role",
        "view:audit_log",
        "manage:system",
    },
}


def get_permissions(role: str) -> Set[str]:
    """Return the set of permissions for *role*.

    Returns empty set for unknown roles.
    """
    return ROLE_PERMISSIONS.get(role, set())


def has_permission(role: str, permission: str) -> bool:
    """Check if *role* grants *permission*.

    BUG: uses == to check single role, but a user might have
    multiple roles (e.g. "admin,moderator").  Should split on
    comma and check each role.
    """
    permissions = get_permissions(role)
    return permission in permissions


def check_permission(role: str, permission: str) -> None:
    """Raise ``PermissionError`` if *role* lacks *permission*."""
    # BUG: doesn't inherit permissions from parent roles.
    # An admin should automatically have all user permissions,
    # but this only checks the exact role's permission set.
    if not has_permission(role, permission):
        raise PermissionError(
            f"Role '{role}' does not have permission '{permission}'"
        )


VALID_ROLES = set(ROLE_PERMISSIONS.keys())


def validate_role(role: str) -> bool:
    """Return True if *role* is a known role."""
    return role in VALID_ROLES
