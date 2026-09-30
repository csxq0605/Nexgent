"""Task tools using the existing registry and standard-library file/SQL engines."""
import csv
import io
from pathlib import Path
import sqlite3

from .tasks.tools import ToolRegistry, ToolSpec, validate


class WorkspaceTools:
    def __init__(self, root, output, *, shared_artifacts=(), allow_artifact_writes=True):
        self.root, self.output = Path(root).resolve(), Path(output).resolve()
        self.artifacts = []
        self.shared_paths = {Path(a["path"]).resolve() for a in shared_artifacts}
        self.registry = ToolRegistry()
        for name, handler, properties, description, effect in (
            ("list_files", self.list_files, {}, "List readable project files (first 200).", "read"),
            ("read_text", self.read_text, {"path": {"type": "string"}}, "Read a UTF-8 project file, up to 30000 characters.", "read"),
            ("query_csv", self.query_csv, {"path": {"type": "string"}, "sql": {"type": "string"}},
             "Query a UTF-8 CSV using SQLite SQL. Table data has the CSV header columns as TEXT; CAST numeric columns. Returns up to 200 rows.", "local_compute"),
            ("write_artifact", self.write_artifact, {"name": {"type": "string"}, "content": {"type": "string", "maxLength": 30000}},
             "Save a UTF-8 deliverable in your isolated output directory. Use the filename required by the user, not a project path. Other members and earlier attempts have separate directories, so the same filename is allowed there.", "artifact_write"),
        ):
            if effect == "artifact_write" and not allow_artifact_writes:
                continue
            self.registry.register(ToolSpec(name, {"type": "object", "properties": properties,
                "required": list(properties), "additionalProperties": False}, {"type": "object"}, effect, handler, description))

    def source(self, path):
        requested = Path(path)
        resolved = (self.root / requested).resolve()
        accessible = self.shared_paths | {Path(a["path"]).resolve() for a in self.artifacts}
        if not resolved.exists() and requested.name == path:
            matches = [p for p in accessible if p.name == path]
            if len(matches) > 1:
                raise ValueError("Several shared artifacts have this name; use the exact absolute path")
            if matches:
                resolved = matches[0]
        if resolved in accessible:
            if not resolved.is_file() or resolved.stat().st_size > 1_000_000:
                raise ValueError("Shared artifact is missing or exceeds 1 MB")
            return resolved
        relative = resolved.relative_to(self.root)
        if any(p.startswith('.') or p.casefold() in {"models.json", "node_modules", "venv", "__pycache__"} for p in relative.parts):
            raise ValueError("Private configuration and internal directories are not task inputs")
        if not resolved.is_file() or resolved.stat().st_size > 1_000_000:
            raise ValueError("Expected a project file of at most 1 MB")
        return resolved

    def list_files(self):
        import os
        files = []
        for directory, dirs, names in os.walk(self.root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if not d.startswith('.') and d.casefold() not in {"node_modules", "venv", "__pycache__"})
            for name in sorted(names):
                path = Path(directory) / name
                try:
                    self.source(path)
                except (ValueError, OSError):
                    continue
                files.append(path.relative_to(self.root).as_posix())
                if len(files) >= 200:
                    return {"files": files, "truncated": True}
        return {"files": files, "truncated": False}

    def read_text(self, path):
        text = self.source(path).read_text(encoding="utf-8-sig")
        return {"path": path, "content": text[:30000], "truncated": len(text) > 30000}

    def query_csv(self, path, sql):
        rows = csv.reader(io.StringIO(self.source(path).read_text(encoding="utf-8-sig")))
        header = next(rows)
        if not header or len(header) > 100 or len(set(h.casefold() for h in header)) != len(header):
            raise ValueError("CSV requires unique column names, at most 100 columns")
        db = sqlite3.connect(":memory:")
        try:
            columns = ','.join('"' + h.replace('"', '""') + '" TEXT' for h in header)
            db.execute(f"CREATE TABLE data ({columns})")
            db.executemany(f"INSERT INTO data VALUES ({','.join('?' for _ in header)})", rows)
            db.execute("PRAGMA query_only=ON")
            # No filesystem access through ATTACH, pragmas or extensions.
            allowed = {sqlite3.SQLITE_SELECT, sqlite3.SQLITE_READ, sqlite3.SQLITE_FUNCTION, sqlite3.SQLITE_RECURSIVE}
            db.set_authorizer(lambda action, *_: sqlite3.SQLITE_OK if action in allowed else sqlite3.SQLITE_DENY)
            steps = 0
            def progress():
                nonlocal steps
                steps += 1
                return int(steps > 1000)
            db.set_progress_handler(progress, 1000)
            result = db.execute(sql)
            values = result.fetchmany(201)
            return {"columns": [c[0] for c in result.description], "rows": values[:200], "truncated": len(values) > 200}
        finally:
            db.close()

    def write_artifact(self, name, content):
        if not name or Path(name).name != name or any(c in name for c in '/\\:') or name.startswith('.'):
            raise ValueError("Artifact name must be a simple filename")
        self.output.mkdir(parents=True, exist_ok=True)
        path = self.output / name
        if path.exists():
            raise ValueError("Artifact already exists; use a new name")
        path.write_text(content, encoding="utf-8")
        artifact = {"path": str(path), "content": content}
        self.artifacts.append(artifact)
        return artifact

    def call(self, name, arguments):
        tool = self.registry.get(name)
        validate(arguments, tool.input_schema, label="tool arguments")
        result = tool.handler(**arguments)
        validate(result, tool.output_schema, label="tool result")
        return result
