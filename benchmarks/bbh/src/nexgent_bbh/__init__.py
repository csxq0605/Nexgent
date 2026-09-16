"""Optional BIG-Bench Hard plugin; importing the package does not load data."""

__all__ = ["BigBenchHardBenchmark"]


def __getattr__(name):
    if name == "BigBenchHardBenchmark":
        from .benchmark import BigBenchHardBenchmark
        return BigBenchHardBenchmark
    raise AttributeError(name)
