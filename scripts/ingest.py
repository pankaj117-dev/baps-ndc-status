#!/usr/bin/env python3
"""Pull open 'weekly-update' and 'feedback' issues into data.json / history.json
/ notes.json, then close the issues that were successfully ingested.

Run by .github/workflows/ingest.yml (scheduled + manual). Safe to run
repeatedly — issues are only closed once they've been merged in, and repeat
runs with no open issues are no-ops.
"""
import datetime
import json
import os
import sys

from lib import (
    PROJECT_NAME_TO_ID,
    load_json,
    lines,
    parse_issue_form_body,
    run_gh,
    save_json,
    to_int,
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(ROOT, "data.json")
HISTORY_PATH = os.path.join(ROOT, "history.json")
NOTES_PATH = os.path.join(ROOT, "notes.json")


def fetch_issues(label):
    out = run_gh([
        "issue", "list",
        "--label", label,
        "--state", "open",
        "--json", "number,body,createdAt,author,url",
        "--limit", "100",
    ])
    return json.loads(out)


def apply_weekly_update(project, fields):
    """Mutate `project` in place with any non-empty fields from the issue."""
    def set_if_present(key, source_key, transform=str):
        value = fields.get(source_key, "")
        if value:
            project[key] = transform(value)

    set_if_present("owner", "PM name")
    set_if_present("stage", "Pipeline stage")
    set_if_present("phase", "Current phase")
    set_if_present("delayNote", "Delay note")
    set_if_present("delayImpact", "Impact of delay")

    delay_mitigation = fields.get("Mitigation steps taken", "")
    if delay_mitigation:
        project["delayMitigation"] = lines(delay_mitigation)

    delay_tradeoffs = fields.get("Trade-off conversations", "")
    if delay_tradeoffs:
        project["delayTradeoffs"] = delay_tradeoffs.strip()

    status = fields.get("Overall status", "")
    if status:
        project["status"] = status.strip().lower()

    progress = fields.get("Progress (0-100)", "")
    if progress:
        project["progress"] = max(0, min(100, to_int(progress, project.get("progress", 0))))

    delay_days = fields.get("Delay (days)", "")
    if delay_days:
        project["delayDays"] = to_int(delay_days, project.get("delayDays", 0))

    milestone_name = fields.get("Next milestone name", "")
    milestone_date = fields.get("Next milestone date", "")
    if milestone_name or milestone_date:
        nm = project.get("nextMilestone") or {}
        if milestone_name:
            nm["name"] = milestone_name
        if milestone_date:
            nm["date"] = milestone_date
        project["nextMilestone"] = nm

    go_live = fields.get("Go-live date", "")
    if go_live:
        # First time a go-live date is recorded for this project, lock it in as
        # the baseline. Later updates move `goLive` but `originalGoLive` stays
        # put so the dashboard can show how far the date has slipped.
        if not project.get("originalGoLive"):
            project["originalGoLive"] = go_live
        project["goLive"] = go_live

    deps = fields.get("Dependencies", "")
    if deps:
        project["dependencies"] = lines(deps)

    dep_team = fields.get("Dependency owning team(s)", "")
    if dep_team:
        project["dependencyTeams"] = lines(dep_team)

    dep_mitigation = fields.get("Dependency mitigation plan / impact", "")
    if dep_mitigation:
        project["dependencyMitigations"] = lines(dep_mitigation)

    sprint = project.get("sprintStatus") or {"completed": [], "inProgress": [], "nextPlan": []}
    completed = fields.get("Completed this week", "")
    in_progress = fields.get("In progress", "")
    next_plan = fields.get("Next plan", "")
    if completed:
        sprint["completed"] = lines(completed)
    if in_progress:
        sprint["inProgress"] = lines(in_progress)
    if next_plan:
        sprint["nextPlan"] = lines(next_plan)
    project["sprintStatus"] = sprint

    risks = fields.get("Risks / blockers", "")
    if risks:
        project["risks"] = lines(risks)

    risk_mitigation = fields.get("Risk mitigation plan", "")
    if risk_mitigation:
        project["riskMitigations"] = lines(risk_mitigation)


def ingest_weekly_updates(data):
    issues = fetch_issues("weekly-update")
    if not issues:
        return [], None

    by_id = {p["id"]: p for p in data["projects"]}
    ingested = []
    latest_as_of = data.get("asOf")

    for issue in issues:
        fields = parse_issue_form_body(issue["body"] or "")
        project_name = fields.get("Project", "").strip()
        project_id = PROJECT_NAME_TO_ID.get(project_name)
        as_of = fields.get("As of date", "").strip()

        if not project_id or project_id not in by_id:
            print(f"issue #{issue['number']}: unrecognized project '{project_name}', skipping")
            continue
        if not as_of:
            print(f"issue #{issue['number']}: missing 'As of date', skipping")
            continue

        apply_weekly_update(by_id[project_id], fields)
        if latest_as_of is None or as_of >= latest_as_of:
            latest_as_of = as_of

        ingested.append(issue["number"])
        print(f"issue #{issue['number']}: merged into '{project_id}' (as of {as_of})")

    if latest_as_of and latest_as_of != data.get("asOf"):
        data["asOf"] = latest_as_of

    return ingested, latest_as_of


def ingest_feedback(notes):
    issues = fetch_issues("feedback")
    if not issues:
        return []

    ingested = []
    existing_ids = {n["id"] for n in notes}
    next_id = 1 + max([0] + [int(n["id"].split("-")[-1]) for n in notes if n["id"].startswith("note-")])

    for issue in issues:
        fields = parse_issue_form_body(issue["body"] or "")
        project_name = fields.get("Project", "").strip()
        project_id = PROJECT_NAME_TO_ID.get(project_name)
        note_text = fields.get("Feedback / ask", "").strip()
        mitigation_impact = fields.get("Mitigation plan / impact (if this is a risk or dependency)", "").strip()
        raised_by = fields.get("Raised by", "").strip() or (issue.get("author") or {}).get("login", "unknown")

        if not project_id or not note_text:
            print(f"issue #{issue['number']}: missing project or note text, skipping")
            continue

        note_id = f"note-{next_id}"
        next_id += 1
        notes.append({
            "id": note_id,
            "projectId": project_id,
            "text": note_text,
            "mitigationImpact": mitigation_impact,
            "raisedBy": raised_by,
            "createdAt": issue.get("createdAt"),
            "sourceIssue": issue.get("url"),
            "status": "open",
        })
        ingested.append(issue["number"])
        print(f"issue #{issue['number']}: logged feedback for '{project_id}'")

    return ingested


def close_issues(numbers, comment):
    for n in numbers:
        try:
            run_gh(["issue", "comment", str(n), "--body", comment])
            run_gh(["issue", "close", str(n)])
        except RuntimeError as e:
            print(f"warning: could not close issue #{n}: {e}", file=sys.stderr)


def snapshot_history(data, history):
    as_of = data.get("asOf")
    if not as_of:
        return
    history[as_of] = {
        "capturedAt": datetime.datetime.utcnow().isoformat() + "Z",
        "projects": [
            {
                "id": p["id"],
                "name": p["name"],
                "status": p["status"],
                "progress": p["progress"],
                "stage": p.get("stage", ""),
                "delayDays": p.get("delayDays", 0),
                "phase": p.get("phase", ""),
                "nextMilestone": p.get("nextMilestone"),
                "goLive": p.get("goLive"),
                "originalGoLive": p.get("originalGoLive"),
                "delayImpact": p.get("delayImpact", ""),
                "delayMitigation": p.get("delayMitigation", []),
                "delayTradeoffs": p.get("delayTradeoffs", ""),
                "risks": p.get("risks", []),
                "riskMitigations": p.get("riskMitigations", []),
                "dependencies": p.get("dependencies", []),
                "dependencyTeams": p.get("dependencyTeams", []),
                "dependencyMitigations": p.get("dependencyMitigations", []),
            }
            for p in data["projects"]
        ],
    }


def main():
    data = load_json(DATA_PATH, {"asOf": None, "lastUpdated": None, "projects": []})
    history = load_json(HISTORY_PATH, {})
    notes = load_json(NOTES_PATH, [])

    update_issue_numbers, as_of_changed = ingest_weekly_updates(data)
    feedback_issue_numbers = ingest_feedback(notes)

    if update_issue_numbers or feedback_issue_numbers:
        data["lastUpdated"] = datetime.datetime.utcnow().isoformat() + "Z"
        snapshot_history(data, history)

        save_json(DATA_PATH, data)
        save_json(HISTORY_PATH, history)
        save_json(NOTES_PATH, notes)

        close_issues(
            update_issue_numbers,
            "✅ Merged into `data.json` — thanks! This will show up on the dashboard shortly.",
        )
        close_issues(
            feedback_issue_numbers,
            "✅ Logged as an open follow-up — it'll show on the dashboard and the PM will be "
            "reminded next time they submit a weekly update for this project.",
        )
        print("done: data updated, issues closed")
    else:
        print("done: nothing to ingest")


if __name__ == "__main__":
    main()
