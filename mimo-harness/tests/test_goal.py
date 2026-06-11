"""Tests for the Goal module."""

import os
import time
import pytest
from unittest.mock import patch, MagicMock

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from mimo_harness.goal import (
    GoalManager, GoalState, GoalEvaluator, get_goal_manager, clear_goal_manager
)


class TestGoalManager:
    """Test goal management."""

    def test_set_goal(self):
        """Test setting a goal."""
        manager = GoalManager()
        manager.set_goal("all tests pass")

        goal = manager.get_goal()
        assert goal is not None
        assert goal.condition == "all tests pass"
        assert goal.is_active is True
        assert goal.is_achieved is False

    def test_clear_goal(self):
        """Test clearing a goal."""
        manager = GoalManager()
        manager.set_goal("test condition")
        manager.clear_goal()

        goal = manager.get_goal()
        assert goal is None

    def test_mark_achieved(self):
        """Test marking a goal as achieved."""
        manager = GoalManager()
        manager.set_goal("test condition")
        manager.mark_achieved("Tests passed")

        goal = manager.get_goal()
        assert goal.is_achieved is True
        assert goal.is_active is False
        assert goal.last_reason == "Tests passed"

    def test_increment_turn(self):
        """Test incrementing turn counter."""
        manager = GoalManager()
        manager.set_goal("test condition")
        manager.increment_turn(100)
        manager.increment_turn(200)

        goal = manager.get_goal()
        assert goal.turns_evaluated == 2
        assert goal.tokens_spent == 300

    def test_update_reason(self):
        """Test updating reason."""
        manager = GoalManager()
        manager.set_goal("test condition")
        manager.update_reason("Working on it")

        goal = manager.get_goal()
        assert goal.last_reason == "Working on it"

    def test_get_duration(self):
        """Test getting duration."""
        manager = GoalManager()
        manager.set_goal("test condition")
        time.sleep(0.1)

        duration = manager.get_duration()
        assert duration >= 0.1

    def test_get_status_active(self):
        """Test getting status for active goal."""
        manager = GoalManager()
        manager.set_goal("test condition")
        manager.increment_turn(100)
        manager.update_reason("Working")

        status = manager.get_status()
        assert status['active'] is True
        assert status['achieved'] is False
        assert status['condition'] == "test condition"
        assert status['turns'] == 1
        assert status['tokens'] == 100
        assert status['reason'] == "Working"

    def test_get_status_achieved(self):
        """Test getting status for achieved goal."""
        manager = GoalManager()
        manager.set_goal("test condition")
        manager.mark_achieved("Done")

        status = manager.get_status()
        assert status['active'] is False
        assert status['achieved'] is True

    def test_get_status_no_goal(self):
        """Test getting status when no goal."""
        manager = GoalManager()
        status = manager.get_status()
        assert status['active'] is False


class TestGoalEvaluator:
    """Test goal evaluation."""

    def test_evaluate_tests_passing(self):
        """Test evaluating test-related goal."""
        is_met, reason = GoalEvaluator.evaluate(
            "all tests pass",
            "Running tests... all tests passed"
        )
        assert is_met is True
        assert "Tests appear to be passing" in reason

    def test_evaluate_tests_failing(self):
        """Test evaluating test-related goal with failures."""
        is_met, reason = GoalEvaluator.evaluate(
            "all tests pass",
            "Running tests... 3 tests failed"
        )
        assert is_met is False
        assert "Tests still failing" in reason

    def test_evaluate_build_success(self):
        """Test evaluating build-related goal."""
        is_met, reason = GoalEvaluator.evaluate(
            "build success",
            "Building... build successful"
        )
        assert is_met is True
        assert "Build appears successful" in reason

    def test_evaluate_build_failed(self):
        """Test evaluating build-related goal with failure."""
        is_met, reason = GoalEvaluator.evaluate(
            "build success",
            "Building... build failed"
        )
        assert is_met is False
        assert "Build still failing" in reason

    def test_evaluate_completion(self):
        """Test evaluating completion-related goal."""
        is_met, reason = GoalEvaluator.evaluate(
            "task done",
            "Working... task complete"
        )
        assert is_met is True
        assert "Task appears complete" in reason

    def test_evaluate_not_met(self):
        """Test evaluating goal not yet met."""
        is_met, reason = GoalEvaluator.evaluate(
            "all tests pass",
            "Still working..."
        )
        assert is_met is False
        assert "Condition not yet met" in reason


class TestGetGoalManager:
    """Test global goal manager."""

    def test_get_manager(self):
        """Test getting goal manager."""
        manager = get_goal_manager("test-session")
        assert manager is not None
        assert isinstance(manager, GoalManager)

    def test_get_same_manager(self):
        """Test getting same manager for same session."""
        manager1 = get_goal_manager("test-session")
        manager2 = get_goal_manager("test-session")
        assert manager1 is manager2

    def test_clear_manager(self):
        """Test clearing goal manager."""
        manager = get_goal_manager("test-session")
        manager.set_goal("test")
        clear_goal_manager("test-session")

        # Should be a new manager
        new_manager = get_goal_manager("test-session")
        assert new_manager.get_goal() is None


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
