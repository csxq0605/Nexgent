"""Project scanner - detect language, framework, tools for AGENTS.md generation.

Used by /init command to analyze a project directory and generate
standardized AGENTS.md instructions for the agent.
"""

import os
from pathlib import Path


# File-based language detection
LANGUAGE_MARKERS = {
    "pyproject.toml": "Python",
    "setup.py": "Python",
    "setup.cfg": "Python",
    "requirements.txt": "Python",
    "Pipfile": "Python",
    "package.json": "JavaScript/TypeScript",
    "tsconfig.json": "TypeScript",
    "Cargo.toml": "Rust",
    "go.mod": "Go",
    "pom.xml": "Java",
    "build.gradle": "Java",
    "build.gradle.kts": "Java",
    "Gemfile": "Ruby",
    "composer.json": "PHP",
    "CMakeLists.txt": "C/C++",
    "pubspec.yaml": "Dart",
}

# Framework detection from dependency files
_FRAMEWORK_DEPS = {
    "django": "Django",
    "flask": "Flask",
    "fastapi": "FastAPI",
    "starlette": "FastAPI",
    "tornado": "Tornado",
    "next": "Next.js",
    "nuxt": "Nuxt.js",
    "react": "React",
    "vue": "Vue.js",
    "svelte": "Svelte",
    "angular": "Angular",
    "express": "Express",
    "koa": "Koa",
    "actix-web": "Actix Web",
    "axum": "Axum",
    "rocket": "Rocket",
}

# Test runner detection
TEST_MARKERS = {
    "pytest.ini": "pytest",
    "conftest.py": "pytest",
    "jest.config.js": "jest",
    "jest.config.ts": "jest",
    "jest.config.mjs": "jest",
    "vitest.config.js": "vitest",
    "vitest.config.ts": "vitest",
    ".mocharc.yml": "mocha",
    ".mocharc.js": "mocha",
}

# Linter detection
LINTER_MARKERS = {
    ".eslintrc.js": "eslint",
    ".eslintrc.json": "eslint",
    ".eslintrc.yml": "eslint",
    "eslint.config.js": "eslint",
    "eslint.config.mjs": "eslint",
    ".flake8": "flake8",
    ".pylintrc": "pylint",
    "ruff.toml": "ruff",
    ".ruff.toml": "ruff",
    "biome.json": "biome",
    ".golangci.yml": "golangci-lint",
}

# Formatter detection
FORMATTER_MARKERS = {
    ".prettierrc": "prettier",
    ".prettierrc.json": "prettier",
    ".prettierrc.yml": "prettier",
    ".editorconfig": "editorconfig",
    "biome.json": "biome",
    ".stylua.toml": "stylua",
    "rustfmt.toml": "rustfmt",
}

# Key directories/files to highlight
KEY_PATTERNS = [
    "src/", "lib/", "app/", "tests/", "test/", "spec/",
    "docs/", "scripts/", "config/", "public/", "static/",
    "README.md", "LICENSE", "Makefile", "Dockerfile",
    "docker-compose.yml", ".github/",
]


def _read_file_head(path: str, max_lines: int = 50) -> str:
    """Read first N lines of a file safely."""
    try:
        with open(path, "r", encoding="utf-8", errors="ignore") as f:
            lines = []
            for i, line in enumerate(f):
                if i >= max_lines:
                    break
                lines.append(line)
            return "".join(lines)
    except Exception:
        return ""


def _detect_frameworks_from_deps(content: str) -> list[str]:
    """Detect frameworks from dependency file content."""
    import re
    content_lower = content.lower()
    found = []
    for dep, framework in _FRAMEWORK_DEPS.items():
        # Match dependency name at word boundary (requirements.txt: flask==2.0,
        # package.json: "react": "^18"). Avoids false positives like "overreact".
        pattern = r'(^|[\s"\',=<>!:;])' + re.escape(dep) + r'([\s"\',=<>!:;]|$)'
        if re.search(pattern, content_lower, re.MULTILINE):
            if framework not in found:
                found.append(framework)
    return found


def _detect_pyproject_tools(content: str) -> dict:
    """Detect tools configured in pyproject.toml."""
    result = {}
    content_lower = content.lower()

    if "[tool.pytest" in content_lower or "[tool:pytest" in content_lower:
        result["test_runner"] = "pytest"
    if "[tool.ruff" in content_lower:
        result["linter"] = "ruff"
    if "[tool.black" in content_lower:
        result["formatter"] = "black"
    if "[tool.mypy" in content_lower:
        result["type_checker"] = "mypy"

    return result


def _detect_package_json_tools(content: str) -> dict:
    """Detect tools from package.json."""
    result = {}
    content_lower = content.lower()

    if '"jest"' in content_lower or '"vitest"' in content_lower:
        if '"vitest"' in content_lower:
            result["test_runner"] = "vitest"
        else:
            result["test_runner"] = "jest"
    if '"eslint"' in content_lower:
        result["linter"] = "eslint"
    if '"prettier"' in content_lower:
        result["formatter"] = "prettier"

    return result


