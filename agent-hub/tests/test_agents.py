"""Tests for the Agents module."""

import os
import json
import tempfile
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from agent_hub.agents import (
    AgentParser, AgentDiscovery, AgentManager, AgentConfig
)


@pytest.fixture(autouse=True)
def restore_cwd():
    """Restore original working directory after each test."""
    original_cwd = os.getcwd()
    yield
    os.chdir(original_cwd)


class TestAgentParser:
    """Test agent definition parsing."""

    def test_parse_frontmatter(self):
        """Test parsing YAML frontmatter."""
        content = """---
name: test-agent
description: A test agent
tools: Read, Grep
model: sonnet
---

You are a test agent."""
        config, prompt = AgentParser.parse(content, 'test.md')
        assert config.name == 'test-agent'
        assert config.description == 'A test agent'
        assert config.tools == ['Read', 'Grep']
        assert config.model == 'sonnet'
        assert 'You are a test agent' in prompt

    def test_parse_no_frontmatter(self):
        """Test parsing without frontmatter."""
        content = "You are a simple agent."
        config, prompt = AgentParser.parse(content, 'simple.md')
        assert config.name == 'simple'
        assert prompt == 'You are a simple agent.'

    def test_parse_tools_string(self):
        """Test parsing tools as comma-separated string."""
        content = """---
name: test
description: test
tools: Read, Write, Grep
---
Test"""
        config, _ = AgentParser.parse(content, 'test.md')
        assert config.tools == ['Read', 'Write', 'Grep']

    def test_parse_tools_list(self):
        """Test parsing tools as YAML list."""
        content = """---
name: test
description: test
tools:
  - Read
  - Write
  - Grep
---
Test"""
        config, _ = AgentParser.parse(content, 'test.md')
        assert config.tools == ['Read', 'Write', 'Grep']

    def test_parse_disallowed_tools(self):
        """Test parsing disallowed tools."""
        content = """---
name: test
description: test
disallowedTools: Write, Edit
---
Test"""
        config, _ = AgentParser.parse(content, 'test.md')
        assert config.disallowed_tools == ['Write', 'Edit']

    def test_parse_model_inherit(self):
        """Test default model is inherit."""
        content = """---
name: test
description: test
---
Test"""
        config, _ = AgentParser.parse(content, 'test.md')
        assert config.model == 'inherit'


class TestAgentDiscovery:
    """Test agent discovery."""

    def test_discover_from_project(self, tmp_path):
        """Test discovering agents from project directory."""
        agents_dir = tmp_path / '.mimo' / 'agents'
        agents_dir.mkdir(parents=True)
        agent_file = agents_dir / 'test-agent.md'
        agent_file.write_text("""---
name: test-agent
description: A test agent
---
You are a test agent.""")

        old_cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            agents = AgentDiscovery.discover_agents()
            assert 'test-agent' in agents
            assert agents['test-agent'].source_type == 'project'
        finally:
            os.chdir(old_cwd)

    def test_discover_from_user(self, tmp_path, monkeypatch):
        """Test discovering agents from user directory."""
        agents_dir = tmp_path / '.mimo' / 'agents'
        agents_dir.mkdir(parents=True)
        agent_file = agents_dir / 'user-agent.md'
        agent_file.write_text("""---
name: user-agent
description: A user agent
---
You are a user agent.""")

        monkeypatch.setenv('USERPROFILE', str(tmp_path))
        monkeypatch.setenv('HOME', str(tmp_path))

        agents = AgentDiscovery.discover_agents()
        assert 'user-agent' in agents
        assert agents['user-agent'].source_type == 'user'

    def test_project_priority_over_user(self, tmp_path, monkeypatch):
        """Test project agents have priority over user agents."""
        # Create project agent
        project_dir = tmp_path / '.mimo' / 'agents'
        project_dir.mkdir(parents=True)
        (project_dir / 'agent.md').write_text("""---
name: shared-agent
description: Project version
---
Project prompt.""")

        # Create user agent with same name
        user_dir = tmp_path / 'user' / '.mimo' / 'agents'
        user_dir.mkdir(parents=True)
        (user_dir / 'agent.md').write_text("""---
name: shared-agent
description: User version
---
User prompt.""")

        monkeypatch.setenv('USERPROFILE', str(tmp_path / 'user'))
        monkeypatch.setenv('HOME', str(tmp_path / 'user'))

        old_cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            agents = AgentDiscovery.discover_agents()
            assert 'shared-agent' in agents
            assert agents['shared-agent'].source_type == 'project'
        finally:
            os.chdir(old_cwd)


