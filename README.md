# RocketRide issue connector

Import one page of open issues from a public GitHub repository into a local SQLite file, then read the saved issues without contacting GitHub. Pull requests are excluded, and repeated imports update existing records without duplicates.

## Reviewer quick start

Clone the submission branch, enter the folder, and run one command:

```sh
git clone --branch codex/issue-connector https://github.com/slidahbuck/rocket-ride.git
cd rocket-ride
python3 -m rocketride demo
```

Requires **Python 3.10 or newer with SQLite support**, Git, and internet access. No package installation or API token is needed. On Windows, substitute `py` for `python3` if needed. The repository is private, so reviewers must have GitHub access before cloning; arranging that access is still part of submission preparation.

The demo runs the automated tests, imports a real page from `python/cpython`, reads the saved data in a separate Python process with GitHub requests blocked, imports again, checks for duplicate keys, and shows an intentional invalid-input error. It prints a compact sample and explains what each step establishes, followed by commands for using the connector yourself. A fresh temporary database is removed afterward, so existing database files are untouched. Issue titles and counts depend on live GitHub data and can change between runs.

To use a different public repository:

```sh
python3 -m rocketride demo --repository owner/name
```

The demo exits successfully only if its checks pass. A network, repository-access, or rate-limit failure is explained and returns a nonzero exit status; the tests still run before live requests. To run only the offline tests, use `python3 -m unittest discover -v`.

## Prerequisites and local setup

- Python 3.10 or newer with SQLite support. Development verification used Python 3.14.7.
- Git to clone the repository.
- Internet access for imports. Local reads and automated tests work offline.
- No third-party Python dependencies, API token, paid tools, or hosted services are required.

Run commands from the repository root. Check your Python version with `python3 --version`.

Run `python3 -m rocketride` to see command help and quick-start guidance.

## Run

```sh
python3 -m rocketride import python/cpython --db issues.sqlite3
python3 -m rocketride read python/cpython --db issues.sqlite3
```

The database file is created automatically. Its parent directory must already exist. Use the same path for import and read; relative paths are resolved from the current working directory. The default path is `issues.sqlite3`. A missing database is initialized as empty when read. In-memory databases are rejected because they cannot meet the persistence requirement.

Both commands print JSON and exit with status 0 on success or 1 on an expected connector failure. Invalid command syntax uses argparse's standard help and exit status 2.

Illustrative success output, with example data rather than a claim about a live repository:

```json
{
  "ok": true,
  "repository": "example/project",
  "count": 1,
  "issues": [
    {
      "repository": "example/project",
      "issue_number": 42,
      "title": "Fix login error",
      "url": "https://github.com/example/project/issues/42"
    }
  ]
}
```

Import returns the issues processed in that page after filtering, with `count` equal to the length of that batch. It does not claim that every processed issue is newly inserted. Read returns every saved issue for that repository, so its count may be larger than the latest import count. Results are sorted by issue number.

Example error input:

```sh
python3 -m rocketride import bad-input --db issues.sqlite3
```

```json
{
  "ok": false,
  "error": {
    "code": "invalid_repository",
    "message": "Expected repository in owner/name format."
  }
}
```

The connector distinguishes `invalid_repository`, `invalid_database_path`, `repository_not_found`, `rate_limited`, `api_error`, `network_error`, `invalid_response`, and `storage_error`. Empty issue lists are successful results.

## Reusable Python interface

```python
from rocketride import import_issues, read_issues

import_result = import_issues("python/cpython", db_path="issues.sqlite3")
saved_result = read_issues("python/cpython", db_path="issues.sqlite3")

if not import_result["ok"]:
    print(import_result["error"]["message"])
```

Both functions return ordinary JSON-compatible dictionaries with the contracts shown above. Expected input, network, response, and storage failures are returned as errors. Unexpected programming errors are allowed to surface so bugs are not disguised as normal failures.

## Test

```sh
python3 -m unittest discover -v
```

Tests mock the HTTP boundary and use real temporary SQLite files. They cover import and read, pull request filtering, updated titles and URLs, duplicate prevention, repository isolation and case normalization, persistence in a separate process, empty results, invalid inputs, HTTP and network failures, malformed responses, storage errors, transaction rollback, and CLI errors. The local read test makes network access fail if attempted.

