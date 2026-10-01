(function () {
  "use strict";

  const REPO = "pankaj117-dev/baps-ndc-status";
  const STATUS_LABEL = { green: "On Track", amber: "At Risk", red: "Critical", black: "Non-Recoverable" };
  const STATUS_RANK = { green: 0, amber: 1, red: 2, black: 3 };

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
  let depsPivotGroupBy = "project"; // "project" | "team" — which rollup the Dependencies tab shows first
  let depsPivotCompact = false;
  let depsCycleFilter = "all"; // calendar year string from dueBy, e.g. "2026"
  let lastDepsPivotExport = null;
  let hawkeyeZoom = "month"; // "month" | "week" — Hawk-eye's horizontal timeline density toggle

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
    if (globalTeamFilter !== "all") {
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
        p.phase ? el("div", { class: "phase-fact-detail" }, [p.phase]) : null,
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
      counts[p.status] = (counts[p.status] || 0) + 1;
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

  function renderStageGridLegend() {
    const box = document.getElementById("stageGridLegend");
    if (!box) return;
    box.innerHTML = "";
    [
      { cls: "is-done", label: "Done — on time" },
      { cls: "is-done is-was-breach", label: "Done — blew its SLA" },
      { cls: "is-current", label: "Current stage — on track" },
      { cls: "is-current is-warn", label: "Current stage — approaching SLA" },
      { cls: "is-current is-breach", label: "Current stage — over SLA" },
      { cls: "is-none", label: "Not reached yet" },
    ].forEach((it) => {
      box.appendChild(
        el("span", { class: "stage-grid-legend-item" }, [
          el("span", { class: "stage-grid-swatch " + it.cls }),
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

    let breachCount = 0;
    let hypercareCount = 0;
    let cumulativeSlaOverage = 0;

    projects.forEach((p) => {
      cumulativeSlaOverage += cumulativeStageOverageDays(p);
      const info = currentStageInfo(p);
      if (info && info.flag === "breach") breachCount += 1;
      if ((p.stage || "") === "Hypercare") hypercareCount += 1;
    });

    const metrics = [
      { label: "Active Projects", num: projects.length, sub: `across ${pmCount} PM${pmCount === 1 ? "" : "s"}`, tone: "" },
      { label: "Stages Over SLA", num: breachCount, sub: breachCount ? "need escalation" : "none right now", tone: breachCount ? "tone-red" : "tone-green" },
      { label: "Cumulative SLA Overage", num: cumulativeSlaOverage + "d", sub: "summed across every stage", tone: cumulativeSlaOverage ? "tone-amber" : "tone-green" },
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

  // Donut breakdown of the "Cumulative SLA Overage" KPI above — same
  // per-project total (cumulativeStageOverageDays), just showing WHICH
  // projects are contributing to it instead of one summed number. Reuses
  // buildDonutChart() (defined below, near the stage detail modal's own
  // Delay Analysis donuts) so both views render identically. Clicking a
  // legend row jumps straight to that project's Stage-gate timeline —
  // same click-through the Hawk-eye rows and cumulative-delay card badges
  // already use.
  function renderCumulativeDelayChart() {
    const box = document.getElementById("cumulativeDelayChart");
    if (!box) return;
    box.innerHTML = "";

    const projects = visibleProjects();
    const groups = projects
      .map((p) => ({ label: p.name, days: cumulativeStageOverageDays(p), id: p.id }))
      .filter((g) => g.days > 0)
      .sort((a, b) => b.days - a.days);

    if (!groups.length) {
      box.appendChild(
        el("div", { class: "cumdelay-card cumdelay-empty" }, [
          "No cumulative SLA overage right now across the filtered projects. 🎉",
        ])
      );
      return;
    }

    box.appendChild(
      el("div", { class: "cumdelay-card" }, [
        el("div", { class: "cumdelay-head" }, [
          el("span", { class: "kicker" }, ["Cumulative Delay by Project"]),
          el("span", { class: "cumdelay-sub" }, [
            "Same total as \u201cCumulative SLA Overage\u201d above, broken down by who's contributing to it. Click a project to jump to its Stage-gate timeline.",
          ]),
        ]),
        el("div", { class: "cumdelay-body" }, [
          buildDonutChart(groups, { size: 180, strokeWidth: 26 }),
          el(
            "div",
            { class: "cumdelay-legend" },
            groups.map((g, i) =>
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
                  el("span", { class: "stagedetail-bar-dot", style: `background:${BREAKDOWN_COLORS[i % BREAKDOWN_COLORS.length]}` }),
                  el("span", { class: "stagedetail-bar-label" }, [g.label]),
                  el("span", { class: "stagedetail-bar-days" }, [g.days + "d"]),
                ]
              )
            )
          ),
        ]),
      ])
    );

    box.querySelectorAll(".cumdelay-legend-row").forEach((row) => {
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

  // Portfolio-wide matrix: every visible project as a row, every pipeline
  // stage as a column. Reuses the same stage-segment reconstruction and SLA
  // logic as the per-project "Stage-gate timeline" (see computeStageSegments
  // / stageSlaDays / stageFlagLevel above) so the two views never disagree.
  // Each cell carries the actual date range it covered plus whether that
  // stage blew its SLA (not just the current one) — the fuller "stage-gate"
  // picture, not just a status dot.
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
      const sla = stageSlaDays(stage);
      headerRow.appendChild(
        el("div", { class: "stage-grid-cell stage-grid-col-head", title: stage }, [
          STAGE_GRID_SHORT[stage] || stage,
          sla != null ? el("span", { class: "stage-grid-col-sla" }, ["SLA " + sla + "d"]) : null,
        ])
      );
    });
    grid.appendChild(headerRow);

    projects.forEach((p) => {
      const segByStage = {};
      computeStageSegments(p).forEach((seg) => {
        segByStage[seg.stage] = seg;
      });
      const currentIndex = PIPELINE_STAGES.indexOf(p.stage || "Unstaged");

      const row = el("div", { class: "stage-grid-row" });

      const nameCell = el(
        "div",
        { class: "stage-grid-name-cell stage-grid-cell", "data-project-id": p.id, tabindex: "0", role: "button" },
        [
          el("span", { class: "timeline-dot", style: `background:var(--${p.status === "amber" ? "amber" : p.status})` }),
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
          // Already passed through this stage — show how long it took, the
          // actual date range, and (the part the old version was missing)
          // whether THIS stage blew its own SLA back when it was current,
          // regardless of how the project is doing today.
          const seg = segByStage[stage];
          const sla = stageSlaDays(stage);
          const over = seg && sla != null ? seg.days - sla : null;
          const wasBreach = over != null && over > 0;
          cell = el(
            "div",
            {
              class: "stage-grid-cell stage-grid-status-cell is-done is-clickable" + (wasBreach ? " is-was-breach" : ""),
              "data-project-id": p.id,
              "data-stage": stage,
              tabindex: "0",
              role: "button",
              title: seg
                ? `${stage}: ${seg.approxStart ? "≥" : ""}${seg.days}d (${fmtDateShort(seg.start)} \u2192 ${fmtDateShort(seg.end)})` +
                  (sla != null ? ` — SLA ${sla}d${wasBreach ? `, ${over}d over` : ""}` : "") +
                  " — click for full detail"
                : `${stage}: done — click for full detail`,
            },
            [
              el("span", { class: "stage-grid-days" }, [
                "✓ " + (seg ? (seg.approxStart ? "≥" : "") + seg.days + "d" : "Done"),
              ]),
              seg
                ? el("span", { class: "stage-grid-daterange" + (wasBreach ? " is-was-breach" : "") }, [
                    wasBreach
                      ? `+${over}d over SLA`
                      : `${fmtDateShort(seg.start)} → ${fmtDateShort(seg.end)}`,
                  ])
                : null,
            ]
          );
        } else {
          const seg = segByStage[stage];
          const sla = stageSlaDays(stage);
          const flag = seg ? stageFlagLevel(seg.days, sla) : null;
          const flagClass = flag && flag !== "ok" ? " is-" + flag : "";
          const days = seg ? seg.days : null;
          const over = days != null && sla != null ? days - sla : null;
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
                  ? `${stage}: ${seg.approxStart ? "≥" : ""}${days}d so far (since ${fmtDateShort(seg.start)})` +
                    (sla != null ? ` — SLA ${sla}d${over > 0 ? `, ${over}d over` : ""}` : "")
                  : `${stage}: in progress`) + " — click for full detail",
            },
            [
              el("span", { class: "stage-grid-days" }, [
                days != null ? (seg.approxStart ? "≥" : "") + days + "d" : "In progress",
              ]),
              sla != null
                ? el("span", { class: "stage-grid-sla" }, [
                    "SLA " + sla + "d" + (over > 0 ? ` · +${over}d over` : ""),
                  ])
                : seg
                ? el("span", { class: "stage-grid-daterange" }, ["since " + fmtDateShort(seg.start)])
                : null,
            ]
          );
        }
        row.appendChild(cell);
      });

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
    const projects = visibleProjects().filter((p) => activeFilter === "all" || p.status === activeFilter);

    if (!projects.length) {
      box.appendChild(el("div", { class: "empty-note" }, ["No projects match this filter."]));
      return;
    }

    const recentChanges = mostRecentChangeByProject();

    projects.forEach((p) => {
      const isLate = p.delayDays > 0;
      const notes = openNotesFor(p.id);

      const card = el("div", { class: "card status-" + p.status, "data-project-id": p.id, tabindex: "0", role: "button" }, [
        el("div", { class: "card-head" }, [
          el("h3", null, [p.name]),
          el("span", { class: "pill pill-" + p.status }, [STATUS_LABEL[p.status]]),
        ]),
        el("div", { class: "card-owner" }, [p.owner ? "PM: " + p.owner : "PM: unassigned"]),
        cardRecentChangeNode(recentChanges[p.id]),
        el("div", { class: "progress-row" }, [
          el("div", { class: "progress-track" }, [
            el("div", { class: "progress-fill status-" + p.status, style: "width:" + p.progress + "%" }),
          ]),
          el("div", { class: "progress-pct" }, [p.progress + "%"]),
        ]),
        el("dl", { class: "card-facts" }, [
          ...currentStageFactNodes(p),
          el("dt", null, ["Next milestone"]),
          el("dd", null, [(p.nextMilestone && p.nextMilestone.name || "—") + (p.nextMilestone && p.nextMilestone.date ? " · " + fmtDateShort(p.nextMilestone.date) : "")]),
          el("dt", null, ["Go-live"]),
          el("dd", null, [fmtDate(p.goLive)]),
          el("dt", null, ["Delay"]),
          el("dd", { class: "delay-flag " + (isLate ? "is-late" : "is-ontime") }, [
            isLate ? "+" + p.delayDays + " days" : "On schedule",
          ]),
          ...((p.timeSavedDays || 0) > 0
            ? [
                el("dt", null, ["Time saved"]),
                el("dd", { class: "delay-flag is-saved" }, ["-" + p.timeSavedDays + " days"]),
              ]
            : []),
        ]),
        el("div", { class: "card-badges" }, [
          el("span", { class: "badge is-jump-link", "data-focus-section": "detail-deps-section" }, [
            countOpenDependencies(p) + " dependencies",
          ]),
          el(
            "span",
            { class: "badge is-jump-link" + (countOpenRisks(p) ? " has-risk" : ""), "data-focus-section": "detail-risks-section" },
            [countOpenRisks(p) + " risks"]
          ),
          el(
            "span",
            { class: "badge" + (notes.length ? " has-followup is-jump-link" : ""), "data-focus-section": notes.length ? "detail-followups-section" : "" },
            [notes.length + " follow-ups"]
          ),
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

  // Total days a project has spent over-SLA, summed across every stage
  // segment it's been through (including its current one) — the
  // per-project version of the Grid tab's portfolio-wide "Cumulative SLA
  // Overage" KPI.
  function cumulativeStageOverageDays(p) {
    return computeStageSegments(p).reduce((sum, seg) => {
      const sla = stageSlaDays(seg.stage);
      return sum + (sla != null ? Math.max(0, seg.days - sla) : 0);
    }, 0);
  }

  // Builds the full sequence of stage blocks for one project's Hawk-eye
  // row: real start/end dates for stages already passed through (from the
  // same history reconstruction as the Grid tab / the per-project
  // Stage-gate timeline), the current stage sized to at least its SLA (so
  // it reads as "expected to land around here" even mid-stage), then every
  // remaining stage chained forward using its SLA as a planned-only
  // placeholder width. Returns [] for a project with no recognized stage
  // (e.g. "Unstaged") — nothing real to plot yet.
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
        const sla = stageSlaDays(stage);
        blocks.push({
          stage,
          start: seg.start,
          end: seg.end,
          kind: "done",
          overDays: sla != null ? Math.max(0, seg.days - sla) : 0,
        });
      } else if (i === currentIndex) {
        const seg = segByStage[stage] || { start: today, days: 0 };
        const sla = stageSlaDays(stage);
        const plannedEnd = sla != null ? addDaysIso(seg.start, sla) : null;
        const end = plannedEnd && plannedEnd > today ? plannedEnd : today;
        blocks.push({
          stage,
          start: seg.start,
          end,
          kind: "current",
          flag: stageFlagLevel(seg.days, sla),
          overDays: sla != null ? Math.max(0, seg.days - sla) : 0,
        });
      } else {
        // Potential target for a not-yet-reached stage: prefer a REAL
        // recorded stagePlan date for that stage when one's already on
        // record (decks sometimes have forward-looking planned dates for
        // stages the project hasn't reached yet), falling back to a blind
        // SLA-chain estimate (start right after the previous block ends,
        // run for that stage's configured SLA) only when nothing better
        // is known. `planned: true` marks the former so callers can show
        // "planned target" vs. "potential target (estimated)".
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
          const sla = stageSlaDays(stage) || DEFAULT_FUTURE_STAGE_DAYS;
          start = prev ? prev.end : today;
          end = addDaysIso(start, sla);
          planned = false;
        }
        blocks.push({ stage, start, end, kind: "future", planned });
      }
    });
    return blocks;
  }

  // Single-project version of the Hawk-eye visual timeline, embedded in
  // the project detail view's Stage-gate tab (2026-09-30, replacing a
  // flat list of rows) — same visual language as the cross-project
  // Hawk-eye tab (blocks on a real date axis, dashed for not-yet-reached
  // stages, a "Today" line, click-through to stage detail), but with two
  // things Hawk-eye can't afford once it's showing every project at once:
  //  1. Every future stage is positioned by its own real planned/potential
  //     date instead of being squeezed into a fixed-size chip strip —
  //     there's only one row here, so there's room to actually plot it.
  //  2. Every block's real date range (and day-count/SLA) is written out
  //     directly underneath it, not just on hover — "easy to see" was the
  //     whole point of rebuilding this.
  function buildStageGateTimeline(p) {
    const DAY = 86400000;
    const blocks = buildHawkeyeBlocks(p);
    if (!blocks.length) {
      return el("p", { class: "empty-note" }, ["No pipeline stage data to plot yet."]);
    }

    // Done/current day-counts and "since before tracking"/"→ now" wording
    // come from the same `computeStageSegments()` the old flat list used
    // (accurate real elapsed days) — `buildHawkeyeBlocks()`'s own `end`
    // for the current stage is deliberately padded out to at least that
    // stage's SLA for VISUAL sizing (so it reads as "expected to land
    // around here" even mid-stage), which would overstate real elapsed
    // time if used for the day-count text too.
    const segByStage = {};
    computeStageSegments(p).forEach((seg) => {
      segByStage[seg.stage] = seg;
    });

    const todayIso = todayISO();
    const times = [];
    blocks.forEach((b) => {
      times.push(new Date(b.start + "T00:00:00").getTime());
      times.push(new Date(b.end + "T00:00:00").getTime());
    });
    times.push(new Date(todayIso + "T00:00:00").getTime());
    const minTime = Math.min(...times) - 4 * DAY;
    let maxTime = Math.max(...times) + 4 * DAY;
    if (maxTime - minTime < 20 * DAY) maxTime = minTime + 20 * DAY;

    const PX_PER_DAY = 6;
    const MIN_BLOCK_PX = 10;
    const xPx = (iso) => ((new Date(iso + "T00:00:00").getTime() - minTime) / DAY) * PX_PER_DAY;

    // Quarter gridlines — same snap logic as Hawk-eye's month view.
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

    // Build each block's caption text up front so its real pixel width
    // can be reserved during layout — this is what keeps captions from
    // ever overlapping, instead of guessing with a fixed tier stagger.
    const CAPTION_GAP_PX = 14;
    const STAGE_CHAR_PX = 7.1; // --font-display, 11.5px, 700 weight
    const META_CHAR_PX = 6.3; // --font-mono, 10.5px
    function textWidthPx(text, perCharPx) {
      return text.length * perCharPx;
    }
    const captioned = blocks.map((b) => {
      const seg = segByStage[b.stage];
      const sla = stageSlaDays(b.stage);
      const dateLabel =
        b.kind === "future"
          ? (b.planned ? "Planned: " : "Potential (est.): ") + fmtDateShort(b.start) + " → " + fmtDateShort(b.end)
          : seg
          ? (seg.approxStart ? "since before tracking, " : "") +
            fmtDateShort(seg.start) +
            (seg.ongoing ? " → now" : " → " + fmtDateShort(seg.end))
          : fmtDateShort(b.start) + (b.kind === "current" ? " → now" : " → " + fmtDateShort(b.end));
      let metaText = "Not started";
      let metaBreach = false;
      if (b.kind !== "future" && seg) {
        const days = seg.days;
        metaText = (seg.approxStart ? "≥" : "") + days + "d" + (sla != null ? " / SLA " + sla + "d" : "");
        metaBreach = sla != null && days > sla;
      }
      const capWidth = Math.max(
        textWidthPx(b.stage, STAGE_CHAR_PX),
        textWidthPx(dateLabel, META_CHAR_PX),
        textWidthPx(metaText, META_CHAR_PX)
      );
      return { b, dateLabel, metaText, metaBreach, capWidth };
    });

    // Sequential collision-avoiding layout — same idea as Hawk-eye's
    // `cursorPx`, but every stage (including future ones) gets placed by
    // its own real date here, and each slot reserves whichever is wider:
    // the block itself, or the caption text that goes directly beneath
    // it. That guarantees captions never overlap without needing a
    // staggered tier (which breaks down once several short, back-to-back
    // future stages are involved) — the tradeoff is that two
    // calendar-adjacent stages with long captions get visually spread a
    // little further apart than their raw dates alone would place them.
    let cursorPx = 0;
    const placed = captioned.map(({ b, dateLabel, metaText, metaBreach, capWidth }) => {
      const rawLeft = xPx(b.start);
      // Width comes from the stage's OWN real date span, measured before
      // any rightward shift — not from `end - left`. Using the shifted
      // `left` here was the bug: once a long caption pushed `left` far
      // enough right, `end - left` could go negative and collapse to
      // `MIN_BLOCK_PX`, turning every block into a same-size tiny dot and
      // destroying the one thing a timeline is supposed to show
      // (relative stage duration).
      const width = Math.max(xPx(b.end) - rawLeft, MIN_BLOCK_PX);
      const left = Math.max(rawLeft, cursorPx);
      cursorPx = left + Math.max(width, capWidth + CAPTION_GAP_PX);
      return { b, left, width, dateLabel, metaText, metaBreach };
    });
    const timelineWidthPx = Math.max(cursorPx, xPx(todayIso)) + 24;

    const wrap = el("div", { class: "stagegantt-scroll" });
    const inner = el("div", { class: "stagegantt-inner", style: `width:${timelineWidthPx}px` });

    const header = el("div", { class: "stagegantt-months" });
    marks.forEach((m) => {
      header.appendChild(el("div", { class: "stagegantt-month-mark", style: `left:${m.px}px` }, [m.label]));
    });
    inner.appendChild(header);

    const track = el("div", { class: "stagegantt-track" });
    marks.forEach((m) => {
      track.appendChild(el("div", { class: "stagegantt-grid-line", style: `left:${m.px}px` }));
    });
    track.appendChild(
      el("div", { class: "stagegantt-today-line", style: `left:${xPx(todayIso)}px` }, [
        el("span", { class: "stagegantt-today-label" }, ["Today"]),
      ])
    );

    placed.forEach(({ b, left, width, dateLabel, metaText, metaBreach }) => {
      const kindClass =
        b.kind === "done"
          ? "is-done"
          : b.kind === "current"
          ? "is-current" + (b.flag && b.flag !== "ok" ? " is-" + b.flag : "")
          : "is-future";
      const code = STAGE_SHORT_CODE[b.stage] || b.stage;

      track.appendChild(
        el(
          "div",
          {
            class: "stagegantt-block " + kindClass,
            style: `left:${left}px;width:${width}px`,
            "data-project-id": p.id,
            "data-stage": b.stage,
            tabindex: "0",
            role: "button",
            title: "Click for stage detail",
          },
          [width >= 32 ? code : ""]
        )
      );

      // Caption directly below the block, left-anchored to it — always
      // real dates, no hover required. The layout pass above already
      // reserved enough horizontal room for this exact text, so a single
      // tier is guaranteed not to collide with its neighbors.
      track.appendChild(
        el("div", { class: "stagegantt-caption", style: `left:${left}px` }, [
          el("span", { class: "stagegantt-caption-stage" }, [b.stage]),
          el("span", { class: "stagegantt-caption-date" }, [dateLabel]),
          el("span", { class: "stagegantt-caption-meta" + (metaBreach ? " is-breach" : "") }, [metaText]),
        ])
      );
    });

    inner.appendChild(track);
    wrap.appendChild(inner);

    wrap.querySelectorAll(".stagegantt-block").forEach((blockEl) => {
      const open = () => openStageDetail(blockEl.getAttribute("data-project-id"), blockEl.getAttribute("data-stage"));
      blockEl.addEventListener("click", open);
      blockEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          open();
        }
      });
    });

    // Default scroll position: land with "today" a little in from the
    // left edge, same reasoning as Hawk-eye's own default scroll.
    requestAnimationFrame(() => {
      wrap.scrollLeft = Math.max(0, xPx(todayIso) - 60);
    });

    return wrap;
  }

  // Fixed left column width for the project name/cumulative-delay label —
  // kept in one place since both the JS (row/header layout math) and the
  // CSS (.hawkeye-row-label's sticky positioning) need to agree on it.
  const HAWKEYE_LABEL_WIDTH = 220;

  // Two timeline densities. Month = the original "quarter gridlines"
  // zoom, now just wide enough to read easily rather than being forced to
  // fit a fixed board width. Week = a real zoom-in for anyone who wants
  // week-level precision, at the cost of more horizontal scrolling.
  const HAWKEYE_ZOOM = {
    month: { pxPerDay: 5, grid: "quarter" },
    week: { pxPerDay: 16, grid: "week" },
  };

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
    const rows = projects.map((p) => ({ p, blocks: buildHawkeyeBlocks(p) }));
    const withBlocks = rows.filter((r) => r.blocks.length);

    if (!withBlocks.length) {
      board.appendChild(el("p", { class: "empty-note" }, ["No pipeline stage data to plot yet."]));
      return;
    }

    // Only "done"/"current" blocks are date-accurate, so only they should
    // stretch the calendar range — future/not-started stages are rendered
    // as a compact fixed-size chip strip (see below), not plotted by date,
    // so including their chained placeholder end dates here would just
    // pointlessly widen the whole board.
    const allDates = [todayIso];
    withBlocks.forEach(({ blocks }) => {
      blocks.forEach((b) => {
        if (b.kind === "future") return;
        allDates.push(b.start);
        allDates.push(b.end);
      });
    });

    const times = allDates.map((d) => new Date(d + "T00:00:00").getTime());
    // No more clipping the left edge to force everything into a fixed
    // board width — that used to hide an outlier project's early stages
    // entirely (only a sliver of its bar rendered, tooltip or not, since
    // xPct clamped anything before the cutoff to 0%). The timeline is now
    // a horizontally SCROLLABLE track sized in real pixels, so every real
    // dated block gets genuine room — an outlier's early history is
    // reachable by scrolling left instead of being clamped away.
    const minTime = Math.min(...times) - 7 * DAY;
    let maxTime = Math.max(...times) + 7 * DAY;
    if (maxTime - minTime < 30 * DAY) maxTime = minTime + 30 * DAY;

    const zoom = HAWKEYE_ZOOM[hawkeyeZoom] || HAWKEYE_ZOOM.month;
    const pxPerDay = zoom.pxPerDay;
    const xPx = (iso) => ((new Date(iso + "T00:00:00").getTime() - minTime) / DAY) * pxPerDay;

    board.appendChild(
      el("div", { class: "hawkeye-toolbar" }, [
        el("div", { class: "hawkeye-legend" }, [
          el("span", { class: "hawkeye-legend-item" }, [el("span", { class: "hawkeye-legend-swatch is-done" }), "Done"]),
          el("span", { class: "hawkeye-legend-item" }, [
            el("span", { class: "hawkeye-legend-swatch is-current" }),
            "Current — on track",
          ]),
          el("span", { class: "hawkeye-legend-item" }, [el("span", { class: "hawkeye-legend-swatch is-warn" }), "At risk"]),
          el("span", { class: "hawkeye-legend-item" }, [
            el("span", { class: "hawkeye-legend-swatch is-breach" }),
            "Blocked / over SLA",
          ]),
          el("span", { class: "hawkeye-legend-item" }, [
            el("span", { class: "hawkeye-legend-swatch is-future" }),
            "Not started (planned)",
          ]),
        ]),
        el("div", { class: "hawkeye-zoom-toggle", role: "tablist", title: "Timeline zoom" }, [
          el(
            "button",
            {
              class: "hawkeye-zoom-btn" + (hawkeyeZoom === "month" ? " is-active" : ""),
              type: "button",
              "data-zoom": "month",
              role: "tab",
              "aria-selected": hawkeyeZoom === "month" ? "true" : "false",
            },
            ["Month"]
          ),
          el(
            "button",
            {
              class: "hawkeye-zoom-btn" + (hawkeyeZoom === "week" ? " is-active" : ""),
              type: "button",
              "data-zoom": "week",
              role: "tab",
              "aria-selected": hawkeyeZoom === "week" ? "true" : "false",
            },
            ["Week"]
          ),
        ]),
      ])
    );
    board.querySelectorAll(".hawkeye-zoom-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const z = btn.getAttribute("data-zoom");
        if (z === hawkeyeZoom) return;
        hawkeyeZoom = z;
        renderHawkeye();
      });
    });

    // Gridline marks: quarters in Month view, individual weeks (Monday
    // start) in Week view — the actual "break to a week view" zoom-in.
    const marks = [];
    if (zoom.grid === "week") {
      const cursor = new Date(minTime);
      cursor.setHours(0, 0, 0, 0);
      cursor.setDate(cursor.getDate() - ((cursor.getDay() + 6) % 7)); // snap to Monday on/before minTime
      while (cursor.getTime() <= maxTime) {
        if (cursor.getTime() >= minTime) {
          marks.push({
            px: ((cursor.getTime() - minTime) / DAY) * pxPerDay,
            label: cursor.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          });
        }
        cursor.setDate(cursor.getDate() + 7);
      }
    } else {
      const cursor = new Date(minTime);
      cursor.setDate(1);
      cursor.setHours(0, 0, 0, 0);
      cursor.setMonth(Math.floor(cursor.getMonth() / 3) * 3); // snap to quarter start
      while (cursor.getTime() <= maxTime) {
        if (cursor.getTime() >= minTime) {
          marks.push({
            px: ((cursor.getTime() - minTime) / DAY) * pxPerDay,
            label: `Q${Math.floor(cursor.getMonth() / 3) + 1} ${cursor.getFullYear()}`,
          });
        }
        cursor.setMonth(cursor.getMonth() + 3);
      }
    }

    // Monospace font at 10.5px — ~6.5px/char is a safe (slightly
    // generous) estimate; plus the block's own horizontal padding/border.
    // No more "measure a probe element's rendered width" trick — block
    // widths are computed directly in real pixels now (pxPerDay is fixed
    // per zoom level, not squeezed to fit a variable container width), so
    // there's nothing to measure; the number IS the pixel width.
    const CHAR_PX = 6.5;
    const BLOCK_CHROME_PX = 12;
    const fitsPx = (text) => text.length * CHAR_PX + BLOCK_CHROME_PX;
    const FUTURE_CHAR_PX = 6.2; // 10px mono font is still slightly narrower than the 10.5px dated-block font
    const FUTURE_CHIP_CHROME_PX = 18; // 7px+7px padding + ~4px border/rounding
    const FUTURE_CHIP_GAP_PX = 3;
    const MIN_BLOCK_PX = 4;

    // Pass 1: lay out every row's blocks in real pixels (independent of
    // final board width), while tracking the widest a row's content
    // actually needs to be (nominal date-range width, or further out if
    // some row's future-strip chips need more room past the last dated
    // block) — then EVERY row's track gets built at that same shared
    // width, so nothing is ever clipped/hidden and every row still lines
    // up under the same gridlines.
    let timelineWidthPx = ((maxTime - minTime) / DAY) * pxPerDay;

    const rowPlans = rows
      .slice()
      .sort((a, b) => {
        const ta = a.p.goLive ? new Date(a.p.goLive).getTime() : Infinity;
        const tb = b.p.goLive ? new Date(b.p.goLive).getTime() : Infinity;
        return ta - tb;
      })
      .map(({ p, blocks }) => {
        if (!blocks.length) return { p, empty: true };

        const datedBlocks = blocks.filter((b) => b.kind !== "future");
        const futureBlocks = blocks.filter((b) => b.kind === "future");

        // Sequential collision-avoiding layout — same reasoning as
        // before, just in px instead of %: `cursorPx` tracks where the
        // previous block visually ended so each subsequent block's left
        // is clamped forward if needed (dates stay accurate for blocks
        // with real room; only blocks that would've overlapped get
        // nudged).
        let cursorPx = 0;
        const placedDated = datedBlocks.map((b) => {
          const rawLeft = xPx(b.start);
          const left = Math.max(rawLeft, cursorPx);
          const width = Math.max(xPx(b.end) - left, MIN_BLOCK_PX);
          cursorPx = left + width;
          return { b, left, width };
        });

        let stripAnchorPx = null;
        let stripWidthPx = 0;
        if (futureBlocks.length) {
          // Anchor right after the last dated block ends (its clamped
          // visual position, not its raw date) — or at "today" if there
          // are no dated blocks at all yet.
          stripAnchorPx = datedBlocks.length ? cursorPx : xPx(todayIso);
          stripWidthPx =
            futureBlocks.reduce((sum, b) => {
              const code = STAGE_SHORT_CODE[b.stage] || b.stage;
              return sum + code.length * FUTURE_CHAR_PX + FUTURE_CHIP_CHROME_PX;
            }, 0) + FUTURE_CHIP_GAP_PX * Math.max(futureBlocks.length - 1, 0);
          timelineWidthPx = Math.max(timelineWidthPx, stripAnchorPx + stripWidthPx + 16);
        } else if (placedDated.length) {
          timelineWidthPx = Math.max(timelineWidthPx, cursorPx + 16);
        }

        return { p, placedDated, futureBlocks, stripAnchorPx };
      });

    // Pass 2: build the DOM at the final shared timelineWidthPx. Header +
    // gridlines + today-line live in a separate wide "scroll" wrapper
    // (not the toolbar above, which stays put) so the project-name label
    // column can stick to the left edge of THAT wrapper while its
    // timeline content scrolls underneath/beside it.
    const scrollInner = el("div", { class: "hawkeye-scroll-inner" });
    const fullWidthPx = HAWKEYE_LABEL_WIDTH + timelineWidthPx;

    const header = el("div", { class: "hawkeye-months", style: `width:${fullWidthPx}px` });
    marks.forEach((m) => {
      header.appendChild(
        el("div", { class: "hawkeye-month-mark", style: `left:${HAWKEYE_LABEL_WIDTH + m.px}px` }, [m.label])
      );
    });
    scrollInner.appendChild(header);

    const rowsWrap = el("div", { class: "hawkeye-rows", style: `width:${fullWidthPx}px` });
    marks.forEach((m) => {
      rowsWrap.appendChild(el("div", { class: "hawkeye-grid-line", style: `left:${HAWKEYE_LABEL_WIDTH + m.px}px` }));
    });
    rowsWrap.appendChild(
      el("div", { class: "hawkeye-today-line", style: `left:${HAWKEYE_LABEL_WIDTH + xPx(todayIso)}px` }, [
        el("span", { class: "hawkeye-today-label" }, ["Today"]),
      ])
    );

    rowPlans.forEach((plan) => {
      const { p } = plan;
      const cumulativeDelay = cumulativeStageOverageDays(p);
      const row = el("div", { class: "hawkeye-row", "data-project-id": p.id, tabindex: "0", role: "button" }, [
        el("div", { class: "hawkeye-row-label" }, [
          el("span", { class: "timeline-dot", style: `background:var(--${p.status})` }),
          el("div", null, [
            el("strong", null, [p.name]),
            el("div", { class: "hawkeye-row-sub" }, [
              cumulativeDelay > 0 ? `${cumulativeDelay}d cumulative delay` : "On pace — no SLA overage",
            ]),
          ]),
        ]),
      ]);

      if (plan.empty) {
        row.appendChild(
          el("div", { class: "hawkeye-row-track hawkeye-row-track-empty", style: `width:${timelineWidthPx}px` }, [
            "No pipeline stage set yet",
          ])
        );
        rowsWrap.appendChild(row);
        return;
      }

      const track = el("div", { class: "hawkeye-row-track", style: `width:${timelineWidthPx}px` });

      plan.placedDated.forEach(({ b, left, width }) => {
        const kindClass = b.kind === "done" ? "is-done" : "is-current" + (b.flag && b.flag !== "ok" ? " is-" + b.flag : "");
        const code = STAGE_SHORT_CODE[b.stage] || b.stage;
        // Only ever render text that's actually measured (in real px) to
        // fit, so it's never partial/illegible. Full "CODE +Xd" if it
        // fits, just "CODE" if that's all that fits, blank (color/border
        // + tooltip only) if not even that fits.
        const fullLabel = code + (b.overDays ? ` +${b.overDays}d` : "");
        const label = width >= fitsPx(fullLabel) ? fullLabel : width >= fitsPx(code) ? code : "";
        const title =
          `${p.name} — ${b.stage}: ${fmtDateShort(b.start)} → ${fmtDateShort(b.end)}` +
          (b.overDays ? ` (+${b.overDays}d over SLA)` : "");
        track.appendChild(
          el("div", { class: "hawkeye-stage-block " + kindClass, style: `left:${left}px;width:${width}px`, title }, [label])
        );
      });

      if (plan.futureBlocks.length) {
        const strip = el("div", { class: "hawkeye-future-strip", style: `left:${plan.stripAnchorPx}px` });
        plan.futureBlocks.forEach((b) => {
          const code = STAGE_SHORT_CODE[b.stage] || b.stage;
          const targetLabel = b.planned
            ? `planned target ${fmtDateShort(b.start)} → ${fmtDateShort(b.end)}`
            : `potential target ${fmtDateShort(b.start)} → ${fmtDateShort(b.end)} (estimated from SLA — not yet planned)`;
          strip.appendChild(
            el(
              "div",
              {
                class: "hawkeye-stage-block is-future",
                title: `${p.name} — ${b.stage}: ${targetLabel}`,
                "data-project-id": p.id,
                "data-stage": b.stage,
                tabindex: "0",
                role: "button",
              },
              [code]
            )
          );
        });
        track.appendChild(strip);
        // Clicking a specific future chip opens that stage's own detail
        // (with the potential-target date front and center) instead of
        // just the row's general project detail — one click straight to
        // "what's the target for this specific upcoming stage."
        strip.querySelectorAll(".hawkeye-stage-block").forEach((chip) => {
          chip.addEventListener("click", (e) => {
            e.stopPropagation();
            openStageDetail(chip.getAttribute("data-project-id"), chip.getAttribute("data-stage"));
          });
          chip.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              e.stopPropagation();
              openStageDetail(chip.getAttribute("data-project-id"), chip.getAttribute("data-stage"));
            }
          });
        });
      }

      row.appendChild(track);
      rowsWrap.appendChild(row);
    });

    scrollInner.appendChild(rowsWrap);
    board.appendChild(scrollInner);

    board.querySelectorAll(".hawkeye-row").forEach((row) => {
      row.addEventListener("click", () => openProjectDetail(row.getAttribute("data-project-id"), "stage-gate-timeline-section"));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openProjectDetail(row.getAttribute("data-project-id"), "stage-gate-timeline-section");
        }
      });
    });

    // Default scroll position: land with a sensible lead-in before
    // "today" (roughly what the old fixed span cap used to show by
    // default) rather than dumping the user at the very left edge — which
    // could now be months/years before anything relevant for an outlier
    // project — or the very right edge, which would hide "today" itself
    // off-screen on first load. Everything before/after is still just a
    // scroll away, never clipped out of existence.
    requestAnimationFrame(() => {
      const leadInDays = zoom.grid === "week" ? 21 : 90;
      const target = xPx(todayIso) - leadInDays * pxPerDay;
      scrollInner.scrollLeft = Math.max(0, target);
    });
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
    renderStatusHistory();
  }

  function updateGlobalFilterUI() {
    const bar = document.getElementById("globalFilterBar");
    const clearBtn = document.getElementById("globalFilterClear");
    const isActive = globalProjectFilter !== "all";
    clearBtn.hidden = !isActive;
    bar.classList.toggle(
      "is-active",
      isActive || activeOwner !== "all" || globalTeamFilter !== "all"
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
    return deps.map((dep) => {
      const mitigation = dep.mitigation || "";
      const actions = dep.id
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
      const li = el("li", { class: "paired-item is-clickable", tabindex: "0", role: "button" }, [
        el("div", { class: "paired-item-text" }, [
          dep.id ? el("span", { class: "dep-id-tag" }, [dep.id]) : null,
          dep.text,
          dep.escalated ? el("span", { class: "deps-badge deps-badge-escalated" }, ["🚨 Escalated"]) : null,
          // Some projects (e.g. SSO V2) fold two conceptually distinct
          // deck tables — with their own separate dependency/risk lists —
          // into one project record. `track` (only set where the source
          // deck actually had more than one such table) surfaces which
          // one this item came from instead of silently merging them.
          dep.track ? el("span", { class: "track-tag" }, [dep.track]) : null,
          el("span", { class: "team-tag" + (dep.team ? "" : " is-missing") }, [dep.team || "No team labeled"]),
        ].filter(Boolean)),
        el("div", { class: "paired-item-mitigation" + (mitigation ? "" : " is-missing") }, [
          el("span", { class: "mitigation-label" }, ["Mitigation / impact: "]),
          mitigation || "Not yet documented",
        ]),
        actions.length ? el("div", { class: "dep-actions-row" }, actions) : null,
      ].filter(Boolean));
      const open = () => openItemDetail("dependency", project, dep);
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
      const li = el("li", { class: "paired-item is-clickable", tabindex: "0", role: "button" }, [
        el("div", { class: "paired-item-text" }, [
          risk.id ? el("span", { class: "dep-id-tag" }, [risk.id]) : null,
          risk.text,
          risk.track ? el("span", { class: "track-tag" }, [risk.track]) : null,
        ].filter(Boolean)),
        el("div", { class: "paired-item-mitigation" + (mitigation ? "" : " is-missing") }, [
          el("span", { class: "mitigation-label" }, ["Mitigation plan: "]),
          mitigation || "Not yet documented",
        ]),
      ]);
      const open = () => openItemDetail("risk", project, risk);
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
          status: p.status,
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
  // active projects/teams from open deps; blocked stages = current stage over SLA
  // (same breach flag as Grid/Hawk-eye); cumulative delay = summed stage SLA
  // overage across filtered projects; rollout/hypercare = post-UAT pipeline stages.
  function renderDependenciesMetrics(rows) {
    const activeProjects = new Set(rows.map((r) => r.projectId)).size;
    const activeTeams = new Set(rows.map((r) => r.team || "Unlabeled")).size;

    const scopedProjects = projectsWithOpenDependencies();

    let blockedStages = 0;
    let cumulativeDelay = 0;
    let rolloutHypercare = 0;
    scopedProjects.forEach((p) => {
      cumulativeDelay += cumulativeStageOverageDays(p);
      const info = currentStageInfo(p);
      if (info && info.flag === "breach") blockedStages += 1;
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
        label: "Blocked Stages",
        num: blockedStages,
        sub: blockedStages ? "need escalation" : "none right now",
        tone: blockedStages ? "tone-red" : "tone-green",
      },
      {
        label: "Cumulative Delay",
        num: cumulativeDelay + "d",
        sub: "all stages",
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

  // Every week a project reported time pulled back IN (timeSavedDays > 0) —
  // tracked the same way delayDays/statusChangeReason are: a this-week's-news
  // value on the snapshot, not a diff, so it shows up once per week it's
  // reported (same treatment escalations get).
  function computeTimeSavedEvents() {
    const dates = Object.keys(HISTORY).sort();
    const nameById = {};
    DATA.projects.forEach((p) => (nameById[p.id] = p.name));
    const events = [];

    dates.forEach((asOf) => {
      (HISTORY[asOf].projects || []).forEach((snap) => {
        nameById[snap.id] = nameById[snap.id] || snap.name;
        const days = snap.timeSavedDays || 0;
        if (days > 0) {
          events.push({
            projectId: snap.id,
            projectName: nameById[snap.id] || snap.id,
            date: asOf,
            days,
            note: snap.timeSavedNote || [],
            status: snap.status,
          });
        }
      });
    });

    return events;
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
      return el("div", { class: "card-recent-change", title: "Most recent status/date change — see Status History tab or this project's detail view for the full log" }, [
        el("span", { class: "card-recent-change-date" }, [fmtDateShort(event.date)]),
        el("span", { class: "pill pill-" + event.from }, [STATUS_LABEL[event.from]]),
        el("span", { class: "card-recent-change-arrow" }, ["→"]),
        el("span", { class: "pill pill-" + event.to }, [STATUS_LABEL[event.to]]),
      ]);
    }
    const deltaDays = Math.round((new Date(event.to + "T00:00:00") - new Date(event.from + "T00:00:00")) / 86400000);
    return el("div", { class: "card-recent-change", title: "Most recent status/date change — see Status History tab or this project's detail view for the full log" }, [
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

  function renderStatusHistory() {
    const transitions = computeStatusTransitions().map((t) => Object.assign({ kind: "status" }, t));
    const shifts = computeScheduleShifts().map((s) => Object.assign({ kind: "schedule" }, s));
    const timeSaved = computeTimeSavedEvents().map((s) => Object.assign({ kind: "timesaved" }, s));
    const combined = transitions.concat(shifts, timeSaved).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    const list = document.getElementById("statusHistoryList");
    list.innerHTML = "";

    const ownerById = {};
    DATA.projects.forEach((p) => (ownerById[p.id] = p.owner || "Unassigned"));

    const filtered = combined.filter(
      (t) =>
        (globalProjectFilter === "all" || t.projectId === globalProjectFilter) &&
        (activeOwner === "all" || ownerById[t.projectId] === activeOwner)
    );

    if (!filtered.length) {
      list.appendChild(
        el("div", { class: "deps-empty-group" }, [
          combined.length
            ? "Nothing to show for this project/PM filter."
            : "No status changes or date shifts recorded yet — once weekly updates move a project's status, go-live, or milestone dates, they'll show up here with dates and the why.",
        ])
      );
      return;
    }

    filtered.forEach((t) => {
      if (t.kind === "schedule") {
        const deltaDays = Math.round((new Date(t.to + "T00:00:00") - new Date(t.from + "T00:00:00")) / 86400000);
        const row = el("div", { class: "status-history-row kind-schedule" }, [
          el("div", { class: "status-history-date" }, [fmtDate(t.date)]),
          el("div", { class: "status-history-main" }, [
            el("div", { class: "status-history-transition" }, [
              el("span", { class: "schedule-shift-badge" }, ["📅 " + t.label + " moved"]),
              el("span", { class: "golive-date-original" }, [fmtDateShort(t.from)]),
              el("span", { class: "status-history-arrow" }, ["→"]),
              el("span", { class: "golive-date-current" }, [fmtDate(t.to)]),
              el(
                "span",
                { class: "schedule-timeline-delta " + (deltaDays > 0 ? "is-late" : deltaDays < 0 ? "is-early" : "") },
                [deltaDays === 0 ? "No change in days" : (deltaDays > 0 ? "+" : "") + deltaDays + " days"]
              ),
              el("button", { class: "status-history-project", "data-project-id": t.projectId }, [t.projectName]),
            ]),
          ]),
        ]);
        list.appendChild(row);
        return;
      }

      if (t.kind === "timesaved") {
        const row = el("div", { class: "status-history-row kind-timesaved" }, [
          el("div", { class: "status-history-date" }, [fmtDate(t.date)]),
          el("div", { class: "status-history-main" }, [
            el("div", { class: "status-history-transition" }, [
              el("span", { class: "schedule-shift-badge is-saved" }, ["⏱ Time saved"]),
              el("span", { class: "schedule-timeline-delta is-early" }, ["-" + t.days + " days"]),
              el("button", { class: "status-history-project", "data-project-id": t.projectId }, [t.projectName]),
            ]),
            t.note && t.note.length
              ? el("div", { class: "status-history-context" }, [t.note.join(" · ")])
              : null,
          ]),
        ]);
        list.appendChild(row);
        return;
      }

      const worsened = STATUS_RANK[t.to] > STATUS_RANK[t.from];
      const missingReason = worsened && !t.statusChangeReason;
      const row = el("div", { class: "status-history-row" + (worsened ? " is-worse" : " is-better") }, [
        el("div", { class: "status-history-date" }, [fmtDate(t.date)]),
        el("div", { class: "status-history-main" }, [
          el("div", { class: "status-history-transition" }, [
            el("span", { class: "pill pill-" + t.from }, [STATUS_LABEL[t.from]]),
            el("span", { class: "status-history-arrow" }, ["→"]),
            el("span", { class: "pill pill-" + t.to }, [STATUS_LABEL[t.to]]),
            el("button", { class: "status-history-project", "data-project-id": t.projectId }, [t.projectName]),
          ]),
        ]),
      ]);

      const main = row.querySelector(".status-history-main");

      // Project tracking at the time of this change: stage + progress
      const trackingBits = [];
      if (t.stage) trackingBits.push(t.stage);
      if (t.progress !== null) trackingBits.push(t.progress + "% complete");
      if (trackingBits.length) {
        main.appendChild(
          el("div", { class: "status-history-tracking" }, [
            el("span", { class: "status-history-tracking-label" }, ["Tracking at the time:"]),
            " " + trackingBits.join(" · "),
          ])
        );
      }

      const contextBits = [];
      if (t.delayDays > 0) contextBits.push(`${t.delayDays} day${t.delayDays === 1 ? "" : "s"} delayed`);
      if (t.delayNote) contextBits.push(t.delayNote);
      else if (t.phase) contextBits.push(t.phase);
      if (contextBits.length) {
        main.appendChild(el("div", { class: "status-history-context" }, [contextBits.join(" — ")]));
      }

      if (t.statusChangeReason) {
        main.appendChild(
          el("div", { class: "status-history-reason" }, [
            el("span", { class: "status-history-reason-label" }, ["Reason for change:"]),
            " " + t.statusChangeReason,
          ])
        );
      } else if (missingReason) {
        main.appendChild(
          el("div", { class: "status-history-reason status-history-reason-missing" }, [
            "⚠️ No reason was provided for this status change — please add one on the next weekly update.",
          ])
        );
      }

      list.appendChild(row);
    });

    list.querySelectorAll(".status-history-project").forEach((btn) => {
      btn.addEventListener("click", () => openProjectDetail(btn.getAttribute("data-project-id")));
    });
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
        rows.push({ projectId: p.id, projectName: p.name, owner: p.owner || "Unassigned", status: p.status, text });
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
        return snap ? { asOf, ...snap } : null;
      })
      .filter(Boolean);
  }

  /* ---------------- Stage-gate timeline + SLA ---------------- */

  // Fallback SLAs (business days aren't tracked here, just calendar days —
  // close enough for a weekly cadence). data.json's top-level `stageSlaDays`
  // always wins if present, so these can be tuned without touching code.
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

  // "ok" | "warn" (>=80% of SLA) | "breach" (over SLA) | null (no SLA tracked
  // for this stage, e.g. "Unstaged").
  function stageFlagLevel(days, sla) {
    if (sla == null) return null;
    if (days > sla) return "breach";
    if (days >= sla * 0.8) return "warn";
    return "ok";
  }

  // Reconstructs how long a project has spent in each pipeline stage, using
  // the weekly history snapshots (only granularity we have — this isn't
  // exact to the day, but good enough for a weekly leadership review).
  // Returns an ordered list of segments: { stage, start, end, ongoing,
  // approxStart }. `approxStart` marks the very first segment, since we
  // don't know how long the project was in that stage before tracking began.
  function computeStageSegments(p) {
    const today = todayISO();
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

  function currentStageInfo(p) {
    const segments = computeStageSegments(p);
    const seg = segments[segments.length - 1];
    if (!seg) return null;
    const sla = stageSlaDays(seg.stage);
    return { ...seg, sla, flag: stageFlagLevel(seg.days, sla) };
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
    return buildScheduleTimeline(historyForProject(p.id))
      .filter((e) => e.kind !== "timesaved" && e.stage === stage)
      .map((e) => Object.assign({ deltaDays: daysBetweenIso(e.from, e.to) }, e))
      .filter((e) => e.deltaDays > 0);
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

  function buildTrendGraph(weeks) {
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
      `<text x="${p.x}" y="${height - 8}" text-anchor="middle" class="graph-axis-label">${fmtDateShort(p.w.asOf)}</text>`
    ).join("");

    const latestColor = STATUS_COLOR[weeks[weeks.length - 1].status] || "var(--accent)";

    const dots = points.map((p) => {
      // Flip the label below the dot when it's too close to the top edge
      // (and thus the "100" axis label) to avoid the two overlapping.
      const tooHigh = p.y - 12 < padT + 10;
      const labelY = tooHigh ? p.y + 18 : p.y - 12;
      return `<circle cx="${p.x}" cy="${p.y}" r="4.5" fill="${STATUS_COLOR[p.w.status] || latestColor}" stroke="#fff" stroke-width="2" />` +
        `<text x="${p.x}" y="${labelY}" text-anchor="middle" class="graph-point-label">${p.w.progress}%</text>`;
    }).join("");

    const svg = `
      <svg viewBox="0 0 ${width} ${height}" class="trend-graph" preserveAspectRatio="none">
        <defs>
          <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="${latestColor}" stop-opacity="0.16" />
            <stop offset="100%" stop-color="${latestColor}" stop-opacity="0" />
          </linearGradient>
        </defs>
        ${gridLines}
        <path d="${areaD}" fill="url(#trendFill)" stroke="none" />
        <path d="${lineD}" fill="none" stroke="${latestColor}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" />
        ${dots}
        ${xLabels}
      </svg>`;

    return el("div", { class: "trend-graph-wrap", html: svg });
  }

  function buildScheduleTimeline(weeks) {
    const events = [];
    let prevGoLive = null;
    let prevMilestoneName = null;
    let prevMilestoneDate = null;

    weeks.forEach((w) => {
      const goLive = w.goLive || null;
      const milestoneName = (w.nextMilestone && w.nextMilestone.name) || null;
      const milestoneDate = (w.nextMilestone && w.nextMilestone.date) || null;

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
        events.push({
          date: w.asOf,
          label: milestoneName || prevMilestoneName || "Milestone",
          from: prevMilestoneDate,
          to: milestoneDate,
          stage: w.stage || null,
        });
      }

      if (goLive) prevGoLive = goLive;
      if (milestoneDate) {
        prevMilestoneDate = milestoneDate;
        prevMilestoneName = milestoneName;
      }

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

    return events.reverse(); // newest first
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

      const deltaDays = Math.round(
        (new Date(e.to + "T00:00:00") - new Date(e.from + "T00:00:00")) / 86400000
      );
      box.appendChild(
        el("div", { class: "schedule-timeline-row" }, [
          el("div", { class: "schedule-timeline-date" }, [fmtDate(e.date)]),
          el("div", { class: "schedule-timeline-main" }, [
            el("span", { class: "schedule-timeline-label" }, [e.label]),
            el("span", { class: "golive-date-original" }, [fmtDateShort(e.from)]),
            el("span", { class: "golive-arrow" }, ["→"]),
            el("span", { class: "golive-date-current" }, [fmtDate(e.to)]),
            el("span", { class: "schedule-timeline-delta " + (deltaDays > 0 ? "is-late" : deltaDays < 0 ? "is-early" : "") }, [
              deltaDays === 0 ? "No change in days" : (deltaDays > 0 ? "+" : "") + deltaDays + " days",
            ]),
          ]),
        ])
      );
    });
    return box;
  }

  // The Date change log used to always render fully expanded — with
  // several projects racking up 5+ entries, it was one of the bigger
  // single contributors to the project detail view feeling too
  // long/dense. Collapsed by default; clicking the header expands it in
  // place. The entry count stays visible either way, so "is there
  // anything here worth opening" doesn't require opening it.
  function buildCollapsibleChangelog(events) {
    const wrap = el("div", { class: "schedule-changelog-wrap is-collapsed" });
    const toggle = el(
      "button",
      { class: "schedule-changelog-toggle", type: "button", "aria-expanded": "false" },
      [
        el("span", { class: "schedule-changelog-chevron" }, ["▸"]),
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
      activateDetailTab(detailRoot, DETAIL_SECTION_TAB_MAP[focusSectionId] || "stagegate");
      requestAnimationFrame(() => {
        const target = document.getElementById(focusSectionId);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } else {
      overlay.scrollTop = 0;
    }
  }

  function closeProjectDetail() {
    document.getElementById("projectDetail").hidden = true;
    document.body.classList.remove("no-scroll");
  }

  function buildProjectDetail(p) {
    const isLate = p.delayDays > 0;
    const openFollowUps = openNotesFor(p.id);
    const allNotes = NOTES.filter((n) => n.projectId === p.id);
    const weeks = historyForProject(p.id);

    const root = el("div", { class: "detail-root" });

    // Header
    root.appendChild(
      el("div", { class: "detail-head" }, [
        el("div", null, [
          el("span", { class: "pill pill-" + p.status }, [STATUS_LABEL[p.status]]),
          el("h1", null, [p.name]),
          el("div", { class: "card-owner" }, [p.owner ? "PM: " + p.owner : "PM: unassigned"]),
        ]),
        el("div", { class: "detail-action-row" }, [
          el("a", {
            class: "btn-primary btn-small",
            target: "_blank",
            rel: "noopener",
            href: issueUrl("weekly-update.yml", { project: p.name, as_of: todayISO(), owner: p.owner || "" }),
          }, ["Submit weekly update ↗"]),
          el("a", {
            class: "btn-ghost btn-small",
            target: "_blank",
            rel: "noopener",
            href: issueUrl("meeting-feedback.yml", { project: p.name }),
          }, ["Add feedback ↗"]),
        ]),
      ])
    );

    root.appendChild(
      el("div", { class: "progress-row detail-progress" }, [
        el("div", { class: "progress-track" }, [
          el("div", { class: "progress-fill status-" + p.status, style: "width:" + p.progress + "%" }),
        ]),
        el("div", { class: "progress-pct" }, [p.progress + "%"]),
      ])
    );

    root.appendChild(
      el("dl", { class: "card-facts detail-facts" }, [
        ...currentStageFactNodes(p),
        el("dt", null, ["Next milestone"]),
        el("dd", null, [(p.nextMilestone && p.nextMilestone.name || "—") + (p.nextMilestone && p.nextMilestone.date ? " · " + fmtDateShort(p.nextMilestone.date) : "")]),
        el("dt", null, ["Go-live"]),
        el("dd", null, [
          p.originalGoLive && p.originalGoLive !== p.goLive
            ? `${fmtDate(p.originalGoLive)} → ${fmtDate(p.goLive)}`
            : fmtDate(p.goLive),
        ]),
        el("dt", null, ["Delay"]),
        el("dd", { class: "delay-flag " + (isLate ? "is-late" : "is-ontime") }, [
          isLate ? "+" + p.delayDays + " days" : "On schedule",
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
      ])
    );

    // Detail-view tabs — everything below the header/progress/facts used to
    // be one long flat stack of `<h3>` sections (Stage-gate timeline, Delay
    // recovery, Follow-ups, Schedule, Dependencies/Risks/Escalations, Week
    // -over-week, Feedback history), which meant scrolling past everything
    // you didn't care about to find the one thing you clicked for. Tabbed
    // instead: each button shows/hides its own panel via `.is-active`, and
    // jump-links (the card badges, `openProjectDetail`'s `focusSectionId`)
    // now switch to the right tab first, then scroll to the anchor inside
    // it — see `DETAIL_SECTION_TAB_MAP` / `activateDetailTab` below.
    // Order here is purely display order in the tab strip (and which one
    // defaults to active, below) — doesn't affect anything functional, so
    // it's just this one array to reorder. First entry is the default-open
    // tab (2026-09-30: Schedule, since that's what a user wanted to land
    // on first).
    const DETAIL_TABS = [
      { id: "schedule", label: "Schedule" },
      { id: "weekoverweek", label: "Week-over-week" },
      { id: "stagegate", label: "Stage-gate" },
      { id: "depsrisks", label: "Dependencies & Risks" },
      { id: "followups", label: "Follow-ups" },
      { id: "feedback", label: "Feedback" },
    ];
    const tabStrip = el(
      "div",
      { class: "detail-tabs", role: "tablist" },
      DETAIL_TABS.map((t, i) =>
        el(
          "button",
          {
            class: "detail-tab-btn" + (i === 0 ? " is-active" : ""),
            "data-tab": t.id,
            role: "tab",
            type: "button",
          },
          [t.label]
        )
      )
    );
    root.appendChild(tabStrip);

    // Panels are created independent of display order, then appended in
    // whatever order `DETAIL_TABS` says — only the first one in that order
    // starts active, no matter which variable it happens to be.
    const stagegatePanel = el("div", { class: "detail-tab-panel", "data-tab": "stagegate" });
    const depsRisksPanel = el("div", { class: "detail-tab-panel", "data-tab": "depsrisks" });
    const weekOverWeekPanel = el("div", { class: "detail-tab-panel", "data-tab": "weekoverweek" });
    const followupsPanel = el("div", { class: "detail-tab-panel", "data-tab": "followups" });
    const schedulePanel = el("div", { class: "detail-tab-panel", "data-tab": "schedule" });
    const feedbackPanel = el("div", { class: "detail-tab-panel", "data-tab": "feedback" });
    const PANELS_BY_TAB = {
      stagegate: stagegatePanel,
      depsrisks: depsRisksPanel,
      weekoverweek: weekOverWeekPanel,
      followups: followupsPanel,
      schedule: schedulePanel,
      feedback: feedbackPanel,
    };
    DETAIL_TABS.forEach((t, i) => {
      const panel = PANELS_BY_TAB[t.id];
      if (i === 0) panel.classList.add("is-active");
      root.appendChild(panel);
    });

    tabStrip.querySelectorAll(".detail-tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        activateDetailTab(root, btn.getAttribute("data-tab"));
        const overlay = document.getElementById("projectDetail");
        if (overlay) overlay.scrollTop = 0;
      });
    });

    // Stage-gate timeline — same visual language as the cross-project
    // Hawk-eye tab (real date axis, blocks colored by status, dashed for
    // not-yet-reached stages, a "Today" line), rebuilt from the old flat
    // list of rows (2026-09-30) per explicit request — see
    // `buildStageGateTimeline()` for the full reasoning. Real stagePlan
    // dates win over a blind SLA-chain estimate for future stages when on
    // record, same source (`buildHawkeyeBlocks`) Hawk-eye itself uses, so
    // a clicked-through "potential target" here always matches what's
    // shown there.
    stagegatePanel.appendChild(el("h3", { class: "weekly-subhead" }, ["Stage-gate timeline"]));
    stagegatePanel.appendChild(
      el("div", { class: "stagegantt-legend" }, [
        el("span", { class: "stagegantt-legend-item" }, [el("span", { class: "stagegantt-legend-swatch is-done" }), "Done"]),
        el("span", { class: "stagegantt-legend-item" }, [el("span", { class: "stagegantt-legend-swatch is-current" }), "Current — on track"]),
        el("span", { class: "stagegantt-legend-item" }, [el("span", { class: "stagegantt-legend-swatch is-warn" }), "At risk"]),
        el("span", { class: "stagegantt-legend-item" }, [el("span", { class: "stagegantt-legend-swatch is-breach" }), "Blocked / over SLA"]),
        el("span", { class: "stagegantt-legend-item" }, [el("span", { class: "stagegantt-legend-swatch is-future" }), "Not started (planned)"]),
      ])
    );
    stagegatePanel.appendChild(
      el("div", { id: "stage-gate-timeline-section" }, [buildStageGateTimeline(p)])
    );

    if (isLate) {
      stagegatePanel.appendChild(el("h3", { class: "weekly-subhead" }, ["Delay recovery"]));
      stagegatePanel.appendChild(
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
      stagegatePanel.appendChild(el("h3", { class: "weekly-subhead" }, ["Time saved"]));
      stagegatePanel.appendChild(
        el("div", { class: "detail-block time-saved" }, [
          el("h4", null, ["+" + p.timeSavedDays + " day" + (p.timeSavedDays === 1 ? "" : "s") + " ahead of plan"]),
          p.timeSavedNote && p.timeSavedNote.length
            ? el("ul", null, listOrDash(p.timeSavedNote))
            : el("p", { class: "empty-note is-missing" }, ["Not yet documented"]),
        ])
      );
    }

    if ((p.fastFollowItems || []).length || p.scopeReduced) {
      stagegatePanel.appendChild(el("h3", { class: "weekly-subhead" }, ["Fast-follow items (planned or remaining)"]));
      stagegatePanel.appendChild(
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

    // Progress trend chart
    schedulePanel.appendChild(el("h3", { class: "weekly-subhead" }, ["Progress over time"]));
    if (!weeks.length) {
      schedulePanel.appendChild(el("p", { class: "empty-note" }, ["No history yet — it'll build up week over week as updates get ingested."]));
    } else {
      schedulePanel.appendChild(buildTrendGraph(weeks));
    }

    // Schedule timeline — a log of every date move (e.g. a CR pushing the
    // timeline). Used to also render a per-project calendar/Gantt above
    // this (`buildSingleProjectGantt()`) — removed 2026-09-30 per explicit
    // request, for every project, not just one.
    const scheduleSection = el("div", { id: "detailScheduleSection" });
    scheduleSection.appendChild(el("h3", { class: "weekly-subhead" }, ["Schedule timeline"]));
    scheduleSection.appendChild(
      el("p", { class: "section-subhead" }, [
        "A log of every time this project's go-live or a milestone date moved — e.g. a CR pushing the timeline.",
      ])
    );
    const scheduleEvents = buildScheduleTimeline(weeks);
    scheduleSection.appendChild(
      scheduleEvents.length ? buildCollapsibleChangelog(scheduleEvents) : renderScheduleTimeline(scheduleEvents)
    );
    schedulePanel.appendChild(scheduleSection);

    // Renders the Dependencies / Weekly Status / Risks blocks for a given
    // week's data (either the live project `p` or a historical snapshot),
    // into whichever container is passed in. Used twice, in two different
    // tabs, for two different purposes:
    //  - The "Dependencies & Risks" tab calls this once, always with the
    //    live project `p` (never changes), in interactive mode — real
    //    jump-link ids (`detail-deps-section` etc.) and actionable list
    //    items (edit/escalate/resolve) and "+ Add" links.
    //  - The "Week-over-week" tab calls this every time a different week
    //    gets clicked, in read-only mode (`opts.readOnly`) — no ids (there
    //    can only be one `detail-deps-section` in the DOM, and that's the
    //    live one above), always the plain non-interactive paired-list
    //    rendering regardless of which week is selected (even the latest),
    //    and no "+ Add" links, since this tab is explicitly a historical
    //    viewer, not a place to make live edits.
    function renderSnapshotSections(container, snap, label, isLatest, opts) {
      opts = opts || {};
      const readOnly = !!opts.readOnly;
      const interactive = isLatest && !readOnly;
      container.innerHTML = "";

      container.appendChild(
        el("div", { class: "snapshot-sections-label" }, [
          isLatest ? "Showing current data" : "Showing snapshot as of " + fmtDate(label),
        ])
      );

      if (snap.escalations && snap.escalations.length) {
        container.appendChild(
          el("h3", readOnly ? { class: "weekly-subhead" } : { class: "weekly-subhead", id: "detail-escalations-section" }, ["🚨 Escalated to leadership"])
        );
        container.appendChild(
          el("div", { class: "detail-block escalations" }, [
            el("ul", null, snap.escalations.map((text) => el("li", null, [text]))),
          ])
        );
      }

      container.appendChild(
        el(
          "h3",
          readOnly ? { class: "weekly-subhead detail-section-head" } : { class: "weekly-subhead detail-section-head", id: "detail-deps-section" },
          [
            el("span", null, ["Dependencies"]),
            interactive ? detailSectionIssueLink("new-dependency.yml", p.name, "+ Add a Dependency") : null,
          ].filter(Boolean)
        )
      );
      const snapDeps = getDependencyObjects(snap).filter(
        (d) => !d.resolved && !isPlaceholderDependencyText(d.text)
      );
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

      const snapRisks = getRiskObjects(snap).filter(
        (r) => !r.resolved && !isPlaceholderRiskText(r.text)
      );
      container.appendChild(
        el(
          "h3",
          readOnly ? { class: "weekly-subhead detail-section-head" } : { class: "weekly-subhead detail-section-head", id: "detail-risks-section" },
          [
            el("span", null, ["Risks / blockers"]),
            interactive ? detailSectionIssueLink("new-risk.yml", p.name, "+ Report a Risk") : null,
          ].filter(Boolean)
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
    }

    // "Dependencies & Risks" tab — always the live project's current data,
    // interactive (real jump-link ids + add/edit/escalate/resolve actions).
    // No time-travel here anymore; that moved to its own "Week-over-week"
    // tab below, which gets its own separate (read-only) copy of this same
    // rendering so there's only ever one `id="detail-deps-section"` etc. in
    // the DOM for jump-links to find.
    const liveSnapshotSections = el("div", { class: "snapshot-sections" });
    renderSnapshotSections(liveSnapshotSections, p, null, true);
    depsRisksPanel.appendChild(liveSnapshotSections);

    // "Week-over-week" tab — click a week to load its Dependencies /
    // Weekly Status / Risks as they stood that week. Its own snapshot
    // preview is always read-only (even when the latest week is selected)
    // since this tab is explicitly a historical viewer, not a place to
    // make live edits — that's what the "Dependencies & Risks" tab is for.
    weekOverWeekPanel.appendChild(el("h3", { class: "weekly-subhead" }, ["Week-over-week changes"]));
    if (!weeks.length) {
      weekOverWeekPanel.appendChild(
        el("p", { class: "empty-note" }, ["No history yet — it'll build up week over week as updates get ingested."])
      );
    } else {
      weekOverWeekPanel.appendChild(el("p", { class: "section-subhead", style: "margin:-6px 0 12px;" }, ["Click a week to see dependencies, sprint status, and risks as they stood that week."]));
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

        const rowEl = el(
          "div",
          {
            class: "changelog-row" + (statusChanged ? " has-status-change" : "") + (isLatest ? " is-selected" : ""),
            "data-week-index": String(i),
            tabindex: "0",
            role: "button",
          },
          [
            el("div", { class: "changelog-date" }, [fmtDate(cur.asOf)]),
            el("div", { class: "changelog-body" }, bodyChildren),
          ]
        );
        changeLog.appendChild(rowEl);
      }
      weekOverWeekPanel.appendChild(changeLog);

      const historySnapshotSections = el("div", { class: "snapshot-sections" });
      weekOverWeekPanel.appendChild(historySnapshotSections);

      changeLog.querySelectorAll(".changelog-row").forEach((rowEl) => {
        const selectWeek = () => {
          const idx = Number(rowEl.getAttribute("data-week-index"));
          const isLatest = idx === weeks.length - 1;
          changeLog.querySelectorAll(".changelog-row").forEach((r) => r.classList.remove("is-selected"));
          rowEl.classList.add("is-selected");
          renderSnapshotSections(historySnapshotSections, isLatest ? p : weeks[idx], weeks[idx].asOf, isLatest, { readOnly: true });
        };
        rowEl.addEventListener("click", selectWeek);
        rowEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selectWeek();
          }
        });
      });

      // Defaults to the latest week (same data the "Dependencies & Risks"
      // tab is already showing); click an older row above to rewind.
      renderSnapshotSections(historySnapshotSections, p, weeks[weeks.length - 1].asOf, true, { readOnly: true });
    }

    // Full feedback history
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
    "stage-gate-timeline-section": "stagegate",
    "detail-deps-section": "depsrisks",
    "detail-risks-section": "depsrisks",
    "detail-escalations-section": "depsrisks",
    "detail-followups-section": "followups",
  };

  function activateDetailTab(root, tabId) {
    root.querySelectorAll(".detail-tab-btn").forEach((btn) => {
      btn.classList.toggle("is-active", btn.getAttribute("data-tab") === tabId);
    });
    root.querySelectorAll(".detail-tab-panel").forEach((panel) => {
      panel.classList.toggle("is-active", panel.getAttribute("data-tab") === tabId);
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

  function buildItemDetail(kind, project, item) {
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
    const sla = stageSlaDays(stage);
    const days = seg ? seg.days : 0;
    const flag = seg ? stageFlagLevel(days, sla) : null;
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
        buildStageOverviewPanel(p, stage, seg, sla, days, flag, kind, plan, delayEntries),
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

  function dateVarianceCell(initial, latest, actual) {
    let varianceLabel = "—";
    let varianceClass = "";
    if (actual && latest) {
      const delta = daysBetweenIso(latest, actual);
      if (delta === 0) {
        varianceLabel = "On schedule";
        varianceClass = "is-ontime";
      } else if (delta > 0) {
        varianceLabel = "+" + delta + "d late";
        varianceClass = "is-late";
      } else {
        varianceLabel = delta + "d early";
        varianceClass = "is-early";
      }
    } else if (!latest) {
      varianceLabel = "Not planned yet";
    } else {
      varianceLabel = "Pending";
    }
    return el("span", { class: "stagedetail-variance" + (varianceClass ? " " + varianceClass : "") }, [varianceLabel]);
  }

  function buildStageOverviewPanel(p, stage, seg, sla, days, flag, kind, plan, delayEntries) {
    // `seg` can be null even for a "done" stage — computeStageSegments()
    // only reconstructs stages actually captured in history.json, so a
    // project whose tracking began mid-pipeline has no segment for stages
    // before that point, even though they're clearly in the past by index.
    const actualStart = seg ? seg.start : null;
    const actualEnd = kind === "done" && seg ? seg.end : null;

    const pct = kind === "done" ? 100 : kind === "future" ? 0 : sla != null ? Math.max(0, Math.min(100, Math.round((days / sla) * 100))) : null;
    const cumulativeOverage = cumulativeStageOverageDays(p);
    const overDays = sla != null ? Math.max(0, days - sla) : 0;

    // For a not-yet-reached stage with no real stagePlan entry, `plan` is
    // empty and every date row below would just show "—" — not useful
    // when the whole point of clicking through here was "what's the
    // potential target for this." Fall back to the same SLA-chain
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
          el("h4", null, ["SLA Elapsed"]),
          el("span", { class: "stagedetail-completion-pct" }, [pct == null ? "—" : pct + "%"]),
        ]),
        el("div", { class: "progress-track" }, [
          el("div", { class: "progress-fill status-" + (flag === "breach" ? "red" : flag === "warn" ? "amber" : "green"), style: "width:" + (pct || 0) + "%" }),
        ]),
        el("div", { class: "stagedetail-completion-foot" }, [
          el("span", null, [kind === "done" ? "Closed out" : kind === "current" ? "In progress" : "Not started"]),
          el("span", null, ["Status: " + stageStatusBadge(kind)]),
        ]),
      ]),

      el("div", { class: "stagedetail-stat-row" }, [
        el("div", { class: "metric-card" + (flag === "breach" ? " tone-red" : flag === "warn" ? " tone-amber" : " tone-green") }, [
          el("div", { class: "num" }, [(overDays > 0 ? "+" + overDays : "0") + "d"]),
          el("div", { class: "label" }, ["Stage delay"]),
          el("div", { class: "stage-grid-metric-sub" }, [overDays > 0 ? "over SLA" : "on time"]),
        ]),
        el("div", { class: "metric-card" }, [
          el("div", { class: "num" }, [String(delayEntries.length)]),
          el("div", { class: "label" }, ["Log entries"]),
          el("div", { class: "stage-grid-metric-sub" }, ["recorded"]),
        ]),
        el("div", { class: "metric-card" + (cumulativeOverage ? " tone-amber" : " tone-green") }, [
          el("div", { class: "num" }, [cumulativeOverage + "d"]),
          el("div", { class: "label" }, ["Project cumulative"]),
          el("div", { class: "stage-grid-metric-sub" }, ["all " + PIPELINE_STAGES.length + " stages"]),
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

  function buildStageAnalysisPanel(entries) {
    if (!entries.length) {
      return el("div", { class: "deps-empty-group" }, ["No delay log entries recorded for this stage."]);
    }
    const totalDays = entries.reduce((sum, e) => sum + (e.days || 0), 0);
    const breakdowns = [
      { title: "By Team", groups: aggregateDelayLog(entries, "team") },
      { title: "By Member", groups: aggregateDelayLog(entries, "member") },
      { title: "By Reason", groups: aggregateDelayLog(entries, "reason") },
    ];
    return el(
      "div",
      { class: "stagedetail-analysis-head" }, [
      el("div", { class: "stagedetail-analysis-total" }, [
        el("span", { class: "kicker" }, ["Delay Attribution"]),
        el("span", { class: "num" }, [String(totalDays)]),
        el("span", { class: "label" }, ["days total"]),
      ]),
      el(
        "div",
        { class: "stagedetail-analysis-cols" },
        breakdowns.map((b) =>
          el("div", { class: "stagedetail-analysis-col" }, [
            el("h4", null, [b.title]),
            buildDonutChart(b.groups),
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
      ),
    ]);
  }

  const BREAKDOWN_COLORS = ["#c1502e", "#5a3b30", "#dfa23a", "#3562e8", "#1a9f6b", "#8a5fd6"];

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
        el("span", { class: "donut-chart-num" }, [String(total)]),
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
      // slipping again." None of this feeds the Stage delay / Project
      // cumulative numbers above either — those come from real elapsed
      // calendar time in a stage versus its SLA, independent of how many
      // times a target got re-planned.
      wrap.appendChild(
        el("p", { class: "section-subhead stagedetail-log-note" }, [
          "Note: each row above is its own change, not a running total — Go-Live and milestone-target shifts are tracked separately and shouldn't be summed together, and they're unrelated to the Stage delay / Project cumulative figures above.",
        ])
      );
    }

    wrap.appendChild(el("h4", { class: "weekly-subhead stagedetail-manual-log-head" }, ["Manually reported delay log"]));

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

    let sortDesc = true;

    function render() {
      const q = searchInput.value.trim().toLowerCase();
      const reasonFilter = reasonSelect.value;
      const teamFilter = teamSelect.value;
      let filtered = entries.filter((e) => {
        if (reasonFilter !== "all" && e.reason !== reasonFilter) return false;
        if (teamFilter !== "all" && e.team !== teamFilter) return false;
        if (q && !(e.reason + " " + e.member + " " + e.team + " " + e.id).toLowerCase().includes(q)) return false;
        return true;
      });
      filtered = filtered.slice().sort((a, b) => (sortDesc ? b.days - a.days : a.days - b.days));

      tableHolder.innerHTML = "";
      if (!filtered.length) {
        tableHolder.appendChild(el("div", { class: "deps-empty-group" }, ["No matching delay log entries."]));
        return;
      }

      const sortArrow = el("span", { class: "stagedetail-sort-arrow" }, [sortDesc ? "▼" : "▲"]);
      const daysHeader = el("th", { class: "stagedetail-days-header" }, ["Days ", sortArrow]);
      daysHeader.addEventListener("click", () => {
        sortDesc = !sortDesc;
        render();
      });

      tableHolder.appendChild(
        el("table", { class: "stagedetail-log-table" }, [
          el("thead", null, [
            el("tr", null, [
              el("th", null, ["ID"]),
              el("th", null, ["Date"]),
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
                el("td", null, [e.reason]),
                el("td", null, [e.member]),
                el("td", null, [e.team]),
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

  function wireFeedbackModal() {
    const modal = document.getElementById("feedbackModal");
    const projectSelect = document.getElementById("fbProject");
    activeProjects().forEach((p) => {
      projectSelect.appendChild(el("option", { value: p.name }, [p.name]));
    });

    document.getElementById("openFeedbackBtn").addEventListener("click", () => {
      modal.hidden = false;
    });
    document.getElementById("fbCancel").addEventListener("click", () => {
      modal.hidden = true;
    });
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.hidden = true;
    });
    document.getElementById("fbSubmit").addEventListener("click", () => {
      const project = projectSelect.value;
      const note = document.getElementById("fbNote").value.trim();
      const mitigationImpact = document.getElementById("fbMitigation").value.trim();
      const raisedBy = document.getElementById("fbRaisedBy").value.trim();
      if (!note) {
        document.getElementById("fbNote").focus();
        return;
      }
      const url = issueUrl("meeting-feedback.yml", {
        project,
        note,
        mitigation_impact: mitigationImpact,
        raised_by: raisedBy,
      });
      window.open(url, "_blank", "noopener");
      modal.hidden = true;
      document.getElementById("fbNote").value = "";
      document.getElementById("fbMitigation").value = "";
      document.getElementById("fbRaisedBy").value = "";
    });
  }

  /* ---------------- Tabs ---------------- */

  // Which tabs the global filter bar's controls actually affect. The bar
  // used to claim "Applies to every tab" unconditionally, but:
  // - Status History (renderStatusHistory) only ever checks
  //   globalProjectFilter/activeOwner — it never reads globalTeamFilter,
  //   so picking a team there silently did nothing.
  // - Team Performance is a disconnected placeholder stub (no data wired
  //   up at all yet) — none of the three filters affect it.
  const TEAM_FILTER_TABS = new Set(["status", "grid", "hawkeye", "deps"]);
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

    const teamApplies = TEAM_FILTER_TABS.has(tabKey);
    teamGroup.hidden = !teamApplies;
    teamSep.hidden = !teamApplies;
    hint.textContent = teamApplies
      ? "Applies to every tab"
      : "Project & PM filters apply here — Team doesn't (Status History isn't grouped by team)";
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
        document.getElementById("panel-" + tabKey).classList.add("is-active");
        updateGlobalFilterBarForTab(tabKey);
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

    renderStatusHistory();

    wireProjectDetail();
    wireStageDetailModal();
    wireItemDetailModal();
    wireFeedbackModal();
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
