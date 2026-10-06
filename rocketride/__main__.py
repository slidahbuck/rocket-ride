"""Run a reviewer demo or import/read individual repositories."""

import argparse
import json

from .connector import DEFAULT_DB_PATH, import_issues, read_issues
from .demo import DEFAULT_REPOSITORY, run_demo


def main() -> int:
    parser = argparse.ArgumentParser(
        prog="python3 -m rocketride",
        description="Save one page of public GitHub issues and read them locally.",
        epilog="New here? Run: python3 -m rocketride demo",
    )
    commands = parser.add_subparsers(dest="command")
    demo = commands.add_parser("demo", help="Run the guided reviewer checks with temporary storage")
    demo.add_argument("--repository", default=DEFAULT_REPOSITORY, help="Public repository (default: %(default)s)")
    for name, help_text in (("import", "Fetch and save one page of issues"), ("read", "Read saved issues without GitHub")):
        command = commands.add_parser(name, help=help_text)
        command.add_argument("repository", help="Public GitHub repository in owner/name format")
        command.add_argument("--db", default=DEFAULT_DB_PATH, help="SQLite file path (default: %(default)s)")
    args = parser.parse_args()
    if args.command is None:
        parser.print_help()
        return 0
    if args.command == "demo":
        return run_demo(args.repository)
    operation = import_issues if args.command == "import" else read_issues
    result = operation(args.repository, args.db)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
