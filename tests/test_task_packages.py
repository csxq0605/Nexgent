"""AgentPackage identity and real controlled subprocess execution checks."""

from copy import deepcopy
import os
import threading
import time

import pytest

from nexgent.tasks.packages import PackageError, make_package, verify_package
from nexgent.tasks.package_runner import run_package


def package(source="def execute(payload, context):\n    return payload\n", **extra):
    files = {"agent/main.py": source, **extra}
    return make_package(files, {"entries": {"execute": "agent/main.py:execute"}})


def test_complete_tree_identity_and_lineage():
    parent = package(**{"unused.txt": "old"})
    child = make_package({"agent/main.py": parent["files"]["agent/main.py"]}, parent["manifest"], parent=parent)
    root = package()
    assert "unused.txt" not in child["files"]
    assert child["digest"] == root["digest"]
    assert child["id"] != root["id"]
    assert child["generation"] == 1
    assert verify_package(child, parent=parent) == child
    with pytest.raises(PackageError, match="supplied parent"):
        verify_package(child, parent=root)


@pytest.mark.parametrize("field", ["files", "manifest", "component_digests", "id", "digest", "generation", "parent_id", "schema"])
def test_identity_detects_tampering(field):
    original = package()
    changed = deepcopy(original)
    if field == "files":
        changed[field]["notes.txt"] = "new behavior guidance"
    elif field == "manifest":
        changed[field]["roles"] = {"reviewer": "new prompt"}
    elif field == "component_digests":
        changed[field]["agent/main.py"] = "0" * 64
    else:
        changed[field] = 1 if field == "generation" else "tampered"
    with pytest.raises(PackageError):
        verify_package(changed)


@pytest.mark.parametrize("path", ["../x.txt", "/x.txt", "C:/x.txt", "a\\x.txt", "a/./x", "a//x", "a/../x", "NUL.txt", "a/x.", "a/x ", "a/x:stream", "a/\x00x"])
def test_rejects_unsafe_paths(path):
    with pytest.raises(PackageError, match="path"):
        package(**{path: "data"})


def test_platform_collisions_and_tree_shape():
    with pytest.raises(PackageError, match="collide"):
        package(**{"DATA.txt": "1", "data.txt": "2"})
    with pytest.raises(PackageError, match="collide"):
        package(**{"data": "1", "data/a.txt": "2"})


def test_manifest_and_prompt_resource_change_content_identity():
    original = package(**{"skills/prompt.md": "review carefully"})
    changed = deepcopy(original["manifest"])
    changed["skills"] = {"review": {"kind": "prompt_protocol", "ref": "skills/prompt.md"}}
    candidate = make_package(original["files"], changed)
    assert candidate["digest"] != original["digest"]
    assert make_package({**original["files"], "skills/prompt.md": "review skeptically"}, changed)["digest"] != candidate["digest"]


def v2_package(manifest_changes=None, file_changes=None):
    files = {
        "agent/main.py": "def execute(payload, context):\n    return payload\n",
        "prompts/reviewer.md": "Review the result.",
        "workflows/main.json": '{"nodes": [{"id": "main", "method": "ask"}]}',
        "resources/memory-policy.json": "{}",
    }
    manifest = {
        "manifest_version": 2,
        "entries": {"execute": "agent/main.py:execute"},
        "skills": {},
        "roles": {"reviewer": {"prompt_ref": "prompts/reviewer.md", "capabilities": ["ask"]}},
        "workflows": {"main": {"ref": "workflows/main.json", "max_parallel": 2}},
        "components": {
            "main-orchestrator": {"class": "O", "kind": "workflow", "ref": "main"},
            "review-role": {"class": "S", "kind": "role", "ref": "reviewer"},
            "memory-policy": {"class": "M", "kind": "resource", "ref": "resources/memory-policy.json"},
        },
        "orchestrator": "main-orchestrator",
    }
    if manifest_changes:
        manifest.update(manifest_changes)
    if file_changes:
        files.update(file_changes)
    return make_package(files, manifest)


def test_manifest_v2_registers_first_class_agent_components():
    candidate = v2_package()
    assert candidate["manifest"]["manifest_version"] == 2
    assert candidate["manifest"]["components"]["main-orchestrator"] == {
        "class": "O", "kind": "workflow", "ref": "main"}
    assert verify_package(candidate) == candidate


