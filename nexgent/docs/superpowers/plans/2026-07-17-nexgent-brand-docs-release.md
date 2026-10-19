# Nexgent Agent Relay Brand, Documentation, and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the selected Agent Relay identity, package it throughout the desktop app, update Markdown and screenshots, and prove the complete GUI/TUI/CLI product runs from a built distribution.

**Architecture:** A canonical `branding.py` defines product language and asset paths. A deterministic Pillow script renders the selected relay geometry into application, transparent-mark, title, and documentation assets; GUI screenshot scripts use sanitized fake runtime data; release verification builds and installs the package in an isolated environment.

**Tech Stack:** Python 3.10+, imagegen concept exploration, Pillow 10+, PyQt6, setuptools/wheel, pytest, existing Nexgent runtime and GUI.

## Global Constraints

- Complete the runtime and desktop GUI plans first.
- Selected concept is B, Agent Relay; do not substitute the Manyselves multi-face cube.
- Palette values are `#171D3B`, `#080B1D`, `#4B63FF`, `#8D43FF`, `#22D3EE`, and `#E3E7FF`.
- Brand assets and screenshots must never contain API keys, real user paths, or private session content.
- `nexgent/branding.py` is the single source for product name, tagline, descriptor, and icon path.
- Generated assets must be repeatable from checked-in scripts and source geometry.
- Documentation must describe only behavior verified in the current checkout.

---

## File Structure

| Path | Responsibility |
| --- | --- |
| `nexgent/branding.py` | Canonical public identity and packaged asset paths |
| `nexgent/resources/icon.png` | Packaged 1024 px application icon |
| `assets/brand/nexgent-mark.png` | Transparent Agent Relay mark |
| `assets/brand/nexgent-mark-dark.png` | Mark presented on dark background |
| `assets/brand/nexgent-app-icon.png` | Rounded application export |
| `assets/brand/nexgent-title.png` | README title banner |
| `assets/brand/README.md` | Palette, safe area, size, misuse rules |
| `docs/brand.md` | Product identity, voice, naming, UI copy contract |
| `scripts/build_brand_assets.py` | Deterministic Pillow renderer |
| `scripts/capture_gui_screenshots.py` | Sanitized Qt screenshot capture |
| `assets/screenshots/*.png` | Start, configuration, main workspace, control-center images |
| `README.md` | Desktop-first product documentation with complete CLI/TUI compatibility |
| `tests/test_branding.py` | Constants, paths, dimensions, package metadata |
| `tests/gui/test_branding_surfaces.py` | Visible product-copy and icon tests |
| `tests/test_distribution.py` | Wheel/sdist content and clean-install smoke helpers |

## Task 1: Finalize Agent Relay reference and canonical identity

**Files:**
- Create: `nexgent/branding.py`
- Create: `assets/brand/agent-relay-reference.png`
- Create: `tests/test_branding.py`

**Interfaces:**
- Produces: `PRODUCT_NAME`, `TAGLINE`, `DESCRIPTOR_EN`, `DESCRIPTOR_ZH`, `APP_ICON_PATH`, `__version__` integration.
- Consumes: selected browser direction B and package version from `nexgent.__init__`.

- [ ] **Step 1: Use the `imagegen` skill for one polished Agent Relay reference**

Generate a square application-icon reference with this exact direction: deep indigo rounded-square field; two connected forward relay forms; one pale source node and one cyan destination node; blue-to-violet-to-cyan material; strong silhouette; no text; no letters; no cube; no photorealism; no mock device frame. Save the selected result as `assets/brand/agent-relay-reference.png`. This file is visual guidance, not the deterministic production master.

- [ ] **Step 2: Write failing identity tests**

```python
from pathlib import Path

from nexgent.branding import (
    APP_ICON_PATH,
    DESCRIPTOR_EN,
    DESCRIPTOR_ZH,
    PRODUCT_NAME,
    TAGLINE,
)

ROOT = Path(__file__).resolve().parents[1]


def test_nexgent_brand_contract():
    assert PRODUCT_NAME == "Nexgent"
    assert TAGLINE == "Agents in motion."
    assert DESCRIPTOR_EN == "A production-grade model-agnostic Agent Harness."
    assert DESCRIPTOR_ZH == "生产级、模型无关的 Agent Harness"
    assert APP_ICON_PATH == ROOT / "nexgent/resources/icon.png"
```

