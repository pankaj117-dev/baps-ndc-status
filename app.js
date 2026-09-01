(function () {
  "use strict";

  const REPO = "pankaj117-dev/baps-ndc-status";
  const STATUS_LABEL = { green: "On Track", amber: "At Risk", red: "Critical" };

  let DATA = null;
  let HISTORY = {};
  let NOTES = [];
  let activeFilter = "all";
  let weeklySelectedId = null;

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

  function listOrDash(items) {
    return items.length ? items.map((d) => el("li", null, [d])) : [el("li", null, ["—"])];
  }

  function renderCards() {
    const box = document.getElementById("cards");
    box.innerHTML = "";
    const projects = DATA.projects.filter((p) => activeFilter === "all" || p.status === activeFilter);

    projects.forEach((p) => {
      const isLate = p.delayDays > 0;
      const detailId = "detail-" + p.id;
      const notes = openNotesFor(p.id);

      const card = el("div", { class: "card status-" + p.status }, [
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
        el("button", { class: "card-toggle", "data-target": detailId }, ["Show details ▾"]),
        el("div", { class: "card-detail", id: detailId }, [
          notes.length
            ? el("div", { class: "detail-block followups" }, [
                el("h4", null, ["Open follow-ups"]),
                el("ul", null, notes.map((n) => el("li", null, [n.text + (n.raisedBy ? ` — ${n.raisedBy}` : "")]))),
              ])
            : null,
          el("div", { class: "detail-block deps" }, [
            el("h4", null, ["Dependencies"]),
            el("ul", null, listOrDash(p.dependencies || [])),
          ]),
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
          el("div", { class: "detail-block risks" }, [
            el("h4", null, ["Risks / blockers"]),
            el("ul", null, p.risks && p.risks.length ? p.risks.map((d) => el("li", null, [d])) : [el("li", null, ["None reported"])]),
          ]),
          el("div", { class: "card-action-row" }, [
            el("a", {
              class: "btn-ghost btn-small",
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
        ]),
      ]);

      box.appendChild(card);
    });

    box.querySelectorAll(".card-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = document.getElementById(btn.getAttribute("data-target"));
        const open = target.classList.toggle("is-open");
        btn.textContent = open ? "Hide details ▴" : "Show details ▾";
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

  /* ---------------- Tab 2: Week over Week ---------------- */

  function populateWeeklySelect() {
    const select = document.getElementById("weeklyProjectSelect");
    select.innerHTML = "";
    DATA.projects.forEach((p) => {
      select.appendChild(el("option", { value: p.id }, [p.name]));
    });
    if (!weeklySelectedId) weeklySelectedId = DATA.projects[0] && DATA.projects[0].id;
    select.value = weeklySelectedId;
    select.addEventListener("change", () => {
      weeklySelectedId = select.value;
      renderWeekOverWeek();
    });
  }

  function historyForProject(projectId) {
    return Object.keys(HISTORY)
      .sort()
      .map((asOf) => {
        const snap = HISTORY[asOf].projects.find((p) => p.id === projectId);
        return snap ? { asOf, ...snap } : null;
      })
      .filter(Boolean);
  }

  function renderWeekOverWeek() {
    const box = document.getElementById("weeklyContent");
    box.innerHTML = "";
    if (!weeklySelectedId) return;

    const weeks = historyForProject(weeklySelectedId);
    const project = DATA.projects.find((p) => p.id === weeklySelectedId);
    const notes = NOTES.filter((n) => n.projectId === weeklySelectedId);

    if (!weeks.length) {
      box.appendChild(el("p", { class: "empty-note" }, ["No history yet for this project — it'll build up week over week as updates get ingested."]));
      return;
    }

    // Progress trend as simple bar chart.
    const chart = el("div", { class: "trend-chart" });
    weeks.forEach((w) => {
      chart.appendChild(
        el("div", { class: "trend-bar-wrap" }, [
          el("div", { class: "trend-bar status-" + w.status, style: `height:${Math.max(4, w.progress)}%` }),
          el("div", { class: "trend-pct" }, [w.progress + "%"]),
          el("div", { class: "trend-label" }, [fmtDateShort(w.asOf)]),
        ])
      );
    });
    box.appendChild(el("h3", { class: "weekly-subhead" }, ["Progress over time — " + (project ? project.name : "")]));
    box.appendChild(chart);

    // Change log between consecutive snapshots.
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
    box.appendChild(el("h3", { class: "weekly-subhead" }, ["Week-over-week changes"]));
    box.appendChild(changeLog);

    // Notes / follow-ups history for this project.
    box.appendChild(el("h3", { class: "weekly-subhead" }, ["Feedback history"]));
    if (!notes.length) {
      box.appendChild(el("p", { class: "empty-note" }, ["No feedback logged for this project yet."]));
    } else {
      const notesList = el("div", { class: "notes-list" });
      notes
        .slice()
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
        .forEach((n) => {
          notesList.appendChild(
            el("div", { class: "note-row " + (n.status === "open" ? "is-open" : "is-resolved") }, [
              el("span", { class: "note-status" }, [n.status === "open" ? "OPEN" : "RESOLVED"]),
              el("span", { class: "note-text" }, [n.text]),
              el("span", { class: "note-meta" }, [
                (n.raisedBy ? n.raisedBy + " · " : "") + fmtDate((n.createdAt || "").slice(0, 10)),
              ]),
            ])
          );
        });
      box.appendChild(notesList);
    }
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
      const raisedBy = document.getElementById("fbRaisedBy").value.trim();
      if (!note) {
        document.getElementById("fbNote").focus();
        return;
      }
      const url = issueUrl("meeting-feedback.yml", { project, note, raised_by: raisedBy });
      window.open(url, "_blank", "noopener");
      modal.hidden = true;
      document.getElementById("fbNote").value = "";
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
    renderCards();
    wireFilters();

    populateWeeklySelect();
    renderWeekOverWeek();

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
