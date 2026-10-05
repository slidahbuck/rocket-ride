import io
import json
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

from rocketride import import_issues, read_issues
from rocketride.storage import save_issues


def issue(number=42, title="Fix login error"):
    return {"number": number, "title": title, "html_url": f"https://github.com/example/project/issues/{number}"}


class ConnectorTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.db = Path(self.directory.name) / "issues.sqlite3"

    def import_payload(self, payload, repository="example/project"):
        with patch("rocketride.github.urlopen", return_value=io.BytesIO(json.dumps(payload).encode())) as request:
            result = import_issues(repository, self.db)
        return result, request

    def test_real_storage_import_filters_pr_and_read_never_calls_api(self):
        pull = {**issue(99), "pull_request": {"url": "ignored"}}
        result, request = self.import_payload([issue(2), pull, issue(1)])
        self.assertTrue(result["ok"])
        self.assertEqual([item["issue_number"] for item in result["issues"]], [1, 2])
        api_request = request.call_args.args[0]
        self.assertEqual(api_request.full_url, "https://api.github.com/repos/example/project/issues?state=open&per_page=30&page=1")
        self.assertEqual(api_request.get_header("Accept"), "application/vnd.github+json")
        self.assertEqual(request.call_args.kwargs["timeout"], 15)
        request.assert_called_once()
        with patch("rocketride.github.urlopen", side_effect=AssertionError("Read must be offline")):
            self.assertEqual(read_issues("example/project", self.db), result)

    def test_repeat_import_updates_title_and_url_without_duplicates(self):
        self.import_payload([issue()])
        updated = {**issue(title="Updated title"), "html_url": "https://github.com/example/renamed/issues/42"}
        self.import_payload([updated])
        saved = read_issues("example/project", self.db)
        self.assertEqual(saved["count"], 1)
        self.assertEqual(saved["issues"][0]["title"], "Updated title")
        self.assertEqual(saved["issues"][0]["url"], updated["html_url"])

    def test_repository_names_are_normalized(self):
        self.import_payload([issue()], " Example/Project ")
        self.import_payload([issue(title="Updated")], "example/project")
        self.assertEqual(read_issues("EXAMPLE/PROJECT", self.db)["count"], 1)

    def test_same_number_in_two_repositories_is_independent(self):
        self.import_payload([issue()], "example/one")
        self.import_payload([issue(title="Other repo")], "example/two")
        self.assertEqual(read_issues("example/one", self.db)["issues"][0]["title"], "Fix login error")
        self.assertEqual(read_issues("example/two", self.db)["issues"][0]["title"], "Other repo")

    def test_absent_issue_is_retained_and_import_count_describes_batch(self):
        self.import_payload([issue(1), issue(2)])
        result, _ = self.import_payload([issue(2), issue(3)])
        self.assertEqual(result["count"], 2)
        self.assertEqual(read_issues("example/project", self.db)["count"], 3)

    def test_read_persists_in_new_process(self):
        self.import_payload([issue()])
        process = subprocess.run(
            [sys.executable, "-m", "rocketride", "read", "example/project", "--db", str(self.db)],
            cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True, check=True,
        )
        self.assertEqual(json.loads(process.stdout)["issues"][0]["issue_number"], 42)

    def test_empty_import_and_new_database_read_are_successful(self):
        self.assertEqual(read_issues("example/project", self.db)["issues"], [])
        result, _ = self.import_payload([])
        self.assertEqual(result, {"ok": True, "repository": "example/project", "count": 0, "issues": []})

    def test_invalid_repositories_fail_before_io(self):
        for repository in ("project", "a/b/c", "https://github.com/a/b", "a/..", "a/", "a/b?state=all", None):
            with self.subTest(repository=repository), patch("rocketride.github.urlopen") as request:
                result = import_issues(repository, self.db)
                self.assertEqual(result["error"]["code"], "invalid_repository")
                request.assert_not_called()
        self.assertFalse(self.db.exists())

    def test_invalid_database_paths_fail_before_network(self):
        for path in ("", ":memory:", "\x00", None):
            with self.subTest(path=path), patch("rocketride.github.urlopen") as request:
                self.assertEqual(import_issues("example/project", path)["error"]["code"], "invalid_database_path")
                request.assert_not_called()

    def test_http_failures_preserve_existing_records(self):
        self.import_payload([issue()])
        for status, headers, expected in (
            (404, {}, "repository_not_found"),
            (500, {}, "api_error"),
            (403, {}, "api_error"),
            (403, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "123"}, "rate_limited"),
            (403, {"Retry-After": "60"}, "rate_limited"),
            (429, {}, "rate_limited"),
        ):
            with self.subTest(status=status, headers=headers):
                error = HTTPError("https://api.github.com", status, "failed", headers, None)
                with patch("rocketride.github.urlopen", side_effect=error):
                    result = import_issues("example/project", self.db)
                self.assertEqual(result["error"]["code"], expected)
                self.assertEqual(read_issues("example/project", self.db)["count"], 1)

    def test_network_failure_and_timeout(self):
        for failure in (URLError("offline"), TimeoutError("timed out")):
            with self.subTest(failure=failure), patch("rocketride.github.urlopen", side_effect=failure):
                self.assertEqual(import_issues("example/project", self.db)["error"]["code"], "network_error")
        self.assertFalse(self.db.exists())

    def test_invalid_json_is_reported(self):
        with patch("rocketride.github.urlopen", return_value=io.BytesIO(b"not JSON")):
            self.assertEqual(import_issues("example/project", self.db)["error"]["code"], "invalid_response")

    def test_malformed_batch_does_not_write_valid_prefix(self):
        for payload in ({"message": "error"}, [issue(), {}], [issue(), None], [issue(number=True)], [issue(number=-1)]):
            with self.subTest(payload=payload):
                result, _ = self.import_payload(payload)
                self.assertEqual(result["error"]["code"], "invalid_response")
                self.assertFalse(self.db.exists())

    def test_storage_error_is_reported_for_import_and_read(self):
        with patch("rocketride.github.urlopen", return_value=io.BytesIO(b"[]")):
            imported = import_issues("example/project", self.directory.name)
        saved = read_issues("example/project", self.directory.name)
        self.assertEqual(imported["error"]["code"], "storage_error")
        self.assertEqual(saved["error"]["code"], "storage_error")

    def test_failed_storage_batch_rolls_back(self):
        self.import_payload([issue()])
        valid = {"repository": "example/project", "issue_number": 1, "title": "Valid", "url": "https://github.com/example/project/issues/1"}
        invalid = {**valid, "issue_number": 2, "title": None}
        with self.assertRaises(sqlite3.IntegrityError):
            save_issues(str(self.db), [valid, invalid])
        self.assertEqual(read_issues("example/project", self.db)["count"], 1)

    def test_cli_failure_is_json_and_has_nonzero_exit(self):
        process = subprocess.run(
            [sys.executable, "-m", "rocketride", "import", "bad-input", "--db", str(self.db)],
            cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True,
        )
        self.assertEqual(process.returncode, 1)
        self.assertEqual(json.loads(process.stdout)["error"]["code"], "invalid_repository")


if __name__ == "__main__":
    unittest.main()