- [ ] **Step 3: Run the test and verify missing module**

Run: `.venv/bin/python -m pytest tests/test_branding.py -q`  
Expected: import failure for `nexgent.branding`.

- [ ] **Step 4: Implement canonical identity**

```python
from pathlib import Path

PRODUCT_NAME = "Nexgent"
TAGLINE = "Agents in motion."
DESCRIPTOR_EN = "A production-grade model-agnostic Agent Harness."
DESCRIPTOR_ZH = "生产级、模型无关的 Agent Harness"
APP_ICON_PATH = Path(__file__).resolve().parent / "resources" / "icon.png"
```

Replace duplicated product strings in the GUI window titles and start window with imports from this module. Do not yet assert icon existence until Task 2 creates it.

- [ ] **Step 5: Run identity and GUI copy tests**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/test_branding.py tests/gui/test_project_dialog.py tests/gui/test_main_window.py -q`  
Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add nexgent/branding.py assets/brand/agent-relay-reference.png tests/test_branding.py nexgent/gui/app.py nexgent/gui/project_dialog.py nexgent/gui/main_window.py
git commit -m "feat: establish Nexgent Agent Relay identity"
```

## Task 2: Deterministic Agent Relay asset builder

**Files:**
- Modify: `setup.py`
- Create: `scripts/build_brand_assets.py`
- Create: `assets/brand/README.md`
- Create: `assets/brand/nexgent-mark.png`
- Create: `assets/brand/nexgent-mark-dark.png`
- Create: `assets/brand/nexgent-app-icon.png`
- Create: `assets/brand/nexgent-title.png`
- Create: `nexgent/resources/__init__.py`
- Create: `nexgent/resources/icon.png`
- Modify: `tests/test_branding.py`

**Interfaces:**
- Produces: repeatable PNG exports and package resource.
- Consumes: constants from Task 1 and Pillow in the dev extra.

- [ ] **Step 1: Add failing asset dimension and palette tests**

```python
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def test_brand_exports_exist_with_expected_dimensions():
    expected = {
        "assets/brand/nexgent-mark.png": (1024, 1024),
        "assets/brand/nexgent-mark-dark.png": (1024, 1024),
        "assets/brand/nexgent-app-icon.png": (1024, 1024),
        "assets/brand/nexgent-title.png": (1400, 420),
        "nexgent/resources/icon.png": (1024, 1024),
    }
    for relative, size in expected.items():
        image = Image.open(ROOT / relative)
        assert image.size == size


def test_transparent_mark_has_alpha_and_visible_bounds():
    image = Image.open(ROOT / "assets/brand/nexgent-mark.png").convert("RGBA")
    assert image.getchannel("A").getbbox() is not None
    assert image.getchannel("A").getextrema() == (0, 255)
```

- [ ] **Step 2: Add Pillow to the dev extra and verify tests fail for missing assets**

Add `Pillow>=10.0.0,<12.0.0` and `wheel>=0.43.0` to `extras_require["dev"]`.

Run: `.venv/bin/python -m pytest tests/test_branding.py -q`  
Expected: asset existence/dimension assertions fail.

- [ ] **Step 3: Implement relay geometry in the deterministic builder**

The script creates all parent directories and defines this stable geometry:

```python
def draw_relay_mark(size: int = 1024) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    scale = size / 1024

    def points(values):
        return [(round(x * scale), round(y * scale)) for x, y in values]

    left = points(((180, 330), (500, 330), (660, 512), (500, 694), (180, 694), (340, 512)))
    right = points(((494, 330), (690, 330), (850, 512), (690, 694), (494, 694), (654, 512)))
    draw.polygon(left, fill="#4B63FF")
    draw.polygon(right, fill="#8D43FF")
    node_radius = round(54 * scale)
    for x, y, color in ((340, 512, "#E3E7FF"), (654, 512, "#22D3EE")):
        cx, cy = round(x * scale), round(y * scale)
        draw.ellipse((cx-node_radius, cy-node_radius, cx+node_radius, cy+node_radius), fill=color)
    return canvas
```

Add antialiasing by drawing at 2x and downsampling. Add restrained gradients inside clipped relay polygons without changing the outer silhouette. Build the dark presentation, rounded-square icon, packaged icon, and title banner from that mark.

