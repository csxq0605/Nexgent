"""Canonical TaskService surface for the optional scientific demo.

This package is deliberately below a subdirectory so the preserved legacy
``ResearchBenchmark`` source snapshot (which freezes top-level ``*.py`` files)
does not silently absorb the canonical runtime.
"""

from .adapter import (
    ScientificDiscoveryDomain,
    ScientificDiscoveryTaskBenchmark,
    benchmark_adapter,
    domain_pack,
    reference_package,
)

__all__ = [
    "ScientificDiscoveryDomain",
    "ScientificDiscoveryTaskBenchmark",
    "benchmark_adapter",
    "domain_pack",
    "reference_package",
]
