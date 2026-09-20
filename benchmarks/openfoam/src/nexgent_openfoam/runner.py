"""Trusted, fixed OpenFOAM runner. No task value becomes shell text or argv."""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time

from .data import TEMPLATE_RELPATH, digest


PROGRAMS = ("blockMesh", "checkMesh", "icoFoam")
WSL_DISTRIBUTION = "Ubuntu-20.04"
WSL_BASHRC = "/opt/openfoam8/etc/bashrc"
WSL_TEMPLATE = "/opt/openfoam8/tutorials/" + TEMPLATE_RELPATH
WSL_PROBE_SCRIPT = r'''source /opt/openfoam8/etc/bashrc >/dev/null 2>&1 || exit 10
printf '%s\n' "$WM_PROJECT" "$WM_PROJECT_VERSION"
printf '%s\n' "$(command -v blockMesh)" "$(command -v checkMesh)" "$(command -v icoFoam)"
test -d /opt/openfoam8/tutorials/incompressible/icoFoam/cavity/cavity || exit 11
'''
WSL_COPY_SCRIPT = r'''source /opt/openfoam8/etc/bashrc >/dev/null 2>&1 || exit 10
src=/opt/openfoam8/tutorials/incompressible/icoFoam/cavity/cavity
dst="$1"
test -d "$src" || exit 11
test ! -e "$dst" || exit 12
test "$(find "$src" -type l -print -quit)" = "" || exit 13
count=$(find "$src" -type f -printf '.' | wc -c)
bytes=$(find "$src" -type f -printf '%s\n' | awk '{s+=$1} END {print s+0}')
test "$count" -le 256 || exit 14
test "$bytes" -le 16777216 || exit 15
mkdir -p "$dst" || exit 16
cp -R --no-preserve=ownership -- "$src"/. "$dst"/ || exit 17
'''
WSL_TOOL_SCRIPT = r'''source /opt/openfoam8/etc/bashrc >/dev/null 2>&1 || exit 10
case_dir="$1"
program="$2"
timeout_seconds="$3"
case "$program" in blockMesh|checkMesh|icoFoam) ;; *) exit 64 ;; esac
case "$timeout_seconds" in ''|*[!0-9]*) exit 65 ;; esac
test "$timeout_seconds" -ge 1 -a "$timeout_seconds" -le 300 || exit 65
# The host remains the authoritative timer.  This fixed inner guard ensures a
# Linux solver cannot outlive a killed/disconnected wsl.exe client indefinitely.
exec /usr/bin/timeout --signal=TERM --kill-after=2s "$((timeout_seconds + 2))" \
    "$program" -case "$case_dir"
'''
MAX_TEMPLATE_FILES = 256
MAX_TEMPLATE_BYTES = 16 * 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 60
DEFAULT_OUTPUT_LIMIT = 64 * 1024


class EnvironmentUnavailable(RuntimeError):
    pass


class UnsafeTemplate(RuntimeError):
    pass


class OpenFOAMRunError(RuntimeError):
    pass


@dataclass(frozen=True)
class EnvironmentProbe:
    available: bool
    backend: str | None
    version: str | None
    project: str | None
    template: Path | str | None
    executables: dict[str, Path | None]
    reasons: tuple[str, ...]
    launcher: Path | None = None

    def public(self):
        return {
            "available": self.available,
            "status": "available" if self.available else "unavailable",
            "backend": self.backend,
            "foundation_version": self.version,
            "project": self.project,
            "template": str(self.template) if self.template else None,
            "executables": {
                name: str(path) if path else None for name, path in self.executables.items()
            },
            "reasons": list(self.reasons),
            "scope": (
                "Read-only host inspection. Availability means an already configured "
                "OpenFOAM Foundation 8 environment with the official cavity template; "
                "on Windows the fixed probe may start the configured WSL distribution "
                "and sources only the installed OpenFOAM environment script."
            ),
        }


