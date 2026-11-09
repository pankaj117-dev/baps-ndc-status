(function () {
  "use strict";

  const REPO = "pankaj117-dev/baps-ndc-status";
  const STATUS_LABEL = { green: "On Track", amber: "At Risk", red: "Critical", black: "Non-Recoverable" };
  const STATUS_RANK = { green: 0, amber: 1, red: 2, black: 3 };

  // Display color/label is driven by the project's actual schedule delay
  // (p.delayDays), not the PM's free-text status field, so the dashboard
  // reflects real on-schedule/at-risk/critical state consistently
  // everywhere (2026-10-06): on schedule (<=0d) -> green, 1-10d late ->
  // amber, 10+d late -> red. "black" (Non-Recoverable) is a distinct
  // manual call that isn't about schedule delay, so it's preserved as-is.
  function effectiveStatus(p) {
    if (p.status === "black") return "black";
    // A project can set `usePmStatus: true` (2026-11-04, myBKY 2A) to show
    // the status its PM reported instead of the delay-days rule below.
    // Weekly snapshots don't carry the flag, so look it up on the project.
    const owner = p.usePmStatus != null ? p : DATA && (DATA.projects || []).find((x) => x.id === p.id);
    if (owner && owner.usePmStatus && p.status) return p.status;
    const d = p.delayDays || 0;
    if (d > 10) return "red";
    if (d > 0) return "amber";
    return "green";
  }

  let DATA = null;
  let HISTORY = {};
  let NOTES = [];

  // Resolving a follow-up on the dashboard is instant (no GitHub round trip) —
  // it's tracked as a locally-resolved override in this browser's
  // localStorage. The underlying note is never touched/deleted; it still
  // exists exactly as-is in notes.json/git. When you're ready to make the
  // resolution permanent (so it also shows resolved for everyone else / in
  // git history), use the "Sync to GitHub ↗" link that appears once
  // something's been resolved locally.
  const LOCAL_RESOLVED_KEY = "baps-ndc-status:locally-resolved";

  function loadLocalResolved() {
    try {
      return new Set(JSON.parse(localStorage.getItem(LOCAL_RESOLVED_KEY) || "[]"));
    } catch (e) {
      return new Set();
    }
  }

  function saveLocalResolved(set) {
    try {
      localStorage.setItem(LOCAL_RESOLVED_KEY, JSON.stringify(Array.from(set)));
    } catch (e) {
      /* localStorage unavailable — resolve still works for this page view */
    }
  }

  let LOCAL_RESOLVED = loadLocalResolved();

  function isLocallyResolved(noteId) {
    return LOCAL_RESOLVED.has(noteId);
  }

  function setLocallyResolved(noteId, resolved) {
    if (resolved) LOCAL_RESOLVED.add(noteId);
    else LOCAL_RESOLVED.delete(noteId);
    saveLocalResolved(LOCAL_RESOLVED);
  }

  // A note's effective status, folding in any local-only resolve/undo.
  function noteStatus(note) {
    if (note.status === "resolved") return "resolved";
    return isLocallyResolved(note.id) ? "resolved" : "open";
  }
  let activeFilter = "all";
  let activeOwner = "all";
  let globalProjectFilter = "all";
  let globalTeamFilter = "all";
  let activeTab = "status";
  let depsPivotGroupBy = "project"; // "project" | "team" — which rollup the Dependencies tab shows first
  let depsPivotCompact = false;
  let depsCycleFilter = "all"; // calendar year string from dueBy, e.g. "2026"
  let lastDepsPivotExport = null;
  // Hawk-eye projects opened into their own fitted timeline. Starts
  // collapsed; a choice made this session is remembered in this browser.
  const HAWKEYE_EXPANDED_KEY = "baps-ndc-hawkeye-expanded";
  const hawkeyeExpanded = new Set();
  try {
    localStorage.removeItem(HAWKEYE_EXPANDED_KEY);
  } catch (e) {
    /* ignore */
  }
  let hawkeyeRestoreScrollLeft = null;
  let hawkeyeRestoreWindowY = null;
  function saveHawkeyeExpanded() {
    try {
      localStorage.setItem(HAWKEYE_EXPANDED_KEY, JSON.stringify([...hawkeyeExpanded]));
    } catch (e) {
      /* ignore */
    }
  }

  // Projects flagged `hidden: true` in data.json are kept in the underlying
  // data (nothing's deleted) but excluded from every view/filter/dropdown —
  // used for projects that don't have their own status section in the
  // current weekly deck anymore, without losing their historical record.
  function activeProjects() {
    return DATA.projects.filter((p) => !p.hidden);
  }

  function visibleProjects() {
    let projects = activeProjects();
    if (globalProjectFilter !== "all") {
      projects = projects.filter((p) => p.id === globalProjectFilter);
    }
    if (activeOwner !== "all") {
      projects = projects.filter((p) => (p.owner || "Unassigned") === activeOwner);
    }
    // The team dropdown only exists on Dependencies, so it only narrows
    // that tab. Project and PM still apply everywhere.
    if (activeTab === "deps" && globalTeamFilter !== "all") {
      projects = projects.filter((p) =>
        getDependencyObjects(p).some((d) => !d.resolved && d.team === globalTeamFilter)
      );
    }
    return projects;
  }

  function fmtDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  function fmtDateShort(iso) {
    if (!iso) return "—";
    const d = new Date(iso + "T00:00:00");
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  // Numeric "M/D" — tight enough to sit inside a small Roadmap/Timeline
  // chip alongside the stage code (2026-11-05: "dates present for teams
  // ... make it in small but show up").
  function fmtDateTiny(iso) {
    if (!iso) return "";
    const d = new Date(iso + "T00:00:00");
    return (d.getMonth() + 1) + "/" + d.getDate();
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach((k) => {
        if (k === "class") node.className = attrs[k];
        else if (k === "html") node.innerHTML = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach((c) => {
      if (c) node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return node;
  }

  function openNotesFor(projectId) {
    return NOTES.filter((n) => n.projectId === projectId && noteStatus(n) === "open");
  }

  // The target completion date for a project's CURRENT canonical pipeline
  // stage — the "next due target" for whatever it's actively working on
  // right now, distinct from the overall project's Go-Live/Next Milestone
  // (which can be much further out). Prefers the latest (revised) date,
  // falling back to the original plan if nothing's slipped. Returns null
  // when there's no stagePlan entry for the current stage (most projects
  // don't have this backfilled — the fact row just omits the date then).
  // The full Current Stage / Next Milestone / Go-Live / Delay (/ Impact of
  // delay / Time saved) fact list — originally only rendered once, inline,
  // at the top of the project detail view. Extracted into its own function
  // (2026-10-16) so the Weekly Status Report widget's Progress row can
  // reuse the exact same facts instead of just a bar + percentage ("I want
  // to see the full progress of how I see the weekly here").
  // "On schedule" / "+N days", plus an optional per-project qualifier
  // (p.scheduleScope, e.g. "hotfix") so a project in Hypercare can say
  // what the schedule status is actually tracking.
  function scheduleStatusText(p) {
    const base = (p.delayDays || 0) > 0 ? "+" + p.delayDays + " days" : "On schedule";
    return p.scheduleScope ? base + " (" + p.scheduleScope + ")" : base;
  }

  function buildProgressFactsList(p) {
    const isLate = p.delayDays > 0;
    return el("dl", { class: "card-facts detail-facts" }, [
      ...currentStageFactNodes(p),
      // Go-Live lives in this top box (2026-11-04, "the go live should be
      // in the top box"); the next milestone is listed under the
      // Milestones heading below instead. Single date only — the history
      // of how it moved is already in the Date change log / Status History
      // tab. `originalGoLive` stays in data.json untouched.
      el("dt", null, ["Go-live"]),
      el("dd", null, [fmtDate(p.goLive)]),
      el("dt", null, ["Status"]),
      el("dd", { class: "delay-flag " + (isLate ? "is-late" : "is-ontime") }, [
        scheduleStatusText(p),
      ]),
      // Open-item counts (2026-11-04, "this is what I want to see in the
      // second image section") — the same four badges the project card
      // shows (dependencies / risks / follow-ups / CRs), repeated here in
      // the detail view's progress facts so they're visible without going
      // back to the card. Total logged counts, not just open ones — a
      // resolved dependency is still a dependency — colored green/amber/red
      // by how many are resolved, and each one jumps to its source tab
      // (2026-11-04, "why are the risk and dependencies not showing up" /
      // "all the button should link to the icon when clicked").
      el("dt", null, ["Open items"]),
      el("dd", null, [
        el("span", { class: "facts-counts" }, [
          openItemBadge(dependencyCounts(p), "dependency", "dependencies", "detail-deps-section"),
          openItemBadge(riskCounts(p), "risk", "risks", "detail-risks-section"),
          openItemBadge(followupCounts(p), "follow-up", "follow-ups", "detail-followups-section"),
          changeRequestBadge(p),
        ]),
      ]),
      ...(isLate
        ? [
            el("dt", null, ["Impact of delay"]),
            el("dd", { class: p.delayImpact ? "" : "is-missing" }, [
              p.delayImpact || "Not yet documented",
            ]),
          ]
        : []),
      ...((p.timeSavedDays || 0) > 0
        ? [
            el("dt", null, ["Time saved"]),
            el("dd", { class: "delay-flag is-saved" }, ["-" + p.timeSavedDays + " days"]),
          ]
        : []),
    ]);
  }

  function currentStageTargetDate(p) {
    const stage = p.stage;
    const plan = stage && p.stagePlan && p.stagePlan[stage];
    if (!plan) return null;
    return plan.latestEnd || plan.initialEnd || null;
  }

  // Replaces the old free-text-only "Phase" fact with the actual current
  // state (the canonical pipeline Stage, same value driving the Grid /
  // Hawk-eye / Stage-gate timeline tabs) plus its own next due target date
  // — rather than a vague sub-activity description with no date attached.
  // The original free-text `phase` (when present) is kept as a secondary
  // detail line since it often carries useful specifics (e.g. "Regression
  // / Performance / Security / UAT") the canonical stage name alone loses.
  function currentStageFactNodes(p) {
    const stage = p.stage || "Unstaged";
    const targetDate = currentStageTargetDate(p);
    return [
      el("dt", null, ["Current Stage"]),
      el("dd", { class: "phase-fact" }, [
        el(
          "div",
          { class: "phase-fact-stage" },
          [
            stage,
            targetDate ? el("span", { class: "phase-fact-target" }, [" — target " + fmtDateShort(targetDate)]) : null,
          ].filter(Boolean)
        ),
        p.phase ? el("div", { class: "phase-fact-detail", title: p.phase }, [p.phase]) : null,
      ].filter(Boolean)),
    ];
  }

  function todayISO() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function issueUrl(template, params) {
    const base = `https://github.com/${REPO}/issues/new`;
    const search = new URLSearchParams({ template, ...params });
    return `${base}?${search.toString()}`;
  }

  // "Resolve" is instant and local — no GitHub tab, no form. The note itself
  // is left completely as-is in notes.json; this just remembers (in this
  // browser's localStorage) that it should be treated as resolved. Use the
  // "Sync to GitHub ↗" link (only shown once something's resolved locally)
  // when you want that to become permanent / visible to everyone else — that
  // opens a pre-filled "resolve-feedback" issue that the bot uses to flip
  // notes.json's real status, so it's still fully preserved in git.
  function resolveUrl(note, projectName) {
    return issueUrl("resolve-feedback.yml", {
      note_id: note.id || "",
      project: projectName || "",
      summary: (note.text || "").slice(0, 120),
    });
  }

  function resolveLink(note, projectName) {
    const wrap = el("span", { class: "resolve-actions" });

    const resolveBtn = el(
      "button",
      { type: "button", class: "resolve-link", title: "Close this out — no GitHub needed, just hides it here" },
      ["✓ Resolve"]
    );
    resolveBtn.addEventListener("click", () => {
      setLocallyResolved(note.id, true);
      refreshProjectViews(note.projectId);
    });
    wrap.appendChild(resolveBtn);

    return wrap;
  }

  // Shown next to already-resolved (locally) notes in the full feedback
  // history: an "Undo" in case it was closed by mistake, and a "Sync to
  // GitHub" for making the resolution permanent in notes.json/git.
  function resolvedActions(note, projectName) {
    const wrap = el("span", { class: "resolve-actions" });

    const undoBtn = el(
      "button",
      { type: "button", class: "resolve-link is-undo", title: "Put this back in the open list" },
      ["↺ Undo"]
    );
    undoBtn.addEventListener("click", () => {
      setLocallyResolved(note.id, false);
      refreshProjectViews(note.projectId);
    });
    wrap.appendChild(undoBtn);

    wrap.appendChild(
      el(
        "a",
        {
          class: "resolve-link is-sync",
          target: "_blank",
          rel: "noopener",
          title: "Make this resolution permanent in notes.json/git (visible to everyone, not just this browser)",
          href: resolveUrl(note, projectName),
        },
        ["Sync to GitHub ↗"]
      )
    );

    return wrap;
  }

  // Re-render whatever's currently on screen after a resolve/undo so the
  // change shows up immediately without a full page reload.
  function refreshProjectViews(projectId) {
    renderMetrics();
    renderCards();
    const overlay = document.getElementById("projectDetail");
    if (!overlay.hidden) {
      const project = DATA.projects.find((p) => p.id === projectId);
      if (project) {
        const content = document.getElementById("detailContent");
        const scrollTop = overlay.scrollTop;
        content.innerHTML = "";
        content.appendChild(buildProjectDetail(project));
        overlay.scrollTop = scrollTop;
      }
    }
  }

  /* ---------------- Header ---------------- */

  function renderHeader() {
    document.getElementById("asOf").textContent = "As of " + fmtDate(DATA.asOf);
    const d = new Date(DATA.lastUpdated);
    document.getElementById("lastUpdated").textContent =
      "Data last updated " + d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  }

  /* ---------------- Tab 1: Program Status ---------------- */

  function renderMetrics() {
    const projects = visibleProjects();
    const counts = { green: 0, amber: 0, red: 0, black: 0 };
    let delaySum = 0;
    let riskCount = 0;
    projects.forEach((p) => {
      counts[effectiveStatus(p)] = (counts[effectiveStatus(p)] || 0) + 1;
      delaySum += p.delayDays || 0;
      riskCount += countOpenRisks(p);
    });
    const avgDelay = projects.length ? Math.round((delaySum / projects.length) * 10) / 10 : 0;

    const metrics = [
      { label: "Total Projects", num: projects.length, tone: "", filter: "all" },
      { label: "On Track", num: counts.green, tone: "tone-green", filter: "green" },
      { label: "At Risk", num: counts.amber, tone: "tone-amber", filter: "amber" },
      { label: "Critical", num: counts.red, tone: "tone-red", filter: "red" },
    ];
    if (counts.black) metrics.push({ label: "Non-Recoverable", num: counts.black, tone: "tone-black", filter: "black" });
    metrics.push(
      { label: "Avg Delay (days)", num: avgDelay, tone: "tone-accent" },
      { label: "Open Follow-ups", num: NOTES.filter((n) => noteStatus(n) === "open").length, tone: "tone-accent" }
    );

    const row = document.getElementById("metricsRow");
    row.innerHTML = "";
    metrics.forEach((m) => {
      const isClickable = !!m.filter;
      const classes = [
        "metric-card",
        m.tone,
        isClickable ? "is-clickable" : "",
        isClickable && activeFilter === m.filter ? "is-active" : "",
      ]
        .filter(Boolean)
        .join(" ");
      const card = el(
        "div",
        isClickable
          ? { class: classes, "data-filter": m.filter, tabindex: "0", role: "button", title: "Filter projects by " + m.label }
          : { class: classes },
        [
          el("div", { class: "num" }, [String(m.num)]),
          el("div", { class: "label" }, [m.label]),
        ]
      );
      row.appendChild(card);
    });

    row.querySelectorAll(".metric-card.is-clickable").forEach((card) => {
      const applyFilter = () => {
        activeFilter = card.getAttribute("data-filter");
        renderMetrics();
        renderCards();
      };
      card.addEventListener("click", applyFilter);
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          applyFilter();
        }
      });
    });
  }

  const tabIcon = (paths) =>
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + "</svg>";
  const DETAIL_TAB_ICONS = {
    gauge: tabIcon('<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/><circle cx="12" cy="14" r="1.5"/>'),
    clock: tabIcon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    trend: tabIcon('<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>'),
    swap: tabIcon('<path d="M7 4L3 8l4 4"/><path d="M3 8h14"/><path d="M17 20l4-4-4-4"/><path d="M21 16H7"/>'),
    alert: tabIcon('<path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    sparkle: tabIcon('<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 17v4"/><path d="M17 19h4"/>'),
    check: tabIcon('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M8 2v4"/><path d="M16 2v4"/><path d="M8 13l3 3 5-6"/>'),
    chat: tabIcon('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/>'),
    steps: tabIcon('<path d="M4 6h6"/><path d="M8 12h8"/><path d="M12 18h8"/>'),
  };

  const PIPELINE_STAGES = [
    "Proposal",
    "Requirements",
    "Tech. Design",
    "Estimate & Planning",
    "Development",
    "UAT",
    "VAPT",
    "Rollout",
    "Hypercare",
  ];

  // Short column headers for the Grid tab — same stages, tighter labels so
  // 9 columns + the project name column fit without too much horizontal
  // scroll.
  const STAGE_GRID_SHORT = {
    "Proposal": "Proposal",
    "Requirements": "Requirements",
    "Tech. Design": "Tech. Design",
    "Estimate & Planning": "Estimate & Planning",
    "Development": "Development",
    "UAT": "UAT",
    "VAPT": "VAPT",
    "Rollout": "Rollout",
    "Hypercare": "Hypercare",
  };

  // "Who leads each stage" (RACI reference) and the "Go-Live readiness"
  // checklist were removed from the Stage-gate tab, all projects, on
  // 2026-11-04 per explicit request ("remove these for all projects") —
  // both were static/fixed-playbook content (RACI_STAGES,
  // GOLIVE_CHECKLIST_ITEMS), not project-specific data, so nothing in
  // data.json needed to change. `buildRaciReference()`/
  // `buildGoLiveChecklist()` and their constants were deleted outright
  // (not just unwired) since nothing else called them. `p.goLiveChecklist`
  // stays in data.json/README unused, same precedent as `features`/
  // `milestones` elsewhere in this file, in case it's revived later.

  // "Five logs every project maintains" (slide 15) banner — REMOVED
  // 2026-10-16. It used to sit above the Change & Decisions and Delay
  // tabs' content as a 5-icon strip (Change/Delay/Decision/Risk/Issue
  // log, each clickable when the project had entries) jumping to that
  // log's section. Once the whole 9-tab accordion became a horizontal
  // icon-tile strip (same day) covering ALL of Schedule/Delay/
  // Week-over-week/Stage-gate/Change & Decisions/Features/Dependencies &
  // Risks/Follow-ups/Feedback up top, every single icon in this banner
  // became a duplicate of a tile already in that strip — Change log and
  // Decision log duplicated the very "Change & Decisions" tile this
  // banner lived inside, Risk log and Issue log duplicated "Dependencies
  // & Risks," Delay log duplicated "Delay." A user flagged this
  // explicitly ("the icon below takes them to risks again - don't need
  // duplicates") and the banner (`buildFiveLogsBanner()`, `FIVE_LOGS`)
  // was deleted outright, along with its `.five-logs-*` CSS and its two
  // call sites in `changeDecisionsPanel`/`delayPanel`.

  function renderStageGridLegend() {
    const box = document.getElementById("stageGridLegend");
    if (!box) return;
    box.innerHTML = "";
    // SLA-vs-generic-threshold judgments removed (2026-10-05) — comparing
    // a project's real stage duration against one flat SLA constant per
    // stage name was flagging giant-but-on-plan projects as wildly "over
    // SLA" when they weren't actually delayed against their own approved
    // plan at all (see the project-level `delayDays`/Go-Live slip for the
    // real, meaningful delay number). "Current stage" color (2026-10-06)
    // is now yellow by default ("in progress") and only turns red when
    // THAT stage has run past its own committed stagePlan end date — see
    // currentStageOverdue() — not a flat SLA and not just "is the whole
    // project red."
    [
      { cls: "is-done", label: "Done" },
      { cls: "is-current is-warn", label: "Current stage — in progress" },
      { cls: "is-current is-breach", label: "Current stage — past planned end date" },
      { cls: "is-none", label: "Not reached yet" },
    ].forEach((it) => {
      box.appendChild(
        el("span", { class: "stage-grid-legend-item" }, [
          el("span", { class: "stage-grid-swatch " + it.cls }),
          it.label,
        ])
      );
    });
    // Per-stage delay chips (2026-11-04) — each cell's own real duration
    // vs THIS project's own stagePlan dates for that stage, see
    // stagePlanDelayDays(). Red = ran longer than its own plan. Green =
    // wrapped up ahead of its own plan ("pulled up"). Shown inside the
    // cell, separate from the done/current/breach coloring above.
    [
      { cls: "stage-grid-delay is-over", label: "Over its own plan for that stage" },
      { cls: "stage-grid-delay is-early", label: "Ahead of its own plan (pulled up)" },
    ].forEach((it) => {
      box.appendChild(
        el("span", { class: "stage-grid-legend-item" }, [
          el("span", { class: it.cls + " stage-grid-legend-chip" }, ["+Nd"]),
          it.label,
        ])
      );
    });
  }

  // KPI strip above the grid — portfolio-wide stage-gate health at a glance,
  // reusing the same .metric-card look as the Program Status tab's metrics
  // row. All numbers respect the global Project/PM/Team filters.
  function renderStageGridMetrics() {
    const row = document.getElementById("stageGridMetrics");
    if (!row) return;
    row.innerHTML = "";

    const projects = visibleProjects();
    const pmCount = new Set(projects.map((p) => p.owner || "Unassigned")).size;

    // Delay-based, not SLA-based (2026-10-05) — "Stages Over SLA" and
    // "Cumulative SLA Overage" used to compare each stage's real duration
    // against a flat generic constant per stage name, which flagged
    // large-but-on-plan projects as wildly delayed when they weren't.
    // These now use the same `delayDays` every other view in the app
    // already treats as the real, meaningful delay — overall slip against
    // the committed go-live date.
    let delayedCount = 0;
    let hypercareCount = 0;
    let cumulativeDelay = 0;

        projects.forEach((p) => {
      cumulativeDelay += p.delayDays || 0;
      if ((p.delayDays || 0) > 0) delayedCount += 1;
      if ((p.stage || "") === "Hypercare") hypercareCount += 1;
    });

    const metrics = [
      { label: "Active Projects", num: projects.length, sub: `across ${pmCount} PM${pmCount === 1 ? "" : "s"}`, tone: "" },
      { label: "Projects Delayed", num: delayedCount, sub: delayedCount ? "vs. committed go-live" : "none right now", tone: delayedCount ? "tone-red" : "tone-green" },
      { label: "Cumulative Delay", num: cumulativeDelay + "d", sub: "summed across every project", tone: cumulativeDelay ? "tone-amber" : "tone-green" },
      { label: "In Hypercare", num: hypercareCount, sub: "live, post go-live", tone: "tone-accent" },
    ];

    metrics.forEach((m) => {
      row.appendChild(
        el("div", { class: ["metric-card", m.tone].filter(Boolean).join(" ") }, [
          el("div", { class: "num" }, [String(m.num)]),
          el("div", { class: "label" }, [m.label]),
          el("div", { class: "stage-grid-metric-sub" }, [m.sub]),
        ])
      );
    });
  }

  // Donut breakdown of the "Cumulative Delay" KPI above — same per-project
  // total (`delayDays`, the real slip against each project's committed
  // go-live — 2026-10-05, replacing a per-stage SLA-overage sum that
  // could flag a large-but-on-plan project as wildly delayed), just
  // showing WHICH projects are contributing to it instead of one summed
  // number. Reuses buildDonutChart() (defined below, near the stage
  // detail modal's own Delay Analysis donuts) so both views render
  // identically. Clicking a legend row jumps straight to that project's
  // Stage-gate timeline — same click-through the Hawk-eye rows and
  // cumulative-delay card badges already use.
  function renderCumulativeDelayChart() {
    const box = document.getElementById("cumulativeDelayChart");
    if (!box) return;
    box.innerHTML = "";

    const projects = visibleProjects();
    const projectGroups = projects
      .map((p) => ({ label: p.name, days: p.delayDays || 0, id: p.id }))
      .filter((g) => g.days > 0)
      .sort((a, b) => b.days - a.days)
      .map((g, i) => ({ ...g, color: BREAKDOWN_COLORS[i % BREAKDOWN_COLORS.length] }));

    if (!projectGroups.length) {
      box.appendChild(
        el("div", { class: "cumdelay-card cumdelay-empty" }, [
          "No project delays right now across the filtered projects. 🎉",
        ])
      );
      return;
    }

    // Three genuinely different numbers, not three cuts of the same one
    // (2026-10-06) — ring 1 is cumulative delay by project (as before);
    // ring 2 is a completely different metric, total real elapsed days
    // per pipeline stage across the whole portfolio (same figures as the
    // Grid tab's "Portfolio total" row, via computeStageCostTotals — this
    // is NOT delay, just how long each stage-gate has taken everywhere
    // it's been run); ring 3 is cumulative delay again, this time by
    // overall status, as the "which severity bucket is this coming from"
    // rollup of ring 1's total.
    const statusMap = new Map();
    projects.forEach((p) => {
      const days = p.delayDays || 0;
      if (days <= 0) return;
      const status = effectiveStatus(p);
      statusMap.set(status, (statusMap.get(status) || 0) + days);
    });
    const STATUS_ORDER = ["red", "amber", "green", "black"];
    const statusGroups = STATUS_ORDER.filter((s) => statusMap.has(s)).map((s) => ({
      label: STATUS_LABEL[s] || s,
      days: statusMap.get(s),
      color: `var(--${s})`,
    }));

    const stageTotals = computeStageCostTotals(projects);
    const stageGroups = PIPELINE_STAGES.map((stage) => ({ label: stage, days: stageTotals[stage].totalDays }))
      .filter((g) => g.days > 0)
      .sort((a, b) => b.days - a.days)
      .map((g, i) => ({ ...g, color: PM_RING_COLORS[i % PM_RING_COLORS.length] }));

    box.appendChild(
      el("div", { class: "cumdelay-card" }, [
        el("div", { class: "cumdelay-head" }, [
          el("span", { class: "kicker" }, ["Portfolio Totals — Project Delays / Stage-Gate Days / Overall Delays"]),
          el("span", { class: "cumdelay-sub" }, [
            "Three separate numbers: cumulative delay by project, total elapsed days per stage-gate across the whole portfolio, and that same cumulative delay rolled up by overall status. Click a project row to jump to its Stage-gate timeline.",
          ]),
        ]),
        // Three standalone donuts side by side (2026-10-06, replacing an
        // earlier concentric-rings version) — each cut is its own full
        // circle with its own legend underneath, rather than three bands
        // nested inside one shared circle, since nested rings read as
        // "one ring" at a glance and made it hard to tell the cuts apart.
        el("div", { class: "cumdelay-body cumdelay-rings-row" }, [
          el("div", { class: "cumdelay-ring-panel" }, [
            el("span", { class: "cumdelay-ring-title" }, ["Cumulative project delays"]),
            buildDonutChart(projectGroups, { size: 150, strokeWidth: 18 }),
            el(
              "div",
              { class: "cumdelay-legend" },
              projectGroups.map((g) =>
                el(
                  "div",
                  {
                    class: "cumdelay-legend-row",
                    "data-project-id": g.id,
                    tabindex: "0",
                    role: "button",
                    title: "Open " + g.label,
                  },
                  [
                    el("span", { class: "stagedetail-bar-dot", style: `background:${g.color}` }),
                    el("span", { class: "stagedetail-bar-label" }, [g.label]),
                    el("span", { class: "stagedetail-bar-days" }, [g.days + "d"]),
                  ]
                )
              )
            ),
          ]),
          el("div", { class: "cumdelay-ring-panel" }, [
            el("span", { class: "cumdelay-ring-title" }, ["By stage-gate"]),
            buildDonutChart(stageGroups, { size: 150, strokeWidth: 18, centerLabel: "stage days" }),
            el(
              "div",
              { class: "cumdelay-legend" },
              stageGroups.map((g) =>
                el("div", { class: "cumdelay-legend-row cumdelay-legend-row-static" }, [
                  el("span", { class: "stagedetail-bar-dot", style: `background:${g.color}` }),
                  el("span", { class: "stagedetail-bar-label" }, [g.label]),
                  el("span", { class: "stagedetail-bar-days" }, [g.days + "d"]),
                ])
              )
            ),
          ]),
          el("div", { class: "cumdelay-ring-panel" }, [
            el("span", { class: "cumdelay-ring-title" }, ["Overall project delays"]),
            buildDonutChart(statusGroups, { size: 150, strokeWidth: 18 }),
            el(
              "div",
              { class: "cumdelay-legend" },
              statusGroups.map((g) =>
                el("div", { class: "cumdelay-legend-row cumdelay-legend-row-static" }, [
                  el("span", { class: "stagedetail-bar-dot", style: `background:${g.color}` }),
                  el("span", { class: "stagedetail-bar-label" }, [g.label]),
                  el("span", { class: "stagedetail-bar-days" }, [g.days + "d"]),
                ])
              )
            ),
          ]),
              ]),
            ])
          );

    box.querySelectorAll(".cumdelay-legend-row[data-project-id]").forEach((row) => {
      const open = () => openProjectDetail(row.getAttribute("data-project-id"), "stage-gate-timeline-section");
      row.addEventListener("click", open);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
    });
  }

  // Per-stage portfolio totals — "how much time has each stage-gate taken
  // overall, across every project that's been through it" — summed real
  // elapsed days, built from the same computeStageSegments() each
  // individual grid cell uses, so the totals row below always reconciles
  // with the cells above it. (2026-10-05: dropped the summed SLA-overage
  // figure that used to sit alongside this — see the "SLA removal" note
  // on renderStageGridLegend above.)
  function computeStageCostTotals(projects) {
    const totals = {};
    PIPELINE_STAGES.forEach((stage) => {
      totals[stage] = { stage, totalDays: 0, projectCount: 0 };
    });
    projects.forEach((p) => {
      computeStageSegments(p).forEach((seg) => {
        const t = totals[seg.stage];
        if (!t) return;
        t.totalDays += seg.days;
        t.projectCount += 1;
      });
    });
    return totals;
  }

  // Portfolio-wide matrix: every visible project as a row, every pipeline
  // stage as a column. Reuses the same stage-segment reconstruction as the
  // per-project "Stage-gate timeline" (see computeStageSegments above) so
  // the two views never disagree. Each cell carries the actual date range
  // it covered — the fuller "stage-gate" picture, not just a status dot.
  // Colors on the current stage reflect the project's own overall status
  // (same signal as everywhere else in the app), not a generic per-stage
  // SLA threshold — see the note on renderStageGridLegend for why that was
  // removed.
  function renderStageGrid() {
    renderStageGridMetrics();
    renderCumulativeDelayChart();
    renderStageGridLegend();
    const wrap = document.getElementById("stageGrid");
    if (!wrap) return;
    wrap.innerHTML = "";

    const projects = visibleProjects();
    if (!projects.length) {
      wrap.appendChild(el("div", { class: "stage-col-empty" }, ["No projects match the current filters"]));
      return;
    }

    const grid = el("div", { class: "stage-grid" });

    const headerRow = el("div", { class: "stage-grid-row stage-grid-header" }, [
      el("div", { class: "stage-grid-cell stage-grid-name-cell" }, ["Project"]),
    ]);
    PIPELINE_STAGES.forEach((stage) => {
      headerRow.appendChild(
        el("div", { class: "stage-grid-cell stage-grid-col-head", title: stage }, [
          STAGE_GRID_SHORT[stage] || stage,
        ])
      );
    });
    // "Total" column — how long the WHOLE project has been running
    // (real calendar days since its first stage started, not a sum of
    // per-stage day-counts — see the note by `lifecycleDays` below for
    // why that distinction matters) plus the project's total delay,
    // right alongside the per-stage breakdown instead of needing to
    // scroll to a card to find either number.
    headerRow.appendChild(
      el(
        "div",
        { class: "stage-grid-cell stage-grid-col-head stage-grid-total-col", title: "Days running so far, and total delay against plan" },
        ["Total"]
      )
    );
    grid.appendChild(headerRow);

    // "How much time has each stage-gate taken overall" — a bolded summary
    // row, pinned right under the header so it's visible without
    // scrolling past every project, showing total real days spent in that
    // stage across every project that's reached it (same numbers the
    // individual cells below are built from — see computeStageCostTotals()).
    const stageTotals = computeStageCostTotals(projects);
    // Overall delay is the go-live slip only. Stage slips stay on the
    // stage boxes: a team can run the next stage in parallel and still
    // launch on time, so those days are not added into this total.
    const portfolioDelay = projects.reduce((sum, p) => sum + Math.max(0, p.delayDays || 0), 0);
    const totalsRow = el("div", { class: "stage-grid-row stage-grid-totals-row" }, [
      el("div", { class: "stage-grid-cell stage-grid-name-cell stage-grid-totals-label" }, [
        el("div", { class: "stage-grid-name-text" }, [
          el("strong", null, ["Portfolio total"]),
          el("span", { class: "stage-grid-name-meta" }, [`across ${projects.length} project${projects.length === 1 ? "" : "s"}`]),
        ]),
      ]),
    ]);
    PIPELINE_STAGES.forEach((stage) => {
      const t = stageTotals[stage];
      let cell;
      if (!t || t.projectCount === 0) {
        cell = el("div", { class: "stage-grid-cell stage-grid-status-cell stage-grid-totals-cell is-none" }, ["—"]);
      } else {
        cell = el(
          "div",
          {
            class: "stage-grid-cell stage-grid-status-cell stage-grid-totals-cell is-done",
            title: `${stage}: ${t.totalDays}d total across ${t.projectCount} project${t.projectCount === 1 ? "" : "s"}`,
          },
          [
            el("span", { class: "stage-grid-days" }, [t.totalDays + "d total"]),
            el("span", { class: "stage-grid-daterange" }, [`${t.projectCount} project${t.projectCount === 1 ? "" : "s"}`]),
          ]
        );
      }
      totalsRow.appendChild(cell);
    });
    const grandTotalDays = PIPELINE_STAGES.reduce((sum, stage) => sum + ((stageTotals[stage] && stageTotals[stage].totalDays) || 0), 0);
    totalsRow.appendChild(
      el(
        "div",
        {
          class: "stage-grid-cell stage-grid-status-cell stage-grid-totals-cell stage-grid-total-cell is-done",
          title:
            `${grandTotalDays}d — sum of every stage, every project` +
            (portfolioDelay > 0 ? `; +${portfolioDelay}d go-live delay across the portfolio` : "; no project launched late"),
        },
        [
          el("span", { class: "stage-grid-days" }, [grandTotalDays + "d total"]),
          el("span", { class: "stage-grid-daterange" }, ["whole portfolio"]),
          portfolioDelay > 0
            ? el("span", { class: "stage-grid-delay is-over" }, [`+${portfolioDelay}d delay`])
            : null,
        ]
      )
    );
    grid.appendChild(totalsRow);

    projects.forEach((p) => {
      const segments = computeStageSegments(p);
      const segByStage = {};
      segments.forEach((seg) => {
        segByStage[seg.stage] = seg;
      });
      const currentIndex = PIPELINE_STAGES.indexOf(p.stage || "Unstaged");

      const row = el("div", { class: "stage-grid-row" });

      const nameCell = el(
        "div",
        { class: "stage-grid-name-cell stage-grid-cell", "data-project-id": p.id, tabindex: "0", role: "button" },
        [
          el("span", { class: "timeline-dot", style: `background:var(--${effectiveStatus(p)})` }),
          el("div", { class: "stage-grid-name-text" }, [
              el("strong", null, [p.name]),
            el("span", { class: "stage-grid-name-meta" }, [
              (p.owner || "Unassigned") + (currentIndex === -1 ? " · Unstaged" : ""),
            ]),
          ]),
        ]
      );
      row.appendChild(nameCell);

      PIPELINE_STAGES.forEach((stage, i) => {
        let cell;
        if (currentIndex === -1 || i > currentIndex) {
          cell = el("div", { class: "stage-grid-cell stage-grid-status-cell is-none" }, ["—"]);
        } else if (i < currentIndex) {
          // Already passed through this stage — show how long it took and
          // the actual date range. (No more per-stage SLA judgment here —
          // see the note on renderStageGridLegend. Whether the PROJECT as a
          // whole is delayed is tracked once, overall, via `delayDays`.)
          const seg = segByStage[stage];
          const delta = stagePlanDelayDays(p, stage, seg);
          const deltaLabel = delta != null && delta !== 0 ? (delta > 0 ? `+${delta}d` : `${delta}d`) : null;
          cell = el(
            "div",
            {
              class: "stage-grid-cell stage-grid-status-cell is-done is-clickable",
              "data-project-id": p.id,
              "data-stage": stage,
              tabindex: "0",
              role: "button",
              title:
                (seg
                  ? `${stage}: ${seg.approxStart ? "≥" : ""}${seg.days}d (${fmtDateShort(seg.start)} \u2192 ${fmtDateShort(seg.end)})`
                  : `${stage}: done`) +
                (deltaLabel
                  ? delta > 0
                    ? ` — ${deltaLabel} over its own plan`
                    : ` — ${deltaLabel} ahead of its own plan (pulled up)`
                  : "") +
                " — click for full detail",
            },
            [
              el("span", { class: "stage-grid-days" }, [
                "✓ " + (seg ? (seg.approxStart ? "≥" : "") + seg.days + "d" : "Done"),
              ]),
              seg
                ? el("span", { class: "stage-grid-daterange" }, [`${fmtDateShort(seg.start)} → ${fmtDateShort(seg.end)}`])
                : null,
              deltaLabel
                ? el("span", { class: "stage-grid-delay " + (delta > 0 ? "is-over" : "is-early") }, [deltaLabel])
                : null,
            ]
          );
        } else {
          // Current stage — yellow ("in progress") by default, red only
          // if this SPECIFIC stage has run past its own committed
          // stagePlan end date (see currentStageOverdue) — not the
          // project's overall status, which can be red for reasons
          // unrelated to this particular stage running long.
          const seg = segByStage[stage];
          const overdue = currentStageOverdue(p, stage);
          const flagClass = overdue ? " is-breach" : " is-warn";
          const days = seg ? seg.days : null;
          const delta = stagePlanDelayDays(p, stage, seg);
          const deltaLabel = delta != null && delta > 0 ? `+${delta}d` : null;
          cell = el(
            "div",
            {
              class: "stage-grid-cell stage-grid-status-cell is-current is-clickable" + flagClass,
              "data-project-id": p.id,
              "data-stage": stage,
              tabindex: "0",
              role: "button",
              title:
                (days != null
                  ? `${stage}: ${seg.approxStart ? "≥" : ""}${days}d so far (since ${fmtDateShort(seg.start)})`
                  : `${stage}: in progress`) +
                (deltaLabel ? ` — ${deltaLabel} past its planned end date` : "") +
                " — click for full detail",
            },
            [
              el("span", { class: "stage-grid-days" }, [
                days != null ? (seg.approxStart ? "≥" : "") + days + "d" : "In progress",
              ]),
              seg ? el("span", { class: "stage-grid-daterange" }, ["since " + fmtDateShort(seg.start)]) : null,
              deltaLabel ? el("span", { class: "stage-grid-delay is-over" }, [deltaLabel]) : null,
            ]
          );
        }
        row.appendChild(cell);
      });

      // Horizontal "whole lifecycle so far" total (2026-11-04: fixed —
      // used to be `segments.reduce((sum, seg) => sum + seg.days, 0)`,
      // which SUMS every stage's own day-count. That's wrong whenever
      // stages overlap in real calendar time — which happens for any
      // project whose earlier stages were backfilled from stagePlan dates
      // (see the backfill note on computeStageSegments): those backfilled
      // ranges aren't cross-checked against the next stage's real dates,
      // so e.g. MyBKY (Phase 1)'s Requirements (Nov 8 → Jun 25) and Tech.
      // Design (Mar 9 → Jul 14) overlap by ~3.5 months, and summing both
      // in full double-counts that overlap — the per-stage days always
      // added up correctly (229+127+...=629), the TOTAL just didn't mean
      // "how long has this project been running" like it looked like it
      // did. Fixed: calendar days from the first stage's start straight to
      // today — the project's real elapsed run time, never inflated by
      // overlapping segments.
      const firstStart = segments.length ? segments[0].start : null;
      const lifecycleDays = firstStart ? daysBetweenIso(firstStart, todayISO()) : 0;
      // Overall delay is the go-live slip (`delayDays`), not the sum of
      // the stage chips. Stages can slip while the launch still holds.
      const totalDelay = Math.max(0, p.delayDays || 0);
      row.appendChild(
        el(
          "div",
          {
            class: "stage-grid-cell stage-grid-status-cell stage-grid-total-cell",
            title:
              `${p.name}: ${lifecycleDays}d running so far` +
              (firstStart ? ` (since ${fmtDateShort(firstStart)})` : "") +
              (totalDelay > 0 ? `; go-live +${totalDelay}d` : "; go-live on time"),
          },
          [
            el("span", { class: "stage-grid-days" }, [lifecycleDays + "d"]),
            firstStart ? el("span", { class: "stage-grid-daterange" }, ["since " + fmtDateShort(firstStart)]) : null,
            totalDelay > 0
              ? el("span", { class: "stage-grid-delay is-over" }, [`+${totalDelay}d delay`])
              : el("span", { class: "stage-grid-delay-ok" }, ["on plan"]),
          ]
        )
      );

      grid.appendChild(row);
    });

    wrap.appendChild(grid);

    // Project name cell → open the full project detail view, scrolled to
    // the Schedule timeline (calendar + date-change log) — the Grid tab is
    // fundamentally a "what moved" / scheduling view, so that's the more
    // relevant landing spot than the Stage-gate timeline section below it.
    // Individual stage cells → open that exact stage's detail modal
    // directly (Overview/Date History/Delay Analysis/Delay Log), the SAME
    // modal and same openStageDetail(projectId, stage) call used when
    // clicking a row in the per-project Stage-gate timeline — so clicking a
    // cell here has the identical effect.
    wrap.querySelectorAll(".stage-grid-name-cell[data-project-id]").forEach((node) => {
      const open = () => openProjectDetail(node.getAttribute("data-project-id"), "detailScheduleSection");
      node.addEventListener("click", open);
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
    });
    wrap.querySelectorAll(".stage-grid-status-cell[data-project-id][data-stage]").forEach((node) => {
      const open = () => openStageDetail(node.getAttribute("data-project-id"), node.getAttribute("data-stage"));
      node.addEventListener("click", open);
      node.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
    });
  }

  function listOrDash(items) {
    return items.length ? items.map((d) => el("li", null, [d])) : [el("li", null, ["—"])];
  }

  function pairedList(items, mitigations, label, teams) {
    if (!items.length) return [el("li", null, ["—"])];
    return items.map((text, i) => {
      const mitigation = (mitigations && mitigations[i]) || "";
      const team = (teams && teams[i]) || "";
      return el("li", { class: "paired-item" }, [
        el("div", { class: "paired-item-text" }, [
          text,
          ...(teams
            ? [el("span", { class: "team-tag" + (team ? "" : " is-missing") }, [team || "No team labeled"])]
            : []),
        ]),
        el("div", { class: "paired-item-mitigation" + (mitigation ? "" : " is-missing") }, [
          el("span", { class: "mitigation-label" }, [label + ": "]),
          mitigation || "Not yet documented",
        ]),
      ]);
    });
  }

  function renderCards() {
    const box = document.getElementById("cards");
    box.innerHTML = "";
    const projects = visibleProjects().filter((p) => activeFilter === "all" || effectiveStatus(p) === activeFilter);

    if (!projects.length) {
      box.appendChild(el("div", { class: "empty-note" }, ["No projects match this filter."]));
      return;
    }

    const recentChanges = mostRecentChangeByProject();

    projects.forEach((p) => {
      const isLate = p.delayDays > 0;
      const notes = openNotesFor(p.id);

      const eStatus = effectiveStatus(p);
      const card = el("div", { class: "card status-" + eStatus, "data-project-id": p.id, tabindex: "0", role: "button" }, [
        el("div", { class: "card-head" }, [
          el("h3", null, [p.name]),
          el("span", { class: "pill pill-" + eStatus }, [STATUS_LABEL[eStatus]]),
        ]),
        el("div", { class: "card-owner" }, [p.owner ? "PM: " + p.owner : "PM: unassigned"]),
        cardRecentChangeNode(recentChanges[p.id]),
        el("div", { class: "progress-row" }, [
          el("div", { class: "progress-track" }, [
            el("div", { class: "progress-fill status-" + eStatus, style: "width:" + p.progress + "%" }),
          ]),
          el("div", { class: "progress-pct" }, [p.progress + "%"]),
        ]),
        el("dl", { class: "card-facts" }, [
          ...currentStageFactNodes(p),
          el("dt", null, ["Next milestone"]),
          el("dd", null, [(p.nextMilestone && p.nextMilestone.name || "—") + (p.nextMilestone && p.nextMilestone.date ? " · " + fmtDateShort(p.nextMilestone.date) : "")]),
          el("dt", null, ["Go-live"]),
          el("dd", null, [fmtDate(p.goLive)]),
          el("dt", null, ["Status"]),
          el("dd", { class: "delay-flag " + (isLate ? "is-late" : "is-ontime") }, [
            scheduleStatusText(p),
          ]),
          ...((p.timeSavedDays || 0) > 0
            ? [
                el("dt", null, ["Time saved"]),
                el("dd", { class: "delay-flag is-saved" }, ["-" + p.timeSavedDays + " days"]),
              ]
            : []),
        ]),
        el("div", { class: "card-badges" }, [
          openItemBadge(dependencyCounts(p), "dependency", "dependencies", "detail-deps-section", { jump: true }),
          openItemBadge(riskCounts(p), "risk", "risks", "detail-risks-section", { jump: true }),
          openItemBadge(followupCounts(p), "follow-up", "follow-ups", "detail-followups-section", { jump: true }),
          changeRequestBadge(p, { jump: true }),
          ...((p.fastFollowItems || []).length
            ? [el("span", { class: "badge has-fastfollow" }, [(p.fastFollowItems || []).length + " fast-follow"])]
            : []),
          ...(p.scopeReduced
            ? [el("span", { class: "badge has-scopecut" }, ["✂️ scope cut"])]
            : []),
          ...((p.timeSavedDays || 0) > 0
            ? [el("span", { class: "badge has-timesaved" }, ["⏱ +" + p.timeSavedDays + "d saved"])]
            : []),
          ...((p.escalations || []).length
            ? [
                el(
                  "span",
                  { class: "badge has-escalation is-jump-link", "data-focus-section": "detail-escalations-section" },
                  ["🚨 " + (p.escalations || []).length + " escalated"]
                ),
              ]
            : []),
        ]),
        el("button", { class: "card-expand" }, ["View full details →"]),
      ]);

      box.appendChild(card);
    });

    box.querySelectorAll(".card").forEach((card) => {
      card.addEventListener("click", () => openProjectDetail(card.getAttribute("data-project-id")));
      card.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openProjectDetail(card.getAttribute("data-project-id"));
        }
      });
    });

    // Dependencies/risks/follow-ups/escalated badges jump straight to
    // their source section in the project detail view (instead of just
    // opening the detail scrolled to the top and making someone hunt for
    // it) — stopPropagation so clicking a badge doesn't also fire the
    // whole card's click handler above it.
    box.querySelectorAll(".badge.is-jump-link").forEach((badge) => {
      badge.setAttribute("tabindex", "0");
      badge.setAttribute("role", "button");
      const open = (e) => {
        e.stopPropagation();
        const card = badge.closest(".card");
        if (!card) return;
        const section = badge.getAttribute("data-focus-section");
        openProjectDetail(card.getAttribute("data-project-id"), section || undefined);
      };
      badge.addEventListener("click", open);
      badge.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open(e);
        }
      });
    });
  }

  function populateGlobalOwnerFilter() {
    const select = document.getElementById("globalOwnerFilter");
    const owners = Array.from(
      new Set(activeProjects().map((p) => p.owner || "Unassigned"))
    ).sort((a, b) => {
      if (a === "Unassigned") return 1;
      if (b === "Unassigned") return -1;
      return a.localeCompare(b);
    });

    owners.forEach((owner) => {
      select.appendChild(el("option", { value: owner }, [owner]));
    });
  }

  function updateGlobalOwnerFilterUI() {
    const clearBtn = document.getElementById("globalOwnerClear");
    clearBtn.hidden = activeOwner === "all";
    updateGlobalFilterUI();
  }

  function wireGlobalOwnerFilter() {
    const select = document.getElementById("globalOwnerFilter");
    select.addEventListener("change", () => {
      activeOwner = select.value;
      updateGlobalOwnerFilterUI();
      renderAllTabs();
    });

    document.getElementById("globalOwnerClear").addEventListener("click", () => {
      activeOwner = "all";
      select.value = "all";
      updateGlobalOwnerFilterUI();
      renderAllTabs();
    });
  }

  // Filters to projects that have a dependency owned by another team
  // (DevOps, BAPS ID Team, SSO Team, etc. — whatever's actually been entered
  // in `dependencyTeams` across the portfolio). Useful for someone from one
  // of those teams to jump straight to "what do I need to look at."
  function populateGlobalTeamFilter() {
    const select = document.getElementById("globalTeamFilter");
    const teams = Array.from(
      new Set(
        activeProjects().flatMap((p) =>
          getDependencyObjects(p)
            .filter((d) => !d.resolved && d.team)
            .map((d) => d.team)
        )
      )
    ).sort((a, b) => a.localeCompare(b));

    teams.forEach((team) => {
      select.appendChild(el("option", { value: team }, [team]));
    });
  }

  function updateGlobalTeamFilterUI() {
    const clearBtn = document.getElementById("globalTeamClear");
    clearBtn.hidden = globalTeamFilter === "all";
    updateGlobalFilterUI();
  }

  function wireGlobalTeamFilter() {
    const select = document.getElementById("globalTeamFilter");
    select.addEventListener("change", () => {
      globalTeamFilter = select.value;
      updateGlobalTeamFilterUI();
      renderAllTabs();
    });

    document.getElementById("globalTeamClear").addEventListener("click", () => {
      globalTeamFilter = "all";
      select.value = "all";
      updateGlobalTeamFilterUI();
      renderAllTabs();
    });
  }

  /* ---------------- Hawk-eye (cross-project stage-gate calendar) ---------------- */

  const STAGE_SHORT_CODE = {
    "Proposal": "PROP",
    "Requirements": "REQ",
    "Tech. Design": "TD",
    "Estimate & Planning": "EST",
    "Development": "DEV",
    "UAT": "UAT",
    "VAPT": "VAPT",
    "Rollout": "ROL",
    "Hypercare": "HC",
    "Load": "LD",
  };

  // Fallback planned width (calendar days) for a future stage with no
  // configured SLA — shouldn't normally hit since every real pipeline
  // stage has one in DEFAULT_STAGE_SLA_DAYS, but keeps the chain from
  // collapsing to zero-width if data.json ever removes one.
  const DEFAULT_FUTURE_STAGE_DAYS = 14;

  function addDaysIso(iso, days) {
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // Builds the full sequence of stage blocks for one project's Hawk-eye
  // row: real start/end dates for stages already passed through (from the
  // same history reconstruction as the Grid tab / the per-project
  // Stage-gate timeline), the current stage running to today, then every
  // remaining stage chained forward using a generic placeholder width
  // (DEFAULT_FUTURE_STAGE_DAYS, or that stage's configured duration
  // estimate when no real plan date is on record yet) purely for VISUAL
  // sizing — not a deadline or SLA judgment. Returns [] for a project with
  // no recognized stage (e.g. "Unstaged") — nothing real to plot yet.
  // (2026-10-05: coloring is driven by the project's own overall status,
  // not a per-stage SLA breach — see the note on renderStageGridLegend.)
  function buildHawkeyeBlocks(p) {
    const today = todayISO();
    const segments = computeStageSegments(p);
    const segByStage = {};
    segments.forEach((seg) => {
      segByStage[seg.stage] = seg;
    });
    const currentIndex = PIPELINE_STAGES.indexOf(p.stage || "Unstaged");
    if (currentIndex === -1) return [];

    const blocks = [];
    PIPELINE_STAGES.forEach((stage, i) => {
      if (i < currentIndex) {
        const seg = segByStage[stage];
        if (!seg) return;
        blocks.push({
          stage,
          start: seg.start,
          end: seg.end,
          kind: "done",
        });
      } else if (i === currentIndex) {
        const seg = segByStage[stage] || { start: today, days: 0 };
        const end = seg.end && seg.end > today ? seg.end : today;
        // Yellow ("in progress") by default, red only if THIS stage has
        // run past its own committed stagePlan end date — see
        // currentStageOverdue.
        blocks.push({
          stage,
          start: seg.start,
          end,
          kind: "current",
          flag: currentStageOverdue(p, stage) ? "breach" : "warn",
        });
      } else {
        // Potential target for a not-yet-reached stage: prefer a REAL
        // recorded stagePlan date for that stage when one's already on
        // record (decks sometimes have forward-looking planned dates for
        // stages the project hasn't reached yet), falling back to a
        // generic placeholder-width chain (start right after the previous
        // block ends, run for a generic estimated duration) purely for
        // visual sizing when nothing better is known — not a deadline.
        // `planned: true` marks the former so callers can show "planned
        // target" vs. "potential target (estimated)".
        const prev = blocks[blocks.length - 1];
        const plan = p.stagePlan && p.stagePlan[stage];
        const planStart = plan && (plan.latestStart || plan.initialStart);
        const planEnd = plan && (plan.latestEnd || plan.initialEnd);
        let start, end, planned;
        if (planStart && planEnd) {
          start = planStart;
          end = planEnd;
          planned = true;
        } else {
          const estDuration = stageSlaDays(stage) || DEFAULT_FUTURE_STAGE_DAYS;
          start = prev ? prev.end : today;
          end = addDaysIso(start, estDuration);
          planned = false;
        }
        // A real planned window that's already fully in the past (2026-10-06)
        // means the project hasn't reported moving into this stage yet even
        // though its OWN plan says it should already be done — e.g. myBKY 2A
        // is still reported as "Requirements" today even though its Tech.
        // Design plan window (Aug 10 → Oct 23) started two months ago.
        // Surfacing that as an ordinary "upcoming" chip would be actively
        // misleading, so it gets its own `overdue` flag for a distinct look.
        const overdue = planned && end < today;
        blocks.push({ stage, start, end, kind: "future", planned, overdue });
      }
    });
    return blocks;
  }

  // Single-project Stage-gate timeline. Every project uses the step
  // ladder (one lane per stage, stacked downward on a shared date axis)
  // — the same layout parallel-stage projects already had (2026-11-04,
  // "I want to see this in a step ladder UI downwards ... like the
  // second image"). The previous single-row chart shoved every stage
  // onto one track and shifted blocks sideways so captions wouldn't
  // collide, which hid real overlaps and made the labels unreadable.
  function buildStageGateTimeline(p) {
    return buildParallelStageGateTimeline(p);
  }

  // "Stage Dates" table (2026-11-03) — per explicit request, modeled on a
  // reference spreadsheet screenshot ("NDC Development Project Planned
  // Schedule"-style table: Stage / Start / End / Delay (Days), with a
  // revised date in red under the original whenever the plan slipped).
  // Uses this project's own `stagePlan` baseline (`initialStart`/
  // `initialEnd`) vs its current plan (`latestStart`/`latestEnd`) — the
  // SAME two numbers every other plan-vs-latest view in this app already
  // reads (e.g. `buildHawkeyeBlocks`'s `plan.latestStart || plan.initialStart`),
  // just laid out as a table instead of a chart. "Delay (Days)" is the
  // shift in the planned COMPLETION date specifically (latestEnd minus
  // initialEnd, in business days only — weekends don't count, 2026-11-04)
  // — not a start-date shift, and not the real/actual
  // duration from `computeStageSegments` (that's what the Grid tab and
  // the timeline above already show) — this table is purely "how has
  // THIS stage's own plan moved since it was first committed." A stage
  // with no `stagePlan` entry on record at all gets a dashed "—" row
  // rather than being omitted, so the table always lists the full
  // 9-stage pipeline.
  // One row per stage the project actually tracks. `stageDateOrder` is the
  // PM's own list (label + which stagePlan key) — MyBKY Phase 1 uses the
  // Stage Dates spreadsheet, including Load, which is not a pipeline stage.
  // Everyone else keeps the nine pipeline stages.
  function stageDateRows(p) {
    const order = p.stageDateOrder && p.stageDateOrder.length
      ? p.stageDateOrder
      : PIPELINE_STAGES.map((stage) => ({ stage: stage, label: stage }));
    return order.map((row) => {
      const stage = row.stage || row;
      const plan = (p.stagePlan && p.stagePlan[stage]) || {};
      const plannedEnd = plan.initialEnd || null;
      const actualEnd = plan.latestEnd || plan.initialEnd || null;
      const slipped = plannedEnd && actualEnd && actualEnd !== plannedEnd;
      const days = slipped ? businessDaysBetweenIso(plannedEnd, actualEnd) : 0;
      return {
        stage,
        label: row.label || stage,
        start: plan.initialStart || null,
        plannedEnd,
        actualEnd,
        days: days > 0 ? days : 0,
      };
    });
  }

  // One card row per stage, in the date-change-log style (2026-11-04):
  // start date on the left, then planned end → actual end, with the
  // weekday slip on the right. Latest stage first, in timeline order, so
  // stages still ahead (Go-Live, Hypercare) sit above the current one. The
  // current stage stays highlighted where it falls instead of jumping to
  // the top.
  function buildStageDatesTable(p) {
    const rows = stageDateRows(p).slice().reverse();
    const box = el("div", { class: "schedule-timeline stagedates-list" });
    rows.forEach((row) => {
      const slipped = row.days > 0;
      const current = row.stage === p.stage;
      const endParts = !row.actualEnd
        ? [el("span", { class: "stagedates-none" }, ["No dates planned yet"])]
        : slipped
        ? [
            el("span", { class: "golive-date-original" }, [fmtDateShort(row.plannedEnd)]),
            el("span", { class: "golive-arrow" }, ["→"]),
            el("span", { class: "golive-date-current is-late" }, [fmtDate(row.actualEnd)]),
          ]
        : [el("span", { class: "stagedates-end-label" }, ["Ends"]), el("span", { class: "golive-date-current" }, [fmtDate(row.actualEnd)])];
      box.appendChild(
        el("div", { class: "schedule-timeline-row stagedates-line" + (current ? " is-current" : "") }, [
          el("div", { class: "sd-start" }, [
            el("span", { class: "stagedates-start-label" }, ["Start"]),
            row.start ? fmtDate(row.start) : "—",
          ]),
          el("div", { class: "sd-stage" }, [
            el("span", { class: "schedule-timeline-label" }, [row.label]),
            current ? el("span", { class: "stagedates-current-pill" }, ["Current"]) : null,
          ]),
          el("div", { class: "sd-ends" }, endParts),
          el("div", { class: "sd-delay" }, [
            slipped ? el("span", { class: "schedule-timeline-delta is-late" }, ["+" + row.days + " days"]) : null,
          ]),
        ])
      );
    });
    return box;
  }

  // One lane per stage on that stage's own dates, stacked downward so
  // overlapping stages read as a step ladder instead of colliding on one
  // row. Shared by every project's Stage-gate tab (`buildStageGateTimeline`)
  // and the cross-project Hawk-eye board. `p.parallelStages` only renames
  // lanes (e.g. {"Tech. Design": "Design"}) and switches done/current to
  // milestone progress; every other project uses `p.stage` for
  // done/current/future. A stage counts as started once its planned start
  // has passed when progress drives the coloring. A done/current stage
  // with no plan entry falls back to its recorded segment, and a done
  // stage carries its recorded finish date when that differs from the plan.
  function stageLaneBlocks(p) {
    const todayIso = todayISO();
    const labels = p.parallelStages && typeof p.parallelStages === "object" ? p.parallelStages : {};
    const plan = p.stagePlan || {};
    const pctByName = {};
    (p.milestones || []).forEach((m) => {
      if (m.progress != null && m.progress !== "") pctByName[m.name] = Number(m.progress);
    });
    const currentIndex = PIPELINE_STAGES.indexOf(p.stage || "Unstaged");
    const byProgress = !!p.parallelStages || currentIndex === -1;
    const segByStage = {};
    if (!byProgress) computeStageSegments(p).forEach((seg) => { segByStage[seg.stage] = seg; });
    return PIPELINE_STAGES.map((stage, i) => {
      const sp = plan[stage];
      const seg = segByStage[stage];
      let start = sp && (sp.latestStart || sp.initialStart);
      let end = sp && (sp.latestEnd || sp.initialEnd);
      const label = labels[stage] || stage;
      const pct = pctByName[label];
      const kind = byProgress
        ? pct >= 100 ? "done" : start && start <= todayIso ? "current" : "future"
        : i < currentIndex ? "done" : i === currentIndex ? "current" : "future";
      if ((!start || !end) && seg && kind !== "future") {
        start = seg.start;
        end = kind === "current" ? todayIso : seg.end;
      }
      if (!start || !end) return null;
      return {
        stage,
        label,
        start,
        end,
        plannedEnd: sp && sp.initialEnd,
        actualEnd: kind === "done" && seg && seg.end !== end ? seg.end : null,
        pct,
        kind,
        late: kind === "current" && end < todayIso,
        planPassed: kind === "future" && end < todayIso,
      };
    }).filter(Boolean);
  }

  function stageLaneMeta(b) {
    const status =
      b.kind === "done"
        ? "done"
        : b.kind === "current"
        ? b.late ? "past planned end" : "in progress"
        : b.planPassed ? "plan passed, not started" : "not started";
    return (
      fmtDateShort(b.start) + " → " + fmtDateShort(b.end) +
      (b.plannedEnd && b.plannedEnd !== b.end ? " (planned " + fmtDateShort(b.plannedEnd) + ")" : "") +
      (b.actualEnd ? "  ·  finished " + fmtDateShort(b.actualEnd) : "") +
      (b.pct != null ? "  ·  " + b.pct + "%" : "") +
      "  ·  " + status
    );
  }

  // Rightmost pixel a lane's block or caption reaches — used to size the
  // scrollable width so no caption is ever cut off.
  function stageLaneExtentPx(b, xPx) {
    const left = xPx(b.start);
    const width = Math.max(xPx(b.end) - left, 10);
    // Caption text is wider than a short bar (the current stage often
    // sits at the right edge). Measure from the bar's left so the scroll
    // width includes the full caption, not just the bar.
    return left + Math.max(width, b.label.length * 8, stageLaneMeta(b).length * 7.4);
  }

  function stageLaneTrack(p, b, xPx, marks, todayIso, opts) {
    const o = opts || {};
    const left = xPx(b.start);
    const width = Math.max(xPx(b.end) - left, 10);
    const meta = stageLaneMeta(b);
    const track = el("div", { class: "stagegantt-track" + (o.className ? " " + o.className : "") });
    marks.forEach((m) => track.appendChild(el("div", { class: "stagegantt-grid-line", style: `left:${m.px}px` })));
    track.appendChild(
      el("div", { class: "stagegantt-today-line", style: `left:${xPx(todayIso)}px` },
        o.todayLabel ? [el("span", { class: "stagegantt-today-label" }, ["Today"])] : [])
    );
    const kindClass =
      b.kind === "done"
        ? "is-done"
        : b.kind === "current"
        ? "is-current is-" + (b.late ? "breach" : "warn")
        : "is-future" + (b.planPassed ? " is-plan-overdue" : "");
    const block = el(
      "div",
      {
        class: "stagegantt-block " + kindClass,
        style: `left:${left}px;width:${width}px`,
        role: "button",
        tabindex: "0",
        title: `${p.name} — ${b.label}: ${meta}. Click for stage detail.`,
        "aria-label": "View full stage detail for " + b.label,
      },
      [width >= 32 ? STAGE_SHORT_CODE[b.stage] || b.stage : ""]
    );
    const open = (e) => {
      e.stopPropagation();
      openStageDetail(p.id, b.stage);
    };
    block.addEventListener("click", open);
    block.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        open(e);
      }
    });
    track.appendChild(block);
    track.appendChild(
      el("div", { class: "stagegantt-caption", style: `left:${left}px` }, [
        el("span", { class: "stagegantt-caption-stage" }, [b.label]),
        el("span", { class: "stagegantt-caption-meta" + (b.late || b.planPassed ? " is-plan-overdue" : "") }, [meta]),
      ])
    );
    return track;
  }

  function buildParallelStageGateTimeline(p) {
    const DAY = 86400000;
    const todayIso = todayISO();
    const blocks = stageLaneBlocks(p);
    if (!blocks.length) {
      return el("p", { class: "empty-note" }, ["No stage plan dates to plot yet."]);
    }

    const times = [new Date(todayIso + "T00:00:00").getTime()];
    blocks.forEach((b) => {
      times.push(new Date(b.start + "T00:00:00").getTime());
      times.push(new Date(b.end + "T00:00:00").getTime());
    });
    const minTime = Math.min(...times) - 4 * DAY;
    let maxTime = Math.max(...times) + 4 * DAY;
    if (maxTime - minTime < 20 * DAY) maxTime = minTime + 20 * DAY;
    const PX_PER_DAY = Math.min(6, Math.max(0.45, 900 / ((maxTime - minTime) / DAY)));
    const xPx = (iso) => ((new Date(iso + "T00:00:00").getTime() - minTime) / DAY) * PX_PER_DAY;

    const marks = [];
    const cursor = new Date(minTime);
    cursor.setDate(1);
    cursor.setHours(0, 0, 0, 0);
    cursor.setMonth(Math.floor(cursor.getMonth() / 3) * 3);
    while (cursor.getTime() <= maxTime) {
      if (cursor.getTime() >= minTime) {
        marks.push({
          px: ((cursor.getTime() - minTime) / DAY) * PX_PER_DAY,
          label: `Q${Math.floor(cursor.getMonth() / 3) + 1} ${cursor.getFullYear()}`,
        });
      }
      cursor.setMonth(cursor.getMonth() + 3);
    }

    const timelineWidthPx = Math.max(xPx(todayIso), ...blocks.map((b) => stageLaneExtentPx(b, xPx))) + 48;

    const wrap = el("div", { class: "stagegantt-scroll" });
    const inner = el("div", { class: "stagegantt-inner", style: `width:${timelineWidthPx}px` });
    const header = el("div", { class: "stagegantt-months" });
    marks.forEach((m) => header.appendChild(el("div", { class: "stagegantt-month-mark", style: `left:${m.px}px` }, [m.label])));
    inner.appendChild(header);
    blocks.forEach((b, i) => inner.appendChild(stageLaneTrack(p, b, xPx, marks, todayIso, { todayLabel: i === 0 })));
    wrap.appendChild(inner);

    requestAnimationFrame(() => {
      wrap.scrollLeft = Math.max(0, xPx(todayIso) - 260);
    });
    return wrap;
  }

  // The "Who leads each stage" (RACI) reference and "Go-Live readiness"
  // checklist that follow `buildParallelStageGateTimeline` on origin/main
  // are intentionally NOT brought in here — both were removed for all
  // projects on 2026-11-04 per explicit request (see the note near the old
  // RACI_STAGES/GOLIVE_CHECKLIST_ITEMS constants). Their functions and the
  // constants they depend on are gone on this branch, so re-adding them
  // would reference undefined names.

  // "Recovery note" (2026-11-04) — sits right under the Stage Dates table.
  // Per explicit request: "below this allow the PMs to type a message on
  // how they were able to catch up and finish ontime regardless of all the
  // delays (so show the total delays = 0)". The table above can show
  // individual stages slipping (Development +25, UAT +15, ...) while the
  // project still landed on its original go-live date — this is the PM's
  // own free-text explanation of how the team caught up, and a small
  // "Total delay: 0" chip next to it (from the SAME `p.delayDays` number
  // every other "on schedule" surface in the app already uses, so it can
  // never disagree with the rest of the dashboard). Only shown when the
  // project is genuinely on schedule (`delayDays === 0`) — a project
  // that's still behind doesn't get a "how we caught up" prompt.
  //
  // The typed note is saved locally (localStorage, keyed by project id)
  // AND mirrored onto `p.recoveryNote` in memory so it survives for the
  // rest of this browser session. This dashboard has no write-back to
  // data.json (that file is the ingested source of truth, updated only
  // via the weekly-update pipeline) — see README for how a PM's note gets
  // promoted into data.json permanently.
  const RECOVERY_NOTE_STORAGE_PREFIX = "baps-ndc-recovery-note:";

  function recoveryNoteFor(p) {
    try {
      const saved = localStorage.getItem(RECOVERY_NOTE_STORAGE_PREFIX + p.id);
      if (saved !== null) return saved;
    } catch (e) {
      /* localStorage unavailable (private mode, etc.) — fall through */
    }
    return p.recoveryNote || "";
  }

  function saveRecoveryNote(p, text) {
    p.recoveryNote = text;
    try {
      localStorage.setItem(RECOVERY_NOTE_STORAGE_PREFIX + p.id, text);
    } catch (e) {
      /* ignore — the in-memory copy above still holds it for this session */
    }
  }

  // Scratch space for a live call (2026-11-04). Not a GitHub issue — a PM
  // or anyone else types under Dependencies, Risks, or Feedback, and cleans
  // it up into the real list later. Saved in this browser only.
  const SCRATCH_PREFIX = "baps-ndc-scratch:";

  function scratchNoteFor(p, kind) {
    try {
      const saved = localStorage.getItem(SCRATCH_PREFIX + kind + ":" + p.id);
      if (saved !== null) return saved;
    } catch (e) {
      /* ignore */
    }
    return "";
  }

  function saveScratchNote(p, kind, text) {
    try {
      localStorage.setItem(SCRATCH_PREFIX + kind + ":" + p.id, text);
    } catch (e) {
      /* ignore */
    }
  }

  function buildCallScratch(p, kind, label, placeholder) {
    const saved = scratchNoteFor(p, kind);
    const textarea = el("textarea", {
      class: "recovery-note-input" + (saved ? "" : " is-empty"),
      rows: "3",
      placeholder,
    });
    textarea.value = saved;
    const status = el("span", { class: "recovery-note-status" }, [saved ? "Saved on this browser" : ""]);
    let saveTimer = null;
    textarea.addEventListener("input", () => {
      textarea.classList.toggle("is-empty", !textarea.value.trim());
      status.textContent = "Saving…";
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveScratchNote(p, kind, textarea.value);
        status.textContent = "Saved on this browser";
      }, 400);
    });
    return el("div", { class: "recovery-note", id: kind + "-scratch" }, [
      el("div", { class: "recovery-note-head" }, [
        el("span", { class: "recovery-note-label" }, [label]),
      ]),
      textarea,
      status,
    ]);
  }

  function buildRecoveryNote(p) {
    const delayDays = p.delayDays || 0;
    if (delayDays !== 0) return null;

    const wrap = el("div", { class: "recovery-note" });
    wrap.appendChild(
      el("div", { class: "recovery-note-head" }, [
        el("span", { class: "recovery-note-chip" }, ["Total delay: 0"]),
        el("span", { class: "recovery-note-label" }, ["How did the team catch up?"]),
      ])
    );

    const saved = recoveryNoteFor(p);
    const textarea = el("textarea", {
      class: "recovery-note-input" + (saved ? "" : " is-empty"),
      rows: "3",
      placeholder: "Type how the team recovered the time lost above and still finished on schedule…",
    });
    textarea.value = saved;

    const status = el("span", { class: "recovery-note-status" }, [saved ? "Saved" : ""]);

    let saveTimer = null;
    textarea.addEventListener("input", () => {
      textarea.classList.toggle("is-empty", !textarea.value.trim());
      status.textContent = "Saving…";
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        saveRecoveryNote(p, textarea.value);
        status.textContent = "Saved";
      }, 400);
    });

    wrap.appendChild(textarea);
    wrap.appendChild(status);
    return wrap;
  }

  // Change Request Log — structured per-project log of every change
  // request (slide 8's CR process + slide 15's "five logs every project
  // maintains"). Previously CRs were only ever mentioned informally
  // inside the freeform `delayTradeoffs` text; this is the first
  // structured place to track them.
  // Full column set, matching the deck's own sample "Change Request"
  // table exactly (slide 19, same slide as the Decision Metrix table
  // below — 2026-10-15, per explicit request: "same for these... these
  // and the last two are templates on how things should be added"):
  // Change Request, Description, Submitted Date, By whom, Action Item,
  // Approved for current phase / Moved to next phase, Impact — 7
  // distinct columns, none merged into another cell (the first version
  // of this table condensed Description/Action Item into one cell).
  // Hotfix timeline (2026-11-03, GMS 1.4) — a follow-on release's own
  // stage table, shown under the Schedule timeline exactly as the PM's
  // deck lays it out: planned dates, with the post-delay date underneath
  // in red when it moved. Rows: { stage, plannedStart, actualStart,
  // plannedEnd, actualEnd, delayDays, note }.
  function buildHotfixPlan(plan) {
    const dateCell = (planned, actual) =>
      el("td", null, [
        el("div", null, [planned ? fmtDateShort(planned) : "—"]),
        actual && actual !== planned ? el("div", { class: "hotfix-plan-actual" }, [fmtDateShort(actual)]) : null,
      ]);
    const wrap = el("div", { class: "hotfix-plan" }, [
      el("h4", { class: "hotfix-plan-title" }, [plan.title || "Hotfix timeline"]),
    ]);
    const scroll = el("div", { class: "wide-log-table-scroll" });
    scroll.appendChild(
      el("table", { class: "wide-log-full-table" }, [
        el("thead", null, [el("tr", null, ["Stage", "Start", "End", "Delay (days)", "Notes"].map((c) => el("th", null, [c])))]),
        el(
          "tbody",
          null,
          plan.rows.map((r) =>
            el("tr", null, [
              el("td", { class: "wide-log-title-cell" }, [r.stage]),
              dateCell(r.plannedStart, r.actualStart),
              dateCell(r.plannedEnd, r.actualEnd),
              el("td", null, [r.delayDays ? String(r.delayDays) : "—"]),
              el("td", null, [r.note || "—"]),
            ])
          )
        ),
      ])
    );
    wrap.appendChild(scroll);
    return wrap;
  }

  // Compact list (2026-11-04): title, short summary, date, owner and
  // status per row. Click a row for every field in a popup.
  function crStatusClass(status) {
    return /approved|resolved|closed/i.test(status || "") ? "is-approved" : /pending|tbd/i.test(status || "") ? "is-pending" : "";
  }

  function buildChangeRequestLog(p) {
    const items = p.changeRequests || [];
    if (!items.length) {
      return el("p", { class: "empty-note" }, ["No change requests logged yet."]);
    }
    const list = el("div", { class: "cr-list" });
    items.forEach((cr, i) => {
      const row = el(
        "button",
        { type: "button", class: "cr-row", title: "View full details" },
        [
          el("span", { class: "cr-row-num" }, ["CR" + (i + 1)]),
          el("span", { class: "cr-row-main" }, [
            el("span", { class: "cr-row-title" }, [cr.title || "Untitled change request"]),
            cr.description ? el("span", { class: "cr-row-desc" }, [cr.description]) : null,
          ]),
          el("span", { class: "cr-row-meta" }, [
            cr.submittedDate ? fmtDateShort(cr.submittedDate) : "—",
            cr.by ? " · " + cr.by : "",
          ]),
          el("span", { class: "cr-log-status " + crStatusClass(cr.approvalStatus) }, [cr.approvalStatus || "TBD"]),
          el("span", { class: "cr-row-chevron", "aria-hidden": "true" }, ["›"]),
        ]
      );
      row.addEventListener("click", () => openItemDetail("cr", p, Object.assign({ num: i + 1 }, cr)));
      list.appendChild(row);
    });
    return list;
  }

  // Decision Log — structured per-project log of key decisions (slide 15
  // "five logs"). Distinct from Dependencies/Risks: a decision is a
  // closed-door call that was made, not an open item being tracked to
  // resolution. Full column set matching the deck's own "Decision
  // Metrix" table exactly (slide 19 — 2026-10-15, per explicit request):
  // Decision, Description, Date Taken, By whom — Description now its own
  // column instead of being merged under the Decision title.
  function buildDecisionLog(p) {
    const items = p.decisions || [];
    if (!items.length) {
      return el("p", { class: "empty-note" }, ["No decisions logged yet."]);
    }
    const cols = ["Decision", "Description", "Date Taken", "By Whom"];
    const wrap = el("div", { class: "wide-log-table-scroll" });
    wrap.appendChild(
      el("table", { class: "wide-log-full-table" }, [
        el("thead", null, [el("tr", null, cols.map((c) => el("th", null, [c])))]),
        el(
          "tbody",
          null,
          items.map((d) =>
            el("tr", null, [
              el("td", { class: "wide-log-title-cell" }, [d.decision || "—"]),
              el("td", null, [d.description || "—"]),
              el("td", null, [d.dateTaken ? fmtDateShort(d.dateTaken) : "—"]),
              el("td", null, [d.by || "—"]),
            ])
          )
        ),
      ])
    );
    return wrap;
  }

  // Delay Log — the narrative, manually-maintained companion to the
  // auto-detected schedule-shift log: root cause, who owns the follow-up,
  // what's actually been done, and whether it's closed (slide 15 "five
  // logs" + the sample Delay Log table). The auto-detected log elsewhere
  // in this tab answers "what moved and by how much"; this answers "why,
  // and who's on it." Stored under `delayItemLog`, NOT `delayLog` — that
  // name is already taken by a pre-existing, differently-shaped field
  // (per-stage incident log: date/stage/reason/team/member/days) that
  // feeds the stage detail modal's Delay Analysis/Delay Log tabs; reusing
  // it here would have silently corrupted that feature the moment either
  // field got real data.
  // Full column set, matching the deck's own sample Delay Log table
  // exactly (2026-10-15, per explicit request after seeing that table's
  // screenshot): Delayed Item, Description, Reported Date, Impacted
  // phase, Impact (Time/Cost/Scope), Root Cause, Responsible, Action
  // Item, Action Taken, Status, Closure Remarks — 11 distinct columns,
  // none merged into another cell (the first version of this table
  // condensed several of these together, and never showed Reported Date
  // at all). Real `<table>` + horizontal scroll wrapper rather than the
  // grid-row card layout used by the Change/Decision logs, since 11
  // columns side by side genuinely needs a wide table, not a card list.
  function buildDelayLogTable(p) {
    const items = p.delayItemLog || [];
    if (!items.length) {
      return el("p", { class: "empty-note" }, ["No delay log entries recorded yet."]);
    }
    const cols = [
      "Delayed Item",
      "Description",
      "Reported Date",
      "Impacted Phase",
      "Impact (Time/Cost/Scope)",
      "Root Cause",
      "Responsible",
      "Action Item",
      "Action Taken",
      "Status",
      "Closure Remarks",
    ];
    const wrap = el("div", { class: "wide-log-table-scroll" });
    wrap.appendChild(
      el("table", { class: "wide-log-full-table" }, [
        el("thead", null, [el("tr", null, cols.map((c) => el("th", null, [c])))]),
        el(
          "tbody",
          null,
          items.map((d) => {
            const statusClass = /closed|resolved/i.test(d.status || "") ? "is-closed" : "is-open";
            return el("tr", null, [
              el("td", { class: "wide-log-title-cell" }, [d.delayedItem || "—"]),
              el("td", null, [d.description || "—"]),
              el("td", null, [d.reportedDate ? fmtDateShort(d.reportedDate) : "—"]),
              el("td", null, [d.impactedPhase || "—"]),
              el("td", null, [d.impact || "—"]),
              el("td", null, [d.rootCause || "—"]),
              el("td", null, [d.responsible || "—"]),
              el("td", null, [d.actionItem || "—"]),
              el("td", null, [d.actionTaken || "—"]),
              el("td", null, [el("span", { class: "wide-log-status " + statusClass }, [d.status || "Open"])]),
              el("td", null, [d.closureRemarks || "—"]),
            ]);
          })
        ),
      ])
    );
    return wrap;
  }

  // RAID Log (Dependencies & Risks tab, 2026-10-15) — Risks, Assumptions,
  // Issues, Dependencies, as one consolidated log, matching slide 18's
  // sample table ("Weekly Status Updates" series, same slides the Delay
  // Log table came from): Item, Description, Reported Date, Action Item,
  // Targeted Completion Date, Responsible, Status, Closure Remarks.
  // Deliberately a NEW, separate field (`raidLog`) rather than
  // synthesized from the existing `risks`/`dependencies`/`escalations`
  // fields: those three stay exactly as they are (different shape, feed
  // different existing sections), and this is the first place
  // "Assumptions" can be tracked at all. The deck's own sample table has
  // no per-row Risk/Assumption/Issue/Dependency column — added one anyway
  // (`type`) per explicit request, since without it "RAID" is just a
  // label with no way to tell which letter a given row actually is.
  const RAID_TYPES = ["Risk", "Assumption", "Issue", "Dependency"];

  function buildRaidLogTable(p) {
    const items = p.raidLog || [];
    if (!items.length) {
      return el("p", { class: "empty-note" }, ["No RAID log entries recorded yet."]);
    }
    const cols = ["Type", "Item", "Description", "Reported Date", "Action Item", "Targeted Completion", "Responsible", "Status", "Closure Remarks"];
    const wrap = el("div", { class: "wide-log-table-scroll" });
    wrap.appendChild(
      el("table", { class: "wide-log-full-table raid-log-full-table" }, [
        el("thead", null, [el("tr", null, cols.map((c) => el("th", null, [c])))]),
        el(
          "tbody",
          null,
          items.map((d) => {
            const statusClass = /closed|resolved/i.test(d.status || "") ? "is-closed" : "is-open";
            const typeClass = "raid-type-" + (d.type || "risk").toLowerCase();
            return el("tr", null, [
              el("td", null, [el("span", { class: "raid-type-pill " + typeClass }, [d.type || "Risk"])]),
              el("td", { class: "wide-log-title-cell" }, [d.item || "—"]),
              el("td", null, [d.description || "—"]),
              el("td", null, [d.reportedDate ? fmtDateShort(d.reportedDate) : "—"]),
              el("td", null, [d.actionItem || "—"]),
              el("td", null, [d.targetedCompletionDate ? fmtDateShort(d.targetedCompletionDate) : "—"]),
              el("td", null, [d.responsible || "—"]),
              el("td", null, [el("span", { class: "wide-log-status " + statusClass }, [d.status || "Open"])]),
              el("td", null, [d.closureRemarks || "—"]),
            ]);
          })
        ),
      ])
    );
    return wrap;
  }

  // Feature/sprint tracker — the most granular view in the deck (slide
  // 20's live MyBKY example): every feature/capability as a row instead
  // of every project, with its own status, planned/actual dates and
  // delay reason, plus the same 7 KPI cards the deck itself leads with.
  //
  // Removed, then brought back the same day (2026-10-15): the "Features"
  // tab was pulled shortly after being added ("dont know if we need
  // features"), left dormant per the `milestones`-field precedent, then
  // explicitly restored a few turns later ("Also bring the features back
  // - lets keep those"). These functions and `data.json`'s `features`
  // field were never actually touched during the removal — only the tab
  // button/panel/jump-link wiring was removed and is now reinstated.
  // Subtitle under a KPI card — the deck's own cards all have a second
  // line of context (e.g. "Sprints 1, 2, 3 & 4" under Completed, "→
  // Phase 2" under Excluded, "→ UIUX Revisions" under Blocker), not just
  // a bare number (2026-10-15, per explicit request after an "anything
  // missing?" audit against that slide). There's no dedicated field for
  // this — auto-computed instead from whatever's already on the matching
  // items: sprint numbers if every item has one and no two share the
  // same note/delay-reason worth surfacing, otherwise the distinct
  // notes/delayReason text itself (deduped, short, since this is a
  // one-line subtitle, not another table).
  function featureKpiSubtitle(items) {
    if (!items.length) return "";
    const notes = Array.from(new Set(items.map((f) => f.delayReason || f.notes).filter(Boolean)));
    if (notes.length === 1) return notes[0];
    const sprints = Array.from(new Set(items.map((f) => f.sprint).filter((s) => s != null))).sort();
    if (sprints.length) return "Sprint" + (sprints.length === 1 ? "" : "s") + " " + sprints.join(", ");
    return "";
  }

  // Post-prod bugs (2026-11-03, GMS 1.4) — the deck's post-release
  // issue tally: an optional summary line, then one row of counts per
  // group (bugs, CRs, …) with an optional note underneath. Shape:
  // { summary, groups: [{ title, metrics: [{ label, num, tone? }], note }] }.
  // The Post-Release Issues & RCA table, when given, slots in right after
  // the first group (the bug tiles), ahead of the CR tiles.
  function buildPostProdBugs(data, issues) {
    const wrap = el("div", { class: "postprod-bugs" }, [
      el("h3", { class: "weekly-subhead", id: "postprod-bugs-section" }, ["Post-prod bugs"]),
      data.summary ? el("p", { class: "section-subhead" }, [data.summary]) : null,
    ]);
    (data.groups || []).forEach((g, i) => {
      wrap.appendChild(el("h4", { class: "hotfix-plan-title" }, [g.title]));
      const row = el("div", { class: "feature-kpi-row" });
      g.metrics.forEach((m) => {
        row.appendChild(
          el("div", { class: ["metric-card", m.tone].filter(Boolean).join(" ") }, [
            el("div", { class: "num" }, [String(m.num)]),
            el("div", { class: "label" }, [m.label]),
          ])
        );
      });
      wrap.appendChild(row);
      if (g.note) wrap.appendChild(el("p", { class: "postprod-bugs-note" }, [g.note]));
      if (i === 0 && (issues || []).length) wrap.appendChild(buildPostReleaseIssues(issues, true));
    });
    return wrap;
  }

  // Post-Release Issues & RCA (2026-11-03, GMS 1.4) — production issues
  // only, kept deliberately light: issue + one-line summary, RCA result,
  // who reported it, status. Items: { title, summary, rca, reportedBy, status }.
  function buildPostReleaseIssues(items, nested) {
    const rcaClass = (r) => (/missed/i.test(r || "") ? "is-missed" : /review|pending/i.test(r || "") ? "is-pending" : "");
    const statusClass = (s) => (/resolved|closed|done/i.test(s || "") ? "is-approved" : /wip|progress|open/i.test(s || "") ? "is-pending" : "");
    const scroll = el("div", { class: "wide-log-table-scroll" });
    scroll.appendChild(
      el("table", { class: "wide-log-full-table" }, [
        el("thead", null, [el("tr", null, ["Issue", "RCA", "Reported by", "Status"].map((c) => el("th", null, [c])))]),
        el(
          "tbody",
          null,
          items.map((it) =>
            el("tr", null, [
              el("td", null, [
                el("div", { class: "wide-log-title-cell" }, [it.title]),
                it.summary ? el("div", { class: "postrelease-summary" }, [it.summary]) : null,
              ]),
              el("td", null, [it.rca ? el("span", { class: "cr-log-status " + rcaClass(it.rca) }, [it.rca]) : "—"]),
              el("td", null, [it.reportedBy || "—"]),
              el("td", null, [el("span", { class: "cr-log-status " + statusClass(it.status) }, [it.status || "—"])]),
            ])
          )
        ),
      ])
    );
    return el("div", { class: "postrelease-issues" + (nested ? " is-nested" : "") }, [
      nested
        ? el("h4", { class: "hotfix-plan-title", id: "postrelease-issues-section" }, ["Post-Release Issues & RCA"])
        : el("h3", { class: "weekly-subhead", id: "postrelease-issues-section" }, ["Post-Release Issues & RCA"]),
      el("p", { class: "section-subhead" }, ["Production issues reported since go-live, with the root-cause result for each."]),
      scroll,
    ]);
  }

  // Every item in `p.features` with a "bug" type (e.g. "Hypercare bug") is
  // a bug, not a feature (2026-11-04, "all the one listed are bugs") —
  // split the tracker into two sub-tabs instead of one mixed table, each
  // with its own KPI counts.
  function isBugFeatureItem(f) {
    return /bug/i.test(f.type || "");
  }

  function buildFeatureKpiRow(items, opts) {
    opts = opts || {};
    const row = el("div", { class: "feature-kpi-row" });
    const totalLabel = opts.totalLabel || "Total";
    const doneLabel = opts.doneLabel || "Completed";
    const doneItems = items.filter((f) => f.status === "Done");
    const inProgressItems = items.filter((f) => f.status === "In Progress" || f.status === "Partially Done");
    const upcomingItems = items.filter((f) => f.status === "Upcoming");
    const excludedItems = items.filter((f) => f.status === "Excluded");
    const metrics = [
      { num: items.length, label: totalLabel, tone: "", sub: "" },
      { num: doneItems.length, label: doneLabel, tone: "tone-green", sub: featureKpiSubtitle(doneItems) },
      { num: inProgressItems.length, label: "In Progress", tone: "tone-amber", sub: featureKpiSubtitle(inProgressItems) },
      { num: upcomingItems.length, label: "Upcoming", tone: "tone-accent", sub: featureKpiSubtitle(upcomingItems) },
      { num: excludedItems.length, label: "Excluded", tone: "", sub: featureKpiSubtitle(excludedItems) },
    ];
    metrics.forEach((m) => {
      row.appendChild(
        el("div", { class: ["metric-card", m.tone].filter(Boolean).join(" ") }, [
          el("div", { class: "num" }, [String(m.num)]),
          el("div", { class: "label" }, [m.label]),
          m.sub ? el("div", { class: "feature-kpi-sub" }, [m.sub]) : null,
        ])
      );
    });
    return row;
  }

  // Table rebuilt (2026-10-15, per explicit request) into the deck's own
  // 7 columns exactly — SP, Type, Feature/Capability, Status, Notes,
  // Planned/Actual, Delay Reason — instead of merging Notes and Delay
  // Reason under the feature name, same wide-table treatment the other
  // 4 logs got earlier the same day.
  function buildFeatureTable(items, emptyLabel) {
    if (!items.length) return el("p", { class: "empty-note" }, [emptyLabel]);
    const cols = ["SP", "Type", "Feature / Capability", "Status", "Notes", "Planned / Actual", "Delay Reason"];
    const scroll = el("div", { class: "wide-log-table-scroll" });
    scroll.appendChild(
      el("table", { class: "wide-log-full-table feature-full-table" }, [
        el("thead", null, [el("tr", null, cols.map((c) => el("th", null, [c])))]),
        el(
          "tbody",
          null,
          items.map((f) => {
            const statusClass =
              f.status === "Done"
                ? "is-done"
                : f.status === "In Progress" || f.status === "Partially Done"
                ? "is-inprogress"
                : f.status === "Excluded"
                ? "is-excluded"
                : f.status === "Blocked"
                ? "is-blocked"
                : "is-upcoming";
            return el("tr", null, [
              el("td", null, [f.sprint != null ? String(f.sprint) : "—"]),
              el("td", null, [el("span", { class: "feature-type-tag" }, [f.type || "—"])]),
              el("td", { class: "wide-log-title-cell" }, [f.feature || "—"]),
              el("td", null, [el("span", { class: "feature-status " + statusClass }, [f.status || "Upcoming"])]),
              el("td", null, [f.notes || "—"]),
              el("td", null, [(f.plannedDate ? fmtDateShort(f.plannedDate) : "—") + " → " + (f.actualDate ? fmtDateShort(f.actualDate) : "—")]),
              el("td", null, [f.delayReason || "—"]),
            ]);
          })
        ),
      ])
    );
    return scroll;
  }

  // Reference note — the deck's own disclaimer under the Features table
  // (slide 20), generic/static rather than per-project data: a reminder
  // of what "Planned/Actual" actually measures and what still has to
  // happen before Go-Live even once every feature says "Done." Doesn't
  // apply to the Bugs sub-tab (Hypercare bugs have no Go-Live gate left).
  function buildFeatureReferenceNote() {
    return el("div", { class: "feature-reference-note" }, [
      el("div", { class: "feature-reference-note-head" }, ["⚠ Reference Note"]),
      el("ul", null, [
        el("li", null, ["Planned/Actual dates indicate Development Completion dates only; QA testing, defect fixing, and QA sign-off activities will follow"]),
        el("li", null, ["Before Go-Live, regression testing, security/performance testing, respective sign-offs, and UAT activities will be completed"]),
      ]),
    ]);
  }

  // Features and Bugs as two sub-tabs (2026-11-04, "make this features
  // and bugs ... the counts at the top should show the info on bugs and
  // features separately with tab view") instead of one mixed table and
  // one KPI row covering both — a project in Hypercare (e.g. MyBKY Phase
  // 1) can have 27 tracker rows that are ALL bugs, which used to read as
  // "27 features," 0 of them actual features.
  function buildFeatureTracker(p) {
    const items = p.features || [];
    const wrap = el("div");
    if (!items.length) {
      wrap.appendChild(el("p", { class: "empty-note" }, ["No features or bugs logged yet for this project."]));
      return wrap;
    }
    const featureItems = items.filter((f) => !isBugFeatureItem(f));
    const bugItems = items.filter(isBugFeatureItem);

    const sub = [
      { id: "features", label: "Features", items: featureItems },
      { id: "bugs", label: "Bugs", items: bugItems },
    ];
    // Default to whichever sub-tab actually has rows, favoring Features —
    // a Hypercare project with 0 features and 27 bugs opens on Bugs
    // instead of an empty Features table.
    let active = featureItems.length ? "features" : bugItems.length ? "bugs" : "features";

    const toggle = el(
      "div",
      { class: "feature-subtabs", role: "tablist" },
      sub.map((s) =>
        el("button", { type: "button", class: "feature-subtab" + (s.id === active ? " is-active" : ""), "data-subtab": s.id }, [
          s.label + " (" + s.items.length + ")",
        ])
      )
    );
    const body = el("div", { class: "feature-subtab-body" });
    wrap.appendChild(toggle);
    wrap.appendChild(body);

    function render() {
      toggle.querySelectorAll(".feature-subtab").forEach((btn) => {
        btn.classList.toggle("is-active", btn.getAttribute("data-subtab") === active);
      });
      body.innerHTML = "";
      if (active === "features") {
        body.appendChild(buildFeatureKpiRow(featureItems, { totalLabel: "Total Features", doneLabel: "Completed" }));
        body.appendChild(buildFeatureTable(featureItems, "No features logged yet for this project."));
        if (featureItems.length) body.appendChild(buildFeatureReferenceNote());
      } else {
        body.appendChild(buildFeatureKpiRow(bugItems, { totalLabel: "Total Bugs", doneLabel: "Fixed" }));
        body.appendChild(buildFeatureTable(bugItems, "No bugs logged yet for this project."));
      }
    }
    toggle.querySelectorAll(".feature-subtab").forEach((btn) => {
      btn.addEventListener("click", () => {
        active = btn.getAttribute("data-subtab");
        render();
      });
    });
    render();

    return wrap;
  }

  // Hawk-eye has two views. Roadmap is the month grid the PMO keeps in its
  // planning sheet: one column per month, the stages running in it, with a
  // Planned and an Actual row per project. Timeline is the day-accurate bar
  // chart.
  const HAWKEYE_VIEWS = [
    { id: "roadmap", label: "Roadmap" },
    { id: "v2", label: "2.0" },
    { id: "timeline", label: "Timeline" },
  ];
  let hawkeyeView = "roadmap";
  // Roadmap row set: both month rows, or one timeline row of Actual, or one
  // timeline row of Planned.
  let hawkeyeRoadmapMode = "both";

  // Roadmap column granularity — a separate zoom from the Timeline view's
  // day-pixel density below. Columns shrink from a 3-month bucket down to
  // a week so stage chips get more room and their dates/delays stop
  // getting truncated (2026-11-08: "zoom in ... goes from 3months to
  // 2 months to 1 month and then ... weeks but not days"). Order here IS
  // the zoom-in direction: wider buckets first, narrower (more granular)
  // last.
  const HAWKEYE_ROADMAP_ZOOM_ORDER = ["halfyear", "quarter", "bimonth", "month", "week"];
  const HAWKEYE_ROADMAP_ZOOM_LABEL = {
    halfyear: "6 months",
    quarter: "3 months",
    bimonth: "2 months",
    month: "1 month",
    week: "Weeks",
  };
  const HAWKEYE_ROADMAP_ZOOM_KEY = "baps-ndc-hawkeye-roadmap-zoom";
  let hawkeyeRoadmapZoom = (() => {
    try {
      const v = localStorage.getItem(HAWKEYE_ROADMAP_ZOOM_KEY);
      return HAWKEYE_ROADMAP_ZOOM_ORDER.includes(v) ? v : "month";
    } catch (e) {
      return "month";
    }
  })();
  function setHawkeyeRoadmapZoom(id) {
    hawkeyeRoadmapZoom = id;
    try {
      localStorage.setItem(HAWKEYE_ROADMAP_ZOOM_KEY, id);
    } catch (e) {
      /* ignore */
    }
  }

  // Calendar months from `firstKey` ("YYYY-MM") through `lastKey`, then
  // bucketed to the requested zoom: unchanged for "month", N consecutive
  // months merged for "bimonth"/"quarter", or re-split into 7-day weeks.
  // Every period — whatever its width — has the same {key, start, end,
  // label, year} shape, so every renderer below treats them identically.
  function buildRoadmapPeriods(firstKey, lastKey, zoom) {
    const months = [];
    let [y, m] = firstKey.split("-").map(Number);
    for (;;) {
      const key = y + "-" + String(m).padStart(2, "0");
      const lastDay = new Date(y, m, 0).getDate();
      months.push({
        key,
        start: key + "-01",
        end: key + "-" + String(lastDay).padStart(2, "0"),
        label: HAWKEYE_MONTH_SHORT[m - 1].toUpperCase(),
        year: y,
      });
      if (key >= lastKey) break;
      m += 1;
      if (m > 12) {
        m = 1;
        y += 1;
      }
    }
    if (zoom === "month" || !zoom) return months;
    const BUCKET_SIZE = { halfyear: 6, quarter: 3, bimonth: 2 };
    if (BUCKET_SIZE[zoom]) {
      const size = BUCKET_SIZE[zoom];
      const periods = [];
      for (let i = 0; i < months.length; i += size) {
        const chunk = months.slice(i, i + size);
        const startMo = chunk[0];
        const endMo = chunk[chunk.length - 1];
        periods.push({
          key: startMo.key,
          start: startMo.start,
          end: endMo.end,
          label: chunk.length > 1 ? startMo.label + "–" + endMo.label : startMo.label,
          year: startMo.year,
        });
      }
      return periods;
    }
    // Weeks: plain 7-day buckets across the same overall span, so the
    // last week may run short rather than spilling past `months`' range.
    const periods = [];
    const lastEnd = months[months.length - 1].end;
    let cur = months[0].start;
    while (cur <= lastEnd) {
      const end = addDaysIso(cur, 6);
      periods.push({
        key: cur,
        start: cur,
        end: end > lastEnd ? lastEnd : end,
        label: fmtDateTiny(cur),
        year: Number(cur.slice(0, 4)),
      });
      cur = addDaysIso(cur, 7);
    }
    return periods;
  }

  // Generic replacements for the old exact-month-key lookups, so every
  // track-based row (Totals, single Planned/Actual, the 2.0 pair view)
  // keeps working no matter how `months` is bucketed.
  function periodIndexFor(periods, iso) {
    if (!periods.length) return 0;
    if (iso <= periods[0].start) return 0;
    if (iso >= periods[periods.length - 1].end) return periods.length - 1;
    const idx = periods.findIndex((mo) => iso >= mo.start && iso <= mo.end);
    return idx === -1 ? periods.length - 1 : idx;
  }
  function periodFrac(periods, iso) {
    if (!periods.length || !iso) return 0;
    if (iso <= periods[0].start) return 0;
    if (iso > periods[periods.length - 1].end) return 1;
    const idx = periodIndexFor(periods, iso);
    const mo = periods[idx];
    const dim = hawkeyeDaySpan(mo.start, addDaysIso(mo.end, 1));
    const dayOffset = hawkeyeRawDayDiff(mo.start, iso);
    return (idx + Math.min(Math.max(dayOffset, 0), dim) / dim) / periods.length;
  }
  function periodIsToday(mo, todayIso) {
    return todayIso >= mo.start && todayIso <= mo.end;
  }

  // Timeline densities. Half year fits the panel. Quarter (default) is
  // 1.5× that so blocks are readable; Month is the close view.
  const HAWKEYE_ZOOM = {
    half: { pxPerDay: 0.9, scale: 1, label: "Half year" },
    quarter: { pxPerDay: 1.8, scale: 1.5, label: "Quarter" },
    month: { pxPerDay: 5, scale: 1.5, label: "Month" },
  };
  const HAWKEYE_ZOOM_ORDER = ["half", "quarter", "month"];
  let hawkeyeZoom = "quarter";

  // −/+ stepper through an ordered list of zoom levels (vs. hawkeyeToggle's
  // flat set of tabs) — used for the Roadmap column granularity, where
  // "next" and "previous" are the natural gesture, not picking a tab.
  function hawkeyeZoomStepper(order, labels, current, onPick, title) {
    const idx = order.indexOf(current);
    const wrap = el("div", { class: "hawkeye-zoom-toggle hawkeye-zoom-stepper", title });
    const minus = el("button", { class: "hawkeye-zoom-btn hawkeye-zoom-step", type: "button", "aria-label": "Zoom out" }, ["−"]);
    const label = el("span", { class: "hawkeye-zoom-step-label" }, [labels[current] || current]);
    const plus = el("button", { class: "hawkeye-zoom-btn hawkeye-zoom-step", type: "button", "aria-label": "Zoom in" }, ["+"]);
    if (idx <= 0) minus.disabled = true;
    if (idx === -1 || idx >= order.length - 1) plus.disabled = true;
    minus.addEventListener("click", () => {
      if (idx > 0) onPick(order[idx - 1]);
    });
    plus.addEventListener("click", () => {
      if (idx !== -1 && idx < order.length - 1) onPick(order[idx + 1]);
    });
    wrap.appendChild(minus);
    wrap.appendChild(label);
    wrap.appendChild(plus);
    return wrap;
  }

  function hawkeyeToggle(options, onPick, title) {
    return el(
      "div",
      { class: "hawkeye-zoom-toggle", role: "tablist", title },
      options.map((o) => {
        const btn = el(
          "button",
          {
            class: "hawkeye-zoom-btn" + (o.active ? " is-active" : ""),
            type: "button",
            role: "tab",
            "aria-selected": o.active ? "true" : "false",
          },
          [o.label]
        );
        btn.addEventListener("click", () => {
          if (!o.active) onPick(o.id);
        });
        return btn;
      })
    );
  }

  // Roadmap stage names and colours follow the PMO planning sheet.
  const ROADMAP_STAGE = {
    Proposal: { code: "PROP", cls: "is-req" },
    Requirements: { code: "REQ", cls: "is-req" },
    "Tech. Design": { code: "DSGN", cls: "is-dsgn" },
    "Estimate & Planning": { code: "E&P", cls: "is-dsgn" },
    Development: { code: "DEV", cls: "is-dev" },
    UAT: { code: "UAT", cls: "is-uat" },
    VAPT: { code: "VAPT", cls: "is-uat" },
    Load: { code: "LOAD", cls: "is-uat" },
    Rollout: { code: "ROLLOUT", cls: "is-rollout" },
    Hypercare: { code: "HC", cls: "is-hc" },
  };

  function roadmapStage(b) {
    return ROADMAP_STAGE[b.stage] || { code: b.code || String(b.label || b.stage).slice(0, 4).toUpperCase(), cls: "is-other" };
  }

  function hawkeyeRoadmapLegend() {
    const swatch = (cls, text) =>
      el("span", { class: "stagegantt-legend-item" }, [el("span", { class: "roadmap-swatch " + cls }), text]);
    return el("div", { class: "stagegantt-legend hawkeye-legend" }, [
      swatch("is-req", "Requirements"),
      swatch("is-dsgn", "Design"),
      swatch("is-dev", "Development"),
      swatch("is-uat", "UAT / VAPT / Load"),
      swatch("is-rollout", "Rollout"),
      swatch("is-hc", "Hypercare"),
      swatch("is-late", "Running past its plan"),
    ]);
  }

  // Totals mode colors by overall project status, not by stage, so it
  // gets its own small legend instead of the stage one above.
  function hawkeyeTotalsLegend() {
    const swatch = (cls, text) =>
      el("span", { class: "stagegantt-legend-item" }, [el("span", { class: "roadmap-swatch roadmap-total-swatch " + cls }), text]);
    return el("div", { class: "stagegantt-legend hawkeye-legend" }, [
      swatch("is-green", "On track"),
      swatch("is-amber", "At risk"),
      swatch("is-red", "Critical"),
      swatch("is-late", "Delayed vs. its own plan"),
      el("span", { class: "stagegantt-legend-item hawkeye-totals-hint" }, ["Click a bar to open that project"]),
    ]);
  }

  // Month grid: every month from the earliest to the latest stage date
  // across the visible projects. A stage shows in each month it runs in.
  // On the Actual row, a stage running in a month after its planned end is
  // red, and the month it finished carries the weekday slip (+Nd) or the
  // time saved (−Nd).
  function buildHawkeyeRoadmap(rows, todayIso) {
    const monthKey = (iso) => iso.slice(0, 7);
    let first = null;
    let last = null;
    rows.forEach(({ actual, planned }) => {
      actual.concat(planned).forEach((b) => {
        const s = monthKey(b.start);
        const e = monthKey(b.end);
        if (!first || s < first) first = s;
        if (!last || e > last) last = e;
      });
    });
    if (!last || last < "2027-08") last = "2027-08";
    const months = buildRoadmapPeriods(first, last, hawkeyeRoadmapZoom);

    const mode = hawkeyeView === "v2" ? "both" : hawkeyeRoadmapMode;
    // Zooming all the way out to the 3-month view collapses every row to
    // one start-to-finish bar — the same idea as the manual Totals toggle
    // — instead of cramming a full stage breakdown into a column that's
    // 3 months wide. Zooming in brings the stage chips back, then their
    // dates, then delay badges: "zoom out -> one bar - then things show
    // up and then delays show up" (2026-11-08).
    const zoomTier = HAWKEYE_ROADMAP_ZOOM_ORDER.indexOf(hawkeyeRoadmapZoom);
    // Tiers (0..4): halfyear, quarter, bimonth, month, week. The two most
    // zoomed-out levels (6 and 3 months) collapse to one bar; bimonth
    // brings stage chips back (no dates yet); month adds dates; week adds
    // the delay badge.
    const autoCollapsed = hawkeyeView !== "v2" && zoomTier <= 1 && mode !== "totals";
    const effectiveMode = autoCollapsed ? "totals" : mode;
    const showDates = zoomTier >= 3; // month or week
    const showDelayBadge = zoomTier >= 4; // week only
    const showBoth = effectiveMode === "both";
    const showKind = showBoth && hawkeyeView !== "v2";
    const table = el("table", { class: "roadmap-table" + (showKind ? "" : " is-actual-only") });
    const yearRow = el("tr", { class: "roadmap-year-row" }, [
      el("th", { class: "roadmap-sticky roadmap-name-col", colspan: showKind ? "2" : "1" }, [""]),
    ]);
    let i = 0;
    while (i < months.length) {
      let j = i;
      while (j < months.length && months[j].year === months[i].year) j++;
      yearRow.appendChild(el("th", { class: "roadmap-year", colspan: String(j - i) }, [String(months[i].year)]));
      i = j;
    }
    const headRow = el("tr", null, [
      el("th", { class: "roadmap-sticky roadmap-name-col" }, ["Project"]),
      showKind ? el("th", { class: "roadmap-sticky roadmap-kind-col" }, [""]) : null,
    ]);
    months.forEach((mo) => headRow.appendChild(el("th", { class: "roadmap-month" + (periodIsToday(mo, todayIso) ? " is-today" : "") }, [mo.label])));
    table.appendChild(el("thead", null, [yearRow, headRow]));

    const tbody = el("tbody");
    rows.forEach(({ p, actual, planned }) => {
      if (!actual.length) return;
      const delay = Math.max(0, p.delayDays || 0);
      const nameCell = el("td", { class: "roadmap-sticky roadmap-name-col roadmap-name", rowspan: showBoth && hawkeyeView !== "v2" ? "2" : "1" }, [
        el("button", { class: "roadmap-project", type: "button", title: `Open ${p.name}'s Stage-gate timeline` }, [p.name]),
        el("div", { class: "roadmap-project-meta" }, [p.owner || ""]),
        el("div", { class: "roadmap-project-meta" + (delay > 0 ? " is-late" : "") }, [
          (p.goLive ? "Go-Live " + fmtDateShort(p.goLive) : "No go-live yet") + (delay > 0 ? " · +" + delay + "d" : " · on plan"),
        ]),
      ]);
      nameCell.querySelector(".roadmap-project").addEventListener("click", () => openProjectDetail(p.id, "stage-gate-timeline-section"));


      const cellsFor = (blocks, isActual) =>
        months.map((mo) => {
          const inMonth = blocks.filter((b) => b.start <= mo.end && b.end >= mo.start);
          const td = el("td", { class: "roadmap-cell" + (periodIsToday(mo, todayIso) ? " is-today" : "") });
          inMonth.forEach((b) => {
            const st = roadmapStage(b);
            let text = st.code;
            let late = false;
            let tip = b.label + (isActual ? " (actual): " : " (planned): ") + fmtDateShort(b.start) + " → " + fmtDateShort(b.end);
            let delayNote = null;
            if (isActual && b.plannedEnd) {
              if (mo.start > b.plannedEnd && b.end > b.plannedEnd) late = true;
              if (b.end >= mo.start && b.end <= mo.end && b.end !== b.plannedEnd) {
                const d = businessDaysBetweenIso(b.plannedEnd, b.end);
                if (d > 0) {
                  delayNote = "+" + d + "d";
                  late = true;
                  tip += " · +" + d + " weekdays past " + fmtDateShort(b.plannedEnd);
                } else if (d < 0) {
                  delayNote = "−" + -d + "d";
                  tip += " · " + -d + " weekdays early vs " + fmtDateShort(b.plannedEnd);
                }
              }
            }
            const dateLabel = fmtDateShort(b.start) + " – " + fmtDateShort(b.end);
            const cls =
              "roadmap-chip " +
              st.cls +
              (isActual ? "" : " is-planned") +
              (late ? " is-late" : "") +
              (isActual && b.kind === "current" ? " is-current" : "") +
              (isActual && b.kind === "future" ? " is-future" : "");
            const chip = el("span", { class: cls, title: tip }, [
              el("span", { class: "roadmap-chip-code" }, [text, showDelayBadge && delayNote ? " " + delayNote : ""]),
              showDates ? el("span", { class: "roadmap-chip-date" }, [dateLabel]) : null,
            ]);
            if (isActual) {
              chip.setAttribute("role", "button");
              chip.setAttribute("tabindex", "0");
              chip.addEventListener("click", () => openStageDetail(p.id, b.stage));
            }
            td.appendChild(chip);
          });
          return td;
        });

      const timelineCell = (blocks, isActual) => {
        const frac = (iso) => periodFrac(months, iso);
        const laneRight = [];
        const placed = blocks
          .slice()
          .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : hawkeyeStageIndex(a.stage) - hawkeyeStageIndex(b.stage)))
          .map((b) => {
            const left = frac(b.start);
            const right = Math.max(frac(addDaysIso(b.end, 1)), left + 0.008);
            const days = isActual && b.plannedEnd && b.end !== b.plannedEnd ? businessDaysBetweenIso(b.plannedEnd, b.end) : 0;
            const note = days > 0 ? " +" + days + "d" : days < 0 ? " −" + -days + "d" : "";
            const st = roadmapStage(b);
            const label = st.code + note + "  " + fmtDateShort(b.start) + " – " + fmtDateShort(b.end);
            // Keep the next bar off this label. A short stage still needs
            // room for its name and dates.
            const labelFrac = (label.length * 6.4 + 16) / Math.max(months.length * 132, 1);
            const occupyRight = Math.max(right, left + labelFrac);
            let lane = laneRight.findIndex((r) => left >= r - 0.001);
            if (lane === -1) {
              lane = laneRight.length;
              laneRight.push(occupyRight);
            } else laneRight[lane] = occupyRight;
            return { b, left, right, lane, note, days, st };
          });
        const laneH = 40;
        const track = el("div", { class: "roadmap-track", style: `height:${Math.max(laneRight.length, 1) * laneH + 8}px` });
        months.forEach((mo, idx) => {
          if (!idx) return;
          track.appendChild(
            el("div", {
              class: "roadmap-track-line" + (periodIsToday(mo, todayIso) ? " is-today" : ""),
              style: `left:${(idx / months.length) * 100}%`,
            })
          );
        });
        const todayFrac = frac(todayIso);
        if (todayFrac > 0 && todayFrac < 1) {
          track.appendChild(el("div", { class: "roadmap-track-today", style: `left:${todayFrac * 100}%` }));
        }
        placed.forEach(({ b, left, right, lane, note, days, st }) => {
          const late = days > 0;
          const tip =
            b.label +
            (isActual ? " (actual): " : " (planned): ") +
            fmtDateShort(b.start) +
            " → " +
            fmtDateShort(b.end) +
            (late ? " · +" + days + " weekdays past " + fmtDateShort(b.plannedEnd) : "");
          const bar = el(
            "div",
            {
              class:
                "roadmap-bar roadmap-chip " +
                st.cls +
                (isActual ? "" : " is-planned") +
                (late ? " is-late" : "") +
                (isActual && b.kind === "current" ? " is-current" : "") +
                (isActual && b.kind === "future" ? " is-future" : ""),
              style: `left:${left * 100}%;width:${(right - left) * 100}%;top:${4 + lane * laneH}px`,
              title: tip,
              role: "button",
              tabindex: "0",
            },
            [
              el("span", { class: "roadmap-chip-code" }, [st.code + (showDelayBadge ? note : "")]),
              showDates ? el("span", { class: "roadmap-chip-date" }, [fmtDateShort(b.start) + " – " + fmtDateShort(b.end)]) : null,
            ]
          );
          const open = () => openStageDetail(p.id, b.stage);
          bar.addEventListener("click", open);
          bar.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              open();
            }
          });
          track.appendChild(bar);
        });
        return el("td", { class: "roadmap-track-cell", colspan: String(months.length) }, [track]);
      };

      // Totals: no stages at all, one bar from the project's earliest
      // start to its latest finish, labelled with just those two dates
      // (2026-11-08: "if I collapse I can see just the timeline of the
      // full projects, no details just the start and the finish ... so I
      // can know what capacity planning I can do"). Reuses the Actual
      // row's month-fraction math from `timelineCell` so it lines up with
      // every other roadmap row on the same grid.
      const totalsCell = (blocks, showDates = true) => {
        const frac = (iso) => periodFrac(months, iso);
        const laneH = 34;
        const track = el("div", { class: "roadmap-track roadmap-track-totals", style: `height:${laneH + 8}px` });
        months.forEach((mo, idx) => {
          if (!idx) return;
          track.appendChild(
            el("div", {
              class: "roadmap-track-line" + (periodIsToday(mo, todayIso) ? " is-today" : ""),
              style: `left:${(idx / months.length) * 100}%`,
            })
          );
        });
        const todayFrac = frac(todayIso);
        if (todayFrac > 0 && todayFrac < 1) {
          track.appendChild(el("div", { class: "roadmap-track-today", style: `left:${todayFrac * 100}%` }));
        }
        if (!blocks.length) return el("td", { class: "roadmap-track-cell", colspan: String(months.length) }, [track]);
        let start = blocks[0].start;
        let end = blocks[0].end;
        blocks.forEach((b) => {
          if (b.start < start) start = b.start;
          if (b.end > end) end = b.end;
        });
        const left = frac(start);
        const right = Math.max(frac(addDaysIso(end, 1)), left + 0.01);
        const delay = Math.max(0, p.delayDays || 0);
        const statusCls = p.status === "red" ? "is-red" : p.status === "amber" ? "is-amber" : "is-green";
        const bar = el(
          "div",
          {
            class: "roadmap-total-bar " + statusCls + (delay > 0 ? " is-late" : ""),
            style: `left:${left * 100}%;width:${(right - left) * 100}%;top:4px;height:${laneH}px`,
            title: p.name + ": " + fmtDateShort(start) + " → " + fmtDateShort(end) + (delay > 0 ? " · +" + delay + "d vs plan" : ""),
            role: "button",
            tabindex: "0",
          },
          showDates
            ? [
                el("span", { class: "roadmap-total-date is-start" }, [fmtDateShort(start)]),
                el("span", { class: "roadmap-total-date is-end" }, [fmtDateShort(end)]),
              ]
            : []
        );
        const open = () => openProjectDetail(p.id, "stage-gate-timeline-section");
        bar.addEventListener("click", open);
        bar.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            open();
          }
        });
        track.appendChild(bar);
        return el("td", { class: "roadmap-track-cell", colspan: String(months.length) }, [track]);
      };

      if (effectiveMode === "totals") {
        tbody.appendChild(
          el("tr", { class: "roadmap-row is-actual-row is-totals-row" }, [nameCell, totalsCell(actual)])
        );
        return;
      }

      // View 2.0: one track. Each stage is a pair — its planned bar
      // directly above its actual bar. Overlapping stages step down.
      const pairTimelineCell = () => {
        const frac = (iso) => periodFrac(months, iso);
        const groups = new Map();
        const order = [];
        const add = (b, kind) => {
          if (!groups.has(b.stage)) {
            groups.set(b.stage, { stage: b.stage, planned: null, actual: null });
            order.push(b.stage);
          }
          const g = groups.get(b.stage);
          if (!g[kind]) g[kind] = b;
        };
        planned.forEach((b) => add(b, "planned"));
        actual.forEach((b) => add(b, "actual"));
        const spanOf = (b) => {
          const left = frac(b.start);
          return { left, right: Math.max(frac(addDaysIso(b.end, 1)), left + 0.008) };
        };
        const pairs = order
          .map((stage) => {
            const g = groups.get(stage);
            const ps = g.planned ? spanOf(g.planned) : null;
            const as = g.actual ? spanOf(g.actual) : null;
            const left = Math.min(ps ? ps.left : 1, as ? as.left : 1);
            const right = Math.max(ps ? ps.right : 0, as ? as.right : 0);
            const src = g.actual || g.planned;
            const st = roadmapStage(src);
            const days = g.actual && g.actual.plannedEnd && g.actual.end !== g.actual.plannedEnd ? businessDaysBetweenIso(g.actual.plannedEnd, g.actual.end) : 0;
            const note = days > 0 ? " +" + days + "d" : days < 0 ? " −" + -days + "d" : "";
            const planLabel = g.planned ? st.code + "  " + fmtDateShort(g.planned.start) + " – " + fmtDateShort(g.planned.end) : "";
            const actLabel = g.actual ? st.code + note + "  " + fmtDateShort(g.actual.start) + " – " + fmtDateShort(g.actual.end) : "";
            const labelFrac = (Math.max(planLabel.length, actLabel.length) * 6.4 + 16) / Math.max(months.length * 132, 1);
            return { ...g, st, ps, as, left, right, occupyRight: Math.max(right, left + labelFrac), days, note, start: src.start };
          })
          .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : hawkeyeStageIndex(a.stage) - hawkeyeStageIndex(b.stage)));
        const laneRight = [];
        pairs.forEach((pair) => {
          let lane = laneRight.findIndex((r) => pair.left >= r - 0.001);
          if (lane === -1) {
            lane = laneRight.length;
            laneRight.push(pair.occupyRight);
          } else laneRight[lane] = pair.occupyRight;
          pair.lane = lane;
        });
        const barH = 30;
        const pairGap = 2;
        const laneH = barH * 2 + pairGap + 10;
        const track = el("div", { class: "roadmap-track", style: `height:${Math.max(laneRight.length, 1) * laneH + 8}px` });
        months.forEach((mo, idx) => {
          if (!idx) return;
          track.appendChild(
            el("div", {
              class: "roadmap-track-line" + (periodIsToday(mo, todayIso) ? " is-today" : ""),
              style: `left:${(idx / months.length) * 100}%`,
            })
          );
        });
        const todayFrac = frac(todayIso);
        if (todayFrac > 0 && todayFrac < 1) {
          track.appendChild(el("div", { class: "roadmap-track-today", style: `left:${todayFrac * 100}%` }));
        }
        const makeBar = (b, isActual, box, top, note, days, st) => {
          const late = isActual && days > 0;
          const codeText = st.code + (isActual ? note : "");
          const dateText = fmtDateShort(b.start) + " – " + fmtDateShort(b.end);
          const minPx = Math.ceil((codeText + "  " + dateText).length * 6.4 + 16);
          const tip =
            b.label +
            (isActual ? " (actual): " : " (planned): ") +
            fmtDateShort(b.start) +
            " → " +
            fmtDateShort(b.end) +
            (late ? " · +" + days + " weekdays past " + fmtDateShort(b.plannedEnd) : "");
          const bar = el(
            "div",
            {
              class:
                "roadmap-bar roadmap-chip " +
                st.cls +
                (isActual ? " is-pair-actual" : " is-planned is-pair-plan") +
                (late ? " is-late" : "") +
                (isActual && b.kind === "current" ? " is-current" : "") +
                (isActual && b.kind === "future" ? " is-future" : ""),
              style: `left:${box.left * 100}%;width:${(box.right - box.left) * 100}%;min-width:${minPx}px;top:${top}px;height:${barH}px`,
              title: tip,
              role: "button",
              tabindex: "0",
            },
            [
              el("span", { class: "roadmap-chip-code" }, [codeText]),
              el("span", { class: "roadmap-chip-date" }, [dateText]),
            ]
          );
          const open = () => openStageDetail(p.id, b.stage);
          bar.addEventListener("click", open);
          bar.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              open();
            }
          });
          return bar;
        };
        pairs.forEach((pair) => {
          const top = 4 + pair.lane * laneH;
          if (pair.planned && pair.actual) {
            track.appendChild(makeBar(pair.planned, false, pair.ps, top, "", 0, pair.st));
            track.appendChild(makeBar(pair.actual, true, pair.as, top + barH + pairGap, pair.note, pair.days, pair.st));
          } else if (pair.planned) {
            track.appendChild(makeBar(pair.planned, false, pair.ps, top, "", 0, pair.st));
          } else if (pair.actual) {
            track.appendChild(makeBar(pair.actual, true, pair.as, top, pair.note, pair.days, pair.st));
          }
        });
        return el("td", { class: "roadmap-track-cell", colspan: String(months.length) }, [track]);
      };

      if (showBoth && hawkeyeView !== "v2") {
        tbody.appendChild(
          el("tr", { class: "roadmap-row is-planned-row" }, [
            nameCell,
            el("td", { class: "roadmap-sticky roadmap-kind-col roadmap-kind" }, ["Planned"]),
            ...cellsFor(planned, false),
          ])
        );
        tbody.appendChild(
          el("tr", { class: "roadmap-row is-actual-row" }, [
            el("td", { class: "roadmap-sticky roadmap-kind-col roadmap-kind" }, ["Actual"]),
            ...cellsFor(actual, true),
          ])
        );
        return;
      }

      if (showBoth) {
        tbody.appendChild(
          el("tr", { class: "roadmap-row is-merged-row" }, [nameCell, pairTimelineCell()])
        );
        return;
      }

      tbody.appendChild(
        el("tr", { class: "roadmap-row is-actual-row" }, [nameCell, timelineCell(mode === "actual" ? actual : planned, mode === "actual")])
      );
    });
    table.appendChild(tbody);

    const wrap = el("div", { class: "roadmap-scroll" }, [table]);
    requestAnimationFrame(() => {
      const todayTh = table.querySelector("th.roadmap-month.is-today");
      if (!todayTh) return;
      const kindCol = table.querySelector(".roadmap-kind-col");
      const stickyW = table.querySelector(".roadmap-name-col").offsetWidth + (kindCol ? kindCol.offsetWidth : 0);
      wrap.scrollLeft = Math.max(0, todayTh.offsetLeft - stickyW - (wrap.clientWidth - stickyW) * 0.6);
    });
    return wrap;
  }

  // Six months before the first date, so the chart can scroll back and a
  // project can sit in the middle of the panel instead of on the left edge.
  function hawkeyeMonthsEarlier(timeMs, months) {
    const d = new Date(timeMs);
    d.setMonth(d.getMonth() - months);
    return d.getTime();
  }

  // Every stage block for one project's Hawk-eye row (2026-11-04, "I want
  // to see every stage - and every block but in one row"). Same dates as
  // the step-ladder (`stageLaneBlocks`), plus any extra stage the PM
  // tracks in `stageDateOrder` (Load on MyBKY Phase 1). `slipped` is the
  // same plan-vs-latest comparison as the Stage Dates table: the block
  // runs to the revised end, and the part past `initialEnd` is the red
  // delay.
  function hawkeyeStageBlocks(p) {
    const today = todayISO();
    const blocks = stageLaneBlocks(p).map((b) => ({
      stage: b.stage,
      label: b.label,
      code: STAGE_SHORT_CODE[b.stage] || String(b.label || b.stage).slice(0, 3).toUpperCase(),
      start: b.start,
      end: b.end,
      plannedEnd: b.plannedEnd || null,
      kind: b.kind,
      slipped: !!(b.plannedEnd && b.end > b.plannedEnd),
      saved: !!(b.plannedEnd && b.end < b.plannedEnd),
    }));
    const seen = {};
    blocks.forEach((b) => {
      seen[b.stage] = true;
    });
    const order = p.stageDateOrder || [];
    const currentIdx = order.findIndex((row) => (row.stage || row) === p.stage);
    order.forEach((row, i) => {
      const stage = row.stage || row;
      if (seen[stage]) return;
      const plan = (p.stagePlan && p.stagePlan[stage]) || {};
      const start = plan.latestStart || plan.initialStart;
      const end = plan.latestEnd || plan.initialEnd;
      if (!start || !end || end < start) return;
      const kind = currentIdx === -1 ? (end < today ? "done" : start <= today ? "current" : "future") : i < currentIdx ? "done" : i === currentIdx ? "current" : "future";
      blocks.push({
        stage,
        label: row.label || stage,
        code: STAGE_SHORT_CODE[stage] || String(row.label || stage).slice(0, 3).toUpperCase(),
        start,
        end,
        plannedEnd: plan.initialEnd || null,
        kind,
        slipped: !!(plan.initialEnd && end > plan.initialEnd),
        saved: !!(plan.initialEnd && end < plan.initialEnd),
      });
    });
    return blocks.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  }

  // The PLANNED counterpart to `hawkeyeStageBlocks()` — every stage's own
  // never-revised baseline (`initialStart`/`initialEnd`), same stage
  // set/labels/codes as the Actual blocks passed in, so the Planned row
  // lines up stage-for-stage with the Actual row underneath it
  // (2026-11-04: "one row show blocks on each stage ... which show start
  // and end dates (planned) and then one row shows the same but ...
  // actual row ... with the days showing the block in red"). A stage with
  // no baseline on record (e.g. the current stage, still missing an end
  // date) just has no block here — not guessed.
  function hawkeyeStagePlannedBlocks(p, actualBlocks) {
    return actualBlocks
      .map((b) => {
        const plan = (p.stagePlan && p.stagePlan[b.stage]) || {};
        const start = plan.initialStart;
        const end = plan.initialEnd;
        return start && end && end >= start ? { stage: b.stage, label: b.label, code: b.code, start, end } : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  }

  function hawkeyeStageIndex(stage) {
    if (stage === "Load") return PIPELINE_STAGES.indexOf("VAPT") + 0.5;
    const i = PIPELINE_STAGES.indexOf(stage);
    return i === -1 ? 50 : i;
  }

  function hawkeyeRawDayDiff(aIso, bIso) {
    const DAY = 86400000;
    return Math.round((new Date(bIso + "T00:00:00").getTime() - new Date(aIso + "T00:00:00").getTime()) / DAY);
  }

  function hawkeyeDaySpan(aIso, bIso) {
    return Math.max(1, hawkeyeRawDayDiff(aIso, bIso));
  }

  // One row, laid out from that row's own dates (2026-11-04). Planned and
  // Actual are computed separately: a delay on Actual must not widen a
  // shared column and open a hole in Planned before the next stage. The
  // plan started when it was planned — earlier — and the overrun stays on
  // the Actual row, in red. Pass the row's blocks as `planned` and leave
  // `actual` empty. For the Actual row, a stage that finished early is
  // passed with its end extended to the planned end so the green "time
  // saved" tail has room; that extension does not touch the Planned row.
  // Stages that overlap each other on THIS row still share one packed
  // window and sit side by side inside it. A stage that doesn't overlap
  // anyone sits on its own real dates.
  function computeHawkeyeStageColumns(planned, actual, xPx) {
    const byStage = {};
    planned.forEach((b) => {
      (byStage[b.stage] = byStage[b.stage] || {}).planned = b;
    });
    actual.forEach((b) => {
      (byStage[b.stage] = byStage[b.stage] || {}).actual = b;
    });
    const stages = Object.keys(byStage)
      .map((stage) => {
        const row = byStage[stage];
        const starts = [row.planned && row.planned.start, row.actual && row.actual.start].filter(Boolean).sort();
        const ends = [row.planned && row.planned.end, row.actual && row.actual.end].filter(Boolean).sort();
        if (!starts.length || !ends.length) return null;
        // A stage runs through the END of its last day, so it is drawn to
        // the start of the next day (2026-11-05). Otherwise a stage ending
        // on the 15th and the next starting on the 16th had a visible gap.
        return { stage, start: starts[0], end: addDaysIso(ends[ends.length - 1], 1), order: hawkeyeStageIndex(stage) };
      })
      .filter(Boolean)
      .sort((a, b) => (a.start !== b.start ? (a.start < b.start ? -1 : 1) : a.order - b.order));

    const clusters = [];
    stages.forEach((s) => {
      const last = clusters[clusters.length - 1];
      if (!last || s.start >= last.end) {
        clusters.push({ start: s.start, end: s.end, items: [s] });
      } else {
        if (s.end > last.end) last.end = s.end;
        last.items.push(s);
      }
    });

    // A weekend between one stage's end and the next stage's start is not
    // a gap in the plan. Close it when only Saturday/Sunday lie between.
    clusters.forEach((c, i) => {
      const next = clusters[i + 1];
      c.drawEnd = c.end;
      if (!next || next.start <= c.end) return;
      let onlyWeekend = true;
      for (let d = c.end; d < next.start; d = addDaysIso(d, 1)) {
        const dow = new Date(d + "T00:00:00").getDay();
        if (dow !== 0 && dow !== 6) {
          onlyWeekend = false;
          break;
        }
      }
      if (onlyWeekend) c.drawEnd = next.start;
    });

    const columns = {};
    clusters.forEach((c) => {
      c.items.sort((a, b) => a.order - b.order);
      // Stages that ran in parallel sit flush against each other, so the
      // row has no empty space where the plan has none.
      const natural = Math.max(xPx(c.drawEnd) - xPx(c.start), 4);
      const spanOf = (s) => hawkeyeDaySpan(s.start, s.end === c.end ? c.drawEnd : s.end);
      const totalDays = c.items.reduce((sum, s) => sum + spanOf(s), 0);
      let left = xPx(c.start);
      c.items.forEach((s) => {
        const w = Math.max((spanOf(s) / totalDays) * natural, 2);
        const reachesEnd = s.end === c.end;
        columns[s.stage] = {
          leftPx: left,
          widthPx: w,
          unionStart: s.start,
          unionEnd: reachesEnd ? c.drawEnd : s.end,
          itemEnd: s.end,
        };
        left += w;
      });
    });
    return columns;
  }

  function mapWithinHawkeyeColumn(iso, column) {
    const span = Math.max(1, hawkeyeRawDayDiff(column.unionStart, column.unionEnd));
    const offset = hawkeyeRawDayDiff(column.unionStart, iso);
    return column.leftPx + (offset / span) * column.widthPx;
  }

  // Places a stage's own bar inside its shared column (narrower than the
  // column on whichever side ran shorter), then marks the leftover: past
  // the bar's own end but still inside the column is either a red
  // overrun (planned end fell before the bar's real end — the bar IS the
  // longer, column-defining one) or a green "time saved" ghost (planned
  // end falls AFTER the bar's real end — the bar finished before the
  // column's full width, 2026-11-04: "I do want to see how much time we
  // saved along with delays too").
  function assignHawkeyeColumnPositions(blocks, columns) {
    blocks.forEach((b) => {
      const column = columns[b.stage];
      if (!column) {
        b.leftPx = 0;
        b.widthPx = 2;
        return;
      }
      const left = mapWithinHawkeyeColumn(b.start, column);
      // Draw through the end of the last day. A block that reaches the
      // column's end also takes the closed-over weekend.
      const endNext = addDaysIso(b.end, 1);
      const right = mapWithinHawkeyeColumn(endNext === column.itemEnd ? column.unionEnd : endNext, column);
      b.leftPx = left;
      b.widthPx = Math.max(right - left, 2);
      b.delayLeftPx = null;
      b.delayWidthPx = 0;
      b.savedLeftPx = null;
      b.savedWidthPx = 0;
      if (!b.plannedEnd || b.plannedEnd === b.end) return;
      const markerPx = mapWithinHawkeyeColumn(addDaysIso(b.plannedEnd, 1), column);
      const blockRight = left + b.widthPx;
      if (b.plannedEnd < b.end) {
        // A stage that started after its own planned end is late for its
        // whole length. Red starts at the block, never to the left of it,
        // where it would run over the stages before.
        const delayLeft = Math.max(markerPx, left);
        b.delayLeftPx = delayLeft;
        b.delayWidthPx = Math.max(blockRight - delayLeft, 2);
      } else {
        b.savedLeftPx = blockRight;
        b.savedWidthPx = Math.max(markerPx - blockRight, 2);
      }
    });
  }

  // One row — Planned or Actual — of every stage block, label sticky to
  // the left so it stays readable while the timeline scrolls sideways.
  // The Planned row is a plain dashed outline per stage (no color-coding,
  // no red — it's just the baseline). The Actual row keeps the
  // done/current/future coloring plus the red overrun segment for any
  // stage that ran past ITS OWN planned end. Blocks are already placed
  // side by side by `layoutHawkeyeSideBySide`.
  // Block text. Compact rows show the stage code; an expanded project
  // shows the full stage name when it fits, plus its dates.
  function hawkeyeBlockContent(b, width, large) {
    if (!large) {
      if (width < 24) return [""];
      const tiny = width >= 58 ? fmtDateTiny(b.start) + "–" + fmtDateTiny(b.end) : null;
      return [
        el("span", { class: "hawkeye-block-name" }, [b.code]),
        tiny ? el("span", { class: "hawkeye-block-dates is-inline" }, [tiny]) : null,
      ];
    }
    const name = width >= b.label.length * 7.2 + 16 ? b.label : width >= 24 ? b.code : "";
    const dates =
      width >= 96
        ? fmtDateShort(b.start) + " – " + fmtDateShort(b.end)
        : width >= 46
        ? fmtDateTiny(b.start) + "–" + fmtDateTiny(b.end)
        : null;
    return [
      el("span", { class: "hawkeye-block-name" }, [name]),
      dates ? el("span", { class: "hawkeye-block-dates" }, [dates]) : null,
    ];
  }

  function buildHawkeyeStageLine(p, label, blocks, xPx, marks, todayIso, opts) {
    const o = opts || {};
    const blockH = o.large ? (o.ladder ? 38 : 44) : 32;
    const rowH = blockH + 4;
    const labelH = 18;
    const hasAnnotation = !o.planned && blocks.some((b) => b.delayLeftPx != null || b.savedLeftPx != null);
    const blockTop = labelH + 2;
    // Ladder: each lane holds one block at a time and carries its own
    // delay count underneath, so lanes are taller on the Actual row.
    const laneStride = blockH + (o.planned ? 6 : o.large ? 26 : 22);
    const laneTop = (b) => blockTop + (o.ladder ? (b.lane || 0) * laneStride : 0);
    const blockStyle = o.large || o.ladder ? `height:${blockH}px;` : "";
    const track = el("div", { class: "hawkeye-stage-row" + (o.large ? " is-large" : "") + (o.ladder ? " is-ladder" : "") });
    const setHeight = (captionLines) => {
      track.style.height = o.ladder
        ? labelH + Math.max(o.laneCount || 1, 1) * laneStride + 4 + "px"
        : rowH + labelH + captionLines * 20 + 6 + "px";
    };
    setHeight(hasAnnotation ? 1 : 0);
    track.appendChild(el("span", { class: "hawkeye-stage-row-label" }, [label]));
    marks.forEach((m) => track.appendChild(el("div", { class: "stagegantt-grid-line", style: `left:${m.px}px;top:${labelH}px` })));
    if (!o.hideToday) {
      track.appendChild(el("div", { class: "stagegantt-today-line", style: `left:${xPx(todayIso)}px;top:${labelH}px` }));
    }
    blocks.forEach((b) => {
      const left = b.leftPx;
      const width = Math.max(b.widthPx, 8);
      const top = laneTop(b);
      if (o.planned) {
        track.appendChild(
          el(
            "div",
            {
              class: "hawkeye-stage-block is-hawkeye-planned",
              style: `${blockStyle}left:${left}px;width:${width}px;top:${top}px`,
              title: p.name + " — " + b.label + " (planned): " + fmtDateShort(b.start) + " → " + fmtDateShort(b.end),
            },
            hawkeyeBlockContent(b, width, o.large)
          )
        );
        return;
      }
      const kindClass = b.kind === "done" ? "is-done" : b.kind === "current" ? "is-current is-warn" : "is-future";
      const delayNote = b.slipped ? "  ·  +" + businessDaysBetweenIso(b.plannedEnd, b.end) + " weekdays past " + fmtDateShort(b.plannedEnd) : "";
      const block = el(
        "div",
        {
          class: "hawkeye-stage-block " + kindClass,
          style: `${blockStyle}left:${left}px;width:${width}px;top:${top}px`,
          role: "button",
          tabindex: "0",
          title: p.name + " — " + b.label + " (actual): " + fmtDateShort(b.start) + " → " + fmtDateShort(b.end) + delayNote,
        },
        hawkeyeBlockContent(b, width, o.large)
      );
      const open = (e) => {
        e.stopPropagation();
        openStageDetail(p.id, b.stage);
      };
      block.addEventListener("click", open);
      block.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open(e);
        }
      });
      track.appendChild(block);
      if (b.delayLeftPx != null) {
        const days = businessDaysBetweenIso(b.plannedEnd, b.end);
        track.appendChild(
          el("div", {
            class: "hawkeye-stage-block is-delay",
            style: `${blockStyle}left:${b.delayLeftPx}px;width:${b.delayWidthPx}px;top:${top}px`,
            title: b.label + " delay: " + fmtDateShort(b.plannedEnd) + " → " + fmtDateShort(b.end) + " (+" + days + " weekdays)",
          })
        );
        if (days > 0) {
          b.delayDays = days;
          b.delayLabel = (o.large ? b.label : b.code) + " +" + days + "d";
        }
      } else if (b.savedLeftPx != null) {
        const days = businessDaysBetweenIso(b.end, b.plannedEnd);
        track.appendChild(
          el("div", {
            class: "hawkeye-stage-block is-saved",
            style: `${blockStyle}left:${b.savedLeftPx}px;width:${b.savedWidthPx}px;top:${top}px`,
            title: b.label + " finished early: " + fmtDateShort(b.end) + " → " + fmtDateShort(b.plannedEnd) + " (−" + days + " weekdays saved)",
          })
        );
        if (days > 0) {
          b.savedDays = days;
          b.savedLabel = (o.large ? b.label : b.code) + " −" + days + "d";
        }
      }
    });
    if (hasAnnotation) {
      // Sit each count under its red/green stretch. When a label would
      // cover the one before it, drop it to a second line; only when both
      // lines are taken does it nudge right.
      const annotations = [];
      blocks.forEach((b) => {
        if (b.delayLabel) {
          annotations.push({
            lane: b.lane || 0,
            left: b.delayLeftPx,
            width: b.delayWidthPx,
            label: b.delayLabel,
            cls: "hawkeye-delay-label",
            title: b.label + " ran " + b.delayDays + " weekdays past " + fmtDateShort(b.plannedEnd),
          });
        }
        if (b.savedLabel) {
          annotations.push({
            lane: b.lane || 0,
            left: b.savedLeftPx,
            width: b.savedWidthPx,
            label: b.savedLabel,
            cls: "hawkeye-saved-label",
            title: b.label + " finished " + b.savedDays + " weekdays early, vs " + fmtDateShort(b.plannedEnd),
          });
        }
      });
      if (o.ladder) {
        // Each count sits right under its own block, in that block's lane.
        // Within one lane, nudge right if two counts would touch.
        const rightByLane = {};
        annotations
          .sort((a, b) => a.left - b.left)
          .forEach((a) => {
            const est = a.label.length * 6.8 + 14;
            let center = a.left + a.width / 2;
            const prevRight = rightByLane[a.lane] == null ? -Infinity : rightByLane[a.lane];
            if (center - est / 2 < prevRight) center = prevRight + est / 2;
            rightByLane[a.lane] = center + est / 2 + 4;
            const top = blockTop + a.lane * laneStride + blockH + 3;
            track.appendChild(el("span", { class: a.cls, style: `left:${center}px;top:${top}px`, title: a.title }, [a.label]));
          });
      } else {
        const laneRight = [-Infinity, -Infinity];
        let linesUsed = 1;
        annotations
          .sort((a, b) => a.left - b.left)
          .forEach((a) => {
            const est = a.label.length * 6.8 + 14;
            let center = a.left + a.width / 2;
            let lane = laneRight.findIndex((right) => center - est / 2 >= right);
            if (lane === -1) {
              lane = laneRight[0] <= laneRight[1] ? 0 : 1;
              center = laneRight[lane] + est / 2;
            }
            laneRight[lane] = center + est / 2 + 4;
            linesUsed = Math.max(linesUsed, lane + 1);
            track.appendChild(
              el("span", { class: a.cls, style: `left:${center}px;top:${blockTop + blockH + 2 + lane * 20}px`, title: a.title }, [a.label])
            );
          });
        setHeight(linesUsed);
      }
    }
    return track;
  }

  const HAWKEYE_MONTH_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  function hawkeyeMonthMarks(minTime, maxTime, pxPerDay) {
    const DAY = 86400000;
    const marks = [];
    const cursor = new Date(minTime);
    cursor.setDate(1);
    cursor.setHours(0, 0, 0, 0);
    // A compressed scale packs months too close for a label each. Step to
    // quarters, then half-years, once a month is narrower than its label.
    const monthPx = 30.44 * pxPerDay;
    const step = monthPx >= 56 ? 1 : monthPx >= 32 ? 3 : 6;
    const endMark = new Date(maxTime);
    while (cursor.getTime() <= maxTime) {
      const month = cursor.getMonth();
      const isRangeEnd = month === endMark.getMonth() && cursor.getFullYear() === endMark.getFullYear();
      if (cursor.getTime() >= minTime && (month % step === 0 || isRangeEnd)) {
        marks.push({
          px: ((cursor.getTime() - minTime) / DAY) * pxPerDay,
          label: HAWKEYE_MONTH_SHORT[month] + " '" + String(cursor.getFullYear()).slice(2),
        });
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }
    return marks;
  }

  // Places both rows of one project in the same stage columns and returns
  // the rightmost pixel used. One column per stage, wide enough for the
  // longer of planned and actual, so Requirements on the plan sits directly
  // above Requirements on actual (2026-11-05, "show columns"). An early
  // finish keeps the column out to the planned end so the green tail fits.
  function layoutHawkeyeProjectRows(planned, actual, xPx) {
    const actualLayout = actual.map((b) => ({
      stage: b.stage,
      start: b.start,
      end: b.plannedEnd && b.plannedEnd > b.end ? b.plannedEnd : b.end,
    }));
    const columns = computeHawkeyeStageColumns(planned, actualLayout, xPx);
    assignHawkeyeColumnPositions(planned, columns);
    assignHawkeyeColumnPositions(actual, columns);
    let right = 0;
    actual.concat(planned).forEach((b) => {
      right = Math.max(
        right,
        (b.leftPx || 0) + (b.widthPx || 0),
        b.savedLeftPx != null ? b.savedLeftPx + b.savedWidthPx : 0,
        b.delayLeftPx != null ? b.delayLeftPx + b.delayWidthPx : 0
      );
    });
    return right;
  }

  // Ladder layout for the Actual row (2026-11-05). The Planned row stays
  // one line. Here every stage sits on its real dates, and a stage that
  // overlaps one already placed steps down to the next lane instead of
  // being squeezed beside it. So TDD running 20 days long and Development
  // starting on its planned day show as two lanes that overlap in time.
  // Gaps stay: empty
  // space means the dates leave that time empty. A weekend between one
  // stage's end and the next stage's start in the same lane is not a gap.
  // Sets leftPx/widthPx, delay and saved segments, and `lane` on each block;
  // returns the rightmost pixel and the number of lanes used.
  function layoutHawkeyeLadder(blocks, xPx) {
    const MIN_W = 8;
    const info = blocks
      .map((b) => {
        const rightIso = addDaysIso(b.end, 1);
        const savedIso = b.plannedEnd && b.plannedEnd > b.end ? addDaysIso(b.plannedEnd, 1) : null;
        return { b, rightIso, extentIso: savedIso || rightIso, savedIso };
      })
      .sort((a, c) => (a.b.start !== c.b.start ? (a.b.start < c.b.start ? -1 : 1) : hawkeyeStageIndex(a.b.stage) - hawkeyeStageIndex(c.b.stage)));

    const laneRight = [];
    const laneItems = [];
    info.forEach((it) => {
      const left = xPx(it.b.start);
      const right = Math.max(xPx(it.extentIso), left + MIN_W);
      let lane = laneRight.findIndex((r) => left >= r - 0.01);
      if (lane === -1) {
        lane = laneRight.length;
        laneRight.push(-Infinity);
        laneItems.push([]);
      }
      laneRight[lane] = right + 1;
      laneItems[lane].push(it);
      it.b.lane = lane;
    });

    laneItems.forEach((items) => {
      items.forEach((it, i) => {
        const next = items[i + 1];
        if (!next || it.savedIso || next.b.start <= it.rightIso) return;
        for (let d = it.rightIso; d < next.b.start; d = addDaysIso(d, 1)) {
          const dow = new Date(d + "T00:00:00").getDay();
          if (dow !== 0 && dow !== 6) return;
        }
        it.rightIso = next.b.start;
        it.extentIso = next.b.start;
      });
    });

    let rightMost = 0;
    info.forEach((it) => {
      const b = it.b;
      const left = xPx(b.start);
      const blockRight = Math.max(xPx(it.rightIso), left + 2);
      b.leftPx = left;
      b.widthPx = blockRight - left;
      b.delayLeftPx = null;
      b.delayWidthPx = 0;
      b.savedLeftPx = null;
      b.savedWidthPx = 0;
      if (b.plannedEnd && b.plannedEnd < b.end) {
        const delayLeft = Math.max(xPx(addDaysIso(b.plannedEnd, 1)), left);
        b.delayLeftPx = delayLeft;
        b.delayWidthPx = Math.max(blockRight - delayLeft, 2);
      } else if (it.savedIso) {
        b.savedLeftPx = blockRight;
        b.savedWidthPx = Math.max(xPx(it.savedIso) - blockRight, 2);
      }
      rightMost = Math.max(rightMost, blockRight, b.savedLeftPx != null ? b.savedLeftPx + b.savedWidthPx : 0);
    });
    return { right: rightMost, laneCount: Math.max(laneRight.length, 1) };
  }

  const HAWKEYE_LADDER_KEY = "baps-ndc-hawkeye-ladder";
  // A project opens in Ladder when its actual stages overlap in time (one
  // still running when the next has started), the same situation as SPM.
  // A choice made in the panel overrides that and is remembered here.
  const hawkeyeLadderChoice = (() => {
    try {
      return JSON.parse(localStorage.getItem(HAWKEYE_LADDER_KEY) || "{}") || {};
    } catch (e) {
      return {};
    }
  })();
  function hawkeyeStagesOverlap(blocks) {
    const spans = blocks
      .filter((b) => b.start && b.end && b.end >= b.start)
      .map((b) => ({ start: b.start, end: addDaysIso(b.end, 1) }))
      .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
    for (let i = 0; i < spans.length; i++) {
      for (let j = i + 1; j < spans.length; j++) {
        if (spans[j].start >= spans[i].end) break;
        return true;
      }
    }
    return false;
  }
  function hawkeyeLadderOn(id, blocks) {
    if (id in hawkeyeLadderChoice) return !!hawkeyeLadderChoice[id];
    return hawkeyeStagesOverlap(blocks);
  }
  function setHawkeyeLadder(id, on) {
    hawkeyeLadderChoice[id] = !!on;
    try {
      localStorage.setItem(HAWKEYE_LADDER_KEY, JSON.stringify(hawkeyeLadderChoice));
    } catch (e) {
      /* ignore */
    }
  }

  // One project on its own calendar, fitted to just its dates, so a
  // project that's a thin strip on the shared chart opens up to the full
  // panel width. Sticky on the left so it stays in view while the shared
  // chart around it scrolls sideways.
  function buildHawkeyeFocusPanel(p, plannedIn, actualIn, widthPx, todayIso) {
    const DAY = 86400000;
    const planned = plannedIn.map((b) => ({ ...b }));
    const actual = actualIn.map((b) => ({ ...b }));
    const isoTimes = [];
    actual.concat(planned).forEach((b) => {
      [b.start, b.end, b.plannedEnd].forEach((iso) => {
        if (iso) isoTimes.push(new Date(iso + "T00:00:00").getTime());
      });
    });
    const minTime = Math.min(...isoTimes) - 5 * DAY;
    const maxTime = Math.max(...isoTimes) + 5 * DAY;
    const spanDays = Math.max(1, (maxTime - minTime) / DAY);
    const usable = Math.max(widthPx - 24, 320);
    const pxPerDay = usable / spanDays;
    const xPx = (iso) => ((new Date(iso + "T00:00:00").getTime() - minTime) / DAY) * pxPerDay;
    const todayTime = new Date(todayIso + "T00:00:00").getTime();
    const hideToday = todayTime < minTime || todayTime > maxTime;
    const marks = hawkeyeMonthMarks(minTime, maxTime, pxPerDay);
    const right = layoutHawkeyeProjectRows(planned, actual, xPx);
    const contentWidth = Math.max(usable, spanDays * pxPerDay, right + 24);

    const lanes = el("div", { class: "hawkeye-focus-lanes", style: `width:${contentWidth}px` });
    const header = el("div", { class: "stagegantt-months hawkeye-focus-header" });
    marks.forEach((m) => header.appendChild(el("div", { class: "stagegantt-month-mark", style: `left:${m.px}px` }, [m.label])));
    if (!hideToday) header.appendChild(el("span", { class: "hawkeye-lanes-today", style: `left:${xPx(todayIso)}px` }, ["Today"]));
    lanes.appendChild(header);
    if (planned.length) {
      lanes.appendChild(
        buildHawkeyeStageLine(p, "Planned", planned, xPx, marks, todayIso, { planned: true, large: true, hideToday })
      );
    }
    lanes.appendChild(buildHawkeyeStageLine(p, "Actual", actual, xPx, marks, todayIso, { large: true, hideToday }));
    const scroller = el("div", { class: "hawkeye-focus-scroll" }, [lanes]);
    return el("div", { class: "hawkeye-focus", style: `width:${widthPx}px` }, [scroller]);
  }

  // Cross-project Hawk-eye. One project, two rows — Planned, then Actual
  // with any delay in red — every stage block on each (2026-11-04, "I
  // want 2 rows ... one row show blocks on each stage ... (planned) and
  // then one row shows the same but ... actual ... in red as delay").
  // Sorted by go-live date.
  function renderHawkeye() {
    const board = document.getElementById("hawkeyeGantt");
    board.innerHTML = "";

    const projects = visibleProjects();
    if (!projects.length) {
      board.appendChild(el("p", { class: "empty-note" }, ["No projects match the current filters."]));
      return;
    }

    const DAY = 86400000;
    const todayIso = todayISO();
    const rows = projects
      .map((p) => {
        const actual = hawkeyeStageBlocks(p);
        return { p, actual, planned: hawkeyeStagePlannedBlocks(p, actual) };
      })
      .sort((a, b) => {
        const ta = a.p.goLive ? new Date(a.p.goLive).getTime() : Infinity;
        const tb = b.p.goLive ? new Date(b.p.goLive).getTime() : Infinity;
        return ta - tb;
      });
    if (!rows.some((r) => r.actual.length)) {
      board.appendChild(el("p", { class: "empty-note" }, ["No stage plan dates to plot yet."]));
      return;
    }

    const times = [new Date(todayIso + "T00:00:00").getTime()];
    rows.forEach(({ actual, planned }) => {
      actual.concat(planned).forEach((b) => {
        times.push(new Date(b.start + "T00:00:00").getTime());
        times.push(new Date(b.end + "T00:00:00").getTime());
      });
    });
    const dataMin = Math.min(...times);
    const minTime = hawkeyeMonthsEarlier(dataMin, 6);
    let maxTime = Math.max(...times) + 7 * DAY;
    if (maxTime - dataMin < 30 * DAY) maxTime = dataMin + 30 * DAY;
    const throughAug2027 = new Date("2027-08-31T00:00:00").getTime();
    if (maxTime < throughAug2027) maxTime = throughAug2027;

    const viewToggle = hawkeyeToggle(
      HAWKEYE_VIEWS.map((v) => ({ id: v.id, label: v.label, active: hawkeyeView === v.id })),
      (id) => {
        hawkeyeView = id;
        renderHawkeye();
      },
      "Hawk-eye view"
    );
    if (hawkeyeView === "roadmap" || hawkeyeView === "v2") {
      const planToggle =
        hawkeyeView === "v2"
          ? null
          : hawkeyeToggle(
              [
                { id: "both", label: "Planned + Actual", active: hawkeyeRoadmapMode === "both" },
                { id: "planned", label: "Planned", active: hawkeyeRoadmapMode === "planned" },
                { id: "actual", label: "Actual", active: hawkeyeRoadmapMode === "actual" },
                { id: "totals", label: "Totals (collapse)", active: hawkeyeRoadmapMode === "totals" },
              ],
              (id) => {
                hawkeyeRoadmapMode = id;
                renderHawkeye();
              },
              "Month grid, one timeline row of planned/actual, or one bar per project start-to-finish for capacity planning"
            );
      const zoomStepper = hawkeyeZoomStepper(
        HAWKEYE_ROADMAP_ZOOM_ORDER,
        HAWKEYE_ROADMAP_ZOOM_LABEL,
        hawkeyeRoadmapZoom,
        (id) => {
          setHawkeyeRoadmapZoom(id);
          renderHawkeye();
        },
        "Column width: 6 months → 3 months → 2 months → 1 month → weeks. Narrower columns show stage dates and delays more clearly."
      );
      // At the 3-month zoom every row auto-collapses to one bar (same look
      // as picking Totals), so the mode toggle's own highlight would be
      // misleading there — call it out instead of silently disagreeing
      // with what's on screen.
      const autoCollapseHint =
        hawkeyeView === "roadmap" &&
        (hawkeyeRoadmapZoom === "quarter" || hawkeyeRoadmapZoom === "halfyear") &&
        hawkeyeRoadmapMode !== "totals"
          ? el("span", { class: "hawkeye-zoom-autohint" }, ["Zoomed out to one bar per project — zoom in for stages"])
          : null;
      board.appendChild(
        el("div", { class: "hawkeye-toolbar" }, [
          viewToggle,
          planToggle,
          zoomStepper,
          autoCollapseHint,
          hawkeyeRoadmapMode === "totals" ? hawkeyeTotalsLegend() : hawkeyeRoadmapLegend(),
        ])
      );
      board.appendChild(buildHawkeyeRoadmap(rows, todayIso));
      return;
    }

    // Side by side, sized to the panel at Half year, a bit wider at
    // Quarter so blocks are readable, and denser still at Month. The chart
    // scrolls sideways for the extra width. clientWidth is 0 while this tab
    // is display:none; fall back to the zoom scale then.
    const zoom = HAWKEYE_ZOOM[hawkeyeZoom] || HAWKEYE_ZOOM.quarter;
    const available = board.clientWidth > 80 ? board.clientWidth - 40 : 0;
    const spanDays = Math.max(1, (maxTime - minTime) / DAY);
    const fit = available ? Math.max(zoom.pxPerDay, available / spanDays) : zoom.pxPerDay;
    const pxPerDay = fit * zoom.scale;
    const xPx = (iso) => ((new Date(iso + "T00:00:00").getTime() - minTime) / DAY) * pxPerDay;

    const legendItem = (cls, text) =>
      el("span", { class: "stagegantt-legend-item" }, [el("span", { class: "stagegantt-legend-swatch " + cls }), text]);
    board.appendChild(
      el("div", { class: "hawkeye-toolbar" }, [
        viewToggle,
        el("div", { class: "stagegantt-legend hawkeye-legend" }, [
          legendItem("is-hawkeye-planned", "Planned"),
          legendItem("is-done", "Done"),
          legendItem("is-warn", "In progress"),
          legendItem("is-future", "Not started"),
          legendItem("is-hawkeye-delay", "Delay past that stage's plan"),
          legendItem("is-hawkeye-saved", "Time saved vs that stage's plan"),
        ]),
      ])
    );
    const expandable = rows.filter((r) => r.actual.length).map((r) => r.p.id);
    const openCount = expandable.filter((id) => hawkeyeExpanded.has(id)).length;
    const bulkBtn = (text, action, disabled) => {
      const btn = el("button", { class: "hawkeye-bulk-btn", type: "button" }, [text]);
      if (disabled) btn.disabled = true;
      btn.addEventListener("click", () => {
        expandable.forEach((id) => (action === "open" ? hawkeyeExpanded.add(id) : hawkeyeExpanded.delete(id)));
        saveHawkeyeExpanded();
        hawkeyeRestoreWindowY = window.scrollY;
        renderHawkeye();
      });
      return btn;
    };
    board.appendChild(
      el("div", { class: "hawkeye-expand-bar" }, [
        el("span", { class: "hawkeye-expand-hint" }, [
          "Expand a project to see its stages larger, fitted to its own dates.",
        ]),
        bulkBtn("Expand all", "open", openCount === expandable.length),
        bulkBtn("Collapse all", "close", openCount === 0),
      ])
    );
    const zoomToggle = hawkeyeToggle(
      HAWKEYE_ZOOM_ORDER.map((z) => ({ id: z, label: HAWKEYE_ZOOM[z].label, active: hawkeyeZoom === z })),
      (id) => {
        hawkeyeZoom = id;
        renderHawkeye();
      },
      "Timeline zoom"
    );
    const chartWindow = el("div", { class: "hawkeye-window" }, [zoomToggle]);
    board.appendChild(chartWindow);

    // Month-by-month axis, every zoom level (2026-11-04, "above show
    // months in the view so people can see the time slots") — Half/
    // Quarter/Month only change pxPerDay (how much calendar fits the
    // panel); the header itself always marks real months.
    const marks = hawkeyeMonthMarks(minTime, maxTime, pxPerDay);

    let timelineWidthPx = Math.max(available || 0, ((maxTime - minTime) / DAY) * pxPerDay);
    rows.forEach((row) => {
      timelineWidthPx = Math.max(timelineWidthPx, layoutHawkeyeProjectRows(row.planned, row.actual, xPx) + 24);
    });
    const focusWidthPx = Math.max((board.clientWidth || 960) - 4, 360);

    const scrollInner = el("div", { class: "hawkeye-scroll-inner" });
    const inner = el("div", { class: "hawkeye-lanes", style: `width:${timelineWidthPx}px` });
    const header = el("div", { class: "stagegantt-months hawkeye-lanes-header" });
    marks.forEach((m) => header.appendChild(el("div", { class: "stagegantt-month-mark", style: `left:${m.px}px` }, [m.label])));
    header.appendChild(el("span", { class: "hawkeye-lanes-today", style: `left:${xPx(todayIso)}px` }, ["Today"]));
    inner.appendChild(header);

    rows.forEach((row) => {
      const { p, actual, planned } = row;
      const delay = p.delayDays || 0;
      const openProject = () => openProjectDetail(p.id, "stage-gate-timeline-section");
      const head = el(
        "div",
        { class: "hawkeye-project-head", role: "button", tabindex: "0", title: `Open ${p.name}'s full Stage-gate timeline` },
        [
          el("span", { class: "timeline-dot", style: `background:var(--${effectiveStatus(p)})` }),
          el("strong", null, [p.name]),
          el("span", { class: "hawkeye-project-meta" }, [
            [p.owner, delay > 0 ? `${delay}d delayed` : "On pace", p.goLive ? "Go-Live " + fmtDate(p.goLive) : null]
              .filter(Boolean)
              .join("  ·  "),
          ]),
        ]
      );
      head.addEventListener("click", openProject);
      head.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openProject();
        }
      });
      const expanded = hawkeyeExpanded.has(p.id) && actual.length > 0;
      const toggle = el(
        "button",
        {
          class: "hawkeye-expand-btn" + (expanded ? " is-open" : ""),
          type: "button",
          "aria-expanded": expanded ? "true" : "false",
          title: expanded ? "Back to the shared timeline" : "Open " + p.name + " on its own, fitted timeline",
        },
        [el("span", { class: "hawkeye-expand-chevron", "aria-hidden": "true" }, ["▸"]), expanded ? "Collapse" : "Expand"]
      );
      toggle.addEventListener("click", () => {
        if (hawkeyeExpanded.has(p.id)) hawkeyeExpanded.delete(p.id);
        else hawkeyeExpanded.add(p.id);
        saveHawkeyeExpanded();
        hawkeyeRestoreScrollLeft = scrollInner.scrollLeft;
        hawkeyeRestoreWindowY = window.scrollY;
        renderHawkeye();
      });
      const bar = el("div", { class: "hawkeye-project-bar" }, [actual.length ? toggle : null, head]);
      const group = el("div", { class: "hawkeye-project" + (expanded ? " is-expanded" : ""), "data-project-id": p.id }, [bar]);
      if (!actual.length) {
        group.appendChild(el("p", { class: "empty-note hawkeye-project-empty" }, ["No stage plan dates to plot yet."]));
      } else if (expanded) {
        group.appendChild(buildHawkeyeFocusPanel(p, planned, actual, focusWidthPx, todayIso));
      } else {
        if (planned.length) {
          group.appendChild(
            buildHawkeyeStageLine(p, "Planned", planned, xPx, marks, todayIso, { planned: true })
          );
        }
        group.appendChild(
          buildHawkeyeStageLine(p, "Actual", actual, xPx, marks, todayIso, {})
        );
      }
      inner.appendChild(group);
    });

    scrollInner.appendChild(inner);
    chartWindow.appendChild(scrollInner);

    // Two frames: emptying the chart collapses the page and the browser
    // clamps the window scroll to the top on the next frame. Restoring
    // one frame later loses that race, so wait one more.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (hawkeyeRestoreWindowY != null) {
        window.scrollTo(0, hawkeyeRestoreWindowY);
        hawkeyeRestoreWindowY = null;
      }
      if (hawkeyeRestoreScrollLeft != null) {
        scrollInner.scrollLeft = hawkeyeRestoreScrollLeft;
        hawkeyeRestoreScrollLeft = null;
        return;
      }
      // Open with today a third of the way in, so recent work and what's
      // next are both in view.
      const viewport = scrollInner.clientWidth || available;
      scrollInner.scrollLeft = Math.max(0, xPx(todayIso) - viewport * 0.66);
    }));
  }

  /* ---------------- Global project filter (applies to every tab) ---------------- */

  function populateGlobalProjectFilter() {
    const select = document.getElementById("globalProjectFilter");
    const names = activeProjects().sort((a, b) => a.name.localeCompare(b.name));
    names.forEach((p) => {
      select.appendChild(el("option", { value: p.id }, [p.name]));
    });
  }

  function renderAllTabs() {
    renderMetrics();
    renderStageGrid();
    renderHawkeye();
    renderCards();
    renderDependenciesTab();
    renderEscalationsTab();
  }

  function updateGlobalFilterUI() {
    const bar = document.getElementById("globalFilterBar");
    const clearBtn = document.getElementById("globalFilterClear");
    const isActive = globalProjectFilter !== "all";
    clearBtn.hidden = !isActive;
    bar.classList.toggle(
      "is-active",
      isActive || activeOwner !== "all" || (activeTab === "deps" && globalTeamFilter !== "all")
    );
  }

  function wireGlobalProjectFilter() {
    const select = document.getElementById("globalProjectFilter");
    select.addEventListener("change", (e) => {
      globalProjectFilter = e.target.value;
      updateGlobalFilterUI();
      renderAllTabs();
    });

    document.getElementById("globalFilterClear").addEventListener("click", () => {
      globalProjectFilter = "all";
      select.value = "all";
      updateGlobalFilterUI();
      renderAllTabs();
    });
  }

  /* ---------------- Tab: Dependencies ---------------- */

  // Due-window buckets for a dependency's "needed by" date, relative to
  // today — drives card badges and pivot due-window columns. Matches the
  // leadership mockup (Today → Next Month) plus Overdue as a 7th column so
  // past-due work is never folded into "Today". Dependencies with no date use
  // internal key `no-date` (counted in row totals only, not in window cols).
  const DUE_WINDOWS = [
    { key: "overdue", label: "Overdue", rank: 0 },
    { key: "today", label: "Today", rank: 1 },
    { key: "tomorrow", label: "Tomorrow", rank: 2 },
    { key: "this-week", label: "This Week", rank: 3 },
    { key: "next-week", label: "Next Week", rank: 4 },
    { key: "this-month", label: "This Month", rank: 5 },
    { key: "next-month", label: "Next Month", rank: 6 },
  ];
  const DUE_WINDOW_BY_KEY = {
    "no-date": { key: "no-date", label: "No date set", rank: 99 },
  };
  DUE_WINDOWS.forEach((w) => (DUE_WINDOW_BY_KEY[w.key] = w));

  function endOfWeekSunday(fromIso) {
    const d = new Date(fromIso + "T00:00:00");
    const dow = d.getDay();
    const daysUntilSunday = dow === 0 ? 0 : 7 - dow;
    return addDaysIso(fromIso, daysUntilSunday);
  }

  function endOfMonthIso(fromIso) {
    const d = new Date(fromIso + "T00:00:00");
    const y = d.getFullYear();
    const m = d.getMonth();
    const last = new Date(y, m + 1, 0);
    const mm = String(last.getMonth() + 1).padStart(2, "0");
    const dd = String(last.getDate()).padStart(2, "0");
    return `${last.getFullYear()}-${mm}-${dd}`;
  }

  function startOfNextMonthIso(fromIso) {
    const d = new Date(fromIso + "T00:00:00");
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    return `${y}-${m}-01`;
  }

  function dueWindowFor(dueBy, today) {
    if (!dueBy) return DUE_WINDOW_BY_KEY["no-date"];
    if (dueBy < today) return DUE_WINDOW_BY_KEY.overdue;
    if (dueBy === today) return DUE_WINDOW_BY_KEY.today;
    const tomorrow = addDaysIso(today, 1);
    if (dueBy === tomorrow) return DUE_WINDOW_BY_KEY.tomorrow;
    const weekEnd = endOfWeekSunday(today);
    if (dueBy > tomorrow && dueBy <= weekEnd) return DUE_WINDOW_BY_KEY["this-week"];
    const nextWeekEnd = addDaysIso(weekEnd, 7);
    if (dueBy <= nextWeekEnd) return DUE_WINDOW_BY_KEY["next-week"];
    const monthEnd = endOfMonthIso(today);
    if (dueBy <= monthEnd) return DUE_WINDOW_BY_KEY["this-month"];
    const nextMonthEnd = endOfMonthIso(startOfNextMonthIso(today));
    if (dueBy <= nextMonthEnd) return DUE_WINDOW_BY_KEY["next-month"];
    return DUE_WINDOW_BY_KEY["next-month"];
  }

  function dueByCalendarYear(dueBy) {
    if (!dueBy) return null;
    return String(new Date(dueBy + "T00:00:00").getFullYear());
  }

  const POST_UAT_STAGES = new Set(["Rollout", "Hypercare"]);

  const PRIORITY_ORDER = ["Critical", "High", "Medium", "Low"];

  function isPlaceholderDependencyText(text) {
    return !text || /^(none|no dependency)$/i.test(String(text).trim());
  }

  /** Read dependencies as objects — supports legacy parallel-array snapshots in history.json. */
  function getDependencyObjects(source) {
    const raw = source.dependencies || [];
    if (!raw.length) return [];
    if (typeof raw[0] === "object" && raw[0] !== null && "text" in raw[0]) {
      return raw.map((d) => ({
        id: d.id || "",
        text: d.text || "",
        team: d.team || "",
        mitigation: d.mitigation || "",
        dueBy: d.dueBy || "",
        priority: PRIORITY_ORDER.includes(d.priority) ? d.priority : "Medium",
        escalated: !!d.escalated,
        resolved: !!d.resolved,
      }));
    }
    return raw.map((text, i) => ({
      id: "",
      text,
      team: (source.dependencyTeams && source.dependencyTeams[i]) || "",
      mitigation: (source.dependencyMitigations && source.dependencyMitigations[i]) || "",
      dueBy: (source.dependencyDueBy && source.dependencyDueBy[i]) || "",
      priority: PRIORITY_ORDER.includes(
        (source.dependencyPriority && source.dependencyPriority[i]) || "Medium"
      )
        ? (source.dependencyPriority && source.dependencyPriority[i]) || "Medium"
        : "Medium",
      escalated: !!(source.dependencyEscalated && source.dependencyEscalated[i]),
      resolved: false,
    }));
  }

  function countOpenDependencies(project) {
    return getDependencyObjects(project).filter(
      (d) => !d.resolved && !isPlaceholderDependencyText(d.text)
    ).length;
  }

  // Resolved/total breakdowns behind every Open-items badge (2026-11-04,
  // "why are the risk and dependencies not showing up" — they were OPEN-
  // only counts, so a project with 6 resolved dependencies and 5 resolved
  // risks read as "0 dependencies · 0 risks," as if nothing had ever been
  // logged). `total` now includes resolved items; `resolved` is how many
  // of those are done, which `openItemTone()` below turns into a color.
  function dependencyCounts(p) {
    const all = getDependencyObjects(p).filter((d) => !isPlaceholderDependencyText(d.text));
    return { total: all.length, resolved: all.filter((d) => d.resolved).length };
  }

  function riskCounts(p) {
    const all = getRiskObjects(p).filter((r) => !isPlaceholderRiskText(r.text));
    return { total: all.length, resolved: all.filter((r) => r.resolved).length };
  }

  function followupCounts(p) {
    const all = NOTES.filter((n) => n.projectId === p.id);
    return { total: all.length, resolved: all.filter((n) => noteStatus(n) === "resolved").length };
  }

  function crCounts(p) {
    const all = p.changeRequests || [];
    return { total: all.length, resolved: all.filter((cr) => crStatusClass(cr.approvalStatus) === "is-approved").length };
  }

  // Green when everything logged is resolved, red when none of it is,
  // amber in between — "show in red, yellow and green if things have
  // resolved or in progress or red if nothing has been done" (2026-11-04).
  // No color (plain badge) when nothing's been logged at all — that's not
  // "nothing done," there's just nothing to report yet.
  function openItemTone(total, resolved) {
    if (!total) return "";
    if (resolved >= total) return "tone-green";
    if (resolved <= 0) return "tone-red";
    return "tone-amber";
  }

  // Every Open-items badge — deps/risks/follow-ups/CRs — shows the TOTAL
  // logged count (not just open), colored by `openItemTone()`, and always
  // jumps to its source section (2026-11-04, "all the button should link
  // to the icon when clicked"). `opts.jump: true` (project cards) relies
  // on the generic `.badge.is-jump-link` click wiring scoped to `.card`
  // (see the `box.querySelectorAll(".badge.is-jump-link")` loop below);
  // inside an already-open detail view it wires its own click to switch
  // tabs + scroll instead of reopening the detail — same split
  // `changeRequestBadge()` already used.
  function openItemBadge(counts, singular, plural, focusSection, opts) {
    opts = opts || {};
    const { total, resolved } = counts;
    const tone = openItemTone(total, resolved);
    const badge = el(
      "span",
      {
        class: "badge is-jump-link" + (tone ? " " + tone : ""),
        role: "button",
        tabindex: "0",
        title: total ? resolved + " of " + total + " resolved" : "None logged yet",
        "data-focus-section": opts.jump ? focusSection : "",
      },
      [String(total) + " " + (total === 1 ? singular : plural)]
    );
    if (!opts.jump) {
      const open = (e) => {
        e.stopPropagation();
        const detailRoot = document.querySelector("#detailContent").firstElementChild;
        if (!detailRoot) return;
        activateDetailTab(detailRoot, DETAIL_SECTION_TAB_MAP[focusSection] || focusSection);
        requestAnimationFrame(() => {
          const target = document.getElementById(focusSection);
          if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
        });
      };
      badge.addEventListener("click", open);
      badge.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open(e);
        }
      });
    }
    return badge;
  }

  // Change-request badge for the Open items row and the project-card
  // badges — total logged CRs, colored by how many are approved
  // (`openItemBadge()`/`openItemTone()` above). `opts.jump` makes the card
  // badge open the Change Request Log; inside the detail view the same
  // badge switches to that tab.
  function changeRequestBadge(p, opts) {
    return openItemBadge(crCounts(p), "CR", "CRs", "cr-log-section", opts);
  }

  function isPlaceholderRiskText(text) {
    return !text || /^(none|no risk|no risks|no blocker|no blockers)$/i.test(String(text).trim());
  }

  /** Read risks as objects — supports legacy parallel-array snapshots in history.json. */
  function getRiskObjects(source) {
    const raw = source.risks || [];
    if (!raw.length) return [];
    if (typeof raw[0] === "object" && raw[0] !== null && "text" in raw[0]) {
      return raw.map((r) => ({
        id: r.id || "",
        text: r.text || "",
        mitigation: r.mitigation || "",
        resolved: !!r.resolved,
      }));
    }
    const mitigations = source.riskMitigations || [];
    return raw.map((text, i) => ({
      id: "",
      text,
      mitigation: mitigations[i] || "",
      resolved: false,
    }));
  }

  function countOpenRisks(project) {
    return getRiskObjects(project).filter(
      (r) => !r.resolved && !isPlaceholderRiskText(r.text)
    ).length;
  }

  function detailSectionIssueLink(template, projectName, label) {
    return el("a", {
      class: "btn-ghost btn-small detail-section-link",
      target: "_blank",
      rel: "noopener",
      href: issueUrl(template, { project: projectName }),
    }, [label + " ↗"]);
  }

  // In-page form button (2026-11-04) — replaces `detailSectionIssueLink`
  // for "+ Add a Dependency" / "+ Report a Risk", which used to jump
  // straight to an external GitHub issue form. Opens the matching modal
  // instead; the modal itself is what opens the GitHub issue, once filled in.
  function detailSectionModalButton(label, onClick) {
    const btn = el("button", { type: "button", class: "btn-ghost btn-small detail-section-link" }, [label]);
    btn.addEventListener("click", onClick);
    return btn;
  }

  // Opens the "Update / Resolve a Dependency" issue form, pre-filled with
  // the project + dependency id so the PM doesn't have to look either up.
  // `extra` can pre-select the resolve/escalate dropdown so a single click
  // (e.g. "Resolve") opens the form already set to do that — the PM still
  // has to submit the GitHub issue, since this is a static site with no
  // write access of its own.
  function dependencyUpdateUrl(projectName, depId, extra) {
    return issueUrl("update-dependency.yml", {
      project: projectName,
      dependency_id: depId,
      ...(extra || {}),
    });
  }

  function dependencyActionLink(href, label) {
    return el("a", {
      class: "dep-action-link",
      target: "_blank",
      rel: "noopener",
      href,
    }, [label]);
  }

  /** Like pairedList(), but for the Dependencies section only: shows each
   * dependency's stable id, an escalated badge when set, and quick-action
   * links (Update / Escalate·Un-escalate / Resolve) that open the
   * "update-dependency.yml" issue form pre-filled for that one row. Legacy
   * dependencies with no id (pre-migration data still mid-flight) get no
   * action links, since there's nothing stable to target. The row itself
   * is also clickable (anywhere except the action links) to open the
   * item detail modal with every field (team/priority/due date/escalated/
   * resolved), not just what fits inline here. */
  function dependencyListItems(deps, project) {
    if (!deps.length) return [el("li", null, ["—"])];
    const projectName = project.name;
    const today = todayISO();
    return deps.map((dep) => {
      const mitigation = dep.mitigation || "";
      // Due date badge (2026-11-03, "I want to see the dependency ... due
      // date on this view in the row") — same `dueWindow` badge/coloring
      // already used in the cross-project Dependencies rollup (overdue/
      // today/this week in red/amber, further out muted, "No date set"
      // when `dueBy` isn't on record), just surfaced here too so it's
      // visible without leaving the project detail view.
      const dueWindow = dueWindowFor(dep.dueBy || "", today);
      const actions = dep.id && !dep.resolved
        ? [
            dependencyActionLink(dependencyUpdateUrl(projectName, dep.id, {}), "✎ Update"),
            dep.escalated
              ? dependencyActionLink(
                  dependencyUpdateUrl(projectName, dep.id, { mark_escalated: "No — un-escalate" }),
                  "✓ Un-escalate"
                )
              : dependencyActionLink(
                  dependencyUpdateUrl(projectName, dep.id, { mark_escalated: "Yes — escalate" }),
                  "🚨 Escalate"
                ),
            dependencyActionLink(
              dependencyUpdateUrl(projectName, dep.id, { mark_resolved: "Yes — resolved" }),
              "✓ Resolve"
            ),
          ]
        : [];
      const li = el("li", { class: "paired-item is-clickable" + (dep.resolved ? " is-resolved" : ""), tabindex: "0", role: "button" }, [
        el("div", { class: "paired-item-text" }, [
          dep.id ? el("span", { class: "dep-id-tag" }, [dep.id]) : null,
          dep.text,
          dep.resolved ? el("span", { class: "deps-badge deps-badge-resolved" }, ["Resolved"]) : null,
          dep.escalated && !dep.resolved ? el("span", { class: "deps-badge deps-badge-escalated" }, ["🚨 Escalated"]) : null,
          // Some projects (e.g. SSO V2) fold two conceptually distinct
          // deck tables — with their own separate dependency/risk lists —
          // into one project record. `track` (only set where the source
          // deck actually had more than one such table) surfaces which
          // one this item came from instead of silently merging them.
          dep.track ? el("span", { class: "track-tag" }, [dep.track]) : null,
          el("span", { class: "team-tag" + (dep.team ? "" : " is-missing") }, [dep.team || "No team labeled"]),
          dep.resolved
            ? null
            : el("span", { class: "deps-badge deps-badge-due is-" + dueWindow.key }, [
                dep.dueBy ? `${dueWindow.label} · ${fmtDate(dep.dueBy)}` : "No date set",
              ]),
          dep.stage ? el("span", { class: "stage-tag" }, [dep.stage + " →"]) : null,
        ].filter(Boolean)),
        el("div", { class: "paired-item-mitigation" + (mitigation ? "" : " is-missing") }, [
          el("span", { class: "mitigation-label" }, ["Mitigation / impact: "]),
          mitigation || "Not yet documented",
        ]),
        actions.length ? el("div", { class: "dep-actions-row" }, actions) : null,
      ].filter(Boolean));
      // 2026-11-04, explicit request: clicking a dependency should land
      // directly on its own pipeline stage's detail popup (same one
      // opened from a Grid-tab/Stage-gate-timeline stage cell) when the
      // item has a `stage` tag — rather than this item's own (largely
      // redundant — team/priority/due/mitigation are already inline in
      // the row above) detail modal. Untagged items keep the old
      // behavior so nothing else in the app changes.
      const open = () =>
        dep.stage ? openStageDetail(project.id, dep.stage) : openItemDetail("dependency", project, dep);
      li.addEventListener("click", (e) => {
        if (e.target.tagName === "A") return; // action links handle their own click
        open();
      });
      li.addEventListener("keydown", (e) => {
        if (e.target.tagName === "A") return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
      return li;
    });
  }

  /** Read-only counterpart of dependencyListItems() for the Risks /
   * blockers section — risks don't have team/priority/due-date fields to
   * offer quick actions on, but the row is still clickable to open the
   * item detail modal (full text, mitigation plan, resolved state). */
  function riskListItems(risks, project) {
    if (!risks.length) return [el("li", null, ["—"])];
    return risks.map((risk) => {
      const mitigation = risk.mitigation || "";
      const li = el("li", { class: "paired-item is-clickable" + (risk.resolved ? " is-resolved" : ""), tabindex: "0", role: "button" }, [
        el("div", { class: "paired-item-text" }, [
          risk.id ? el("span", { class: "dep-id-tag" }, [risk.id]) : null,
          risk.text,
          risk.resolved ? el("span", { class: "deps-badge deps-badge-resolved" }, ["Resolved"]) : null,
          risk.track ? el("span", { class: "track-tag" }, [risk.track]) : null,
          risk.stage ? el("span", { class: "stage-tag" }, [risk.stage + " →"]) : null,
        ].filter(Boolean)),
        el("div", { class: "paired-item-mitigation" + (mitigation ? "" : " is-missing") }, [
          el("span", { class: "mitigation-label" }, ["Mitigation plan: "]),
          mitigation || "Not yet documented",
        ]),
      ]);
      // Same stage-detail-first behavior as dependencyListItems() above —
      // see the note there (2026-11-04).
      const open = () =>
        risk.stage ? openStageDetail(project.id, risk.stage) : openItemDetail("risk", project, risk);
      li.addEventListener("click", open);
      li.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
      return li;
    });
  }

  function collectDependencies(opts) {
    const skipCycle = opts && opts.skipCycle;
    const rows = [];
    const today = todayISO();
    visibleProjects().forEach((p) => {
      getDependencyObjects(p).forEach((dep) => {
        if (dep.resolved || isPlaceholderDependencyText(dep.text)) return;
        const dueBy = dep.dueBy || "";
        if (!skipCycle && depsCycleFilter !== "all" && dueBy) {
          if (dueByCalendarYear(dueBy) !== depsCycleFilter) return;
        }
        rows.push({
          projectId: p.id,
          projectName: p.name,
          status: effectiveStatus(p),
          id: dep.id,
          text: dep.text,
          team: dep.team || "",
          mitigation: dep.mitigation || "",
          dueBy,
          priority: dep.priority,
          dueWindow: dueWindowFor(dueBy, today),
          escalated: !!dep.escalated,
        });
      });
    });
    return rows;
  }

  function projectsWithOpenDependencies() {
    return visibleProjects().filter((p) => countOpenDependencies(p) > 0);
  }

  function dependencyCycleYears(rows) {
    const years = new Set();
    rows.forEach((r) => {
      const y = dueByCalendarYear(r.dueBy);
      if (y) years.add(y);
    });
    return Array.from(years).sort();
  }

  // Four KPIs aligned to the Dependencies mockup, grounded in this app's data:
  // active projects/teams from open deps; delayed projects = overall
  // `delayDays` > 0 (2026-10-05: previously "blocked stages" based on a
  // per-stage SLA-breach flag — see the note on renderStageGridLegend);
  // cumulative delay = summed `delayDays` across filtered projects;
  // rollout/hypercare = post-UAT pipeline stages.
  function renderDependenciesMetrics(rows) {
    const activeProjects = new Set(rows.map((r) => r.projectId)).size;
    const activeTeams = new Set(rows.map((r) => r.team || "Unlabeled")).size;

    const scopedProjects = projectsWithOpenDependencies();

    let delayedProjects = 0;
    let cumulativeDelay = 0;
    let rolloutHypercare = 0;
    scopedProjects.forEach((p) => {
      cumulativeDelay += p.delayDays || 0;
      if ((p.delayDays || 0) > 0) delayedProjects += 1;
      if (POST_UAT_STAGES.has(p.stage || "")) rolloutHypercare += 1;
    });

    const metrics = [
      {
        label: "Active Projects",
        num: activeProjects,
        sub: `across ${activeTeams} team${activeTeams === 1 ? "" : "s"}`,
        tone: "",
      },
      {
        label: "Projects Delayed",
        num: delayedProjects,
        sub: delayedProjects ? "need escalation" : "none right now",
        tone: delayedProjects ? "tone-red" : "tone-green",
      },
      {
        label: "Cumulative Delay",
        num: cumulativeDelay + "d",
        sub: "vs. committed go-live",
        tone: cumulativeDelay ? "tone-amber" : "tone-green",
      },
      {
        label: "In Rollout / Hypercare",
        num: rolloutHypercare,
        sub: "post-UAT",
        tone: rolloutHypercare ? "tone-accent" : "",
      },
    ];

    const row = document.getElementById("depsMetricsRow");
    row.innerHTML = "";
    metrics.forEach((m) => {
      row.appendChild(
        el("div", { class: ["metric-card", m.tone].filter(Boolean).join(" ") }, [
          el("div", { class: "num" }, [String(m.num)]),
          el("div", { class: "label" }, [m.label]),
          el("div", { class: "stage-grid-metric-sub" }, [m.sub]),
        ])
      );
    });
  }

  function renderDependenciesBoard(rows) {
    const board = document.getElementById("depsBoard");
    board.innerHTML = "";

    if (!rows.length) {
      board.appendChild(el("div", { class: "deps-empty-group" }, ["No dependencies recorded yet."]));
      return;
    }

    const groups = {};
    rows.forEach((r) => {
      const key = r.team || "Unlabeled";
      (groups[key] = groups[key] || []).push(r);
    });

    const groupNames = Object.keys(groups).sort((a, b) => {
      if (a === "Unlabeled") return 1;
      if (b === "Unlabeled") return -1;
      return groups[b].length - groups[a].length || a.localeCompare(b);
    });

    groupNames.forEach((team) => {
      const entries = groups[team];
      const group = el("div", { class: "deps-group" }, [
        el("div", { class: "deps-group-head" }, [
          el("h3", null, [team]),
          el("span", { class: "deps-group-count" }, [entries.length + (entries.length === 1 ? " dependency" : " dependencies")]),
        ]),
      ]);
      entries.forEach((r) => {
        const card = el("div", { class: "deps-card" }, [
          el("div", { class: "deps-card-project", "data-project-id": r.projectId }, [
            el("span", { class: "timeline-dot", style: `background:var(--${r.status === "amber" ? "amber" : r.status})` }),
            r.projectName,
          ]),
          el("div", { class: "deps-card-badges" }, [
            el("span", { class: "deps-badge deps-badge-priority is-" + r.priority.toLowerCase() }, [r.priority]),
            el("span", { class: "deps-badge deps-badge-due is-" + r.dueWindow.key }, [
              r.dueBy ? `${r.dueWindow.label} · ${fmtDate(r.dueBy)}` : "No date set",
            ]),
            ...(r.escalated
              ? [el("span", { class: "deps-badge deps-badge-escalated" }, ["🚨 Escalated"])]
              : []),
          ]),
          el("div", { class: "deps-card-text" }, [r.text]),
          el("div", { class: "deps-card-mitigation" + (r.mitigation ? "" : " is-missing") }, [
            r.mitigation || "Mitigation / impact not yet documented",
          ]),
        ]);
        group.appendChild(card);
      });
      board.appendChild(group);
    });

    board.querySelectorAll(".deps-card-project").forEach((node) => {
      node.addEventListener("click", () => openProjectDetail(node.getAttribute("data-project-id")));
    });
  }

  /* ---------------- Status History ---------------- */

  function computeStatusTransitions() {
    const dates = Object.keys(HISTORY).sort();
    const nameById = {};
    DATA.projects.forEach((p) => (nameById[p.id] = p.name));

    const prevStatus = {};
    const transitions = [];

    dates.forEach((asOf) => {
      (HISTORY[asOf].projects || []).forEach((snap) => {
        nameById[snap.id] = nameById[snap.id] || snap.name;
        const prev = prevStatus[snap.id];
        if (prev !== undefined && prev !== snap.status) {
          transitions.push({
            projectId: snap.id,
            projectName: nameById[snap.id] || snap.id,
            date: asOf,
            from: prev,
            to: snap.status,
            phase: snap.phase || "",
            stage: snap.stage || "",
            progress: typeof snap.progress === "number" ? snap.progress : null,
            delayNote: snap.delayNote || "",
            delayDays: snap.delayDays || 0,
            statusChangeReason: snap.statusChangeReason || "",
          });
        }
        prevStatus[snap.id] = snap.status;
      });
    });

    return transitions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.projectName.localeCompare(b.projectName)));
  }

  // Every time a go-live or milestone date moved (e.g. because of a CR),
  // across every project — the same diffing logic as the per-project
  // schedule timeline, just run over all projects at once.
  function computeScheduleShifts() {
    const dates = Object.keys(HISTORY).sort();
    const nameById = {};
    DATA.projects.forEach((p) => (nameById[p.id] = p.name));

    const prevGoLive = {};
    const prevMilestoneDate = {};
    const prevMilestoneName = {};
    const shifts = [];

    dates.forEach((asOf) => {
      (HISTORY[asOf].projects || []).forEach((snap) => {
        nameById[snap.id] = nameById[snap.id] || snap.name;
        const goLive = snap.goLive || null;
        const milestoneName = (snap.nextMilestone && snap.nextMilestone.name) || null;
        const milestoneDate = (snap.nextMilestone && snap.nextMilestone.date) || null;

        const pg = prevGoLive[snap.id];
        if (pg && goLive && goLive !== pg) {
          shifts.push({
            projectId: snap.id,
            projectName: nameById[snap.id] || snap.id,
            date: asOf,
            label: "Go-Live",
            from: pg,
            to: goLive,
            status: snap.status,
          });
        }

        const pmd = prevMilestoneDate[snap.id];
        const pmn = prevMilestoneName[snap.id];
        if (pmd && milestoneDate && (milestoneDate !== pmd || milestoneName !== pmn)) {
          shifts.push({
            projectId: snap.id,
            projectName: nameById[snap.id] || snap.id,
            date: asOf,
            label: milestoneName || pmn || "Milestone",
            from: pmd,
            to: milestoneDate,
            status: snap.status,
          });
        }

        if (goLive) prevGoLive[snap.id] = goLive;
        if (milestoneDate) {
          prevMilestoneDate[snap.id] = milestoneDate;
          prevMilestoneName[snap.id] = milestoneName;
        }
      });
    });

    return shifts;
  }

  // For each project, the single most recent status transition OR
  // go-live/milestone date shift (whichever happened later) — same source
  // data as the Status History tab, just collapsed to "what changed most
  // recently" per project so a card can show a one-line glimpse of it
  // without opening the full detail view. Returns { [projectId]: event }.
  function mostRecentChangeByProject() {
    const byProject = {};
    const consider = (event) => {
      const cur = byProject[event.projectId];
      if (!cur || event.date > cur.date) byProject[event.projectId] = event;
    };
    computeStatusTransitions().forEach((t) => consider(Object.assign({ kind: "status" }, t)));
    computeScheduleShifts().forEach((s) => consider(Object.assign({ kind: "schedule" }, s)));
    return byProject;
  }

  // Compact one-line rendering of a `mostRecentChangeByProject()` entry for
  // a project card — mirrors the Status History tab's row content (status
  // pill → pill, or "label moved from → to (±Nd)"), just squeezed down.
  function cardRecentChangeNode(event) {
    if (!event) return null;
    if (event.kind === "status") {
      return el("div", { class: "card-recent-change", title: "Most recent status/date change — open this project's detail view for the full log" }, [
        el("span", { class: "card-recent-change-date" }, [fmtDateShort(event.date)]),
        el("span", { class: "pill pill-" + event.from }, [STATUS_LABEL[event.from]]),
        el("span", { class: "card-recent-change-arrow" }, ["→"]),
        el("span", { class: "pill pill-" + event.to }, [STATUS_LABEL[event.to]]),
      ]);
    }
    const deltaDays = Math.round((new Date(event.to + "T00:00:00") - new Date(event.from + "T00:00:00")) / 86400000);
    return el("div", { class: "card-recent-change", title: "Most recent status/date change — open this project's detail view for the full log" }, [
      el("span", { class: "card-recent-change-date" }, [fmtDateShort(event.date)]),
      el("span", { class: "schedule-shift-badge" }, ["📅 " + event.label + " moved"]),
      el("span", { class: "golive-date-original" }, [fmtDateShort(event.from)]),
      el("span", { class: "card-recent-change-arrow" }, ["→"]),
      el("span", { class: "golive-date-current" }, [fmtDateShort(event.to)]),
      deltaDays !== 0
        ? el("span", { class: "schedule-timeline-delta " + (deltaDays > 0 ? "is-late" : "is-early") }, [(deltaDays > 0 ? "+" : "") + deltaDays + "d"])
        : null,
    ].filter(Boolean));
  }

  // Builds the nested rollup rows for the pivot table: primary group (either
  // "project" or "team") -> secondary group (the other one) -> counts. A
  // primary-group subtotal row sits above its secondary rows, mirroring the
  // mockup's nested Project -> Team pivot (just usable in either direction,
  // since teams like DevOps need the mirror image of that same table to see
  // everything they're on the hook for across every project in one place).
  function buildDependenciesPivot(rows, groupBy) {
    const primaryKey = groupBy === "team" ? "team" : "projectId";
    const primaryLabel = groupBy === "team" ? "team" : "projectName";
    const secondaryLabel = groupBy === "team" ? "projectName" : "team";

    function emptyCounts() {
      const c = { total: 0, escalated: 0 };
      PRIORITY_ORDER.forEach((p) => (c[p] = 0));
      DUE_WINDOWS.forEach((w) => (c[w.key] = 0));
      return c;
    }

    function tally(counts, r) {
      counts.total += 1;
      counts[r.priority] += 1;
      if (r.dueWindow.key !== "no-date" && counts[r.dueWindow.key] != null) counts[r.dueWindow.key] += 1;
      if (r.escalated) counts.escalated += 1;
    }

    const primaries = {};
    rows.forEach((r) => {
      const pKey = r[primaryKey] || "Unlabeled";
      const pLabel = r[primaryLabel] || "Unlabeled";
      const group =
        primaries[pKey] ||
        (primaries[pKey] = { primaryKey: pKey, label: pLabel, counts: emptyCounts(), secondaries: {} });
      tally(group.counts, r);
      const sKey = r[secondaryLabel] || "Unlabeled";
      const sub =
        group.secondaries[sKey] ||
        (group.secondaries[sKey] = { secondaryKey: sKey, label: sKey, counts: emptyCounts() });
      tally(sub.counts, r);
    });

    return Object.keys(primaries)
      .map((k) => primaries[k])
      .sort((a, b) => b.counts.total - a.counts.total || a.label.localeCompare(b.label))
      .map((group) => ({
        ...group,
        secondaries: Object.keys(group.secondaries)
          .map((k) => group.secondaries[k])
          .sort((a, b) => b.counts.total - a.counts.total || a.label.localeCompare(b.label)),
      }));
  }

  function depsPivotPrimaryKey(r) {
    return depsPivotGroupBy === "team" ? r.team || "Unlabeled" : r.projectId;
  }

  function depsPivotSecondaryKey(r) {
    return depsPivotGroupBy === "team" ? r.projectName || "Unlabeled" : r.team || "Unlabeled";
  }

  function filterDepsForDrill(rows, spec) {
    return rows.filter((r) => {
      if (spec.primaryKey != null && depsPivotPrimaryKey(r) !== spec.primaryKey) return false;
      if (spec.secondaryKey != null && depsPivotSecondaryKey(r) !== spec.secondaryKey) return false;
      if (spec.metric === "total") return true;
      if (spec.metric === "priority") return r.priority === spec.value;
      if (spec.metric === "dueWindow") return r.dueWindow.key === spec.value;
      return true;
    });
  }

  function depsPivotCountCellClass(n, kind, key) {
    let cls = "deps-pivot-num";
    if (!n) cls += " is-zero";
    else cls += " is-clickable";
    if (kind === "priority" && key) cls += " is-priority is-" + key.toLowerCase();
    if (kind === "dueWindow" && key === "overdue" && n) cls += " is-overdue";
    if (kind === "dueWindow" && key === "today" && n) cls += " is-due-soon";
    if (kind === "dueWindow" && key === "tomorrow" && n) cls += " is-due-soon";
    if (kind === "total" && n) cls += " deps-pivot-total";
    return cls;
  }

  function depsPivotCountCell(n, drill) {
    const attrs = {
      class: depsPivotCountCellClass(n, drill.kind, drill.value),
    };
    if (n) {
      attrs["data-drill"] = "1";
      attrs["data-drill-metric"] = drill.metric;
      if (drill.value) attrs["data-drill-value"] = drill.value;
      if (drill.primaryKey != null) attrs["data-drill-primary"] = drill.primaryKey;
      if (drill.secondaryKey != null) attrs["data-drill-secondary"] = drill.secondaryKey;
    }
    return el("td", attrs, [n ? String(n) : "—"]);
  }

  function renderDependenciesPivot(rows) {
    const wrap = document.getElementById("depsPivotWrap");
    wrap.innerHTML = "";
    wrap.classList.toggle("is-compact", depsPivotCompact);

    if (!rows.length) {
      wrap.appendChild(el("div", { class: "deps-empty-group" }, ["No dependencies recorded yet."]));
      lastDepsPivotExport = null;
      return;
    }

    const groups = buildDependenciesPivot(rows, depsPivotGroupBy);
    lastDepsPivotExport = { rows, groups, groupBy: depsPivotGroupBy };

    const colPrimary = depsPivotGroupBy === "team" ? "Team" : "Project";
    const colSecondary = depsPivotGroupBy === "team" ? "Project" : "Team";

    const headRow1 = el("tr", null, [
      el("th", { rowspan: "2", class: "deps-pivot-group-head" }, [colPrimary]),
      el("th", { rowspan: "2", class: "deps-pivot-group-head" }, [colSecondary]),
      el("th", { rowspan: "2" }, ["Total"]),
      el("th", { colspan: String(PRIORITY_ORDER.length) }, ["By Priority"]),
      el("th", { colspan: String(DUE_WINDOWS.length) }, ["By Due Window"]),
    ]);
    const headRow2 = el("tr", null, [
      ...PRIORITY_ORDER.map((p) => el("th", { class: "deps-pivot-sub-head is-" + p.toLowerCase() }, [p])),
      ...DUE_WINDOWS.map((w) => el("th", { class: "deps-pivot-sub-head is-" + w.key }, [w.label])),
    ]);

    function countCells(counts, drillBase) {
      return [
        depsPivotCountCell(counts.total, { ...drillBase, metric: "total", kind: "total" }),
        ...PRIORITY_ORDER.map((p) =>
          depsPivotCountCell(counts[p], { ...drillBase, metric: "priority", value: p, kind: "priority" })
        ),
        ...DUE_WINDOWS.map((w) =>
          depsPivotCountCell(counts[w.key], { ...drillBase, metric: "dueWindow", value: w.key, kind: "dueWindow" })
        ),
      ];
    }

    const tbody = el("tbody");
    groups.forEach((group) => {
      const primaryKey = group.primaryKey;
      const subCount = group.secondaries.length;
      const rowSpan = subCount + 1;

      tbody.appendChild(
        el("tr", {
          class: "deps-pivot-primary-row deps-pivot-group-total-row",
          "data-pivot-row": "group-total",
        }, [
          el("td", { class: "deps-pivot-group-cell deps-pivot-primary-label", rowspan: String(rowSpan) }, [
            group.label,
            group.counts.escalated
              ? el("span", { class: "deps-pivot-escalated-flag", title: "Has escalated dependencies" }, [" 🚨"])
              : null,
          ]),
          el("td", { class: "deps-pivot-group-cell deps-pivot-total-meta-cell" }, [
            el("span", { class: "deps-pivot-total-badge" }, ["Group total"]),
          ]),
          ...countCells(group.counts, { primaryKey, secondaryKey: null }),
        ])
      );

      group.secondaries.forEach((sub, idx) => {
        const isLast = idx === subCount - 1;
        const rowClass =
          "deps-pivot-secondary-row deps-pivot-breakdown-row" + (isLast ? " deps-pivot-group-end" : "");
        const tr = el("tr", { class: rowClass, "data-pivot-row": "breakdown" }, [
          el("td", { class: "deps-pivot-group-cell deps-pivot-sub-cell" }, [
            el("span", { class: "deps-pivot-breakdown-label" }, [sub.label]),
          ]),
          ...countCells(sub.counts, {
            primaryKey,
            secondaryKey: sub.secondaryKey,
          }),
        ]);
        tbody.appendChild(tr);
      });
    });

    const table = el("table", { class: "deps-pivot" }, [el("thead", null, [headRow1, headRow2]), tbody]);
    wrap.appendChild(table);

    table.querySelectorAll("[data-drill]").forEach((cell) => {
      cell.addEventListener("click", () => {
        const spec = {
          primaryKey: cell.getAttribute("data-drill-primary"),
          secondaryKey: cell.getAttribute("data-drill-secondary") || null,
          metric: cell.getAttribute("data-drill-metric"),
          value: cell.getAttribute("data-drill-value") || null,
        };
        openDepsDrillModal(filterDepsForDrill(rows, spec), spec);
      });
    });
  }

  function openDepsDrillModal(items, spec) {
    const modal = document.getElementById("depsDrillModal");
    const title = document.getElementById("depsDrillTitle");
    const sub = document.getElementById("depsDrillSub");
    const list = document.getElementById("depsDrillList");
    list.innerHTML = "";

    const bits = [];
    if (spec.primaryKey != null) bits.push(depsPivotGroupBy === "team" ? "Team" : "Project");
    if (spec.secondaryKey != null) bits.push(depsPivotGroupBy === "team" ? "Project" : "Team");
    if (spec.metric === "priority") bits.push(spec.value + " priority");
    else if (spec.metric === "dueWindow") bits.push(DUE_WINDOW_BY_KEY[spec.value].label);
    else if (spec.metric === "total") bits.push("all items in row");

    title.textContent = items.length + (items.length === 1 ? " dependency" : " dependencies");
    sub.textContent = bits.length ? bits.join(" · ") : "Filtered list";

    if (!items.length) {
      list.appendChild(el("p", { class: "deps-empty-group" }, ["No matching items."]));
    } else {
      const table = el("table", { class: "deps-drill-table" }, [
        el("colgroup", null, [
          el("col", { class: "deps-drill-col-project" }),
          el("col", { class: "deps-drill-col-team" }),
          el("col", { class: "deps-drill-col-priority" }),
          el("col", { class: "deps-drill-col-due" }),
          el("col", { class: "deps-drill-col-escalated" }),
          el("col", { class: "deps-drill-col-desc" }),
        ]),
        el("thead", null, [
          el("tr", null, [
            el("th", null, ["Project"]),
            el("th", null, ["Team"]),
            el("th", null, ["Priority"]),
            el("th", null, ["Needed by"]),
            el("th", null, ["Escalated"]),
            el("th", null, ["Description"]),
          ]),
        ]),
        el(
          "tbody",
          null,
          items.map((r) =>
            el("tr", null, [
              el("td", { class: "deps-drill-col-project" }, [r.projectName]),
              el("td", { class: "deps-drill-col-team" }, [r.team || "—"]),
              el("td", { class: "deps-drill-col-priority" }, [
                el("span", { class: "deps-badge deps-badge-priority is-" + r.priority.toLowerCase() }, [r.priority]),
              ]),
              el("td", { class: "deps-drill-col-due" }, [r.dueBy ? fmtDate(r.dueBy) : "No date"]),
              el("td", { class: "deps-drill-col-escalated" }, [r.escalated ? "Yes" : "—"]),
              el("td", { class: "deps-drill-desc" }, [r.text]),
            ])
          )
        ),
      ]);
      list.appendChild(table);
    }

    modal.hidden = false;
  }

  function closeDepsDrillModal() {
    document.getElementById("depsDrillModal").hidden = true;
  }

  function csvEscapeField(val) {
    const s = String(val == null ? "" : val);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportDependenciesPivotCsv() {
    if (!lastDepsPivotExport || !lastDepsPivotExport.groups.length) return;
    const { groups, groupBy } = lastDepsPivotExport;
    const colPrimary = groupBy === "team" ? "Team" : "Project";
    const colSecondary = groupBy === "team" ? "Project" : "Team";
    const headers = [colPrimary, colSecondary, "Total", ...PRIORITY_ORDER, ...DUE_WINDOWS.map((w) => w.label)];
    const lines = [headers.map(csvEscapeField).join(",")];

    groups.forEach((group) => {
      group.secondaries.forEach((sub) => {
        lines.push(
          [
            group.label,
            sub.label,
            sub.counts.total,
            ...PRIORITY_ORDER.map((p) => sub.counts[p]),
            ...DUE_WINDOWS.map((w) => sub.counts[w.key]),
          ]
            .map(csvEscapeField)
            .join(",")
        );
      });
      lines.push(
        [
          group.label,
          "Total · " + group.label,
          group.counts.total,
          ...PRIORITY_ORDER.map((p) => group.counts[p]),
          ...DUE_WINDOWS.map((w) => group.counts[w.key]),
        ]
          .map(csvEscapeField)
          .join(",")
      );
    });

    const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "dependencies-pivot-" + groupBy + "-" + todayISO() + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  function populateDepsCycleFilter(rows) {
    const select = document.getElementById("depsCycleFilter");
    if (!select) return;
    const years = dependencyCycleYears(rows);
    const prev = depsCycleFilter;
    select.innerHTML = "";
    select.appendChild(el("option", { value: "all" }, ["All cycles"]));
    years.forEach((y) => {
      select.appendChild(el("option", { value: y }, ["FY " + y]));
    });
    if (prev !== "all" && years.includes(prev)) select.value = prev;
    else {
      depsCycleFilter = "all";
      select.value = "all";
    }
  }

  function updateDepsPivotSectionTitle() {
    const node = document.getElementById("depsPivotSectionTitle");
    if (!node) return;
    node.textContent =
      depsPivotGroupBy === "team" ? "Team-wise dependencies" : "Project-wise dependencies";
  }

  function wireDepsPivotControls() {
    const toggle = document.getElementById("depsViewToggle");
    if (toggle && !toggle.dataset.wired) {
      toggle.dataset.wired = "1";
      toggle.querySelectorAll(".deps-view-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          depsPivotGroupBy = btn.getAttribute("data-group");
          toggle.querySelectorAll(".deps-view-btn").forEach((b) => b.classList.toggle("is-active", b === btn));
          updateDepsPivotSectionTitle();
          renderDependenciesTab();
        });
      });
    }

    const cycle = document.getElementById("depsCycleFilter");
    if (cycle && !cycle.dataset.wired) {
      cycle.dataset.wired = "1";
      cycle.addEventListener("change", () => {
        depsCycleFilter = cycle.value;
        renderDependenciesTab();
      });
    }

    const compactBtn = document.getElementById("depsCompactToggle");
    if (compactBtn && !compactBtn.dataset.wired) {
      compactBtn.dataset.wired = "1";
      compactBtn.addEventListener("click", () => {
        depsPivotCompact = !depsPivotCompact;
        compactBtn.classList.toggle("is-active", depsPivotCompact);
        compactBtn.setAttribute("aria-pressed", depsPivotCompact ? "true" : "false");
        renderDependenciesPivot(collectDependencies());
      });
    }

    const exportBtn = document.getElementById("depsExportBtn");
    if (exportBtn && !exportBtn.dataset.wired) {
      exportBtn.dataset.wired = "1";
      exportBtn.addEventListener("click", exportDependenciesPivotCsv);
    }
  }

  function wireDepsDrillModal() {
    const modal = document.getElementById("depsDrillModal");
    if (!modal || modal.dataset.wired) return;
    modal.dataset.wired = "1";
    document.getElementById("depsDrillClose").addEventListener("click", closeDepsDrillModal);
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeDepsDrillModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !modal.hidden) closeDepsDrillModal();
    });
  }

  function renderDependenciesTab() {
    const rowsPreCycle = collectDependencies({ skipCycle: true });
    populateDepsCycleFilter(rowsPreCycle);
    const rows = collectDependencies();
    renderDependenciesMetrics(rows);
    renderDependenciesPivot(rows);
    renderDependenciesBoard(rows);
    updateDepsPivotSectionTitle();
    wireDepsPivotControls();
    wireDepsDrillModal();
  }

  /* ---------------- Tab: Escalations ---------------- */

  function collectEscalations() {
    const rows = [];
    visibleProjects().forEach((p) => {
      (p.escalations || []).forEach((text) => {
        if (!text) return;
        rows.push({ projectId: p.id, projectName: p.name, owner: p.owner || "Unassigned", status: effectiveStatus(p), text });
      });
    });
    return rows;
  }

  function renderEscalationsMetrics(rows) {
    const projects = new Set(rows.map((r) => r.projectId));
    const metrics = [
      { label: "Total Escalations", num: rows.length, tone: rows.length ? "tone-red" : "tone-green" },
      { label: "Projects Escalating", num: projects.size, tone: projects.size ? "tone-amber" : "tone-green" },
    ];
    const row = document.getElementById("escalationsMetricsRow");
    row.innerHTML = "";
    metrics.forEach((m) => {
      row.appendChild(
        el("div", { class: "metric-card " + m.tone }, [
          el("div", { class: "num" }, [String(m.num)]),
          el("div", { class: "label" }, [m.label]),
        ])
      );
    });
  }

  function renderEscalationsBoard(rows) {
    const board = document.getElementById("escalationsBoard");
    board.innerHTML = "";

    if (!rows.length) {
      board.appendChild(
        el("div", { class: "deps-empty-group" }, ["Nothing currently escalated to leadership. 🎉"])
      );
      return;
    }

    const groups = {};
    rows.forEach((r) => {
      (groups[r.projectId] = groups[r.projectId] || { projectName: r.projectName, owner: r.owner, status: r.status, items: [] }).items.push(r.text);
    });

    Object.keys(groups)
      .sort((a, b) => groups[b].items.length - groups[a].items.length || groups[a].projectName.localeCompare(groups[b].projectName))
      .forEach((projectId) => {
        const g = groups[projectId];
        const group = el("div", { class: "deps-group escalations-group" }, [
          el("div", { class: "deps-group-head" }, [
            el("div", { class: "deps-card-project escalations-project", "data-project-id": projectId }, [
              el("span", { class: "timeline-dot", style: `background:var(--${g.status === "amber" ? "amber" : g.status})` }),
              g.projectName,
              el("span", { class: "escalations-owner" }, [" · " + g.owner]),
            ]),
            el("span", { class: "deps-group-count" }, [g.items.length + (g.items.length === 1 ? " escalation" : " escalations")]),
          ]),
        ]);
        const list = el("ul", { class: "escalations-list" }, g.items.map((text) => el("li", null, [text])));
        group.appendChild(list);
        board.appendChild(group);
      });

    board.querySelectorAll(".deps-card-project").forEach((node) => {
      node.addEventListener("click", () => openProjectDetail(node.getAttribute("data-project-id")));
    });
  }

  function copyEscalationsSummary(rows) {
    const btn = document.getElementById("copyEscalationsBtn");
    if (!rows.length) {
      btn.textContent = "Nothing to copy";
      setTimeout(() => (btn.textContent = "📋 Copy summary to share"), 1500);
      return;
    }
    const groups = {};
    rows.forEach((r) => {
      (groups[r.projectName] = groups[r.projectName] || []).push(r.text);
    });
    const asOf = DATA.asOf ? fmtDate(DATA.asOf) : "";
    const lines = [`Escalations to leadership — as of ${asOf}`, ""];
    Object.keys(groups).forEach((name) => {
      lines.push(`${name}:`);
      groups[name].forEach((text) => lines.push(`  • ${text}`));
      lines.push("");
    });
    const text = lines.join("\n").trim();

    const done = () => {
      btn.textContent = "✅ Copied!";
      setTimeout(() => (btn.textContent = "📋 Copy summary to share"), 1500);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(done);
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } catch (e) {
        // ignore
      }
      document.body.removeChild(ta);
      done();
    }
  }

  function renderEscalationsTab() {
    const rows = collectEscalations();
    renderEscalationsMetrics(rows);
    renderEscalationsBoard(rows);
    const btn = document.getElementById("copyEscalationsBtn");
    if (btn) btn.onclick = () => copyEscalationsSummary(rows);
  }

  /* ---------------- Project detail overlay ---------------- */

  function historyForProject(projectId) {
    return Object.keys(HISTORY)
      .sort()
      .map((asOf) => {
        const snap = HISTORY[asOf].projects.find((p) => p.id === projectId);
        // A snapshot may carry its own `asOf` to correct one project's
        // date without moving the whole week (e.g. GMS 1.4 went live
        // 10-12, captured in the 10-14 snapshot) — it wins over the key.
        return snap ? { asOf, ...snap } : null;
      })
      .filter(Boolean)
      .sort((a, b) => (a.asOf < b.asOf ? -1 : a.asOf > b.asOf ? 1 : 0));
  }

  // Monday of the calendar week containing `iso`. Local date math, not
  // toISOString, so a US timezone doesn't shift the week back a day.
  function weekStartMonday(iso) {
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  // One point per calendar week (Monday–Sunday), keeping the latest
  // snapshot in that week. Extra PM updates in the same week — a Monday
  // correction and Tuesday's report, or several PRs — collapse to that
  // one point. The axis is labeled with the Monday, not the PR date.
  // Used only by the progress chart. The date-change log keeps every snapshot.
  function weeklyHistoryForProject(projectId) {
    const byWeek = new Map();
    historyForProject(projectId).forEach((w) => {
      const key = weekStartMonday(w.asOf);
      const prev = byWeek.get(key);
      if (!prev || w.asOf > prev.asOf) byWeek.set(key, Object.assign({}, w, { weekOf: key }));
    });
    return Array.from(byWeek.values()).sort((a, b) => (a.weekOf < b.weekOf ? -1 : 1));
  }

  /* ---------------- Stage-gate timeline ---------------- */

  // Generic per-stage duration estimates — used ONLY as a placeholder
  // width when drawing a not-yet-reached future stage that has no real
  // stagePlan date on record yet (Hawk-eye future chips, the per-project
  // Stage-gate timeline). NOT used as an SLA/breach threshold against real
  // elapsed time anymore (2026-10-05 — comparing a project's real stage
  // duration against one flat constant per stage name, regardless of
  // project size, was flagging large-but-on-plan projects as wildly
  // "delayed" when they weren't; see renderStageGridLegend for the full
  // note). The project's own overall `delayDays` is the one real delay
  // number surfaced everywhere now. data.json's top-level `stageSlaDays`
  // still wins if present, so these can be tuned without touching code.
  const DEFAULT_STAGE_SLA_DAYS = {
    "Proposal": 7,
    "Requirements": 10,
    "Tech. Design": 7,
    "Estimate & Planning": 5,
    "Development": 30,
    "UAT": 10,
    "VAPT": 5,
    "Rollout": 5,
    "Hypercare": 21,
  };

  function stageSlaDays(stage) {
    const configured = DATA && DATA.stageSlaDays;
    if (configured && configured[stage] != null) return configured[stage];
    return DEFAULT_STAGE_SLA_DAYS[stage] != null ? DEFAULT_STAGE_SLA_DAYS[stage] : null;
  }

  function daysBetweenIso(aIso, bIso) {
    const DAY = 86400000;
    return Math.round((new Date(bIso + "T00:00:00") - new Date(aIso + "T00:00:00")) / DAY);
  }

  // Same idea as `daysBetweenIso`, but only counts Mon–Fri (2026-11-04,
  // per explicit request: "delays should not count weekends, just
  // weekdays"). Used specifically for DELAY/variance figures — how much a
  // stage's actual or revised dates slipped against its own plan — not for
  // plain elapsed-time counts (lifecycle age, a stage's raw duration, or
  // "this date moved by Xd" schedule-shift logs), which are left as
  // calendar days since those aren't "delay," just distance between dates.
  function businessDaysBetweenIso(aIso, bIso) {
    const DAY = 86400000;
    const a = new Date(aIso + "T00:00:00").getTime();
    const b = new Date(bIso + "T00:00:00").getTime();
    const sign = b >= a ? 1 : -1;
    const start = sign === 1 ? a : b;
    const end = sign === 1 ? b : a;
    let count = 0;
    for (let t = start; t < end; t += DAY) {
      const dow = new Date(t).getDay(); // 0 = Sun, 6 = Sat
      if (dow !== 0 && dow !== 6) count++;
    }
    return count * sign;
  }

  // Is the CURRENT stage running past its own committed end date (2026-10-06)?
  // Compares today against THIS project's own stagePlan.latestEnd for the
  // stage it's actually in right now — not a flat per-stage-name constant
  // (that's the SLA approach removed earlier) and not just "is the overall
  // project red" (a project can be red for reasons unrelated to the
  // specific stage it's sitting in, e.g. myBKY 2A was still reporting
  // "Requirements" as current a week after its own plan said Requirements
  // would be done — that's the real, data-grounded signal for "this stage
  // is now overdue"). No stagePlan on record yet → can't say overdue,
  // defaults to false (still "in progress").
  function currentStageOverdue(p, stage) {
    const plan = p.stagePlan && p.stagePlan[stage];
    const plannedEnd = plan && (plan.latestEnd || plan.initialEnd);
    if (!plannedEnd) return false;
    return todayISO() > plannedEnd;
  }

  // Per-stage delay vs THIS project's own original end date (2026-11-05).
  // Weekdays from initialEnd to latestEnd — the same slip the stage
  // detail card calls "latest plan vs initial". Comparing against
  // latestEnd instead zeroed the chip whenever the stage finished on its
  // revised date: MyBKY UAT ended 30 Sep against a 9 Sep original end
  // (+15 weekdays) and the grid showed no red label, because latestEnd
  // had already moved to 30 Sep. Positive = finished after the original
  // end (red chip). Negative = finished before it (green, pulled up).
  // Null when there is no original end, or the current stage has neither
  // a revised end nor run past the original one yet.
  function stagePlanDelayDays(p, stage, seg) {
    if (!seg) return null;
    const plan = p.stagePlan && p.stagePlan[stage];
    if (!plan) return null;
    const plannedEnd = plan.initialEnd || plan.latestEnd;
    if (!plannedEnd) return null;
    let actualEnd = null;
    if (seg.ongoing) {
      if (plan.latestEnd && plan.latestEnd !== plannedEnd) actualEnd = plan.latestEnd;
      else if (todayISO() > plannedEnd) actualEnd = todayISO();
    } else {
      actualEnd = plan.latestEnd || seg.end;
    }
    if (!actualEnd || actualEnd === plannedEnd) return null;
    return businessDaysBetweenIso(plannedEnd, actualEnd);
  }

  // Reconstructs how long a project has spent in each pipeline stage, using
  // the weekly history snapshots (only granularity we have — this isn't
  // exact to the day, but good enough for a weekly leadership review).
  // Returns an ordered list of segments: { stage, start, end, ongoing,
  // approxStart }. `approxStart` marks the very first segment, since we
  // don't know how long the project was in that stage before tracking began.
  function computeStageSegments(p) {
    const today = todayISO();
    if (p.stageDatesFromPlan) return stageSegmentsFromPlan(p, today);
    const points = historyForProject(p.id).map((w) => ({ asOf: w.asOf, stage: w.stage || "Unstaged" }));
    const currentStage = p.stage || "Unstaged";
    // Track this explicitly (rather than re-deriving it later) — needed
    // below to know whether the final segment boundary is a REAL snapshot
    // date or one we just made up because there's no fresher data yet.
    const injectedFinalPoint = !points.length || points[points.length - 1].stage !== currentStage;
    if (injectedFinalPoint) {
      points.push({ asOf: today, stage: currentStage });
    }

    const segments = [];
    points.forEach((pt) => {
      const last = segments[segments.length - 1];
      if (!last || last.stage !== pt.stage) {
        if (last) last.end = pt.asOf;
        segments.push({ stage: pt.stage, start: pt.asOf, end: null });
      }
    });

    const finalSeg = segments[segments.length - 1];
    if (finalSeg) {
      finalSeg.end = today;
      finalSeg.ongoing = true;
    }
    if (segments.length) segments[0].approxStart = true;

    // If `currentStage` doesn't match the last real weekly snapshot (e.g.
    // the last snapshot is a few weeks old and `stagePlan` says the
    // project should have moved on by now, per its own un-delayed
    // schedule), the segment we just closed out above — the one
    // immediately before the synthetic "today" point — got `end: today`
    // purely by construction. That's almost certainly not when the real
    // transition happened; we just don't have a fresher snapshot to prove
    // the exact date. Prefer a real stagePlan end date for that stage when
    // one's on record and falls on/before today, instead of "whenever we
    // happened to check."
    if (injectedFinalPoint && segments.length >= 2) {
      const closedSeg = segments[segments.length - 2];
      const plan = p.stagePlan && p.stagePlan[closedSeg.stage];
      const planEnd = plan && (plan.latestEnd || plan.initialEnd);
      if (planEnd && planEnd <= today && planEnd > closedSeg.start) {
        closedSeg.end = planEnd;
      }
    }

    const withDays = segments.map((seg) => ({ ...seg, days: Math.max(0, daysBetweenIso(seg.start, seg.end)) }));

    // History only ever captures the stage a project was in AS OF each
    // weekly snapshot. If tracking started after a project had already
    // moved past its earliest canonical stages (e.g. Requirements/Design
    // were done before this dashboard existed), those stages never show up
    // in `points` above and the Stage-gate timeline looks like it's
    // missing rows — even though the real dates are known and recorded on
    // `stagePlan`. Backfill any canonical PIPELINE_STAGES entry that's
    // strictly before the current stage, has real dates on `stagePlan`,
    // and has no history-derived segment of its own — using those planned
    // dates as the actual completed range. This never overrides a real
    // history-derived segment; it only fills gaps, so it's a no-op for
    // every project that doesn't have this kind of pre-tracking stagePlan
    // backfill recorded.
    const currentIndex = PIPELINE_STAGES.indexOf(currentStage);
    const covered = new Set(withDays.map((seg) => seg.stage));
    const backfilled = [];
    if (currentIndex > 0 && p.stagePlan) {
      PIPELINE_STAGES.slice(0, currentIndex).forEach((stage) => {
        if (covered.has(stage)) return;
        const plan = p.stagePlan[stage];
        if (!plan) return;
        const start = plan.initialStart || plan.latestStart;
        const end = plan.latestEnd || plan.initialEnd;
        if (!start || !end) return;
        backfilled.push({ stage, start, end, days: Math.max(0, daysBetweenIso(start, end)) });
      });
    }

    // Also use the current (ongoing) stage's own planned start date instead
    // of the history-derived guess, when available — same reasoning as the
    // backfill above: a recorded stagePlan date is more accurate than
    // "first time we saw this project's stage in a weekly snapshot". This
    // runs regardless of whether any earlier stage needed backfilling (a
    // project whose CURRENT stage is already the very first canonical
    // stage, e.g. still in Requirements, has nothing to backfill but can
    // still have a real recorded start date worth using).
    const liveSeg = withDays[withDays.length - 1];
    const livePlan = p.stagePlan && p.stagePlan[currentStage];
    if (liveSeg && liveSeg.ongoing && livePlan) {
      const planStart = livePlan.initialStart || livePlan.latestStart;
      if (planStart && planStart < liveSeg.start) {
        liveSeg.start = planStart;
        liveSeg.days = Math.max(0, daysBetweenIso(planStart, today));
        liveSeg.approxStart = false;
      }
    }

    if (!backfilled.length) return withDays;

    // A backfilled stage is now the true first stage we know about — clear
    // approxStart from whatever history-derived segment used to be first
    // (it no longer is; the earliest backfilled stage's start came from
    // real recorded dates, not a guess, so none of these need the "≥" hedge
    // anymore).
    withDays.forEach((seg) => { seg.approxStart = false; });

    // Merge into canonical stage order (backfilled entries slot in among
    // the history-derived ones by their position in PIPELINE_STAGES; any
    // "Unstaged"/unrecognized stage name sorts after known stages but
    // otherwise keeps its original relative position).
    const combined = [...backfilled, ...withDays];
    combined.sort((a, b) => {
      const ai = PIPELINE_STAGES.indexOf(a.stage);
      const bi = PIPELINE_STAGES.indexOf(b.stage);
      if (ai === -1 && bi === -1) return 0;
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });
    return combined;
  }

  // `p.stageDatesFromPlan` (2026-11-03, GMS 1.4): the PM's own stage table
  // is the source of truth, so every stage up to the current one is
  // plotted straight from stagePlan's latest (post-delay) dates instead of
  // being reconstructed from weekly snapshots — which, for GMS, still
  // carried the previous release's UAT/Rollout and a stale Development
  // stretch. The current stage runs from its latest start to today.
  function stageSegmentsFromPlan(p, today) {
    const currentIndex = PIPELINE_STAGES.indexOf(p.stage || "Unstaged");
    const segments = [];
    PIPELINE_STAGES.slice(0, currentIndex + 1).forEach((stage, i) => {
      const plan = p.stagePlan && p.stagePlan[stage];
      const start = plan && (plan.latestStart || plan.initialStart);
      if (!start) return;
      const ongoing = i === currentIndex;
      const end = ongoing ? today : plan.latestEnd || plan.initialEnd;
      if (!end) return;
      segments.push({ stage, start, end, ongoing, days: Math.max(0, daysBetweenIso(start, end)) });
    });
    return segments;
  }

  /* ---------------- Stage detail modal (per-stage planned/actual dates,
     delay attribution, delay log) ---------------- */

  // Diffs `stagePlan[stage].latestStart` / `.latestEnd` across every weekly
  // history snapshot for this project, building a revision log: the first
  // time a field is seen is its "Baseline" row, every later change is a
  // numbered revision with the day-shift from the immediately preceding
  // value (not the baseline) — same semantics as computeScheduleShifts, just
  // scoped to one stage's planned dates instead of goLive/milestones.
  function stagePlanRevisions(p, stage) {
    const weeks = historyForProject(p.id);
    const revisions = [];
    let prevStart = null;
    let prevEnd = null;
    let startRevNum = 0;
    let endRevNum = 0;

    weeks.forEach((w) => {
      const plan = (w.stagePlan && w.stagePlan[stage]) || null;
      const start = plan ? plan.latestStart : null;
      const end = plan ? plan.latestEnd : null;

      if (start && start !== prevStart) {
        revisions.push({
          revision: prevStart === null ? "Baseline" : "Rev " + ++startRevNum,
          changedOn: w.asOf,
          field: "Planned Start",
          from: prevStart,
          to: start,
          shiftDays: prevStart === null ? null : daysBetweenIso(prevStart, start),
        });
        prevStart = start;
      }
      if (end && end !== prevEnd) {
        revisions.push({
          revision: prevEnd === null ? "Baseline" : "Rev " + ++endRevNum,
          changedOn: w.asOf,
          field: "Planned Completion",
          from: prevEnd,
          to: end,
          shiftDays: prevEnd === null ? null : daysBetweenIso(prevEnd, end),
        });
        prevEnd = end;
      }
    });

    // Live data.json may be ahead of the last captured snapshot (this
    // week's update hasn't been through a snapshot yet) — include it too.
    const livePlan = (p.stagePlan && p.stagePlan[stage]) || null;
    if (livePlan) {
      if (livePlan.latestStart && livePlan.latestStart !== prevStart) {
        revisions.push({
          revision: prevStart === null ? "Baseline" : "Rev " + ++startRevNum,
          changedOn: DATA.asOf,
          field: "Planned Start",
          from: prevStart,
          to: livePlan.latestStart,
          shiftDays: prevStart === null ? null : daysBetweenIso(prevStart, livePlan.latestStart),
        });
      }
      if (livePlan.latestEnd && livePlan.latestEnd !== prevEnd) {
        revisions.push({
          revision: prevEnd === null ? "Baseline" : "Rev " + ++endRevNum,
          changedOn: DATA.asOf,
          field: "Planned Completion",
          from: prevEnd,
          to: livePlan.latestEnd,
          shiftDays: prevEnd === null ? null : daysBetweenIso(prevEnd, livePlan.latestEnd),
        });
      }
    }

    return revisions;
  }

  function stageDelayLog(p, stage) {
    return (p.delayLog || []).filter((e) => e.stage === stage);
  }

  // Auto-detected schedule shifts for one stage — reuses the exact same
  // Go-Live / milestone-date-shift events shown in the project's Schedule
  // timeline "Date change log", filtered to shifts that happened while the
  // project was reported in this stage, and to actual delays only (date
  // moved LATER — "no change" and pulled-in/early shifts aren't delays).
  // These are kept separate from the manually-reported `p.delayLog`
  // entries (which have a reason/team/member) since this data has none of
  // that — it's purely "the date moved, and by how much."
  function stageAutoScheduleShifts(p, stage) {
    return buildScheduleTimeline(historyForProject(p.id), p)
      .filter((e) => e.kind !== "timesaved" && e.stage === stage)
      .map((e) => Object.assign({ deltaDays: daysBetweenIso(e.from, e.to) }, e))
      .filter((e) => e.isDelay);
  }

  // Same as `stageAutoScheduleShifts`, but across every stage — the
  // project-wide version used by the Delay tab's "Delay Analysis (all
  // stages)" breakdown, instead of needing to click into one stage at a
  // time via the Grid.
  function projectAutoScheduleShifts(p) {
    return buildScheduleTimeline(historyForProject(p.id), p)
      .filter((e) => e.kind !== "timesaved")
      .map((e) => Object.assign({ deltaDays: daysBetweenIso(e.from, e.to) }, e))
      .filter((e) => e.isDelay);
  }

  // Pre-loads the Delay tab's "Delay attribution" / "Delay log entries"
  // sections from the Schedule timeline instead of leaving them empty
  // (2026-11-04, "consolidate - just pre-load the logs and they should
  // show according to the timeline"): `p.delayLog` is manually-curated
  // and, across this whole portfolio, basically always empty — but
  // `projectAutoScheduleShifts()` already has the real, already-detected
  // delays (same data the Schedule timeline above shows, already filtered
  // to genuine overruns only). Shaped to match `p.delayLog`'s
  // date/stage/reason/team/member/days fields so `aggregateDelayLog()` and
  // `buildManualDelayLogSearchTable()` can consume it unchanged — `team`/
  // `member` are left unset (shows under "Unlabeled", same fallback
  // `aggregateDelayLog()` already uses for a real entry missing either
  // field) since a date-move event doesn't carry who owns it. Sorted
  // newest-first, same order as the Schedule timeline it comes from — "by
  // Reason" buckets by the event's own `label` when no explicit reason was
  // logged, so e.g. every "Go-Live" slip still groups together.
  function projectAutoDelayLogEntries(p) {
    return projectAutoScheduleShifts(p).map((e, i) => ({
      id: "AUTO-" + (i + 1),
      date: e.date,
      stage: e.stage || null,
      reason: e.reason || e.label,
      team: null,
      member: null,
      days: e.deltaDays,
    }));
  }

  // Weekday slip of each stage's own planned end (latestEnd vs initialEnd).
  // This is the Stage Dates "Delay (Days)" column. It is not the project's
  // finish-date delay — a stage can slip and the go-live still hold
  // (2026-11-04, "delays in stages but still finished on time").
  function stagePlanSlipEntries(p) {
    const plan = p.stagePlan || {};
    return PIPELINE_STAGES.map((stage) => {
      const sp = plan[stage];
      if (!sp || !sp.initialEnd || !sp.latestEnd || sp.latestEnd <= sp.initialEnd) return null;
      const days = businessDaysBetweenIso(sp.initialEnd, sp.latestEnd);
      if (!days || days <= 0) return null;
      return {
        id: stage,
        date: sp.latestEnd,
        stage,
        reason: stage,
        team: null,
        member: null,
        days,
      };
    }).filter(Boolean);
  }

  // Groups delay-log entries by a key (team/member/reason) and sums days —
  // the data behind the stage detail modal's "Delay Analysis" tab. Sorted
  // by days descending so the biggest contributor leads.
  function aggregateDelayLog(entries, keyField) {
    const groups = {};
    entries.forEach((e) => {
      const key = e[keyField] || "Unlabeled";
      const g = groups[key] || (groups[key] = { label: key, days: 0, count: 0 });
      g.days += e.days || 0;
      g.count += 1;
    });
    return Object.values(groups).sort((a, b) => b.days - a.days || a.label.localeCompare(b.label));
  }

  const STATUS_COLOR = { green: "#2f6b4f", amber: "#a6650f", red: "#b5342a", black: "#1c1d24" };

  // Line colors for per-milestone series overlaid on the project chart —
  // deliberately not status colors, so a milestone line can't be misread
  // as the project's own Green/Amber/Red.
  const MILESTONE_SERIES_COLORS = ["#2f62c4", "#8a4fd0", "#0f8a8a", "#c2410c"];

  // `fillId` keeps each chart's gradient id unique in case several of
  // these render on one page (duplicate SVG ids would share one fill).
  // `extraSeries` ([{name, color, points: [{asOf, progress}]}]) overlays
  // additional lines — e.g. one per milestone — plotted on the same weekly
  // x positions as `weeks`; weeks a series has no value for are skipped,
  // so its line joins its known points. `lineColor` overrides the
  // status-based coloring (used for the standalone per-milestone charts).
  function buildTrendGraph(weeks, fillId = "trendFill", extraSeries = [], lineColor = null) {
    const width = 700;
    const height = 210;
    const padL = 38;
    const padR = 16;
    const padT = 30;
    const padB = 30;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const xFor = (i) => (weeks.length === 1 ? padL + plotW / 2 : padL + (i / (weeks.length - 1)) * plotW);
    const yFor = (pct) => padT + plotH - (pct / 100) * plotH;

    const points = weeks.map((w, i) => ({ x: xFor(i), y: yFor(w.progress), w }));
    const lineD = points.map((p, i) => (i === 0 ? `M ${p.x} ${p.y}` : `L ${p.x} ${p.y}`)).join(" ");
    const areaD = `${lineD} L ${points[points.length - 1].x} ${padT + plotH} L ${points[0].x} ${padT + plotH} Z`;

    const gridLines = [0, 25, 50, 75, 100].map((pct) => {
      const y = yFor(pct);
      return `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="var(--line)" stroke-width="1" />` +
        `<text x="${padL - 8}" y="${y}" text-anchor="end" dominant-baseline="middle" class="graph-axis-label">${pct}</text>`;
    }).join("");

    const xLabels = points.map((p, i) =>
      `<text x="${p.x}" y="${height - 8}" text-anchor="middle" class="graph-axis-label">${fmtDateShort(p.w.weekOf || p.w.asOf)}</text>`
    ).join("");

    const latestColor = lineColor || STATUS_COLOR[weeks[weeks.length - 1].status] || "var(--accent)";

    const dots = points.map((p) => {
      // Flip the label below the dot when it's too close to the top edge
      // (and thus the "100" axis label) to avoid the two overlapping.
      const tooHigh = p.y - 12 < padT + 10;
      const labelY = tooHigh ? p.y + 18 : p.y - 12;
      return `<circle cx="${p.x}" cy="${p.y}" r="4.5" fill="${lineColor || STATUS_COLOR[p.w.status] || latestColor}" stroke="#fff" stroke-width="2" />` +
        `<text x="${p.x}" y="${labelY}" text-anchor="middle" class="graph-point-label">${p.w.progress}%</text>`;
    }).join("");

    const indexByAsOf = {};
    weeks.forEach((w, i) => { indexByAsOf[w.asOf] = i; });
    const seriesSvg = extraSeries.map((s) => {
      const pts = s.points
        .filter((pt) => indexByAsOf[pt.asOf] != null)
        .map((pt) => ({ x: xFor(indexByAsOf[pt.asOf]), y: yFor(pt.progress), progress: pt.progress }));
      if (!pts.length) return "";
      const d = pts.map((pt, i) => (i === 0 ? `M ${pt.x} ${pt.y}` : `L ${pt.x} ${pt.y}`)).join(" ");
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-dasharray="6 4" stroke-linejoin="round" stroke-linecap="round" />` +
        pts.map((pt) => {
          const tooHigh = pt.y - 12 < padT + 10;
          const labelY = tooHigh ? pt.y + 18 : pt.y - 12;
          return `<circle cx="${pt.x}" cy="${pt.y}" r="4.5" fill="${s.color}" stroke="#fff" stroke-width="2" />` +
            `<text x="${pt.x}" y="${labelY}" text-anchor="middle" class="graph-point-label" style="fill:${s.color}">${pt.progress}%</text>`;
        }).join("");
    }).join("");

    const svg = `
      <svg viewBox="0 0 ${width} ${height}" class="trend-graph" preserveAspectRatio="none">
        <defs>
          <linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${latestColor}" stop-opacity="0.16" />
            <stop offset="100%" stop-color="${latestColor}" stop-opacity="0" />
          </linearGradient>
        </defs>
        ${gridLines}
        <path d="${areaD}" fill="url(#${fillId})" stroke="none" />
        <path d="${lineD}" fill="none" stroke="${latestColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
        ${dots}
        ${seriesSvg}
        ${xLabels}
      </svg>`;

    const wrap = el("div", { class: "trend-graph-wrap", html: svg });
    if (extraSeries.length) {
      wrap.appendChild(
        el("div", { class: "trend-graph-legend" }, [
          el("span", { class: "trend-graph-legend-item" }, [
            el("span", { class: "trend-graph-legend-swatch", style: `background:${latestColor}` }),
            "Overall project",
          ]),
          ...extraSeries.map((s) =>
            el("span", { class: "trend-graph-legend-item" }, [
              el("span", { class: "trend-graph-legend-swatch", style: `background:${s.color}` }),
              s.name,
            ])
          ),
        ])
      );
    }
    return wrap;
  }

  // Working days (Mon–Fri) from `aIso` to `bIso`, not counting `aIso`
  // itself; negative when `bIso` is earlier.
  function workingDaysBetweenIso(aIso, bIso) {
    const sign = bIso < aIso ? -1 : 1;
    const [from, to] = sign > 0 ? [aIso, bIso] : [bIso, aIso];
    const d = new Date(from + "T00:00:00");
    const end = new Date(to + "T00:00:00");
    let count = 0;
    while (d < end) {
      d.setDate(d.getDate() + 1);
      const day = d.getDay();
      if (day !== 0 && day !== 6) count++;
    }
    return sign * count;
  }

  const BASELINE_STAGE_LABELS = {
    Requirements: "Requirements completion",
    "Tech. Design": "Design (TDD) completion",
    Development: "Development & QA completion",
    Rollout: "Go-Live",
  };

  // `p.scheduleBaseline` (2026-11-03, myBKY 2A): instead of comparing each
  // week's go-live / next milestone with the week before, log every week a
  // stage's latest end date moved, shown against that stage's ORIGINAL
  // planned end (`stagePlan[stage].initialEnd`) in working days. Weeks
  // before the project had a stage plan keep the usual go-live / milestone
  // comparison. `deltaDays` stays the week-on-week move, so the per-stage
  // delay analysis doesn't double-count the cumulative slip.
  function buildScheduleTimeline(weeks, p) {
    // A hand-curated log (2026-11-03, GMS 1.4 — from the PM's stage table)
    // replaces the snapshot-diff reconstruction entirely. Entries are
    // { date, label, from, to, stage?, deltaDays? }; deltaDays, when given,
    // is the PM's own delay count and wins over the calendar-day diff.
    if (p && Array.isArray(p.scheduleLog)) {
      const logged = p.scheduleLog.map((e) => ({ ...e })).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      return markScheduleDelays(logged, p);
    }
    const events = [];
    let prevGoLive = null;
    let prevMilestoneName = null;
    let prevMilestoneDate = null;
    let prevPlan = null;
    const baseline = !!(p && p.scheduleBaseline);

    weeks.forEach((w) => {
      const goLive = w.goLive || null;
      const milestoneName = (w.nextMilestone && w.nextMilestone.name) || null;
      const milestoneDate = (w.nextMilestone && w.nextMilestone.date) || null;
      const plan = w.stagePlan && Object.keys(w.stagePlan).length ? w.stagePlan : null;

      if (baseline && plan && prevPlan) {
        Object.keys(plan).forEach((stage) => {
          const cur = plan[stage];
          const before = prevPlan[stage];
          if (!cur || !before || !cur.latestEnd || !before.latestEnd || cur.latestEnd === before.latestEnd) return;
          const planned = cur.initialEnd || before.latestEnd;
          events.push({
            date: w.asOf,
            label: BASELINE_STAGE_LABELS[stage] || stage + " completion",
            from: planned,
            to: cur.latestEnd,
            stage,
            vsPlanWorkingDays: workingDaysBetweenIso(planned, cur.latestEnd),
            deltaDays: workingDaysBetweenIso(before.latestEnd, cur.latestEnd),
          });
        });
      } else {
        // `stage` records which pipeline stage the project was reported in
        // during the week the shift happened — this is what lets a shift get
        // attributed to a specific stage's Delay Log (see
        // stageAutoScheduleShifts) without having to guess from the
        // free-text milestone label.
        if (prevGoLive && goLive && goLive !== prevGoLive) {
          events.push({ date: w.asOf, label: "Go-Live", from: prevGoLive, to: goLive, stage: w.stage || null });
        }
        if (
          prevMilestoneDate &&
          milestoneDate &&
          (milestoneDate !== prevMilestoneDate || milestoneName !== prevMilestoneName)
        ) {
          // A new milestone that lands on this stage's planned end is not a
          // move. Project Closure on Nov 6 replaced Go-Live on Oct 5, and
          // those 32 days are the planned Hypercare length.
          const stagePlan = p && p.stagePlan && w.stage && p.stagePlan[w.stage];
          const plannedEnd = stagePlan && stagePlan.initialEnd;
          const planHeld = stagePlan && stagePlan.latestEnd && stagePlan.latestEnd === plannedEnd;
          const handoffToPlan = milestoneName !== prevMilestoneName && planHeld && milestoneDate === plannedEnd;
          if (!handoffToPlan) {
            events.push({
              date: w.asOf,
              label: milestoneName || prevMilestoneName || "Milestone",
              from: prevMilestoneDate,
              to: milestoneDate,
              stage: w.stage || null,
            });
          }
        }
      }

      if (goLive) prevGoLive = goLive;
      if (milestoneDate) {
        prevMilestoneDate = milestoneDate;
        prevMilestoneName = milestoneName;
      }
      if (plan) prevPlan = plan;

      // Time pulled back IN this week — tracked the same way as a delay:
      // one event per week it's reported, not a diff.
      if ((w.timeSavedDays || 0) > 0) {
        events.push({
          date: w.asOf,
          label: "Time saved",
          kind: "timesaved",
          days: w.timeSavedDays,
          note: w.timeSavedNote || [],
        });
      }
    });

    return markScheduleDelays(events.reverse(), p); // newest first
  }

  // A later date is a delay only when it lands past that stage's own
  // planned end. Hypercare's Project Closure move to Nov 6 matches the
  // planned Hypercare end, so it is not a delay (2026-11-04).
  function markScheduleDelays(events, p) {
    events.forEach((e) => {
      if (!e || e.kind === "timesaved" || !e.from || !e.to) return;
      const delta = e.deltaDays != null
        ? e.deltaDays
        : e.vsPlanWorkingDays != null
        ? e.vsPlanWorkingDays
        : daysBetweenIso(e.from, e.to);
      const plan = p && p.stagePlan && e.stage && p.stagePlan[e.stage];
      const plannedEnd = plan && plan.initialEnd;
      e.isDelay = delta > 0 && !(plannedEnd && e.to <= plannedEnd);
    });
    return events;
  }

  function renderScheduleTimeline(events) {
    if (!events.length) {
      return el("p", { class: "empty-note" }, [
        "No schedule changes recorded yet — this fills in automatically whenever a go-live or " +
          "milestone date moves (e.g. because of a CR), or time gets saved, with the date it happened.",
      ]);
    }

    const box = el("div", { class: "schedule-timeline" });
    events.forEach((e) => {
      if (e.kind === "timesaved") {
        box.appendChild(
          el("div", { class: "schedule-timeline-row kind-timesaved" }, [
            el("div", { class: "schedule-timeline-date" }, [fmtDate(e.date)]),
            el("div", { class: "schedule-timeline-main" }, [
              el("span", { class: "schedule-timeline-label" }, [e.label]),
              el("span", { class: "schedule-timeline-delta is-early" }, ["-" + e.days + " days"]),
              e.note && e.note.length
                ? el("span", { class: "schedule-timeline-note" }, [e.note.join(" · ")])
                : null,
            ]),
          ])
        );
        return;
      }

      // Baseline events (see buildScheduleTimeline) show the slip against
      // the original plan in working days; everything else, calendar days.
      const vsPlan = e.vsPlanWorkingDays != null;
      const deltaDays = vsPlan
        ? e.vsPlanWorkingDays
        : e.deltaDays != null
        ? e.deltaDays
        : Math.round((new Date(e.to + "T00:00:00") - new Date(e.from + "T00:00:00")) / 86400000);
      const unit = vsPlan ? " working days vs plan" : " days";
      // This is a date-change log, not the stage-delay calculation. A date
      // moving later only means the target changed; it does not establish
      // that the stage finished past plan. Keep that movement neutral here.
      // Actual delays are calculated from plannedEnd -> actualEnd in
      // `stageDateRows()` and shown in red in Stage dates / attribution.
      box.appendChild(
        el("div", { class: "schedule-timeline-row" }, [
          el("div", { class: "schedule-timeline-date" }, [fmtDate(e.date)]),
          el("div", { class: "schedule-timeline-main" }, [
            el("span", { class: "schedule-timeline-label" }, [e.label]),
            e.stage ? el("span", { class: "schedule-timeline-stage" }, [e.stage]) : null,
            el("span", { class: "golive-date-original" }, [fmtDateShort(e.from)]),
            el("span", { class: "golive-arrow" }, ["→"]),
            el("span", { class: "golive-date-current" + (e.stageDelay ? " is-late" : "") }, [fmtDate(e.to)]),
            e.stageDelay
              ? el("span", { class: "schedule-timeline-delta is-late" }, ["+" + e.deltaDays + " days"])
              : deltaDays > 0
              ? el("span", { class: "schedule-timeline-delta is-moved" }, ["+" + deltaDays + unit + " moved"])
              : null,
            e.reason ? el("span", { class: "schedule-timeline-note is-reason" }, ["Reason: " + e.reason]) : null,
          ]),
        ])
      );
    });
    return box;
  }

  // The Date change log used to always render fully expanded — with
  // Collapsed used to be the default (the log made the detail view long).
  // It now starts open (2026-11-04, "show this already visible") — the
  // entry count still sits in the header, and clicking it collapses the
  // rows in place.
  function buildCollapsibleChangelog(events) {
    const wrap = el("div", { class: "schedule-changelog-wrap" });
    const toggle = el(
      "button",
      { class: "schedule-changelog-toggle", type: "button", "aria-expanded": "true" },
      [
        el("span", { class: "schedule-changelog-chevron" }, ["▾"]),
        el("span", { class: "schedule-changelog-title" }, ["Date change log"]),
        el("span", { class: "schedule-changelog-count" }, [
          events.length + (events.length === 1 ? " entry" : " entries"),
        ]),
      ]
    );
    const body = el("div", { class: "schedule-changelog-body" }, [renderScheduleTimeline(events)]);
    toggle.addEventListener("click", () => {
      const nowCollapsed = wrap.classList.toggle("is-collapsed");
      toggle.setAttribute("aria-expanded", nowCollapsed ? "false" : "true");
      toggle.querySelector(".schedule-changelog-chevron").textContent = nowCollapsed ? "▸" : "▾";
    });
    wrap.appendChild(toggle);
    wrap.appendChild(body);
    return wrap;
  }

  function openProjectDetail(projectId, focusSectionId) {
    const project = DATA.projects.find((p) => p.id === projectId);
    if (!project) return;

    const overlay = document.getElementById("projectDetail");
    const content = document.getElementById("detailContent");
    content.innerHTML = "";
    const detailRoot = buildProjectDetail(project);
    content.appendChild(detailRoot);
    overlay.hidden = false;
    document.body.classList.add("no-scroll");

    if (focusSectionId) {
      activateDetailTab(detailRoot, DETAIL_SECTION_TAB_MAP[focusSectionId] || "schedule");
      requestAnimationFrame(() => {
        const target = document.getElementById(focusSectionId);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } else {
      // No specific jump-link target (e.g. a plain click on a project
      // card) — pre-load the Schedule tile open by default instead of
      // leaving all 9 tiles collapsed (2026-11-02, "can you pre-load
      // the schedule icon").
      activateDetailTab(detailRoot, "schedule");
      overlay.scrollTop = 0;
    }
  }

  function closeProjectDetail() {
    document.getElementById("projectDetail").hidden = true;
    document.body.classList.remove("no-scroll");
  }

  // "Weekly status report" widget (Progress/Risks/Issues/Decisions/
  // Dependencies/Upcoming milestones as a standalone box above the tab
  // list) — REMOVED 2026-10-16. A user pointed out it duplicated the tab
  // list right below it ("these are duplicates - all the top should just
  // link to the icons") and asked for the two to merge into one list:
  // each tab row now shows its own one-line teaser (a count/status, not
  // a content preview) in the collapsed header, and the full detail is
  // revealed on click (see `tabTeaser()` and the accordion rows below) —
  // see git history for `weeklyReportRow()`/`weeklyReportTeaser()`/
  // `buildWeeklyStatusReport()` if this needs resurrecting.
  // One-line collapsed-header summary per accordion row (2026-10-16, see
  // the big comment above `DETAIL_TABS` in `buildProjectDetail()` for why
  // this exists — it's what replaced the standalone "Weekly status
  // report" widget's teaser rows). Deliberately a count/status, never a
  // content preview — "share high level delay counts or details and when
  // the user clicks on it - it shows all the delay logs things that are
  // present" — so each row stays a single line no matter how much data a
  // project has; the full detail is only ever one click away.
  function tabTeaser(tabId, p) {
    const plural = (n, word, pluralWord) => n + " " + (n === 1 ? word : pluralWord || word + "s");
    switch (tabId) {
      case "schedule": {
        const eStat = effectiveStatus(p);
        return el("div", { class: "detail-tab-btn-progress" }, [
          el("div", { class: "progress-track" }, [
            el("div", { class: "progress-fill status-" + eStat, style: "width:" + p.progress + "%" }),
          ]),
          el("span", { class: "progress-pct" }, [p.progress + "%"]),
        ]);
      }
      case "delay": {
        const isLateP = (p.delayDays || 0) > 0;
        const count = (p.delayItemLog || []).length + (p.delayLog || []).length;
        const statusText = scheduleStatusText(p);
        return statusText + (count ? " · " + plural(count, "logged delay") : "");
      }
      case "weekoverweek": {
        const n = historyForProject(p.id).length;
        return n ? plural(n, "weekly snapshot") + " logged" : "No history logged yet";
      }
      case "stagegate": {
        const stage = p.stage || "Unstaged";
        const target = currentStageTargetDate(p);
        return stage + (target ? " — target " + fmtDateShort(target) : "");
      }
      case "changedecisions": {
        const cr = (p.changeRequests || []).length;
        const dec = (p.decisions || []).length;
        return plural(cr, "change request") + " · " + plural(dec, "decision");
      }
      case "features": {
        const feats = p.features || [];
        if (!feats.length) return "No features or bugs tracked yet";
        const bugs = feats.filter(isBugFeatureItem);
        const feats2 = feats.filter((f) => !isBugFeatureItem(f));
        const parts = [];
        if (feats2.length) parts.push(feats2.filter((f) => f.status === "Done").length + " of " + plural(feats2.length, "feature") + " done");
        if (bugs.length) parts.push(bugs.filter((f) => f.status === "Done").length + " of " + plural(bugs.length, "bug") + " fixed");
        return parts.join(" · ") || "No features or bugs tracked yet";
      }
      case "depsrisks": {
        const summarize = (items, one, many) => {
          const n = items.length;
          const open = items.filter((x) => !x.resolved).length;
          if (!n) return "0 " + many;
          if (open === n) return plural(n, one, many);
          if (!open) return plural(n, one, many) + " resolved";
          return open + " open · " + (n - open) + " resolved " + many;
        };
        const risks = getRiskObjects(p).filter((r) => !isPlaceholderRiskText(r.text));
        const deps = getDependencyObjects(p).filter((d) => !isPlaceholderDependencyText(d.text));
        const issues = (p.escalations || []).length;
        return (
          summarize(risks, "risk", "risks") +
          " · " +
          summarize(deps, "dependency", "dependencies") +
          " · " +
          plural(issues, "issue")
        );
      }
      case "followups": {
        const n = openNotesFor(p.id).length;
        return n ? plural(n, "open follow-up") : "No open follow-ups";
      }
      case "feedback": {
        const n = NOTES.filter((note) => note.projectId === p.id).length;
        return n ? plural(n, "feedback entry", "feedback entries") : "No feedback logged yet";
      }
      default:
        return "";
    }
  }

  function buildProjectDetail(p) {
    const isLate = p.delayDays > 0;
    const eStatus = effectiveStatus(p);
    const openFollowUps = openNotesFor(p.id);
    const allNotes = NOTES.filter((n) => n.projectId === p.id);
    const weeks = weeklyHistoryForProject(p.id);

    const root = el("div", { class: "detail-root" });

    // Header
    root.appendChild(
      el("div", { class: "detail-head" }, [
        el("div", null, [
          el("span", { class: "pill pill-" + eStatus }, [STATUS_LABEL[eStatus]]),
          el("h1", null, [p.name]),
          el("div", { class: "card-owner" }, [p.owner ? "PM: " + p.owner : "PM: unassigned"]),
        ]),
      ])
    );

    // Detail-view sections — everything below the header/progress/facts
    // used to be one long flat stack of `<h3>` sections (Stage-gate
    // timeline, Delay recovery, Follow-ups, Schedule, Dependencies/Risks/
    // Escalations, Week-over-week, Feedback history), then a horizontal
    // tab strip, then (same day) a vertical list of tabs — see git
    // history. Rebuilt again, 2026-10-16, as a single-open ACCORDION:
    // a user flagged that this tab list AND the separate "Weekly status
    // report" widget above it ("Progress"/"Risks"/"Issues"/"Decisions"/
    // "Dependencies"/"Upcoming milestones") were duplicating each other
    // ("these are duplicates - all the top should just link to the
    // icons... merge the top with the icons and just have icons with 1
    // row info and when I click on them things expand below to show all
    // the details"). So the widget is gone entirely (see
    // `buildProgressFactsList()`'s call site inside the Schedule panel
    // below for where its "Progress" row's facts list ended up), and
    // each of these 9 rows now shows a one-line, data-driven `tabTeaser()`
    // summary (a count or status, not a content preview) in its collapsed
    // header; clicking a row expands it in place to show its full panel
    // content, closing any other open row (confirmed: single-open,
    // all-collapsed by default, jump-links auto-expand + scroll).
    // Order here is purely display order — doesn't affect anything
    // functional, so it's just this one array to reorder.
    const DETAIL_TABS = [
      { id: "schedule", label: "Current state", icon: "gauge" },
      { id: "delay", label: "Timeline", icon: "clock" },
      { id: "weekoverweek", label: "Week over week", icon: "trend" },
      { id: "changedecisions", label: "Change requests", icon: "swap" },
      { id: "depsrisks", label: "Dependencies & risks", icon: "alert" },
      { id: "features", label: "Features & bugs", icon: "sparkle" },
      { id: "followups", label: "Follow-ups", icon: "check" },
      { id: "feedback", label: "Feedback", icon: "chat" },
    ];

    // Panels are created independent of display order, then placed inside
    // their accordion row below in whatever order `DETAIL_TABS` says. None
    // start active/open — the whole list starts fully collapsed.
    const depsRisksPanel = el("div", { class: "detail-tab-panel", "data-tab": "depsrisks" });
    const weekOverWeekPanel = el("div", { class: "detail-tab-panel", "data-tab": "weekoverweek" });
    const followupsPanel = el("div", { class: "detail-tab-panel", "data-tab": "followups" });
    const schedulePanel = el("div", { class: "detail-tab-panel", "data-tab": "schedule" });
    const feedbackPanel = el("div", { class: "detail-tab-panel", "data-tab": "feedback" });
    const changeDecisionsPanel = el("div", { class: "detail-tab-panel", "data-tab": "changedecisions" });
    const delayPanel = el("div", { class: "detail-tab-panel", "data-tab": "delay" });
    const featuresPanel = el("div", { class: "detail-tab-panel", "data-tab": "features" });
    const PANELS_BY_TAB = {
      depsrisks: depsRisksPanel,
      weekoverweek: weekOverWeekPanel,
      followups: followupsPanel,
      schedule: schedulePanel,
      feedback: feedbackPanel,
      changedecisions: changeDecisionsPanel,
      delay: delayPanel,
      features: featuresPanel,
    };

    // Horizontal icon-tile strip (2026-10-16) — "make these horizontal and
    // I want icons like these (second image) horizontally", pointing at
    // the Five Logs banner's circular-badge-icon-above-label look. Tiles
    // and panels are now two separate flat lists (tiles row, panels
    // stack below it) instead of nested accordion rows, since a panel no
    // longer has room to expand directly under its own tile once tiles
    // sit side by side — `activateDetailTab()` below toggles both lists
    // in lockstep by matching `data-tab`.
    const tabStrip = el(
      "div",
      { class: "detail-tabs-h", role: "list" },
      DETAIL_TABS.map((t) =>
        el(
          "button",
          {
            class: "detail-tab-tile",
            "data-tab": t.id,
            type: "button",
            "aria-expanded": "false",
            "aria-label": t.label,
          },
          [
            el("span", { class: "detail-tab-tile-icon", html: DETAIL_TAB_ICONS[t.icon] || "" }),
            el("span", { class: "detail-tab-tile-label" }, [t.label]),
            el("span", { class: "detail-tab-tile-teaser" }, [tabTeaser(t.id, p)]),
          ]
        )
      )
    );
    const tabPanels = el(
      "div",
      { class: "detail-tab-panels" },
      DETAIL_TABS.map((t) => PANELS_BY_TAB[t.id])
    );
    root.appendChild(tabStrip);
    root.appendChild(tabPanels);

    tabStrip.querySelectorAll(".detail-tab-tile").forEach((tile) => {
      tile.addEventListener("click", () => {
        const tabId = tile.getAttribute("data-tab");
        const willOpen = !tile.classList.contains("is-open");
        activateDetailTab(root, willOpen ? tabId : null);
      });
    });

    // Follow-ups tab always exists (even with none open) so a stable set
    // of tabs is available no matter what — clicking the "0 follow-ups"
    // badge would otherwise have nowhere sensible to land.
    followupsPanel.appendChild(el("h3", { class: "weekly-subhead", id: "detail-followups-section" }, ["Open follow-ups"]));
    if (openFollowUps.length) {
      followupsPanel.appendChild(
        el("div", { class: "detail-block followups" }, [
          el(
            "ul",
            null,
            openFollowUps.map((n) =>
              el("li", { class: "followup-item" }, [
                el("span", null, [n.text + (n.raisedBy ? ` — ${n.raisedBy}` : "")]),
                resolveLink(n, p.name),
              ])
            )
          ),
        ])
      );
    } else {
      followupsPanel.appendChild(el("p", { class: "empty-note" }, ["No open follow-ups."]));
    }

    // Change & Decisions tab — the two structured logs from the "five
    // logs every project maintains" framework (slide 15) that didn't
    // already exist anywhere in this dashboard: a Change Request Log
    // (slide 8's CR process) and a Decision Log. Both always render
    // (even empty) so the tab itself is a stable landing spot.
    // (The "Five logs" summary banner that used to sit above these two
    // logs was removed 2026-10-16 — see the note by `buildFiveLogsBanner`'s
    // old definition for why.)
    changeDecisionsPanel.appendChild(el("h3", { class: "weekly-subhead", id: "cr-log-section" }, ["Change Request Log"]));
    changeDecisionsPanel.appendChild(
      el("p", { class: "section-subhead" }, [
        "Every change request — large or small — documented for tracking and transparency, per the CR process.",
      ])
    );
    changeDecisionsPanel.appendChild(buildChangeRequestLog(p));

    changeDecisionsPanel.appendChild(el("h3", { class: "weekly-subhead", id: "decision-log-section" }, ["Decision Log"]));
    changeDecisionsPanel.appendChild(
      el("p", { class: "section-subhead" }, [
        "Key calls that were made — distinct from Dependencies & Risks, which tracks open items still being resolved.",
      ])
    );
    changeDecisionsPanel.appendChild(buildDecisionLog(p));

    // Features tab — brought back (2026-10-15), per explicit request
    // ("Also bring the features back - lets keep those") shortly after it
    // was removed the same day. The most granular view in the deck:
    // every feature/capability as its own row with its own status,
    // rather than one project-level status (slide 20's live MyBKY
    // example). `buildFeatureKpis()`/`buildFeatureTracker()` were kept
    // in place, unused, when the tab was removed — this just re-wires
    // the tab button/panel/jump-link entry; no changes to those two
    // functions or to `data.json`'s `features` field were needed.
    // (`buildFeatureTracker()` calls `buildFeatureKpis()` internally.)
    featuresPanel.appendChild(el("h3", { class: "weekly-subhead", id: "feature-tracker-section" }, ["Feature / bug tracker"]));
    featuresPanel.appendChild(
      el("p", { class: "section-subhead" }, [
        "Feature-level breakdown by sprint and bug tracker, in separate tabs — each with its own counts, planned vs. actual dates and delay reasons.",
      ])
    );
    featuresPanel.appendChild(buildFeatureTracker(p));

    // Current Stage / Next Milestone / Go-Live / Status facts — shown as
    // the Schedule accordion row's expanded content, right under its
    // one-line Progress-bar teaser (2026-10-16, see `tabTeaser()` and the
    // accordion row-building code below). Previously lived in a
    // standalone "Weekly status report" widget above the whole tab
    // list, which a user flagged as duplicating this very tab's content
    // once the tab list itself started showing per-row detail — merged
    // in here instead of existing in two places.
    schedulePanel.appendChild(buildProgressFactsList(p));

    // Upcoming milestones — the `milestones` field revived (2026-10-15)
    // specifically to back this tab's milestones list. Full list (not
    // just upcoming) so this doubles as a complete milestone log, not
    // just a teaser.
    schedulePanel.appendChild(el("h3", { class: "weekly-subhead", id: "milestones-section" }, ["Next milestones"]));
    // Next milestones come from the stage-date breakdown (2026-11-04):
    // every stage from the current one forward, on its latest planned end.
    // That date is labeled "Target date". A next-milestone name that lands
    // on the same day replaces the stage name (Project Closure on Nov 6
    // is Hypercare's target). Logged milestones still ahead are included
    // when they aren't already one of those rows.
    const todayStr = todayISO();
    const stageIndex = PIPELINE_STAGES.indexOf(p.stage || "");
    const plan = p.stagePlan || {};
    const allMilestones = [];
    PIPELINE_STAGES.forEach((stage, i) => {
      const sp = plan[stage];
      const target = sp && (sp.latestEnd || sp.initialEnd);
      if (!target) return;
      if (target < todayStr && !(stageIndex !== -1 && i >= stageIndex)) return;
      allMilestones.push({ name: stage, date: target, target: true });
    });
    const nm = p.nextMilestone;
    if (nm && nm.name) {
      const sameDay = nm.date && allMilestones.find((m) => m.date === nm.date);
      if (sameDay) sameDay.name = nm.name;
      else if (!allMilestones.some((m) => m.name === nm.name) && (!nm.date || nm.date >= todayStr)) {
        allMilestones.push({ name: nm.name, date: nm.date || null, target: !!nm.date });
      }
    }
    (p.milestones || []).forEach((m) => {
      if (!m.name || allMilestones.some((row) => row.name === m.name)) return;
      if (m.date && m.date < todayStr) return;
      allMilestones.push({ name: m.name, date: m.date || null, status: m.status, target: !!m.date });
    });
    allMilestones.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    if (!allMilestones.length) {
      schedulePanel.appendChild(el("p", { class: "empty-note" }, ["No upcoming milestones from the stage dates yet."]));
    } else {
      schedulePanel.appendChild(
        el(
          "ul",
          { class: "milestones-list" },
          allMilestones.map((m) =>
            el("li", { class: "milestones-row" + ((m.date && m.date < todayStr) ? " is-past" : "") }, [
              m.status
                ? el("span", { class: "pill pill-" + m.status }, [STATUS_LABEL[m.status] || m.status])
                : null,
              el("span", { class: "milestones-name" }, [m.name]),
              m.date && m.target
                ? el("span", { class: "milestones-target" }, [
                    el("span", { class: "milestones-target-label" }, ["Target date"]),
                    el("span", { class: "milestones-date" }, [fmtDateShort(m.date)]),
                  ])
                : el("span", { class: "milestones-date" }, [m.date ? fmtDateShort(m.date) : "—"]),
            ])
          )
        )
      );
    }

    // Same Stage dates table as the Stage-gate tab (2026-11-04, "add this
    // to the current state below Next Milestone"), with the project's
    // current stage row highlighted.
    schedulePanel.appendChild(el("h3", { class: "weekly-subhead" }, ["Stage dates"]));
    schedulePanel.appendChild(buildStageDatesTable(p));
    const currentStateRecovery = buildRecoveryNote(p);
    if (currentStateRecovery) schedulePanel.appendChild(currentStateRecovery);

    // Progress trend chart. Per-milestone lines (2026-11-03) — a project
    // running several milestones in parallel (e.g. myMandir 1B's Oct + Nov
    // releases) can't express both in one project-level %, so each
    // milestone with a `progress` value in any weekly snapshot is overlaid
    // as its own line, built from history.json like the project line.
    schedulePanel.appendChild(el("h3", { class: "weekly-subhead" }, ["Progress over time"]));
    // Weekly cadence only (2026-11-04) — one point per Tuesday-to-Tuesday
    // reporting week, not one per snapshot. See weeklyHistoryForProject().
    const chartWeeks = weeklyHistoryForProject(p.id);
    if (!chartWeeks.length) {
      schedulePanel.appendChild(el("p", { class: "empty-note" }, ["No history yet — it'll build up week over week as updates get ingested."]));
    } else {
      const milestonePoints = {};
      chartWeeks.forEach((w) => {
        (w.milestones || []).forEach((m) => {
          if (m.progress == null || m.progress === "") return;
          (milestonePoints[m.name] || (milestonePoints[m.name] = [])).push({ asOf: w.asOf, weekOf: w.weekOf, progress: Number(m.progress) });
        });
      });
      const milestoneSeries = Object.keys(milestonePoints).map((name, i) => ({
        name,
        color: MILESTONE_SERIES_COLORS[i % MILESTONE_SERIES_COLORS.length],
        points: milestonePoints[name],
      }));
      // A project can set `milestoneOverlay: false` to keep the project chart
      // to the overall line only and show its milestones just in their own
      // charts below (e.g. myBKY 2A's parallel Requirements / Design / Dev stages).
      const overlaySeries = p.milestoneOverlay === false ? [] : milestoneSeries;
      schedulePanel.appendChild(buildTrendGraph(chartWeeks, "trendFill", overlaySeries));

      // Plus one standalone chart per milestone, in that milestone's line
      // color, so each one's trend can be read on its own.
      milestoneSeries.forEach((s, i) => {
        schedulePanel.appendChild(el("h3", { class: "weekly-subhead" }, [s.name + " — progress over time"]));
        schedulePanel.appendChild(buildTrendGraph(s.points, "trendFillMilestone" + i, [], s.color));
      });
    }

    // Delay tab (2026-10-15) — everything delay-related lives here now,
    // consolidated out of Schedule (the date-move log + narrative delay
    // log both moved here) and out of the Grid-click-only stage detail
    // modal (Delay Analysis + Delay Log, previously only viewable one
    // stage at a time): a user asked for "delay in its own tab with logs
    // — things that show up when I click on the grid," aggregated across
    // every stage instead of requiring a click per stage.

    // Schedule timeline — a log of every date move (e.g. a CR pushing the
    // timeline). Used to also render a per-project calendar/Gantt above
    // this (`buildSingleProjectGantt()`) — removed 2026-09-30 per explicit
    // request, for every project, not just one. Moved here from the
    // Schedule tab 2026-10-15 (see note above) — `detailScheduleSection`'s
    // id is unchanged, so the Grid tab's "click project name" jump-link
    // still lands on it correctly (now via `DETAIL_SECTION_TAB_MAP` →
    // "delay" instead of falling through to the wrong default tab, which
    // this id was never actually mapped to before this change either).
    // Planned vs actual, from this project's stage plan, sits above the
    // date-change log (2026-11-04). The chart is the Delay (Days) column.
    // The headline stays the project finish.
    // Same step-ladder as the Stage-gate tab (2026-11-04), above the
    // delay chart. No shared id — the Stage-gate copy keeps the jump target.
    delayPanel.appendChild(el("h3", { class: "weekly-subhead" }, ["Stage-gate timeline"]));
    delayPanel.appendChild(
      el("div", { class: "stagegantt-legend" }, [
        el("span", { class: "stagegantt-legend-item" }, [el("span", { class: "stagegantt-legend-swatch is-done" }), "Done"]),
        el("span", { class: "stagegantt-legend-item" }, [el("span", { class: "stagegantt-legend-swatch is-warn" }), "Current — in progress"]),
        el("span", { class: "stagegantt-legend-item" }, [el("span", { class: "stagegantt-legend-swatch is-breach" }), "Current — past planned end date"]),
        el("span", { class: "stagegantt-legend-item" }, [el("span", { class: "stagegantt-legend-swatch is-future" }), "Not started (planned)"]),
        el("span", { class: "stagegantt-legend-item" }, [el("span", { class: "stagegantt-legend-swatch is-future is-plan-overdue" }), "Plan passed, not yet reported started"]),
      ])
    );
    delayPanel.appendChild(el("div", { id: "stage-gate-timeline-section" }, [buildStageGateTimeline(p)]));

    const dateRows = stageDateRows(p);
    const slips = dateRows.filter((row) => row.days > 0).map((row) => ({ label: row.label, days: row.days }));
    const onTime = (p.delayDays || 0) === 0;
    delayPanel.appendChild(el("h3", { class: "weekly-subhead", id: "delay-attribution-section" }, ["Delay attribution (all stages)"]));
    delayPanel.appendChild(
      el("p", { class: "section-subhead" }, [
        onTime
          ? "Weekday slip of each stage’s actual end past its planned end. Those slips were recovered — the project finish is still on time."
          : "Weekday slip of each stage’s actual end past its planned end. The project finish slip is the figure above the chart.",
      ])
    );
    delayPanel.appendChild(
      buildStageAnalysisPanel(slips, "No stage end dates moved.", {
        kicker: "Project",
        num: onTime ? "On time" : String(p.delayDays),
        label: onTime ? "finish date held" : "days late",
        numClass: onTime ? "is-ontime" : "is-late",
        breakdowns: [{ title: "By stage", groups: slips, centerLabel: "stage days" }],
      })
    );

    // The per-stage slip rows that used to sit here moved into the Stage
    // dates list (Current state tab), which now uses this same row UI
    // for every stage. The id stays as the Grid tab's jump target.
    const scheduleSection = el("div", { id: "detailScheduleSection" });
    if (p.hotfixPlan && (p.hotfixPlan.rows || []).length) scheduleSection.appendChild(buildHotfixPlan(p.hotfixPlan));
    delayPanel.appendChild(scheduleSection);

    // Delay Log — narrative companion to the auto-detected shift log
    // above: root cause, ownership and status, manually maintained
    // rather than inferred from date diffs (slide 15 "five logs" + the
    // sample Delay Log table). Consolidated away when there's nothing
    // manually reported (2026-11-04, "consolidate - just pre-load the
    // logs") — this 11-column table's Responsible/Status/Action fields
    // can't be honestly auto-filled from a date-move event, unlike the
    // attribution/entries sections below, so rather than show it
    // perpetually empty for every project except GMS, it's only rendered
    // once there's something real in it.
    if ((p.delayItemLog || []).length) {
      delayPanel.appendChild(el("h3", { class: "weekly-subhead", id: "delay-log-section" }, ["Reported delay log (root cause & ownership)"]));
      delayPanel.appendChild(
        el("p", { class: "section-subhead" }, [
          "Root cause, ownership and status for each delay — distinct from the auto-detected log above, and from the per-stage incident log below.",
        ])
      );
      delayPanel.appendChild(buildDelayLogTable(p));
    }

    if (p.delayLog && p.delayLog.length) {
      delayPanel.appendChild(el("h3", { class: "weekly-subhead", id: "delay-entries-section" }, ["Delay log entries (all stages)"]));
      delayPanel.appendChild(buildManualDelayLogSearchTable(p.delayLog));
    }

    if (isLate) {
      delayPanel.appendChild(el("h3", { class: "weekly-subhead" }, ["Delay recovery"]));
      delayPanel.appendChild(
        el("div", { class: "detail-block delay-recovery" }, [
          el("h4", null, ["Mitigation steps taken"]),
          p.delayMitigation && p.delayMitigation.length
            ? el("ul", null, listOrDash(p.delayMitigation))
            : el("p", { class: "empty-note is-missing" }, ["Not yet documented"]),
          el("h4", null, ["Trade-off conversations"]),
          el("p", { class: p.delayTradeoffs ? "" : "empty-note" }, [
            p.delayTradeoffs || "None recorded — assumed no scope/resource trade-offs made yet.",
          ]),
        ])
      );
    }

    if ((p.timeSavedDays || 0) > 0) {
      delayPanel.appendChild(el("h3", { class: "weekly-subhead" }, ["Time saved"]));
      delayPanel.appendChild(
        el("div", { class: "detail-block time-saved" }, [
          el("h4", null, ["+" + p.timeSavedDays + " day" + (p.timeSavedDays === 1 ? "" : "s") + " ahead of plan"]),
          p.timeSavedNote && p.timeSavedNote.length
            ? el("ul", null, listOrDash(p.timeSavedNote))
            : el("p", { class: "empty-note is-missing" }, ["Not yet documented"]),
        ])
      );
    }

    if ((p.fastFollowItems || []).length || p.scopeReduced) {
      delayPanel.appendChild(el("h3", { class: "weekly-subhead" }, ["Fast-follow items (planned or remaining)"]));
      delayPanel.appendChild(
        el("div", { class: "detail-block fast-follow" }, [
          el("p", { class: "empty-note" }, [
            p.scopeReduced
              ? "Scope is being cut/deferred to hold the current date. Live / in production, but not fully closed out until these ship:"
              : "Live / in production, but not fully closed out until these ship:",
          ]),
          el("ul", null, listOrDash(p.fastFollowItems || [])),
        ])
      );
    }

    // Renders the Dependencies / Weekly Status / Risks blocks for a given
    // week's data (either the live project `p` or a historical snapshot),
    // into whichever container is passed in. Used twice, in two different
    // tabs, for two different purposes:
    //  - The "Dependencies & Risks" tab calls this once, always with the
    //    live project `p` (never changes), in interactive mode — real
    //    jump-link ids (`detail-deps-section` etc.) and actionable list
    //    items (edit/escalate/resolve) and "+ Add" links. This is the only
    //    caller that renders Dependencies/Risks at all (see
    //    `opts.depsAndRisks` below).
    //  - The "Week-over-week" tab calls this every time a different week
    //    gets clicked, in read-only mode (`opts.readOnly`) — no ids (there
    //    can only be one `detail-deps-section` in the DOM, and that's the
    //    live one above), always the plain non-interactive paired-list
    //    rendering regardless of which week is selected (even the latest),
    //    and no "+ Add" links, since this tab is explicitly a historical
    //    viewer, not a place to make live edits. It also passes
    //    `opts.depsAndRisks = false` (2026-10-05) — Dependencies and
    //    Risks/blockers are always the LIVE/current ones (the "Dependencies
    //    & Risks" tab right next to this one), not historical, so showing
    //    them again per-week here was just a duplicate of that tab, not a
    //    real "as it stood that week" view. Only Weekly Status (which
    //    genuinely did change week to week) stays in this tab — the live
    //    "Dependencies & Risks" tab passes `opts.weeklyStatus = false`
    //    (2026-10-06) so that block only ever shows up here, not
    //    duplicated into the tab that's supposed to be just
    //    dependencies/risks.
    function renderSnapshotSections(container, snap, label, isLatest, opts) {
      opts = opts || {};
      const readOnly = !!opts.readOnly;
      const showDepsAndRisks = opts.depsAndRisks !== false;
      const showWeeklyStatus = opts.weeklyStatus !== false;
      const interactive = isLatest && !readOnly;
      container.innerHTML = "";

      container.appendChild(
        el("div", { class: "snapshot-sections-label" }, [
          isLatest ? "Showing current data" : "Showing snapshot as of " + fmtDate(label),
        ])
      );

      if (showDepsAndRisks && snap.escalations && snap.escalations.length) {
        container.appendChild(
          el("h3", readOnly ? { class: "weekly-subhead" } : { class: "weekly-subhead", id: "detail-escalations-section" }, ["🚨 Escalated to leadership"])
        );
        container.appendChild(
          el("div", { class: "detail-block escalations" }, [
            el("ul", null, snap.escalations.map((text) => el("li", null, [text]))),
          ])
        );
      }

      if (showDepsAndRisks) {
        container.appendChild(
          el(
            "h3",
            readOnly ? { class: "weekly-subhead detail-section-head" } : { class: "weekly-subhead detail-section-head", id: "detail-deps-section" },
            [
              el("span", null, ["Dependencies"]),
            ]
          )
        );
        const snapDeps = getDependencyObjects(snap)
          .filter((d) => !isPlaceholderDependencyText(d.text))
          .sort((a, b) => Number(a.resolved) - Number(b.resolved));
      container.appendChild(
        el("div", { class: "detail-block deps" }, [
          el(
            "ul",
            { class: "paired-list" },
              interactive
                ? dependencyListItems(snapDeps, p)
                : pairedList(
                    snapDeps.map((d) => d.text),
                    snapDeps.map((d) => d.mitigation),
                    "Mitigation / impact",
                    snapDeps.map((d) => d.team)
                  )
          ),
        ])
      );
      if (interactive) {
        container.appendChild(
          buildCallScratch(
            p,
            "dependency",
            "Notes from the call",
            "Type a dependency that came up. Clean it up into the list above later."
          )
        );
      }
      }

      if (showWeeklyStatus) {
        container.appendChild(el("h3", { class: "weekly-subhead" }, ["Weekly Status"]));
      if (!snap.sprintStatus) {
        container.appendChild(
          el("p", { class: "empty-note" }, ["Sprint work detail wasn't captured for this week's snapshot yet."])
        );
      } else {
        container.appendChild(
          el("div", { class: "sprint-grid" }, [
            el("div", { class: "detail-block" }, [
              el("h4", null, ["Completed"]),
              el("ul", null, listOrDash(snap.sprintStatus.completed || [])),
            ]),
            el("div", { class: "detail-block" }, [
              el("h4", null, ["In progress"]),
              el("ul", null, listOrDash(snap.sprintStatus.inProgress || [])),
            ]),
            el("div", { class: "detail-block" }, [
              el("h4", null, ["Next plan"]),
              el("ul", null, listOrDash(snap.sprintStatus.nextPlan || [])),
            ]),
          ])
        );
        }
      }

      if (showDepsAndRisks) {
        const snapRisks = getRiskObjects(snap)
          .filter((r) => !isPlaceholderRiskText(r.text))
          .sort((a, b) => Number(a.resolved) - Number(b.resolved));
        container.appendChild(
          el(
            "h3",
            readOnly ? { class: "weekly-subhead detail-section-head" } : { class: "weekly-subhead detail-section-head", id: "detail-risks-section" },
            [el("span", null, ["Risks / blockers"])]
          )
        );
      container.appendChild(
        el("div", { class: "detail-block risks" }, [
            snapRisks.length
              ? el(
                  "ul",
                  { class: "paired-list" },
                  interactive
                    ? riskListItems(snapRisks, p)
                    : pairedList(
                        snapRisks.map((r) => r.text),
                        snapRisks.map((r) => r.mitigation),
                        "Mitigation plan"
                      )
                )
            : el("ul", null, [el("li", null, ["None reported"])]),
        ])
      );
      if (interactive) {
        container.appendChild(
          buildCallScratch(
            p,
            "risk",
            "Notes from the call",
            "Type a risk that came up. Clean it up into the list above later."
          )
        );
      }
      }
    }

    // "Dependencies & Risks" tab — always the live project's current data,
    // interactive (real jump-link ids + add/edit/escalate/resolve actions).
    // No time-travel here anymore; that moved to its own "Week-over-week"
    // tab below, which gets its own separate (read-only) copy of this same
    // rendering so there's only ever one `id="detail-deps-section"` etc. in
    // the DOM for jump-links to find.
    const liveSnapshotSections = el("div", { class: "snapshot-sections" });
    renderSnapshotSections(liveSnapshotSections, p, null, true, { weeklyStatus: false });
    depsRisksPanel.appendChild(liveSnapshotSections);

    if (p.postProdBugs) depsRisksPanel.appendChild(buildPostProdBugs(p.postProdBugs, p.postReleaseIssues));
    else if ((p.postReleaseIssues || []).length) depsRisksPanel.appendChild(buildPostReleaseIssues(p.postReleaseIssues));

    // RAID Log — Risks, Assumptions, Issues, Dependencies consolidated
    // into one log (slide 18), appended below the existing
    // Dependencies/Risks/Escalations sections above rather than
    // replacing them (those stay as the structured, per-category views;
    // this is the single-table rollup across all four categories, plus
    // Assumptions which isn't tracked anywhere else).
    depsRisksPanel.appendChild(el("h3", { class: "weekly-subhead", id: "raid-log-section" }, ["RAID Log"]));
    depsRisksPanel.appendChild(
      el("p", { class: "section-subhead" }, [
        "Risks, Assumptions, Issues and Dependencies in one consolidated log — distinct from the structured Dependencies/Risks/Escalations sections above.",
      ])
    );
    depsRisksPanel.appendChild(buildRaidLogTable(p));

    // One-line TL;DR built from that week's "Weekly Status" notes
    // (completed/inProgress/nextPlan — the same `sprintStatus` the block
    // above the changelog renders in full), used as a fallback
    // for changelog rows that have no numeric/field delta to show (see
    // the call site below). Picks the first item of whichever lists are
    // non-empty, in Completed → In progress → Next priority order, so
    // the line stays short — the full lists are in the Weekly Status
    // cards above the changelog.
    function weeklyChangelogTldr(snap) {
      const s = snap && snap.sprintStatus;
      if (!s) return null;
      const pick = (label, list) => (list && list.length ? `${label}: ${list[0]}` : null);
      const parts = [pick("Completed", s.completed), pick("In progress", s.inProgress), pick("Next", s.nextPlan)].filter(Boolean);
      return parts.length ? parts.join("  ·  ") : null;
    }

    // "Week-over-week" tab — click a week to load its Weekly Status as it
    // stood that week. The snapshot preview is always read-only (even when
    // the latest week is selected) since this tab is a historical viewer,
    // not a place to make live edits — that's what the "Dependencies &
    // Risks" tab is for. Weekly Status sits ABOVE the changelog
    // (2026-11-04, "show this above" the week-over-week list) so the
    // current sprint cards are the first thing you see; clicking a week
    // below still rewinds those same cards.
    if (!weeks.length) {
      weekOverWeekPanel.appendChild(el("h3", { class: "weekly-subhead" }, ["Week-over-week changes"]));
      weekOverWeekPanel.appendChild(
        el("p", { class: "empty-note" }, ["No history yet — it'll build up week over week as updates get ingested."])
      );
    } else {
      const historySnapshotSections = el("div", { class: "snapshot-sections" });
      weekOverWeekPanel.appendChild(historySnapshotSections);
      weekOverWeekPanel.appendChild(el("h3", { class: "weekly-subhead" }, ["Week-over-week changes"]));
      weekOverWeekPanel.appendChild(el("p", { class: "section-subhead", style: "margin:-6px 0 12px;" }, ["Click a week to see what changed and that week's sprint status. Dependencies and risks are always current — see the \"Dependencies & Risks\" tab for those."]));
      const changeLog = el("div", { class: "changelog" });
      for (let i = weeks.length - 1; i >= 0; i--) {
        const cur = weeks[i];
        const prev = weeks[i - 1];
        const isLatest = i === weeks.length - 1;
        const changes = [];
        const statusChanged = !!(prev && prev.status !== cur.status);
        if (prev) {
          if (prev.progress !== cur.progress) changes.push(`Progress ${prev.progress}% → ${cur.progress}%`);
          if (prev.delayDays !== cur.delayDays) changes.push(`Delay ${prev.delayDays}d → ${cur.delayDays}d`);
          if ((prev.phase || "") !== (cur.phase || "")) changes.push(`Phase → ${cur.phase || "—"}`);
          if ((prev.stage || "") !== (cur.stage || "")) changes.push(`Stage → ${cur.stage || "—"}`);
        } else {
          changes.push("First recorded snapshot");
        }
        const bodyChildren = [];
        if (statusChanged) {
          bodyChildren.push(
            el("div", { class: "changelog-status-change" }, [
              el("span", { class: "pill pill-" + prev.status }, [STATUS_LABEL[prev.status]]),
              el("span", { class: "status-history-arrow" }, ["→"]),
              el("span", { class: "pill pill-" + cur.status }, [STATUS_LABEL[cur.status]]),
            ])
          );
        }
        if (changes.length) bodyChildren.push(el("div", null, [changes.join(" · ")]));

        // TL;DR fallback (2026-11-03, "this empty space should have high
        // level info from the notes below - like a tl;dr") — plenty of
        // weeks have no progress/delay/phase/stage/status delta (nothing
        // for the lines above to show) even though that week's "Weekly
        // Status" notes (completed/in progress/next plan, the cards above
        // this list) are very much not empty. Only fills in when the row would otherwise be
        // genuinely blank — a week that already has a real change line
        // isn't missing anything, so it's left as-is rather than
        // cluttering it with a second, overlapping summary.
        if (!bodyChildren.length) {
          const tldr = weeklyChangelogTldr(cur);
          if (tldr) bodyChildren.push(el("div", { class: "changelog-tldr" }, [tldr]));
        }

        const rowEl = el(
          "div",
          {
            class: "changelog-row" + (statusChanged ? " has-status-change" : "") + (isLatest ? " is-selected" : ""),
            "data-week-index": String(i),
            tabindex: "0",
            role: "button",
          },
          [
            el("div", { class: "changelog-date" }, ["Week of " + fmtDate(cur.weekOf || cur.asOf)]),
            el("div", { class: "changelog-body" }, bodyChildren),
          ]
        );
        changeLog.appendChild(rowEl);
      }
      weekOverWeekPanel.appendChild(changeLog);

      changeLog.querySelectorAll(".changelog-row").forEach((rowEl) => {
        const selectWeek = () => {
          const idx = Number(rowEl.getAttribute("data-week-index"));
          const isLatest = idx === weeks.length - 1;
          changeLog.querySelectorAll(".changelog-row").forEach((r) => r.classList.remove("is-selected"));
          rowEl.classList.add("is-selected");
          renderSnapshotSections(historySnapshotSections, isLatest ? p : weeks[idx], weeks[idx].asOf, isLatest, { readOnly: true, depsAndRisks: false });
        };
        rowEl.addEventListener("click", selectWeek);
        rowEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selectWeek();
          }
        });
      });

      // Defaults to the latest week; click an older row in the changelog
      // below to rewind the Weekly Status cards above.
      renderSnapshotSections(historySnapshotSections, p, weeks[weeks.length - 1].asOf, true, { readOnly: true, depsAndRisks: false });
    }

    // Full feedback history
    feedbackPanel.appendChild(
      buildCallScratch(
        p,
        "feedback",
        "Notes from the call",
        "Type feedback raised on the call. Clean it up into a follow-up later."
      )
    );
    feedbackPanel.appendChild(el("h3", { class: "weekly-subhead" }, ["Feedback history"]));
    if (!allNotes.length) {
      feedbackPanel.appendChild(el("p", { class: "empty-note" }, ["No feedback logged for this project yet."]));
    } else {
      const notesList = el("div", { class: "notes-list" });
      allNotes
        .slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .forEach((n) => {
          const effective = noteStatus(n);
          const locallyOnly = effective === "resolved" && n.status !== "resolved";
          notesList.appendChild(
            el("div", { class: "note-row " + (effective === "open" ? "is-open" : "is-resolved") }, [
              el("span", { class: "note-status" }, [effective === "open" ? "OPEN" : "RESOLVED"]),
              el("span", { class: "note-text" }, [n.text]),
              ...(n.mitigationImpact
                ? [el("span", { class: "note-mitigation" }, ["Mitigation / impact: " + n.mitigationImpact])]
                : []),
              ...(n.status === "resolved" && n.resolutionNote
                ? [el("span", { class: "note-mitigation" }, ["Resolution: " + n.resolutionNote])]
                : []),
              el("span", { class: "note-meta" }, [
                (n.raisedBy ? n.raisedBy + " · " : "") + fmtDate((n.createdAt || "").slice(0, 10)),
                n.status === "resolved" && n.resolvedBy
                  ? " · resolved by " + n.resolvedBy + (n.resolvedAt ? " " + fmtDate((n.resolvedAt || "").slice(0, 10)) : "")
                  : "",
                locallyOnly ? " · resolved in your browser, not yet synced" : "",
              ]),
              ...(effective === "open" ? [resolveLink(n, p.name)] : []),
              ...(locallyOnly ? [resolvedActions(n, p.name)] : []),
            ])
          );
        });
      feedbackPanel.appendChild(notesList);
    }

    return root;
  }

  // Maps every jump-linkable anchor id inside the project detail view to
  // the tab panel that now contains it, so `openProjectDetail`'s
  // `focusSectionId` can switch to the right tab before scrolling to the
  // anchor (scrollIntoView on a still-hidden `.detail-tab-panel` is a
  // no-op, so the tab switch has to happen first).
  const DETAIL_SECTION_TAB_MAP = {
    "stage-gate-timeline-section": "delay",
    "detail-deps-section": "depsrisks",
    "detail-risks-section": "depsrisks",
    "detail-escalations-section": "depsrisks",
    "raid-log-section": "depsrisks",
    "detail-followups-section": "followups",
    "detailScheduleSection": "delay",
    "milestones-section": "schedule",
    "delay-log-section": "delay",
    "delay-attribution-section": "delay",
    "delay-entries-section": "delay",
    "cr-log-section": "changedecisions",
    "decision-log-section": "changedecisions",
    "feature-tracker-section": "features",
  };

  // Single-open accordion (2026-10-16, replacing a tab-strip's always-
  // exactly-one-active model): `tabId` is the one tile/panel to open —
  // pass a falsy value to collapse everything (used when a user clicks
  // the already-open tile, toggling it closed, per the confirmed
  // "single-open accordion" + "all collapsed by default" behavior).
  // Tiles (`.detail-tab-tile`) and panels (`.detail-tab-panel`) are two
  // separate flat lists since the horizontal icon-strip redesign (same
  // day) — matched up here purely by `data-tab`, not by DOM nesting.
  function activateDetailTab(root, tabId) {
    root.querySelectorAll(".detail-tab-tile").forEach((tile) => {
      const isOpen = !!tabId && tile.getAttribute("data-tab") === tabId;
      tile.classList.toggle("is-open", isOpen);
      tile.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });
    root.querySelectorAll(".detail-tab-panel").forEach((panel) => {
      const isOpen = !!tabId && panel.getAttribute("data-tab") === tabId;
      panel.classList.toggle("is-active", isOpen);
    });
  }

  /* ---------------- Stage detail modal ---------------- */

  function openStageDetail(projectId, stage) {
    const project = DATA.projects.find((p) => p.id === projectId);
    if (!project) return;

    const overlay = document.getElementById("stageDetail");
    const content = document.getElementById("stageDetailContent");
    content.innerHTML = "";
    content.appendChild(buildStageDetail(project, stage));
    overlay.hidden = false;
    overlay.scrollTop = 0;
  }

  function closeStageDetail() {
    document.getElementById("stageDetail").hidden = true;
  }

  // Dependency / Risk item detail modal — opened by clicking a dependency
  // or risk/blocker row in a project's full detail view. Takes the actual
  // objects directly (not an id to re-look-up) since legacy risk rows
  // don't always have a stable id to look up by.
  function openItemDetail(kind, project, item) {
    const overlay = document.getElementById("itemDetail");
    const content = document.getElementById("itemDetailContent");
    content.innerHTML = "";
    content.appendChild(buildItemDetail(kind, project, item));
    overlay.hidden = false;
    overlay.scrollTop = 0;
  }

  function closeItemDetail() {
    document.getElementById("itemDetail").hidden = true;
  }

  function buildCrDetail(project, cr) {
    const root = el("div", { class: "itemdetail-root" });
    root.appendChild(
      el("div", { class: "stagedetail-head" }, [
        el("div", null, [
          el("div", { class: "stagedetail-kicker" }, [project.name.toUpperCase() + " · CHANGE REQUEST " + cr.num]),
          el("h2", null, [cr.title || "Untitled change request"]),
          el("span", { class: "cr-log-status " + crStatusClass(cr.approvalStatus) }, [cr.approvalStatus || "TBD"]),
        ]),
      ])
    );
    root.appendChild(
      el("dl", { class: "detail-facts itemdetail-facts" }, [
        el("dt", null, ["Description"]),
        el("dd", { class: "cr-detail-text" }, [cr.description || "—"]),
        el("dt", null, ["Submitted"]),
        el("dd", null, [(cr.submittedDate ? fmtDate(cr.submittedDate) : "—") + (cr.by ? " · by " + cr.by : "")]),
        el("dt", null, ["Action item"]),
        el("dd", { class: "cr-detail-text" }, [cr.actionItem || "—"]),
        el("dt", null, ["Impact"]),
        el("dd", { class: "cr-detail-text" }, [cr.impact || "—"]),
      ])
    );
    return root;
  }

  function buildItemDetail(kind, project, item) {
    if (kind === "cr") return buildCrDetail(project, item);
    const isDep = kind === "dependency";
    const root = el("div", { class: "itemdetail-root" });

    root.appendChild(
      el("div", { class: "stagedetail-head" }, [
        el("div", null, [
          el("div", { class: "stagedetail-kicker" }, [
            project.name.toUpperCase() + " · " + (isDep ? "DEPENDENCY" : "RISK / BLOCKER"),
          ]),
          el("h2", null, [item.id || (isDep ? "Unlabeled dependency" : "Unlabeled risk")]),
        ]),
      ])
    );

    const fields = [el("dt", null, ["Description"]), el("dd", null, [item.text || "—"])];

    if (item.track) {
      fields.push(el("dt", null, ["Source track"]), el("dd", null, [item.track]));
    }

    if (isDep) {
      fields.push(
        el("dt", null, ["Team"]),
        el("dd", null, [item.team || "No team labeled"]),
        el("dt", null, ["Priority"]),
        el("dd", null, [item.priority || "—"]),
        el("dt", null, ["Due by"]),
        el("dd", null, [item.dueBy ? fmtDate(item.dueBy) : "Not set"]),
        el("dt", null, ["Escalated"]),
        el("dd", null, [item.escalated ? "🚨 Yes — escalated to leadership" : "No"])
      );
    }

    fields.push(
      el("dt", null, ["Resolved"]),
      el("dd", null, [item.resolved ? "Yes" : "No — still open"]),
      el("dt", null, [isDep ? "Mitigation / impact" : "Mitigation plan"]),
      el("dd", null, [item.mitigation || "Not yet documented"])
    );

    root.appendChild(el("dl", { class: "detail-facts itemdetail-facts" }, fields));

    if (isDep && item.id) {
      root.appendChild(
        el("div", { class: "dep-actions-row itemdetail-actions" }, [
          dependencyActionLink(dependencyUpdateUrl(project.name, item.id, {}), "✎ Update"),
          item.escalated
            ? dependencyActionLink(
                dependencyUpdateUrl(project.name, item.id, { mark_escalated: "No — un-escalate" }),
                "✓ Un-escalate"
              )
            : dependencyActionLink(
                dependencyUpdateUrl(project.name, item.id, { mark_escalated: "Yes — escalate" }),
                "🚨 Escalate"
              ),
          dependencyActionLink(
            dependencyUpdateUrl(project.name, item.id, { mark_resolved: "Yes — resolved" }),
            "✓ Resolve"
          ),
        ])
      );
    } else if (!isDep) {
      root.appendChild(
        el("div", { class: "dep-actions-row itemdetail-actions" }, [
          detailSectionIssueLink("new-risk.yml", project.name, "+ Report an update"),
        ])
      );
    }

    return root;
  }

  function stageStatusBadge(kind) {
    return { done: "Done", current: "In Progress", future: "Not Started" }[kind] || kind;
  }

  function buildStageDetail(p, stage) {
    const stageIndex = PIPELINE_STAGES.indexOf(stage);
    const segments = computeStageSegments(p);
    const seg = segments.find((s) => s.stage === stage) || null;
    const currentIndex = PIPELINE_STAGES.indexOf(p.stage || "Unstaged");
    const kind = stageIndex < currentIndex ? "done" : stageIndex === currentIndex ? "current" : "future";
    const days = seg ? seg.days : 0;
    const plan = (p.stagePlan && p.stagePlan[stage]) || {};
    const delayEntries = stageDelayLog(p, stage);
    const autoShifts = stageAutoScheduleShifts(p, stage);
    const revisions = stagePlanRevisions(p, stage);

    const root = el("div", { class: "stagedetail-root" });

    root.appendChild(
      el("div", { class: "stagedetail-head" }, [
        el("div", null, [
          el("div", { class: "stagedetail-kicker" }, [
            p.name.toUpperCase() + " · STAGE " + (stageIndex + 1) + " OF " + PIPELINE_STAGES.length,
          ]),
          el("h2", null, [stage]),
          el("div", { class: "stagedetail-sub" }, [
            stageStatusBadge(kind) + (p.owner ? " · PM " + p.owner : ""),
          ]),
        ]),
      ])
    );

    root.appendChild(
      el("div", { class: "stagedetail-tabs", role: "tablist" }, [
        el("button", { class: "stagedetail-tab-btn is-active", "data-panel": "overview", type: "button" }, ["Overview"]),
        el("button", { class: "stagedetail-tab-btn", "data-panel": "history", type: "button" }, ["Date History"]),
        el("button", { class: "stagedetail-tab-btn", "data-panel": "analysis", type: "button" }, ["Delay Analysis"]),
        el("button", { class: "stagedetail-tab-btn", "data-panel": "log", type: "button" }, ["Delay Log"]),
      ])
    );

    const panels = el("div", { class: "stagedetail-panels" }, [
      el("div", { class: "stagedetail-panel is-active", "data-panel": "overview" }, [
        buildStageOverviewPanel(p, stage, seg, days, kind, plan, delayEntries),
      ]),
      el("div", { class: "stagedetail-panel", "data-panel": "history" }, [buildStageHistoryPanel(revisions)]),
      el("div", { class: "stagedetail-panel", "data-panel": "analysis" }, [buildStageAnalysisPanel(delayEntries)]),
      el("div", { class: "stagedetail-panel", "data-panel": "log" }, [buildStageLogPanel(delayEntries, autoShifts)]),
    ]);
    root.appendChild(panels);

    root.querySelectorAll(".stagedetail-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        root.querySelectorAll(".stagedetail-tab-btn").forEach((b) => b.classList.remove("is-active"));
        root.querySelectorAll(".stagedetail-panel").forEach((pnl) => pnl.classList.remove("is-active"));
        btn.classList.add("is-active");
        root.querySelector('.stagedetail-panel[data-panel="' + btn.getAttribute("data-panel") + '"]').classList.add("is-active");
      });
    });

    return root;
  }

  // Current-stage overview card (`buildCurrentStageOverviewCard`,
  // embedded in the Stage-gate panel 2026-10-16, made whole-card-
  // clickable the same day) was removed 2026-10-16, same day as its
  // last edit — see the removal note at its old call site in
  // `buildProjectDetail()` above. Function deleted outright since
  // nothing else called it; `buildStageOverviewPanel()` below is still
  // very much alive — the stage detail modal (`openStageDetail`) is its
  // only remaining caller now.

  function dateVarianceCell(initial, latest, actual) {
    let varianceLabel = "—";
    let varianceClass = "";
    // Slip against the original date. A stage that finished on its revised
    // date is still late when that revised date is past the original one
    // (2026-11-05: MyBKY Development actual and latest were both 21 Sep,
    // so this said "On schedule" while the original end was 17 Aug).
    const from = initial || latest;
    const to = actual || latest;
    const againstInitial = !!initial;
    if (from && to) {
      const delta = businessDaysBetweenIso(from, to);
      if (delta === 0) {
        varianceLabel = "On schedule";
        varianceClass = "is-ontime";
      } else if (delta > 0) {
        varianceLabel = "+" + delta + "d" + (againstInitial ? " vs initial plan" : " late");
        varianceClass = "is-late";
      } else {
        varianceLabel = delta + "d" + (againstInitial ? " vs initial plan" : " early");
        varianceClass = "is-early";
      }
    } else if (!latest) {
      varianceLabel = "Not planned yet";
    } else {
      varianceLabel = "Pending";
    }
    return el("span", { class: "stagedetail-variance" + (varianceClass ? " " + varianceClass : "") }, [varianceLabel]);
  }

  function buildStageOverviewPanel(p, stage, seg, days, kind, plan, delayEntries) {
    // `seg` can be null even for a "done" stage — computeStageSegments()
    // only reconstructs stages actually captured in history.json, so a
    // project whose tracking began mid-pipeline has no segment for stages
    // before that point, even though they're clearly in the past by index.
    const actualStart = seg ? seg.start : null;
    const actualEnd = kind === "done" && seg ? seg.end : null;

    // Progress is measured against THIS project's own planned duration for
    // the stage (stagePlan's latest approved dates), not a flat per-stage
    // constant (2026-10-05 — see the note on renderStageGridLegend for why
    // that was removed). Falls back to null (no bar) when no plan is on
    // record for this stage yet.
    const plannedDays =
      plan.latestStart && plan.latestEnd ? daysBetweenIso(plan.latestStart, plan.latestEnd) : null;
    const pct =
      kind === "done"
        ? 100
        : kind === "future"
        ? 0
        : plannedDays
        ? Math.max(0, Math.min(100, Math.round((days / plannedDays) * 100)))
        : null;
    const projectDelay = p.delayDays || 0;
    const stageSlip =
      plan.initialEnd && plan.latestEnd && plan.latestEnd !== plan.initialEnd
        ? businessDaysBetweenIso(plan.initialEnd, plan.latestEnd)
        : 0;
    const durationStart = (seg && seg.start) || plan.latestStart || plan.initialStart;
    const durationEnd = (kind === "done" && seg && seg.end) || plan.latestEnd || plan.initialEnd;
    const durationDays =
      seg && seg.days
        ? seg.days
        : durationStart && durationEnd
        ? Math.max(0, daysBetweenIso(durationStart, durationEnd))
        : days;

    // For a not-yet-reached stage with no real stagePlan entry, `plan` is
    // empty and every date row below would just show "—" — not useful
    // when the whole point of clicking through here was "what's the
    // potential target for this." Fall back to the same placeholder-width
    // estimate the Hawk-eye future-chip strip uses (buildHawkeyeBlocks),
    // clearly suffixed "(estimated)" so it's never mistaken for a real
    // planned date.
    const estBlock = kind === "future" ? buildHawkeyeBlocks(p).find((b) => b.stage === stage) : null;
    const showEstimate = !!(estBlock && !estBlock.planned);

    return el("div", null, [
      el("div", { class: "stagedetail-datebox-row" }, [
        el("div", { class: "stagedetail-datebox" }, [
          el("h4", null, ["Start Date"]),
          el("dl", null, [
            el("dt", null, ["Initial Planned Start Date"]),
            el("dd", null, [fmtDate(plan.initialStart)]),
            el("dt", null, ["Latest Planned Start Date"]),
            el("dd", null, [
              plan.latestStart
                ? fmtDate(plan.latestStart)
                : showEstimate
                ? fmtDate(estBlock.start) + " (estimated)"
                : fmtDate(plan.latestStart),
            ]),
            el("dt", null, ["Actual Start Date"]),
            el("dd", { class: "stagedetail-actual" }, [fmtDate(actualStart)]),
          ]),
          el("div", { class: "stagedetail-variance-row" }, [
            el("span", { class: "stagedetail-variance-label" }, ["Variance"]),
            dateVarianceCell(plan.initialStart, plan.latestStart, actualStart),
          ]),
        ]),
        el("div", { class: "stagedetail-datebox" }, [
          el("h4", null, ["Completion Date"]),
          el("dl", null, [
            el("dt", null, ["Initial Planned Completion Date"]),
            el("dd", null, [fmtDate(plan.initialEnd)]),
            el("dt", null, ["Latest Planned Completion Date"]),
            el("dd", null, [
              plan.latestEnd
                ? fmtDate(plan.latestEnd)
                : showEstimate
                ? fmtDate(estBlock.end) + " (estimated)"
                : fmtDate(plan.latestEnd),
            ]),
            el("dt", null, ["Actual Completion Date"]),
            el("dd", { class: "stagedetail-actual" }, [actualEnd ? fmtDate(actualEnd) : "—"]),
          ]),
          el("div", { class: "stagedetail-variance-row" }, [
            el("span", { class: "stagedetail-variance-label" }, ["Variance"]),
            dateVarianceCell(plan.initialEnd, plan.latestEnd, actualEnd),
          ]),
        ]),
      ]),

      el("div", { class: "stagedetail-completion" }, [
        el("div", { class: "stagedetail-completion-head" }, [
          el("h4", null, ["Stage Progress"]),
          el("span", { class: "stagedetail-completion-pct" }, [pct == null ? "—" : pct + "%"]),
        ]),
        el("div", { class: "progress-track" }, [
          el("div", {
            class:
              "progress-fill status-" +
              (kind === "done" ? "green" : kind === "future" ? "grey" : currentStageOverdue(p, stage) ? "red" : "amber"),
            style: "width:" + (pct || 0) + "%",
          }),
        ]),
        el("div", { class: "stagedetail-completion-foot" }, [
          el("span", null, [kind === "done" ? "Closed out" : kind === "current" ? "In progress" : "Not started"]),
          el("span", null, ["Status: " + stageStatusBadge(kind)]),
        ]),
      ]),

      el("div", { class: "stagedetail-stat-row" }, [
        el("div", { class: "metric-card" }, [
          el("div", { class: "num" }, [durationDays + "d"]),
          el("div", { class: "label" }, ["Stage duration"]),
          el("div", { class: "stage-grid-metric-sub" }, [kind === "done" ? "total" : "elapsed so far"]),
        ]),
        el("div", { class: "metric-card" }, [
          el("div", { class: "num" }, [String(delayEntries.length)]),
          el("div", { class: "label" }, ["Log entries"]),
          el("div", { class: "stage-grid-metric-sub" }, ["recorded"]),
        ]),
        el("div", { class: "metric-card" + (stageSlip > 0 ? " tone-amber" : projectDelay > 0 ? " tone-amber" : " tone-green") }, [
          el("div", { class: "num" }, [(stageSlip > 0 ? "+" : "") + stageSlip + "d"]),
          el("div", { class: "label" }, ["Stage delay"]),
          el("div", { class: "stage-grid-metric-sub" }, [
            stageSlip > 0
              ? "weekdays, latest plan vs initial"
              : projectDelay > 0
              ? "none on this stage · project +" + projectDelay + "d"
              : "weekdays, latest plan vs initial",
          ]),
        ]),
      ]),
    ]);
  }

  function buildStageHistoryPanel(revisions) {
    if (!revisions.length) {
      return el("div", { class: "deps-empty-group" }, ["No planned-date revisions recorded yet — submit a planned start/completion date on a weekly update for this stage to start tracking."]);
    }
    return el("div", null, [
      el("table", { class: "stagedetail-history-table" }, [
        el("thead", null, [
          el("tr", null, [
            el("th", null, ["Revision"]),
            el("th", null, ["Changed On"]),
            el("th", null, ["Field"]),
            el("th", null, ["From → To"]),
            el("th", null, ["Shift"]),
          ]),
        ]),
        el(
          "tbody",
          null,
          revisions.map((r) =>
            el("tr", null, [
              el("td", { class: "stagedetail-rev-cell" }, [r.revision]),
              el("td", null, [fmtDate(r.changedOn)]),
              el("td", null, [r.field]),
              el("td", null, [(r.from ? fmtDateShort(r.from) : "—") + " → " + fmtDateShort(r.to)]),
              el("td", { class: "stagedetail-shift-cell" }, [r.shiftDays == null ? "—" : (r.shiftDays > 0 ? "+" : "") + r.shiftDays + "d"]),
            ])
          )
        ),
      ]),
      el("ul", { class: "stagedetail-history-notes" }, [
        el("li", null, ["Baseline is the first planned date submitted for this stage; every later change is tracked as a revision."]),
        el("li", null, ["Shift is measured against the immediately preceding revision, not the baseline."]),
      ]),
    ]);
  }

  function buildStageAnalysisPanel(entries, emptyLabel, opts) {
    opts = opts || {};
    const breakdowns = opts.breakdowns || [
      { title: "By Team", groups: aggregateDelayLog(entries, "team") },
      { title: "By Member", groups: aggregateDelayLog(entries, "member") },
      { title: "By Reason", groups: aggregateDelayLog(entries, "reason") },
    ];
    const hasChart = breakdowns.some((b) => b.groups && b.groups.length);
    if (!entries.length && !hasChart && opts.num == null) {
      return el("div", { class: "deps-empty-group" }, [emptyLabel || "No delay log entries recorded for this stage."]);
    }
    const totalDays = entries.reduce((sum, e) => sum + (e.days || 0), 0);
    return el(
      "div",
      { class: "stagedetail-analysis-head" }, [
      el("div", { class: "stagedetail-analysis-total" }, [
        el("span", { class: "kicker" }, [opts.kicker || "Delay Attribution"]),
        el("span", { class: "num" + (opts.numClass ? " " + opts.numClass : "") }, [opts.num != null ? String(opts.num) : String(totalDays)]),
        el("span", { class: "label" }, [opts.label || "days total"]),
      ]),
      hasChart
        ? el(
            "div",
            { class: "stagedetail-analysis-cols" },
            breakdowns.filter((b) => b.groups && b.groups.length).map((b) =>
              el("div", { class: "stagedetail-analysis-col" }, [
                el("h4", null, [b.title]),
                buildDonutChart(b.groups, { centerLabel: b.centerLabel, centerNum: b.centerNum }),
                el(
                  "div",
                  { class: "stagedetail-bar-list" },
                  b.groups.map((g, i) =>
                    el("div", { class: "stagedetail-bar-row" }, [
                      el("span", { class: "stagedetail-bar-dot", style: `background:${BREAKDOWN_COLORS[i % BREAKDOWN_COLORS.length]}` }),
                      el("span", { class: "stagedetail-bar-label" }, [g.label]),
                      el("span", { class: "stagedetail-bar-days" }, [g.days + "d"]),
                    ])
                  )
                ),
              ])
            )
          )
        : null,
    ]);
  }

  const BREAKDOWN_COLORS = ["#c1502e", "#5a3b30", "#dfa23a", "#3562e8", "#1a9f6b", "#8a5fd6"];
  // Separate palette for the "by stage-gate" donut next to the
  // "cumulative project delays" donut (2026-10-06) — kept visually
  // distinct from BREAKDOWN_COLORS (used for the project-delay ring) so
  // the two side-by-side circles never land on the exact same colors.
  const PM_RING_COLORS = ["#2f6fed", "#7c3aed", "#0ea5a5", "#d97706", "#64748b", "#be185d"];

  // Reusable SVG donut chart — `groups` is [{label, days, color?}], already
  // sorted by whatever the caller wants (biggest slice first, typically).
  // Renders as concentric arc segments via stroke-dasharray/-dashoffset on
  // stacked <circle>s (rotated -90° so the first segment starts at 12
  // o'clock, matching the internal admin-dashboard mockup this was modeled
  // on), with the total printed in the hole in the middle. Falls back to a
  // plain grey ring + "0" when every group is 0 days (nothing to show a
  // proportion of) rather than dividing by zero.
  function buildDonutChart(groups, opts) {
    opts = opts || {};
    const size = opts.size || 140;
    const strokeWidth = opts.strokeWidth || 20;
    const r = (size - strokeWidth) / 2;
    const cx = size / 2;
    const cy = size / 2;
    const circumference = 2 * Math.PI * r;
    const total = groups.reduce((sum, g) => sum + (g.days || 0), 0);

    let circlesSvg;
    if (total <= 0) {
      circlesSvg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line-strong)" stroke-width="${strokeWidth}" />`;
    } else {
      let offsetAcc = 0;
      circlesSvg = groups
        .filter((g) => (g.days || 0) > 0)
        .map((g, i) => {
          const frac = g.days / total;
          const dash = frac * circumference;
          const gap = circumference - dash;
          const dashoffset = -offsetAcc;
          offsetAcc += dash;
          const color = g.color || BREAKDOWN_COLORS[i % BREAKDOWN_COLORS.length];
          return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${strokeWidth}" stroke-dasharray="${dash} ${gap}" stroke-dashoffset="${dashoffset}" stroke-linecap="butt" transform="rotate(-90 ${cx} ${cy})" />`;
        })
        .join("");
    }

    const svg = `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" class="donut-chart-svg">${circlesSvg}</svg>`;
    return el("div", { class: "donut-chart", style: `width:${size}px;height:${size}px`, html: svg }, [
      el("div", { class: "donut-chart-center" }, [
        el("span", { class: "donut-chart-num" }, [opts.centerNum != null ? String(opts.centerNum) : String(total)]),
        el("span", { class: "donut-chart-label" }, [opts.centerLabel || "days"]),
      ]),
    ]);
  }

  function buildStageLogPanel(entries, autoShifts) {
    const wrap = el("div", { class: "stagedetail-log-wrap" });

    // Auto-detected schedule shifts first — same Go-Live / milestone-shift
    // data as the Schedule timeline's "Date change log", filtered to
    // shifts that happened while the project was in this stage.
    wrap.appendChild(el("h4", { class: "weekly-subhead" }, ["Schedule shifts (auto-detected)"]));
    wrap.appendChild(
      el("p", { class: "section-subhead" }, [
        "Go-Live / milestone date moves that happened while this project was in this stage — pulled automatically from the Schedule timeline, not manually reported.",
      ])
    );
    if (!autoShifts || !autoShifts.length) {
      wrap.appendChild(el("p", { class: "empty-note" }, ["No schedule-driven delays detected for this stage yet."]));
    } else {
      wrap.appendChild(renderScheduleTimeline(autoShifts));
      // The "+Nd" on each row is just that one row's own delta — don't add
      // them up. Go-Live and the next-milestone target are two different
      // dates interleaved in the same list, and the milestone's label
      // itself sometimes gets reworded as scope gets refined (e.g.
      // "TDD" → "Requirement + TDD" → "Requirements completion"), so even
      // two consecutive milestone rows aren't always "the same date
      // slipping again." None of this feeds the Stage duration / Project
      // delay numbers above either — those come from real elapsed calendar
      // time and the project's overall committed-go-live slip,
      // independent of how many times a target got re-planned.
      wrap.appendChild(
        el("p", { class: "section-subhead stagedetail-log-note" }, [
          "Note: each row above is its own change, not a running total — Go-Live and milestone-target shifts are tracked separately and shouldn't be summed together, and they're unrelated to the Stage duration / Project delay figures above.",
        ])
      );
    }

    wrap.appendChild(el("h4", { class: "weekly-subhead stagedetail-manual-log-head" }, ["Manually reported delay log"]));
    wrap.appendChild(buildManualDelayLogSearchTable(entries));

    return wrap;
  }

  // The searchable/sortable "manually reported delay log" table — split
  // out of `buildStageLogPanel()` (2026-10-15) so the project-wide Delay
  // tab can reuse it directly with ALL of a project's `p.delayLog`
  // entries (every stage, not just one), without also re-rendering the
  // "Schedule shifts (auto-detected)" section above it a second time
  // (that's shown once, at the top of the Delay tab, project-wide).
  function buildManualDelayLogSearchTable(entries) {
    const wrap = el("div");
    const reasons = Array.from(new Set(entries.map((e) => e.reason).filter(Boolean))).sort();
    const teams = Array.from(new Set(entries.map((e) => e.team).filter(Boolean))).sort();

    const searchInput = el("input", { type: "text", class: "stagedetail-log-search", placeholder: "Search delay log..." });
    const reasonSelect = el("select", { class: "stagedetail-log-filter" }, [
      el("option", { value: "all" }, ["All Reasons"]),
      ...reasons.map((r) => el("option", { value: r }, [r])),
    ]);
    const teamSelect = el("select", { class: "stagedetail-log-filter" }, [
      el("option", { value: "all" }, ["All Teams"]),
      ...teams.map((t) => el("option", { value: t }, [t])),
    ]);

    wrap.appendChild(
      el("div", { class: "stagedetail-log-controls" }, [searchInput, reasonSelect, teamSelect])
    );

    const tableHolder = el("div");
    wrap.appendChild(tableHolder);

    // Default sort matches the Schedule timeline's own (newest-first)
    // order rather than re-sorting by day-count (2026-11-04, "they should
    // show according to the timeline") — `entries` already arrives in that
    // order whether it's the real manually-reported `p.delayLog` or the
    // auto-loaded fallback (`projectAutoDelayLogEntries()`). Clicking the
    // "Days" header switches to sorting by magnitude instead, toggling
    // direction on repeat clicks, same as before.
    let sortByDays = false;
    let sortDesc = true;

    function render() {
      const q = searchInput.value.trim().toLowerCase();
      const reasonFilter = reasonSelect.value;
      const teamFilter = teamSelect.value;
      let filtered = entries.filter((e) => {
        if (reasonFilter !== "all" && e.reason !== reasonFilter) return false;
        if (teamFilter !== "all" && e.team !== teamFilter) return false;
        if (q && !((e.reason || "") + " " + (e.member || "") + " " + (e.team || "") + " " + (e.id || "")).toLowerCase().includes(q)) return false;
        return true;
      });
      filtered = sortByDays ? filtered.slice().sort((a, b) => (sortDesc ? b.days - a.days : a.days - b.days)) : filtered.slice();

      tableHolder.innerHTML = "";
      if (!filtered.length) {
        tableHolder.appendChild(el("div", { class: "deps-empty-group" }, ["No matching delay log entries."]));
        return;
      }

      const sortArrow = sortByDays ? el("span", { class: "stagedetail-sort-arrow" }, [sortDesc ? "▼" : "▲"]) : null;
      const daysHeader = el("th", { class: "stagedetail-days-header" }, ["Days ", sortArrow]);
      daysHeader.addEventListener("click", () => {
        sortDesc = sortByDays ? !sortDesc : true;
        sortByDays = true;
        render();
      });

      tableHolder.appendChild(
        el("table", { class: "stagedetail-log-table" }, [
          el("thead", null, [
            el("tr", null, [
              el("th", null, ["ID"]),
              el("th", null, ["Date"]),
              el("th", null, ["Stage"]),
              el("th", null, ["Reason"]),
              el("th", null, ["Member"]),
              el("th", null, ["Team"]),
              daysHeader,
            ]),
          ]),
          el(
            "tbody",
            null,
            filtered.map((e) =>
              el("tr", null, [
                el("td", { class: "stagedetail-id-cell" }, [e.id || "—"]),
                el("td", null, [fmtDateShort(e.date)]),
                el("td", null, [e.stage || "—"]),
                el("td", null, [e.reason || "—"]),
                el("td", null, [e.member || "—"]),
                el("td", null, [e.team || "—"]),
                el("td", null, [el("span", { class: "stagedetail-days-pill" }, [e.days + "d"])]),
              ])
            )
          ),
        ])
      );
    }

    [searchInput, reasonSelect, teamSelect].forEach((input) => {
      input.addEventListener("input", render);
      input.addEventListener("change", render);
    });
    render();

    return wrap;
  }

  function wireStageDetailModal() {
    document.getElementById("stageDetailClose").addEventListener("click", closeStageDetail);
    document.getElementById("stageDetail").addEventListener("click", (e) => {
      if (e.target.id === "stageDetail") closeStageDetail();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !document.getElementById("stageDetail").hidden) closeStageDetail();
    });
  }

  function wireItemDetailModal() {
    document.getElementById("itemDetailClose").addEventListener("click", closeItemDetail);
    document.getElementById("itemDetail").addEventListener("click", (e) => {
      if (e.target.id === "itemDetail") closeItemDetail();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !document.getElementById("itemDetail").hidden) closeItemDetail();
    });
  }

  function wireProjectDetail() {
    document.getElementById("detailClose").addEventListener("click", closeProjectDetail);
    document.getElementById("projectDetail").addEventListener("click", (e) => {
      if (e.target.id === "projectDetail") closeProjectDetail();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !document.getElementById("projectDetail").hidden) closeProjectDetail();
    });
  }

  /* ---------------- Feedback modal ---------------- */

  // Opens the same feedback modal the masthead's "📝 Add feedback" button
  // uses (2026-11-04, "it should land in the same spot if I click that
  // feedback button" — the per-project "Add feedback" button used to skip
  // this modal and jump straight to the GitHub issue form; now both land
  // here, with the project preselected when a specific project triggered it).
  function openFeedbackModal(projectName) {
    const projectSelect = document.getElementById("fbProject");
    if (projectName) projectSelect.value = projectName;
    document.getElementById("feedbackModal").hidden = false;
  }

  function wireFeedbackModal() {
    const modal = document.getElementById("feedbackModal");
    const projectSelect = document.getElementById("fbProject");
    activeProjects().forEach((p) => {
      projectSelect.appendChild(el("option", { value: p.name }, [p.name]));
    });

    document.getElementById("fbCancel").addEventListener("click", () => {
      modal.hidden = true;
    });
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.hidden = true;
    });
    document.getElementById("fbSubmit").addEventListener("click", () => {
      const projectName = projectSelect.value;
      const project = (DATA.projects || []).find((item) => item.name === projectName);
      const note = document.getElementById("fbNote").value.trim();
      const mitigationImpact = document.getElementById("fbMitigation").value.trim();
      const raisedBy = document.getElementById("fbRaisedBy").value.trim();
      if (!note) {
        document.getElementById("fbNote").focus();
        return;
      }
      if (project) {
        const lines = [note];
        if (mitigationImpact) lines.push("Mitigation / impact: " + mitigationImpact);
        if (raisedBy) lines.push("Raised by: " + raisedBy);
        const prev = scratchNoteFor(project, "feedback");
        saveScratchNote(project, "feedback", (prev ? prev.replace(/\s+$/, "") + "\n\n" : "") + lines.join("\n"));
      }
      modal.hidden = true;
      document.getElementById("fbNote").value = "";
      document.getElementById("fbMitigation").value = "";
      document.getElementById("fbRaisedBy").value = "";
    });
  }

  /* ---------------- Add Dependency / Report a Risk modals ---------------- */

  // Both used to be plain external links straight to a GitHub issue form
  // (2026-11-04, "make these buttons for adding dependencies and risks
  // directly into the view") — now an in-page form, same pattern as the
  // feedback modal: fill it in here, then one button opens the pre-filled
  // GitHub issue to actually submit it (this is a static site with no
  // write access of its own).
  let depModalProject = null;
  let riskModalProject = null;

  function openDependencyModal(projectName) {
    depModalProject = projectName;
    document.getElementById("depModalProject").textContent = "For " + projectName;
    document.getElementById("depModal").hidden = false;
    document.getElementById("depDescription").focus();
  }

  function openRiskModal(projectName) {
    riskModalProject = projectName;
    document.getElementById("riskModalProject").textContent = "For " + projectName;
    document.getElementById("riskModal").hidden = false;
    document.getElementById("riskDescription").focus();
  }

  function wireDependencyModal() {
    const modal = document.getElementById("depModal");
    const close = () => { modal.hidden = true; };
    document.getElementById("depCancel").addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    document.getElementById("depSubmit").addEventListener("click", () => {
      const description = document.getElementById("depDescription").value.trim();
      const team = document.getElementById("depTeam").value.trim();
      const priority = document.getElementById("depPriority").value;
      const dueBy = document.getElementById("depDueBy").value;
      const mitigation = document.getElementById("depMitigation").value.trim();
      if (!description) return document.getElementById("depDescription").focus();
      if (!team) return document.getElementById("depTeam").focus();
      const url = issueUrl("new-dependency.yml", {
        project: depModalProject || "",
        description,
        team,
        priority,
        due_by: dueBy,
        mitigation,
      });
      window.open(url, "_blank", "noopener");
      close();
      document.getElementById("depDescription").value = "";
      document.getElementById("depTeam").value = "";
      document.getElementById("depDueBy").value = "";
      document.getElementById("depMitigation").value = "";
    });
  }

  function wireRiskModal() {
    const modal = document.getElementById("riskModal");
    const close = () => { modal.hidden = true; };
    document.getElementById("riskCancel").addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    document.getElementById("riskSubmit").addEventListener("click", () => {
      const description = document.getElementById("riskDescription").value.trim();
      const mitigation = document.getElementById("riskMitigation").value.trim();
      if (!description) return document.getElementById("riskDescription").focus();
      const url = issueUrl("new-risk.yml", {
        project: riskModalProject || "",
        description,
        mitigation,
      });
      window.open(url, "_blank", "noopener");
      close();
      document.getElementById("riskDescription").value = "";
      document.getElementById("riskMitigation").value = "";
    });
  }

  /* ---------------- Tabs ---------------- */

  // Team Performance is a disconnected placeholder stub (no data wired
  // up at all yet) — none of the filters affect it, so the bar hides
  // there. Project and PM apply on every other tab. The Team dropdown
  // only applies on Dependencies (2026-11-05).
  const NO_FILTER_TABS = new Set(["team"]);

  function updateGlobalFilterBarForTab(tabKey) {
    const bar = document.getElementById("globalFilterBar");
    const teamGroup = document.getElementById("globalTeamFilterGroup");
    const teamSep = document.getElementById("globalTeamFilterSep");
    const hint = document.getElementById("globalFilterHint");
    if (!bar) return;

    if (NO_FILTER_TABS.has(tabKey)) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const showTeam = tabKey === "deps";
    teamGroup.hidden = !showTeam;
    teamSep.hidden = !showTeam;
    hint.textContent = showTeam ? "Team filter is for this tab" : "Applies to every tab";
    updateGlobalFilterUI();
  }

  function wireTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".tab-btn").forEach((b) => {
          b.classList.remove("is-active");
          b.setAttribute("aria-selected", "false");
        });
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("is-active"));
        btn.classList.add("is-active");
        btn.setAttribute("aria-selected", "true");
        const tabKey = btn.getAttribute("data-tab");
        const previousTab = activeTab;
        activeTab = tabKey;
        document.getElementById("panel-" + tabKey).classList.add("is-active");
        updateGlobalFilterBarForTab(tabKey);
        // A team picked on Dependencies must not keep filtering the other
        // tabs, and must apply again when coming back.
        const teamChangedScope = globalTeamFilter !== "all" && (previousTab === "deps" || tabKey === "deps");
        if (teamChangedScope) {
          if (tabKey === "hawkeye") requestAnimationFrame(() => renderAllTabs());
          else renderAllTabs();
        } else if (tabKey === "hawkeye") {
          requestAnimationFrame(() => renderHawkeye());
        }
      });
    });
    // Set the correct state for whichever tab starts active (Program
    // Status), rather than assuming the bar's static HTML default is
    // already right for it.
    const activeBtn = document.querySelector(".tab-btn.is-active");
    updateGlobalFilterBarForTab(activeBtn ? activeBtn.getAttribute("data-tab") : "status");
  }

  /* ---------------- Init ---------------- */

  function init([data, history, notes]) {
    DATA = data;
    HISTORY = history;
    NOTES = notes;

    renderHeader();
    populateGlobalProjectFilter();
    wireGlobalProjectFilter();
    populateGlobalOwnerFilter();
    wireGlobalOwnerFilter();
    populateGlobalTeamFilter();
    wireGlobalTeamFilter();
    renderMetrics();
    renderStageGrid();
    renderHawkeye();
    renderCards();

    renderDependenciesTab();
    renderEscalationsTab();

    wireProjectDetail();
    wireStageDetailModal();
    wireItemDetailModal();
    wireFeedbackModal();
    wireDependencyModal();
    wireRiskModal();
    wireTabs();
  }

  function safeFetchJson(path, fallback) {
    return fetch(path)
      .then((r) => (r.ok ? r.json() : fallback))
      .catch(() => fallback);
  }

  Promise.all([
    safeFetchJson("data.json", { asOf: null, lastUpdated: null, projects: [] }),
    safeFetchJson("history.json", {}),
    safeFetchJson("notes.json", []),
  ])
    .then(init)
    .catch((err) => {
      document.getElementById("cards").textContent = "Could not load dashboard data: " + err.message;
    });
})();
