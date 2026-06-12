"""Custom Agents system - reusable agent definitions and invocation.

Implements Claude Code-style custom agents:
- Agent definition files with YAML frontmatter
- Agent discovery from multiple directories
- /agents command for management
- Agent invocation with custom system prompts and tool restrictions
- Preset templates for quick creation
"""

import os
import re
import yaml
import json
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Any
from pathlib import Path


# Preset agent templates for quick creation
AGENT_PRESETS = {
    "code-reviewer": {
        "description": "Reviews code for quality, security, and best practices",
        "prompt": "You are a senior code reviewer. Analyze code for:\n- Bugs and logic errors\n- Security vulnerabilities\n- Performance issues\n- Code style and readability\n\nProvide specific, actionable feedback with line references.",
        "tools": ["Read", "Grep", "Glob"],
        "color": "blue",
    },
    "researcher": {
        "description": "Researches and analyzes codebases and documentation",
        "prompt": "You are a research assistant. Explore codebases thoroughly, find relevant files, and provide comprehensive analysis. Focus on accuracy and completeness.",
        "tools": ["Read", "Grep", "Glob", "WebSearch", "WebFetch"],
        "color": "green",
    },
    "debugger": {
        "description": "Debugs errors and test failures",
        "prompt": "You are an expert debugger. Analyze errors, identify root causes, and provide fixes. Read error messages carefully, trace execution flow, and propose minimal changes.",
        "tools": ["Read", "Grep", "Glob", "Bash"],
        "color": "red",
    },
    "writer": {
        "description": "Writes documentation and technical content",
        "prompt": "You are a technical writer. Create clear, well-structured documentation. Use proper formatting, examples, and explanations suitable for the target audience.",
        "tools": ["Read", "Write", "Edit"],
        "color": "purple",
    },
    "tester": {
        "description": "Writes and runs tests",
        "prompt": "You are a test engineer. Write comprehensive tests covering happy paths, edge cases, and error conditions. Ensure tests are isolated, readable, and maintainable.",
        "tools": ["Read", "Write", "Edit", "Bash"],
        "color": "yellow",
    },
    "planner": {
        "description": "Plans implementation approach before coding",
        "prompt": "You are a software architect. Analyze requirements, design solutions, and create implementation plans. Consider trade-offs, dependencies, and risks.",
        "tools": ["Read", "Grep", "Glob"],
        "color": "cyan",
    },
}


def get_preset_names() -> List[str]:
    """Get list of available preset names."""
    return list(AGENT_PRESETS.keys())


def get_preset(name: str) -> Optional[Dict[str, Any]]:
    """Get a preset template by name."""
    return AGENT_PRESETS.get(name)


@dataclass
class AgentConfig:
    """Agent configuration from frontmatter."""
    name: str
    description: str
    prompt: str = ""
    tools: List[str] = field(default_factory=list)
    disallowed_tools: List[str] = field(default_factory=list)
    model: str = "inherit"
    permission_mode: str = "default"
    max_turns: int = 0
    memory: str = "none"
    background: bool = False
    color: str = "blue"
    effort: Optional[str] = None


@dataclass
class Agent:
    """Represents a loaded agent."""
    name: str
    config: AgentConfig
    source_path: str
    source_type: str  # 'user', 'project'


class AgentParser:
    """Parse agent definition files with YAML frontmatter."""

    FRONTMATTER_PATTERN = re.compile(
        r'^---\s*\n(.*?)\n---\s*\n?(.*)$',
        re.DOTALL
    )

    @classmethod
    def parse(cls, content: str, source_path: str = '') -> tuple[AgentConfig, str]:
        """Parse agent definition content into config and prompt."""
        match = cls.FRONTMATTER_PATTERN.match(content.strip())
        if match:
            yaml_content = match.group(1)
            prompt = match.group(2).strip()
            try:
                frontmatter_data = yaml.safe_load(yaml_content) or {}
            except yaml.YAMLError:
                frontmatter_data = {}
        else:
            frontmatter_data = {}
            prompt = content.strip()

        # Parse frontmatter
        config = AgentConfig(
            name=frontmatter_data.get('name', Path(source_path).stem if source_path else 'unnamed'),
            description=frontmatter_data.get('description', ''),
            prompt=prompt,
            tools=cls._parse_tools(frontmatter_data.get('tools', [])),
            disallowed_tools=cls._parse_tools(frontmatter_data.get('disallowedTools', [])),
            model=frontmatter_data.get('model', 'inherit'),
            permission_mode=frontmatter_data.get('permissionMode', 'default'),
            max_turns=frontmatter_data.get('maxTurns', 0),
            memory=frontmatter_data.get('memory', 'none'),
            background=frontmatter_data.get('background', False),
            color=frontmatter_data.get('color', 'blue'),
            effort=frontmatter_data.get('effort'),
        )

        return config, prompt

    @classmethod
    def _parse_tools(cls, tools) -> List[str]:
        """Parse tools field (string or list)."""
        if isinstance(tools, str):
            return [t.strip() for t in tools.replace(',', ' ').split()]
        elif isinstance(tools, list):
            return [str(t) for t in tools]
        return []


