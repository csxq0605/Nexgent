"""Permission pipeline - 4-stage access control following Claude Code architecture.

Implements Ch4 patterns:
- 4-stage pipeline: validate → rule matching → context evaluation → user prompt
- Rule priority: deny > ask > allow
- Plan mode (read-only operations only)
- Bash command pattern matching (exact, prefix, wildcard)
- Permission rules from configuration
"""

import json
import os
import fnmatch
from enum import Enum
from datetime import datetime
from dataclasses import dataclass, field
from typing import Optional


class Permission(Enum):
    READ = "read"
    WRITE = "write"
    DESTRUCTIVE = "destructive"


class PermissionMode(Enum):
    DEFAULT = "default"    # Every write needs confirmation
    PLAN = "plan"          # Read-only, no writes allowed
    AUTO = "auto"          # Auto-approve safe operations


@dataclass
class PermissionRule:
    """A single permission rule (Ch4: deny > ask > allow)."""
    tool_pattern: str      # e.g. "read_file", "run_command", "run_command:npm:*"
    action: str            # "allow", "deny", "ask"
    source: str = "user"   # "user", "session", "policy"
    path_pattern: Optional[str] = None  # e.g. "~/secrets/**", "/src/**"

    def matches(self, tool_name: str, context: str = "") -> bool:
        """Check if this rule matches a tool call.

        Supports:
        - Exact match: "read_file"
        - Tool wildcard: "run_command:*" (all run_command calls)
        - Prefix match: "run_command:npm:*" (commands starting with npm)
        - Path pattern: if path_pattern is set, also check tool's path argument
        """
        # First check tool pattern match
        tool_match = False
        if ":" in self.tool_pattern:
            # Pattern includes context (e.g., "run_command:npm:*")
            parts = self.tool_pattern.split(":", 1)
            if parts[0] != tool_name:
                return False
            pattern = parts[1]
            if pattern == "*":
                tool_match = True
            # Prefix match with wildcard
            elif pattern.endswith("*"):
                prefix = pattern[:-1].rstrip(":")
                # Match if context starts with prefix
                tool_match = context.startswith(prefix)
            else:
                tool_match = context == pattern
        else:
            # Simple tool name match
            if self.tool_pattern == "*":
                tool_match = True
            else:
                tool_match = self.tool_pattern == tool_name

        if not tool_match:
            return False

        # If path_pattern is set, also check if the tool's path argument matches
        if self.path_pattern:
            return self._matches_path(context)
        return True

    def _matches_path(self, context: str) -> bool:
        """Check if a path in the context matches the path_pattern glob."""
        # Try to extract a path from the context
        # Context can be: a raw path, or JSON like {"path": "/foo/bar", ...}
        path = context
        if context.startswith("{"):
            try:
                args = json.loads(context)
                path = args.get("path", args.get("command", context))
            except (json.JSONDecodeError, AttributeError):
                path = context
        # Expand ~ for home directory
        expanded_pattern = self.path_pattern
        if expanded_pattern.startswith("~"):
            expanded_pattern = os.path.expanduser(expanded_pattern)
        expanded_path = path
        if expanded_path.startswith("~"):
            expanded_path = os.path.expanduser(expanded_path)
        return fnmatch.fnmatch(expanded_path, expanded_pattern)


