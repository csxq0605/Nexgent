"""Tests for scheduler_tools.py - session-scoped cron scheduling."""

import json
import time

from mimo_harness.tools.scheduler_tools import (
    Scheduler,
    cron_create, cron_delete, cron_list,
    set_scheduler, get_tools,
)
from mimo_harness.tools.registry import ToolDef
from mimo_harness.permissions import Permission


class TestScheduler:
    def test_create_job(self):
        s = Scheduler()
        job_id = s.create_job("* * * * *", "test prompt")
        assert job_id == "cron-1"
        jobs = s.list_jobs()
        assert len(jobs) == 1
        assert jobs[0]["cron"] == "* * * * *"

    def test_create_multiple_jobs(self):
        s = Scheduler()
        id1 = s.create_job("* * * * *", "prompt 1")
        id2 = s.create_job("0 9 * * *", "prompt 2")
        assert id1 == "cron-1"
        assert id2 == "cron-2"
        assert len(s.list_jobs()) == 2

    def test_delete_job(self):
        s = Scheduler()
        job_id = s.create_job("* * * * *", "test")
        assert s.delete_job(job_id) is True
        assert len(s.list_jobs()) == 0

    def test_delete_nonexistent(self):
        s = Scheduler()
        assert s.delete_job("cron-999") is False

    def test_list_jobs_empty(self):
        s = Scheduler()
        assert s.list_jobs() == []

    def test_list_jobs_truncates_long_prompt(self):
        s = Scheduler()
        long_prompt = "x" * 200
        s.create_job("* * * * *", long_prompt)
        jobs = s.list_jobs()
        assert len(jobs[0]["prompt"]) <= 83  # 80 + "..."

    def test_check_and_fire(self):
        s = Scheduler()
        fired = []
        s.set_callback(lambda p: fired.append(p))
        s.create_job("* * * * *", "fire me")

        s.check_and_fire()

        # Should have fired since * * * * * matches any time
        assert len(fired) == 1
        assert fired[0] == "fire me"
        # Job should still exist (recurring=True)
        assert len(s.list_jobs()) == 1

    def test_check_and_fire_one_shot(self):
        s = Scheduler()
        fired = []
        s.set_callback(lambda p: fired.append(p))
        s.create_job("* * * * *", "once", recurring=False)

        s.check_and_fire()

        # One-shot job should be deleted after firing
        assert len(s.list_jobs()) == 0
        assert len(fired) == 1
        assert fired[0] == "once"

    def test_check_and_fire_no_callback(self):
        s = Scheduler()
        s.create_job("* * * * *", "no callback")
        # Should not raise
        s.check_and_fire()

    def test_check_and_fire_rate_limit(self):
        """Jobs should not fire if fired in the last 30 seconds."""
        s = Scheduler()
        fired = []
        s.set_callback(lambda p: fired.append(p))
        job_id = s.create_job("* * * * *", "rate limited")

        # Set last_fired to now
        with s._lock:
            s._jobs[job_id].last_fired = time.time()

        s.check_and_fire()

        assert len(fired) == 0

    def test_background_checker(self):
        s = Scheduler()
        s.start_background_checker(interval=0.1)
        assert s._checker_thread is not None
        assert s._checker_thread.is_alive()
        s.stop()
        s._checker_thread.join(timeout=2)
        assert not s._checker_thread.is_alive()

    def test_stop_without_start(self):
        s = Scheduler()
        s.stop()  # Should not raise

    def test_set_callback(self):
        s = Scheduler()
        fn = lambda x: None
        s.set_callback(fn)
        assert s._callback is fn

    def test_callback_exception_swallowed(self):
        s = Scheduler()
        s.set_callback(lambda x: 1 / 0)  # Will raise ZeroDivisionError
        s.create_job("* * * * *", "will crash callback")

        s.check_and_fire()  # Should not propagate exception


class TestCronToolFunctions:
    def setup_method(self):
        self.scheduler = Scheduler()
        set_scheduler(self.scheduler)

    def teardown_method(self):
        set_scheduler(None)

    def test_cron_create(self):
        result = json.loads(cron_create({
            "cron": "*/5 * * * *",
            "prompt": "check status",
        }))
        assert "job_id" in result
        assert result["cron"] == "*/5 * * * *"
        assert result["recurring"] is True

    def test_cron_create_one_shot(self):
        result = json.loads(cron_create({
            "cron": "0 9 * * *",
            "prompt": "morning reminder",
            "recurring": False,
        }))
        assert result["recurring"] is False

    def test_cron_create_no_cron(self):
        result = json.loads(cron_create({"prompt": "test"}))
        assert "error" in result

    def test_cron_create_no_prompt(self):
        result = json.loads(cron_create({"cron": "* * * * *"}))
        assert "error" in result

    def test_cron_create_invalid_cron(self):
        result = json.loads(cron_create({"cron": "invalid", "prompt": "test"}))
        assert "error" in result

    def test_cron_create_no_scheduler(self):
        set_scheduler(None)
        result = json.loads(cron_create({"cron": "* * * * *", "prompt": "test"}))
        assert "error" in result
        set_scheduler(self.scheduler)

    def test_cron_delete(self):
        job_id = self.scheduler.create_job("* * * * *", "test")
        result = json.loads(cron_delete({"job_id": job_id}))
        assert "message" in result

    def test_cron_delete_not_found(self):
        result = json.loads(cron_delete({"job_id": "cron-999"}))
        assert "error" in result

    def test_cron_delete_no_id(self):
        result = json.loads(cron_delete({}))
        assert "error" in result

    def test_cron_delete_no_scheduler(self):
        set_scheduler(None)
        result = json.loads(cron_delete({"job_id": "cron-1"}))
        assert "error" in result
        set_scheduler(self.scheduler)

    def test_cron_list(self):
        self.scheduler.create_job("* * * * *", "test 1")
        self.scheduler.create_job("0 9 * * *", "test 2")
        result = json.loads(cron_list({}))
        assert result["count"] == 2
        assert len(result["jobs"]) == 2

    def test_cron_list_empty(self):
        result = json.loads(cron_list({}))
        assert result["jobs"] == []
        assert "No scheduled jobs" in result.get("message", "")

    def test_cron_list_no_scheduler(self):
        set_scheduler(None)
        result = json.loads(cron_list({}))
        assert "error" in result
        set_scheduler(self.scheduler)


class TestSchedulerToolsGetTools:
    def test_returns_three_tools(self):
        tools = get_tools()
        assert len(tools) == 3

    def test_tool_names(self):
        names = {t.name for t in get_tools()}
        assert names == {"cron_create", "cron_delete", "cron_list"}

    def test_all_tooldefs(self):
        for tool in get_tools():
            assert isinstance(tool, ToolDef)
            assert tool.handler is not None
            assert tool.permission == Permission.READ

    def test_required_params(self):
        tools = {t.name: t for t in get_tools()}
        assert "cron" in tools["cron_create"].parameters["required"]
        assert "prompt" in tools["cron_create"].parameters["required"]
        assert "job_id" in tools["cron_delete"].parameters["required"]
