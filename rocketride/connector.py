"""Public import/read functions returning consistent JSON-compatible results."""

import os
import sqlite3

from .errors import ConnectorError
from .github import fetch_issues, normalize_repository
from .storage import load_issues, save_issues

DEFAULT_DB_PATH = "issues.sqlite3"


def _database_path(db_path) -> str:
    try:
        value = os.fspath(db_path)
    except TypeError as exc:
        raise ConnectorError("invalid_database_path", "Expected a filesystem path for the database.") from exc
    if not isinstance(value, str) or not value.strip() or "\x00" in value or value == ":memory:":
        raise ConnectorError("invalid_database_path", "Use a nonempty file path for persistent storage.")
    return value


def _success(repository: str, issues: list[dict]) -> dict:
    return {"ok": True, "repository": repository, "count": len(issues), "issues": issues}


def _failure(exc: ConnectorError) -> dict:
    return {"ok": False, "error": {"code": exc.code, "message": str(exc)}}


def import_issues(repository: str, db_path=DEFAULT_DB_PATH) -> dict:
    """Import one page; count/ issues describe this batch, not all saved rows."""
    try:
        repository = normalize_repository(repository)
        db_path = _database_path(db_path)
        issues = fetch_issues(repository)
        save_issues(db_path, issues)
        return _success(repository, issues)
    except ConnectorError as exc:
        return _failure(exc)
    except (sqlite3.Error, OSError) as exc:
        return _failure(ConnectorError("storage_error", f"Could not save issues: {exc}"))


def read_issues(repository: str, db_path=DEFAULT_DB_PATH) -> dict:
    """Read saved rows without any GitHub access; an empty database is valid."""
    try:
        repository = normalize_repository(repository)
        db_path = _database_path(db_path)
        return _success(repository, load_issues(db_path, repository))
    except ConnectorError as exc:
        return _failure(exc)
    except (sqlite3.Error, OSError) as exc:
        return _failure(ConnectorError("storage_error", f"Could not read issues: {exc}"))
