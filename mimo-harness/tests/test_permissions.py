"""Tests for the permission pipeline (Ch4 patterns)."""

import pytest
import json
import tempfile
import os
from mimo_harness.permissions import (
    Permission, PermissionMode, PermissionRule, PermissionGate,
)


class TestPermissionRule:
    def test_exact_match(self):
        rule = PermissionRule(tool_pattern="read_file", action="allow")
        assert rule.matches("read_file")
        assert not rule.matches("write_file")

    def test_wildcard_match(self):
        rule = PermissionRule(tool_pattern="*", action="allow")
        assert rule.matches("anything")
        assert rule.matches("read_file")

    def test_prefix_match(self):
        rule = PermissionRule(tool_pattern="run_command:npm:*", action="allow")
        assert rule.matches("run_command", "npm test")
        assert rule.matches("run_command", "npm install")
        assert not rule.matches("run_command", "git status")

    def test_context_exact_match(self):
        rule = PermissionRule(tool_pattern="run_command:git status", action="allow")
        assert rule.matches("run_command", "git status")
        assert not rule.matches("run_command", "git log")

    def test_path_scoped_rule_match(self):
        rule = PermissionRule(
            tool_pattern="edit_file",
            action="allow",
            path_pattern="/src/**",
        )
        assert rule.matches("edit_file", "/src/foo.py")
        assert rule.matches("edit_file", "/src/sub/module.py")

    def test_path_scoped_rule_no_match(self):
        rule = PermissionRule(
            tool_pattern="edit_file",
            action="allow",
            path_pattern="/src/**",
        )
        assert not rule.matches("edit_file", "/other/foo.py")
        assert not rule.matches("edit_file", "/etc/passwd")

    def test_path_scoped_with_tilde(self):
        home = os.path.expanduser("~")
        rule = PermissionRule(
            tool_pattern="read_file",
            action="allow",
            path_pattern="~/Documents/**",
        )
        assert rule.matches("read_file", f"{home}/Documents/test.txt")
        assert not rule.matches("read_file", "/other/path.txt")

    def test_path_scoped_gate_integration(self):
        """Path-scoped rules integrate with PermissionGate."""
        gate = PermissionGate(auto_approve=True, rules=[
            PermissionRule("write_file", "allow", path_pattern="/src/**"),
        ])
        # write_file to /src/ should be allowed
        assert gate.check(Permission.WRITE, "write_file(/src/main.py)")
        # write_file outside /src/ falls through to auto-approve
        assert gate.check(Permission.WRITE, "write_file(/tmp/other.py)")


class TestPermissionGate:
    def test_read_always_approved(self):
        gate = PermissionGate()
        assert gate.check(Permission.READ, "read_file(path)")

    def test_write_needs_confirmation_default(self, monkeypatch):
        gate = PermissionGate()
        monkeypatch.setattr("builtins.input", lambda _: "y")
        assert gate.check(Permission.WRITE, "write_file(path)")

    def test_write_denied_by_user(self, monkeypatch):
        gate = PermissionGate()
        monkeypatch.setattr("builtins.input", lambda _: "n")
        assert not gate.check(Permission.WRITE, "write_file(path)")

    def test_auto_approve(self):
        gate = PermissionGate(auto_approve=True)
        assert gate.check(Permission.WRITE, "write_file(path)")

    def test_dry_run_blocks(self):
        gate = PermissionGate(dry_run=True)
        assert not gate.check(Permission.WRITE, "write_file(path)")

    def test_plan_mode_blocks_writes(self):
        gate = PermissionGate(plan_mode=True)
        assert not gate.check(Permission.WRITE, "write_file(path)")
        assert gate.check(Permission.READ, "read_file(path)")

    def test_deny_rule_takes_precedence(self):
        gate = PermissionGate(auto_approve=True)
        gate.rules.append(PermissionRule(
            tool_pattern="write_file", action="deny"
        ))
        assert not gate.check(Permission.WRITE, "write_file(path)")

    def test_allow_rule(self):
        gate = PermissionGate()
        gate.rules.append(PermissionRule(
            tool_pattern="read_file", action="allow"
        ))
        assert gate.check(Permission.READ, "read_file(path)")

    def test_deny_over_allow(self):
        gate = PermissionGate()
        gate.rules.append(PermissionRule(tool_pattern="run_command", action="allow"))
        gate.rules.append(PermissionRule(tool_pattern="run_command", action="deny"))
        assert not gate.check(Permission.WRITE, "run_command(rm -rf /)")

    def test_approval_log(self, monkeypatch):
        gate = PermissionGate(auto_approve=True)
        gate.check(Permission.WRITE, "write_file(path)")
        log = gate.summary()
        assert len(log) == 1
        assert log[0]["result"] == "auto_approved"

    def test_load_rules_from_file(self):
        rules_content = {
            "permissions": {
                "allow": ["read_file", "glob_files"],
                "deny": ["run_command:rm *"],
                "ask": ["write_file"]
            }
        }
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(rules_content, f)
            path = f.name

        try:
            gate = PermissionGate()
            gate.load_rules_from_file(path)
            assert len(gate.rules) == 4
            assert gate.rules[0].action == "allow"
            assert gate.rules[2].action == "deny"
        finally:
            os.unlink(path)

    def test_plan_mode_allows_read(self):
        gate = PermissionGate(plan_mode=True)
        assert gate.check(Permission.READ, "read_file(/etc/passwd)")

    def test_plan_mode_blocks_destructive(self):
        gate = PermissionGate(plan_mode=True)
        assert not gate.check(Permission.DESTRUCTIVE, "run_command(rm -rf /)")


class TestPermissionMode:
    def test_modes(self):
        assert PermissionMode.DEFAULT.value == "default"
        assert PermissionMode.PLAN.value == "plan"
        assert PermissionMode.AUTO.value == "auto"
