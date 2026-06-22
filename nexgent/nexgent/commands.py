"""Shared command definitions for auto-completion and suggestions.

This module provides a single source of truth for all slash commands
used in the CLI and TUI interfaces.
"""

# All available slash commands
SLASH_COMMANDS = [
    # Basic commands
    "/help", "/quit", "/exit", "/q", "/clear", "/tools",
    "/save", "/load",
    "/memory", "/remember", "/hooks", "/stats",
    "/compact", "/context", "/init", "/init-config", "/rewind", "/fork",
    "/effort",
    # SubAgent commands
    "/subagents", "/subagent", "/parallel", "/pipeline",
    # Agent management
    "/agents", "/agents list", "/agents create", "/agents show", "/agents delete",
    # Background tasks
    "/tasks", "/tasks list", "/tasks show", "/tasks cancel", "/tasks cleanup",
    # Goal management
    "/goal", "/goal clear",
    # In-flight guidance
    "/btw",
    # Skills
    "/skills", "/skills install",
    # MCP
    "/mcp", "/mcp install", "/mcp connect", "/mcp disconnect", "/mcp refresh",
    # Workflow
    "/workflow", "/workflow run", "/workflow list", "/workflow status",
    "/workflow resume", "/workflow save",
    # Model management
    "/model", "/model list", "/model set", "/model default",
    # Plugins
    "/plugin", "/plugin list", "/plugin load", "/plugin unload",
]

# Subset of commands for quick suggestions (most common)
SUGGEST_COMMANDS = [
    "/help", "/quit", "/exit", "/q", "/clear", "/tools",
    "/compact", "/context", "/memory",
    "/agents", "/tasks", "/goal", "/skills", "/mcp", "/btw",
]
