import json

from nexgent.runtime.interactions import InteractionBroker
from nexgent.tools.interactive import ask_user_question, set_interaction_broker


def test_agent_question_uses_frontend_broker():
    def handler(request):
        request.resolve(True, 1)

    set_interaction_broker(InteractionBroker(handler))
    try:
        result = json.loads(ask_user_question({
            "question": "Choose",
            "options": [{"label": "A"}, {"label": "B"}],
        }))
    finally:
        set_interaction_broker(None)
    assert result["selected"]["label"] == "B"
