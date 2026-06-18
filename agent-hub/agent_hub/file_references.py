"""File References system - @ file and folder references.

Implements Claude Code-style file references:
- @filename syntax for referencing files
- @folder/ syntax for referencing directories
- Wildcard support (e.g., @*.py)
- Automatic content injection into context
"""

import os
import re
import glob
from pathlib import Path
from typing import List, Tuple, Optional


class FileReferenceParser:
    """Parse @ file references in user input."""

    # Pattern to match @ references
    # Matches: @filename, @folder/, @*.ext, @path/to/file
    # Uses lookbehind to avoid matching email addresses (user@domain)
    REFERENCE_PATTERN = re.compile(
        r'(?:(?<=\s)|(?<=^))@(?:'
        r'(?:[^\s*?\[\]]+)'  # Normal path
        r'|(?:[^\s*?\[\]]*[*?][^\s*?\[\]]*)'  # Wildcard path
        r')'
    )

    @classmethod
    def parse_references(cls, text: str) -> List[Tuple[str, int, int]]:
        """Parse @ references from text.

        Returns:
            List of (reference_path, start_pos, end_pos) tuples
        """
        references = []
        for match in cls.REFERENCE_PATTERN.finditer(text):
            ref_path = match.group(0)[1:]  # Remove @ prefix
            references.append((ref_path, match.start(), match.end()))
        return references

    @classmethod
    def resolve_reference(cls, ref_path: str, base_dir: str = '.') -> List[str]:
        """Resolve a file reference to actual file paths.

        Args:
            ref_path: The reference path (without @)
            base_dir: Base directory for relative paths

        Returns:
            List of resolved file paths
        """
        # Normalize base directory
        base_dir = os.path.abspath(base_dir)
        base_path = Path(base_dir)

        def is_within_base(path: str) -> bool:
            """Check if path is within base directory."""
            try:
                Path(os.path.abspath(path)).relative_to(base_path)
                return True
            except ValueError:
                return False

        # Handle absolute paths
        if os.path.isabs(ref_path):
            # Check for path traversal - absolute paths must be within base_dir
            abs_path = os.path.abspath(ref_path)
            if not is_within_base(abs_path):
                return []  # Block path traversal
            if os.path.exists(abs_path):
                return [abs_path]
            # Try glob for wildcards
            matches = glob.glob(abs_path)
            return [m for m in matches if os.path.isfile(m) and is_within_base(m)]

        # Handle relative paths
        full_path = os.path.join(base_dir, ref_path)

        # Check for path traversal
        abs_full_path = os.path.abspath(full_path)
        if not is_within_base(abs_full_path):
            return []  # Block path traversal

        # Check if it's a directory
        if os.path.isdir(full_path):
            # Return directory listing instead of content
            return [full_path]

        # Check if it's a file
        if os.path.isfile(full_path):
            return [full_path]

        # Try glob for wildcards
        matches = glob.glob(abs_full_path, recursive=True)
        if matches:
            return [m for m in matches if os.path.isfile(m) and is_within_base(m)]

        return []

    @classmethod
    def read_file_content(cls, filepath: str, max_lines: int = 2000) -> Optional[str]:
        """Read file content with size limits.

        Args:
            filepath: Path to file
            max_lines: Maximum lines to read

        Returns:
            File content or None if error
        """
        try:
            with open(filepath, 'r', encoding='utf-8', errors='replace') as f:
                lines = []
                for i, line in enumerate(f):
                    if i >= max_lines:
                        lines.append(f"\n... (truncated at {max_lines} lines)")
                        break
                    lines.append(line)
                return ''.join(lines)
        except Exception:
            return None

    @classmethod
    def read_directory_structure(cls, dirpath: str, max_depth: int = 3) -> Optional[str]:
        """Read directory structure as a tree.

        Args:
            dirpath: Path to directory
            max_depth: Maximum depth to traverse

        Returns:
            Directory tree string or None if error
        """
        try:
            lines = []
            for root, dirs, files in os.walk(dirpath):
                # Calculate depth
                depth = root.replace(dirpath, '').count(os.sep)
                if depth >= max_depth:
                    dirs.clear()
                    continue

                # Add directory
                indent = '  ' * depth
                dir_name = os.path.basename(root) or root
                lines.append(f"{indent}{dir_name}/")

                # Add files
                for file in sorted(files):
                    file_indent = '  ' * (depth + 1)
                    lines.append(f"{file_indent}{file}")

            return '\n'.join(lines)
        except Exception:
            return None