- [ ] **Step 4: Document brand use rules**

`assets/brand/README.md` records exact colors, 12.5% minimum clear space, 16 px minimum UI size, dark/light background variants, and prohibited modifications: rotation, cube substitution, unapproved colors, effects that weaken the nodes, or embedding text inside the icon.

- [ ] **Step 5: Build assets twice and verify determinism**

Run:

```bash
.venv/bin/python scripts/build_brand_assets.py
shasum -a 256 assets/brand/nexgent-mark.png nexgent/resources/icon.png > /tmp/nexgent-brand-first.sha
.venv/bin/python scripts/build_brand_assets.py
shasum -a 256 -c /tmp/nexgent-brand-first.sha
```

Expected: both files report `OK`.

- [ ] **Step 6: Run brand tests**

Run: `.venv/bin/python -m pytest tests/test_branding.py -q`  
Expected: all tests pass.

- [ ] **Step 7: Commit**

```bash
git add setup.py scripts/build_brand_assets.py assets/brand nexgent/resources tests/test_branding.py
git commit -m "feat: add deterministic Agent Relay assets"
```

## Task 3: Apply brand to every desktop surface

**Files:**
- Modify: `nexgent/gui/app.py`
- Modify: `nexgent/gui/project_dialog.py`
- Modify: `nexgent/gui/main_window.py`
- Modify: `nexgent/gui/config_dialog.py`
- Modify: `nexgent/gui/title_bar.py`
- Modify: `nexgent/display.py`
- Create: `tests/gui/test_branding_surfaces.py`

**Interfaces:**
- Consumes: `nexgent.branding` and packaged icon from Tasks 1-2.
- Produces: consistent GUI and terminal identity.

- [ ] **Step 1: Write failing visible-surface tests**

```python
from PyQt6.QtWidgets import QLabel


def label_text(widget) -> str:
    return "\n".join(label.text() for label in widget.findChildren(QLabel))


def test_project_dialog_uses_nexgent_identity(qtbot, project_dialog):
    qtbot.addWidget(project_dialog)
    assert project_dialog.windowTitle() == "Nexgent"
    assert "Agents in motion." in label_text(project_dialog)
    assert not project_dialog.windowIcon().isNull()


def test_main_window_has_project_and_product_title(qtbot, main_window):
    qtbot.addWidget(main_window)
    assert main_window.windowTitle().endswith(" — Nexgent")
```

Add assertions that AutoReport, Manyselves, physics-report terms, the Manyselves tagline, and the old MiMo-only CLI description do not appear on Nexgent GUI surfaces.

- [ ] **Step 2: Run surface tests and record failures**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/test_branding_surfaces.py -q`  
Expected: failures where strings/icons are still duplicated or absent.

- [ ] **Step 3: Replace duplicated identity with canonical constants**

Set QApplication name/display name/icon, dialog titles, main-window title, About text, configuration header, and start-window descriptor from `nexgent.branding`. Update the terminal banner to use the same name/version/descriptor while retaining terminal layout.

- [ ] **Step 4: Run brand surface and display tests**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui/test_branding_surfaces.py tests/test_display.py tests/test_branding.py -q`  
Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add nexgent/gui nexgent/display.py tests/gui/test_branding_surfaces.py
git commit -m "feat: apply Nexgent identity across product surfaces"
```

## Task 4: Capture sanitized GUI screenshots

**Files:**
- Create: `scripts/capture_gui_screenshots.py`
- Create: `assets/screenshots/start-window.png`
- Create: `assets/screenshots/configuration-window.png`
- Create: `assets/screenshots/main-window.png`
- Create: `assets/screenshots/control-center.png`
- Create: `tests/test_screenshots.py`

**Interfaces:**
- Consumes: GUI test-mode runtime and finished brand surfaces.
- Produces: deterministic documentation screenshots with no secrets.

- [ ] **Step 1: Write failing screenshot contract tests**

```python
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def test_documentation_screenshots_exist_and_are_large_enough():
    for name in ("start-window.png", "configuration-window.png", "main-window.png", "control-center.png"):
        image = Image.open(ROOT / "assets/screenshots" / name)
        assert image.width >= 720
        assert image.height >= 480
