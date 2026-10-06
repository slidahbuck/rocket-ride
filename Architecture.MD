# Architecture

## Interface and components

`rocketride.import_issues(repository, db_path="issues.sqlite3")` imports one page. `rocketride.read_issues(repository, db_path="issues.sqlite3")` reads all locally saved rows for that repository. Both return `{ok: true, repository, count, issues}` on success or `{ok: false, error: {code, message}}` on expected failure. Import count refers to its filtered batch; read count refers to all saved rows. Each issue has `repository`, `issue_number`, `title`, and `url`.

- `github.py`: Validates and normalizes `owner/name`, makes one HTTP request, excludes entries with `pull_request`, maps `html_url` to `url`, and validates every issue before storage.
- `storage.py`: Creates the table, performs parameterized UPSERTs in a transaction, and returns rows sorted by issue number. Connections are closed after each operation.
- `connector.py`: Exposes the two functions, validates the database path, coordinates import/read, and translates expected errors into dictionaries.
- `errors.py`: Carries stable error codes for expected failures.
- `__main__.py`: Parses CLI arguments, dispatches the guided demo or reusable functions, serializes import/read results as JSON, and sets the exit status.
- `demo.py`: Runs the automated suite and a guided live review using a temporary database. It shows a sample issue and explains each check without requiring reviewers to prepare commands or manage database files.

## Data flow

Import: validate input and database path, request `GET /repos/{owner}/{repo}/issues?state=open&per_page=30&page=1`, parse JSON, filter pull requests, validate and map required fields, save the batch, return the processed issues. Fetch and validation finish before opening storage, so API and malformed-response failures leave existing data untouched.

Read: validate input and database path, open SQLite, initialize an empty table if needed, select rows for the normalized repository, return dictionaries. The read path never invokes the GitHub client. Restart persistence is verified with a separate CLI process.

Reviewer demo: run tests, import a live page, read it in a separate Python process with the GitHub HTTP entry point blocked, repeat the import, query SQLite for duplicate keys, and check an intentional invalid-input failure. The fresh database is held in a temporary directory and deleted afterward. This verifies the submitted flow without modifying existing user data. Live titles and counts can change between requests, so duplicate-key checks do not depend on identical counts. The demo returns a nonzero status if a check or live request fails.

## Database schema

```sql
CREATE TABLE issues (
    repository TEXT NOT NULL,
    issue_number INTEGER NOT NULL CHECK (issue_number > 0),
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    PRIMARY KEY (repository, issue_number)
);
```

The composite primary key separates identical issue numbers in different repositories. `ON CONFLICT(repository, issue_number) DO UPDATE` refreshes title and URL without inserting a duplicate. The batch transaction commits on success and rolls back on a failed write. Bound SQL parameters keep data separate from SQL syntax.

## Configuration and failures

Database path is a function argument or CLI `--db` option. The default is `issues.sqlite3` relative to the working directory; parent directories must exist. File paths support persistence, while `:memory:` is rejected. The database file is runtime data and is ignored by Git.

`python3 -m rocketride demo` defaults to the public repository `python/cpython`; `--repository owner/name` chooses another public repository. The reviewer path requires internet access for its two imports, while the test suite and local reads work offline. It uses the standard library and needs no dependency installation. Running the CLI with no arguments prints help and quick-start guidance.

The GitHub client uses a 15-second socket timeout, a fixed first page of 30 entries, the JSON accept header, a user agent, and API version `2026-03-10`. Public requests use no token. GitHub's unauthenticated rate limit applies.

Expected failures have stable codes: invalid repository/path, inaccessible repository, rate limit, other HTTP failure, network failure, malformed response, and SQLite/file failure. Known rate-limit responses include retry/reset details when available. The CLI exits 1 for these failures and 0 for successes, including empty results. Argument syntax errors use argparse's exit 2. Unexpected code bugs are not swallowed.

## Tradeoffs and limitations

- Standard-library Python and embedded SQLite keep local setup small and avoid external runtime dependencies.
- No ORM or separate repository table is needed for four fields and one composite identity.
- Import results describe the current fetched batch; local read results describe the accumulated saved records. Count does not mean newly inserted rows.
- Lowercasing repository names avoids duplicates caused by input casing. Repository renames are not reconciled.
- Imports upsert rather than replacing all rows. An issue absent from page 1 might have moved to page 2, so its absence cannot justify deletion. This is a partial snapshot store, not authoritative synchronization of current open state.
- Reads can initialize a missing database and return an empty result; they do not check GitHub existence.
- HTTP is synchronous, with no pagination, automatic retries, scheduler, authentication, or UI. These are outside the assessment scope.
- Tests mock HTTP and exercise real SQLite, including rollback and process restart. A live import validates the external integration separately.
