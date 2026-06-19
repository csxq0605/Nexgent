"""Shared input utilities using prompt_toolkit.

Provides a single PromptSession instance that can be used across modules
(cli.py, agent.py, permissions.py, tools/interactive.py) without circular imports.

Falls back to built-in input() if prompt_toolkit cannot initialize (e.g., in
non-interactive environments like pytest, piped stdin, or CI).
"""

import builtins
import os
import sys

# Import shared command list
from .commands import SLASH_COMMANDS as _SLASH_COMMANDS


class AtFileCompleter:
    """Completer for @file references — fuzzy file finder.

    Detects @<prefix> in the input and yields matching files/directories.
    Works with prompt_toolkit's completion dropdown menu.
    """

    def get_completions(self, document, complete_event):
        from prompt_toolkit.completion import Completion
        from .file_references import scan_completions

        text = document.text_before_cursor
        # Find the last @ in the text
        at_pos = text.rfind('@')
        if at_pos < 0:
            return

        # Extract the prefix after @
        prefix = text[at_pos + 1:]

        # Don't complete if prefix contains spaces (not a file ref)
        if ' ' in prefix:
            return

        # Strip line number suffix like :42
        line_suffix = ''
        if ':' in prefix:
            parts = prefix.rsplit(':', 1)
            if parts[1].isdigit():
                prefix = parts[0]
                line_suffix = ':' + parts[1]

        # Scan for matching files
        matches = scan_completions(prefix, os.getcwd(), limit=15)
        for match in matches:
            # The text to insert replaces everything after @
            insert_text = match + line_suffix
            yield Completion(
                insert_text,
                start_position=-len(prefix) - len(line_suffix),
                display=match,
            )

# Lazy-loaded prompt_toolkit components
_session = None
_prompt_toolkit_available = None


def _init_prompt_toolkit():
    """Try to initialize prompt_toolkit. Returns True if successful."""
    global _session, _prompt_toolkit_available
    if _prompt_toolkit_available is not None:
        return _prompt_toolkit_available

    # Only use prompt_toolkit in interactive terminals
    if not sys.stdin.isatty() or not sys.stdout.isatty():
        _prompt_toolkit_available = False
        return False

    try:
        from prompt_toolkit import PromptSession
        from prompt_toolkit.completion import WordCompleter, merge_completers
        from prompt_toolkit.history import FileHistory
        from prompt_toolkit.auto_suggest import AutoSuggestFromHistory
        from prompt_toolkit.styles import Style

        slash_completer = WordCompleter(_SLASH_COMMANDS, ignore_case=True, sentence=True)
        at_file_completer = AtFileCompleter()
        completer = merge_completers(slash_completer, at_file_completer)
        history_path = os.path.join(os.path.expanduser("~"), ".nexgent", "history")
        os.makedirs(os.path.dirname(history_path), exist_ok=True)

        # Style for the prompt labels
        prompt_style = Style.from_dict({
            'prompt.label': 'cyan bold',
            'prompt.user': 'cyan bold',
            'prompt.tokens': '#888888',
            'prompt.arrow': 'cyan',
            'prompt.border': 'cyan',
            'completion-menu.completion': 'bg:#222222 #ffffff',
            'completion-menu.completion.current': 'bg:#444444 #ffffff bold',
            'auto-suggestion': '#666666',
        })

        _session = PromptSession(
            history=FileHistory(history_path),
            auto_suggest=AutoSuggestFromHistory(),
            completer=completer,
            style=prompt_style,
        )
        _prompt_toolkit_available = True
        return True
    except Exception:
        _prompt_toolkit_available = False
        return False


def rich_input(prompt: str = "") -> str:
    """Drop-in replacement for input() with auto-completion and history.

    Falls back to built-in input() if prompt_toolkit is unavailable.
    Uses builtins.input so monkeypatching in tests works correctly.

    Usage:
        from .input_utils import rich_input
        user_input = rich_input("Enter command: ").strip()
    """
    if _init_prompt_toolkit():
        try:
            return _session.prompt(prompt)
        except (EOFError, KeyboardInterrupt):
            raise
        except Exception:
            # prompt_toolkit failed at runtime, fall back
            return builtins.input(prompt)
    else:
        return builtins.input(prompt)


def reset_prompt_toolkit():
    """Reset prompt_toolkit state. Used in tests to re-initialize."""
    global _session, _prompt_toolkit_available
    _session = None
    _prompt_toolkit_available = None
