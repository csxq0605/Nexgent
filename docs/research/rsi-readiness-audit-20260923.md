# Nexgent RSI readiness and decision gates · 2026-09-23

This is an evidence ledger for the **framework**, not a claim that its demos
prove general RSI. The authoritative run evidence remains in immutable Episode,
candidate, trial, memory, and study records. This document records what each
mechanism has actually exercised and the next gate before spending an
independent benchmark split.

| Capability | Current observation | Claim ceiling |
| --- | --- | --- |
| Multi-agent execution | A fixed graph made two MiMo proposer calls and one adjudicator call, then used a skill and host evaluator. One public development case scored 0 while an equal-call serial solver scored 1. | Real model-driven execution; no multi-agent benefit estimate. |
| O/S generation | MiMo v2.6-flash produced two valid S candidates and one genuine O graph candidate. The O candidate added a verify role and two calls; development scored candidate 2/2 vs parent 1/2, but selection contained one received invalid-JSON candidate response, higher work, and failed gates. It was not promoted. | Real O generation and development activation, not demonstrated selection improvement, deployment, or RSI benefit. |
| Pure M | MemoryService can admit, select, promote, snapshot, and consume a separate M release in deterministic tests. A real MiMo v2.6-flash pilot made three development-role calls and one R0 call; R0 explicitly abstained, so no candidate or later reuse was produced. | Engineering contract plus a negative real generation result; no M benefit or deployment evidence. |
| Recursive R | R0/R1 cycle, downstream comparison, guard, and rollback exist with deterministic fixtures. | Engineering contract only; no real recursive benefit. |
| Four-arm benchmark | A noncausal F/S/M/E qualification harness shares task inputs, evaluator identity, and per-Episode hard caps; the formal study service still supports exactly two arms and starts with empty memory. | Execution comparability check only; no formal four-arm causal estimate. |
| Product UI | Main runs ordinary Episodes and exposes evidence; RSI views are primarily read-only. | Product shell, not yet an operational RSI Lab. |

## Constraints introduced by our own design

1. The fixed multi-role graph has two independent proposers and one
   adjudicator. The three-call single-role control is sequential and can revise
   its earlier drafts. Equal call count does not equal equal correction
   opportunity. Compare both as distinct architectures, and report actual
   tokens, failures, and task distribution.
2. R0 initially had one model call, a full child-manifest output contract, and
   a 6,000 completion-token ceiling. The first attempt exhausted that ceiling;
   compact registry proposals then generated a legal candidate with 830
   completion tokens. Legality did not predict quality. Model-facing contracts,
   prompt size, abstention, structural repair, and candidate multiplicity are
   design variables to measure, not reasons to dismiss a failure.
3. Selection was spent before checking candidate artifact publication on fresh
   development tasks. A later [development preflight](../../experiments/orchestration_qualification/RESULTS.md)
   found contract failures in both candidate tasks and one parent task. The
   changed publishing branch was not shown to execute; the model-to-artifact
   boundary is brittle in the fixed graph too.
4. `charged_completion_tokens` is a conservative reservation/accounting value,
   whereas provider-reported completion and prompt tokens are observed usage.
   Equal charged ceilings can hide different actual output lengths. The new
   shared P3/P5 cost projection freezes node weight and reports both charged
   and observed-token work; historical P3 trials retain their former weight.
   Reports must still show both raw and charged counters.
5. A public two-family BBH slice and historical scientific confirmation data
   cannot establish cross-task generalization. No fresh host-private external
   final holdout has been executed.
6. The first real O candidate needed five role calls, while the runner still
   froze a three-call Episode cap. That [partial attempt](../../experiments/orchestration_qualification/receipts/o-search-attempt1-budget-incident.json)
   spent development work without a trial. The new runner estimates reachable
   workflow call/token bounds before pairing and gives both arms the same cap.
   A candidate with more calls may still fail the unchanged cost gate.
7. A received invalid-JSON model reply was initially classified as
   infrastructure missing in an O selection Episode. The runtime now records
   direct workflow capability aborts as terminal and treats invalid provider
   output as an observed agent failure; transport errors remain infrastructure.
   The earlier sealed selection decision is preserved, not recomputed.

## Required gates, in dependency order

| Gate | Must become observable before continuing | Current state |
| --- | --- | --- |
| G0 Evidence consistency | README, PR, plan, and receipts agree; failed and missing runs remain visible; actual and charged usage are separate. | Receipts and local docs updated; PR update pending this stage. |
| G1 Candidate validity | Generic schema/hand-off preflight, bounded repair, several archived candidates, and component activation evidence on fresh development units. Failed candidates do not consume independent selection. | Preflight now exists; repair and multi-candidate search remain. |
| G2 O/S activation | A real generated O change, with role/workflow edges actually exercised, passes development checks and a new paired selection without protocol regression. | Partly met: O candidate was generated and activated on fresh development tasks; selection failed completeness, cost, and other gates. |
| G3 M activation | Default R0 generates an M proposal; frozen M release is consumed on later independent tasks against the same package with empty memory. | Deterministic route exists; first real-model R0 attempt abstained before selection. |
| G4 Four-arm protocol | One preregistered F/S/M/E schedule binds the same source clusters, model, hard budget, evaluator, memory namespaces, outer evolution cost, missingness rule, and multiple-comparison policy. | Qualification harness only; formal service remains two-arm. |
| G5 Recursive benefit | From common A0, real R0 and R1 produce descendants under equal resources; downstream utility, guard, and rollback are measured on unseen tasks. | Deterministic R cycle only. |
| G6 Product and external study | Main/RSI Lab can operate and explain the cycle; fresh external task families and private holdout support a statistical report with negative results preserved. | Not met. |

At each gate, stop spending the next independent split if the preceding
mechanism has not run or if its provenance cannot be reconstructed. A failed
gate is a result to diagnose and archive, not a reason to weaken validation.

The [confirmatory four-arm protocol](four-arm-confirmatory-protocol-v1.md)
specifies the next implementation boundary. Its four treatments can test the
full system, fixed multi-agent architecture, and memory-only effect; separating
O/S-by-M interaction would require an additional preregistered arm.
