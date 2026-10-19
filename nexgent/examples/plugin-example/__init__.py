"""Example plugin — demonstrates the Nexgent plugin system.

This plugin provides a single tool: echo_tool, which echoes back its input.
"""

import json


def get_tools():
    """Return a list of ToolDef objects to register."""
    from nexgent.tools.registry import ToolDef
    from nexgent.permissions import Permission

    return [
        ToolDef(
            name="echo_tool",
            description="Echo back the input message. Example plugin tool.",
            parameters={
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "Message to echo back",
                    },
                },
                "required": ["message"],
            },
            handler=_echo_handler,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=True,
        ),
    ]


def _echo_handler(params: dict) -> str:
    message = params.get("message", "")
    return json.dumps({"echo": message, "length": len(message)})


def init():
    """Called when the plugin is loaded. Optional."""
    print("[example-plugin] Initialized!")


def destroy():
    """Called when the plugin is unloaded. Optional."""
    print("[example-plugin] Destroyed!")