def _wsl_launcher(environ, which):
    found = which("wsl.exe") or which("wsl")
    if found:
        return Path(found).resolve()
    system_root = environ.get("SystemRoot")
    if isinstance(system_root, str) and system_root:
        candidate = (Path(system_root) / "System32" / "wsl.exe").resolve()
        if candidate.is_file():
            return candidate
    return None


def discover_environment(environ=None, which=None, run_factory=subprocess.run):
    environ = os.environ if environ is None else environ
    which = shutil.which if which is None else which
    raw_version = environ.get("WM_PROJECT_VERSION")
    version = raw_version.strip() if isinstance(raw_version, str) and raw_version.strip() else None
    project = environ.get("WM_PROJECT")
    project = project.strip() if isinstance(project, str) and project.strip() else None
    tutorial_root = environ.get("FOAM_TUTORIALS")
    template = None
    if isinstance(tutorial_root, str) and tutorial_root.strip():
        candidate = (Path(tutorial_root).expanduser() / Path(TEMPLATE_RELPATH)).resolve()
        if candidate.is_dir():
            template = candidate
    executables = {}
    for name in PROGRAMS:
        found = which(name)
        path = Path(found).resolve() if found else None
        executables[name] = path if path and path.is_file() else None
    reasons = []
    if version != "8":
        reasons.append("foundation_version_8_required")
    if project != "OpenFOAM":
        reasons.append("foundation_project_marker_required")
    if template is None:
        reasons.append("official_cavity_template_missing")
    for name in PROGRAMS:
        if executables[name] is None:
            reasons.append(f"executable_missing:{name}")
    if not reasons:
        return EnvironmentProbe(True, "native", version, project, template, executables, ())

    launcher = _wsl_launcher(environ, which)
    wsl_reasons = []
    if launcher is None:
        wsl_reasons.append("wsl_launcher_missing")
    else:
        try:
            result = run_factory(
                [str(launcher), "-d", WSL_DISTRIBUTION, "--exec", "/bin/bash", "--noprofile",
                 "--norc", "-c", WSL_PROBE_SCRIPT],
                stdin=subprocess.DEVNULL, capture_output=True, timeout=30,
                check=False, shell=False,
            )
            output = result.stdout or b""
            if isinstance(output, str):
                output = output.encode("utf-8")
            if len(output) > 4096:
                wsl_reasons.append("wsl_probe_output_exceeded_bound")
                lines = []
            else:
                lines = output.decode("utf-8", errors="replace").splitlines()
            if result.returncode != 0:
                wsl_reasons.append(f"wsl_probe_failed:{result.returncode}")
            elif len(lines) != 5 or lines[:2] != ["OpenFOAM", "8"]:
                wsl_reasons.append("wsl_foundation_8_contract_mismatch")
            elif any(not line.startswith("/") for line in lines[2:]):
                wsl_reasons.append("wsl_executable_probe_invalid")
        except (OSError, subprocess.SubprocessError) as exc:
            wsl_reasons.append(f"wsl_probe_error:{type(exc).__name__}")
    if not wsl_reasons:
        return EnvironmentProbe(
            True, "wsl", "8", "OpenFOAM", WSL_TEMPLATE,
            {name: Path(lines[index + 2]) for index, name in enumerate(PROGRAMS)},
            (), launcher,
        )
    return EnvironmentProbe(
        False, None, version, project, template, executables,
        tuple(reasons + wsl_reasons), launcher,
    )


def _regular_files(root):
    root = root.resolve()
    files = []
    total = 0
    for path in sorted(root.rglob("*"), key=lambda item: item.as_posix()):
        if path.is_symlink():
            raise UnsafeTemplate("Official template copy refuses symbolic links")
        if path.is_dir():
            continue
        if not path.is_file():
            raise UnsafeTemplate("Official template contains a non-regular filesystem entry")
        relative = path.relative_to(root)
        size = path.stat().st_size
        files.append((relative, path, size))
        total += size
        if len(files) > MAX_TEMPLATE_FILES or total > MAX_TEMPLATE_BYTES:
            raise UnsafeTemplate("Official template exceeds the bounded copy allowance")
    if not files:
        raise UnsafeTemplate("Official template is empty")
    return files


