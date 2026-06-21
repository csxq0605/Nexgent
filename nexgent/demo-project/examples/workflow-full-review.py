"""Full review and fix workflow for the demo-project.

Usage:
    nexgent> /workflow run examples/workflow-full-review.py

Demonstrates: multi-phase orchestration, pipeline pattern,
parallel agents, budget control.
"""

export const meta = {
    name: 'full-review',
    description: 'Full code review, bug fix, and verification workflow',
    phases: [
        { title: 'Scan', detail: 'Find all issues across the codebase' },
        { title: 'Fix', detail: 'Fix the most critical bugs' },
        { title: 'Verify', detail: 'Run tests and confirm fixes' },
    ],
}

# Phase 1: Scan — parallel review of all source files
src_files = [
    'src/auth/service.py',
    'src/auth/routes.py',
    'src/auth/admin.py',
    'src/auth/rate_limit.py',
    'src/auth/audit.py',
    'src/auth/roles.py',
    'src/utils/security.py',
]

findings = await parallel(
    [lambda f=f: agent(
        f"Review {f} for bugs, security issues, and code quality. "
        f"Return a list of findings with severity (critical/high/medium/low), "
        f"line number, and description.",
        { phase: 'Scan', label: f'review:{f}' }
    ) for f in src_files]
)

# Flatten and count
all_findings = [f for batch in findings if batch for f in (batch if isinstance(batch, list) else [batch])]
ctx.log(f"Found {len(all_findings)} findings across {len(src_files)} files")

# Phase 2: Fix — implement the TODO stubs
features = ['password_reset', 'email_verify']
fix_results = await pipeline(
    features,
    lambda feat: agent(
        f"Read src/auth/{feat}.py and implement the TODO stubs. "
        f"Follow the docstring instructions and project conventions. "
        f"Run tests after implementation.",
        { phase: 'Fix', label: f'implement:{feat}' }
    )
)

ctx.log(f"Implemented {len([r for r in fix_results if r])} features")

# Phase 3: Verify — run full test suite
verify = await agent(
    "Run the full test suite: python -m pytest tests/ -v --tb=short\n"
    "Report total, passed, failed, skipped. If any fail, identify root cause.",
    { phase: 'Verify', label: 'test-suite' }
)

return {
    'findings_count': len(all_findings),
    'features_implemented': len([r for r in fix_results if r]),
    'verification': verify,
}