def _derive_commands(language: str, test_runner: str | None, linter: str | None, has_setup: bool) -> dict:
    """Derive install/test/lint commands from detected tools."""
    cmds = {}

    if language == "Python":
        if has_setup:
            cmds["install"] = "pip install -e ."
        else:
            cmds["install"] = "pip install -r requirements.txt"
        if test_runner == "pytest":
            cmds["test"] = "pytest"
        else:
            cmds["test"] = "python -m pytest"
        if linter == "ruff":
            cmds["lint"] = "ruff check ."
        elif linter == "flake8":
            cmds["lint"] = "flake8 ."
        elif linter == "pylint":
            cmds["lint"] = "pylint ."
    elif language in ("JavaScript/TypeScript", "TypeScript"):
        cmds["install"] = "npm install"
        if test_runner == "jest":
            cmds["test"] = "npm test"
        elif test_runner == "vitest":
            cmds["test"] = "npx vitest run"
        else:
            cmds["test"] = "npm test"
        if linter == "eslint":
            cmds["lint"] = "npx eslint ."
    elif language == "Rust":
        cmds["install"] = "cargo build"
        cmds["test"] = "cargo test"
        cmds["lint"] = "cargo clippy"
    elif language == "Go":
        cmds["install"] = "go build ./..."
        cmds["test"] = "go test ./..."
        cmds["lint"] = "golangci-lint run"

    return cmds


def scan_project(project_dir: str = ".") -> dict:
    """Scan project directory for language, framework, tools.

    Returns dict with keys:
        language, frameworks, test_runner, linter, formatter,
        key_files, install_cmd, test_cmd, lint_cmd
    """
    project_dir = os.path.abspath(project_dir)

    # List top-level files and dirs
    try:
        entries = set(os.listdir(project_dir))
    except Exception:
        return {"language": "unknown", "frameworks": [], "test_runner": None,
                "linter": None, "formatter": None, "key_files": [],
                "install_cmd": None, "test_cmd": None, "lint_cmd": None}

    # Detect language
    language = "unknown"
    for marker, lang in LANGUAGE_MARKERS.items():
        if marker in entries:
            language = lang
            break

    # Detect frameworks from dependency files
    frameworks = []
    dep_content = ""
    for dep_file in ["requirements.txt", "pyproject.toml", "package.json", "Cargo.toml", "go.mod"]:
        if dep_file in entries:
            dep_content = _read_file_head(os.path.join(project_dir, dep_file))
            frameworks.extend(_detect_frameworks_from_deps(dep_content))
            break

    # Detect tools from pyproject.toml
    tool_info = {}
    if "pyproject.toml" in entries:
        py_content = _read_file_head(os.path.join(project_dir, "pyproject.toml"), max_lines=100)
        tool_info = _detect_pyproject_tools(py_content)

    # Detect tools from package.json
    if "package.json" in entries and not tool_info:
        pkg_content = _read_file_head(os.path.join(project_dir, "package.json"))
        tool_info = _detect_package_json_tools(pkg_content)

    # Detect from marker files
    test_runner = tool_info.get("test_runner")
    if not test_runner:
        for marker, runner in TEST_MARKERS.items():
            if marker in entries:
                test_runner = runner
                break

    linter = tool_info.get("linter")
    if not linter:
        for marker, lint in LINTER_MARKERS.items():
            if marker in entries:
                linter = lint
                break

    formatter = tool_info.get("formatter")
    if not formatter:
        for marker, fmt in FORMATTER_MARKERS.items():
            if marker in entries:
                formatter = fmt
                break

    # Detect key files/dirs
    key_files = []
    for pattern in KEY_PATTERNS:
        if pattern.endswith("/"):
            if pattern.rstrip("/") in entries:
                key_files.append(pattern)
        else:
            if pattern in entries:
                key_files.append(pattern)

    # Derive commands
    has_setup = "pyproject.toml" in entries or "setup.py" in entries
    cmds = _derive_commands(language, test_runner, linter, has_setup)

    return {
        "language": language,
        "frameworks": frameworks,
        "test_runner": test_runner,
        "linter": linter,
        "formatter": formatter,
        "key_files": key_files,
        "install_cmd": cmds.get("install"),
        "test_cmd": cmds.get("test"),
        "lint_cmd": cmds.get("lint"),
    }


