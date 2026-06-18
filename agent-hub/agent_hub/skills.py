"""Skills system - reusable skill definitions and invocation.

Implements Claude Code-style skills:
- SKILL.md file format with YAML frontmatter
- Dynamic context injection (!`command` syntax)
- Parameter substitution ($ARGUMENTS, $0, $1, etc.)
- Skill discovery from multiple directories
- /skill-name invocation
- Frontmatter configuration (disable-model-invocation, user-invocable, allowed-tools, etc.)
"""

import os
import re
import yaml
import subprocess
from dataclasses import dataclass, field
from typing import Optional, Dict, List, Any
from pathlib import Path


@dataclass
class SkillFrontmatter:
    """Skill frontmatter configuration."""
    name: Optional[str] = None
    description: Optional[str] = None
    when_to_use: Optional[str] = None
    argument_hint: Optional[str] = None
    arguments: List[str] = field(default_factory=list)
    disable_model_invocation: bool = False
    user_invocable: bool = True
    allowed_tools: List[str] = field(default_factory=list)
    disallowed_tools: List[str] = field(default_factory=list)
    model: Optional[str] = None
    effort: Optional[str] = None
    context: Optional[str] = None  # 'fork' for subagent execution
    agent: Optional[str] = None
    hooks: Dict[str, Any] = field(default_factory=dict)
    paths: List[str] = field(default_factory=list)
    shell: str = 'bash'


@dataclass
class Skill:
    """Represents a loaded skill."""
    name: str
    frontmatter: SkillFrontmatter
    content: str
    source_path: str
    source_type: str  # 'personal', 'project', 'enterprise', 'plugin'


class SkillParser:
    """Parse SKILL.md files with YAML frontmatter."""

    FRONTMATTER_PATTERN = re.compile(
        r'^---\s*\n(.*?)\n---\s*\n?(.*)$',
        re.DOTALL
    )

    @classmethod
    def parse(cls, content: str, source_path: str = '') -> tuple[SkillFrontmatter, str]:
        """Parse SKILL.md content into frontmatter and body."""
        match = cls.FRONTMATTER_PATTERN.match(content.strip())
        if match:
            yaml_content = match.group(1)
            body = match.group(2)
            try:
                frontmatter_data = yaml.safe_load(yaml_content) or {}
            except yaml.YAMLError:
                frontmatter_data = {}
        else:
            frontmatter_data = {}
            body = content

        # Parse frontmatter
        frontmatter = SkillFrontmatter(
            name=frontmatter_data.get('name'),
            description=frontmatter_data.get('description'),
            when_to_use=frontmatter_data.get('when_to_use'),
            argument_hint=frontmatter_data.get('argument-hint'),
            arguments=cls._parse_arguments(frontmatter_data.get('arguments', [])),
            disable_model_invocation=frontmatter_data.get('disable-model-invocation', False),
            user_invocable=frontmatter_data.get('user-invocable', True),
            allowed_tools=cls._parse_tools(frontmatter_data.get('allowed-tools', [])),
            disallowed_tools=cls._parse_tools(frontmatter_data.get('disallowed-tools', [])),
            model=frontmatter_data.get('model'),
            effort=frontmatter_data.get('effort'),
            context=frontmatter_data.get('context'),
            agent=frontmatter_data.get('agent'),
            hooks=frontmatter_data.get('hooks', {}),
            paths=cls._parse_paths(frontmatter_data.get('paths', [])),
            shell=frontmatter_data.get('shell', 'bash'),
        )

        return frontmatter, body

    @classmethod
    def _parse_arguments(cls, arguments) -> List[str]:
        """Parse arguments field (string or list)."""
        if isinstance(arguments, str):
            return arguments.split()
        elif isinstance(arguments, list):
            return [str(a) for a in arguments]
        return []

    @classmethod
    def _parse_paths(cls, paths) -> List[str]:
        """Parse paths field (string or list)."""
        if isinstance(paths, str):
            return [p.strip() for p in paths.split(',')]
        elif isinstance(paths, list):
            return [str(p) for p in paths]
        return []

    @classmethod
    def _parse_tools(cls, tools) -> List[str]:
        """Parse tools field (string or list)."""
        if isinstance(tools, str):
            return [t.strip() for t in tools.replace(',', ' ').split()]
        elif isinstance(tools, list):
            return [str(t) for t in tools]
        return []


