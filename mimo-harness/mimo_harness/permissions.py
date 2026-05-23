"""Permission gate - tiered access control for tool execution."""

from enum import Enum
from datetime import datetime


class Permission(Enum):
    READ = "read"
    WRITE = "write"
    DESTRUCTIVE = "destructive"


class PermissionGate:
    def __init__(self, auto_approve: bool = False, dry_run: bool = False):
        self.auto_approve = auto_approve
        self.dry_run = dry_run
        self.approval_log: list[dict] = []

    def check(self, permission: Permission, action_desc: str) -> bool:
        if permission == Permission.READ:
            self._log(permission, action_desc, "auto_approved")
            return True

        if self.dry_run:
            self._log(permission, action_desc, "dry_run_skip")
            print(f"  [DRY-RUN] Would: {action_desc}")
            return False

        if self.auto_approve:
            self._log(permission, action_desc, "auto_approved")
            return True

        # Interactive confirmation
        print(f"\n  [CONFIRM] {action_desc}")
        print(f"  Permission: {permission.value}")
        try:
            response = input("  Allow? (y/n): ").strip().lower()
        except (EOFError, KeyboardInterrupt):
            self._log(permission, action_desc, "denied_no_input")
            return False
        approved = response in ("y", "yes")
        self._log(permission, action_desc, "approved" if approved else "denied")
        return approved

    def _log(self, perm: Permission, desc: str, result: str):
        self.approval_log.append({
            "timestamp": datetime.now().isoformat(),
            "permission": perm.value,
            "action": desc,
            "result": result,
        })

    def summary(self) -> list[dict]:
        return self.approval_log
