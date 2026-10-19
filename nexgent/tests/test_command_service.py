from nexgent.command_service import CommandService
from nexgent.context import Session
from nexgent.memory import MemoryStore


class Harness:
    pass


def test_command_service_wraps_existing_dispatcher(monkeypatch, tmp_path, capsys):
    seen = {}

    def dispatch(parts, harness, session, memory_store, checkpoint_manager, session_dir):
        seen["parts"] = parts
        print("command output")
        return "continue", session

    monkeypatch.setattr("nexgent.cli._handle_command", dispatch)
    session = Session(session_id="session")
    service = CommandService(Harness(), session, MemoryStore(str(tmp_path)))
    result = service.execute("/tasks list")
    assert seen["parts"] == ["/tasks", "list"]
    assert result.output.strip() == "command output"
    assert result.session is session
    assert "command output" in capsys.readouterr().out
