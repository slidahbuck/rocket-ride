# Review and demo walkthrough

## One-command reviewer flow

After cloning the submission branch, run from the repository root:

```sh
python3 -m rocketride demo
```

Python 3.10 or newer with SQLite support and internet access are required. No packages need installing. The command runs the automated tests first, imports a live page from `python/cpython`, shows a sample, reads the saved records in a separate Python process with GitHub requests blocked, repeats the import, checks for duplicate keys, and displays an expected invalid-input error. Its explanations and final commands let reviewers continue exploring without preparing their own verification script.

The demo uses a fresh temporary database and deletes it afterward. Your existing `review.sqlite3` or other database files are untouched. Live issue counts and titles may change; zero duplicate keys is the stable requirement. A failed live request produces useful guidance and a nonzero exit status after the tests have run. Run `python3 -m unittest discover -v` to verify only the offline suite, or `python3 -m rocketride demo --repository owner/name` to choose a different public repository.

Reviewers need GitHub access to clone the private repository. That access and an accurate personal learning reflection still need completing before submission.

## Learn the implementation

Read these files in order and use the questions to check your understanding:

1. `rocketride/__main__.py`: Where does the repository argument go? Why is the exit status nonzero for an error?
2. `rocketride/connector.py`: What happens on import versus read? Why does import return the batch count rather than the total saved count?
3. `rocketride/github.py`: What URL is requested? Why do we filter `pull_request` and save `html_url`? What happens before a malformed response reaches the database?
4. `rocketride/storage.py`: Why are repository and issue number both in the primary key? What does `excluded.title` mean? What does the transaction protect?
5. `tests/test_connector.py`: How can network requests be mocked while the database stays real? Which tests establish persistence and offline reading?
6. `rocketride/demo.py`: How does the one-command flow check the core interface while keeping live requests separate from deterministic tests?

Run `python3 -m unittest discover -v`, then open the repeated-import and rollback tests and predict their assertions before reading them. Ask Codex to explain a specific line or propose a failing example if you get stuck. Update the README's personal reflection with what you actually learned before submitting.

## Manual verification

Use a new filename for a fresh run, and use that same file throughout:

```sh
python3 -m rocketride import python/cpython --db review.sqlite3
python3 -m rocketride read python/cpython --db review.sqlite3
python3 -m rocketride import python/cpython --db review.sqlite3
python3 -m rocketride read python/cpython --db review.sqlite3
python3 -m rocketride import bad-input --db review.sqlite3
```

The last command deliberately exits 1 and prints a useful JSON error. Exit the terminal, open a new one at the repository root, and run the read command again. It should return saved data. Reading also works with internet disconnected.

Inspect duplicates and total rows directly:

```sh
python3 - <<'PY'
import sqlite3
with sqlite3.connect("review.sqlite3") as connection:
    print("Saved rows:", connection.execute("SELECT COUNT(*) FROM issues").fetchone()[0])
    duplicates = connection.execute(
        "SELECT repository, issue_number, COUNT(*) FROM issues "
        "GROUP BY repository, issue_number HAVING COUNT(*) > 1"
    ).fetchall()
    print("Duplicates:", duplicates)
PY
```

Expected duplicates: `[]`. Live GitHub data can change between imports, so unchanged total count is helpful evidence but not a guaranteed outcome. The unique-key query and automated repeated-input test establish duplicate prevention independently of live changes.

## Demo plan under two minutes

The reviewer command is a convenient complete check. For your recorded submission, use the individual commands in Manual verification so your narration clearly explains each operation and your design decision.

Prepare the terminal, commands, and a fresh database filename before recording. Rehearse once to avoid lengthy output scrolling. If the issue list is long, show the operation, count, and a representative issue in the terminal output rather than scrolling through every record.

| Time | Show and explain |
| --- | --- |
| 0:00 to 0:10 | Introduce a public GitHub issue connector with local SQLite persistence. |
| 0:10 to 0:35 | Run a real import and point out a saved issue's number, title, and URL. |
| 0:35 to 0:55 | Run read in a new terminal process, using the same database. Explain it does not call GitHub. |
| 0:55 to 1:20 | Import again, read the saved data, and show the duplicate query returning `[]`. |
| 1:20 to 1:35 | Run `import bad-input` and show the useful error. |
| 1:35 to 1:50 | Explain the composite key and upsert, or why absence from one page does not cause deletion. |

A new CLI process demonstrates restart persistence. The offline test is stronger evidence that read avoids network access. Do not claim the demo proves something you have not actually shown or tested.

## Remaining submission work

Record and upload the video to Google Drive. Verify that reviewers can view the repository and video. Review the README reflection for accuracy. Prepare an individual reply in the original email thread with the GitHub and Drive links. Sending that reply requires explicit approval of the prepared email.