class PermissionGate:
    """4-stage permission pipeline (Ch4: validate → rules → context → prompt).

    Stages:
    1. validateInput - data legitimacy check
    2. hasPermissionsToUseTool - rule matching (deny > ask > allow)
    3. checkPermissions - tool-specific context evaluation
    4. interactivePrompt - user confirmation (interactive mode only)
    """

    def __init__(
        self,
        auto_approve: bool = False,
        dry_run: bool = False,
        plan_mode: bool = False,
        rules: list[PermissionRule] = None,
    ):
        self.auto_approve = auto_approve
        self.dry_run = dry_run
        self.mode = PermissionMode.PLAN if plan_mode else (
            PermissionMode.AUTO if auto_approve else PermissionMode.DEFAULT
        )
        self.approval_log: list[dict] = []
        self.rules: list[PermissionRule] = rules or []
        self._rejection_count = 0  # Ch4: circuit breaker for rejections

    def add_rule(self, rule: PermissionRule):
        self.rules.append(rule)

    def add_rules(self, rules: list[PermissionRule]):
        self.rules.extend(rules)

    def _match_rules(
        self, permission: Permission, tool_name: str, context: str = ""
    ) -> Optional[str]:
        """Stage 2: Match rules in priority order (deny > ask > allow).

        Returns: "deny", "allow", "ask", or None (no match).
        """
        # Ch4: deny always takes precedence
        for rule in self.rules:
            if rule.action == "deny" and rule.matches(tool_name, context):
                return "deny"

        for rule in self.rules:
            if rule.action == "ask" and rule.matches(tool_name, context):
                return "ask"

        for rule in self.rules:
            if rule.action == "allow" and rule.matches(tool_name, context):
                return "allow"

        return None

    def check(self, permission: Permission, action_desc: str) -> bool:
        """Full 4-stage permission check.

        Returns True if allowed, False if denied.
        """
        # Stage 1: Plan mode blocks all writes (Ch4: plan mode)
        if self.mode == PermissionMode.PLAN:
            if permission in (Permission.WRITE, Permission.DESTRUCTIVE):
                self._log(permission, action_desc, "denied_plan_mode")
                print(f"  [PLAN MODE] Write blocked: {action_desc}")
                return False

        # READ is always auto-approved (Ch4: safe tool allowlist)
        if permission == Permission.READ:
            self._log(permission, action_desc, "auto_approved")
            return True

        # Stage 2: Rule matching
        tool_name = action_desc.split("(")[0] if "(" in action_desc else action_desc
        context = action_desc.split("(", 1)[1].rstrip(")") if "(" in action_desc else ""
        rule_result = self._match_rules(permission, tool_name, context)

        if rule_result == "deny":
            self._log(permission, action_desc, "denied_by_rule")
            return False
        if rule_result == "allow":
            self._log(permission, action_desc, "allowed_by_rule")
            return True

        # Dry-run mode
        if self.dry_run:
            self._log(permission, action_desc, "dry_run_skip")
            print(f"  [DRY-RUN] Would: {action_desc}")
            return False

        # Auto-approve mode (Ch4: auto mode with safe tool allowlist)
        if self.auto_approve or self.mode == PermissionMode.AUTO:
            # Ch4: rejection tracking - fallback to interactive after rejections
            if self._rejection_count >= 3:
                pass  # Fall through to interactive prompt
            else:
                self._log(permission, action_desc, "auto_approved")
                return True

        # Stage 4: Interactive confirmation
        return self._interactive_confirm(permission, action_desc)

    def _interactive_confirm(
        self, permission: Permission, action_desc: str
    ) -> bool:
        """Stage 4: Interactive user confirmation."""
        print(f"\n  [CONFIRM] {action_desc}")
        print(f"  Permission: {permission.value}")
        try:
            response = input("  Allow? (y/n): ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            self._log(permission, action_desc, "denied_no_input")
            return False
        approved = response in ("y", "yes")
        if not approved:
            self._rejection_count += 1
        else:
            self._rejection_count = 0
        self._log(
            permission, action_desc, "approved" if approved else "denied"
        )
        return approved

    def _log(self, perm: Permission, desc: str, result: str):
        self.approval_log.append({
            "timestamp": datetime.now().isoformat(),
            "permission": perm.value,
            "action": desc,
            "result": result,
            "mode": self.mode.value,
        })

    def summary(self) -> list[dict]:
        return self.approval_log

    def load_rules_from_file(self, path: str):
        """Load permission rules from a JSON config file.

        Expected format:
        {
            "permissions": {
                "allow": ["read_file", "glob_files", "run_command:git:*"],
                "deny": ["run_command:rm -rf *"],
                "ask": ["write_file", "edit_file"]
            }
        }
        """
        try:
            with open(path, "r", encoding="utf-8") as f:
                config = json.load(f)

            perms = config.get("permissions", {})
            for action in ("allow", "deny", "ask"):
                for pattern in perms.get(action, []):
                    self.rules.append(PermissionRule(
                        tool_pattern=pattern,
                        action=action,
                        source="config",
                    ))
        except FileNotFoundError:
            pass
        except Exception as e:
            print(f"Warning: Failed to load permission rules from {path}: {e}")
