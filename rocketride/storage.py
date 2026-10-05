"""SQLite persistence with batch transactions and a composite primary key."""

from contextlib import closing
import sqlite3

SCHEMA = """
CREATE TABLE IF NOT EXISTS issues (
    repository TEXT NOT NULL,
    issue_number INTEGER NOT NULL CHECK (issue_number > 0),
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    PRIMARY KEY (repository, issue_number)
)
"""

UPSERT = """
INSERT INTO issues (repository, issue_number, title, url)
VALUES (:repository, :issue_number, :title, :url)
ON CONFLICT(repository, issue_number) DO UPDATE SET
    title = excluded.title,
    url = excluded.url
"""


def save_issues(db_path: str, issues: list[dict]) -> None:
    with closing(sqlite3.connect(db_path)) as connection:
        connection.execute(SCHEMA)
        with connection:
            connection.executemany(UPSERT, issues)


def load_issues(db_path: str, repository: str) -> list[dict]:
    with closing(sqlite3.connect(db_path)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute(SCHEMA)
        rows = connection.execute(
            "SELECT repository, issue_number, title, url FROM issues "
            "WHERE repository = ? ORDER BY issue_number",
            (repository,),
        ).fetchall()
        return [dict(row) for row in rows]
