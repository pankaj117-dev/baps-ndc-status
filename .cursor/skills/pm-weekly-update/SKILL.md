---
name: pm-weekly-update
description: >-
  Conversationally interview a PM to collect their weekly status update for
  one project in the baps-ndc-status dashboard, then write it directly into
  data.json/history.json so it shows up on the dashboard immediately — no
  GitHub issue, no waiting for the scheduled ingest bot. Covers everything
  the "Weekly Project Update" issue form covers (status, progress, risks,
  dependencies, delay, stage dates, sprint status) PLUS newer fields that
  form doesn't have yet (Change Requests, Decisions, Go-Live Checklist,
  RAID log, Features/sprint tracker, Milestones, narrative Delay Item Log).
  Use when a PM wants to submit, log, or update their weekly project
  status, or asks to "fill in" / "add" / "update" data for a project.
disable-model-invocation: true
---

# PM Weekly Update (Q&A)

Interview the PM one topic at a time (not one giant form dump), build a
`fields` JSON dict as you go, then apply it with
`scripts/apply_weekly_update_direct.py`. Field labels in `fields` MUST
match [reference.md](reference.md) **exactly** — they're reused verbatim
from `.github/ISSUE_TEMPLATE/weekly-update.yml` so the same validated
`apply_weekly_update()` logic in `scripts/ingest.py` runs either way.

## Before you start

1. `cd` to the repo root. Run `git pull` (or `git fetch && git merge
   origin/main`) first — the scheduled ingest bot commits on its own
   schedule and you don't want to clobber or conflict with it. If there's
   a conflict in `data.json`, resolve it the same way as any other merge
   (keep both sides' field additions; see git history around
   2026-10-16 for a worked example if you need one).
2. Ask which project this update is for — give the PM the project list
   from [reference.md](reference.md)'s "Known projects" table (these are
   the only valid `"Project"` values; typos won't resolve).
3. Ask "As of date" (default: today, `YYYY-MM-DD`).

## The interview

Ask in this order. For every field: if the PM says "no change" / "same as
last week" / skips it, just omit that key from `fields` entirely — leaving
a key out means "unchanged," which matches `apply_weekly_update()`'s own
blank-is-unchanged rule. Don't force them through fields that don't apply
(e.g. skip delay follow-ups entirely if delay is 0).

1. **PM name**, **Overall status** (Green/Amber/Red/Non-Recoverable).
   - If this is WORSE than their last known status (check `data.json`
     first), you MUST also ask **"Reason for status change"** — the
     script will refuse to apply a downgrade without one, same as the
     GitHub issue pipeline.
2. **Progress (0-100)**, **Delay (days)** (always ask this one — 0 if on
   schedule, stale delay values mislead the dashboard).
   - If delay > 0: ask **Delay note**, **Impact of delay**, **Mitigation
     steps taken** (one per line), **Trade-off conversations**.
   - If they mention pulling time back IN this week: ask **Time saved
     this week (days)** and **What did the team do to save that time?**
     (one per line, required if time saved > 0).
3. **Pipeline stage** (only if it changed) + if so, **planned start/
   completion dates** for that stage. **Delay log entries this week** —
   optional, one per line, `date | reason | team | person | days`.
4. **Current phase**, **Next milestone name/date**, **Go-live date**.
5. **Dependencies** — ask for every currently-open one (not just new
   ones), one per line, plus **owning team(s)**, **mitigation plan/
   impact**, **needed by date**, **priority**, **escalated to
   leadership?**, **resolved?** — same line order across all six.
   Omitting a previously-open dependency from this list marks it
   resolved. New mid-week dependencies just go in this same list.
6. **Risks / blockers** + **Risk mitigation plan**, same one-per-line/
   same-order rule as dependencies.
7. **Completed this week**, **In progress**, **Next plan** (one per
   line each — always ask these three).
8. **Fast-follow items**, **Reducing scope to hold the date?** (Yes/No),
   **Escalations to leadership this week** (blank = "nothing to
   escalate," which actively clears last week's list — don't skip this
   one just because it's often empty).
9. **Extended fields** (see [reference.md](reference.md) for exact JSON
   shapes) — ask briefly whether there's anything new/changed on:
   - Change Requests, Decisions, Go-Live Checklist items, RAID log
     entries, Features/sprint tracker rows, Milestones, or a narrative
     Delay Item Log entry. Skip any the PM has nothing for. For an
     EXISTING entry they want to update (e.g. "mark CR-104 approved"),
     include its `"id"` in the object — the script merges by id instead
     of creating a duplicate. New entries just omit `"id"`.

## Apply it

1. Write the accumulated `fields` dict to a temp JSON file.
2. Dry-run first: `python3 scripts/apply_weekly_update_direct.py --fields /tmp/fields.json --dry-run`
   — fix anything it flags (usually a missing status-change reason)
   before continuing.
3. Apply for real (same command without `--dry-run`).
4. Verify: confirm `data.json`/`history.json` are still valid JSON and
   `node --check app.js` still passes (it will — this script never
   touches `app.js`, this just confirms you didn't somehow break the
   working tree). If a verification harness exists in this session,
   re-run it.
5. Show the PM a short summary of what changed (the script already
   prints one).
6. Commit: `git add data.json history.json && git commit -m "Weekly update: <project> (<as-of date>)"`.
7. **Do not push to `main` without asking the PM first** — confirm
   explicitly, then push. If a push gets rejected (remote has new
   commits), `git fetch && git merge origin/main`, resolve any
   conflict, and retry — don't force-push.

## Repeat

A PM can run through the interview again for another project, or add a
follow-up entry to the same project (e.g. "actually also add a RAID
item") — just re-run steps above with a fresh `fields` file; existing
array entries are upserted by id, not duplicated.
