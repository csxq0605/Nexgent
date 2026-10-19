import threading

from nexgent.gui.runtime_bridge import RuntimeBridge
from nexgent.runtime.interactions import InteractionBroker


class BlockingRuntime:
    def __init__(self):
        self.interaction_broker = InteractionBroker()
        self.event_sink = None
        self.calls = []
        self.guidance = []
        self.abort_calls = 0
        self.close_calls = 0
        self.first_started = threading.Event()
        self.release_first = threading.Event()

    def set_event_sink(self, sink):
        self.event_sink = sink

    def handle_input(self, text):
        self.calls.append(text)
        if len(self.calls) == 1:
            self.first_started.set()
            self.release_first.wait(timeout=3)
        return f"done: {text}"

    def inject_guidance(self, text):
        self.guidance.append(text)

    def abort(self):
        self.abort_calls += 1

    def close(self):
        self.close_calls += 1


def test_bridge_accepts_guidance_and_queues_next_input_while_busy(qtbot):
    runtime = BlockingRuntime()
    bridge = RuntimeBridge(runtime)
    assert bridge.submit("first")
    assert runtime.first_started.wait(timeout=1)

    with qtbot.waitSignal(bridge.guidance_injected, timeout=1000):
        assert bridge.submit("/btw use the safer path")
    assert runtime.guidance == ["use the safer path"]

    with qtbot.waitSignal(bridge.input_queued, timeout=1000):
        assert bridge.submit("second")

    runtime.release_first.set()
    qtbot.waitUntil(lambda: runtime.calls == ["first", "second"], timeout=2000)
    qtbot.waitUntil(lambda: bridge.busy is False, timeout=2000)


def test_abort_clears_pending_inputs_and_queue_full_is_reported(qtbot):
    runtime = BlockingRuntime()
    bridge = RuntimeBridge(runtime)
    assert bridge.submit("first")
    assert runtime.first_started.wait(timeout=1)

    for index in range(20):
        assert bridge.submit(f"queued-{index}")

    with qtbot.waitSignal(bridge.input_rejected, timeout=1000) as rejected:
        assert not bridge.submit("overflow")
    assert rejected.args == ["overflow", "Input queue is full"]

    with qtbot.waitSignal(bridge.queue_cleared, timeout=1000) as cleared:
        bridge.abort()
    assert cleared.args == [20]
    runtime.release_first.set()
    qtbot.waitUntil(lambda: bridge.busy is False, timeout=2000)
    assert runtime.calls == ["first"]


def test_quit_command_requests_window_exit(qtbot):
    class ExitRuntime(BlockingRuntime):
        last_command_action = "continue"

        def handle_input(self, text):
            self.calls.append(text)
            self.last_command_action = "quit"
            return "Bye!"

    bridge = RuntimeBridge(ExitRuntime())
    with qtbot.waitSignal(bridge.exit_requested, timeout=1000):
        assert bridge.submit("/quit")


def test_close_detaches_late_worker_events_and_aborts_runtime(qtbot):
    runtime = BlockingRuntime()
    bridge = RuntimeBridge(runtime)
    finished = []
    bridge.run_finished.connect(finished.append)
    assert bridge.submit("slow")
    assert runtime.first_started.wait(timeout=1)

    assert bridge.close(timeout=0.01) is False
    assert runtime.event_sink is None
    assert runtime.abort_calls == 1
    assert runtime.close_calls == 1

    runtime.release_first.set()
    qtbot.waitUntil(lambda: bridge.busy is False, timeout=2000)
    assert finished == []