def test_v1_manifests_remain_loadable_with_implicit_or_explicit_version():
    implicit = package()
    explicit = make_package(implicit["files"], {
        "manifest_version": 1, "entries": {"execute": "agent/main.py:execute"}})
    assert verify_package(implicit) == implicit
    assert verify_package(explicit) == explicit


def test_manifest_v1_rejects_v2_fields_and_package_rejects_unsigned_extensions():
    with pytest.raises(PackageError, match="v2 fields"):
        make_package(
            {"main.py": "def execute(payload, context):\n    return payload\n"},
            {"entries": {"execute": "main.py:execute"}, "components": {}})
    extended = package()
    extended["components"] = {"unsigned": {"class": "M"}}
    with pytest.raises(PackageError, match="schema"):
        verify_package(extended)


def test_manifest_v2_lineage_cannot_downgrade_or_repurpose_stable_component_ids():
    parent = v2_package()
    with pytest.raises(PackageError, match="downgrade"):
        make_package(parent["files"], {
            "manifest_version": 1,
            "entries": {"execute": "agent/main.py:execute"},
        }, parent=parent)

    changed = deepcopy(parent["manifest"])
    changed["components"]["review-role"] = {
        "class": "S", "kind": "resource", "ref": "prompts/reviewer.md"}
    with pytest.raises(PackageError, match="Stable component id"):
        make_package(parent["files"], changed, parent=parent)


def test_manifest_v2_rejects_cross_class_aliases_of_the_same_file():
    components = {
        "main-orchestrator": {"class": "O", "kind": "workflow", "ref": "main"},
        "execute-code": {"class": "O", "kind": "entry", "ref": "execute"},
        "fake-memory": {"class": "M", "kind": "resource", "ref": "agent/main.py"},
    }
    with pytest.raises(PackageError, match="cannot have both O and M classes"):
        v2_package({"components": components})


def test_manifest_v2_rejects_structurally_invalid_workflow_json():
    with pytest.raises(PackageError, match="Workflow 'main' is invalid"):
        v2_package(file_changes={"workflows/main.json": "{}"})


@pytest.mark.parametrize(("manifest_changes", "match"), [
    ({"components": {
        "main-orchestrator": {"class": "O", "kind": "workflow", "ref": "missing"}}},
     "absent workflow"),
    ({"components": {
        "main-orchestrator": {"class": "O", "kind": "workflow", "ref": "main"},
        "duplicate": {"class": "S", "kind": "workflow", "ref": "main"}}},
     "Duplicate component reference"),
    ({"components": {
        "main-orchestrator": {"class": "X", "kind": "workflow", "ref": "main"}}},
     "class must be O, M, or S"),
    ({"orchestrator": "missing"}, "registered component"),
    ({"components": {
        "main-orchestrator": {"class": "S", "kind": "role", "ref": "reviewer"}}},
     "O entry or workflow"),
])
def test_manifest_v2_rejects_invalid_component_contracts(manifest_changes, match):
    with pytest.raises(PackageError, match=match):
        v2_package(manifest_changes)


@pytest.mark.parametrize(("manifest_changes", "match"), [
    ({"roles": {"reviewer": {"prompt_ref": "prompts/missing.md"}}}, "resource is absent"),
    ({"roles": {"reviewer": {"capabilities": ["shell"]}}}, "registered capabilities"),
    ({"roles": {"reviewer": {"capabilities": [{}]}}}, "registered capabilities"),
    ({"workflows": {"main": {"ref": "workflows/missing.json"}}}, "resource is absent"),
])
def test_manifest_v2_rejects_invalid_first_class_registry_references(manifest_changes, match):
    with pytest.raises(PackageError, match=match):
        v2_package(manifest_changes)


