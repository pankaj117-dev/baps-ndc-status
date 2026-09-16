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
    STATUS_LABEL,
    STATUS_RANK,
    STATUS_TEXT_TO_KEY,
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
        "--json", "number,body,createdAt,author,url,labels",
        "--limit", "100",
    ])
    return json.loads(out)


NEEDS_REASON_LABEL = "needs-reason"


def has_label(issue, name):
    return any((l.get("name") or "").lower() == name.lower() for l in issue.get("labels", []))


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

    time_saved_days = fields.get("Time saved this week (days)", "")
    if time_saved_days:
        project["timeSavedDays"] = to_int(time_saved_days, project.get("timeSavedDays", 0))

    time_saved_note = fields.get("What did the team do to save that time?", "")
    if time_saved_note:
        project["timeSavedNote"] = lines(time_saved_note)

    scope_reduced = fields.get("Reducing scope to hold the date?", "")
    if scope_reduced:
        project["scopeReduced"] = scope_reduced.strip().lower() == "yes"

    status = fields.get("Overall status", "")
    if status:
        key = STATUS_TEXT_TO_KEY.get(status.strip().lower())
        if key:
            project["status"] = key

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

    fast_follow = fields.get("Fast-follow items (planned or remaining)", "")
    if fast_follow:
        project["fastFollowItems"] = lines(fast_follow)

    # Unlike most fields (blank = "unchanged"), escalations are inherently
    # this-week's-news: if the PM leaves it blank they mean "nothing to
    # escalate this week", so we clear it rather than carrying last week's
    # escalation forward forever. Only skip entirely if the field wasn't
    # part of the submitted form at all (old issues from before this field
    # existed).
    if "Escalations to leadership this week" in fields:
        project["escalations"] = lines(fields.get("Escalations to leadership this week", ""))


def ingest_weekly_updates(data):
    issues = fetch_issues("weekly-update")
    if not issues:
        return [], None, []

    by_id = {p["id"]: p for p in data["projects"]}
    ingested = []
    blocked = []
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

        project = by_id[project_id]
        prev_status = project.get("status")
        status_text = fields.get("Overall status", "").strip().lower()
        new_status = STATUS_TEXT_TO_KEY.get(status_text) if status_text else None
        reason = fields.get("Reason for status change", "").strip()
        status_changed = bool(new_status) and bool(prev_status) and new_status != prev_status
        worsened = status_changed and STATUS_RANK.get(new_status, 0) > STATUS_RANK.get(prev_status, 0)

        if worsened and not reason:
            if not has_label(issue, NEEDS_REASON_LABEL):
                comment = (
                    f"⚠️ This update moves **{project['name']}** from **{STATUS_LABEL.get(prev_status, prev_status)}** "
                    f"to **{STATUS_LABEL.get(new_status, new_status)}**, but the **'Reason for status change'** field "
                    "is blank. Please edit this issue and add the reason (what changed / root cause) — that's required "
                    "any time a project moves to a worse status, so leadership can see why along with the date. "
                    "This issue will stay open and get picked up automatically on the next run once the reason is added."
                )
                try:
                    run_gh(["issue", "comment", str(issue["number"]), "--body", comment])
                    run_gh(["issue", "edit", str(issue["number"]), "--add-label", NEEDS_REASON_LABEL])
                except RuntimeError as e:
                    print(f"warning: could not flag issue #{issue['number']}: {e}", file=sys.stderr)
            blocked.append(issue["number"])
            print(f"issue #{issue['number']}: blocked — status worsened with no reason given, left open")
            continue

        apply_weekly_update(project, fields)
        project["statusChangeReason"] = reason if status_changed else ""

        if has_label(issue, NEEDS_REASON_LABEL):
            try:
                run_gh(["issue", "edit", str(issue["number"]), "--remove-label", NEEDS_REASON_LABEL])
            except RuntimeError as e:
                print(f"warning: could not unlabel issue #{issue['number']}: {e}", file=sys.stderr)

        if latest_as_of is None or as_of >= latest_as_of:
            latest_as_of = as_of

        ingested.append(issue["number"])
        print(f"issue #{issue['number']}: merged into '{project_id}' (as of {as_of})")

    if latest_as_of and latest_as_of != data.get("asOf"):
        data["asOf"] = latest_as_of

    return ingested, latest_as_of, blocked


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


