"""
Research Assistant Agent - Stage 2 deliverable
A RAG-powered agent that searches, filters, summarizes, and cites sources.
Uses Xiaomi MiMo API (OpenAI-compatible format).
Covers: tool use, RAG pipeline, memory, error handling, citations.
"""

import os, sys, json, time, hashlib, subprocess, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL
from dataclasses import dataclass, field
from typing import Optional
from openai import OpenAI

# ============================================================
# Memory System: short-term (context), session, long-term (vector)
# ============================================================

@dataclass
class Memory:
    """Three-tier memory: short-term (in-context), session (conversation), long-term (persisted)."""
    session_history: list = field(default_factory=list)
    long_term_store: list = field(default_factory=list)

    def add_to_session(self, role: str, content):
        self.session_history.append({"role": role, "content": content})

    def store_long_term(self, text: str, source: str):
        entry_id = hashlib.md5(text.encode()).hexdigest()[:8]
        self.long_term_store.append({"id": entry_id, "text": text, "source": source})

    def search_long_term(self, query: str, top_k: int = 3) -> list:
        scored = []
        query_lower = query.lower()
        for entry in self.long_term_store:
            overlap = sum(1 for w in query_lower.split() if w in entry["text"].lower())
            scored.append((overlap, entry))
        scored.sort(key=lambda x: -x[0])
        return [e for _, e in scored[:top_k] if _ > 0]


def chunk_text(text: str, chunk_size: int = 500, overlap: int = 50) -> list:
    if chunk_size <= overlap:
        raise ValueError("chunk_size must be greater than overlap")
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        end = start + chunk_size
        chunks.append(text[start:end])
        start = end - overlap
    return chunks


def rag_retrieve(memory: Memory, query: str) -> list:
    return memory.search_long_term(query)


# ============================================================
# Tools (OpenAI function calling format)
# ============================================================

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for current information. NOTE: This is a demo placeholder - returns simulated results.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "Search query"}},
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read a local file's contents for analysis.",
            "parameters": {
                "type": "object",
                "properties": {"path": {"type": "string", "description": "File path"}},
                "required": ["path"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "save_to_memory",
            "description": "Save important information to long-term memory.",
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "Information to remember"},
                    "source": {"type": "string", "description": "Source URL or description"}
                },
                "required": ["text", "source"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "recall_memory",
            "description": "Search long-term memory for previously saved information.",
            "parameters": {
                "type": "object",
                "properties": {"query": {"type": "string", "description": "What to search for"}},
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "execute_code",
            "description": "Run Python code for data analysis or computation.",
            "parameters": {
                "type": "object",
                "properties": {"code": {"type": "string", "description": "Python code to execute"}},
                "required": ["code"]
            }
        }
    }
]


