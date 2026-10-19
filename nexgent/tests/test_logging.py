"""Tests for structured logging (TraceLogger)."""

import os
import re
import logging
import pytest
from nexgent.logging_utils import TraceLogger


@pytest.fixture(autouse=True)
def clean_logger():
    """Ensure the nexgent logger is clean before each test."""
    logger = logging.getLogger("nexgent")
    logger.handlers.clear()
    yield
    logger.handlers.clear()


class TestTraceLogger:
    def test_trace_logger_init(self):
        logger = TraceLogger()
        assert len(logger.session_id) == 8
        assert logger.step == 0

    def test_trace_logger_session_id_format(self):
        logger = TraceLogger()
        # 8 hex chars = 4 bytes = secrets.token_hex(4)
        assert re.match(r'^[0-9a-f]{8}$', logger.session_id)

    def test_trace_logger_info(self, caplog):
        logger = TraceLogger()
        with caplog.at_level(logging.DEBUG, logger="nexgent"):
            logger.info("test info message")
        assert "test info message" in caplog.text

    def test_trace_logger_error(self, caplog):
        logger = TraceLogger()
        exc = ValueError("test error")
        with caplog.at_level(logging.DEBUG, logger="nexgent"):
            logger.error("something failed", exc=exc)
        assert "something failed" in caplog.text

    def test_trace_logger_trace(self, caplog):
        logger = TraceLogger()
        with caplog.at_level(logging.DEBUG, logger="nexgent"):
            logger.trace("test_event", {"key": "value"})
        assert "[TRACE]" in caplog.text
        assert "test_event" in caplog.text
        assert "key" in caplog.text
        assert logger.step == 1

    def test_trace_logger_tool_call(self, caplog):
        logger = TraceLogger()
        with caplog.at_level(logging.DEBUG, logger="nexgent"):
            logger.tool_call("read_file", {"path": "/tmp/test"}, result="hello world")
        assert "tool_call" in caplog.text
        assert "read_file" in caplog.text
        assert "result_len" in caplog.text

    def test_trace_logger_session_summary(self, caplog):
        logger = TraceLogger()
        with caplog.at_level(logging.DEBUG, logger="nexgent"):
            logger.session_summary({"steps": 3, "duration": 1.5})
        assert "session_complete" in caplog.text
        assert "steps" in caplog.text

    def test_trace_logger_step_increment(self):
        logger = TraceLogger()
        assert logger.step == 0
        logger.trace("event1")
        assert logger.step == 1
        logger.trace("event2")
        assert logger.step == 2
        logger.trace("event3")
        assert logger.step == 3

    def test_trace_logger_with_log_file(self, tmp_path):
        log_file = str(tmp_path / "test.log")
        logger = TraceLogger(log_file=log_file)
        # The file handler should be created
        file_handlers = [h for h in logger.logger.handlers if isinstance(h, logging.FileHandler)]
        assert len(file_handlers) >= 1
        # Write something and check the file
        logger.info("log to file")
        logger.trace("file_event")
        # Flush handlers
        for h in logger.logger.handlers:
            h.flush()
        assert os.path.exists(log_file)
        with open(log_file, "r", encoding="utf-8") as f:
            content = f.read()
        assert "log to file" in content
        assert "file_event" in content

    def test_trace_logger_verbose(self):
        logger = TraceLogger(verbose=True)
        for handler in logger.logger.handlers:
            if isinstance(handler, logging.StreamHandler) and not isinstance(handler, logging.FileHandler):
                assert handler.level == logging.DEBUG
                break
        else:
            pytest.fail("No stream handler found")

    def test_trace_logger_non_verbose(self):
        logger = TraceLogger(verbose=False)
        for handler in logger.logger.handlers:
            if isinstance(handler, logging.StreamHandler) and not isinstance(handler, logging.FileHandler):
                assert handler.level == logging.INFO
                break
        else:
            pytest.fail("No stream handler found")