Reviewer-demo tests also cover temporary database cleanup, failed checks and API calls, CLI guidance and repository selection, and detecting an accidental GitHub request in the separate read process.

A real API request is separate from the deterministic automated suite. The `demo` command combines that suite with live checks for reviewer convenience. Public requests are rate limited, and the contents of live repositories change.

### Development verification

On October 5, 2026, all 16 automated tests passed on Python 3.14.7. A separate live CLI check imported 11 issues from the first page of `python/cpython`, read them in another process, repeated the import with 11 saved issues and zero duplicate groups, and verified the invalid-input error and exit status. Database files used for verification were temporary and are not included in the repository. The live count is a record of that check, not an expected count for future runs.

On October 6, 2026, a fresh clone from GitHub passed all 16 tests without installing dependencies. The live CLI check imported and read 14 issues, repeated the import with zero duplicate groups, and confirmed the invalid-input error. This also verified that the pushed repository contains everything needed for local use.

After adding the reviewer command on October 6, all 25 automated tests passed. The guided live demo imported 14 issues, matched the saved records in a new process with GitHub requests blocked, repeated the import with zero duplicate groups, showed the expected invalid-input error, and removed its temporary database.

## Snapshot behavior and scope

- Each import requests exactly page 1 with 30 entries and `state=open`. The page can include pull requests, so fewer than 30 issues may be saved.
- Repository names are trimmed and lowercased so casing does not create separate records.
- `(repository, issue_number)` identifies a saved issue. Returned issues update their title and browser URL on conflict.
- Previously saved issues missing from a later page are retained. One page cannot establish whether an issue closed or merely moved to another page. Saved data is not a complete mirror of currently open issues.
- Reading is entirely local. It does not verify that the repository still exists or that saved issues remain open.
- There is no pagination, background synchronization, automatic retry, UI, or deployment. Repository renames are not reconciled into a single identity.

See [Architecture.MD](Architecture.MD) for implementation decisions and [WALKTHROUGH.md](WALKTHROUGH.md) for the learning and demo plan.

## AI and other tools used

- **OpenAI Codex desktop assistant:** Proposed the implementation, wrote the connector and tests, researched official documentation, and ran automated and live checks. The initial implementation and documentation were AI-authored and should be reviewed and understood before submission.
- **Python standard library:** `urllib.request` for GitHub HTTP requests, `json` for data encoding, `sqlite3` for persistence, `argparse` for the CLI, and `unittest`/`unittest.mock` for tests. No package installation was needed.
- **Git and GitHub CLI (`gh`):** Version control, creating the private repository, and pushing the implementation for cross-computer access.
- **Official GitHub, Python, and SQLite documentation:** Verified API fields and parameters, HTTP behavior, SQLite transactions, and UPSERT semantics.

### Problem investigated with AI and verification

The project explored how repeated imports can both avoid duplicates and refresh changed data. Ignoring duplicate inserts would leave titles stale, and issue number alone would mix records across repositories. Codex proposed a composite primary key and `ON CONFLICT ... DO UPDATE`. This was checked against SQLite's documentation and verified with real SQLite tests: importing the same issue twice leaves one row, importing a changed title and URL updates that row, and equal issue numbers in different repositories remain independent. A failing second write is also tested to confirm that the batch transaction rolls back.

This records what the project did, not a claim about the student's prior knowledge. Before submission, the student should explain this decision and add an accurate personal reflection on what they learned or corrected during review.

## Submission checklist

- Review the source and run the tests yourself.
- Follow the demo plan and record a video of at most two minutes with a real GitHub import.
- Arrange repository access for reviewers, and upload the video to Google Drive with viewing access.
- Reply individually to Abhinav's original thread with both links before Wednesday, October 7, 2026 at 11:59 p.m. Pacific. Do not use Reply All.

## References

- [GitHub repository issues API](https://docs.github.com/en/rest/issues/issues#list-repository-issues)
- [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [Python SQLite interface](https://docs.python.org/3/library/sqlite3.html)
- [SQLite UPSERT](https://www.sqlite.org/lang_upsert.html)
