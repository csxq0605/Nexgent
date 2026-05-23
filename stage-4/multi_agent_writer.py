"""
Multi-Agent Writer - Stage 4 deliverable
A pipeline: Research -> Write -> Review -> Revise
Uses Xiaomi MiMo API (OpenAI-compatible format).
"""

import sys, json, re
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL
from dataclasses import dataclass
from typing import Optional
from openai import OpenAI


def get_client():
    return OpenAI(api_key=MIMO_API_KEY, base_url=MIMO_BASE_URL)


def extract_json(text: str) -> dict:
    """Robustly extract JSON from LLM output (handles markdown blocks, leading text, etc.)."""
    # Try markdown code block first
    match = re.search(r'```(?:json)?\s*\n?(.*?)\n?```', text, re.DOTALL | re.IGNORECASE)
    if match:
        try:
            return json.loads(match.group(1).strip())
        except json.JSONDecodeError:
            pass
    # Try direct parse
    try:
        return json.loads(text.strip())
    except json.JSONDecodeError:
        pass
    # Try finding first { to last }
    start = text.find('{')
    end = text.rfind('}')
    if start != -1 and end != -1 and end > start:
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            pass
    return {"raw_text": text, "parse_error": "Failed to parse JSON"}


AGENTS = {
    "researcher": {
        "role": "Research Specialist",
        "system": "You are MiMo, acting as a research specialist. Gather comprehensive information on a topic. Output a JSON object with: key_findings (list of 3-5 facts), sources (list), gaps (list of areas needing more research). Be thorough but concise.",
    },
    "writer": {
        "role": "Content Writer",
        "system": "You are MiMo, acting as a content writer. You receive research findings and produce a well-structured article. Output a JSON object with: title, sections (list of {heading, content}), word_count. Write clearly, cite sources.",
    },
    "reviewer": {
        "role": "Quality Reviewer",
        "system": "You are MiMo, acting as a critical reviewer. Evaluate the article for quality, accuracy, completeness. Output a JSON object with: score (1-10), strengths (list), weaknesses (list), suggestions (list), verdict ('approve' if score>=7, else 'revise').",
    },
    "reviser": {
        "role": "Content Reviser",
        "system": "You are MiMo, acting as a reviser. You receive an article and review feedback, then produce an improved version. Output a JSON object with: title, sections, changes_made (list). Address all feedback.",
    }
}


def call_agent(role: str, user_prompt: str) -> dict:
    agent = AGENTS[role]
    print(f"  [{agent['role']}] Working...")
    client = get_client()

    response = client.chat.completions.create(
        model=MIMO_MODEL,
        messages=[
            {"role": "system", "content": agent["system"]},
            {"role": "user", "content": user_prompt}
        ],
        max_completion_tokens=2048,
        temperature=0.8,
        top_p=0.9
    )

    text = response.choices[0].message.content or ""
    return extract_json(text)


@dataclass
class PipelineState:
    topic: str
    research: Optional[dict] = None
    article: Optional[dict] = None
    review: Optional[dict] = None
    revision: Optional[dict] = None
    current_step: str = "init"
    revision_count: int = 0
    max_revisions: int = 2


def supervisor_run(topic: str, max_revisions: int = 2) -> dict:
    state = PipelineState(topic=topic, max_revisions=max_revisions)

    # Step 1: Research
    print("\n[Supervisor] Step 1: Researching topic...")
    state.research = call_agent("researcher", f"Research this topic thoroughly: {topic}")

    # Step 2: Write
    print("\n[Supervisor] Step 2: Writing article...")
    research_context = json.dumps(state.research, indent=2, ensure_ascii=False)
    state.article = call_agent("writer", f"Write an article based on this research:\n\n{research_context}")

    # Step 3-4: Review -> Revise loop
    while state.revision_count <= state.max_revisions:
        print(f"\n[Supervisor] Step 3: Reviewing (attempt {state.revision_count + 1})...")
        article_text = json.dumps(state.article, indent=2, ensure_ascii=False)
        state.review = call_agent("reviewer", f"Review this article:\n\n{article_text}")

        verdict = state.review.get("verdict", "revise")
        score = state.review.get("score", 0)
        print(f"  [Review] Score: {score}/10, Verdict: {verdict}")

        if verdict == "approve" or score >= 7:
            print("\n[Supervisor] Article approved!")
            break

        if state.revision_count >= state.max_revisions:
            print(f"\n[Supervisor] Max revisions ({state.max_revisions}) reached.")
            break

        print(f"\n[Supervisor] Step 4: Revising...")
        revision_prompt = f"Revise this article based on the review feedback.\n\nARTICLE:\n{article_text}\n\nREVIEW:\n{json.dumps(state.review, indent=2, ensure_ascii=False)}"
        state.article = call_agent("reviser", revision_prompt)
        state.revision_count += 1

    return {
        "topic": topic,
        "research": state.research,
        "article": state.article,
        "review": state.review,
        "revisions": state.revision_count,
        "final_verdict": state.review.get("verdict", "unknown") if state.review else "no_review"
    }


def format_article(result: dict) -> str:
    article = result.get("article", {})
    if "parse_error" in article or "raw_text" in article:
        return article.get("raw_text", "(no article)")
    title = article.get("title", "Untitled")
    sections = article.get("sections", [])
    lines = [f"# {title}\n"]
    for section in sections:
        heading = section.get("heading", "")
        content = section.get("content", "")
        lines.append(f"## {heading}\n{content}\n")
    return "\n".join(lines)


if __name__ == "__main__":
    print("=== Multi-Agent Writer (MiMo) ===")
    print(f"Model: {MIMO_MODEL}")
    print(f"API Key: ***configured***")
    print()

    topic = input("Enter a topic: ").strip()
    if not topic:
        topic = "The future of AI agents in software development"

    print(f"\nTopic: {topic}")
    print("=" * 60)

    result = supervisor_run(topic, max_revisions=2)

    print("\n" + "=" * 60)
    print("FINAL ARTICLE:")
    print("=" * 60)
    print(format_article(result))
    print(f"\nRevisions: {result['revisions']}")
    print(f"Verdict: {result['final_verdict']}")
