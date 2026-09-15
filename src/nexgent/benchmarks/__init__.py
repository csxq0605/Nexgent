"""Domain-neutral benchmark contracts and installed plugin discovery.

The framework imports no reference benchmark. Install a package that registers
the ``nexgent.benchmarks`` entry point to provide tasks, tools and evaluation.
"""

from dataclasses import asdict, dataclass
from importlib.metadata import entry_points
from typing import Protocol


@dataclass(frozen=True)
class BenchmarkSpec:
    id: str
    title: str
    description: str
    task_contract: str
    tool_api: str = ""
    toolbox_factory: str | None = None
    work_unit: str = "domain_defined_operations"

    def as_dict(self):
        return asdict(self)


class Benchmark(Protocol):
    spec: BenchmarkSpec
    evaluator_digest: str

    def initial_files(self) -> dict[str, str]: ...
    def snapshot(self) -> dict: ...
    def research_context(self) -> dict: ...
    def evaluate(self, bundle, split, seed, runner, *, stop_event=None,
                 max_work_units=20_000_000) -> dict: ...


class BenchmarkRegistry:
    def __init__(self, benchmarks=(), project_root=None):
        self.instances = {b.spec.id: b for b in benchmarks}
        self.project_root = project_root

    def available(self):
        rows = {key: {**value.spec.as_dict(), "available": True} for key, value in self.instances.items()}
        for entry in entry_points(group="nexgent.benchmarks"):
            if entry.name in rows:
                continue
            try:
                benchmark = self.get(entry.name)
                rows[entry.name] = {**benchmark.spec.as_dict(), "available": True}
            except Exception as exc:
                rows[entry.name] = {"id": entry.name, "title": entry.name, "description": "",
                                    "available": False, "error": f"{type(exc).__name__}: {str(exc)[:300]}"}
        return list(rows.values())

    def get(self, identity):
        if identity in self.instances:
            return self.instances[identity]
        matches = [entry for entry in entry_points(group="nexgent.benchmarks") if entry.name == identity]
        if len(matches) != 1:
            raise ValueError(f"Install exactly one benchmark plugin registered as {identity!r}")
        provider = matches[0].load()
        instance = provider.from_project(self.project_root) if self.project_root is not None and callable(getattr(provider, "from_project", None)) else provider()
        if not isinstance(instance.spec, BenchmarkSpec) or instance.spec.id != identity:
            raise ValueError("Benchmark entry point and specification identity differ")
        for method in ("initial_files", "snapshot", "research_context", "evaluate"):
            if not callable(getattr(instance, method, None)):
                raise ValueError("Benchmark is missing contract method: " + method)
        self.instances[identity] = instance
        return instance


class BoundRunner:
    """A benchmark receives execution with host-selected tools and RPC budgets."""
    def __init__(self, runner, toolbox_factory=None, handler=None):
        self.runner, self.toolbox_factory, self.handler = runner, toolbox_factory, handler

    def run(self, bundle, entry, argument, **kwargs):
        kwargs.setdefault("toolbox_factory", self.toolbox_factory)
        kwargs.setdefault("handler", self.handler)
        return self.runner.run(bundle, entry, argument, **kwargs)


__all__ = ["Benchmark", "BenchmarkSpec", "BenchmarkRegistry", "BoundRunner"]
