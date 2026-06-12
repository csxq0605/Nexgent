"""Shared command definitions for auto-completion and suggestions.

This module provides a single source of truth for all slash commands
used in the CLI and TUI interfaces.
"""

# All available slash commands
SLASH_COMMANDS = [
    # Basic commands
    "/help", "/quit", "/exit", "/q", "/clear", "/tools",
    "/save", "/load", "/dry-run", "/auto", "/plan", "/abort",
    "/memory", "/remember", "/hooks", "/stats", "/tokens",
    "/compact", "/context", "/init", "/rewind", "/fork",
    "/effort", "/mode",
    # SubAgent commands
    "/subagents", "/subagent", "/parallel", "/pipeline",
    # Agent management
    "/agents", "/agents list", "/agents create", "/agents show", "/agents delete",
    # Background tasks
    "/tasks", "/tasks list", "/tasks show", "/tasks cancel", "/tasks cleanup",
    # Goal management
    "/goal", "/goal clear",
    # Skills
    "/skills", "/skills install",
    # MCP
    "/mcp", "/mcp install", "/mcp connect", "/mcp disconnect", "/mcp refresh",
]

# Subset of commands for quick suggestions (most common)
SUGGEST_COMMANDS = [
    "/help", "/quit", "/exit", "/q", "/clear", "/tools",
    "/compact", "/context", "/memory",
    "/agents", "/tasks", "/goal", "/skills", "/mcp",
]
