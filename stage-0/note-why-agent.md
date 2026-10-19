# Stage 0: Why Agent, Not Workflow?

## Chatbot vs Workflow vs Agent vs Multi-Agent

| System | Who Controls the Flow | Example |
|--------|----------------------|---------|
| **Chatbot** | Pre-scripted rules or simple LLM calls | Customer FAQ bot |
| **Workflow** | Developer-written code orchestrates LLM calls in fixed paths | Prompt chaining: generate -> translate -> format |
| **Agent** | The LLM dynamically decides which tools to call and when to stop | Coding agent that reads files, edits code, runs tests |
| **Multi-Agent** | Multiple agents coordinate with defined roles | Research -> Write -> Review pipeline |

## The Agent Loop: observe -> think -> act -> observe

```
while not done:
    observation = perceive(environment + memory)
    thought = llm.think(observation)        # ReAct: reasoning trace
    action = llm.choose_action(thought)     # tool call or final answer
    result = execute(action)
    memory.store(thought, action, result)
    if action.is_final or max_steps_reached:
        done = true
```

This is the ReAct paradigm (Yao et al., 2022): interleaving **reasoning** (Thought) with **acting** (Action) and **observing** (Observation). The key insight: the LLM is not just generating text -- it is making decisions about what to do next.

## When NOT To Use an Agent

Agents add uncertainty, latency, and cost. Do NOT use an agent when:

- **The task is predictable**: fixed input/output mapping, no branching logic needed
- **A simple script suffices**: data transformation, format conversion, cron jobs
- **The workflow is stable**: no need for the LLM to decide which step comes next
- **Latency matters**: agent loops add 3-10x latency vs single LLM calls
- **Cost matters**: each agent step is an LLM call; loops multiply cost

> "Optimizing single LLM calls with retrieval and in-context examples is usually enough." -- Anthropic

**Rule of thumb**: Start with the simplest solution. Add agentic complexity only when measurably justified.

## Workflows vs Agents: When to Use Which

### Use Workflows when:
- Tasks decompose into fixed, predictable steps
- You need consistent, repeatable outputs
- Quality gates are well-defined (e.g., format validation)
- Examples: content generation pipelines, data processing, form filling

### Use Agents when:
- The number of steps can't be predicted in advance
- The task requires dynamic decision-making
- You need the LLM to judge which tool or approach to use
- Examples: debugging code, researching a topic, handling open-ended customer requests

### Proven Agent Domains (from Anthropic):
1. **Customer support**: conversation + tool access + measurable resolution
2. **Coding agents**: verifiable output via tests + structured problem space

## Key Takeaways

1. **An agent is an LLM in a loop with tools and memory** -- not a chatbot, not a workflow.
2. **The augmented LLM** (retrieval + tools + memory) is the building block; agents compose these into autonomous loops.
3. **Simple composable patterns beat complex frameworks** -- prompt chaining, routing, parallelization, orchestrator-workers, evaluator-optimizer.
4. **Agents trade latency/cost for flexibility** -- only worth it when the task genuinely requires dynamic judgment.
5. **Tool design matters as much as prompting** -- Anthropic found they spent more time optimizing tools for SWE-bench than on the overall prompt.

## References Read

- [x] Anthropic: Building Effective Agents -- https://www.anthropic.com/engineering/building-effective-agents
- [x] Lilian Weng: LLM Powered Autonomous Agents -- https://lilianweng.github.io/posts/2023-06-23-agent/
- [x] OpenAI: A Practical Guide to Building Agents (concept review)
