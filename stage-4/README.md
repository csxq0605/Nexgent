# Stage 4: Multi-Agent Writer

## Deliverable
A multi-agent pipeline: Research -> Write -> Review -> Revise

## Architecture

```
User Topic
    |
    v
[Supervisor] ──────────────────────────┐
    |                                   |
    v                                   |
[Researcher] ──> key findings           |
    |                                   |
    v                                   |
[Writer] ──> article draft              |
    |                                   |
    v                                   |
[Reviewer] ──> score + feedback         |
    |                                   |
    v                                   |
  score >= 7? ──YES──> [Done]           |
    |                                   |
    NO                                  |
    |                                   |
    v                                   |
[Reviser] ──> improved article          |
    |                                   |
    v                                   |
  (loop back to Reviewer, max 2x) ─────┘
```

## Key Concepts

### Role Separation
Each agent has:
- A specialized system prompt defining its expertise
- A defined input schema (what it receives)
- A defined output schema (what it produces)

### Supervisor Pattern
The supervisor:
- Delegates tasks to specialized agents
- Aggregates results between steps
- Controls the review-revise loop
- Enforces stop conditions (max revisions, approval threshold)

### Stop Conditions
- `score >= 7`: article is good enough
- `verdict == "approve"`: reviewer explicitly approves
- `revision_count >= max_revisions`: prevent infinite loops

### Structured I/O
All agents communicate via JSON objects, enabling:
- Programmatic aggregation
- Quality gates (score thresholds)
- Traceable data flow

## How to Run
```bash
# Use MiMo model via OpenAI-compatible API
# Configure MIMO_BASE_URL, MIMO_API_KEY, MIMO_MODEL in .env
pip install openai python-dotenv
python multi_agent_writer.py
```

## References
- [Claude Code Sub-agents](https://code.claude.com/docs/en/sub-agents)
- [Google ADK](https://google.github.io/adk-docs/)
- [Agent2Agent Protocol](https://google-a2a.github.io/A2A/specification/)
