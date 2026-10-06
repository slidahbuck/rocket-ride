"""One-command reviewer walkthrough using real GitHub data and temporary storage."""

from contextlib import closing
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile

from .connector import import_issues, read_issues
from .errors import ConnectorError
from .github import PAGE_SIZE, normalize_repository

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPOSITORY = "python/cpython"

OFFLINE_READ = """
import json
import sys
from unittest.mock import patch
from rocketride import read_issues

with patch('rocketride.github.urlopen', side_effect=AssertionError('Read attempted a GitHub request')):
    result = read_issues(sys.argv[1], sys.argv[2])
print(json.dumps(result))
raise SystemExit(0 if result['ok'] else 1)
"""


class DemoFailure(Exception):
    """A reviewer check failed and should stop the walkthrough."""


def _run_tests() -> bool:
    process = subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", str(PROJECT_ROOT / "tests"), "-v"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=30,
    )
    if process.returncode:
        print(process.stdout + process.stderr)
        return False
    for line in process.stderr.splitlines():
        if line.startswith("Ran ") or line == "OK":
            print(f"  {line}")
    return True


def _read_in_new_process(repository: str, db_path: str) -> dict:
    process = subprocess.run(
        [sys.executable, "-c", OFFLINE_READ, repository, db_path],
        cwd=PROJECT_ROOT,
        capture_output=True,
        text=True,
        timeout=30,
    )
    try:
        result = json.loads(process.stdout)
    except ValueError as exc:
        detail = process.stderr.strip() or "The read process did not return JSON."
        raise DemoFailure(f"Local read in a new process failed: {detail}") from exc
    if process.returncode and result.get("ok"):
        raise DemoFailure("The read process returned a failing exit status.")
    return result


def _require_success(result: dict, step: str) -> None:
    if not result["ok"]:
        error = result["error"]
        raise DemoFailure(f"{step}: {error['code']}: {error['message']}")


def run_demo(repository: str = DEFAULT_REPOSITORY) -> int:
    """Run the assessment checks, explain each result, and leave no database behind."""
    print("RocketRide reviewer demo")
    print("Python standard library only. A live import requires internet access.")
    print("A temporary SQLite file is used; existing databases are untouched.\n")
    try:
        repository = normalize_repository(repository)
        print("[1/5] Automated tests")
        if not _run_tests():
            raise DemoFailure("Automated tests failed. See the test output above.")

        with tempfile.TemporaryDirectory(prefix="rocketride-demo-") as directory:
            db_path = str(Path(directory) / "issues.sqlite3")
            print(f"\n[2/5] Real GitHub import: {repository}")
            imported = import_issues(repository, db_path)
            _require_success(imported, "Import failed")
            print(f"  Processed {imported['count']} issues from one page of up to {PAGE_SIZE} entries.")
            print("  Pull requests are excluded. Count includes both new and existing issues.")
            if imported["issues"]:
                print("  Example saved issue:")
                print(json.dumps(imported["issues"][0], indent=2, ensure_ascii=False))
            else:
                print("  This page has no issues after filtering; an empty result is valid.")

            print("\n[3/5] Local read in a new Python process, with GitHub requests blocked")
            saved = _read_in_new_process(repository, db_path)
            _require_success(saved, "Local read failed")
            if saved != imported:
                raise DemoFailure("Local read did not match the imported records.")
            print(f"  PASS: read {saved['count']} saved issues without contacting GitHub.")
            print("  The database persists between processes.")

            print("\n[4/5] Repeated real import and duplicate check")
            repeated = import_issues(repository, db_path)
            _require_success(repeated, "Repeated import failed")
            saved_after = read_issues(repository, db_path)
            _require_success(saved_after, "Reading after repeated import failed")
            with closing(sqlite3.connect(db_path)) as connection:
                duplicates = connection.execute(
                    "SELECT repository, issue_number, COUNT(*) FROM issues "
                    "GROUP BY repository, issue_number HAVING COUNT(*) > 1"
                ).fetchall()
            if duplicates:
                raise DemoFailure(f"Duplicate issue keys were found: {duplicates}")
            print(f"  Processed {repeated['count']} issues; {saved_after['count']} total saved.")
            print("  PASS: duplicate groups = []")
            print("  The key is (repository, issue_number); upserts refresh title and URL.")

            print("\n[5/5] Expected invalid-input error")
            invalid = import_issues("bad-input", db_path)
            if invalid["ok"] or invalid["error"]["code"] != "invalid_repository":
                raise DemoFailure("Invalid repository input did not return the expected error.")
            print(json.dumps(invalid, indent=2))
            print("  PASS: this intentional error was handled before an API request.")

        print("\nAll reviewer checks passed. The temporary database has been removed.")
        print("Saved records are partial snapshots; missing issues are retained across imports.")
        print("\nTo keep your own data, run these commands from this folder:")
        print(f"  python3 -m rocketride import {repository} --db issues.sqlite3")
        print(f"  python3 -m rocketride read {repository} --db issues.sqlite3")
        print("\nDetails: README.md, Architecture.MD, and WALKTHROUGH.md")
        return 0
    except (DemoFailure, ConnectorError, sqlite3.Error, OSError, subprocess.SubprocessError) as exc:
        print(f"\nReviewer demo stopped: {exc}")
        print("For network failures, check your connection. For rate limits, retry later.")
        print("If the repository is unavailable, choose another public repository:")
        print("  python3 -m rocketride demo --repository owner/name")
        print("To run the automated checks without internet:")
        print("  python3 -m unittest discover -v")
        return 1
