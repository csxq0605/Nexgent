"""Execute existing registered study IDs sequentially, without creating work.

Preparation/read-only check (default):
  python scripts/run_registered_batch.py batch.json --arms task_only greedy
After explicit authorization, execute only these already registered studies:
  python scripts/run_registered_batch.py batch.json --arms task_only greedy --execute
Completed studies are exported/skipped. Failed, paused, running, or previously
admitted studies are never retried. Confirmation is a separate operation.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import signal
import sys
import threading
import time


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
ARMS = {"full", "task_only", "greedy"}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def now():
    return datetime.now(timezone.utc).isoformat()


def load_manifest(path):
    raw = Path(path).read_bytes()
    manifest = json.loads(raw.decode("utf-8-sig"))
    if manifest.get("schema") != "nexgent-registered-batch-v1":
        raise ValueError("expected manifest schema nexgent-registered-batch-v1")
    if manifest.get("content_digest") != digest({key: value for key, value in manifest.items() if key != "content_digest"}):
        raise ValueError("registered manifest digest mismatch")
    if not isinstance(manifest.get("batch_id"), str) or not manifest["batch_id"].replace("-", "").replace("_", "").isalnum():
        raise ValueError("batch ID must contain only letters, digits, hyphens and underscores")
    registered = datetime.fromisoformat(manifest["registered_at"])
    if registered.tzinfo is None or registered >= datetime.now(timezone.utc):
        raise ValueError("manifest registration must predate execution and include a timezone")
    protocol = manifest["protocol"]
    if not isinstance(protocol.get("seeds"), list) or any(type(seed) is not int for seed in protocol["seeds"]) or not protocol["seeds"] or len(set(protocol["seeds"])) != len(protocol["seeds"]):
        raise ValueError("registered evolution seeds must be distinct integers")
    if set(protocol.get("arms", [])) != ARMS or len(protocol["arms"]) != len(ARMS):
        raise ValueError("the full/task_only/greedy arms must all be registered")
    if type(protocol.get("generations")) is not int or not 1 <= protocol["generations"] <= 20:
        raise ValueError("invalid registered generation count")
    if not isinstance(protocol.get("public_prior_study_id"), str):
        raise ValueError("the common public prior study must be registered")
    if any(type(protocol.get("budget", {}).get(field)) is not int or protocol["budget"][field] <= 0 for field in ("max_model_calls", "max_completion_tokens")):
        raise ValueError("registered model budgets must be positive integers")
    entries = manifest.get("studies")
    if not isinstance(entries, list) or not entries:
        raise ValueError("manifest has no already registered study IDs")
    ids, cells = set(), set()
    for entry in entries:
        identity, arm, seed = entry.get("study_id"), entry.get("arm"), entry.get("seed")
        if not isinstance(identity, str) or not identity.startswith("study-") or len(identity) != 22 or any(character not in "0123456789abcdef" for character in identity[6:]):
            raise ValueError("manifest contains an invalid existing study ID")
        if arm not in ARMS or seed not in protocol["seeds"] or identity in ids or (arm, seed) in cells:
            raise ValueError("manifest contains duplicate or unregistered arm/seed entries")
        ids.add(identity); cells.add((arm, seed))
    expected = {(arm, seed) for arm in protocol["arms"] for seed in protocol["seeds"]}
    if cells != expected:
        raise ValueError("all arm/seed study IDs must be registered before any batch execution")
    return manifest, hashlib.sha256(raw).hexdigest()


def inspect_studies(controller, manifest):
    """Read all registrations first. Never repair a budget or create an ID."""
    protocol = manifest["protocol"]
    snapshots = []
    registered_timestamp = datetime.fromisoformat(manifest["registered_at"]).timestamp()
    for entry in manifest["studies"]:
        state = controller.get(entry["study_id"])
        if any(state.get(field) != entry[field] for field in ("arm", "seed")) or state.get("id") != entry["study_id"]:
            raise ValueError("study identity/arm/seed does not match the manifest")
        if any(field in entry and state.get(field) != entry[field] for field in ("initial_program", "implementation_digest")):
            raise ValueError("study source identity differs from its registered manifest entry")
        if "question" in protocol and state.get("question") != protocol["question"]:
            raise ValueError("study question differs from the registered scientific question")
        if state.get("max_generations") != protocol["generations"]:
            raise ValueError("study generation count differs from its registration")
        if any(state.get("budget", {}).get(field) != value for field, value in protocol["budget"].items()):
            raise ValueError("study budget differs from the manifest; no quota changes are allowed")
        if state.get("prior_research", {}).get("study_id") != protocol["public_prior_study_id"]:
            raise ValueError("study public prior differs from the registered common prior")
        if state.get("created", registered_timestamp + 1) > registered_timestamp:
            raise ValueError("study was created after this batch manifest was registered")
        if any(call.get("started_at", registered_timestamp) < registered_timestamp for call in state.get("calls", [])):
            raise ValueError("a study model request predates batch registration")
        snapshots.append(state)
    for field in ("budget", "initial_program", "implementation_digest", "evaluator_digest", "model_configuration", "question"):
        if len({canonical(state.get(field)) for state in snapshots}) != 1:
            raise ValueError("registered studies do not share the same " + field)
    prior_digests = {state.get("prior_research", {}).get("artifact") for state in snapshots}
    if None in prior_digests or len(prior_digests) != 1:
        raise ValueError("registered studies do not have identical frozen public-prior evidence")
    return snapshots


def save(path, receipt):
    receipt["updated_at"] = now()
    receipt["content_digest"] = digest({key: value for key, value in receipt.items() if key != "content_digest"})
    temporary = Path(str(path) + ".tmp")
    temporary.write_text(json.dumps(receipt, ensure_ascii=False, allow_nan=False, indent=2), encoding="utf-8")
    temporary.replace(path)


def compact(state):
    return {key: state.get(key) for key in ("id", "arm", "seed", "status", "stage", "generation", "max_generations", "usage", "last_error", "active_program", "research_program", "conclusion")}


def run_registered(controller, manifest, manifest_file_sha256, arms, project_root, *, user_stop=None, install_signal=True):
    """A study is admitted at most once by this batch runner; failures continue."""
    inspect_studies(controller, manifest)
    selected = [entry for entry in manifest["studies"] if entry["arm"] in arms]
    root = Path(project_root).resolve() / ".nexgent/batches"
    directory = root / manifest["batch_id"]
    directory.mkdir(parents=True, exist_ok=True)
    attempts = root / "study-attempts"
    attempts.mkdir(parents=True, exist_ok=True)
    receipt_path = directory / ("execution-" + "-".join(sorted(arms)) + ".json")
    if receipt_path.exists():
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if receipt.get("manifest_digest") != manifest["content_digest"] or receipt.get("content_digest") != digest({key: value for key, value in receipt.items() if key != "content_digest"}):
            raise ValueError("previous batch receipt changed or belongs to a different registration")
    else:
        receipt = {"schema": "nexgent-registered-batch-execution-v1", "batch_id": manifest["batch_id"], "manifest_digest": manifest["content_digest"], "manifest_file_sha256": manifest_file_sha256, "created_at": now(), "selected_arms": sorted(arms), "registered_studies": selected, "status": "running", "studies": [], "errors": [], "policy": "No create, quota increase, failed-study retry, extra study, or confirmation execution."}
    user_stop = user_stop or threading.Event()
    active_stop = [None]
    def interrupt(signum, frame):
        user_stop.set()
        if active_stop[0] is not None:
            active_stop[0].set()
    previous_handler = signal.signal(signal.SIGINT, interrupt) if install_signal else None
    save(receipt_path, receipt)
    try:
        for entry in selected:
            if user_stop.is_set():
                break
            identity = entry["study_id"]
            existing = [row for row in receipt["studies"] if row["study_id"] == identity]
            if existing:
                # A second invocation never retries an earlier admission, even
                # when the controller failed before changing a ready status.
                continue
            state = controller.get(identity)
            row = {**entry, "observed_status": state["status"], "started_at": now(), "status": "inspected", "progress": []}
            receipt["studies"].append(row)
            attempt_file = attempts / (identity + ".json")
            try:
                if state["status"] == "completed":
                    row["status"] = "skipped_completed"
                elif state["status"] != "ready":
                    row.update(status="skipped_ineligible", reason="Never automatically retry failed, paused, running or otherwise non-ready studies")
                elif attempt_file.exists():
                    row.update(status="skipped_previously_admitted", reason="A prior invocation admitted this ID; inspect its terminal record without reissuing calls")
                else:
                    with attempt_file.open("x", encoding="utf-8") as handle:
                        json.dump({"study_id": identity, "batch_id": manifest["batch_id"], "manifest_digest": manifest["content_digest"], "admitted_at": now()}, handle)
                    row["status"] = "admitted"
                    save(receipt_path, receipt)
                    active_stop[0] = threading.Event()
                    last = [None]
                    def progress(snapshot):
                        item = {"study_id": identity, "arm": entry["arm"], "seed": entry["seed"], "stage": snapshot.get("stage"), "generation": snapshot.get("generation"), "model_calls": snapshot.get("usage", {}).get("model_calls"), "reserved_completion_tokens": snapshot.get("usage", {}).get("reserved_completion_tokens")}
                        key = (item["stage"], item["generation"], item["model_calls"])
                        if key != last[0]:
                            row["progress"].append({"at": now(), **item})
                            save(receipt_path, receipt)
                            print(canonical(item), flush=True)
                            last[0] = key
                    before = time.monotonic()
                    state = controller.run(identity, progress=progress, stop_event=active_stop[0])
                    row.update(status="terminal", wall_seconds=time.monotonic() - before)
                row["terminal"] = compact(state)
            except Exception as exc:
                row.update(status="runner_failure", error=f"{type(exc).__name__}: {str(exc)[:1200]}")
                try:
                    state = controller.get(identity)
                    row["terminal"] = compact(state)
                except Exception as read_error:
                    row["terminal_read_error"] = type(read_error).__name__
            finally:
                # Export is a local evidence write; it never runs a study.
                try:
                    destination = directory / "exports" / (identity + ".json")
                    row["export_path"] = controller.export(identity, destination)
                    row["export_sha256"] = hashlib.sha256(Path(row["export_path"]).read_bytes()).hexdigest()
                except Exception as export_error:
                    row["export_error"] = f"{type(export_error).__name__}: {str(export_error)[:600]}"
                row["finished_at"] = now()
                save(receipt_path, receipt)
                print(canonical({"study_id": identity, "arm": entry["arm"], "seed": entry["seed"], "batch_action": row["status"], "study_status": row.get("terminal", {}).get("status"), "export_path": row.get("export_path"), "error": row.get("error")}), flush=True)
        receipt["status"] = "interrupted" if user_stop.is_set() else "finished_registered_queue"
    finally:
        if install_signal:
            signal.signal(signal.SIGINT, previous_handler)
        receipt["finished_at"] = now()
        receipt["remaining_study_ids"] = [entry["study_id"] for entry in selected if entry["study_id"] not in {row["study_id"] for row in receipt["studies"]}]
        save(receipt_path, receipt)
    return receipt, receipt_path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--arms", nargs="+", choices=sorted(ARMS), default=["task_only", "greedy"])
    parser.add_argument("--execute", action="store_true", help="Actually run only the registered ready IDs; omitted means read-only validation")
    args = parser.parse_args()
    if len(set(args.arms)) != len(args.arms):
        parser.error("arm filter must contain no duplicates")
    try:
        manifest, sha = load_manifest(args.manifest)
        from nexgent.evolution.controller import StudyController
        controller = StudyController(args.root)
        snapshots = inspect_studies(controller, manifest)
        if not args.execute:
            print(canonical({"status": "validated_without_execution", "batch_id": manifest["batch_id"], "manifest_digest": manifest["content_digest"], "selected_arms": args.arms, "studies": [{key: state.get(key) for key in ("id", "arm", "seed", "status", "max_generations", "budget")} for state in snapshots if state["arm"] in args.arms], "study_runs_started": 0}))
            return 0
        receipt, output = run_registered(controller, manifest, sha, set(args.arms), args.root)
        print(canonical({"status": receipt["status"], "receipt": str(output), "remaining_study_ids": receipt["remaining_study_ids"]}))
        failed = any(row["status"] == "runner_failure" or row.get("terminal", {}).get("status") in {"failed", "paused"} for row in receipt["studies"])
        return 1 if failed or receipt["status"] == "interrupted" else 0
    except (ValueError, KeyError, OSError, TypeError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    raise SystemExit(main())
