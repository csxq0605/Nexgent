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
import re
import fnmatch
import platform
from enum import Enum
from datetime import datetime
from dataclasses import dataclass, field
from typing import Optional

from .security_pipeline import classify_action, SafetyDecision


class Permission(Enum):
    READ = "read"
    WRITE = "write"
    DESTRUCTIVE = "destructive"


class PermissionMode(Enum):
    DEFAULT = "default"    # Every write needs confirmation
    PLAN = "plan"          # Read-only, no writes allowed
    AUTO = "auto"          # Auto-approve safe operations
    ACCEPT_EDITS = "accept_edits"  # Reads + file edits auto-approved, shell still asks
    DONT_ASK = "dont_ask"  # Only pre-approved tools, auto-deny rest
    BYPASS = "bypass"      # Everything allowed (circuit breaker only for rm -rf /)


# S4: Protected directories and files that cannot be written to
PROTECTED_DIRS = {".git", ".vscode", ".idea", ".husky", ".claude", ".mimo"}
PROTECTED_FILES = {".gitconfig", ".gitmodules", ".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".env"}


def _is_protected_path(path: str) -> bool:
    """S4: Check if any component of the path matches protected dirs/files."""
    # Resolve symlinks and normalize — prevents symlink bypass attacks
    normalized = os.path.realpath(path)
    # L9: On Windows, also normalize case for consistent comparison
    if platform.system() == "Windows":
        normalized = os.path.normcase(normalized)
    components = normalized.split(os.sep)
    filename = os.path.basename(normalized)

    # Check if filename matches protected files
    if filename in PROTECTED_FILES:
        return True

    # Check if any directory component matches protected dirs
    for component in components:
        if component in PROTECTED_DIRS:
            return True

    return False


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
        - Word boundary: "run_command:npm run test *" (space before * = word boundary)
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
                # Check for word boundary: "npm run test *" matches "npm run test -v"
                # but NOT "npm run testing" — the space before * enforces word boundary
                if prefix.endswith(" "):
                    # Word boundary match: context must start with prefix,
                    # and the next char (if any) must be a word boundary
                    prefix_stripped = prefix.rstrip()
                    if context.startswith(prefix_stripped):
                        rest = context[len(prefix_stripped):]
                        if not rest or rest[0] in " \t\n|;&(":
                            tool_match = True
                    else:
                        tool_match = False
                else:
                    # Simple prefix match (no word boundary)
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

    # File tools that are auto-approved in ACCEPT_EDITS mode
    _FILE_TOOLS = {"read_file", "write_file", "edit_file", "glob_files", "grep_files"}

    def check(self, permission: Permission, action_desc: str, params: dict = None) -> bool:
        """Full 4-stage permission check.

        Returns True if allowed, False if denied.
        """
        # Extract tool name from action description
        tool_name = action_desc.split("(")[0] if "(" in action_desc else action_desc

        # Stage 1: Plan mode blocks all writes (Ch4: plan mode)
        if self.mode == PermissionMode.PLAN:
            if permission in (Permission.WRITE, Permission.DESTRUCTIVE):
                self._log(permission, action_desc, "denied_plan_mode")
                print(f"  [PLAN MODE] Write blocked: {action_desc}")
                return False

        # S4: Protected path check - block writes to protected dirs/files
        # BYPASS mode still protects critical credential/shell files
        if permission in (Permission.WRITE, Permission.DESTRUCTIVE):
            # C2: Use params-based check when available, fallback to string parsing
            is_protected = False
            if params:
                is_protected = self._has_protected_path_from_params(tool_name, params)
            else:
                is_protected = self._has_protected_path(action_desc)
            if is_protected:
                # BYPASS mode still blocks writes to .env, .bashrc, .git etc.
                self._log(permission, action_desc, "denied_protected_path")
                print(f"  [PROTECTED PATH] Write blocked: {action_desc}")
                return False

        # Security Pipeline: hard_deny always blocks (even in BYPASS mode)
        command = ""
        if params:
            command = params.get("command", "")
        classification = classify_action(
            tool_name=tool_name,
            tool_args=params or {},
            command=command,
            working_dir=os.getcwd(),
        )
        if classification.decision == SafetyDecision.HARD_DENY:
            self._log(permission, action_desc, "denied_security_pipeline")
            print(f"  [SECURITY] Blocked: {classification.reason}")
            return False

        # BYPASS mode: approve everything except dangerous rm -rf patterns
        if self.mode == PermissionMode.BYPASS:
            if self._is_dangerous_rm(action_desc):
                self._log(permission, action_desc, "denied_circuit_breaker")
                print(f"  [BYPASS BLOCKED] Dangerous command blocked: {action_desc}")
                return False
            self._log(permission, action_desc, "bypass_approved")
            return True

        # DONT_ASK mode: only pre-approved tools, deny rest without prompting
        if self.mode == PermissionMode.DONT_ASK:
            context = action_desc.split("(", 1)[1].rstrip(")") if "(" in action_desc else ""
            rule_result = self._match_rules(permission, tool_name, context)
            if rule_result == "allow":
                self._log(permission, action_desc, "allowed_by_rule")
                return True
            self._log(permission, action_desc, "denied_dont_ask")
            return False

        # ACCEPT_EDITS mode: auto-approve READ + file tool writes, ask for shell/destructive
        if self.mode == PermissionMode.ACCEPT_EDITS:
            if permission == Permission.READ:
                self._log(permission, action_desc, "auto_approved")
                return True
            if permission == Permission.WRITE and tool_name in self._FILE_TOOLS:
                self._log(permission, action_desc, "accept_edits_approved")
                return True
            # Shell/destructive: fall through to interactive prompt

        # READ is always auto-approved (Ch4: safe tool allowlist)
        if permission == Permission.READ:
            self._log(permission, action_desc, "auto_approved")
            return True

        # Stage 2: Rule matching
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

    def _is_dangerous_rm(self, action_desc: str) -> bool:
        """H2: Check for dangerous destructive patterns (circuit breaker for BYPASS mode)."""
        import re
        patterns = [
            r'\brm\s+.*-[^\s]*r[^\s]*f[^\s]*\s+/(?:\s|\)|$)', r'\brm\s+.*-[^\s]*r[^\s]*f[^\s]*\s+~',
            r'\brm\s+.*-[^\s]*r[^\s]*f[^\s]*\s+\*', r'\brm\s+.*-[^\s]*r[^\s]*f[^\s]*\s+\.',
            r'\brm\s+.*--recursive\s+.*--force', r'\brm\s+.*--force\s+.*--recursive',
            r'\brm\s+.*--recursive\b.*-[^\s]*f', r'\brm\s+.*-[^\s]*r\b.*--force\b',
            r'\bmkfs\b', r'\bdd\s+if=.*of=/dev/',
            r'\bchmod\s+.*-R\s+777\s+/',
            r'(?:^|[;&|]\s*)(?:sudo\s+)?shutdown\b', r'(?:^|[;&|]\s*)(?:sudo\s+)?reboot\b', r'(?:^|[;&|]\s*)(?:sudo\s+)?halt\b',
            r':\(\)\s*\{.*:\|:.*\}',  # fork bomb
        ]
        for pat in patterns:
            if re.search(pat, action_desc, re.IGNORECASE):
                return True
        return False

    def _has_protected_path_from_params(self, tool_name: str, params: dict) -> bool:
        """C2: Check if params contain a path matching protected dirs/files."""
        path = params.get("path", params.get("file_path", ""))
        if path and _is_protected_path(path):
            return True
        command = params.get("command", "")
        if command:
            # Extract shell redirection targets (>, >>) and check them
            import re as _re
            redirects = _re.findall(r'>+\s*([^\s;|&]+)', command)
            for target in redirects:
                if _is_protected_path(target):
                    return True
            # Also check arguments that look like file paths to protected files
            # (e.g., echo x .env, cp file .env)
            parts = command.split()
            for part in parts[1:]:  # skip the command name
                if _is_protected_path(part):
                    return True
        return False

    def _has_protected_path(self, action_desc: str) -> bool:
        """S4: Fallback check using action_desc string parsing."""
        import re
        path_matches = re.findall(r'path=([^,\s\)]+)', action_desc)
        for path in path_matches:
            path = path.strip('"').strip("'")
            if _is_protected_path(path):
                return True
        return False

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

    @staticmethod
    def _redact(desc: str) -> str:
        """Redact potentially sensitive paths and tokens from log entries."""
        # Mask file paths that look like absolute paths
        desc = re.sub(r'(?:[A-Za-z]:)?(?:/|\\)[^\s,;\)]{10,}', '[REDACTED_PATH]', desc)
        # Mask tokens/keys/secrets in args
        desc = re.sub(r'(?i)(token|key|secret|password|auth)[=:]\s*\S+', r'\1=[REDACTED]', desc)
        return desc

    def _log(self, perm: Permission, desc: str, result: str):
        self.approval_log.append({
            "timestamp": datetime.now().isoformat(),
            "permission": perm.value,
            "action": self._redact(desc),
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
