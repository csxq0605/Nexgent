"""Tests for Skills and MCP modules."""

import os
import json
import tempfile
import pytest
from pathlib import Path
from unittest.mock import patch, MagicMock

# Import modules to test
import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from mimo_harness.skills import (
    SkillParser, SkillSubstitutor, SkillDiscovery, SkillManager,
    SkillFrontmatter, Skill
)
from mimo_harness.mcp import (
    MCPConfigParser, MCPManager, MCPConnection,
    MCPServerConfig, MCPTransport, MCPServerStatus
)


class TestSkillParser:
    """Test SKILL.md parsing."""

    def test_parse_frontmatter(self):
        """Test parsing YAML frontmatter."""
        content = """---
name: test-skill
description: A test skill
disable-model-invocation: true
allowed-tools: Read Grep
---

## Instructions

Do something useful.
"""
        frontmatter, body = SkillParser.parse(content)

        assert frontmatter.name == 'test-skill'
        assert frontmatter.description == 'A test skill'
        assert frontmatter.disable_model_invocation is True
        assert frontmatter.allowed_tools == ['Read', 'Grep']
        assert '## Instructions' in body

    def test_parse_no_frontmatter(self):
        """Test parsing content without frontmatter."""
        content = """## Instructions

Do something useful.
"""
        frontmatter, body = SkillParser.parse(content)

        assert frontmatter.name is None
        assert frontmatter.description is None
        assert '## Instructions' in body

    def test_parse_arguments_string(self):
        """Test parsing arguments as string."""
        content = """---
arguments: issue branch
---
"""
        frontmatter, _ = SkillParser.parse(content)
        assert frontmatter.arguments == ['issue', 'branch']

    def test_parse_arguments_list(self):
        """Test parsing arguments as list."""
        content = """---
arguments:
  - issue
  - branch
---
"""
        frontmatter, _ = SkillParser.parse(content)
        assert frontmatter.arguments == ['issue', 'branch']

    def test_parse_paths_string(self):
        """Test parsing paths as comma-separated string."""
        content = """---
paths: "*.py, *.js"
---
"""
        frontmatter, _ = SkillParser.parse(content)
        assert frontmatter.paths == ['*.py', '*.js']


class TestSkillSubstitutor:
    """Test string substitutions."""

    def test_substitute_arguments(self):
        """Test $ARGUMENTS substitution."""
        content = "Fix issue $ARGUMENTS"
        result = SkillSubstitutor.substitute(content, arguments="123")
        assert result == "Fix issue 123"

    def test_substitute_indexed_arguments(self):
        """Test $ARGUMENTS[N] substitution."""
        content = "Fix $ARGUMENTS[0] and $ARGUMENTS[1]"
        result = SkillSubstitutor.substitute(content, arguments="bug feature")
        assert result == "Fix bug and feature"

    def test_substitute_n_shorthand(self):
        """Test $N shorthand substitution."""
        content = "Fix $0 and $1"
        result = SkillSubstitutor.substitute(content, arguments="bug feature")
        assert result == "Fix bug and feature"

    def test_substitute_session_id(self):
        """Test ${CLAUDE_SESSION_ID} substitution."""
        content = "Session: ${CLAUDE_SESSION_ID}"
        result = SkillSubstitutor.substitute(content, session_id="abc123")
        assert result == "Session: abc123"

    def test_substitute_effort(self):
        """Test ${CLAUDE_EFFORT} substitution."""
        content = "Effort: ${CLAUDE_EFFORT}"
        result = SkillSubstitutor.substitute(content, effort="high")
        assert result == "Effort: high"

    def test_substitute_skill_dir(self):
        """Test ${CLAUDE_SKILL_DIR} substitution."""
        content = "Dir: ${CLAUDE_SKILL_DIR}"
        result = SkillSubstitutor.substitute(content, skill_dir="/path/to/skill")
        assert result == "Dir: /path/to/skill"

    def test_append_arguments_if_not_present(self):
        """Test that arguments are appended if $ARGUMENTS not in content."""
        content = "Do something"
        result = SkillSubstitutor.substitute(content, arguments="123")
        assert "ARGUMENTS: 123" in result

    def test_shell_injection(self):
        """Test !`command` shell injection."""
        content = "Date: !`echo 2024-01-01`"
        result = SkillSubstitutor.substitute(content)
        assert "Date: 2024-01-01" in result


class TestSkillDiscovery:
    """Test skill discovery."""

    def test_discover_from_project(self, tmp_path):
        """Test discovering skills from project directory."""
        # Create skill directory
        skill_dir = tmp_path / '.mimo' / 'skills' / 'test-skill'
        skill_dir.mkdir(parents=True)
        skill_md = skill_dir / 'SKILL.md'
        skill_md.write_text("""---
description: A test skill
---
Do something.
""")

        # Change to tmp_path
        old_cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            skills = SkillDiscovery.discover_skills()
            assert 'test-skill' in skills
            assert skills['test-skill'].frontmatter.description == 'A test skill'
        finally:
            os.chdir(old_cwd)

    def test_discover_legacy_commands(self, tmp_path):
        """Test discovering legacy commands."""
        # Create commands directory
        commands_dir = tmp_path / '.mimo' / 'commands'
        commands_dir.mkdir(parents=True)
        cmd_file = commands_dir / 'deploy.md'
        cmd_file.write_text("""---
description: Deploy the app
---
Deploy steps.
""")

        # Change to tmp_path
        old_cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            skills = SkillDiscovery.discover_skills()
            assert 'deploy' in skills
        finally:
            os.chdir(old_cwd)