def test_real_multimodule_execution_and_receipts():
    candidate = package("def execute(payload, context):\n    return context.call('skills/check.py:check', payload)\n",
                        **{"skills/check.py": "def check(payload, context):\n    return {'total': sum(payload), 'note': context.resource('resources/note.md')}\n",
                           "resources/note.md": "verified"})
    result = run_package(candidate, "execute", [2, 3, 5])
    assert result["value"] == {"total": 10, "note": "verified"}
    execution = result["execution"]
    assert execution["pid"] != os.getpid()
    assert execution["package_id"] == candidate["id"]
    assert execution["package_digest"] == candidate["digest"]
    assert execution["loaded_modules"] == [
        "agent/main.py", "skills/check.py", "resources/note.md"]
    assert execution["local_calls"] == [{"ref": "skills/check.py:check"}]
    assert execution["instructions"] > 0
    assert execution["rpc_count"] == 0
    assert execution["isolation"]["audit_hook"] is True
    assert execution["isolation"]["os_filesystem_container"] is False


def test_resource_load_receipt_is_ordered_and_idempotent():
    source = """def execute(payload, context):
    first = context.resource('prompts/task.md')
    second = context.resource('prompts/task.md')
    context.resource('skills/check.py')
    checked = context.call('skills/check.py:check', payload)
    return {'first': first, 'second': second, 'checked': checked}
"""
    candidate = package(source, **{
        "prompts/task.md": "Follow the task contract.",
        "skills/check.py": "def check(payload, context):\n    return payload['value']\n",
    })

    result = run_package(candidate, "execute", {"value": 7})

    assert result["value"] == {
        "first": "Follow the task contract.",
        "second": "Follow the task contract.",
        "checked": 7,
    }
    assert result["execution"]["loaded_modules"] == [
        "agent/main.py", "prompts/task.md", "skills/check.py"]


def test_module_namespaces_are_separate():
    candidate = package("secret = 12\ndef execute(payload, context):\n    return context.call('other.py:check', payload)\n",
                        **{"other.py": "def check(payload, context):\n    return secret\n"})
    with pytest.raises(PackageError, match="NameError"):
        run_package(candidate, "execute", {})


def test_improve_and_registered_skill_entries():
    files = {"main.py": "def execute(payload, context):\n    return payload\n",
             "improvement/run.py": "def improve(payload, context):\n    return {'candidate': payload}\n",
             "skills/check.py": "def check(payload, context):\n    return {'checked': payload}\n"}
    candidate = make_package(files, {"entries": {"execute": "main.py:execute", "improve": "improvement/run.py:improve"},
                                     "skills": {"check": {"kind": "controlled_code", "ref": "skills/check.py:check"}}})
    assert run_package(candidate, "improve", 7)["value"] == {"candidate": 7}
    assert run_package(candidate, "skill:check", 8)["value"] == {"checked": 8}
    with pytest.raises(PackageError, match="Unregistered"):
        run_package(candidate, "skills/check.py:check", {})


@pytest.mark.parametrize("source", [
    "import os\ndef execute(payload, context):\n    return os.environ\n",
    "def execute(payload, context):\n    return open('secret').read()\n",
    "def execute(payload, context):\n    return context.__dict__\n",
    "def execute(payload, context):\n    return context.request('ask', {})\n",
    "def execute(payload, context):\n    return execute.__globals__\n",
])
def test_io_import_and_introspection_are_rejected(source):
    with pytest.raises(PackageError):
        package(source)


def test_resource_cannot_read_host_files():
    candidate = package("def execute(payload, context):\n    return context.resource('../.env')\n")
    with pytest.raises(PackageError, match="Unsafe package path"):
        run_package(candidate, "execute", {})


def test_capability_dispatch_and_defaults_are_explicit():
    source = """def execute(payload, context):
    context.ask('reviewer', 'inspect')
    context.tool('checker')
    context.parallel([{'kind': 'ask'}])
    context.skill('review')
    context.delegate({'objective': 'inspect'})
    context.read_artifact('artifact-1')
    context.publish({'answer': 42})
    context.memory_search('prior result')
    context.remember('check first')
    context.plan({'nodes': []})
    return context.feedback({'passed': True})
"""
    calls = []
    caller_thread = threading.get_ident()

    def handle(method, params):
        assert threading.get_ident() == caller_thread
        calls.append((method, params))
        return {"accepted": method}

    result = run_package(package(source), "execute", {}, handle)
    assert result["value"] == {"accepted": "feedback"}
    assert result["execution"]["rpc_count"] == len(calls) == 11
    assert calls[0] == ("ask", {"role": "reviewer", "prompt": "inspect", "payload": None, "max_tokens": 4000})
    assert calls[1] == ("tool", {"name": "checker", "arguments": None})
    assert calls[6] == ("publish", {"content": {"answer": 42}, "schema": "application/json", "name": None,
                                    "input_refs": ["artifact-1"]})
    assert calls[8] == ("remember", {"content": "check first", "kind": "experience", "evidence": None})


