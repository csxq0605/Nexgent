"""Tests for the permission pipeline (Ch4 patterns)."""

import pytest
import json
import tempfile
import os
from mimo_harness.permissions import (
    Permission, PermissionRule, PermissionGate,
)
from mimo_harness.security_pipeline import SafetyDecision, ClassificationResult, ReviewResult


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

    def test_dry_run_blocks_read(self):
        """Dry-run should block ALL operations including READ."""
        gate = PermissionGate(dry_run=True)
        assert not gate.check(Permission.READ, "read_file(path)")

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

    def test_check_bypass_mode_allows(self):
        """BYPASS mode auto-approves non-dangerous actions."""
        gate = PermissionGate(auto_approve=True)
        from mimo_harness.permissions import PermissionMode
        gate.mode = PermissionMode.BYPASS
        assert gate.check(Permission.WRITE, "write_file(path)")

    def test_check_bypass_mode_blocks_dangerous_rm(self):
        """BYPASS mode blocks dangerous rm commands."""
        gate = PermissionGate(auto_approve=True)
        from mimo_harness.permissions import PermissionMode
        gate.mode = PermissionMode.BYPASS
        assert not gate.check(Permission.WRITE, "run_command(rm -rf /)")

    def test_check_dont_ask_mode_allow(self):
        """DONT_ASK mode with matching allow rule."""
        gate = PermissionGate()
        from mimo_harness.permissions import PermissionMode
        gate.mode = PermissionMode.DONT_ASK
        gate.rules.append(PermissionRule(tool_pattern="write_file", action="allow"))
        assert gate.check(Permission.WRITE, "write_file(path)")

    def test_check_dont_ask_mode_no_match_deny(self):
        """DONT_ASK mode with no matching rule denies."""
        gate = PermissionGate()
        from mimo_harness.permissions import PermissionMode
        gate.mode = PermissionMode.DONT_ASK
        assert not gate.check(Permission.WRITE, "write_file(path)")

    def test_check_accept_edits_mode_read(self):
        """ACCEPT_EDITS mode auto-approves READ."""
        gate = PermissionGate()
        from mimo_harness.permissions import PermissionMode
        gate.mode = PermissionMode.ACCEPT_EDITS
        assert gate.check(Permission.READ, "read_file(path)")

    def test_check_accept_edits_mode_write_file(self):
        """ACCEPT_EDITS mode auto-approves write_file."""
        gate = PermissionGate()
        from mimo_harness.permissions import PermissionMode
        gate.mode = PermissionMode.ACCEPT_EDITS
        assert gate.check(Permission.WRITE, "write_file(path)")

    def test_check_accept_edits_mode_other_write(self, monkeypatch):
        """ACCEPT_EDITS mode falls through to interactive for non-file writes."""
        gate = PermissionGate()
        from mimo_harness.permissions import PermissionMode
        gate.mode = PermissionMode.ACCEPT_EDITS
        monkeypatch.setattr("builtins.input", lambda _: "y")
        assert gate.check(Permission.WRITE, "run_command(echo hi)")

    def test_check_rule_matching_allow(self):
        """Rule matching returns allow when rule matches."""
        gate = PermissionGate()
        gate.rules.append(PermissionRule(tool_pattern="read_file", action="allow"))
        # READ is auto-approved anyway, so test with WRITE
        gate.rules.append(PermissionRule(tool_pattern="write_file", action="allow"))
        assert gate.check(Permission.WRITE, "write_file(path)")

    def test_rule_matches_path_pattern(self):
        """PermissionRule with path_pattern matches correctly."""
        rule = PermissionRule(
            tool_pattern="write_file",
            action="allow",
            path_pattern="*.py",
        )
        # _matches_path extracts path from JSON or raw path context
        assert rule.matches("write_file", '{"path": "/tmp/test.py"}')
        assert not rule.matches("write_file", '{"path": "/tmp/test.txt"}')

    def test_check_protected_path_blocks(self):
        """check() blocks writes to protected paths (e.g. .env)."""
        gate = PermissionGate(auto_approve=True)
        assert not gate.check(Permission.WRITE, "write_file(path=.env)")

    def test_check_security_hard_deny(self):
        """check() blocks when security pipeline returns HARD_DENY."""
        gate = PermissionGate(auto_approve=True)
        # Pass params with the actual command for the security pipeline to evaluate
        result = gate.check(
            Permission.WRITE,
            "run_command(rm -rf /)",
            params={"command": "rm -rf /"},
        )
        assert not result

    def test_approval_log_results(self):
        """Approval log records different result types."""
        gate = PermissionGate(auto_approve=True)
        gate.check(Permission.READ, "read_file(path)")
        gate.check(Permission.WRITE, "write_file(path)")
        log = gate.summary()
        assert len(log) == 2
        results = {e["result"] for e in log}
        assert "auto_approved" in results


# =========================================================================
# Model-driven permission features
# =========================================================================

class TestModelDrivenPermissions:
    def test_set_llm_client(self):
        """set_llm_client stores client and model."""
        gate = PermissionGate()
        # Use a simple object to represent a client (no mock needed)
        client = object()
        gate.set_llm_client(client, "test-model")
        assert gate._llm_client is client
        assert gate._llm_model == "test-model"

    def test_set_permission_mode(self):
        """set_permission_mode updates the mode."""
        gate = PermissionGate()
        gate.set_permission_mode("bypass")
        from mimo_harness.permissions import PermissionMode
        assert gate.mode == PermissionMode.BYPASS

    def test_set_permission_mode_invalid(self):
        """Invalid mode is silently ignored."""
        gate = PermissionGate()
        original_mode = gate.mode
        gate.set_permission_mode("nonexistent_mode")
        assert gate.mode == original_mode

    def test_approval_log_has_reasoning(self):
        """Approval log entries include reasoning and risk_level."""
        gate = PermissionGate(auto_approve=True)
        gate.check(Permission.READ, "read_file(path)")
        log = gate.summary()
        assert "reasoning" in log[0]
        assert "risk_level" in log[0]

    def test_review_log_empty_by_default(self):
        """Review log is empty when no reviews triggered."""
        gate = PermissionGate(auto_approve=True)
        gate.check(Permission.READ, "read_file(path)")
        assert gate.get_review_summary() == []

    def test_security_hard_deny_logged_with_reasoning(self):
        """HARD_DENY entries include reasoning in the log."""
        gate = PermissionGate(auto_approve=True)
        gate.check(
            Permission.WRITE,
            "run_command(rm -rf /)",
            params={"command": "rm -rf /"},
        )
        log = gate.summary()
        # Find the denied entry
        denied = [e for e in log if "denied" in e["result"]]
        assert len(denied) >= 1
        assert denied[0]["reasoning"]  # not empty
        assert denied[0]["risk_level"] == "high"
