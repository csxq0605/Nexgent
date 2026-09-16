"""Versioned primary-literature notes from the repository research, not live search.

These concise paraphrases and their reading scope remain explicitly separate
from documents fetched in a study. They are starting evidence, not new findings.
"""
from copy import deepcopy

REVIEWED_EVIDENCE = [
    {"title": "STOP: Self-Taught Optimizer", "url": "https://arxiv.org/pdf/2310.02304", "read_scope": "Algorithm 1, sections 3-7 and appendices B/C/E", "note": "Apply the improver to its own executable source. Measure meta utility by running that actual improver on downstream programs. A fixed host mutation algorithm is not a substitute. Model weights remain fixed.", "application": "Run each inherited improve source in a new process; match downstream starts and budgets."},
    {"title": "Darwin Godel Machine", "url": "https://arxiv.org/pdf/2505.22954", "read_scope": "Methods and final-paper appendices A.3/C.2-C.4/E.1", "note": "An archive preserves executable ancestors; task performance and number of children influence parent selection. Greedy deployment and exploration serve different purposes. Published ablation dollar costs are not matched.", "application": "Retain rejected candidate programs and their actual offspring results; compare a greedy arm."},
    {"title": "Hyperagents", "url": "https://arxiv.org/html/2603.19461v1", "read_scope": "Sections 3-5 and appendices D/E", "note": "Task and meta programs are both editable. Improvement@k freezes the tested meta program, generates real descendants, selects on validation, and measures held-out performance. Editable parent selection alone did not establish a significant advantage.", "application": "Use actual common-start offspring experiments and report task/meta module replacement separately."},
    {"title": "Huxley-Godel Machine", "url": "https://arxiv.org/html/2510.21614v1", "read_scope": "Sections 3-4 and appendix D", "note": "Descendant productivity can guide which branches to extend. Credit estimates also depend on historical budget allocation; observed productive descendants do not by themselves establish causal superiority.", "application": "Expose measured descendant gains to source selectors and require matched extension budgets for attribution."},
    {"title": "The AI Scientist-v2", "url": "https://arxiv.org/html/2504.08066v1", "read_scope": "Methods and experiment organization", "note": "Literature, experiment trees, ablations, repeated experiments and reports form an iterative research process. A generated report is not sufficient evidence that its proposed experiments ran.", "application": "Bind hypotheses and conclusions to actual source, experiment receipts and independent evaluation."},
]


class ResearchEvidence:
    def __init__(self, live_search):
        self.live_search = live_search

    def __call__(self, query):
        live = self.live_search(query)
        return {**live, "repository_review": deepcopy(REVIEWED_EVIDENCE),
                "review_provenance": "Repository primary-source review dated 2026-09-15; these are prior notes, not papers newly retrieved by this call",
                "live_retrieval_status": live.get("status", "unknown")}
