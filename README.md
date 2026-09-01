# BAPS NDC · Program Status

A single-page status dashboard for the BAPS NDC project portfolio, replacing the
weekly slide-deck review. Built as a static site — no backend, no build step —
so any PM can update it by editing one JSON file and pushing.

**Live site:** `https://pankaj117.github.io/baps-ndc-status/` (enabled via GitHub Pages on the `main` branch)

## Why this exists

The weekly 90-minute leadership review used a slide per project with wildly
inconsistent formats, no shared sense of "how far along is this really,"
and no single place to see dependencies/risks across the whole portfolio.
This dashboard gives every PM the same template and gives leadership one page
to scan instead of a 15-slide deck.

## Tab 1 — Program Status (live today)

- **Metrics row** — auto-computed rollup: on-track / at-risk / critical counts,
  average delay, total open risks.
- **Upcoming milestones** — every project's next milestone, sorted by date.
- **Go-live tracker** — every project with a scheduled go-live, sorted by
  date, showing the original planned date struck through next to the current
  date whenever it's slipped, plus a delay pill (green/amber/red by severity).
  Projects without a go-live yet are listed underneath as "not yet scheduled."
  Click any row to open that project's full detail view.
- **Project cards** — one per project: status, progress bar, phase, next
  milestone, go-live date, delay, and expandable dependencies / sprint status
  (completed, in progress, next plan) / risks. Every risk and dependency in
  the detail view is paired with its mitigation plan / impact, and any delay
  requires a stated impact — items missing one are flagged in amber so it's
  obvious what still needs to be filled in.
- Filter chips to narrow the card grid to on-track / at-risk / critical, plus
  a **PM filter dropdown** to show only one person's projects.

## Tab 2 — Week over Week (live)

Pick a project and see how it's actually moved: a progress-over-time bar
chart, a plain-English change log between consecutive weekly snapshots
(status/progress/delay/phase deltas), and the full feedback history for that
project (open + resolved). Snapshots come from `history.json`, one entry per
`asOf` date — re-ingesting the same week's issues updates that week's
snapshot rather than creating a duplicate.

## Tab 3 — Team Performance (skeleton only)

Placeholder tab for engineering execution metrics (PR velocity, review
turnaround, commit activity, deploy cadence) once we wire up GitHub data per
project repo. Nothing is connected yet — it's there so the layout and nav
don't need to change when that's ready.

## How PMs submit their weekly update

No more editing JSON by hand. Each PM opens a **GitHub Issue** using the
"Weekly Project Update" template — either from the repo's Issues tab, or by
clicking **"Submit weekly update"** on their project's card in the dashboard
(it opens the form pre-filled with the project name and today's `asOf`
date). Leave any field blank to keep last week's value for that field.

The moment the issue is opened, a bot comments with any **open follow-ups**
for that project from previous meetings (see below) — so the PM sees "hey,
Swami asked about hypercare tickets last week" before they even finish
filling out the form.

A scheduled GitHub Action (`.github/workflows/ingest.yml`, weekdays at noon
UTC — adjust the cron to your meeting cadence, or just run it manually from
the Actions tab) reads all open "weekly-update" issues, merges them into
`data.json`, snapshots the result into `history.json`, and **closes each
issue** with a confirmation comment. You can also trigger it on demand via
`workflow_dispatch` right before a meeting if someone submitted late.

## How live meeting feedback works

Click **"📝 Add feedback"** in the header (or "Add feedback" on a specific
project's card) to log something raised in the meeting — e.g. "Swami asked
where are the tickets for the hypercare project." That opens a small
in-dashboard form; submitting it opens a pre-filled GitHub issue
("Meeting Feedback / Takeaway" template) for you to send — no backend, no
login for the dashboard itself, just a one-click handoff to GitHub.

The same scheduled Action ingests open "feedback" issues into `notes.json`
as **open follow-ups**, tied to a project. They show up as a badge on that
project's card, in the Week-over-Week feedback history, and — most
importantly — as a reminder comment the next time that PM opens a weekly
update issue for the same project. Once ingested, the follow-up issue is
closed automatically; it stays "open" in `notes.json` until someone flips
it to `"status": "resolved"` (currently a manual edit — see Roadmap).

**Note:** this means every PM (and anyone logging feedback) needs a GitHub
account with access to open issues on this repo. That's the trade-off for
zero custom backend/hosting.

## Data model

Everything lives in three files:

- **`data.json`** — current live state, one object per project in the
  `projects` array.
- **`history.json`** — one snapshot per `asOf` date, keyed by date, used by
  the Week-over-Week tab.
- **`notes.json`** — flat array of feedback/follow-up entries, each tied to
  a `projectId`, with `status: "open" | "resolved"`.

`data.json` project shape:

```json
{
  "id": "webnext",
  "name": "WebNext",
  "owner": "Jeet Savani",
  "status": "green",        // "green" | "amber" | "red"
  "progress": 80,             // 0-100, your best call on % complete
  "phase": "Requirements Finalization",
  "nextMilestone": { "name": "Requirements Finalization", "date": "2026-08-21" },
  "goLive": "2026-09-25",     // current planned go-live, or null if not yet set
  "originalGoLive": "2026-09-21", // baseline date, set once and preserved across
                                   // slips so the go-live tracker can show the delta
  "delayDays": 0,              // 0 if on schedule, positive integer if late
  "delayNote": "No delay reported",
  "delayImpact": "",           // required in the form whenever delayDays > 0
  "dependencies": ["..."],
  "dependencyMitigations": ["..."], // same length/order as dependencies — plan + impact for each
  "sprintStatus": {
    "completed": ["..."],
    "inProgress": ["..."],
    "nextPlan": ["..."]
  },
  "risks": ["..."],
  "riskMitigations": ["..."]   // same length/order as risks — mitigation plan + impact for each
}
```

Risks and dependencies are tracked as **parallel arrays**: `risks[i]` pairs
with `riskMitigations[i]`, `dependencies[i]` pairs with
`dependencyMitigations[i]`. The weekly-update issue form asks for both lists
in the same order so PMs can just add a matching line. The dashboard flags
any risk, dependency, or delay that's missing its mitigation/impact in amber
so it's visible at a glance who still needs to fill it in. Meeting feedback
issues also carry an optional `mitigationImpact` field for when leadership
flags a risk/dependency live in the meeting.

`originalGoLive` is system-managed: `scripts/ingest.py` sets it the first time
a PM submits a go-live date for a project and never overwrites it after that,
so it always reflects the original baseline even as `goLive` moves.

Adding a brand-new project: add a matching option to the `project` dropdown
in both `.github/ISSUE_TEMPLATE/*.yml` files, add the id/name mapping in
`scripts/lib.py`'s `PROJECT_NAME_TO_ID`, and add the initial project object
to `data.json`. Retiring one: reverse of the above (or just leave it in
`data.json` with no further updates — it'll simply stop moving in the
Week-over-Week view).

## Local preview

```bash
python3 -m http.server 8765
# open http://localhost:8765
```

## Stack

Plain HTML/CSS/JS, no framework, no build step — fast to load, trivial to
host on GitHub Pages, and easy for any PM to edit `data.json` without touching
the app code.

## Roadmap

- [ ] Wire Tab 3 up to real GitHub data (PRs, reviews, commits, deploys) per
      project repo.
- [ ] Add a "resolve" action for follow-ups (currently a manual edit to
      `notes.json` — flip `"status": "open"` to `"resolved"`).
- [ ] Consider a GitHub Action that auto-resolves a follow-up when the next
      weekly update for that project explicitly references it.
