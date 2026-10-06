"""Exercise the guided reviewer demo without live API requests."""

from contextlib import redirect_stdout
import io
from pathlib import Path
import unittest
from unittest.mock import patch

from rocketride.connector import import_issues as connector_import
from rocketride.demo import DemoFailure, OFFLINE_READ, _read_in_new_process, run_demo
from rocketride.storage import load_issues, save_issues
from rocketride.__main__ import main


API_FAILURE = {
    "ok": False,
    "error": {"code": "network_error", "message": "GitHub is unavailable."},
}


class DemoTests(unittest.TestCase):
    def fake_import(self, repository, db_path):
        """Keep actual SQLite writes, while providing a controlled API batch."""
        if repository == "bad-input":
            return connector_import(repository, db_path)
        path = Path(db_path)
        self.import_paths.append(path)
        issues = [{
            "repository": repository,
            "issue_number": 42,
            "title": "First title" if len(self.import_paths) == 1 else "Updated title",
            "url": f"https://github.com/{repository}/issues/42",
        }]
        save_issues(str(path), issues)
        self.saved_batches.append(load_issues(str(path), repository))
        return {"ok": True, "repository": repository, "count": 1, "issues": issues}

    def setUp(self):
        self.import_paths = []
        self.saved_batches = []
        self.output = io.StringIO()

    def run_without_network(self, import_behavior=None, **patches):
        from contextlib import ExitStack
        with ExitStack() as stack:
            stack.enter_context(redirect_stdout(self.output))
            stack.enter_context(patch("rocketride.demo._run_tests", return_value=True))
            stack.enter_context(patch("rocketride.github.urlopen", side_effect=AssertionError("No live API in tests")))
            importer = stack.enter_context(patch(
                "rocketride.demo.import_issues",
                side_effect=import_behavior or self.fake_import,
            ))
            for name, value in patches.items():
                stack.enter_context(patch(f"rocketride.demo.{name}", return_value=value))
            result = run_demo("example/project")
        return result, importer

    def assert_demo_database_removed(self):
        for path in self.import_paths:
            self.assertFalse(path.exists(), "Reviewer demo database must be temporary")
            self.assertFalse(path.parent.exists(), "Reviewer demo directory must be cleaned up")

    def test_demo_uses_real_storage_and_new_process_then_cleans_up(self):
        # The child helper is deliberately unmocked. It must read this file
        # successfully with GitHub access disabled in its own process.
        result, _ = self.run_without_network()
        self.assertEqual(result, 0)
        self.assertEqual(len(self.import_paths), 2)
        self.assertEqual(self.import_paths[0], self.import_paths[1])
        self.assertEqual(len(self.saved_batches[-1]), 1)
        self.assertEqual(self.saved_batches[-1][0]["title"], "Updated title")
        self.assertIn("PASS", self.output.getvalue())
        self.assert_demo_database_removed()

    def test_failed_unit_tests_stop_before_api_access(self):
        with redirect_stdout(self.output), patch("rocketride.demo._run_tests", return_value=False), patch("rocketride.demo.import_issues") as importer:
            result = run_demo("example/project")
        self.assertEqual(result, 1)
        importer.assert_not_called()

    def test_initial_api_failure_reports_failure(self):
        result, importer = self.run_without_network(lambda *_: API_FAILURE)
        self.assertEqual(result, 1)
        importer.assert_called_once()
        self.assertIn("GitHub is unavailable", self.output.getvalue())
        self.assertFalse(Path(importer.call_args.args[1]).parent.exists())

    def test_repeat_import_failure_reports_failure_and_cleans_up(self):
        def import_then_fail(repository, db_path):
            if self.import_paths:
                return API_FAILURE
            return self.fake_import(repository, db_path)

        result, importer = self.run_without_network(import_then_fail)
        self.assertEqual(result, 1)
        self.assertEqual(importer.call_count, 2)
        self.assertIn("GitHub is unavailable", self.output.getvalue())
        self.assert_demo_database_removed()

    def test_failed_child_read_reports_failure_and_cleans_up(self):
        child_failure = {
            "ok": False,
            "error": {"code": "storage_error", "message": "Child process could not read the database."},
        }
        result, importer = self.run_without_network(_read_in_new_process=child_failure)
        self.assertEqual(result, 1)
        self.assertEqual(importer.call_count, 1)
        self.assertIn("Child process could not read", self.output.getvalue())
        self.assert_demo_database_removed()

    def test_invalid_starting_repository_does_not_run_tests_or_import(self):
        with redirect_stdout(self.output), patch("rocketride.demo._run_tests") as tests, patch("rocketride.demo.import_issues") as importer:
            result = run_demo("bad-input")
        self.assertEqual(result, 1)
        tests.assert_not_called()
        importer.assert_not_called()

    def test_offline_child_detects_an_accidental_github_request(self):
        # Replace the child's read function with a regression that attempts
        # network access. The demo guard must block it before any real request.
        unsafe_read = """
import rocketride

def unsafe_read(*args):
    from rocketride.github import urlopen
    urlopen('https://api.github.com')

rocketride.read_issues = unsafe_read
"""
        with patch("rocketride.demo.OFFLINE_READ", unsafe_read + OFFLINE_READ):
            with self.assertRaisesRegex(DemoFailure, "Read attempted a GitHub request"):
                _read_in_new_process("example/project", "unused.sqlite3")

    def test_cli_passes_custom_repository_to_demo(self):
        with patch("sys.argv", ["rocketride", "demo", "--repository", "example/project"]):
            with patch("rocketride.__main__.run_demo", return_value=0) as demo:
                self.assertEqual(main(), 0)
        demo.assert_called_once_with("example/project")

    def test_cli_without_arguments_shows_guidance_without_running_demo(self):
        with redirect_stdout(self.output), patch("sys.argv", ["rocketride"]):
            with patch("rocketride.__main__.run_demo") as demo:
                self.assertEqual(main(), 0)
        demo.assert_not_called()
        self.assertIn("python3 -m rocketride demo", self.output.getvalue())


if __name__ == "__main__":
    unittest.main()