def tree_digest(root):
    root = Path(root).resolve()
    sha = hashlib.sha256()
    for relative, path, size in _regular_files(root):
        encoded = relative.as_posix().encode("utf-8")
        sha.update(len(encoded).to_bytes(4, "big"))
        sha.update(encoded)
        sha.update(size.to_bytes(8, "big"))
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(65536), b""):
                sha.update(chunk)
    return sha.hexdigest()


def validate_template_contract(template):
    template = Path(template).resolve()
    required = [
        template / "0" / "U",
        template / "0" / "p",
        template / "constant" / "transportProperties",
        template / "system" / "blockMeshDict",
        template / "system" / "controlDict",
        template / "system" / "fvSchemes",
        template / "system" / "fvSolution",
    ]
    if any(not path.is_file() or path.is_symlink() for path in required):
        raise UnsafeTemplate("Official cavity template is missing required regular files")
    control = (template / "system" / "controlDict").read_text(encoding="utf-8", errors="replace")
    transport = (template / "constant" / "transportProperties").read_text(
        encoding="utf-8", errors="replace")
    if not re.search(r"\bapplication\s+icoFoam\s*;", control):
        raise UnsafeTemplate("controlDict must select icoFoam")
    nu = re.search(
        r"\bnu(?:\s+nu)?\s*\[\s*0\s+2\s+-1\s+0\s+0\s+0\s+0\s*\]\s*"
        r"([0-9.eE+-]+)\s*;", transport)
    if not nu or not math.isclose(float(nu.group(1)), 0.01, rel_tol=0.0, abs_tol=1e-12):
        raise UnsafeTemplate("nu_dimensions_or_value_mismatch_for_re10")


def copy_template(template, destination):
    template = Path(template).resolve()
    destination = Path(destination).resolve()
    files = _regular_files(template)
    if destination.exists():
        raise FileExistsError(f"Destination already exists: {destination}")
    destination.mkdir(parents=True)
    for relative, source, _ in files:
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target, follow_symlinks=False)


def windows_path_to_wsl(path):
    path = Path(path).resolve()
    drive = path.drive
    if not re.fullmatch(r"[A-Za-z]:", drive):
        raise UnsafeTemplate("Managed WSL case must be on a drive-letter path")
    relative = path.relative_to(drive + "\\").as_posix()
    if any(ord(character) < 32 for character in relative):
        raise UnsafeTemplate("Managed WSL case path contains control characters")
    return f"/mnt/{drive[0].lower()}/{relative}"


def copy_official_template(environment, destination, *, run_factory=subprocess.run):
    destination = Path(destination).resolve()
    if environment.backend == "native":
        validate_template_contract(environment.template)
        copy_template(environment.template, destination)
    elif environment.backend == "wsl":
        if environment.launcher is None:
            raise EnvironmentUnavailable("WSL launcher disappeared after environment probe")
        result = run_factory(
            [str(environment.launcher), "-d", WSL_DISTRIBUTION, "--exec", "/bin/bash",
             "--noprofile", "--norc", "-c", WSL_COPY_SCRIPT,
             "nexgent-openfoam-copy", windows_path_to_wsl(destination)],
            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            timeout=20, check=False, shell=False,
        )
        output = result.stdout or b""
        if isinstance(output, str):
            output = output.encode("utf-8")
        if result.returncode != 0:
            raise UnsafeTemplate(
                f"Fixed WSL template copy failed with exit {result.returncode}: "
                + output[:1000].decode("utf-8", errors="replace"))
        if len(output) > 4096:
            raise UnsafeTemplate("Fixed WSL template copy output exceeded its bound")
        validate_template_contract(destination)
    else:
        raise EnvironmentUnavailable("No supported OpenFOAM execution backend")
    return tree_digest(destination)


