"""Public JSON delivery contracts. Validators here have no expected truth."""

from jsonschema import Draft202012Validator


def obj(properties, required=None):
    return {"type": "object", "properties": properties,
            "required": list(properties) if required is None else required,
            "additionalProperties": False}


STR = {"type": "string", "minLength": 1}
INT = {"type": "integer", "minimum": 0}
REV = {"type": "integer", "minimum": 1}
IDS = {"type": "array", "items": STR, "minItems": 1, "uniqueItems": True}
CANDIDATE = obj({"department": STR, "amount_cents": INT, "deleted": {"type": "boolean"}})
RECORD = obj({"record_id": STR, "revision": REV,
              "status": {"enum": ["active", "deleted", "conflict"]},
              "department": {"type": ["string", "null"]},
              "amount_cents": {"type": ["integer", "null"], "minimum": 0},
              "source_row_ids": IDS})
CONFLICT = obj({"record_id": STR, "revision": REV, "source_row_ids": IDS,
                "candidate_values": {"type": "array", "items": CANDIDATE,
                                     "minItems": 2, "uniqueItems": True}})
LEDGER_SCHEMA = obj({"records": {"type": "array", "items": RECORD},
                     "conflicts": {"type": "array", "items": CONFLICT}})
SUMMARY = obj({"active_count": INT, "deleted_count": INT, "conflict_count": INT,
               "total_amount_cents": INT,
               "by_department": {"type": "array", "items": obj({
                   "department": STR, "active_count": INT, "total_amount_cents": INT})}})
REPORT_SCHEMA = obj({"input_digest": {"type": "string", "pattern": "^[0-9a-f]{64}$"},
                     "summary": SUMMARY,
                     "excluded_rows": {"type": "array", "items": obj({
                         "source_row_id": STR, "reason": STR})}})
DELIVERY_SCHEMAS = {"ledger": LEDGER_SCHEMA, "report": REPORT_SCHEMA}


def schema_errors(deliverables):
    if not isinstance(deliverables, dict):
        return ["deliverables must be an object"]
    errors = []
    if set(deliverables) != set(DELIVERY_SCHEMAS):
        errors.append("deliverables must contain exactly ledger and report")
    for name, schema in DELIVERY_SCHEMAS.items():
        if name not in deliverables:
            continue
        for error in sorted(Draft202012Validator(schema).iter_errors(deliverables[name]),
                            key=lambda e: str(list(e.path))):
            errors.append(f"{name}/{'/'.join(map(str, error.path))}: {error.message}")
    return errors
