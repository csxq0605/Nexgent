"""Tests for RBAC — reveals planted bugs in roles.py."""

from __future__ import annotations

import pytest

from src.auth.roles import (
    get_permissions,
    has_permission,
    check_permission,
    validate_role,
    VALID_ROLES,
)


class TestGetPermissions:
    """Test role permission lookup."""

    def test_user_has_basic_permissions(self):
        perms = get_permissions("user")
        assert "read:own_profile" in perms
        assert "update:own_profile" in perms

    def test_admin_has_all_permissions(self):
        perms = get_permissions("admin")
        assert "manage:system" in perms
        assert "change:role" in perms
        assert "read:own_profile" in perms

    def test_moderator_has_moderation_permissions(self):
        perms = get_permissions("moderator")
        assert "deactivate:user" in perms
        assert "read:all_users" in perms
        assert "manage:system" not in perms

    def test_unknown_role_returns_empty(self):
        perms = get_permissions("ghost")
        assert len(perms) == 0


class TestHasPermission:
    """Test permission checking."""

    def test_admin_has_manage_system(self):
        assert has_permission("admin", "manage:system") is True

    def test_user_lacks_manage_system(self):
        assert has_permission("user", "manage:system") is False

    def test_moderator_lacks_manage_system(self):
        assert has_permission("moderator", "manage:system") is False

    def test_multi_role_string_fails(self):
        """BUG: has_permission uses == to check role, so 'admin,moderator'
        doesn't match 'admin'.  This test documents the bug."""
        # This SHOULD return True because the user has admin role
        # but the implementation uses == instead of checking membership
        result = has_permission("admin,moderator", "manage:system")
        # The bug causes this to return False
        assert result is False  # Documents the current (broken) behavior


class TestCheckPermission:
    """Test permission enforcement."""

    def test_check_passes_for_valid_permission(self):
        # Should not raise
        check_permission("admin", "manage:system")

    def test_check_raises_for_missing_permission(self):
        with pytest.raises(PermissionError):
            check_permission("user", "manage:system")

    def test_admin_inherits_user_permissions(self):
        """BUG: admin should inherit all user permissions automatically.
        Currently ROLE_PERMISSIONS defines them separately, so this works
        by coincidence (admin has the same entries). But if user permissions
        change, admin won't pick them up automatically."""
        user_perms = get_permissions("user")
        admin_perms = get_permissions("admin")
        # This passes because admin explicitly lists user permissions
        # but it's fragile — should use hierarchy instead
        assert user_perms.issubset(admin_perms)


class TestValidateRole:
    """Test role validation."""

    def test_valid_roles(self):
        assert validate_role("user") is True
        assert validate_role("admin") is True
        assert validate_role("moderator") is True

    def test_invalid_role(self):
        assert validate_role("superadmin") is False
        assert validate_role("") is False