class _BoundedCapture:
    def __init__(self, limit):
        self.limit = limit
        self.first = bytearray()
        self.tail = bytearray()
        self.total = 0
        self.sha = hashlib.sha256()
        self.error = None

    def consume(self, pipe):
        try:
            while True:
                chunk = pipe.read(8192)
                if not chunk:
                    break
                self.total += len(chunk)
                self.sha.update(chunk)
                half = self.limit // 2
                if len(self.first) < half:
                    take = min(half - len(self.first), len(chunk))
                    self.first.extend(chunk[:take])
                self.tail.extend(chunk)
                if len(self.tail) > self.limit - half:
                    del self.tail[:len(self.tail) - (self.limit - half)]
        except Exception as exc:  # pragma: no cover - OS pipe failures are platform-specific.
            self.error = exc
        finally:
            pipe.close()

    def result(self):
        truncated = self.total > self.limit
        if truncated:
            body = bytes(self.first) + b"\n...[bounded output truncated]...\n" + bytes(self.tail)
        else:
            body = bytes(self.first)
            if len(body) < self.total:
                body += bytes(self.tail[-(self.total - len(body)):])
        return body.decode("utf-8", errors="replace"), truncated, self.sha.hexdigest()


def _run_command(program, argv, public_argv, case_dir, *, timeout_s, output_limit,
                 popen_factory, monotonic, check_stop):
    started = monotonic()
    process = popen_factory(
        argv, cwd=str(case_dir), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT, shell=False, env={**os.environ, "LC_ALL": "C"},
    )
    capture = _BoundedCapture(output_limit)
    reader = threading.Thread(target=capture.consume, args=(process.stdout,), daemon=True)
    reader.start()
    timed_out = False
    pending_error = None
    try:
        while process.poll() is None:
            check_stop()
            if monotonic() - started >= timeout_s:
                timed_out = True
                process.kill()
                break
            time.sleep(0.05)
    except BaseException as exc:
        pending_error = exc
    finally:
        if process.poll() is None:
            try:
                process.terminate()
                process.wait(timeout=2)
            except (subprocess.TimeoutExpired, OSError):
                process.kill()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                raise OpenFOAMRunError(f"{program} process did not terminate") from None
        reader.join(timeout=5)
    if reader.is_alive():
        raise OpenFOAMRunError(f"{program} output reader did not terminate")
    if capture.error:
        raise OpenFOAMRunError(f"{program} output capture failed: {capture.error}")
    if pending_error is not None:
        raise pending_error
    preview, truncated, output_digest = capture.result()
    receipt = {
        "program": program,
        "argv": public_argv,
        "returncode": int(process.returncode),
        "duration_ms": max(0, int((monotonic() - started) * 1000)),
        "output_bytes": capture.total,
        "output_digest": output_digest,
        "output_preview": preview,
        "output_truncated": truncated,
        "timed_out": timed_out,
    }
    if timed_out:
        raise OpenFOAMRunError(f"{program} exceeded the fixed {timeout_s}s timeout")
    if process.returncode != 0:
        tail = preview[-1000:].replace("\x00", "")
        raise OpenFOAMRunError(f"{program} exited {process.returncode}; bounded output: {tail}")
    return receipt


