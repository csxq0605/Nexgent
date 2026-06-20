"""Plugin system — discover, load, and manage plugins.

Plugins extend Nexgent with new tools, skills, agents, and hooks.

Plugin directory structure:
  ~/.nexgent/plugins/my-plugin/           # User-level plugins
  .nexgent/plugins/my-plugin/             # Project-level plugins

Each plugin has:
  plugin.json     — manifest (name, version, description, entry point)
  __init__.py     — optional Python module with get_tools(), init(), destroy()
  skills/         — optional SKILL.md files
  agents/         — optional agent definition .md files

Example plugin.json:
{
  "name": "my-plugin",
  "version": "1.0.0",
  "description": "A custom plugin",
  "entry": "__init__",
  "requires": ["requests"],
  "tools": true,
  "skills": true,
  "agents": true
}
"""

import json
import os
import sys
import importlib
import importlib.util
import logging
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

_logger = logging.getLogger("nexgent.plugins")


@dataclass
class PluginManifest:
    """Parsed plugin.json manifest."""
    name: str
    version: str = "0.0.0"
    description: str = ""
    entry: str = "__init__"  # Python module name (without .py)
    requires: list[str] = field(default_factory=list)  # Python package dependencies
    tools: bool = True   # Whether plugin provides tools
    skills: bool = True  # Whether plugin provides skills
    agents: bool = True  # Whether plugin provides agents
    hooks: bool = False  # Whether plugin provides hooks
    enabled: bool = True

    @classmethod
    def from_file(cls, path: str) -> "PluginManifest":
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return cls(
            name=data.get("name", os.path.basename(os.path.dirname(path))),
            version=data.get("version", "0.0.0"),
            description=data.get("description", ""),
            entry=data.get("entry", "__init__"),
            requires=data.get("requires", []),
            tools=data.get("tools", True),
            skills=data.get("skills", True),
            agents=data.get("agents", True),
            hooks=data.get("hooks", False),
            enabled=data.get("enabled", True),
        )


@dataclass
class Plugin:
    """A loaded plugin instance."""
    manifest: PluginManifest
    plugin_dir: str
    module: Any = None  # The imported Python module
    tools: list = field(default_factory=list)
    loaded: bool = False
    error: Optional[str] = None

    @property
    def name(self) -> str:
        return self.manifest.name

    @property
    def skills_dir(self) -> str:
        return os.path.join(self.plugin_dir, "skills")

    @property
    def agents_dir(self) -> str:
        return os.path.join(self.plugin_dir, "agents")


