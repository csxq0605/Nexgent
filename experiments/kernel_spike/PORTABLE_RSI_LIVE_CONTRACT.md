# Portable task capability: bounded live probe

This is a mechanism probe, not a general RSI effectiveness study. The arithmetic task family exists only in `portable_capability_live.py`; Nexgent's runtime, package, evaluator, and promotion paths remain task-independent.

## Frozen run

- Provider/model: the authorized local MiMo configuration, `mimo-v2.6-flash`; one provider attempt per model call, with SDK retries disabled.
- Creator: operands 6 and 7. The task program asks the model once to author a reusable pure multiplication tool, then develops and calls it in the same Episode. No repair loop or prompt revision is allowed within this run.
- Selection: operands 123456789 and 987654321, unseen by the creator. Parent and candidate receive identical benchmark task, model/tool/node/work budgets, and the same independent exact-product evaluator. A quality delta of at least 0.5 and cost ratio at most 20 are required, along with actual candidate component activation.
- Guard: operands 98765431 and 123457. Candidate must score 1.0 or the existing monitor may roll it back.
- Fresh process: after promotion and guard, a new Python process opens the durable project and solves 1234567 × 8901234 through the active package channel. It must activate the adopted tool and return the exact answer.
- No post hoc substitutions: the model-generated source, tool name, recorded proposal, candidate package, benchmark operands, threshold, and budgets are not edited after execution starts. Failure at any stage ends the run; no repeated sampling to select a success.

The root capability-call and tool-work budgets are explicit for both arms. A model-authored tool that hardcodes 42 will fail the unseen operands. Even a fully successful run establishes one task-family inheritance mechanism, not transferable performance across families, autonomous gap detection, or recursive improver gains.

## v2 protocol amendment, fixed before its run

The v1 run stopped before Definition creation because the model returned the five proposal fields at the JSON top level while the experiment program expected a `proposal` wrapper. Commit `26f0a4f` preserves that source and failure. V2 accepts either the same top-level proposal or its `proposal` wrapper, then passes it unchanged through Nexgent's existing Definition validator. It changes no operands, model, prompt, budgets, evaluator, promotion threshold, or stopping rule. V2 is one separate attempt and will be reported separately regardless of outcome.
