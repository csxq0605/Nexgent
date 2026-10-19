"""Run tests with fast/slow separation.

Usage:
  python run_tests.py              # Fast tests only (default, ~2 min)
  python run_tests.py --all        # Fast + slow tests (~10 min)
  python run_tests.py --slow       # Slow tests only
  python run_tests.py --no-e2e     # Skip all E2E (real API) tests
"""
import subprocess
import sys
import argparse


def run(cmd, label):
    print(f"\n{'=' * 60}")
    print(f"  {label}")
    print(f"{'=' * 60}\n")
    r = subprocess.run(cmd, cwd=".")
    return r.returncode


def main():
    parser = argparse.ArgumentParser(description="Run nexgent tests")
    parser.add_argument("--all", action="store_true", help="Run fast + slow tests")
    parser.add_argument("--slow", action="store_true", help="Run slow tests only")
    parser.add_argument("--no-e2e", action="store_true", help="Skip E2E (real API) tests")
    args = parser.parse_args()

    base = [sys.executable, "-m", "pytest", "tests/", "-v"]
    exit_code = 0

    if args.no_e2e:
        # Unit + integration only, no real API
        code = run(base + ["--ignore=tests/test_e2e.py"],
                   "Unit + Integration tests (no API)")
        sys.exit(code)

    if args.slow:
        # Slow only
        code = run(base + ["-m", "slow", "--run-slow"], "Slow E2E tests (real API)")
        sys.exit(code)

    if args.all:
        # Fast + slow
        code = run(base + ["--run-slow"], "All tests (fast + slow)")
        sys.exit(code)

    # Default: fast only (slow tests auto-skipped by conftest.py)
    code = run(base, "Fast tests (slow tests skipped)")
    sys.exit(code)


if __name__ == "__main__":
    main()
