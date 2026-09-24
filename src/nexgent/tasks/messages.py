"""Typed, receiver-specific messages carried by workflow data edges."""

from __future__ import annotations

from copy import deepcopy
import re

from ..kernel.programs import digest
from .tools import check_contract_schema, validate


AGENT_MESSAGE_SCHEMA = "nexgent.agent-message.v1"
_TOPIC = re.compile(r"[A-Za-z][A-Za-z0-9_.-]{0,119}")


class AgentMessageError(ValueError):
    pass


def validate_message_contract(contract) -> dict:
    """Return an isolated, validated message-edge contract.

    Sender and receiver are deliberately absent: graph endpoints are the
    authority for those identities, so a generated graph cannot put a message
    into one node while claiming it was addressed to another.
    """
    if not isinstance(contract, dict) or set(contract) != {"topic", "payload_schema"}:
        raise AgentMessageError(
            "Message contracts need exactly topic and payload_schema"
        )
    topic = contract["topic"]
    if not isinstance(topic, str) or _TOPIC.fullmatch(topic) is None:
        raise AgentMessageError("Message topics must be bounded safe identifiers")
    try:
        check_contract_schema(contract["payload_schema"])
    except Exception as exc:
        raise AgentMessageError(f"Message payload schema is invalid: {str(exc)[:800]}") from None
    return deepcopy(contract)


def message_schema_ref(contract) -> str:
    """Content identity used by both ports of a typed message edge."""
    checked = validate_message_contract(contract)
    return "schema://nexgent.agent-message.v1/" + digest(checked)


def make_agent_message(*, sender_node_id, recipient_node_id, contract, payload) -> dict:
    """Validate payload and construct a deterministic addressed envelope."""
    checked = validate_message_contract(contract)
    if (not isinstance(sender_node_id, str) or not sender_node_id
            or not isinstance(recipient_node_id, str) or not recipient_node_id):
        raise AgentMessageError("Message endpoints must be nonempty node identifiers")
    try:
        validate(
            payload,
            checked["payload_schema"],
            label=f"message {sender_node_id}->{recipient_node_id} payload",
        )
    except Exception as exc:
        raise AgentMessageError(str(exc)[:1000]) from None
    schema_ref = message_schema_ref(checked)
    identity = {
        "sender_node_id": sender_node_id,
        "recipient_node_id": recipient_node_id,
        "topic": checked["topic"],
        "payload_schema_ref": schema_ref,
        "payload": deepcopy(payload),
    }
    return {
        "schema": AGENT_MESSAGE_SCHEMA,
        "id": "message-" + digest(identity),
        **identity,
    }
