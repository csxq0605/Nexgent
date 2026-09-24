"""Frozen public specification for the one supported smoke scenario."""

from copy import deepcopy
import hashlib
import json

from .schemas import PARAMETER_SCHEMA, validation_errors


VERSION = "openfoam-cavity-smoke-v1"
SPLITS = ("smoke",)
SCENARIO = "cavity_re10"
TEMPLATE_RELPATH = "incompressible/icoFoam/cavity/cavity"


def digest(value):
    return hashlib.sha256(json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")).hexdigest()


_SPEC = {
    "schema_version": VERSION,
    "split": "smoke",
    "scenario": SCENARIO,
    "foundation_version": "8",
    "solver": "icoFoam",
    "reynolds_number": 10,
    "reference_length_m": 0.1,
    "reference_velocity_m_per_s": 1.0,
    "kinematic_viscosity_m2_per_s": 0.01,
    "template_relpath": TEMPLATE_RELPATH,
    "commands": [
        ["blockMesh", "-case", "<case>"],
        ["checkMesh", "-case", "<case>"],
        ["icoFoam", "-case", "<case>"],
    ],
    "expected_cell_count": 400,
    "expected_end_time": 0.5,
    "scope": (
        "A minimal execution smoke check of the unmodified OpenFOAM Foundation 8 "
        "cavity tutorial at Re=10. It checks tool execution, mesh output and finite "
        "written fields; it is not an accuracy, convergence, performance, or RSI claim."
    ),
}


def parameters_for(split="smoke", scenario=SCENARIO):
    value = {"split": split, "scenario": scenario}
    errors = validation_errors(value, PARAMETER_SCHEMA, "parameters")
    if errors:
        raise ValueError("; ".join(errors))
    return value


def inputs_for(split="smoke", seed=0):
    if split != "smoke":
        raise ValueError("Unknown split; the first release supports only 'smoke'")
    if type(seed) is not int or seed != 0:
        raise ValueError("The frozen smoke slice supports seed=0 only")
    parameters_for(split, SCENARIO)
    return {"spec": deepcopy(_SPEC)}