def execute_case(case_dir, environment, *, timeout_s=DEFAULT_TIMEOUT_SECONDS,
                 output_limit=DEFAULT_OUTPUT_LIMIT, popen_factory=subprocess.Popen,
                 monotonic=time.monotonic, check_stop=lambda: None):
    if type(timeout_s) is not int or not 1 <= timeout_s <= 300:
        raise ValueError("timeout_s must be an integer in [1, 300]")
    if type(output_limit) is not int or not 4096 <= output_limit <= 262144:
        raise ValueError("output_limit must be an integer in [4096, 262144]")
    case_dir = Path(case_dir).resolve()
    receipts = []
    started = monotonic()
    if isinstance(environment, dict):
        environment = EnvironmentProbe(True, "native", "8", "OpenFOAM", None, environment, ())
    for program in PROGRAMS:
        executable = environment.executables.get(program)
        if environment.backend == "native":
            if not isinstance(executable, Path) or not executable.is_file():
                raise EnvironmentUnavailable(f"Trusted executable unavailable: {program}")
            argv = [str(executable), "-case", str(case_dir)]
            public_argv = [program, "-case", "<managed-case>"]
        elif environment.backend == "wsl":
            if environment.launcher is None:
                raise EnvironmentUnavailable("WSL launcher unavailable")
            argv = [
                str(environment.launcher), "-d", WSL_DISTRIBUTION, "--exec", "/bin/bash",
                "--noprofile", "--norc", "-c", WSL_TOOL_SCRIPT,
                "nexgent-openfoam-run", windows_path_to_wsl(case_dir), program,
                str(timeout_s),
            ]
            public_argv = [program, "-case", "<managed-wsl-case>"]
        else:
            raise EnvironmentUnavailable("No supported OpenFOAM execution backend")
        receipts.append(_run_command(
            program, argv, public_argv, case_dir, timeout_s=timeout_s,
            output_limit=output_limit, popen_factory=popen_factory,
            monotonic=monotonic, check_stop=check_stop,
        ))
    return {
        "timeout_seconds_per_command": timeout_s,
        "output_limit_bytes_per_command": output_limit,
        "command_count": 3,
        "wall_time_ms": max(0, int((monotonic() - started) * 1000)),
        "commands": receipts,
    }


def _latest_time_directory(case_dir):
    candidates = []
    for path in Path(case_dir).iterdir():
        if path.is_dir():
            try:
                value = float(path.name)
            except ValueError:
                continue
            if value > 0 and math.isfinite(value):
                candidates.append((value, path))
    if not candidates:
        raise OpenFOAMRunError("Solver did not write a positive time directory")
    return max(candidates, key=lambda item: item[0])


_FLOAT = r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?"


def parse_field(path, name):
    path = Path(path)
    raw = path.read_bytes()
    if len(raw) > 8 * 1024 * 1024:
        raise OpenFOAMRunError(f"Field {name} exceeds the parser bound")
    text = raw.decode("utf-8", errors="strict")
    class_match = re.search(r"\bclass\s+([^;\s]+)\s*;", text)
    dimensions = re.search(r"\bdimensions\s+(\[[^;]+\])\s*;", text)
    internal = re.search(r"\binternalField\s+(.*?);", text, flags=re.DOTALL)
    if not class_match or not dimensions or not internal:
        raise OpenFOAMRunError(f"Field {name} lacks a required OpenFOAM header/value")
    body = internal.group(1)
    declared = re.search(r"\bnonuniform\s+List<[^>]+>\s+(\d+)\s*\((.*)\)\s*$",
                         body, flags=re.DOTALL)
    values = [float(item) for item in re.findall(_FLOAT, declared.group(2) if declared else body)]
    if not values or not all(math.isfinite(value) for value in values):
        raise OpenFOAMRunError(f"Field {name} has no finite internal values")
    if declared:
        count = int(declared.group(1))
        width = 3 if "vector" in class_match.group(1).lower() else 1
        if len(values) != count * width:
            raise OpenFOAMRunError(f"Field {name} value count does not match its declaration")
    else:
        count = 1
    return {
        "name": name,
        "path": path.parent.name + "/" + path.name,
        "digest": hashlib.sha256(raw).hexdigest(),
        "class": class_match.group(1),
        "dimensions": " ".join(dimensions.group(1).split()),
        "value_count": count,
        "finite": True,
        "minimum": min(values),
        "maximum": max(values),
    }


