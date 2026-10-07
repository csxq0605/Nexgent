# @nexgent/test-support

Test helpers shared by the Nexgent packages: the scripted OpenAI-compatible model server, fault injection (timeouts, disconnects, process kill) and the common harness for cross-process acceptance scripts.

Step 0 ships only the `scriptedModelServer` factory signature; the implementation and the simulation spec belong to plan step 1 and the "测试策略" row of section 4.10 (`docs/research/pr4-review-and-plan-2026-10/README.md`).
