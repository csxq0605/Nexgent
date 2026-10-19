"""
Code Review Skill - Stage 5 deliverable
A reusable skill that reviews code for bugs, security, style, and performance.
Uses Xiaomi MiMo API (OpenAI-compatible format).
"""

import os, sys, json, re
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))
from config import MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL
from openai import OpenAI

REVIEW_SYSTEM_PROMPT = """You are MiMo, a senior code reviewer. Analyze the provided code and produce a structured review.

Output a JSON object with:
{
  "issues": [
    {
      "severity": "critical|warning|info",
      "file": "filename",
      "line": line_number,
      "category": "bug|security|style|performance|test",
      "title": "Short issue title",
      "description": "Why this is a problem",
      "suggestion": "How to fix it with code example"
    }
  ],
  "summary": {
    "files_reviewed": N,
    "critical": N,
    "warning": N,
    "info": N,
    "overall_quality": "good|fair|needs_work"
  }
}

Focus on: CRITICAL (bugs, security), WARNING (performance, code smells), INFO (style, naming)."""


def get_client():
    return OpenAI(api_key=MIMO_API_KEY, base_url=MIMO_BASE_URL)


def extract_json(text: str) -> dict:
    """Robustly extract JSON from LLM output."""
    match = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', text, re.DOTALL | re.IGNORECASE)
    if match:
        try:
            return json.loads(match.group(1).strip())
        except json.JSONDecodeError:
            pass
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        pass
    start = text.find('{')
    end = text.rfind('}')
    if start != -1 and end != -1 and end > start:
        snippet = text[start:end + 1]
        try:
            return json.loads(snippet)
        except json.JSONDecodeError:
            pass
        # Fallback: try to fix unescaped quotes inside string values
        fixed = _try_fix_json_quotes(snippet)
        if fixed is not None:
            try:
                return json.loads(fixed)
            except json.JSONDecodeError:
                pass
    return {"raw_text": text, "parse_error": "Failed to parse JSON"}


def _try_fix_json_quotes(text: str) -> str | None:
    """Try to fix unescaped double quotes inside JSON string values."""
    result = []
    in_string = False
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == '\\' and in_string:
            result.append(ch)
            if i + 1 < len(text):
                result.append(text[i + 1])
                i += 2
                continue
        if ch == '"':
            if not in_string:
                in_string = True
                result.append(ch)
            else:
                rest = text[i + 1:].lstrip()
                if rest and rest[0] in (',', '}', ']', ':'):
                    in_string = False
                    result.append(ch)
                elif not rest:
                    in_string = False
                    result.append(ch)
                else:
                    result.append('\\"')
            i += 1
            continue
        result.append(ch)
        i += 1
    fixed = ''.join(result)
    if fixed == text:
        return None
    return fixed


def review_code(code: str, filename: str = "unknown", focus: str = "all") -> dict:
    client = get_client()
    focus_instruction = ""
    if focus != "all":
        focus_instruction = f"\nFocus specifically on: {focus} issues."

    prompt = f"Review this code file ({filename}):{focus_instruction}\n\n```\n{code}\n```"

    response = client.chat.completions.create(
        model=MIMO_MODEL,
        messages=[
            {"role": "system", "content": REVIEW_SYSTEM_PROMPT},
            {"role": "user", "content": prompt}
        ],
        max_completion_tokens=16384,
        temperature=0.3,
        top_p=0.9
    )

    text = response.choices[0].message.content or ""
    return extract_json(text)


def format_report(result: dict) -> str:
    if "parse_error" in result:
        return f"# Code Review\n\n{result.get('raw_text', '(no output)')}"
    summary = result.get("summary", {})
    issues = result.get("issues", [])
    lines = [
        "# Code Review Report",
        "",
        "## Summary",
        f"- Files reviewed: {summary.get('files_reviewed', 'N/A')}",
        f"- Issues found: {len(issues)} (Critical: {summary.get('critical', 0)}, Warning: {summary.get('warning', 0)}, Info: {summary.get('info', 0)})",
        f"- Overall quality: {summary.get('overall_quality', 'N/A')}",
        "",
        "## Issues",
        ""
    ]
    for issue in issues:
        severity = issue.get("severity", "info").upper()
        lines.append(f"### [{severity}] `{issue.get('file', '?')}:{issue.get('line', '?')}` — {issue.get('title', 'Untitled')}")
        lines.append(f"{issue.get('description', '')}")
        lines.append(f"**Suggestion:** {issue.get('suggestion', '')}")
        lines.append("")
    return "\n".join(lines)


def smoke_test() -> bool:
    test_code = '''
def get_user(user_id):
    query = "SELECT * FROM users WHERE id = " + user_id
    password = "admin123"
    return db.execute(query)
'''
    print("[Smoke Test] Reviewing test code...")
    try:
        result = review_code(test_code, "test.py")
    except Exception as e:
        print(f"[FAIL] API call failed: {e}")
        return False

    if "parse_error" in result:
        print("[FAIL] Output parsing failed")
        print(f"  Raw output: {result.get('raw_text', '')[:200]}")
        return False

    issues = result.get("issues", [])
    if not issues:
        print("[FAIL] No issues found in obviously problematic code")
        return False

    has_security = any("sql" in i.get("title", "").lower() or "injection" in i.get("description", "").lower() for i in issues)
    has_credential = any("password" in i.get("title", "").lower() or "credential" in i.get("description", "").lower() or "hardcod" in i.get("description", "").lower() for i in issues)

    if has_security:
        print("[PASS] SQL injection detected")
    else:
        print("[WARN] SQL injection not detected")

    if has_credential:
        print("[PASS] Hardcoded credential detected")
    else:
        print("[WARN] Hardcoded credential not detected")

    print(f"[PASS] Found {len(issues)} issues")
    return True


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--smoke-test":
        success = smoke_test()
        sys.exit(0 if success else 1)

    if len(sys.argv) < 2:
        print("Usage: python review.py <file> [--focus security|bug|style|performance]")
        print("       python review.py --smoke-test")
        sys.exit(1)

    filepath = sys.argv[1]
    focus = "all"
    if "--focus" in sys.argv:
        idx = sys.argv.index("--focus")
        if idx + 1 < len(sys.argv):
            focus = sys.argv[idx + 1]

    if not os.path.exists(filepath):
        print(f"Error: File not found: {filepath}")
        sys.exit(1)

    with open(filepath, "r", encoding="utf-8") as f:
        code = f.read()

    print(f"Reviewing: {filepath} (focus: {focus})")
    result = review_code(code, os.path.basename(filepath), focus)
    print(format_report(result))