def parse_run(case_dir, resource_receipt):
    outputs = {item["program"]: item["output_preview"] for item in resource_receipt["commands"]}
    block = outputs["blockMesh"]
    check = outputs["checkMesh"]
    solver = outputs["icoFoam"]
    # Foundation 8 reports the authoritative mesh statistics in checkMesh;
    # retain blockMesh as a compatibility fallback for other supported hosts.
    cells = re.findall(r"\bcells:\s*(\d+)\b", check)
    if not cells:
        cells = re.findall(r"\bcells:\s*(\d+)\b", block)
    times = [float(value) for value in re.findall(r"(?m)^Time\s*=\s*(%s)\s*$" % _FLOAT, solver)]
    if not cells or not times:
        raise OpenFOAMRunError("Bounded logs do not contain mesh cell count and solver time evidence")
    latest_value, latest_dir = _latest_time_directory(case_dir)
    fields = [parse_field(latest_dir / name, name) for name in ("U", "p")]
    return {
        "mesh": {"cell_count": int(cells[-1]), "mesh_ok": "Mesh OK." in check},
        "solver": {
            "end_time": max(times),
            "completed": "End" in solver and latest_value >= max(times),
            "residual_lines_observed": len(re.findall(r"\bSolving for\b", solver)),
            "residual_scan_complete": not next(
                item["output_truncated"] for item in resource_receipt["commands"]
                if item["program"] == "icoFoam"),
        },
        "fields": fields,
    }


def make_run_documents(case_receipt, resource_receipt, parsed, case_digest_after):
    checks = [
        {"name": "all_commands_succeeded", "passed": all(
            item["returncode"] == 0 and not item["timed_out"]
            for item in resource_receipt["commands"]),
         "evidence": "Fixed blockMesh, checkMesh and icoFoam receipts all returned zero."},
        {"name": "mesh_ok", "passed": parsed["mesh"]["mesh_ok"],
         "evidence": "checkMesh bounded log contains Mesh OK."},
        {"name": "official_cell_count", "passed": parsed["mesh"]["cell_count"] == 400,
         "evidence": f"checkMesh reported {parsed['mesh']['cell_count']} cells; frozen smoke contract is 400."},
        {"name": "solver_reached_end_time", "passed": (
            parsed["solver"]["completed"] and parsed["solver"]["end_time"] >= 0.5),
         "evidence": f"icoFoam reported end time {parsed['solver']['end_time']}; contract minimum is 0.5."},
        {"name": "finite_written_fields", "passed": (
            len(parsed["fields"]) == 2 and all(item["finite"] for item in parsed["fields"])),
         "evidence": "Latest written U and p internal fields were parsed and all numeric values are finite."},
    ]
    payload = {
        "job_digest": case_receipt["job_digest"],
        "spec_digest": case_receipt["spec_digest"],
        "template_digest": case_receipt["template_digest"],
        "case_digest_before_run": case_receipt["case_digest"],
        "case_digest_after_run": case_digest_after,
        "resource_receipt": resource_receipt,
        "parsed": parsed,
    }
    run_digest = digest(payload)
    manifest = {
        "schema_version": "openfoam-run-manifest-v1",
        "run_digest": run_digest,
        "job_digest": case_receipt["job_digest"],
        "spec_digest": case_receipt["spec_digest"],
        "scenario": "cavity_re10",
        "solver": "icoFoam",
        "foundation_version": "8",
        "template_digest": case_receipt["template_digest"],
        "provenance": {
            "template_relpath": TEMPLATE_RELPATH,
            "execution_backend": case_receipt["execution_backend"],
            "case_digest_before_run": case_receipt["case_digest"],
            "case_digest_after_run": case_digest_after,
        },
        "resource_receipt": resource_receipt,
    }
    report = {
        "schema_version": "openfoam-verification-report-v1",
        "run_digest": run_digest,
        "status": "passed" if all(item["passed"] for item in checks) else "failed",
        "checks": checks,
        "mesh": parsed["mesh"],
        "solver": parsed["solver"],
        "fields": parsed["fields"],
        "scope": (
            "Execution and structural smoke evidence only. This report does not establish "
            "numerical accuracy, grid convergence, performance, general CFD validity, or RSI."
        ),
    }
    return {"run_manifest": manifest, "verification_report": report}


def write_json(path, value):
    path = Path(path)
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"),
                         ensure_ascii=False, allow_nan=False).encode("utf-8")
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes(encoded)
    os.replace(temporary, path)


def read_json(path, *, max_bytes=2 * 1024 * 1024):
    path = Path(path)
    if path.stat().st_size > max_bytes:
        raise ValueError("Managed JSON receipt exceeds the read bound")
    return json.loads(path.read_text(encoding="utf-8"))
