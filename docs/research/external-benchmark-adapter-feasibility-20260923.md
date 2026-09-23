# External benchmark adapter feasibility · 2026-09-23

Status: source review and implementation decision, not a benchmark run. The
repository contains no research `SKILL.md`; this note follows a research
workflow of question → primary sources → adapter constraints → falsifiable
acceptance checks. It does not upgrade any Nexgent result.

## Question and selection rule

Can the same versioned Nexgent TaskService and RSI study protocol run a
tool-policy task, executable code task, and stateful interactive task without
adding domain rules to the core? Each adapter must independently supply public
task material, private evaluator, stable statistical-unit and source-cluster
identities, a pinned runtime fingerprint, explicit capabilities, and a way to
account for external work. A publicly released benchmark is useful for
development qualification but is not automatically a private final holdout.

## Source review

| Family | Primary source and current behavior | Integration judgment |
| --- | --- | --- |
| Tool / policy | The [current τ-bench repository](https://github.com/sierra-research/tau2-bench) describes text-mode airline, retail, telecom and mock domains, with policies, tools, tasks and a simulated user. It now requires Python 3.12–3.13 and `uv`; a 2026 grading update changed some banking results. The [older τ-bench repository](https://github.com/sierra-research/tau-bench) explicitly says its retail/airline tasks are outdated. | First external adapter candidate. Pin a tagged source revision and one text domain. Treat the user simulator model, domain database and policy as part of the frozen evaluator/environment, and meter both agent and simulator calls. Start on public development tasks; do not label the public base split private final holdout. |
| Executable code | [LiveCodeBench](https://github.com/LiveCodeBench/LiveCodeBench) publishes time-indexed contest problems and separate code-generation, execution and output-prediction data. Its [ICLR 2025 paper](https://openreview.net/forum?id=chfJJYC3iL) frames continuous collection as a contamination defense. | A dated code-generation slice can test executable artifact delivery. Pin dataset release and problem publication cutoff; run untrusted submissions in a resource-capped isolated process/container with host-owned hidden tests. A public published slice supports qualification, not a fresh secret holdout by itself. |
| Stateful interaction | [OSWorld](https://github.com/xlang-ai/OSWorld) supplies real desktop/web tasks and execution-based evaluation; the [NeurIPS 2024 paper](https://arxiv.org/abs/2404.07972) establishes its interactive setting. The current official setup uses a VM provider or Docker/KVM and may require external account configuration for some tasks. | Stronger long-horizon transfer test, but not the first local adapter: VM images, UI actions and setup make runtime, recovery and work accounting substantially heavier. A private self-hosted WebArena variant remains another option in the existing P5 plan. |

The τ-bench and OSWorld facts above are from their official repositories; the
choice to sequence τ-bench before OSWorld is a Nexgent engineering inference,
not a claim made by those benchmarks.

## Adapter implementation order and gates

1. **τ-bench text qualification adapter:** use the existing
   `nexgent.task_benchmarks` interface. Map one benchmark task to one frozen
   Episode, route simulator turns and policy tools through authorized
   capabilities, keep target database state and grader private, and assign
   `cluster_id` from a documented scenario/template lineage rather than task
   seed. The task-agent package remains generic; domain API schemas live only
   in the plugin. Acceptance: real model tool calls, terminal host evaluation,
   stable task identity across F/S/M/E, interruption accounting, and a
   no-model reference failure/success fixture. Public data stays development.
2. **LiveCodeBench dated qualification adapter:** pin a release and cutoff;
   write generated code to a sandboxed artifact, execute official tests only
   in the host evaluator, record container/runtime digest and charged CPU/time.
   Acceptance: identical code is graded identically across retries, hidden
   tests never enter agent prompts or memory, and timeout/protocol/infra cases
   map to distinct outcome classes.
3. **Interactive environment adapter:** only after TaskService has an explicit
   observation/action capability and durable action receipt for VM or website
   state. Acceptance: resume never repeats an uncertain action; evaluator and
   environment snapshots are pinned; account-dependent tasks are excluded or
   fully configured before preregistration.

Before any E2 claim, freeze fresh private sources, family and cluster
definitions, model/provider revision, package and M release, tool/simulator
costs, holdout schedule and missingness policy. Run deterministic adapter
contracts, then public model qualification, then one preregistered four-arm
holdout. A published leaderboard score cannot replace that sequence.
