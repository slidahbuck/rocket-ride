"""Fetch and validate exactly one page of public GitHub issues."""

import json
import re
from http.client import HTTPException
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from .errors import ConnectorError

API_VERSION = "2026-03-10"
TIMEOUT_SECONDS = 15
PAGE_SIZE = 30


def normalize_repository(repository: str) -> str:
    """Validate owner/name before constructing a URL or opening a database."""
    if not isinstance(repository, str):
        raise ConnectorError("invalid_repository", "Expected repository in owner/name format.")
    value = repository.strip()
    parts = value.split("/")
    if (
        len(parts) != 2
        or not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?", parts[0])
        or not re.fullmatch(r"[A-Za-z0-9_.-]{1,100}", parts[1])
        or parts[1] in {".", ".."}
    ):
        raise ConnectorError("invalid_repository", "Expected repository in owner/name format.")
    return value.lower()


def fetch_issues(repository: str) -> list[dict]:
    request = Request(
        f"https://api.github.com/repos/{repository}/issues?state=open&per_page={PAGE_SIZE}&page=1",
        headers={
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": API_VERSION,
            "User-Agent": "rocketride-issue-connector",
        },
    )
    try:
        with urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read())
    except HTTPError as exc:
        if exc.code == 404:
            message = f"Repository {repository} was not found or is not publicly accessible."
            code = "repository_not_found"
        elif exc.code == 429 or (
            exc.code == 403
            and (exc.headers.get("X-RateLimit-Remaining") == "0" or exc.headers.get("Retry-After"))
        ):
            code = "rate_limited"
            message = "GitHub rate limit reached. Try again later."
            if exc.headers.get("Retry-After"):
                message += f" Retry-After: {exc.headers['Retry-After']} seconds."
            elif exc.headers.get("X-RateLimit-Reset"):
                message += f" Reset at Unix timestamp {exc.headers['X-RateLimit-Reset']}."
        else:
            code = "api_error"
            message = f"GitHub request failed with HTTP {exc.code}."
        exc.close()
        raise ConnectorError(code, message) from exc
    except (URLError, TimeoutError, OSError, HTTPException) as exc:
        raise ConnectorError("network_error", "Could not reach GitHub. Check your connection and try again.") from exc
    except (ValueError, UnicodeError) as exc:
        raise ConnectorError("invalid_response", "GitHub returned invalid JSON.") from exc

    if not isinstance(payload, list):
        raise ConnectorError("invalid_response", "Expected a list of GitHub issues.")
    issues = []
    for item in payload:
        if not isinstance(item, dict):
            raise ConnectorError("invalid_response", "GitHub returned a malformed issue.")
        if "pull_request" in item:
            continue
        number, title, url = item.get("number"), item.get("title"), item.get("html_url")
        if (
            type(number) is not int
            or number < 1
            or not isinstance(title, str)
            or not isinstance(url, str)
            or not url.startswith("https://github.com/")
        ):
            raise ConnectorError("invalid_response", "GitHub returned an issue with invalid required fields.")
        issues.append({"repository": repository, "issue_number": number, "title": title, "url": url})
    return sorted(issues, key=lambda issue: issue["issue_number"])