def ingest_resolutions(notes):
    """Pick up 'resolve-feedback' issues (opened via the dashboard's "✓ Resolve"
    link) and flip the matching note's status to "resolved" in place. The note
    is never removed — it stays in notes.json and git history, just no longer
    counts as "open"."""
    issues = fetch_issues("resolve-feedback")
    if not issues:
        return []

    by_id = {n["id"]: n for n in notes}
    ingested = []

    for issue in issues:
        fields = parse_issue_form_body(issue["body"] or "")
        note_id = fields.get("Note ID", "").strip()
        resolution = fields.get("How was this resolved?", "").strip()
        resolved_by = (issue.get("author") or {}).get("login", "unknown")

        note = by_id.get(note_id)
        if not note:
            print(f"issue #{issue['number']}: no note with id '{note_id}' found, closing anyway")
            ingested.append(issue["number"])
            continue

        if note["status"] != "resolved":
            note["status"] = "resolved"
            note["resolvedAt"] = issue.get("createdAt")
            note["resolvedBy"] = resolved_by
            note["resolutionNote"] = resolution
            note["resolvedVia"] = issue.get("url")
            print(f"issue #{issue['number']}: resolved '{note_id}'")
        else:
            print(f"issue #{issue['number']}: '{note_id}' was already resolved, closing anyway")

        ingested.append(issue["number"])

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
                "delayNote": p.get("delayNote", ""),
                "statusChangeReason": p.get("statusChangeReason", ""),
                "phase": p.get("phase", ""),
                "nextMilestone": p.get("nextMilestone"),
                "goLive": p.get("goLive"),
                "originalGoLive": p.get("originalGoLive"),
                "delayImpact": p.get("delayImpact", ""),
                "delayMitigation": p.get("delayMitigation", []),
                "delayTradeoffs": p.get("delayTradeoffs", ""),
                "timeSavedDays": p.get("timeSavedDays", 0),
                "timeSavedNote": p.get("timeSavedNote", []),
                "scopeReduced": p.get("scopeReduced", False),
                "risks": p.get("risks", []),
                "riskMitigations": p.get("riskMitigations", []),
                "fastFollowItems": p.get("fastFollowItems", []),
                "escalations": p.get("escalations", []),
                "dependencies": p.get("dependencies", []),
                "dependencyTeams": p.get("dependencyTeams", []),
                "dependencyMitigations": p.get("dependencyMitigations", []),
                "sprintStatus": p.get("sprintStatus", {"completed": [], "inProgress": [], "nextPlan": []}),
            }
            for p in data["projects"]
        ],
    }


def main():
    data = load_json(DATA_PATH, {"asOf": None, "lastUpdated": None, "projects": []})
    history = load_json(HISTORY_PATH, {})
    notes = load_json(NOTES_PATH, [])

    update_issue_numbers, as_of_changed, blocked_issue_numbers = ingest_weekly_updates(data)
    feedback_issue_numbers = ingest_feedback(notes)
    resolve_issue_numbers = ingest_resolutions(notes)
    if blocked_issue_numbers:
        print(f"note: {len(blocked_issue_numbers)} issue(s) left open pending a reason for status change: {blocked_issue_numbers}")

    if update_issue_numbers or feedback_issue_numbers or resolve_issue_numbers:
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
        close_issues(
            resolve_issue_numbers,
            "✅ Marked resolved — it'll drop off the open follow-ups list but stays in the "
            "feedback history (and in git) for the record.",
        )
        print("done: data updated, issues closed")
    else:
        print("done: nothing to ingest")


if __name__ == "__main__":
    main()