class SkillSubstitutor:
    """Handle string substitutions in skill content."""

    # Variable patterns
    PATTERNS = {
        'ARGUMENTS': re.compile(r'\$ARGUMENTS(?:\[([0-9]+)\])?'),
        'N': re.compile(r'\$([0-9]+)'),
        'CLAUDE_SESSION_ID': re.compile(r'\$\{CLAUDE_SESSION_ID\}'),
        'CLAUDE_EFFORT': re.compile(r'\$\{CLAUDE_EFFORT\}'),
        'CLAUDE_SKILL_DIR': re.compile(r'\$\{CLAUDE_SKILL_DIR\}'),
    }

    # Shell injection pattern
    SHELL_INJECTION = re.compile(r'!`([^`]+)`')
    SHELL_BLOCK = re.compile(r'```!\s*\n(.*?)```', re.DOTALL)

    @classmethod
    def substitute(
        cls,
        content: str,
        arguments: str = '',
        session_id: str = '',
        effort: str = 'medium',
        skill_dir: str = '',
    ) -> str:
        """Apply all substitutions to skill content."""
        # First, handle shell injections
        content = cls._process_shell_injections(content)

        # Then handle variable substitutions
        args_list = cls._parse_arguments_string(arguments)

        # Check if $ARGUMENTS or $N patterns exist in original content
        has_arguments = '$ARGUMENTS' in content
        has_n_shorthand = any(f'${i}' in content for i in range(len(args_list)))

        # $ARGUMENTS and $ARGUMENTS[N]
        def replace_arguments(match):
            index_str = match.group(1)
            if index_str is None:
                return arguments
            index = int(index_str)
            if 0 <= index < len(args_list):
                return args_list[index]
            return match.group(0)

        content = cls.PATTERNS['ARGUMENTS'].sub(replace_arguments, content)

        # $N shorthand
        def replace_n(match):
            index = int(match.group(1))
            if 0 <= index < len(args_list):
                return args_list[index]
            return match.group(0)

        content = cls.PATTERNS['N'].sub(replace_n, content)

        # ${CLAUDE_SESSION_ID}
        content = cls.PATTERNS['CLAUDE_SESSION_ID'].sub(session_id, content)

        # ${CLAUDE_EFFORT}
        content = cls.PATTERNS['CLAUDE_EFFORT'].sub(effort, content)

        # ${CLAUDE_SKILL_DIR}
        # Convert Windows backslashes to forward slashes for regex safety
        skill_dir_safe = skill_dir.replace('\\', '/')
        content = cls.PATTERNS['CLAUDE_SKILL_DIR'].sub(skill_dir_safe, content)

        # If $ARGUMENTS not in original content, append arguments
        if arguments and not has_arguments and not has_n_shorthand:
            content += f'\nARGUMENTS: {arguments}'

        return content

    @classmethod
    def _parse_arguments_string(cls, arguments: str) -> List[str]:
        """Parse arguments string with shell-style quoting."""
        if not arguments:
            return []
        # Simple split respecting quotes
        import shlex
        try:
            return shlex.split(arguments)
        except ValueError:
            return arguments.split()

    @classmethod
    def _process_shell_injections(cls, content: str) -> str:
        """Process !`command` and ```! ... ``` patterns."""
        # Inline: !`command`
        def replace_inline(match):
            command = match.group(1)
            return cls._execute_shell(command)

        content = cls.SHELL_INJECTION.sub(replace_inline, content)

        # Block: ```! ... ```
        def replace_block(match):
            commands = match.group(1).strip()
            results = []
            for line in commands.split('\n'):
                line = line.strip()
                if line:
                    results.append(cls._execute_shell(line))
            return '\n'.join(results)

        content = cls.SHELL_BLOCK.sub(replace_block, content)

        return content

    # Module-level flag: when True, skip interactive confirmation for shell commands.
    # Auto-detects non-interactive environments (no TTY, pytest, etc.).
    _auto_approve_shell: bool = False

    @classmethod
    def _should_confirm(cls) -> bool:
        """Return True if interactive confirmation is needed."""
        if cls._auto_approve_shell:
            return False
        import sys
        # Skip confirmation when stdin is not a real interactive TTY
        if not hasattr(sys.stdin, 'isatty') or not sys.stdin.isatty():
            return False
        # Skip confirmation when running under pytest (output capture breaks input())
        if os.environ.get('PYTEST_CURRENT_TEST'):
            return False
        return True

    @classmethod
    def _execute_shell(cls, command: str) -> str:
        """Execute a shell command and return output."""
        # Require user confirmation before running any shell command (interactive TTY only)
        if cls._should_confirm():
            print(f"\n[Skill shell command]: {command}")
            try:
                response = input("Execute this command? [y/N] ").strip().lower()
            except (EOFError, KeyboardInterrupt):
                return "[command declined by user]"
            if response not in ('y', 'yes'):
                return "[command declined by user]"

        try:
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                encoding='utf-8',
                errors='replace',
                timeout=30,
            )
            if result.returncode == 0:
                return result.stdout.strip()
            else:
                return f"[command failed: {result.stderr.strip()}]"
        except subprocess.TimeoutExpired:
            return "[command timed out]"
        except Exception as e:
            return f"[command error: {str(e)}]"


