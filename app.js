(function () {
  "use strict";

  const REPO = "pankaj117-dev/baps-ndc-status";
  const STATUS_LABEL = { green: "On Track", amber: "At Risk", red: "Critical" };

  let DATA = null;
  let HISTORY = {};
  let NOTES = [];
  let activeFilter = "all";
  let activeOwner = "all";

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
    return NOTES.filter((n) => n.projectId === projectId && n.status === "open");
  }

  function issueUrl(template, params) {
    const base = `https://github.com/${REPO}/issues/new`;
    const search = new URLSearchParams({ template, ...params });
    return `${base}?${search.toString()}`;
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
    const projects = DATA.projects;
    const counts = { green: 0, amber: 0, red: 0 };
    let delaySum = 0;
    let riskCount = 0;
    projects.forEach((p) => {
      counts[p.status] = (counts[p.status] || 0) + 1;
      delaySum += p.delayDays || 0;
      riskCount += (p.risks || []).length;
    });
    const avgDelay = projects.length ? Math.round((delaySum / projects.length) * 10) / 10 : 0;

    const metrics = [
      { label: "Total Projects", num: projects.length, tone: "" },
      { label: "On Track", num: counts.green, tone: "tone-green" },
      { label: "At Risk", num: counts.amber, tone: "tone-amber" },
      { label: "Critical", num: counts.red, tone: "tone-red" },
      { label: "Avg Delay (days)", num: avgDelay, tone: "tone-accent" },
      { label: "Open Follow-ups", num: NOTES.filter((n) => n.status === "open").length, tone: "tone-accent" },
    ];

    const row = document.getElementById("metricsRow");
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

  function renderTimeline() {
    const withDates = DATA.projects
      .filter((p) => p.nextMilestone && p.nextMilestone.date)
      .slice()
      .sort((a, b) => new Date(a.nextMilestone.date) - new Date(b.nextMilestone.date));

    const box = document.getElementById("timeline");
    box.innerHTML = "";
    withDates.forEach((p) => {
      box.appendChild(
        el("div", { class: "timeline-row" }, [
          el("div", { class: "timeline-date" }, [fmtDateShort(p.nextMilestone.date)]),
          el("div", { class: "timeline-dot", style: `background:var(--${p.status === "amber" ? "amber" : p.status})` }),
          el("div", { class: "timeline-what" }, [
            el("strong", null, [p.name + " — "]),
            el("span", null, [p.nextMilestone.name]),
          ]),
          el("div", { class: "timeline-status pill-" + p.status }, [STATUS_LABEL[p.status]]),
        ])
      );
    });
  }

  function delaySeverity(days) {
    if (!days || days <= 0) return "green";
    if (days <= 7) return "amber";
    return "red";
  }

  function renderGoLiveTracker() {
    const box = document.getElementById("goliveTracker");
    box.innerHTML = "";

    const scheduled = DATA.projects
      .filter((p) => p.goLive)
      .slice()
      .sort((a, b) => new Date(a.goLive) - new Date(b.goLive));
    const unscheduled = DATA.projects.filter((p) => !p.goLive);

    if (!scheduled.length) {
      box.appendChild(el("p", { class: "empty-note" }, ["No go-live dates scheduled yet."]));
      return;
    }

    scheduled.forEach((p) => {
      const hasSlip = p.originalGoLive && p.originalGoLive !== p.goLive;
      const slipDays = p.delayDays || 0;
      const severity = delaySeverity(slipDays);

      const dateBlock = hasSlip
        ? el("div", { class: "golive-dates" }, [
            el("span", { class: "golive-date-original" }, [fmtDateShort(p.originalGoLive)]),
            el("span", { class: "golive-arrow" }, ["→"]),
            el("span", { class: "golive-date-current" }, [fmtDate(p.goLive)]),
          ])
        : el("div", { class: "golive-dates" }, [
            el("span", { class: "golive-date-current" }, [fmtDate(p.goLive)]),
          ]);

      const row = el("div", { class: "golive-row", "data-project-id": p.id, tabindex: "0", role: "button" }, [
        el("div", { class: "golive-project" }, [
          el("span", { class: "timeline-dot", style: `background:var(--${p.status === "amber" ? "amber" : p.status})` }),
          el("strong", null, [p.name]),
        ]),
        dateBlock,
        el("span", { class: "golive-delay-pill pill-" + severity }, [
          slipDays > 0 ? "+" + slipDays + " days" : "On schedule",
        ]),
      ]);

      box.appendChild(row);
    });

    box.querySelectorAll(".golive-row").forEach((row) => {
      row.addEventListener("click", () => openProjectDetail(row.getAttribute("data-project-id")));
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openProjectDetail(row.getAttribute("data-project-id"));
        }
      });
    });

    if (unscheduled.length) {
      box.appendChild(
        el("div", { class: "golive-unscheduled" }, [
          el("strong", null, ["Not yet scheduled: "]),
          unscheduled.map((p) => p.name).join(", "),
        ])
      );
    }
  }

  function listOrDash(items) {
    return items.length ? items.map((d) => el("li", null, [d])) : [el("li", null, ["—"])];
  }

  function pairedList(items, mitigations, label) {
    if (!items.length) return [el("li", null, ["—"])];
    return items.map((text, i) => {
      const mitigation = (mitigations && mitigations[i]) || "";
      return el("li", { class: "paired-item" }, [
        el("div", { class: "paired-item-text" }, [text]),
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
    const projects = DATA.projects.filter((p) => {
      const statusOk = activeFilter === "all" || p.status === activeFilter;
      const owner = p.owner || "Unassigned";
      const ownerOk = activeOwner === "all" || owner === activeOwner;
      return statusOk && ownerOk;
    });

    if (!projects.length) {
      box.appendChild(el("div", { class: "empty-note" }, ["No projects match this filter."]));
      return;
    }

    projects.forEach((p) => {
      const isLate = p.delayDays > 0;
      const notes = openNotesFor(p.id);

      const card = el("div", { class: "card status-" + p.status, "data-project-id": p.id, tabindex: "0", role: "button" }, [
        el("div", { class: "card-head" }, [
          el("h3", null, [p.name]),
          el("span", { class: "pill pill-" + p.status }, [STATUS_LABEL[p.status]]),
        ]),
        el("div", { class: "card-owner" }, [p.owner ? "PM: " + p.owner : "PM: unassigned"]),
        el("div", { class: "progress-row" }, [
          el("div", { class: "progress-track" }, [
            el("div", { class: "progress-fill status-" + p.status, style: "width:" + p.progress + "%" }),
          ]),
          el("div", { class: "progress-pct" }, [p.progress + "%"]),
        ]),
        el("dl", { class: "card-facts" }, [
          el("dt", null, ["Phase"]),
          el("dd", null, [p.phase || "—"]),
          el("dt", null, ["Next milestone"]),
          el("dd", null, [(p.nextMilestone && p.nextMilestone.name || "—") + (p.nextMilestone && p.nextMilestone.date ? " · " + fmtDateShort(p.nextMilestone.date) : "")]),
          el("dt", null, ["Go-live"]),
          el("dd", null, [fmtDate(p.goLive)]),
          el("dt", null, ["Delay"]),
          el("dd", { class: "delay-flag " + (isLate ? "is-late" : "is-ontime") }, [
            isLate ? "+" + p.delayDays + " days" : "On schedule",
          ]),
        ]),
        el("div", { class: "card-badges" }, [
          el("span", { class: "badge" }, [(p.dependencies || []).length + " dependencies"]),
          el("span", { class: "badge" + ((p.risks || []).length ? " has-risk" : "") }, [(p.risks || []).length + " risks"]),
          el("span", { class: "badge" + (notes.length ? " has-followup" : "") }, [notes.length + " follow-ups"]),
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
  }

  function wireFilters() {
    document.getElementById("filterRow").querySelectorAll(".chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        activeFilter = chip.getAttribute("data-filter");
        document.querySelectorAll("#filterRow .chip").forEach((c) => c.classList.remove("is-on"));
        chip.classList.add("is-on");
        renderCards();
      });
    });
  }

  function wireOwnerFilter() {
    const select = document.getElementById("ownerFilter");
    const owners = Array.from(
      new Set(DATA.projects.map((p) => p.owner || "Unassigned"))
    ).sort((a, b) => {
      if (a === "Unassigned") return 1;
      if (b === "Unassigned") return -1;
      return a.localeCompare(b);
    });

    owners.forEach((owner) => {
      select.appendChild(el("option", { value: owner }, [owner]));
    });

    select.addEventListener("change", () => {
      activeOwner = select.value;
      renderCards();
    });
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

  const STATUS_COLOR = { green: "#2f6b4f", amber: "#a6650f", red: "#b5342a" };

  function buildTrendGraph(weeks) {
    const width = 700;
    const height = 200;
    const padL = 34;
    const padR = 16;
    const padT = 18;
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

    const dots = points.map((p) =>
      `<circle cx="${p.x}" cy="${p.y}" r="4.5" fill="${STATUS_COLOR[p.w.status] || latestColor}" stroke="#fff" stroke-width="2" />` +
      `<text x="${p.x}" y="${p.y - 12}" text-anchor="middle" class="graph-point-label">${p.w.progress}%</text>`
    ).join("");

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

  function openProjectDetail(projectId) {
    const project = DATA.projects.find((p) => p.id === projectId);
    if (!project) return;

    const overlay = document.getElementById("projectDetail");
    const content = document.getElementById("detailContent");
    content.innerHTML = "";
    content.appendChild(buildProjectDetail(project));
    overlay.hidden = false;
    document.body.classList.add("no-scroll");
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
            href: issueUrl("weekly-update.yml", { project: p.name, as_of: DATA.asOf, owner: p.owner || "" }),
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
        el("dt", null, ["Phase"]),
        el("dd", null, [p.phase || "—"]),
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
      ])
    );

    if (openFollowUps.length) {
      root.appendChild(el("h3", { class: "weekly-subhead" }, ["Open follow-ups"]));
      root.appendChild(
        el("div", { class: "detail-block followups" }, [
          el("ul", null, openFollowUps.map((n) => el("li", null, [n.text + (n.raisedBy ? ` — ${n.raisedBy}` : "")]))),
        ])
      );
    }

    // Progress trend chart
    root.appendChild(el("h3", { class: "weekly-subhead" }, ["Progress over time"]));
    if (!weeks.length) {
      root.appendChild(el("p", { class: "empty-note" }, ["No history yet — it'll build up week over week as updates get ingested."]));
    } else {
      root.appendChild(buildTrendGraph(weeks));
    }

    // Change log
    if (weeks.length) {
      root.appendChild(el("h3", { class: "weekly-subhead" }, ["Week-over-week changes"]));
      const changeLog = el("div", { class: "changelog" });
      for (let i = weeks.length - 1; i >= 0; i--) {
        const cur = weeks[i];
        const prev = weeks[i - 1];
        const changes = [];
        if (prev) {
          if (prev.progress !== cur.progress) changes.push(`Progress ${prev.progress}% → ${cur.progress}%`);
          if (prev.status !== cur.status) changes.push(`Status ${STATUS_LABEL[prev.status]} → ${STATUS_LABEL[cur.status]}`);
          if (prev.delayDays !== cur.delayDays) changes.push(`Delay ${prev.delayDays}d → ${cur.delayDays}d`);
          if ((prev.phase || "") !== (cur.phase || "")) changes.push(`Phase → ${cur.phase || "—"}`);
        } else {
          changes.push("First recorded snapshot");
        }
        changeLog.appendChild(
          el("div", { class: "changelog-row" }, [
            el("div", { class: "changelog-date" }, [fmtDate(cur.asOf)]),
            el("div", { class: "changelog-body" }, [changes.join(" · ")]),
          ])
        );
      }
      root.appendChild(changeLog);
    }

    // Current details
    root.appendChild(el("h3", { class: "weekly-subhead" }, ["Dependencies"]));
    root.appendChild(
      el("div", { class: "detail-block deps" }, [
        el("ul", { class: "paired-list" }, pairedList(p.dependencies || [], p.dependencyMitigations || [], "Mitigation / impact")),
      ])
    );

    root.appendChild(el("h3", { class: "weekly-subhead" }, ["Sprint status"]));
    root.appendChild(
      el("div", { class: "sprint-grid" }, [
        el("div", { class: "detail-block" }, [
          el("h4", null, ["Completed"]),
          el("ul", null, listOrDash(p.sprintStatus.completed || [])),
        ]),
        el("div", { class: "detail-block" }, [
          el("h4", null, ["In progress"]),
          el("ul", null, listOrDash(p.sprintStatus.inProgress || [])),
        ]),
        el("div", { class: "detail-block" }, [
          el("h4", null, ["Next plan"]),
          el("ul", null, listOrDash(p.sprintStatus.nextPlan || [])),
        ]),
      ])
    );

    root.appendChild(el("h3", { class: "weekly-subhead" }, ["Risks / blockers"]));
    root.appendChild(
      el("div", { class: "detail-block risks" }, [
        p.risks && p.risks.length
          ? el("ul", { class: "paired-list" }, pairedList(p.risks, p.riskMitigations || [], "Mitigation plan"))
          : el("ul", null, [el("li", null, ["None reported"])]),
      ])
    );

    // Full feedback history
    root.appendChild(el("h3", { class: "weekly-subhead" }, ["Feedback history"]));
    if (!allNotes.length) {
      root.appendChild(el("p", { class: "empty-note" }, ["No feedback logged for this project yet."]));
    } else {
      const notesList = el("div", { class: "notes-list" });
      allNotes
        .slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .forEach((n) => {
          notesList.appendChild(
            el("div", { class: "note-row " + (n.status === "open" ? "is-open" : "is-resolved") }, [
              el("span", { class: "note-status" }, [n.status === "open" ? "OPEN" : "RESOLVED"]),
              el("span", { class: "note-text" }, [n.text]),
              ...(n.mitigationImpact
                ? [el("span", { class: "note-mitigation" }, ["Mitigation / impact: " + n.mitigationImpact])]
                : []),
              el("span", { class: "note-meta" }, [
                (n.raisedBy ? n.raisedBy + " · " : "") + fmtDate((n.createdAt || "").slice(0, 10)),
              ]),
            ])
          );
        });
      root.appendChild(notesList);
    }

    return root;
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
    DATA.projects.forEach((p) => {
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
        document.getElementById("panel-" + btn.getAttribute("data-tab")).classList.add("is-active");
      });
    });
  }

  /* ---------------- Init ---------------- */

  function init([data, history, notes]) {
    DATA = data;
    HISTORY = history;
    NOTES = notes;

    renderHeader();
    renderMetrics();
    renderTimeline();
    renderGoLiveTracker();
    renderCards();
    wireFilters();
    wireOwnerFilter();

    wireProjectDetail();
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
