"""Bind a scientific demo to the domain-neutral benchmark contract."""

from copy import deepcopy
import hashlib
from importlib.metadata import version
from pathlib import Path

from nexgent.benchmarks import BenchmarkSpec
from nexgent.research import LiteratureSearch

from .baselines import strong_baseline_files
from .benchmark import BENCHMARK_VERSION, DOMAIN_DESCRIPTION, ResearchBenchmark
from .literature import REVIEW_PROVENANCE, reviewed_evidence
from .roles import ROLE_GUIDANCE
from .toolbox import API_REFERENCE


TASK_CONTRACT = (
    "Implement solve(problem, tools). The problem exposes task_id, noisy observations as a list of "
    "trajectories of state vectors, positive dt, dimension, requirements and tool_api. It may include "
    "numerical_budget supplied by the host. It exposes no true dynamics, family labels or hidden forecasts. "
    "Return {'model': {'terms': ['1', 'x0', 'sin(x0)', ...], 'coefficients': [[...], ...]}, "
    "with one finite coefficient row per state dimension and one coefficient per term; "
    "dx_j/dt is the sum of coefficient[j][k] times term[k]. Supported expressions are documented in tool_api. "
    "Optional hypotheses, experiments and limitations document research but do not award scores. "
    "The host independently integrates the model from unseen initial conditions. Use only visible observations "
    "for fitting and internal validation. Numerical divergence is measured failure; resource-unavailable evaluation is missing."
)


class ScientificDiscoveryBenchmark(ResearchBenchmark):
    spec = BenchmarkSpec(
        id="scientific_discovery",
        title="Scientific discovery: dynamical systems",
        description=DOMAIN_DESCRIPTION,
        task_contract=TASK_CONTRACT,
        tool_api=API_REFERENCE,
        toolbox_factory="nexgent_scientific_discovery.toolbox:Toolbox",
        work_unit="deterministic_numerical_operations",
    )

    def initial_files(self):
        return strong_baseline_files()

    def snapshot(self):
        directory = Path(__file__).parent
        files = {path.name: path.read_text(encoding="utf-8") for path in sorted(directory.glob("*.py"))}
        return {
            "files": files,
            "versions": {name: version(name) for name in ("numpy", "scipy")},
            "data": {
                "kind": "seeded_synthetic_generator",
                "benchmark_version": BENCHMARK_VERSION,
                "generator_sha256": hashlib.sha256((directory / "benchmark.py").read_bytes()).hexdigest(),
                "external_dataset": None,
            },
        }

    def research_context(self):
        return {
            "benchmark_id": self.spec.id,
            "description": DOMAIN_DESCRIPTION,
            "task_contract": TASK_CONTRACT,
            "tool_api": API_REFERENCE,
            "role_guidance": deepcopy(ROLE_GUIDANCE),
            "repository_review": reviewed_evidence(),
            "review_provenance": REVIEW_PROVENANCE,
            "research_process": ["Define a failure using current observations", "Read relevant primary evidence at its stated depth", "State a falsifiable mechanism hypothesis", "Change executable source and compare against the unchanged program", "Keep counterexamples and algorithm/resource failures distinct", "Freeze the program before independent replication"],
            "limits": ["Synthetic recovery of known systems is a demonstration, not a new natural law", "A task-program gain does not establish improved offspring production by the improver", "Host snapshots are reproducibility records and must not be sent to the task as observations"],
        }

    def search(self, query):
        if not hasattr(self, "_literature_search"):
            self._literature_search = LiteratureSearch()
        live = self._literature_search(query)
        return {**live, "domain_review": reviewed_evidence(), "domain_review_provenance": REVIEW_PROVENANCE,
                "live_retrieval_status": live.get("status", "unknown")}
