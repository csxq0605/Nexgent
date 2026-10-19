"""Tests for project scanner (/init command)."""

import pytest
import os
from nexgent.project_scanner import scan_project, generate_agents_md


class TestScanProject:
    def test_detects_python_project(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text("[project]\nname = 'test'")
        result = scan_project(str(tmp_path))
        assert result["language"] == "Python"

    def test_detects_python_from_requirements(self, tmp_path):
        (tmp_path / "requirements.txt").write_text("requests>=2.0")
        result = scan_project(str(tmp_path))
        assert result["language"] == "Python"

    def test_detects_javascript_project(self, tmp_path):
        (tmp_path / "package.json").write_text('{"name": "test"}')
        result = scan_project(str(tmp_path))
        assert result["language"] == "JavaScript/TypeScript"

    def test_detects_rust_project(self, tmp_path):
        (tmp_path / "Cargo.toml").write_text('[package]\nname = "test"')
        result = scan_project(str(tmp_path))
        assert result["language"] == "Rust"

    def test_detects_go_project(self, tmp_path):
        (tmp_path / "go.mod").write_text("module test")
        result = scan_project(str(tmp_path))
        assert result["language"] == "Go"

    def test_detects_fastapi_from_requirements(self, tmp_path):
        (tmp_path / "requirements.txt").write_text("fastapi>=0.100.0\nuvicorn")
        result = scan_project(str(tmp_path))
        assert "FastAPI" in result["frameworks"]

    def test_detects_flask_from_requirements(self, tmp_path):
        (tmp_path / "requirements.txt").write_text("flask>=2.0")
        result = scan_project(str(tmp_path))
        assert "Flask" in result["frameworks"]

    def test_detects_pytest_runner(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text(
            "[project]\nname='t'\n[tool.pytest.ini_options]\ntestpaths=['tests']"
        )
        result = scan_project(str(tmp_path))
        assert result["test_runner"] == "pytest"

    def test_detects_ruff_linter(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text(
            "[project]\nname='t'\n[tool.ruff]\nline-length=88"
        )
        result = scan_project(str(tmp_path))
        assert result["linter"] == "ruff"

    def test_detects_nothing_in_empty_dir(self, tmp_path):
        result = scan_project(str(tmp_path))
        assert result["language"] == "unknown"
        assert result["frameworks"] == []
        assert result["test_runner"] is None
        assert result["linter"] is None

    def test_scans_key_files(self, tmp_path):
        (tmp_path / "src").mkdir()
        (tmp_path / "tests").mkdir()
        (tmp_path / "README.md").write_text("# Test")
        (tmp_path / "pyproject.toml").write_text("[project]\nname='t'")
        result = scan_project(str(tmp_path))
        assert "src/" in result["key_files"]
        assert "tests/" in result["key_files"]
        assert "README.md" in result["key_files"]

    def test_derives_python_commands(self, tmp_path):
        (tmp_path / "pyproject.toml").write_text(
            "[project]\nname='t'\n[tool.pytest.ini_options]\n[tool.ruff]"
        )
        result = scan_project(str(tmp_path))
        assert result["install_cmd"] == "pip install -e ."
        assert result["test_cmd"] == "pytest"
        assert result["lint_cmd"] == "ruff check ."

    def test_derives_js_commands(self, tmp_path):
        (tmp_path / "package.json").write_text('{"name": "t", "scripts": {"test": "jest"}}')
        result = scan_project(str(tmp_path))
        assert result["install_cmd"] == "npm install"


class TestGenerateAgentsMd:
    def test_generates_codex_style_output(self):
        scan = {
            "language": "Python",
            "frameworks": ["FastAPI"],
            "test_runner": "pytest",
            "linter": "ruff",
            "formatter": "black",
            "key_files": ["src/", "tests/"],
            "install_cmd": "pip install -e .",
            "test_cmd": "pytest",
            "lint_cmd": "ruff check .",
        }
        md = generate_agents_md(scan)
        assert "# AGENTS.md" in md
        assert "## Workflow Commands" in md
        assert "## Code Style" in md
        assert "## Testing" in md
        assert "## Dependencies" in md
        assert "## Conventions" in md
        assert "pip install -e ." in md
        assert "pytest" in md
        assert "ruff check ." in md
        assert "black ." in md
        assert "`src/`" in md

    def test_prescriptive_language(self):
        scan = {"language": "Python", "frameworks": [], "test_runner": None,
                "linter": None, "formatter": None, "key_files": [],
                "install_cmd": None, "test_cmd": None, "lint_cmd": None}
        md = generate_agents_md(scan)
        assert "Always" in md
        assert "Never" in md
        assert "Prefer" in md

    def test_includes_detected_commands(self):
        scan = {
            "language": "Python",
            "frameworks": [],
            "test_runner": "pytest",
            "linter": None,
            "formatter": None,
            "key_files": [],
            "install_cmd": "pip install -r requirements.txt",
            "test_cmd": "python -m pytest",
            "lint_cmd": None,
        }
        md = generate_agents_md(scan)
        assert "pip install -r requirements.txt" in md
        assert "python -m pytest" in md

    def test_python_style_rules(self):
        scan = {"language": "Python", "frameworks": [], "test_runner": None,
                "linter": None, "formatter": None, "key_files": [],
                "install_cmd": None, "test_cmd": None, "lint_cmd": None}
        md = generate_agents_md(scan)
        assert "type hints" in md.lower()
        assert "pathlib" in md
        assert "f-strings" in md

    def test_rust_style_rules(self):
        scan = {"language": "Rust", "frameworks": [], "test_runner": None,
                "linter": None, "formatter": None, "key_files": [],
                "install_cmd": None, "test_cmd": None, "lint_cmd": None}
        md = generate_agents_md(scan)
        assert "clippy" in md
        assert "cargo fmt" in md
        assert "unwrap()" in md

    def test_go_style_rules(self):
        scan = {"language": "Go", "frameworks": [], "test_runner": None,
                "linter": None, "formatter": None, "key_files": [],
                "install_cmd": None, "test_cmd": None, "lint_cmd": None}
        md = generate_agents_md(scan)
        assert "gofmt" in md
        assert "context.Context" in md
        assert "table-driven" in md

    def test_placeholders_when_no_commands(self):
        scan = {"language": "unknown", "frameworks": [], "test_runner": None,
                "linter": None, "formatter": None, "key_files": [],
                "install_cmd": None, "test_cmd": None, "lint_cmd": None}
        md = generate_agents_md(scan)
        assert "<!-- e.g." in md  # placeholders present
