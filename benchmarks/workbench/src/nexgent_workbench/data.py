"""Frozen authored operational fixtures and public policy, without answer keys."""

from copy import deepcopy
import hashlib
import json
import random

VERSION = "invoice-reconciliation-v1"
SPLITS = ("development", "selection", "final_holdout")


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"),
                                    ensure_ascii=False, allow_nan=False).encode()).hexdigest()


POLICY = {
    "version": VERSION,
    "currency": "USD",
    "valid_row": "A row has unique source_row_id, nonempty record_id and department, integer revision >= 1, integer amount_cents >= 0, currency USD, and boolean deleted. Booleans are not integers.",
    "exclusion_rule": "excluded_rows contains exactly the invalid input rows, each exactly once. A valid row at a lower revision is superseded for reconciliation but is not invalid and must not appear in excluded_rows. For each invalid row, reason is the first failed field in invalid_reason_order.",
    "revision_rule": "For each record use only valid rows at its highest revision. Ignore valid lower revisions when selecting the reconciled record; they remain valid inputs and are not exclusions. Preserve every highest-revision source_row_id, sorted.",
    "duplicate_rule": "At highest revision identical (department, amount_cents, deleted) values collapse to one record.",
    "conflict_rule": "Different highest-revision values mean conflict. Hold the record, set department and amount_cents null, list sorted distinct candidate_values and source_row_ids. Do not choose a source arbitrarily.",
    "delete_rule": "A non-conflicting highest revision marked deleted yields status deleted. Preserve its amount and department but exclude it from all monetary totals.",
    "aggregate_rule": "Only active records contribute. Produce active/deleted/conflict counts, total_amount_cents, and by_department entries sorted by department with active_count and total_amount_cents. Sort records/conflicts by record_id; excluded rows by source_row_id. Sort candidate_values by department, amount_cents, deleted. input_digest is SHA256 of the complete inputs map serialized as JSON with sorted keys, compact separators, UTF-8, ensure_ascii=False, allow_nan=False.",
    "invalid_reason_order": ["source_row_id", "record_id", "revision", "department", "amount_cents", "currency", "deleted"],
}


def row_errors(row):
    """Public structural validation; does not reconcile or compute targets."""
    if not isinstance(row, dict):
        return ["row"]
    errors = []
    for key in ("source_row_id", "record_id"):
        if not isinstance(row.get(key), str) or not row[key].strip():
            errors.append(key)
    if type(row.get("revision")) is not int or row["revision"] < 1:
        errors.append("revision")
    if not isinstance(row.get("department"), str) or not row["department"].strip():
        errors.append("department")
    if type(row.get("amount_cents")) is not int or row["amount_cents"] < 0:
        errors.append("amount_cents")
    if row.get("currency") != "USD":
        errors.append("currency")
    if type(row.get("deleted")) is not bool:
        errors.append("deleted")
    return errors


def inputs_for(split, seed):
    if split not in SPLITS:
        raise ValueError(f"Unknown split {split!r}; use {SPLITS}")
    if type(seed) is not int or seed < 0:
        raise ValueError("seed must be a nonnegative integer")
    # Seeds vary row order and task amounts, never move identities between partitions.
    prefix = f"{split}-{seed}"
    shift = seed % 97
    rows = []

    def add(source, n, record, revision, amount, department="engineering", deleted=False, currency="USD"):
        rows.append({"source_row_id": f"{prefix}/{source}/{n}", "source_id": source,
                     "source_version": "2026-09-16.v1", "record_id": f"{prefix}/invoice-{record}",
                     "revision": revision, "department": department, "amount_cents": amount,
                     "currency": currency, "deleted": deleted})

    add("erp", 1, "A", 1, 1000 + shift)
    add("erp", 2, "A", 2, 1250 + shift)
    add("billing", 1, "A", 2, 1250 + shift)
    add("erp", 3, "B", 1, 2250 + shift, "sales")
    add("billing", 2, "B", 2, 2400 + shift, "sales")
    add("erp", 4, "B", 2, 2450 + shift, "sales")
    add("erp", 5, "C", 1, 3100 + shift)
    add("billing", 3, "C", 2, 3100 + shift, deleted=True)
    add("erp", 6, "D", 1, 800 + shift, "operations")
    add("billing", 4, "D", 1, 800 + shift, "operations")
    add("erp", 7, "E", 1, 650 + shift, "sales")
    add("billing", 5, "E", 2, -650, "sales")
    add("billing", 6, "F", 1, 2000, "sales", currency="EUR")
    add("erp", 8, "G", 0, 1234)
    random.Random(digest({"split": split, "seed": seed})).shuffle(rows)
    return {"sources": {"dataset_version": VERSION,
                        "sources": [{"source_id": s, "version": "2026-09-16.v1"}
                                    for s in ("erp", "billing")], "rows": rows},
            "policy": deepcopy(POLICY)}
