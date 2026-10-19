"""Review, repair, and verify the planted-fault demo project.

Usage from ``nexgent/demo-project``::

    nexgent> /workflow run examples/workflow-full-review.py

This is a Provider-backed workspace orchestration demonstration.  It does not
replace the offline, independently verified Coding Harness recovery demo in
``../examples/harness_fault_recovery_demo.py``.
"""


META = {
    "name": "full-review",
    "description": "Review planted faults, apply a bounded repair, and rerun tests",
    "phases": ("Scan", "Prioritize", "Repair", "Verify"),
}


async def main(ctx, args):
    options = args or {}
    target = options.get("target", "src/")
    test_command = options.get("test_command", "python -m pytest tests/ -v --tb=short")

    ctx.phase("Scan")
    review_prompts = [
        (
            "correctness",
            f"Review {target} for concrete correctness defects. Cite file and line, "
            "state the failure mechanism, and propose a test that exposes it.",
        ),
        (
            "security",
            f"Review {target} for authentication, authorization, injection, secret, "
            "and race-condition risks. Separate confirmed findings from hypotheses.",
        ),
        (
            "tests",
            "Inspect the current tests and identify uncovered planted faults or tests "
            "that encode broken behavior as success.",
        ),
    ]
    reviews = await ctx.parallel([
        lambda label=label, prompt=prompt: ctx.agent(prompt, label=f"review:{label}")
        for label, prompt in review_prompts
    ])
    valid_reviews = [review for review in reviews if review]
    ctx.log(f"Collected {len(valid_reviews)}/{len(review_prompts)} review reports")

    ctx.phase("Prioritize")
    diagnosis = await ctx.agent(
        "Cross-check the following reports against the repository. Select at most "
        "two confirmed, high-impact defects. For each one provide evidence, the "
        "expected failing test, and a minimal repair boundary. Do not edit files.\n\n"
        + "\n\n---\n\n".join(valid_reviews),
        label="evidence-review",
        tools=["read_file", "grep_files", "glob_files", "run_command"],
    )

    ctx.phase("Repair")
    repair = await ctx.agent(
        "Implement only the confirmed defects in this evidence review. Preserve the "
        "project architecture and add or strengthen regression tests. Run the "
        f"targeted tests before returning.\n\n{diagnosis or 'No confirmed diagnosis.'}",
        label="bounded-repair",
    )

    ctx.phase("Verify")
    verification = await ctx.agent(
        f"Run exactly: {test_command}\n"
        "Do not change code. Report command, exit code, passed/failed/skipped counts, "
        "and any remaining failure evidence.",
        label="independent-verification",
        tools=["read_file", "run_command"],
    )

    return {
        "meta": META,
        "reviews": len(valid_reviews),
        "diagnosis": diagnosis,
        "repair": repair,
        "verification": verification,
        "verified_by_coding_harness": False,
    }