```

- [ ] **Step 2: Run test and verify missing screenshots**

Run: `.venv/bin/python -m pytest tests/test_screenshots.py -q`  
Expected: file-not-found failures.

- [ ] **Step 3: Implement sanitized screenshot capture**

The script sets `QT_QPA_PLATFORM=offscreen`, creates a temporary project named `sample-project`, injects the deterministic fake runtime used by GUI tests, and renders: start window, configuration with fake provider `Example Provider` and masked key reference `${EXAMPLE_API_KEY}`, main workspace with sample files/events, and an expanded control center. Use `widget.grab().save()` and raise if any image fails to save.

- [ ] **Step 4: Capture and inspect screenshots**

Run: `QT_QPA_PLATFORM=offscreen .venv/bin/python scripts/capture_gui_screenshots.py`  
Expected: four PNG files written. Inspect each rendered image and confirm no clipping, blank panels, real paths, secrets, AutoReport, or Manyselves strings.

- [ ] **Step 5: Run screenshot tests**

Run: `.venv/bin/python -m pytest tests/test_screenshots.py -q`  
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/capture_gui_screenshots.py assets/screenshots tests/test_screenshots.py
git commit -m "docs: capture Nexgent desktop screenshots"
```

## Task 5: Desktop-first README and brand documentation

**Files:**
- Modify: `README.md`
- Create: `docs/brand.md`
- Create: `tests/test_documentation.py`

**Interfaces:**
- Consumes: verified commands, screenshots, and brand constants.
- Produces: accurate desktop-first documentation.

- [ ] **Step 1: Write failing documentation consistency tests**

```python
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_readme_documents_all_supported_frontends():
    readme = (ROOT / "README.md").read_text(encoding="utf-8")
    assert "assets/brand/nexgent-title.png" in readme
    assert "nexgent --tui" in readme
    assert "nexgent --task" in readme
    assert "--output-format stream-json" in readme
    assert "assets/screenshots/main-window.png" in readme


def test_brand_doc_uses_canonical_palette():
    brand = (ROOT / "docs/brand.md").read_text(encoding="utf-8")
    for color in ("#171D3B", "#080B1D", "#4B63FF", "#8D43FF", "#22D3EE", "#E3E7FF"):
        assert color in brand
```

- [ ] **Step 2: Run tests and verify documentation gaps**

Run: `.venv/bin/python -m pytest tests/test_documentation.py -q`  
Expected: assertions fail until README and brand documentation are updated.

- [ ] **Step 3: Rewrite README around the desktop product**

Lead with title art, one-sentence descriptor, platform/Python/PyQt/license badges, main-window screenshot, and GUI quick start. Preserve the existing detailed Harness feature inventory, configuration schema, full slash-command table, permissions, architecture, examples, and development commands. Add start/config/control-center screenshots, explicit `nexgent --tui` compatibility, non-interactive routing rules, and links to `docs/brand.md` and the design document.

- [ ] **Step 4: Write the brand contract**

Document product name capitalization, Agent Relay meaning, tagline, descriptors, voice, approved colors, mark variants, safe area, minimum size, screenshot rules, UI copy vocabulary, and the rule that AutoReport/Manyselves are design lineage rather than Nexgent product names.

- [ ] **Step 5: Verify every documented command against the parser**

Run: `.venv/bin/python -m nexgent.cli --help` and compare flags with README. Run a small test that extracts slash-command roots from README and asserts each appears in `nexgent.commands.SLASH_COMMANDS`.

- [ ] **Step 6: Run documentation tests**

Run: `.venv/bin/python -m pytest tests/test_documentation.py tests/test_cli.py -q`  
Expected: all selected tests pass.

- [ ] **Step 7: Commit**

```bash
git add README.md docs/brand.md tests/test_documentation.py
git commit -m "docs: present Nexgent desktop product and brand"
```

## Task 6: Package, install, and full completion audit

**Files:**
- Modify: `setup.py`
- Create: `MANIFEST.in`
- Create: `tests/test_distribution.py`

**Interfaces:**
- Consumes: all previous runtime, GUI, brand, and documentation tasks.
- Produces: distributable package containing GUI resources and working entry point.

- [ ] **Step 1: Write failing package-content tests**

