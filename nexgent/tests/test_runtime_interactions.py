import threading

from nexgent.runtime.interactions import (
    InteractionBroker,
    InteractionKind,
    InteractionRequest,
)


def test_broker_fails_closed_without_handler():
    broker = InteractionBroker()
    response = broker.request(InteractionRequest(InteractionKind.PERMISSION, "write file"))
    assert response.accepted is False


def test_broker_delivers_request_to_handler():
    broker = InteractionBroker(lambda request: request.resolve(True, "yes"))
    response = broker.request(InteractionRequest(InteractionKind.PERMISSION, "write file"))
    assert response.accepted is True
    assert response.value == "yes"


def test_async_resolution_can_arrive_from_frontend_thread():
    def handler(request):
        threading.Timer(0.01, lambda: request.resolve(True)).start()

    broker = InteractionBroker(handler, timeout=1)
    assert broker.request(InteractionRequest(InteractionKind.PERMISSION, "write")).accepted
