"""Public JSON contracts for the Foundation OpenFOAM cavity smoke plugin."""

from jsonschema import Draft202012Validator


def obj(properties, required=None):
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties) if required is None else required,
        "additionalProperties": False,
    }


STR = {"type": "string", "minLength": 1}
BOOL = {"type": "boolean"}
INT = {"type": "integer", "minimum": 0}
NUMBER = {"type": "number"}
DIGEST = {"type": "string", "pattern": "^[0-9a-f]{64}$"}
NULLABLE_STR = {"type": ["string", "null"]}

PARAMETER_SCHEMA = obj({
    "split": {"const": "smoke"},
    "scenario": {"const": "cavity_re10"},
})

SPEC_SCHEMA = obj({
    "schema_version": {"const": "openfoam-cavity-smoke-v1"},
    "split": {"const": "smoke"},
    "scenario": {"const": "cavity_re10"},
    "foundation_version": {"const": "8"},
    "solver": {"const": "icoFoam"},
    "reynolds_number": {"const": 10},
    "reference_length_m": {"const": 0.1},
    "reference_velocity_m_per_s": {"const": 1.0},
    "kinematic_viscosity_m2_per_s": {"const": 0.01},
    "template_relpath": {"const": "incompressible/icoFoam/cavity/cavity"},
    "commands": {
        "const": [["blockMesh", "-case", "<case>"],
                  ["checkMesh", "-case", "<case>"],
                  ["icoFoam", "-case", "<case>"]]
    },
    "expected_cell_count": {"const": 400},
    "expected_end_time": {"const": 0.5},
    "scope": STR,
})

PROBE_SCHEMA = obj({
    "available": BOOL,
    "status": {"enum": ["available", "unavailable"]},
    "backend": {"type": ["string", "null"], "enum": ["native", "wsl", None]},
    "foundation_version": NULLABLE_STR,
    "project": NULLABLE_STR,
    "template": NULLABLE_STR,
    "executables": obj({name: NULLABLE_STR for name in ("blockMesh", "checkMesh", "icoFoam")}),
    "reasons": {"type": "array", "items": STR, "uniqueItems": True},
    "scope": STR,
})

PREPARE_SCHEMA = obj({
    "status": {"enum": ["prepared", "contract_rejected"]},
    "reason": {"type": ["string", "null"]},
    "retryable": BOOL,
    "feedback": {"type": ["string", "null"]},
    "spec_digest": DIGEST,
    "template_digest": {"anyOf": [DIGEST, {"type": "null"}]},
    "job_digest": {"anyOf": [DIGEST, {"type": "null"}]},
    "case_ref": {"type": ["string", "null"]},
    "provenance": obj({
        "foundation": {"const": "OpenFOAM Foundation"},
        "version": {"const": "8"},
        "backend": {"type": ["string", "null"], "enum": ["native", "wsl", None]},
        "template_relpath": {"const": "incompressible/icoFoam/cavity/cavity"},
        "copy_mode": {"const": "bounded_regular_files"},
    }),
})

COMMAND_RECEIPT = obj({
    "program": {"enum": ["blockMesh", "checkMesh", "icoFoam"]},
    "argv": {"type": "array", "items": STR, "minItems": 3, "maxItems": 3},
    "returncode": {"type": "integer"},
    "duration_ms": INT,
    "output_bytes": INT,
    "output_digest": DIGEST,
    "output_preview": {"type": "string"},
    "output_truncated": BOOL,
    "timed_out": BOOL,
})

FIELD_RECEIPT = obj({
    "name": {"enum": ["U", "p"]},
    "path": STR,
    "digest": DIGEST,
    "class": STR,
    "dimensions": STR,
    "value_count": INT,
    "finite": BOOL,
    "minimum": NUMBER,
    "maximum": NUMBER,
})

RESOURCE_RECEIPT = obj({
    "timeout_seconds_per_command": INT,
    "output_limit_bytes_per_command": INT,
    "command_count": {"const": 3},
    "wall_time_ms": INT,
    "commands": {"type": "array", "items": COMMAND_RECEIPT, "minItems": 3, "maxItems": 3},
})

RUN_MANIFEST_SCHEMA = obj({
    "schema_version": {"const": "openfoam-run-manifest-v1"},
    "run_digest": DIGEST,
    "job_digest": DIGEST,
    "spec_digest": DIGEST,
    "scenario": {"const": "cavity_re10"},
    "solver": {"const": "icoFoam"},
    "foundation_version": {"const": "8"},
    "template_digest": DIGEST,
    "provenance": obj({
        "template_relpath": {"const": "incompressible/icoFoam/cavity/cavity"},
        "execution_backend": {"enum": ["native", "wsl"]},
        "case_digest_before_run": DIGEST,
        "case_digest_after_run": DIGEST,
    }),
    "resource_receipt": RESOURCE_RECEIPT,
})

CHECK = obj({"name": STR, "passed": BOOL, "evidence": STR})
VERIFICATION_REPORT_SCHEMA = obj({
    "schema_version": {"const": "openfoam-verification-report-v1"},
    "run_digest": DIGEST,
    "status": {"enum": ["passed", "failed"]},
    "checks": {"type": "array", "items": CHECK, "minItems": 1},
    "mesh": obj({"cell_count": INT, "mesh_ok": BOOL}),
    "solver": obj({"end_time": NUMBER, "completed": BOOL,
                   "residual_lines_observed": INT, "residual_scan_complete": BOOL}),
    "fields": {"type": "array", "items": FIELD_RECEIPT, "minItems": 2, "maxItems": 2},
    "scope": STR,
})

RUN_RESULT_SCHEMA = obj({
    "run_manifest": RUN_MANIFEST_SCHEMA,
    "verification_report": VERIFICATION_REPORT_SCHEMA,
})

VALIDATION_SCHEMA = obj({
    "valid": BOOL,
    "schema_valid": BOOL,
    "receipt_consistent": BOOL,
    "errors": {"type": "array", "items": STR},
    "delivery_digest": DIGEST,
    "run_digest": {"anyOf": [DIGEST, {"type": "null"}]},
    "scope": STR,
})

DELIVERY_SCHEMAS = {
    "run_manifest": RUN_MANIFEST_SCHEMA,
    "verification_report": VERIFICATION_REPORT_SCHEMA,
}


def validation_errors(value, schema, label="value"):
    errors = []
    for error in sorted(Draft202012Validator(schema).iter_errors(value),
                        key=lambda item: str(list(item.path))):
        path = "/".join(map(str, error.path))
        errors.append(f"{label}{'/' + path if path else ''}: {error.message}")
    return errors


def delivery_schema_errors(deliverables):
    if not isinstance(deliverables, dict):
        return ["deliverables must be an object"]
    errors = []
    if set(deliverables) != set(DELIVERY_SCHEMAS):
        errors.append("deliverables must contain exactly run_manifest and verification_report")
    for name, schema in DELIVERY_SCHEMAS.items():
        if name in deliverables:
            errors.extend(validation_errors(deliverables[name], schema, name))
    return errors
