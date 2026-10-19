import json

from nexgent.agent import NexgentAgent
from nexgent.runtime.interactions import InteractionBroker


def test_plan_approval_uses_frontend_broker(monkeypatch):
    monkeypatch.setenv("NEXGENT_API_KEY", "test")
    harness = NexgentAgent()
    harness.interaction_broker = InteractionBroker(lambda request: request.resolve(True, 0))
    result = json.loads(harness._handle_plan_approval({"summary": "Ready", "plan": "Do it"}))
    assert result["decision"] == "approved"
