"""Run with python3 -m rocketride import|read owner/name --db PATH."""

import argparse
import json

from .connector import DEFAULT_DB_PATH, import_issues, read_issues


def main() -> int:
    parser = argparse.ArgumentParser(description="Save one page of public GitHub issues and read them locally.")
    parser.add_argument("command", choices=("import", "read"))
    parser.add_argument("repository", help="Public GitHub repository in owner/name format")
    parser.add_argument("--db", default=DEFAULT_DB_PATH, help="SQLite file path (default: %(default)s)")
    args = parser.parse_args()
    operation = import_issues if args.command == "import" else read_issues
    result = operation(args.repository, args.db)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
