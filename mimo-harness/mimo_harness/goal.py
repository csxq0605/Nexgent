"""Goal system - keep Claude working toward a completion condition.

Implements Claude Code-style /goal command:
- Set a completion condition
- Evaluate after each turn
- Continue working until condition is met
"""

import os
import time
import json
import threading
from dataclasses import dataclass, field
from typing import Optional, Dict, Any, Callable
from pathlib import Path


@dataclass
class GoalState:
    """Goal state tracking."""
    condition: str
    start_time: float = 0.0
    turns_evaluated: int = 0
    tokens_spent: int = 0
    last_reason: str = ""
    is_active: bool = True
    is_achieved: bool = False


class GoalManager:
    """Manage goals for sessions."""

    def __init__(self):
        self.goal: Optional[GoalState] = None
        self._lock = threading.Lock()

    def set_goal(self, condition: str) -> None:
        """Set a new goal."""
        with self._lock:
            self.goal = GoalState(
                condition=condition,
                start_time=time.time(),
            )

    def get_goal(self) -> Optional[GoalState]:
        """Get the current goal."""
        return self.goal

    def clear_goal(self) -> None:
        """Clear the current goal."""
        with self._lock:
            if self.goal:
                self.goal.is_active = False
            self.goal = None

    def mark_achieved(self, reason: str = "") -> None:
        """Mark the goal as achieved."""
        with self._lock:
            if self.goal:
                self.goal.is_achieved = True
                self.goal.is_active = False
                self.goal.last_reason = reason

    def increment_turn(self, tokens: int = 0) -> None:
        """Increment turn counter."""
        with self._lock:
            if self.goal:
                self.goal.turns_evaluated += 1
                self.goal.tokens_spent += tokens

    def update_reason(self, reason: str) -> None:
        """Update the last evaluation reason."""
        with self._lock:
            if self.goal:
                self.goal.last_reason = reason

    def get_duration(self) -> float:
        """Get goal duration in seconds."""
        if not self.goal or self.goal.start_time == 0:
            return 0
        return time.time() - self.goal.start_time

    def get_status(self) -> Dict[str, Any]:
        """Get goal status as dictionary."""
        if not self.goal:
            return {'active': False}

        return {
            'active': self.goal.is_active,
            'achieved': self.goal.is_achieved,
            'condition': self.goal.condition,
            'duration': self.get_duration(),
            'turns': self.goal.turns_evaluated,
            'tokens': self.goal.tokens_spent,
            'reason': self.goal.last_reason,
        }


class GoalEvaluator:
    """Evaluate whether a goal condition is met.

    This is a simple evaluator that checks for keywords in the conversation.
    In a full implementation, this would use a fast model to evaluate the condition.
    """

    @classmethod
    def evaluate(cls, condition: str, conversation: str) -> tuple[bool, str]:
        """Evaluate whether the goal condition is met.

        Args:
            condition: The goal condition
            conversation: Recent conversation text

        Returns:
            (is_met, reason) tuple
        """
        condition_lower = condition.lower()
        conversation_lower = conversation.lower()

        # Simple keyword-based evaluation
        # In production, this would use a fast model like Haiku

        # Check for test-related conditions
        if 'test' in condition_lower and 'pass' in condition_lower:
            if 'all tests passed' in conversation_lower or 'passed' in conversation_lower:
                return True, "Tests appear to be passing"
            if 'failed' in conversation_lower or 'error' in conversation_lower:
                return False, "Tests still failing"

        # Check for build-related conditions
        if 'build' in condition_lower and ('success' in condition_lower or 'pass' in condition_lower):
            if 'build successful' in conversation_lower or 'build complete' in conversation_lower:
                return True, "Build appears successful"
            if 'build failed' in conversation_lower:
                return False, "Build still failing"

        # Check for completion keywords
        if 'done' in condition_lower or 'complete' in condition_lower:
            if 'task complete' in conversation_lower or 'done' in conversation_lower:
                return True, "Task appears complete"

        # Default: not met
        return False, "Condition not yet met"


# Global goal manager instances per session
_goal_managers: Dict[str, GoalManager] = {}
_goal_lock = threading.Lock()


def get_goal_manager(session_id: str = 'default') -> GoalManager:
    """Get or create a goal manager for a session."""
    with _goal_lock:
        if session_id not in _goal_managers:
            _goal_managers[session_id] = GoalManager()
        return _goal_managers[session_id]


def clear_goal_manager(session_id: str = 'default') -> None:
    """Clear a goal manager for a session."""
    with _goal_lock:
        if session_id in _goal_managers:
            del _goal_managers[session_id]