class SkillDiscovery:
    """Discover skills from multiple directories."""

    SKILL_DIRS = [
        Path.home() / '.mimo' / 'skills',   # Personal
        Path('.mimo') / 'skills',            # Project
    ]

    COMMANDS_DIR = Path('.mimo') / 'commands'  # Legacy commands

    @classmethod
    def discover_skills(cls, project_root: str = '.') -> Dict[str, Skill]:
        """Discover all available skills."""
        skills = {}

        # Build skill directories from project_root (not CWD)
        skill_dirs = [
            Path.home() / '.mimo' / 'skills',   # Personal
            Path(project_root) / '.mimo' / 'skills',  # Project
        ]

        # Scan skill directories
        for idx, skill_dir in enumerate(skill_dirs):
            if skill_dir.exists():
                source_type = 'personal' if idx == 0 else 'project'
                for skill_path in skill_dir.iterdir():
                    if skill_path.is_dir():
                        skill_md = skill_path / 'SKILL.md'
                        if skill_md.exists():
                            skill = cls._load_skill(skill_md, source_type)
                            if skill:
                                skills[skill.name] = skill

        # Scan legacy commands directory
        commands_dir = Path(project_root) / cls.COMMANDS_DIR
        if commands_dir.exists():
            for cmd_file in commands_dir.glob('*.md'):
                skill = cls._load_skill(cmd_file, 'project', is_command=True)
                if skill:
                    skills[skill.name] = skill

        return skills

    @classmethod
    def _load_skill(cls, path: Path, source_type: str, is_command: bool = False) -> Optional[Skill]:
        """Load a skill from a file."""
        try:
            content = path.read_text(encoding='utf-8')
            frontmatter, body = SkillParser.parse(content, str(path))

            # Determine skill name
            if is_command:
                name = path.stem
            else:
                name = frontmatter.name or path.parent.name

            return Skill(
                name=name,
                frontmatter=frontmatter,
                content=body,
                source_path=str(path),
                source_type=source_type,
            )
        except Exception as e:
            print(f"Warning: Failed to load skill from {path}: {e}")
            return None


class SkillManager:
    """Manage and invoke skills."""

    def __init__(self, project_root: str = '.'):
        self.project_root = project_root
        self.skills: Dict[str, Skill] = {}
        self._refresh_skills()

    def _refresh_skills(self):
        """Refresh skill discovery."""
        self.skills = SkillDiscovery.discover_skills(self.project_root)

    def list_skills(self) -> List[Dict[str, Any]]:
        """List all available skills."""
        return [
            {
                'name': skill.name,
                'description': skill.frontmatter.description or '',
                'source': skill.source_type,
                'user_invocable': skill.frontmatter.user_invocable,
                'disable_model_invocation': skill.frontmatter.disable_model_invocation,
            }
            for skill in self.skills.values()
        ]

    def get_skill(self, name: str) -> Optional[Skill]:
        """Get a skill by name."""
        return self.skills.get(name)

    def invoke_skill(
        self,
        name: str,
        arguments: str = '',
        session_id: str = '',
        effort: str = 'medium',
    ) -> Optional[str]:
        """Invoke a skill and return rendered content."""
        skill = self.get_skill(name)
        if not skill:
            return None

        # Check if user can invoke
        if not skill.frontmatter.user_invocable:
            return None

        # Apply substitutions
        skill_dir = str(Path(skill.source_path).parent)
        rendered = SkillSubstitutor.substitute(
            skill.content,
            arguments=arguments,
            session_id=session_id,
            effort=effort,
            skill_dir=skill_dir,
        )

        return rendered

    def get_available_for_model(self) -> List[Skill]:
        """Get skills that can be invoked by the model."""
        return [
            skill for skill in self.skills.values()
            if not skill.frontmatter.disable_model_invocation
        ]

    def get_user_invocable(self) -> List[Skill]:
        """Get skills that can be invoked by the user."""
        return [
            skill for skill in self.skills.values()
            if skill.frontmatter.user_invocable
        ]
