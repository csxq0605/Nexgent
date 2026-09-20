"""Optional OpenFOAM plugin; importing it never launches external programs."""

from .plugin import (
    OpenFOAMCavityBenchmark, OpenFOAMCavityDomain, benchmark_adapter, domain_pack,
    prepare_cavity, probe_environment, run_cavity, validate_delivery,
)

__all__ = [
    "OpenFOAMCavityBenchmark", "OpenFOAMCavityDomain", "benchmark_adapter",
    "domain_pack", "prepare_cavity", "probe_environment", "run_cavity",
    "validate_delivery",
]
