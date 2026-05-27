"""Tests for scheduler_tools.py - session-scoped cron scheduling."""

import json
import time
import threading
from unittest.mock import patch, MagicMock

from mimo_harness.tools import scheduler_tools
from mimo_harness.tools.scheduler_tools import (
    CronJob, Scheduler, _parse_cron_field, _match_cron,
    cron_create, cron_delete, cron_list,
    get_scheduler, set_scheduler, get_tools,
)
from mimo_harness.tools.registry import ToolDef
from mimo_harness.permissions import Permission


class TestParseCronField:
    def test_wildcard(self):
        assert _parse_cron_field("*", 0, 59) == set(range(0, 60))

    def test_step(self):
        assert _parse_cron_field("*/5", 0, 59) == {0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55}

    def test_range(self):
        assert _parse_cron_field("1-5", 0, 59) == {1, 2, 3, 4, 5}

    def test_single_value(self):
        assert _parse_cron_field("30", 0, 59) == {30}

    def test_comma_separated(self):
        result = _parse_cron_field("1,5,10", 0, 59)
        assert result == {1, 5, 10}

    def test_mixed(self):
        result = _parse_cron_field("*/15,45", 0, 59)
        assert 0 in result
        assert 15 in result
        assert 45 in result


class TestMatchCron:
    def test_every_minute(self):
        now = time.struct_time((2026, 5, 26, 14, 30, 0, 0, 146, 0))
        assert _match_cron("* * * * *", now) is True

    def test_specific_minute(self):
        now = time.struct_time((2026, 5, 26, 14, 30, 0, 0, 146, 0))
        assert _match_cron("30 * * * *", now) is True
        assert _match_cron("31 * * * *", now) is False

    def test_step(self):
        now = time.struct_time((2026, 5, 26, 14, 30, 0, 0, 146, 0))
        assert _match_cron("*/15 * * * *", now) is True
        now2 = time.struct_time((2026, 5, 26, 14, 31, 0, 0, 146, 0))
        assert _match_cron("*/15 * * * *", now2) is False

    def test_hour_check(self):
        now = time.struct_time((2026, 5, 26, 9, 0, 0, 0, 146, 0))
        assert _match_cron("0 9 * * *", now) is True
        assert _match_cron("0 10 * * *", now) is False

    def test_invalid_expression(self):
        now = time.struct_time((2026, 5, 26, 14, 30, 0, 0, 146, 0))
        assert _match_cron("invalid", now) is False
        assert _match_cron("* *", now) is False

    def test_day_of_week(self):
        # tm_wday=0 is Monday. Standard cron: 0=Sun, 1=Mon, ..., 6=Sat
        now = time.struct_time((2026, 5, 26, 14, 30, 0, 0, 146, 0))
        assert _match_cron("* * * * 1", now) is True   # 1=Monday
        assert _match_cron("* * * * 0", now) is False  # 0=Sunday, not Monday

    def test_range_in_cron(self):
        now = time.struct_time((2026, 5, 26, 14, 30, 0, 0, 146, 0))
        assert _match_cron("30 9-17 * * *", now) is True
        assert _match_cron("30 1-5 * * *", now) is False


class TestCronJob:
    def test_defaults(self):
        job = CronJob(job_id="test-1", cron_expr="* * * * *", prompt="hello")
        assert job.recurring is True
        assert job.fire_count == 0
        assert job.max_fires == 0
        assert job.last_fired == 0.0

    def test_custom_values(self):
        job = CronJob(
            job_id="test-2", cron_expr="0 9 * * *", prompt="morning",
            recurring=False, fire_count=5, max_fires=10,
        )
        assert job.recurring is False
        assert job.fire_count == 5
        assert job.max_fires == 10


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
        callback = MagicMock()
        s.set_callback(callback)
        s.create_job("* * * * *", "fire me")

        # Mock time to match the cron expression
        now = time.localtime()
        with patch("time.localtime", return_value=now):
            s.check_and_fire()

        # Should have fired since * * * * * matches any time
        # (unless last_fired was < 30s ago, but it's a fresh job)
        jobs = s.list_jobs()
        # Job should still exist (recurring=True)

    def test_check_and_fire_one_shot(self):
        s = Scheduler()
        callback = MagicMock()
        s.set_callback(callback)
        s.create_job("* * * * *", "once", recurring=False)

        now = time.localtime()
        with patch("time.localtime", return_value=now):
            s.check_and_fire()

        # One-shot job should be deleted after firing
        assert len(s.list_jobs()) == 0
        callback.assert_called_once_with("once")

    def test_check_and_fire_no_callback(self):
        s = Scheduler()
        s.create_job("* * * * *", "no callback")
        # Should not raise
        now = time.localtime()
        with patch("time.localtime", return_value=now):
            s.check_and_fire()

    def test_check_and_fire_rate_limit(self):
        """Jobs should not fire if fired in the last 30 seconds."""
        s = Scheduler()
        callback = MagicMock()
        s.set_callback(callback)
        job_id = s.create_job("* * * * *", "rate limited")

        # Set last_fired to now
        with s._lock:
            s._jobs[job_id].last_fired = time.time()

        now = time.localtime()
        with patch("time.localtime", return_value=now):
            s.check_and_fire()

        callback.assert_not_called()

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

        now = time.localtime()
        with patch("time.localtime", return_value=now):
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


class TestSchedulerThreadSafety:
    def test_concurrent_create(self):
        s = Scheduler()
        ids = []
        lock = threading.Lock()

        def create():
            for _ in range(20):
                job_id = s.create_job("* * * * *", "concurrent")
                with lock:
                    ids.append(job_id)

        threads = [threading.Thread(target=create) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(ids) == 100
        assert len(set(ids)) == 100  # All unique

    def test_concurrent_create_and_delete(self):
        s = Scheduler()
        created = []
        lock = threading.Lock()

        def creator():
            for _ in range(10):
                job_id = s.create_job("* * * * *", "test")
                with lock:
                    created.append(job_id)

        def deleter():
            time.sleep(0.01)
            with lock:
                ids = list(created)
            for jid in ids[:5]:
                s.delete_job(jid)

        t1 = threading.Thread(target=creator)
        t2 = threading.Thread(target=deleter)
        t1.start()
        t2.start()
        t1.join()
        t2.join()
        # Should not crash


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