def generate_agents_md(scan_result: dict) -> str:
    """Generate AGENTS.md template following Codex specification.

    The generated file is a prescriptive template — the user fills in
    project-specific rules. Auto-detected info (language, commands) is
    pre-filled; sections that need human input have placeholders.
    """
    lang = scan_result.get("language", "unknown")
    fw = scan_result.get("frameworks", [])
    install = scan_result.get("install_cmd")
    test_cmd = scan_result.get("test_cmd")
    lint_cmd = scan_result.get("lint_cmd")
    tr = scan_result.get("test_runner")
    li = scan_result.get("linter")
    fm = scan_result.get("formatter")
    kf = scan_result.get("key_files", [])

    lines = []
    lines.append("# AGENTS.md")
    lines.append("")

    # ── Workflow Commands ──
    lines.append("## Workflow Commands")
    lines.append("")
    lines.append("<!-- Pre-fill detected commands. Edit to match your project. -->")
    lines.append("")
    if install:
        lines.append(f"- **Install dependencies**: `{install}`")
    else:
        lines.append("- **Install dependencies**: `<!-- e.g. pip install -e . -->`")
    if test_cmd:
        lines.append(f"- **Run all tests**: `{test_cmd}`")
    else:
        lines.append("- **Run all tests**: `<!-- e.g. pytest -->`")
    if tr == "pytest":
        lines.append("- **Run single test**: `pytest tests/test_<name>.py::TestClass::test_method`")
    if lint_cmd:
        lines.append(f"- **Lint**: `{lint_cmd}`")
    else:
        lines.append("- **Lint**: `<!-- e.g. ruff check . -->`")
    if fm == "black":
        lines.append("- **Format**: `black .`")
    elif fm == "prettier":
        lines.append("- **Format**: `npx prettier --write .`")
    else:
        lines.append("- **Format**: `<!-- e.g. black . / npx prettier --write . -->`")
    lines.append("- **Type check**: `<!-- e.g. mypy . / tsc --noEmit -->`")
    lines.append("")
    lines.append("Always run lint and tests before committing. Do not skip hooks.")
    lines.append("")

    # ── Code Style ──
    lines.append("## Code Style")
    lines.append("")
    if lang == "Python":
        lines.append("- Always use type hints on function signatures")
        lines.append("- Always use `ruff` or `black` for formatting; never mix styles")
        lines.append("- Prefer f-strings over `.format()` or `%` formatting")
        lines.append("- Prefer `pathlib.Path` over `os.path`")
        lines.append("- Use `dataclass` or `pydantic` for structured data; avoid raw dicts")
        lines.append("- Never use `eval()` or `exec()` on untrusted input")
        lines.append("- Prefer `asyncio` over threading for I/O-bound concurrency")
        lines.append("- Write docstrings for public functions and classes")
    elif lang in ("JavaScript/TypeScript", "TypeScript"):
        lines.append("- Always use TypeScript for new files; never add plain `.js`")
        lines.append("- Prefer `const` over `let`; never use `var`")
        lines.append("- Prefer `async/await` over raw Promises or callbacks")
        lines.append("- Use `interface` for object shapes; `type` for unions/intersections")
        lines.append("- Always handle Promise rejections")
        lines.append("- Prefer named exports over default exports")
    elif lang == "Rust":
        lines.append("- Always run `cargo fmt` after changes")
        lines.append("- Always run `cargo clippy` and fix all warnings")
        lines.append("- Prefer `Result<T, E>` over panics; never use `unwrap()` in production code")
        lines.append("- Use `thiserror` for library errors, `anyhow` for application errors")
        lines.append("- Prefer iterators and combinators over manual loops")
        lines.append("- Write doc comments (`///`) on all public items")
        lines.append("- Make `match` exhaustive; avoid wildcard arms")
    elif lang == "Go":
        lines.append("- Always run `gofmt` and `goimports`")
        lines.append("- Handle errors explicitly; never use `_` for error returns")
        lines.append("- Prefer table-driven tests")
        lines.append("- Use `context.Context` for cancellation and timeouts")
        lines.append("- Keep interfaces small (1-3 methods)")
        lines.append("- Write doc comments on all exported symbols")
    else:
        lines.append("- Follow existing code style in the project")
        lines.append("- <!-- Add project-specific style rules here -->")
    lines.append("")

    # ── Project Structure ──
    lines.append("## Project Structure")
    lines.append("")
    if kf:
        for f in kf:
            if f.endswith("/"):
                lines.append(f"- `{f}` — <!-- describe purpose -->")
            else:
                lines.append(f"- `{f}` — <!-- describe purpose -->")
    else:
        lines.append("<!-- Describe key directories and files -->")
        lines.append("- `src/` — source code")
        lines.append("- `tests/` — test files")
    lines.append("")

    # ── Testing ──
    lines.append("## Testing")
    lines.append("")
    if tr:
        lines.append(f"- Test runner: **{tr}**")
    else:
        lines.append("- Test runner: <!-- e.g. pytest, jest, cargo test -->")
    lines.append("- Always write tests for new functionality")
    lines.append("- Always run the full test suite before finalizing changes")
    lines.append("- Prefer unit tests for logic, integration tests for I/O")
    lines.append("- <!-- Add project-specific testing rules here -->")
    lines.append("")

    # ── Dependencies ──
    lines.append("## Dependencies")
    lines.append("")
    lines.append("- Never add dependencies without explicit user approval")
    lines.append("- Prefer well-maintained, widely-used packages")
    lines.append("- <!-- Add dependency management rules here -->")
    lines.append("")

    # ── Conventions ──
    lines.append("## Conventions")
    lines.append("")
    lines.append("<!-- Add project-specific conventions, patterns, and anti-patterns -->")
    lines.append("")
    lines.append("- <!-- e.g. Always use DI for external services -->")
    lines.append("- <!-- e.g. Never commit secrets; use .env files -->")
    lines.append("- <!-- e.g. Error messages must be user-friendly -->")
    lines.append("")

    return "\n".join(lines)
