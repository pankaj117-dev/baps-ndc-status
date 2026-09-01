#!/usr/bin/env python3
"""Comment on a freshly opened 'weekly-update' issue with any open follow-ups
for that project, so the PM sees them before they finish filling out the form.

Run by .github/workflows/remind.yml on `issues: opened`.
Usage: remind.py <issue-number>
"""
import os
import sys

from lib import PROJECT_NAME_TO_ID, load_json, parse_issue_form_body, run_gh

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NOTES_PATH = os.path.join(ROOT, "notes.json")


def main():
    if len(sys.argv) < 2:
        print("usage: remind.py <issue-number>", file=sys.stderr)
        sys.exit(1)

    issue_number = sys.argv[1]
    body = run_gh(["issue", "view", issue_number, "--json", "body", "-q", ".body"])
    fields = parse_issue_form_body(body)
    project_name = fields.get("Project", "").strip()
    project_id = PROJECT_NAME_TO_ID.get(project_name)

    if not project_id:
        print(f"could not resolve project from issue #{issue_number}, skipping reminder")
        return

    notes = load_json(NOTES_PATH, [])
    open_notes = [n for n in notes if n["projectId"] == project_id and n["status"] == "open"]

    if not open_notes:
        print(f"no open follow-ups for '{project_id}', nothing to remind")
        return

    lines = [
        f"👋 Before you submit — there {'is' if len(open_notes) == 1 else 'are'} "
        f"**{len(open_notes)} open follow-up{'s' if len(open_notes) != 1 else ''}** "
        f"for **{project_name}** from previous meetings:",
        "",
    ]
    for n in open_notes:
        raised = f" _(raised by {n['raisedBy']})_" if n.get("raisedBy") else ""
        lines.append(f"- {n['text']}{raised}")
    lines.append("")
    lines.append("Please address these in this update if you can.")

    run_gh(["issue", "comment", issue_number, "--body", "\n".join(lines)])
    print(f"reminded issue #{issue_number} of {len(open_notes)} open follow-up(s)")


if __name__ == "__main__":
    main()
