"""Run all tests in two phases to avoid API rate-limit flakiness.

Phase 1: Non-E2E tests (unit + integration, some use real API)
Phase 2: E2E tests (all use real API)

Usage: python run_tests.py
"""
import subprocess
import sys

def main():
    print("=" * 60)
    print("Phase 1: Non-E2E tests")
    print("=" * 60)
    r1 = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/", "-v", "--ignore=tests/test_e2e.py"],
        cwd=".",
    )

    print("\n" + "=" * 60)
    print("Phase 2: E2E tests")
    print("=" * 60)
    r2 = subprocess.run(
        [sys.executable, "-m", "pytest", "tests/test_e2e.py", "-v"],
        cwd=".",
    )

    print("\n" + "=" * 60)
    if r1.returncode == 0 and r2.returncode == 0:
        print("ALL TESTS PASSED")
    else:
        print(f"FAILURES: Phase 1={'PASS' if r1.returncode == 0 else 'FAIL'}, "
              f"Phase 2={'PASS' if r2.returncode == 0 else 'FAIL'}")
    print("=" * 60)
    sys.exit(max(r1.returncode, r2.returncode))

if __name__ == "__main__":
    main()
