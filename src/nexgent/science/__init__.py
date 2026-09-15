"""Scientific primitives and independent synthetic discovery evaluation."""
from .baselines import seed_task_files, strong_baseline_files
from .benchmark import BENCHMARK_VERSION, DOMAIN_DESCRIPTION, ResearchBenchmark
from .expressions import NumericalFailure
from .toolbox import API_REFERENCE, Toolbox, WorkBudgetExceeded

__all__ = ["API_REFERENCE", "BENCHMARK_VERSION", "DOMAIN_DESCRIPTION", "ResearchBenchmark", "Toolbox", "NumericalFailure", "WorkBudgetExceeded", "seed_task_files", "strong_baseline_files"]
