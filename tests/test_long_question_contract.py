"""Real source processes and real search validation; model and HTTP replies are fixtures."""

from copy import deepcopy
import json
import os

import pytest

from nexgent.agents import ImprovementBroker, seed_files
from nexgent.kernel.programs import make_bundle
from nexgent.kernel.runner import ProgramRunner
from nexgent.research import LiteratureSearch


PILOT_QUESTION = (
    "Investigate whether actual offspring evidence can improve the executable research program. "
    "Use the supplied benchmark only as the task environment. Diagnose registered public failures, "
    "change substantive improve control flow or agent coordination when justified, test actual "
    "offspring from the same task start, and let the inherited improver execute in the next generation. "
    "Keep task performance, measured meta utility and source execution as separate claims."
)


@pytest.mark.parametrize("question", [PILOT_QUESTION, "Long registered research question. " * 375],
                         ids=["registered-459-characters", "registration-limit-12000-characters"])
def test_long_registered_question_reaches_research_and_actual_offspring_execution(question):
    question = question[:12000]
    assert 400 < len(question) <= 12000
    parent = make_bundle(seed_files({"task.py": "def solve(problem, tools):\n    return {'answer': 0}\n"}))
    calls, urls, events, experiments = [], [], [], []
    source = "def solve(problem, tools):\n    return {'answer': 1}\n"
    runner = ProgramRunner()

    class Gateway:
        def ask(self, **params):
            calls.append(deepcopy(params))
            if params["role"] == "main":
                return {"candidates": [{"files": {"task.py": source},
                    "rationale": "Fixture protocol check", "hypothesis": "The fixture returns one",
                    "code_evidence": [{"file": "task.py", "new_code": "return {'answer': 1}",
                                       "mechanism": "Fixture return value changes"}]}]}
            return {"observations": ["Fixture only; no real model or research result"]}

    def fetch(url):
        urls.append(url)
        return b'<feed xmlns="http://www.w3.org/2005/Atom"></feed>'

    def experiment(files, label):
        execution = runner.run(make_bundle(files), "solve_batch", {"problems": [{}]}, timeout=10)
        experiments.append(execution)
        assert execution["value"][0]["submission"] == {"answer": 1}
        return {"split": "development", "status": "ok", "score_available": True,
                "score": .1, "work_units": 0, "tasks": [{"status": "ok"}],
                "execution": execution["execution"]}

    broker = ImprovementBroker(Gateway(), parent_files=parent["files"], experiment=experiment,
        search=LiteratureSearch(fetch=fetch), event=lambda kind, content: events.append((kind, content)))
    context = {"question": question, "parent": parent,
               "domain": {"id": "domain-neutral-fixture", "description": "No scientific task assumptions"},
               "roles": json.loads(parent["files"]["roles.json"]),
               "capabilities": {"probe_improver": False}, "editable_components": ["task.py"],
               "budget": {"remaining_calls": 3, "remaining_completion_tokens": 10400}}
    result = runner.run(parent, "improve", context, handler=broker.handle, timeout=20)

    assert result["execution"]["pid"] != os.getpid()
    assert result["execution"]["source_digest"] == parent["digest"]
    assert len(urls) == 1 and urls[0].startswith("https://export.arxiv.org/api/query?")
    query = result["value"]["research"]["literature"]["retrieved"]["query"]
    assert query == " ".join(question.split())[:400].strip()
    assert 0 < len(query) <= 400
    assert len(calls) == 3 and sum(call["max_tokens"] for call in calls) == 10400
    assert all(call["payload"]["question"] == question for call in calls)
    assert context["question"] == question
    assert len(experiments) == 1
    assert experiments[0]["execution"]["pid"] != result["execution"]["pid"]
    assert result["value"]["candidates"][0]["files"] == {"task.py": source}
    provenance = result["value"]["research"]["literature_query"]
    assert provenance["source"] == "question" and provenance["truncated"] is True
    assert provenance["input_characters"] == len(question)
    assert any(kind == "agent_log" and content["claimed_kind"] == "literature_query"
               and content["content"] == provenance for kind, content in events)


@pytest.mark.parametrize("argument,expected,origin,truncated", [
    ({"literature_query": "a" * 400}, "a" * 400, "literature_query", False),
    ({"literature_query": "界" * 401}, "界" * 400, "literature_query", True),
    ({"literature_query": "  explicit \n search \t", "question": PILOT_QUESTION},
     "explicit search", "literature_query", False),
    ({"domain": {"literature_query": "domain query"}, "question": PILOT_QUESTION},
     "domain query", "domain.literature_query", False),
    ({"literature_query": ["invalid", "type"], "domain": {"literature_query": "x" * 401}},
     "x" * 400, "domain.literature_query", True),
    ({"literature_query": "\t \n", "domain": {"literature_query": 10}, "question": "valid question"},
     "valid question", "question", False),
    ({"literature_query": " ", "question": "\n"},
     "source code recursive self improvement agents", "default", False),
], ids=["exact-limit", "unicode-over-limit", "explicit-query-normalization", "domain-override",
        "invalid-override-type", "blank-and-invalid-fallback", "nonempty-default"])
def test_search_input_precedence_and_bound_in_actual_source_process(argument, expected, origin, truncated):
    files = seed_files({"task.py": "def solve(problem, tools):\n    return {}\n"})
    files["meta.py"] = (
        "def improve(context, broker):\n"
        "    query = prepare_literature_query(context, context.get('domain', {}))\n"
        "    return {'candidates': [], 'research': {'request': query, 'result': broker.search(query['query'])}}\n"
    )
    queries = []
    search = LiteratureSearch(fetch=lambda url: b'<feed xmlns="http://www.w3.org/2005/Atom"></feed>')

    def handle(method, params):
        assert method == "search", "Query preparation must not make model calls"
        queries.append(params["query"])
        return search(params["query"])

    before = deepcopy(argument)
    result = ProgramRunner().run(make_bundle(files), "improve", argument, handler=handle, timeout=10)
    request = result["value"]["research"]["request"]
    assert queries == [expected]
    assert request["source"] == origin and request["truncated"] is truncated
    assert request["limit_characters"] == 400
    assert result["value"]["research"]["result"]["query"] == expected
    assert result["execution"]["pid"] != os.getpid()
    assert argument == before