class TestSkillManager:
    """Test skill manager."""

    def test_list_skills(self, tmp_path):
        """Test listing skills."""
        # Create skill
        skill_dir = tmp_path / '.mimo' / 'skills' / 'test-skill'
        skill_dir.mkdir(parents=True)
        skill_md = skill_dir / 'SKILL.md'
        skill_md.write_text("""---
description: A test skill
---
Do something.
""")

        old_cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            manager = SkillManager()
            skills = manager.list_skills()
            assert len(skills) > 0
            assert any(s['name'] == 'test-skill' for s in skills)
        finally:
            os.chdir(old_cwd)

    def test_invoke_skill(self, tmp_path):
        """Test invoking a skill."""
        # Create skill
        skill_dir = tmp_path / '.mimo' / 'skills' / 'test-skill'
        skill_dir.mkdir(parents=True)
        skill_md = skill_dir / 'SKILL.md'
        skill_md.write_text("""---
description: A test skill
---
Do something with $ARGUMENTS.
""")

        old_cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            manager = SkillManager()
            result = manager.invoke_skill('test-skill', arguments='123')
            assert result is not None
            assert '123' in result
        finally:
            os.chdir(old_cwd)


class TestMCPConfigParser:
    """Test MCP configuration parsing."""

    def test_parse_mcp_json(self, tmp_path):
        """Test parsing .mimo/mcp.json file."""
        mcp_dir = tmp_path / '.mimo'
        mcp_dir.mkdir(parents=True)
        mcp_json = mcp_dir / 'mcp.json'
        mcp_json.write_text(json.dumps({
            'mcpServers': {
                'test-server': {
                    'type': 'stdio',
                    'command': 'echo',
                    'args': ['hello'],
                }
            }
        }))

        configs = MCPConfigParser.parse_mcp_json(str(mcp_json))
        assert 'test-server' in configs
        assert configs['test-server'].transport == MCPTransport.STDIO
        assert configs['test-server'].command == 'echo'

    def test_parse_http_server(self, tmp_path):
        """Test parsing HTTP server config."""
        mcp_dir = tmp_path / '.mimo'
        mcp_dir.mkdir(parents=True)
        mcp_json = mcp_dir / 'mcp.json'
        mcp_json.write_text(json.dumps({
            'mcpServers': {
                'http-server': {
                    'type': 'http',
                    'url': 'https://mcp.example.com',
                    'headers': {
                        'Authorization': 'Bearer token'
                    }
                }
            }
        }))

        configs = MCPConfigParser.parse_mcp_json(str(mcp_json))
        assert 'http-server' in configs
        assert configs['http-server'].transport == MCPTransport.HTTP
        assert configs['http-server'].url == 'https://mcp.example.com'

    def test_expand_env_vars(self, tmp_path):
        """Test environment variable expansion."""
        mcp_dir = tmp_path / '.mimo'
        mcp_dir.mkdir(parents=True)
        mcp_json = mcp_dir / 'mcp.json'
        mcp_json.write_text(json.dumps({
            'mcpServers': {
                'env-server': {
                    'type': 'stdio',
                    'command': '${HOME}/server',
                    'env': {
                        'API_KEY': '${API_KEY:-default}'
                    }
                }
            }
        }))

        with patch.dict(os.environ, {'HOME': '/home/user', 'API_KEY': 'secret'}):
            configs = MCPConfigParser.parse_mcp_json(str(mcp_json))
            assert configs['env-server'].command == '/home/user/server'
            assert configs['env-server'].env['API_KEY'] == 'secret'

    def test_expand_env_vars_default(self, tmp_path):
        """Test environment variable expansion with default."""
        mcp_dir = tmp_path / '.mimo'
        mcp_dir.mkdir(parents=True)
        mcp_json = mcp_dir / 'mcp.json'
        mcp_json.write_text(json.dumps({
            'mcpServers': {
                'env-server': {
                    'type': 'stdio',
                    'command': '${MISSING_VAR:-/default/path}'
                }
            }
        }))

        configs = MCPConfigParser.parse_mcp_json(str(mcp_json))
        assert configs['env-server'].command == '/default/path'


class TestMCPManager:
    """Test MCP manager."""

    def test_load_configurations(self, tmp_path):
        """Test loading configurations."""
        mcp_dir = tmp_path / '.mimo'
        mcp_dir.mkdir(parents=True)
        mcp_json = mcp_dir / 'mcp.json'
        mcp_json.write_text(json.dumps({
            'mcpServers': {
                'test-server': {
                    'type': 'stdio',
                    'command': 'echo',
                }
            }
        }))

        old_cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            manager = MCPManager()
            manager.load_configurations()
            assert 'test-server' in manager.connections
        finally:
            os.chdir(old_cwd)

    def test_get_server_status(self, tmp_path):
        """Test getting server status."""
        mcp_dir = tmp_path / '.mimo'
        mcp_dir.mkdir(parents=True)
        mcp_json = mcp_dir / 'mcp.json'
        mcp_json.write_text(json.dumps({
            'mcpServers': {
                'test-server': {
                    'type': 'stdio',
                    'command': 'echo',
                }
            }
        }))

        old_cwd = os.getcwd()
        os.chdir(tmp_path)
        try:
            manager = MCPManager()
            manager.load_configurations()
            status = manager.get_server_status()
            assert len(status) == 1
            assert status[0]['name'] == 'test-server'
            assert status[0]['status'] == 'disconnected'
        finally:
            os.chdir(old_cwd)


if __name__ == '__main__':
    pytest.main([__file__, '-v'])
