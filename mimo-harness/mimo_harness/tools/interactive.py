"""Interactive tools - user interaction and memory topic loading.

Ch3 markers:
- ask_user_question: read-only, not concurrency-safe (requires user input)
- read_memory_topic: read-only, concurrency-safe (on-demand topic loading)
"""

import json
import os
from .registry import ToolDef
from ..permissions import Permission
from ..input_utils import rich_input as _rich_input


def ask_user_question(params: dict) -> str:
    """Ask the user a question with multiple choice options.

    Args:
        params: dict with keys:
            - question (str): The question to ask
            - options (list[dict]): List of dicts with 'label' and 'description' keys
            - multi_select (bool, optional): If True, user can select multiple options

    Returns:
        Selected option(s) as JSON string
    """
    question = params.get("question", "")
    options = params.get("options", [])
    multi_select = params.get("multi_select", False)

    if not options:
        return json.dumps({"error": "No options provided"})

    # Display question
    print(f"\n{'='*50}")
    print(f"  {question}")
    print(f"{'='*50}")

    # Display numbered options
    for i, opt in enumerate(options, 1):
        label = opt.get("label", f"Option {i}")
        description = opt.get("description", "")
        if description:
            print(f"  {i}. {label}: {description}")
        else:
            print(f"  {i}. {label}")

    # Prompt for input
    if multi_select:
        prompt = "\nSelect options (comma-separated numbers, e.g., 1,3): "
    else:
        prompt = "\nSelect an option (number): "

    try:
        user_input = _rich_input(prompt).strip()
    except (EOFError, KeyboardInterrupt):
        return json.dumps({"error": "User cancelled"})

    if not user_input:
        return json.dumps({"error": "No selection made"})

    # Parse selection
    try:
        if multi_select:
            indices = [int(x.strip()) - 1 for x in user_input.split(",")]
            selected = []
            for idx in indices:
                if 0 <= idx < len(options):
                    selected.append(options[idx])
                else:
                    return json.dumps({"error": f"Invalid option: {idx + 1}"})
            return json.dumps({"selected": selected})
        else:
            idx = int(user_input) - 1
            if 0 <= idx < len(options):
                return json.dumps({"selected": options[idx]})
            else:
                return json.dumps({"error": f"Invalid option: {idx + 1}"})
    except ValueError:
        return json.dumps({"error": "Invalid input. Please enter numbers only."})


def read_memory_topic(params: dict) -> str:
    """Load a memory topic file on-demand (Ch6: tiered memory loading).

    Topic files like 'debugging.md' are NOT loaded at session start.
    Only the MEMORY.md index is loaded. This tool lets the agent read
    specific topic files when it needs the details.

    Args:
        params: dict with keys:
            - topic_name (str): Name of the topic file (e.g. 'debugging', 'build-and-test')

    Returns:
        Topic file content, or error message if not found.
    """
    topic_name = params.get("topic_name", "")
    if not topic_name:
        return json.dumps({"error": "No topic_name provided"})

    # Find project dir (look for .mimo/memory/ directory)
    project_dir = os.getcwd()
    from ..memory import MemoryStore
    store = MemoryStore(project_dir)
    content = store.load_topic(topic_name)
    if not content:
        available = store.list_topic_names()
        return json.dumps({
            "error": f"Topic '{topic_name}' not found",
            "available_topics": available,
        })
    return content


def get_tools() -> list[ToolDef]:
    return [
        ToolDef(
            name="ask_user_question",
            description="Ask the user a question with multiple choice options. Use when you need clarification or want to present choices to the user.",
            parameters={
                "type": "object",
                "properties": {
                    "question": {
                        "type": "string",
                        "description": "The question to ask the user",
                    },
                    "options": {
                        "type": "array",
                        "description": "List of options, each with 'label' and 'description' keys",
                        "items": {
                            "type": "object",
                            "properties": {
                                "label": {"type": "string", "description": "Short label for the option"},
                                "description": {"type": "string", "description": "Detailed description of the option"},
                            },
                            "required": ["label"],
                        },
                    },
                    "multi_select": {
                        "type": "boolean",
                        "description": "If true, user can select multiple options (default: false)",
                    },
                },
                "required": ["question", "options"],
            },
            handler=ask_user_question,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=False,
        ),
        ToolDef(
            name="read_memory_topic",
            description=(
                "Load a memory topic file on-demand. Topic files (e.g. debugging.md, "
                "build-and-test.md) are NOT loaded at session start — only the MEMORY.md "
                "index is. Use this tool when you need details from a specific topic."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "topic_name": {
                        "type": "string",
                        "description": "Name of the topic file (e.g. 'debugging', 'build-and-test')",
                    },
                },
                "required": ["topic_name"],
            },
            handler=read_memory_topic,
            permission=Permission.READ,
            is_read_only=True,
            is_concurrency_safe=True,
        ),
    ]