```python
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_setup_includes_gui_resources():
    setup_text = (ROOT / "setup.py").read_text(encoding="utf-8")
    manifest = (ROOT / "MANIFEST.in").read_text(encoding="utf-8")
    assert "include_package_data=True" in setup_text
    assert "recursive-include nexgent/resources" in manifest
    assert "recursive-include nexgent/gui" in manifest
```

Add a wheel inspection helper that asserts `nexgent/resources/icon.png`, GUI Python modules, and widget SVG/font resources are present.

- [ ] **Step 2: Run distribution tests and verify packaging gaps**

Run: `.venv/bin/python -m pytest tests/test_distribution.py -q`  
Expected: failure until manifest/package data is configured.

- [ ] **Step 3: Configure resource packaging**

Set `include_package_data=True`. Add package data for `resources/*.png`, widget `*.svg`, and `*.ttf`. Add `MANIFEST.in` entries for runtime package resources plus brand/docs assets included in sdist. Keep tests and screenshots out of the installed wheel unless explicitly needed at runtime.

- [ ] **Step 4: Run focused and full automated verification**

```bash
QT_QPA_PLATFORM=offscreen .venv/bin/python -m pytest tests/gui tests/test_runtime_events.py tests/test_runtime_interactions.py tests/test_command_service.py tests/test_runtime_service.py tests/test_frontend_routing.py tests/test_branding.py tests/test_screenshots.py tests/test_documentation.py tests/test_distribution.py -q
.venv/bin/python -m pytest -q -m "not e2e and not slow"
.venv/bin/ruff check nexgent tests scripts
.venv/bin/python -m compileall -q nexgent
.venv/bin/python run_tests.py
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Build and inspect artifacts**

```bash
.venv/bin/python setup.py sdist bdist_wheel
.venv/bin/python -m pytest tests/test_distribution.py -q
```

Expected: sdist and wheel are created; inspection tests pass.

- [ ] **Step 6: Clean-install smoke in an isolated environment**

```bash
.venv/bin/python -m venv /tmp/nexgent-gui-release-venv
/tmp/nexgent-gui-release-venv/bin/pip install dist/nexgent-*.whl
QT_QPA_PLATFORM=offscreen NEXGENT_GUI_TEST_MODE=1 /tmp/nexgent-gui-release-venv/bin/nexgent --gui
/tmp/nexgent-gui-release-venv/bin/nexgent --help
/tmp/nexgent-gui-release-venv/bin/python -c "from nexgent.cli import _build_parser, select_frontend; args = _build_parser().parse_args(['--task', 'hello', '--output-format', 'json']); assert select_frontend(args, stdin_is_tty=True, stdout_is_tty=True).value == 'cli'"
```

Expected: GUI smoke exits cleanly; installed CLI help works; route selection remains CLI without importing the GUI unnecessarily.

- [ ] **Step 7: Run real macOS window verification**

Launch `nexgent --gui` from the development environment, open `demo-project`, verify start window, three-column workspace, model/mode controls, sanitized permission prompt, one simulated tool flow, control-center tabs, stop/close, and session restore. Record the exact command and observed result in the final handoff.

- [ ] **Step 8: Audit the design acceptance criteria one by one**

For each of the ten acceptance criteria in `docs/superpowers/specs/2026-07-17-nexgent-desktop-gui-design.md`, cite the test, command output, screenshot, packaged file, or runtime observation that proves it. Treat missing or indirect evidence as incomplete and continue implementation.

- [ ] **Step 9: Commit**

```bash
git add setup.py MANIFEST.in tests/test_distribution.py
git commit -m "build: package and verify Nexgent desktop"
```

## Brand and Release Plan Completion Gate

- [ ] Selected Agent Relay geometry appears in packaged icon, start window, main window, title art, and brand docs.
- [ ] Asset builder produces identical mark/icon hashes on consecutive runs.
- [ ] Sanitized start, configuration, workspace, and control-center screenshots are visually inspected.
- [ ] README documents GUI, TUI, and CLI without stale claims.
- [ ] Focused GUI/runtime/brand tests, full non-E2E suite, Ruff, compileall, `run_tests.py`, and distribution tests pass.
- [ ] Built wheel contains GUI code, application icon, SVGs, and font resources.
- [ ] Clean-installed GUI and CLI smoke tests pass.
- [ ] Real macOS window startup and interaction checks pass.
- [ ] All ten design acceptance criteria have direct evidence.
- [ ] `git status --short` shows only intentional committed work.
