"""Explicit, hash-verified download of unmodified official BBH data."""

import argparse
import hashlib
import json
from pathlib import Path
import urllib.request

COMMIT = "9ee07bd481feebf959a6b59d61ea57bdcf30964d"
REPOSITORY = "https://github.com/suzgunmirac/BIG-Bench-Hard"
FILES = {
    "boolean_expressions.json": "ea6c754ec005e2d3f2d085d349a740f593b5764f32ea4638ffed4cfc0061b12a",
    "word_sorting.json": "2a6132d2c99f00d0d2eb1113ac6b4a918bd969d863c48749210d969713db8d43",
    "LICENSE": "4ef2ff4295d26ab6211235039c132697408cec5391d2c091b41e983771978db8",
}
TASKS = ("boolean_expressions", "word_sorting")


class DatasetError(ValueError):
    pass


def source_manifest():
    return {"schema": "nexgent-bbh-data-v1", "repository": REPOSITORY, "commit": COMMIT,
            "license": "MIT", "license_file": "LICENSE", "sha256": dict(FILES),
            "tasks": list(TASKS), "official_examples_per_task": 250,
            "scope": "Two BBH tasks, not the full 23-task benchmark. Original canary strings and bytes are preserved.",
            "paper": "https://aclanthology.org/2023.findings-acl.824/"}


def download(destination, opener=None):
    """Network access occurs only through this explicitly invoked function."""
    destination = Path(destination).expanduser().resolve()
    opener = opener or urllib.request.urlopen
    verified = {}
    for filename, expected in FILES.items():
        local = destination / filename
        if local.exists():
            content = local.read_bytes()
            if hashlib.sha256(content).hexdigest() != expected:
                raise DatasetError(f"Existing {filename} differs from the pinned data; choose a clean destination")
        else:
            relative = filename if filename == "LICENSE" else "bbh/" + filename
            url = f"https://raw.githubusercontent.com/suzgunmirac/BIG-Bench-Hard/{COMMIT}/{relative}"
            with opener(url, timeout=30) as response:
                content = response.read(2_000_001)
            if len(content) > 2_000_000 or hashlib.sha256(content).hexdigest() != expected:
                raise DatasetError(f"Downloaded {filename} failed its pinned SHA256 check")
        verified[filename] = content
    # Check every download before creating any new dataset file.
    destination.mkdir(parents=True, exist_ok=True)
    for filename, content in verified.items():
        path = destination / filename
        if not path.exists(): path.write_bytes(content)
    manifest = source_manifest()
    (destination / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    return destination


def load(destination):
    destination = Path(destination).expanduser().resolve()
    try:
        manifest = json.loads((destination / "manifest.json").read_text(encoding="utf-8"))
        if manifest != source_manifest():
            raise DatasetError("BBH manifest differs from the registered dataset")
        records = {}
        for filename, expected in FILES.items():
            content = (destination / filename).read_bytes()
            if hashlib.sha256(content).hexdigest() != expected:
                raise DatasetError(f"BBH {filename} failed its pinned SHA256 check")
            if filename.endswith(".json"):
                data = json.loads(content)
                examples = data.get("examples")
                if not data.get("canary") or not isinstance(examples, list) or len(examples) != 250:
                    raise DatasetError(f"Unexpected official BBH schema: {filename}")
                if any(not isinstance(r, dict) or not isinstance(r.get("input"), str) or not isinstance(r.get("target"), str) for r in examples):
                    raise DatasetError(f"Invalid example in {filename}")
                records[filename[:-5]] = examples
        return records, manifest
    except FileNotFoundError:
        raise DatasetError("Official BBH data is missing. Run nexgent-bbh-download --destination PATH, then set NEXGENT_BBH_DATA=PATH.") from None


def main(argv=None):
    parser = argparse.ArgumentParser(description="Download the pinned official two-task BBH subset; no model calls")
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args(argv)
    print(download(args.destination))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