def execute_tool(name: str, params: dict, memory: Memory) -> str:
    try:
        if name == "web_search":
            results = [
                {"title": f"Result for '{params['query']}'", "url": f"https://example.com/search?q={params['query']}", "snippet": f"This is a relevant result about {params['query']}..."},
                {"title": f"Another take on '{params['query']}'", "url": f"https://example.org/{params['query']}", "snippet": f"Additional information about {params['query']}..."}
            ]
            return json.dumps({"results": results, "count": len(results)})
        elif name == "read_file":
            try:
                from pathlib import Path as _Path
                resolved = _Path(params["path"]).resolve()
                allowed = _Path.cwd().resolve()
                if not resolved.is_relative_to(allowed):
                    return json.dumps({"error": "Path outside allowed directory"})
                with open(params["path"], "r", encoding="utf-8") as f:
                    content = f.read()
                if not content.strip():
                    return json.dumps({"error": "File is empty", "content": ""})
                chunks = chunk_text(content)
                for i, chunk in enumerate(chunks[:5]):
                    memory.store_long_term(chunk, f"{params['path']}#chunk{i}")
                return json.dumps({"content": content[:3000], "chunks_stored": min(len(chunks), 5)})
            except FileNotFoundError:
                return json.dumps({"error": f"File not found: {params['path']}"})
        elif name == "save_to_memory":
            memory.store_long_term(params["text"], params["source"])
            return json.dumps({"status": "saved", "total_entries": len(memory.long_term_store)})
        elif name == "recall_memory":
            results = rag_retrieve(memory, params["query"])
            if not results:
                return json.dumps({"results": [], "message": "No matching memories found"})
            return json.dumps({"results": [r["text"][:200] for r in results], "sources": [r["source"] for r in results]})
        elif name == "execute_code":
            code = params["code"]
            # Security: block dangerous module imports
            _DANGEROUS_MODULES = {"os", "subprocess", "shutil", "socket", "http", "ftplib", "smtplib", "ctypes", "importlib", "sys"}
            import ast as _ast
            try:
                tree = _ast.parse(code)
                for node in _ast.walk(tree):
                    if isinstance(node, _ast.Import):
                        for alias in node.names:
                            if alias.name.split(".")[0] in _DANGEROUS_MODULES:
                                return json.dumps({"error": f"Blocked: importing '{alias.name}' is not allowed"})
                    elif isinstance(node, _ast.ImportFrom):
                        if node.module and node.module.split(".")[0] in _DANGEROUS_MODULES:
                            return json.dumps({"error": f"Blocked: importing from '{node.module}' is not allowed"})
            except SyntaxError:
                return json.dumps({"error": "Syntax error in code"})
            with tempfile.NamedTemporaryFile(mode="w", suffix=".py", delete=False, encoding="utf-8") as f:
                f.write(code)
                f.flush()
                tmp_path = f.name
            try:
                result = subprocess.run(
                    [sys.executable, tmp_path],
                    capture_output=True, text=True,
                    timeout=5, encoding="utf-8", errors="replace"
                )
                output = result.stdout[:2000] if result.stdout else ""
                stderr = result.stderr[:500] if result.stderr else ""
                if result.returncode != 0:
                    return json.dumps({"error": f"Exit code {result.returncode}", "stderr": stderr})
                if not output.strip():
                    return json.dumps({"output": "(no output)"})
                return json.dumps({"output": output})
            except subprocess.TimeoutExpired:
                return json.dumps({"error": "Code execution timed out (5s)"})
            finally:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
        return json.dumps({"error": f"Unknown tool: {name}"})
    except Exception as e:
        return json.dumps({"error": f"Tool '{name}' failed: {str(e)}"})


SYSTEM_PROMPT = """You are MiMo, a research assistant developed by Xiaomi. Your job is to help users research topics by:
1. Searching for information using web_search
2. Reading and analyzing local files with read_file
3. Saving important findings to memory with save_to_memory
4. Recalling prior research with recall_memory
5. Running computations with execute_code

RULES:
- Always cite your sources with URLs when available
- If a tool returns an error or empty result, acknowledge it and try an alternative
- Do not repeat the same tool call with identical parameters
- If you don't have enough information, say so honestly"""


def research_agent(
    user_message: str,
    memory: Optional[Memory] = None,
    max_steps: int = 15,
    timeout_seconds: int = 120
) -> str:
    if memory is None:
        memory = Memory()

    client = OpenAI(api_key=MIMO_API_KEY, base_url=MIMO_BASE_URL)
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_message}
    ]
    start_time = time.time()
    seen_tool_calls = set()

    for step in range(max_steps):
        if time.time() - start_time > timeout_seconds:
            return "[ERROR] Agent timed out."

        response = client.chat.completions.create(
            model=MIMO_MODEL,
            messages=messages,
            tools=TOOLS,
            tool_choice="auto",
            max_completion_tokens=2048,
            temperature=0.7,
            top_p=0.9
        )

        choice = response.choices[0]
        message = choice.message

        if not message.tool_calls:
            final = message.content or "[No response]"
            return final

        msg_dump = message.model_dump()
        if msg_dump.get("content") is None:
            msg_dump["content"] = ""
        messages.append(msg_dump)
        for tc in message.tool_calls:
            func_name = tc.function.name
            func_args = json.loads(tc.function.arguments)
            call_key = f"{func_name}:{json.dumps(func_args, sort_keys=True)}"
            if call_key in seen_tool_calls:
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps({"skipped": "Duplicate call"})})
                continue
            seen_tool_calls.add(call_key)
            print(f"  [Step {step+1}] {func_name}({json.dumps(func_args)})")
            result = execute_tool(func_name, func_args, memory)
            messages.append({"role": "tool", "tool_call_id": tc.id, "content": result})

    return "[ERROR] Max steps reached."


if __name__ == "__main__":
    print("=== Research Assistant Agent (MiMo) ===")
    print(f"API Key: ***configured***")
    print()

    mem = Memory()
    while True:
        user_input = input("You: ").strip()
        if user_input.lower() in ("quit", "exit", "q"):
            break
        if not user_input:
            continue
        print("\nResearching...\n")
        answer = research_agent(user_input, memory=mem)
        print(f"\n{'='*60}\nAgent:\n{answer}\n{'='*60}\n")