def test_capability_budget_and_missing_handler():
    candidate = package("def execute(payload, context):\n    context.ask('r', 'p')\n    return context.ask('r', 'p')\n")
    with pytest.raises(PackageError, match="no external capabilities"):
        run_package(candidate, "execute", {})
    calls = []
    with pytest.raises(PackageError, match="RPC budget"):
        run_package(candidate, "execute", {}, lambda m, p: calls.append(m), max_rpc=1)
    assert calls == ["ask"]


def test_instruction_budget_cannot_be_caught_to_disable_tracing():
    candidate = package("def execute(payload, context):\n    while True:\n        try:\n            for i in range(100):\n                payload = i\n        except Exception:\n            pass\n")
    with pytest.raises(PackageError, match="instruction budget"):
        run_package(candidate, "execute", {}, max_instructions=1000)


def test_timeout_terminates_and_joins_worker_threads():
    candidate = package("def execute(payload, context):\n    while True:\n        payload = 1\n")
    stop = threading.Event()
    with pytest.raises(TimeoutError):
        run_package(candidate, "execute", {}, stop_event=stop, timeout=0.2, max_instructions=100_000_000)
    assert stop.is_set()
    assert not any(t.name.startswith("nexgent-package-") for t in threading.enumerate())


@pytest.mark.parametrize("reason", ["timeout", "cancel"])
def test_watchdog_cancels_active_synchronous_handler(reason):
    candidate = package("def execute(payload, context):\n    return context.tool('slow')\n")
    stop = threading.Event()
    entered = threading.Event()
    completed = []

    def handle(method, params):
        entered.set()
        assert stop.wait(5)
        completed.append(method)
        return {"stopped": True}

    def cancel():
        assert entered.wait(5)
        stop.set()

    cancel_thread = threading.Thread(target=cancel) if reason == "cancel" else None
    if cancel_thread:
        cancel_thread.start()
    try:
        with pytest.raises(InterruptedError if reason == "cancel" else TimeoutError):
            run_package(candidate, "execute", {}, handle, stop_event=stop, timeout=0.8 if reason == "timeout" else 5)
    finally:
        if cancel_thread:
            cancel_thread.join()
    assert entered.is_set()
    assert completed == ["tool"]
    assert not any(t.name.startswith("nexgent-package-") for t in threading.enumerate())


def test_pre_cancelled_and_non_json_input():
    stop = threading.Event()
    stop.set()
    with pytest.raises(InterruptedError):
        run_package(package(), "execute", {}, stop_event=stop)
    with pytest.raises(PackageError, match="finite JSON"):
        run_package(package(), "execute", float("nan"))


def test_prompt_and_workflow_skills_require_real_bounded_resources():
    files = {"agent.py": "def execute(payload, context): return payload\n", "prompt.md": "Review evidence."}
    manifest = {"entries": {"execute": "agent.py:execute"}, "skills": {
        "review": {"kind": "prompt_protocol", "ref": "missing.md"}}}
    with pytest.raises(PackageError, match="resource is absent"):
        make_package(files, manifest)
    manifest["skills"]["review"].update(ref="prompt.md", max_tokens=0)
    with pytest.raises(PackageError, match="token ceiling"):
        make_package(files, manifest)
    manifest["skills"]["review"]["max_tokens"] = 800
    assert make_package(files, manifest)["manifest"]["skills"]["review"]["ref"] == "prompt.md"


def test_skill_schemas_reject_external_references():
    files = {"agent.py": "def execute(payload, context): return payload\n", "prompt.md": "Analyze."}
    manifest = {"entries": {"execute": "agent.py:execute"}, "skills": {"analyze": {
        "kind": "prompt_protocol", "ref": "prompt.md",
        "input_schema": {"$ref": "https://example.invalid/schema"}}}}
    with pytest.raises(PackageError, match="local schema references"):
        make_package(files, manifest)