class AgentDiscovery:
    """Discover agents from multiple directories."""

    @classmethod
    def discover_agents(cls, project_root: str = '.') -> Dict[str, Agent]:
        """Discover all available agents."""
        agents = {}

        # Project-level agents
        project_agents_dir = os.path.join(project_root, '.mimo', 'agents')
        if os.path.exists(project_agents_dir):
            for agent in cls._scan_directory(project_agents_dir, 'project'):
                agents[agent.name] = agent

        # User-level agents
        user_agents_dir = os.path.join(os.path.expanduser('~'), '.mimo', 'agents')
        if os.path.exists(user_agents_dir):
            for agent in cls._scan_directory(user_agents_dir, 'user'):
                if agent.name not in agents:
                    agents[agent.name] = agent

        return agents

    @classmethod
    def _scan_directory(cls, directory: str, source_type: str) -> List[Agent]:
        """Scan a directory for agent definitions."""
        agents = []
        for root, dirs, files in os.walk(directory):
            for filename in files:
                if filename.endswith('.md'):
                    filepath = os.path.join(root, filename)
                    try:
                        agent = cls._load_agent(filepath, source_type)
                        if agent:
                            agents.append(agent)
                    except Exception as e:
                        print(f"Warning: Failed to load agent from {filepath}: {e}")
        return agents

    @classmethod
    def _load_agent(cls, filepath: str, source_type: str) -> Optional[Agent]:
        """Load an agent from a file."""
        try:
            with open(filepath, 'r', encoding='utf-8') as f:
                content = f.read()
            config, prompt = AgentParser.parse(content, filepath)
            return Agent(
                name=config.name,
                config=config,
                source_path=filepath,
                source_type=source_type,
            )
        except Exception:
            return None


class AgentManager:
    """Manage and invoke custom agents."""

    def __init__(self, project_root: str = '.'):
        self.project_root = project_root
        self.agents: Dict[str, Agent] = {}
        self._refresh_agents()

    def _refresh_agents(self):
        """Refresh agent discovery."""
        self.agents = AgentDiscovery.discover_agents(self.project_root)

    def list_agents(self) -> List[Dict[str, Any]]:
        """List all available agents."""
        return [
            {
                'name': agent.name,
                'description': agent.config.description,
                'source': agent.source_type,
                'model': agent.config.model,
                'tools': agent.config.tools,
            }
            for agent in self.agents.values()
        ]

    def get_agent(self, name: str) -> Optional[Agent]:
        """Get an agent by name."""
        return self.agents.get(name)

    def create_agent(self, name: str, description: str, prompt: str,
                     tools: List[str] = None, model: str = "inherit",
                     scope: str = "user") -> str:
        """Create a new agent definition file."""
        # Determine directory
        if scope == "project":
            agents_dir = os.path.join(self.project_root, '.mimo', 'agents')
        else:
            agents_dir = os.path.join(os.path.expanduser('~'), '.mimo', 'agents')

        os.makedirs(agents_dir, exist_ok=True)

        # Build frontmatter
        frontmatter = {
            'name': name,
            'description': description,
        }
        if tools:
            frontmatter['tools'] = tools
        if model != "inherit":
            frontmatter['model'] = model

        # Build content
        yaml_content = yaml.dump(frontmatter, default_flow_style=False)
        content = f"---\n{yaml_content}---\n\n{prompt}"

        # Write file - check path traversal
        filepath = os.path.join(agents_dir, f"{name}.md")
        abs_filepath = os.path.abspath(filepath)
        abs_agents_dir = os.path.abspath(agents_dir)

        # Use pathlib for robust path comparison
        from pathlib import Path
        try:
            Path(abs_filepath).relative_to(Path(abs_agents_dir))
        except ValueError:
            raise ValueError(f"Invalid agent name: {name}. Path traversal detected.")

        try:
            with open(filepath, 'w', encoding='utf-8') as f:
                f.write(content)
        except (IOError, OSError) as e:
            raise ValueError(f"Failed to create agent file: {e}")

        # Refresh agents
        self._refresh_agents()

        return filepath

    def delete_agent(self, name: str) -> bool:
        """Delete an agent definition file."""
        agent = self.get_agent(name)
        if not agent:
            return False

        try:
            os.remove(agent.source_path)
            self._refresh_agents()
            return True
        except Exception:
            return False
