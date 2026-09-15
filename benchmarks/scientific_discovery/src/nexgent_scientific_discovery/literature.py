"""Public domain evidence; no generated observations or hidden targets."""

from copy import deepcopy


REVIEWED_EVIDENCE = [
    {"title": "Discovering governing equations from data by sparse identification of nonlinear dynamical systems", "url": "https://doi.org/10.1073/pnas.1517384113", "read_scope": "Primary full text", "note": "Sparse regression over candidate functions can identify dynamical equations from observations. Noise, derivative estimates and function-library coverage constrain recovery.", "application": "Investigate estimation, expression generation and observation-only model comparison, not only training residual."},
    {"title": "Weak SINDy for model selection of nonlinear dynamics", "url": "https://arxiv.org/abs/2005.04339", "read_scope": "Author abstract and SIAM publication information; not full methods", "note": "Weak formulations use integral transformations to reduce dependence on noisy pointwise differentiation. Our integral-collocation tool is not a reproduction of the complete published WSINDy algorithm.", "application": "Treat weak/integral estimation as a competing mechanism; compare actual held-out trajectories."},
    {"title": "Model selection for dynamical systems via sparse regression and information criteria", "url": "https://arxiv.org/abs/1701.01773", "read_scope": "Author abstract", "note": "Sparse candidate models can be compared using information criteria. Predictive accuracy and complexity should be evaluated together; an observation fit alone does not identify the true equation uniquely.", "application": "Use trajectories with different initial conditions for selection and counterexamples."},
]

REVIEW_PROVENANCE = "Repository primary-source review dated 2026-09-15; these are prior notes, not papers newly retrieved by this call"


def reviewed_evidence():
    return deepcopy(REVIEWED_EVIDENCE)
