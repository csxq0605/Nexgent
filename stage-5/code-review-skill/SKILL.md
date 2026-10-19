# Code Review Skill

## Name
`code-review`

## Description
Automated code review that checks for bugs, security issues, style violations, and suggests improvements. Produces a structured review report with severity ratings.

## When To Use
- After writing or modifying code, before committing
- When reviewing pull requests
- When onboarding to a new codebase and wanting to understand code quality
- As a pre-commit hook to catch issues early

## Prerequisites
- Access to the code files to review
- (Optional) Project-specific style guide or linting config

## Steps

### 1. Gather Context
- Read the files to be reviewed
- Identify the language and framework
- Check for existing linting/style configs (`.eslintrc`, `pyproject.toml`, etc.)

### 2. Analyze Code
For each file, check:
- **Bugs**: Logic errors, off-by-one, null references, race conditions
- **Security**: SQL injection, XSS, hardcoded secrets, insecure defaults
- **Style**: Naming conventions, code organization, dead code
- **Performance**: Unnecessary allocations, N+1 queries, missing caching
- **Tests**: Missing test coverage, untested edge cases

### 3. Generate Report
Output a structured review:

```markdown
## Code Review Report

### Summary
- Files reviewed: N
- Issues found: N (Critical: X, Warning: Y, Info: Z)

### Issues

#### [CRITICAL] `filename:line` — Issue Title
Description of the issue and why it matters.
**Suggestion:** How to fix it.

#### [WARNING] `filename:line` — Issue Title
Description.
**Suggestion:** How to fix.

#### [INFO] `filename:line` — Issue Title
Description.
```

### 4. Provide Actionable Suggestions
For each issue:
- Explain WHY it's a problem (not just WHAT)
- Provide a concrete code fix or improvement
- Prioritize: critical bugs > security > performance > style

## Acceptance Criteria
- [ ] All critical bugs are identified and explained
- [ ] Security issues are flagged with severity
- [ ] Suggestions include concrete code fixes
- [ ] Report is structured and scannable
- [ ] False positive rate < 20%

## Scripts

### `review.py`
Entry point that runs the review pipeline.

### `templates/report.md`
Template for the review report format.

## Example Usage

```bash
# Review a single file
python review.py --file src/auth.py

# Review a directory
python review.py --dir src/ --extensions .py,.ts

# Review with specific focus
python review.py --file src/api.py --focus security
```

## Limitations
- Does not replace human code review for architectural decisions
- May produce false positives on complex patterns
- Requires clear code to analyze (minified/obfuscated code not supported)
- Does not run the code (static analysis only)
