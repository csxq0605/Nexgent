"""Optional non-CFD task plugin; no provider calls occur on import."""

from .plugin import WorkbenchBenchmark, WorkbenchDomain, benchmark_adapter, domain_pack

__all__ = ["WorkbenchBenchmark", "WorkbenchDomain", "benchmark_adapter", "domain_pack"]
