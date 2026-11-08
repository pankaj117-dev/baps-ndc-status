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

The interview below is grouped by **which tab/view each answer drives** —
say the section name out loud as you move into it (e.g. "Now the stuff
that drives the Grid and Hawk-eye tabs...") so the PM always knows what's
in scope and nothing gets silently skipped. Before you apply anything, you
read the whole batch back to the PM for a sanity check — see "Confirm
before applying."

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
4. Ask one triage question before diving into the regular fields:
   **"Anything this week beyond the normal numbers — a new parallel
   track, a second milestone line running alongside the current stage,
   or something structural like that?"** If no, move straight to the
   interview below. If yes, read "When to bail to free-form" next —
   handle that part first (or last; your call), then run the rest of
   this interview normally for whatever ordinary fields remain.

## When to bail to free-form instead of this script

`scripts/apply_weekly_update_direct.py`'s "Pipeline stage" field can only
carry **one active stage per project at a time** — it keys `stagePlan` by
`current_stage` and only ever writes that one entry (see `reference.md`'s
"Current stage — planned start/completion date" row). It cannot express:

- **A second, parallel stage-gate track running alongside the current
  one.** MyBKY (Phase 1) is the live example in `data.json`: its
  `stagePlan` carries the normal pipeline (`Requirements` → `Rollout`)
  AND a second "2B" track (`TDD 2B`, `Dev 2B`, `UAT 2B`, `VAPT 2B`,
  `Go-Live 2B`, its own tail `Hypercare`), wired up in `stageDateOrder`
  with custom `label`s. That shape only comes from hand-editing
  `data.json`, never from the script.
- **Correcting a stage OTHER than the current one.** The script only
  ever touches `stagePlan[current_stage]` — if a PM needs to fix a past
  or future stage's dates without changing which stage is current, that's
  also a direct `data.json` edit.
- **Reordering, renaming, or restructuring the stage-gate pipeline
  itself** for a project.

This is NOT the same as adding a plain, one-off entry to the `Milestones`
extended field (see below) — a standalone named milestone with its own
date/status/progress goes through the script fine, same as any other
extended field. The bail-out is specifically for a second **stage-gate
track** with its own sequence of stages and dates.

If the PM describes one of the bulleted cases above, say so plainly, e.g.:

> "That's a parallel stage track, not a single current-stage update — I'll
> edit `data.json`'s `stagePlan`/`stageDateOrder` directly in chat instead
> of running the script, so it doesn't fight the one-stage-at-a-time
> logic. Tell me the stage names, their labels, and the planned
> start/end dates you want for each, and which existing stage(s) they run
> alongside."

Then hand-edit `data.json`, using MyBKY (Phase 1)'s `stagePlan` +
`stageDateOrder` as the shape to copy. The usual hygiene still applies —
valid JSON, `node --check app.js` unaffected, commit with a clear message,
confirm before pushing — you just skip `apply_weekly_update_direct.py`
for that part. Ordinary stage progress (the project moved from
Development to UAT, a date slipped) is NOT this — that's the normal
"Pipeline stage" question in Section B below.

## The interview

For every field: if the PM says "no change" / "same as last week" /
skips it, just omit that key from `fields` entirely — leaving a key out
means "unchanged," which matches `apply_weekly_update()`'s own
blank-is-unchanged rule. Don't force them through fields that don't apply
(e.g. skip delay follow-ups entirely if delay is 0).

### Section A — Status card (Program Status tab, the project's "icon")

Everything here drives the project card's pill, progress bar, and badges
on the Program Status tab.

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
3. **Current phase**, **Next milestone name/date**, **Go-live date**.
4. **Fast-follow items**, **Reducing scope to hold the date?** (Yes/No),
   **Escalations to leadership this week** (blank = "nothing to
   escalate," which actively clears last week's list — don't skip this
   one just because it's often empty).

### Section B — Grid & Hawk-eye (stage/schedule tabs)

Everything here drives the Project × Stage grid and the Hawk-eye
roadmap/timeline — both read the same `stage` + `stagePlan` data.

5. **Pipeline stage** (only if it changed this week) + if so, **planned
   start/completion dates** for that stage (`Current stage — planned
   start date`, `Current stage — planned completion date`). These key
   into `stagePlan[stage]` — first value recorded locks the baseline
   (`initialStart`/`initialEnd`), later updates move `latestStart`/
   `latestEnd`, which is what the Grid/Hawk-eye "running past its plan"
   coloring and revision history are built from. Get these right; see
   "Confirm before applying" below.
6. **Delay log entries this week** — optional, one per line,
   `date | reason | team | person | days`.
   - If the PM wants to correct a stage that ISN'T the current one (a
     past stage's dates were wrong, or a future stage's plan moved),
     that's a direct `data.json` edit — see "When to bail to free-form."

### Section C — Dependencies tab

7. **Dependencies** — ask for every currently-open one (not just new
   ones), one per line, plus **owning team(s)**, **mitigation plan/
   impact**, **needed by date**, **priority**, **escalated to
   leadership?**, **resolved?** — same line order across all six.
   Omitting a previously-open dependency from this list marks it
   resolved. New mid-week dependencies just go in this same list.

### Section D — Everything else (sprint status, risks, extended fields)

8. **Risks / blockers** + **Risk mitigation plan**, same one-per-line/
   same-order rule as dependencies.
9. **Completed this week**, **In progress**, **Next plan** (one per
   line each — always ask these three).
10. **Extended fields** (see [reference.md](reference.md) for exact JSON
    shapes) — ask briefly whether there's anything new/changed on:
    - Change Requests, Decisions, Go-Live Checklist items, RAID log
      entries, Features/sprint tracker rows, Milestones, or a narrative
      Delay Item Log entry. Skip any the PM has nothing for. For an
      EXISTING entry they want to update (e.g. "mark CR-104 approved"),
      include its `"id"` in the object — the script merges by id instead
      of creating a duplicate. New entries just omit `"id"`.
    - A plain, one-off `Milestones` entry (name/date/status/progress) is
      fine here through the script — it's only a second STAGE-GATE TRACK
      (Section B's bail-out case) that isn't.

## Confirm before applying

Before writing the temp JSON file, read the PM back a compact recap of
every field you're about to change, grouped by the same A/B/C/D sections
above, e.g.:

> "Here's what I've got for WebNext, as of 2026-11-09 — confirm or correct
> anything before I apply it:
> **A (status card):** Green → Amber (reason: mobile dev slipped),
> progress 55% → 62%, delay 0 → +3d, next milestone UAT 11/18, go-live
> unchanged.
> **B (grid/hawk-eye):** stage unchanged (still Development).
> **C (dependencies):** 1 open — 'GMS load testing API timeout,' owner
> GMS team, needed by 11/12, High priority, not escalated.
> **D (other):** 2 risks, sprint status updated, no extended fields this
> week."

Explicitly call out anything you're leaving unchanged so the PM has a
chance to say "actually that moved too" — the goal is that every data
point on the dashboard that's supposed to reflect this week is accurate,
not just the ones the PM happened to think to mention. Only move to
"Apply it" once they confirm.

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
