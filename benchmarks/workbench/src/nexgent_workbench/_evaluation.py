"""Host-only reconciliation oracle. Never registered as an agent capability."""

from collections import defaultdict

from .data import digest, row_errors


def expected_delivery(inputs):
    groups = defaultdict(list)
    excluded = []
    for row in inputs["sources"]["rows"]:
        errors = row_errors(row)
        if errors:
            excluded.append({"source_row_id": row["source_row_id"], "reason": errors[0]})
        else:
            groups[row["record_id"]].append(row)
    records, conflicts = [], []
    departments = defaultdict(lambda: {"active_count": 0, "total_amount_cents": 0})
    counts = {"active_count": 0, "deleted_count": 0, "conflict_count": 0,
              "total_amount_cents": 0}
    for record_id in sorted(groups):
        revision = max(row["revision"] for row in groups[record_id])
        latest = [r for r in groups[record_id] if r["revision"] == revision]
        ids = sorted(r["source_row_id"] for r in latest)
        values = sorted({(r["department"], r["amount_cents"], r["deleted"]) for r in latest})
        conflict = len(values) > 1
        department, amount, deleted = values[0]
        status = "conflict" if conflict else "deleted" if deleted else "active"
        records.append({"record_id": record_id, "revision": revision, "status": status,
                        "department": None if conflict else department,
                        "amount_cents": None if conflict else amount, "source_row_ids": ids})
        counts[f"{status}_count"] += 1
        if conflict:
            conflicts.append({"record_id": record_id, "revision": revision,
                              "source_row_ids": ids, "candidate_values": [
                                  {"department": d, "amount_cents": a, "deleted": x}
                                  for d, a, x in values]})
        if status == "active":
            counts["total_amount_cents"] += amount
            departments[department]["active_count"] += 1
            departments[department]["total_amount_cents"] += amount
    counts["by_department"] = [{"department": d, **departments[d]} for d in sorted(departments)]
    return {"ledger": {"records": records, "conflicts": conflicts},
            "report": {"input_digest": digest(inputs), "summary": counts,
                       "excluded_rows": sorted(excluded, key=lambda row: row["source_row_id"])}}