class FileReferenceResolver:
    """Resolve and inject file references into context."""

    @classmethod
    def resolve_and_format(cls, text: str, base_dir: str = '.') -> str:
        """Resolve @ references and format them for context injection.

        Args:
            text: Input text with @ references
            base_dir: Base directory for relative paths

        Returns:
            Text with references replaced by file contents
        """
        references = FileReferenceParser.parse_references(text)
        if not references:
            return text

        # Process references in reverse order to maintain positions
        result = text
        for ref_path, start, end in reversed(references):
            resolved_paths = FileReferenceParser.resolve_reference(ref_path, base_dir)

            if not resolved_paths:
                # Reference not found - add note
                replacement = f"[File not found: @{ref_path}]"
            elif len(resolved_paths) == 1:
                path = resolved_paths[0]
                if os.path.isdir(path):
                    # Directory reference - show structure
                    structure = FileReferenceParser.read_directory_structure(path)
                    if structure:
                        replacement = f"[Directory: @{ref_path}]\n{structure}"
                    else:
                        replacement = f"[Empty directory: @{ref_path}]"
                else:
                    # File reference - show content
                    content = FileReferenceParser.read_file_content(path)
                    if content:
                        filename = os.path.basename(path)
                        replacement = f"[File: @{ref_path}]\n```{filename}\n{content}\n```"
                    else:
                        replacement = f"[Cannot read: @{ref_path}]"
            else:
                # Multiple files (wildcard)
                parts = []
                for path in resolved_paths[:10]:  # Limit to 10 files
                    content = FileReferenceParser.read_file_content(path)
                    if content:
                        filename = os.path.basename(path)
                        parts.append(f"[File: {filename}]\n```{filename}\n{content}\n```")
                if len(resolved_paths) > 10:
                    parts.append(f"... and {len(resolved_paths) - 10} more files")
                replacement = '\n\n'.join(parts)

            result = result[:start] + replacement + result[end:]

        return result

    @classmethod
    def has_references(cls, text: str) -> bool:
        """Check if text contains @ references."""
        return bool(FileReferenceParser.REFERENCE_PATTERN.search(text))


def scan_completions(prefix: str, base_dir: str = '.', limit: int = 20) -> List[str]:
    """Scan filesystem for @-completion candidates matching a prefix.

    Used by both CLI (prompt_toolkit) and TUI (Textual) for interactive
    @ file completion. Returns relative paths with '/' suffix for directories.

    Args:
        prefix: The text after @ (e.g. "src/ma" for "@src/ma")
        base_dir: Base directory for relative paths
        limit: Maximum number of results

    Returns:
        List of relative paths, directories end with '/'
    """
    base_dir = os.path.abspath(base_dir)

    # Split into directory part and name prefix
    if os.sep in prefix or '/' in prefix:
        dir_part = os.path.dirname(prefix.replace('/', os.sep))
        name_prefix = os.path.basename(prefix.replace('/', os.sep))
        scan_dir = os.path.join(base_dir, dir_part) if dir_part else base_dir
    else:
        dir_part = ''
        name_prefix = prefix
        scan_dir = base_dir

    scan_dir = os.path.abspath(scan_dir)

    # Path traversal guard
    try:
        Path(scan_dir).relative_to(Path(base_dir))
    except ValueError:
        return []

    if not os.path.isdir(scan_dir):
        return []

    results = []
    try:
        entries = sorted(os.listdir(scan_dir))
    except OSError:
        return []

    for name in entries:
        if name.startswith('.'):
            continue  # Skip hidden files
        if name in ('node_modules', '__pycache__', 'venv', '.venv', 'dist', 'build'):
            continue  # Skip heavy directories for performance
        if name_prefix and not name.lower().startswith(name_prefix.lower()):
            continue

        full = os.path.join(scan_dir, name)
        if dir_part:
            rel = os.path.join(dir_part, name).replace(os.sep, '/')
        else:
            rel = name

        if os.path.isdir(full):
            rel += '/'
        results.append(rel)

        if len(results) >= limit:
            break

    return results