class PluginManager:
    """Manages plugin discovery, loading, and lifecycle.

    Args:
        user_plugin_dir: User-level plugin directory (~/.nexgent/plugins/)
        project_plugin_dir: Project-level plugin directory (.nexgent/plugins/)
    """

    def __init__(
        self,
        user_plugin_dir: str = None,
        project_plugin_dir: str = None,
        logger=None,
    ):
        self.user_plugin_dir = user_plugin_dir or os.path.join(
            os.path.expanduser("~"), ".nexgent", "plugins"
        )
        self.project_plugin_dir = project_plugin_dir or os.path.join(
            ".nexgent", "plugins"
        )
        self.logger = logger or _logger

        self._plugins: dict[str, Plugin] = {}
        self._lock = threading.Lock()

    def discover(self) -> list[str]:
        """Discover all plugin directories. Returns list of plugin paths."""
        discovered = []

        for base_dir in [self.project_plugin_dir, self.user_plugin_dir]:
            if not os.path.isdir(base_dir):
                continue
            for name in sorted(os.listdir(base_dir)):
                plugin_dir = os.path.join(base_dir, name)
                manifest_path = os.path.join(plugin_dir, "plugin.json")
                if os.path.isdir(plugin_dir) and os.path.exists(manifest_path):
                    discovered.append(plugin_dir)
                    self.logger.debug(f"Discovered plugin: {plugin_dir}")

        return discovered

    def load_all(self) -> list[Plugin]:
        """Discover and load all plugins. Returns list of loaded Plugin objects."""
        plugins = []
        for plugin_dir in self.discover():
            plugin = self.load(plugin_dir)
            if plugin:
                plugins.append(plugin)
        return plugins

    def load(self, plugin_dir: str) -> Optional[Plugin]:
        """Load a single plugin from its directory.

        Returns Plugin object on success, None on failure.
        """
        manifest_path = os.path.join(plugin_dir, "plugin.json")
        if not os.path.exists(manifest_path):
            self.logger.warning(f"No plugin.json in {plugin_dir}")
            return None

        try:
            manifest = PluginManifest.from_file(manifest_path)
        except Exception as e:
            self.logger.error(f"Failed to parse {manifest_path}: {e}")
            return None

        if not manifest.enabled:
            self.logger.info(f"Plugin disabled: {manifest.name}")
            return None

        # Check dependencies
        missing = self._check_requires(manifest.requires)
        if missing:
            self.logger.warning(
                f"Plugin {manifest.name} missing dependencies: {missing}"
            )
            plugin = Plugin(
                manifest=manifest,
                plugin_dir=plugin_dir,
                error=f"Missing dependencies: {', '.join(missing)}",
            )
            with self._lock:
                self._plugins[manifest.name] = plugin
            return plugin

        # Import the entry module
        plugin = Plugin(manifest=manifest, plugin_dir=plugin_dir)
        try:
            module = self._import_module(plugin_dir, manifest.entry)
            plugin.module = module

            # Load tools from module
            if manifest.tools and module and hasattr(module, "get_tools"):
                try:
                    tools = module.get_tools()
                    plugin.tools = tools if isinstance(tools, list) else []
                    self.logger.info(
                        f"Plugin {manifest.name}: loaded {len(plugin.tools)} tools"
                    )
                except Exception as e:
                    self.logger.error(
                        f"Plugin {manifest.name} get_tools() failed: {e}"
                    )

            # Call init() if present
            if module and hasattr(module, "init"):
                try:
                    module.init()
                except Exception as e:
                    self.logger.error(f"Plugin {manifest.name} init() failed: {e}")
                    plugin.error = f"init() failed: {e}"
                    plugin.loaded = False
                    return plugin

            plugin.loaded = True

        except Exception as e:
            plugin.error = str(e)
            self.logger.error(f"Failed to load plugin {manifest.name}: {e}")

        with self._lock:
            self._plugins[manifest.name] = plugin

        return plugin

    def unload(self, name: str) -> bool:
        """Unload a plugin by name. Calls destroy() if present."""
        with self._lock:
            plugin = self._plugins.pop(name, None)

        if not plugin:
            return False

        # Call destroy() if present
        if plugin.module and hasattr(plugin.module, "destroy"):
            try:
                plugin.module.destroy()
            except Exception as e:
                self.logger.error(f"Plugin {name} destroy() failed: {e}")

        self.logger.info(f"Unloaded plugin: {name}")
        return True

    def get_plugin(self, name: str) -> Optional[Plugin]:
        """Get a loaded plugin by name."""
        with self._lock:
            return self._plugins.get(name)

    def list_plugins(self) -> list[Plugin]:
        """List all loaded plugins."""
        with self._lock:
            return list(self._plugins.values())

    def get_all_tools(self) -> list:
        """Get all tools from all loaded plugins."""
        tools = []
        with self._lock:
            for plugin in self._plugins.values():
                if plugin.loaded:
                    tools.extend(plugin.tools)
        return tools

    def get_all_skills_dirs(self) -> list[str]:
        """Get skills directories from all loaded plugins."""
        dirs = []
        with self._lock:
            for plugin in self._plugins.values():
                if plugin.loaded and plugin.manifest.skills:
                    skills_dir = plugin.skills_dir
                    if os.path.isdir(skills_dir):
                        dirs.append(skills_dir)
        return dirs

    def get_all_agents_dirs(self) -> list[str]:
        """Get agents directories from all loaded plugins."""
        dirs = []
        with self._lock:
            for plugin in self._plugins.values():
                if plugin.loaded and plugin.manifest.agents:
                    agents_dir = plugin.agents_dir
                    if os.path.isdir(agents_dir):
                        dirs.append(agents_dir)
        return dirs

    def _import_module(self, plugin_dir: str, entry: str):
        """Import a plugin's entry module."""
        module_path = os.path.join(plugin_dir, f"{entry}.py")
        if not os.path.exists(module_path):
            # Try as a package
            module_path = os.path.join(plugin_dir, entry, "__init__.py")
            if not os.path.exists(module_path):
                self.logger.debug(f"No entry module {entry} in {plugin_dir}")
                return None

        # Generate a unique module name
        plugin_name = os.path.basename(plugin_dir)
        module_name = f"_nexgent_plugin_{plugin_name}"

        spec = importlib.util.spec_from_file_location(module_name, module_path)
        if spec is None or spec.loader is None:
            return None

        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
        return module

    def _check_requires(self, requires: list[str]) -> list[str]:
        """Check if required packages are installed. Returns missing list."""
        missing = []
        for pkg in requires:
            try:
                importlib.import_module(pkg)
            except ImportError:
                missing.append(pkg)
        return missing


# Global singleton
_manager: Optional[PluginManager] = None
_manager_lock = threading.Lock()


def get_plugin_manager() -> PluginManager:
    """Get the global plugin manager singleton."""
    global _manager
    if _manager is None:
        with _manager_lock:
            if _manager is None:
                _manager = PluginManager()
    return _manager