class TestAgentManager:
    """Test agent management."""

    def test_list_agents(self, tmp_path, monkeypatch):
        """Test listing agents."""
        agents_dir = tmp_path / '.mimo' / 'agents'
        agents_dir.mkdir(parents=True)
        (agents_dir / 'agent1.md').write_text("""---
name: agent1
description: First agent
---
Prompt 1.""")
        (agents_dir / 'agent2.md').write_text("""---
name: agent2
description: Second agent
---
Prompt 2.""")

        # Isolate from user-level agents
        monkeypatch.setenv('USERPROFILE', str(tmp_path / 'empty_user'))
        monkeypatch.setenv('HOME', str(tmp_path / 'empty_user'))

        old_cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            manager = AgentManager()
            agents = manager.list_agents()
            assert len(agents) == 2
            names = [a['name'] for a in agents]
            assert 'agent1' in names
            assert 'agent2' in names
        finally:
            os.chdir(old_cwd)

    def test_get_agent(self, tmp_path):
        """Test getting a specific agent."""
        agents_dir = tmp_path / '.mimo' / 'agents'
        agents_dir.mkdir(parents=True)
        (agents_dir / 'test.md').write_text("""---
name: test-agent
description: A test agent
---
Test prompt.""")

        old_cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            manager = AgentManager()
            agent = manager.get_agent('test-agent')
            assert agent is not None
            assert agent.name == 'test-agent'
            assert agent.config.description == 'A test agent'
        finally:
            os.chdir(old_cwd)

    def test_get_agent_not_found(self, tmp_path):
        """Test getting a non-existent agent."""
        old_cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            manager = AgentManager()
            agent = manager.get_agent('nonexistent')
            assert agent is None
        finally:
            os.chdir(old_cwd)

    def test_create_agent(self, tmp_path, monkeypatch):
        """Test creating a new agent."""
        monkeypatch.setenv('USERPROFILE', str(tmp_path))
        monkeypatch.setenv('HOME', str(tmp_path))

        old_cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            manager = AgentManager()
            filepath = manager.create_agent(
                name='new-agent',
                description='A new agent',
                prompt='You are a new agent.',
            )
            assert os.path.exists(filepath)
            assert 'new-agent' in manager.agents
        finally:
            os.chdir(old_cwd)

    def test_delete_agent(self, tmp_path, monkeypatch):
        """Test deleting an agent."""
        agents_dir = tmp_path / '.mimo' / 'agents'
        agents_dir.mkdir(parents=True)
        (agents_dir / 'to-delete.md').write_text("""---
name: to-delete
description: Delete me
---
Delete prompt.""")

        monkeypatch.setenv('USERPROFILE', str(tmp_path))
        monkeypatch.setenv('HOME', str(tmp_path))

        old_cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            manager = AgentManager()
            assert 'to-delete' in manager.agents
            result = manager.delete_agent('to-delete')
            assert result is True
            assert 'to-delete' not in manager.agents
        finally:
            os.chdir(old_cwd)

    def test_delete_agent_not_found(self, tmp_path):
        """Test deleting a non-existent agent."""
        old_cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            manager = AgentManager()
            result = manager.delete_agent('nonexistent')
            assert result is False
        finally:
            os.chdir(old_cwd)


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
