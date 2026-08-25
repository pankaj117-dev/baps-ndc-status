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
- **Project cards** — one per project: status, progress bar, phase, next
  milestone, go-live date, delay, and expandable dependencies / sprint status
  (completed, in progress, next plan) / risks.
- Filter chips to narrow the card grid to on-track / at-risk / critical.

## Tab 2 — Team Performance (skeleton only)

Placeholder tab for engineering execution metrics (PR velocity, review
turnaround, commit activity, deploy cadence) once we wire up GitHub data per
project repo. Nothing is connected yet — it's there so the layout and nav
don't need to change when that's ready.

## How PMs update this weekly

Everything lives in **`data.json`**. Each project is one object in the
`projects` array:

```json
{
  "id": "webnext",
  "name": "WebNext",
  "owner": "Jeet Savani",
  "status": "green",        // "green" | "amber" | "red"
  "progress": 80,             // 0-100, your best call on % complete
  "phase": "Requirements Finalization",
  "nextMilestone": { "name": "Requirements Finalization", "date": "2026-08-21" },
  "goLive": "2026-09-25",     // or null if not yet set
  "delayDays": 0,              // 0 if on schedule, positive integer if late
  "delayNote": "No delay reported",
  "dependencies": ["..."],
  "sprintStatus": {
    "completed": ["..."],
    "inProgress": ["..."],
    "nextPlan": ["..."]
  },
  "risks": ["..."]
}
```

Weekly update flow:

1. Edit your project's block in `data.json` (and bump `asOf` /
   `lastUpdated` at the top of the file).
2. Commit and push to `main` — GitHub Pages redeploys automatically in
   under a minute.
3. Add a new project object to the array to onboard a new project; delete
   the object (or set `status`/notes) to retire one — no code changes needed.

To avoid PMs stepping on each other's edits in the same file, keep your diffs
scoped to your own project's object, and pull before you edit.

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

- [ ] Wire Tab 2 up to real GitHub data (PRs, reviews, commits, deploys) per
      project repo.
- [ ] Optional: swap manual `data.json` edits for a lightweight form that
      writes the JSON via a GitHub Action, once the team outgrows direct edits.
