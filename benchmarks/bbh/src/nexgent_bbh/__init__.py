"""Optional BIG-Bench Hard plugin; importing the package does not load data."""

__all__ = ["BigBenchHardBenchmark", "BigBenchHardTaskBenchmark", "reference_package"]


def __getattr__(name):
    if name == "BigBenchHardBenchmark":
        from .benchmark import BigBenchHardBenchmark
        return BigBenchHardBenchmark
    if name in {"BigBenchHardTaskBenchmark", "reference_package"}:
        from .task_benchmark import BigBenchHardTaskBenchmark, reference_package
        return {"BigBenchHardTaskBenchmark": BigBenchHardTaskBenchmark,
                "reference_package": reference_package}[name]
    raise AttributeError(name)
