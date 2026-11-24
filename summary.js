/* Summary tab (2026-11-19): "Project Status Summary", one row per active
 * project, for the start of the NDC call.
 *
 * Everything comes from data the PMs already enter through the Weekly
 * Update form. Nothing here is stored separately:
 *   Current State   effective status, the same rule the cards use
 *                   (delay days, usePmStatus, behindSchedule, black)
 *   Last State      that rule applied to the latest snapshot from the
 *                   previous Monday-Sunday week in history.json
 *   Notes           "Reason for status change", shown when the status
 *                   changed or isn't Green
 *   Go-Live         go-live date (TBD when not set, as on the cards), plus
 *                   the hypercare end date while the project is in Hypercare
 *   Stage           stage label, or pipeline stage
 * A value a PM still has to enter shows a "⚠ ..." chip naming the form
 * field to fill in. Closed (`closedOn`) and finished (`stageComplete`)
 * projects are left out, unless `summaryInclude` keeps one listed (e.g. a
 * pending hotfix). Rows are red, then amber, then green, and within a
 * color the least complete project comes first. The Project/PM filter
 * bar applies here too.
 *
 * app.js shares what this needs as window.NDC and fires "ndc:render"
 * whenever the data or the filters change. */
(function () {
  "use strict";

  const RANK = { black: 0, red: 1, amber: 2, green: 3 };
  const WORD = { green: "GREEN", amber: "AMBER", red: "RED", black: "NON-RECOVERABLE" };
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const FORM = "Weekly Update form";

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // 28-Jan-2027, the format the weekly deck uses.
  function fmt(iso) {
    if (!iso) return "";
    const [y, m, d] = String(iso).slice(0, 10).split("-").map(Number);
    return String(d).padStart(2, "0") + "-" + MONTHS[m - 1] + "-" + y;
  }

  function missing(text, field) {
    return '<span class="sum-missing" title="PM to update: ' + esc(FORM) + " → " + esc(field) + '">⚠ ' + esc(text) + "</span>";
  }

  function stateCell(status, title, label) {
    const attr = ' data-label="' + esc(label) + '"';
    if (!status) return '<td class="sum-state sum-state-none"' + attr + '>' + missing("Not updated", "Overall status") + "</td>";
    return '<td class="sum-state"' + attr + ' title="' + esc(title || "") + '"><span class="pill pill-' + status + '">' + WORD[status] + "</span></td>";
  }

  // Latest snapshot from the calendar week before the one data.json is
  // "as of": the previous NDC week.
  function lastWeekSnapshot(NDC, projectId, asOf) {
    const thisWeek = NDC.weekStartMonday(asOf);
    const earlier = NDC.historyForProject(projectId).filter((w) => NDC.weekStartMonday(w.asOf) < thisWeek);
    return earlier.length ? earlier[earlier.length - 1] : null;
  }

  function hypercareEnd(p) {
    const plan = (p.stagePlan || {}).Hypercare;
    return plan ? plan.latestEnd || plan.initialEnd || null : null;
  }

  function buildRows(NDC) {
    const data = NDC.getData();
    const asOf = data.asOf;
    const rows = NDC.visibleProjects()
      .filter((p) => !p.closedOn && (!p.stageComplete || p.summaryInclude))
      .map((p) => {
        const current = p.status ? NDC.effectiveStatus(p) : null;
        const snap = asOf ? lastWeekSnapshot(NDC, p.id, asOf) : null;
        const last = snap && snap.status ? NDC.effectiveStatus(snap) : null;
        return { p, current, last, snapAsOf: snap ? snap.asOf : null };
      })
      // Red at the top, then amber, then green. Inside a color, least
      // complete first.
      .sort((a, b) =>
        (RANK[a.current] ?? 9) - (RANK[b.current] ?? 9) ||
        (Number(a.p.progress) || 0) - (Number(b.p.progress) || 0) ||
        a.p.name.localeCompare(b.p.name)
      );
    return rows;
  }

  function notesCell(r) {
    const reason = String(r.p.statusChangeReason || "").trim();
    const needsReason = (r.current && r.current !== "green") || (r.last && r.current && r.last !== r.current);
    if (reason) return '<td class="sum-notes" data-label="What changed">' + esc(reason) + "</td>";
    return '<td class="sum-notes" data-label="What changed">' + (needsReason ? missing("Reason missing", "Reason for status change") : "-") + "</td>";
  }

  function goLiveCell(p) {
    const go = p.goLive ? fmt(p.goLive) : "TBD";
    const inHypercare = /hypercare/i.test(p.stage || "");
    if (!inHypercare) return '<td class="sum-golive" data-label="Go-live">' + go + "</td>";
    const end = hypercareEnd(p);
    return '<td class="sum-golive" data-label="Go-live"><span class="sum-golive-date">' + go + "</span>" +
      '<span class="sum-golive-end">Ends ' +
      (end ? fmt(end) : missing("Not set", "Current stage — planned completion date")) +
      "</span></td>";
  }

  function stageCell(p) {
    const stage = p.stageLabel || p.stage;
    return '<td class="sum-stage" data-label="Stage">' + (stage ? esc(stage) : missing("Not updated", "Pipeline stage")) + "</td>";
  }

  function layoutBars(root) {
    const wrap = root.querySelector(".sum-table-wrap");
    if (!wrap) return;
    wrap.querySelectorAll(".sum-progress").forEach((bar) => bar.remove());
    const wrapTop = wrap.getBoundingClientRect().top;
    root.querySelectorAll("tr.sum-row").forEach((row) => {
      const pct = Math.max(0, Math.min(100, Number(row.getAttribute("data-progress")) || 0));
      if (!pct) return;
      const rect = row.getBoundingClientRect();
      const bar = document.createElement("div");
      bar.className = "sum-progress status-" + (row.getAttribute("data-status") || "green");
      bar.style.top = rect.top - wrapTop + wrap.scrollTop + "px";
      bar.style.height = rect.height + "px";
      bar.style.width = (wrap.scrollWidth * pct) / 100 + "px";
      wrap.appendChild(bar);
    });
  }

  function render(NDC) {
    const root = document.getElementById("summaryPanel");
    if (!root) return;
    const data = NDC.getData();
    const rows = buildRows(NDC);
    const counts = { red: 0, amber: 0, green: 0 };
    rows.forEach((r) => {
      if (r.current === "red" || r.current === "black") counts.red++;
      else if (r.current in counts) counts[r.current]++;
    });
    const cols = 8;
    const body = rows.length
      ? rows.map((r, i) => {
          const pct = Math.max(0, Math.min(100, Number(r.p.progress) || 0));
          const badges = (NDC.summaryBadges ? NDC.summaryBadges(r.p) : []).map((b) =>
            '<span class="badge' + (b.tone ? " " + b.tone : "") + '"' +
            (b.section ? ' data-section="' + esc(b.section) + '"' : "") +
            ">" + esc(b.text) + "</span>"
          ).join("");
          return (
            '<tr class="sum-row' + (badges ? "" : " sum-row-plain") + '" tabindex="0" role="button" data-project="' + esc(r.p.id) +
              '" data-progress="' + pct + '" data-status="' + esc(r.current || "") +
              '" title="Open ' + esc(r.p.name) + '">' +
            '<td class="sum-num">' + (i + 1) + "</td>" +
            '<td class="sum-project"><div class="sum-project-line">' + esc(r.p.name) +
              '<span class="sum-pct">' + pct + "%</span></div>" +
              (badges ? '<div class="sum-badges">' + badges + "</div>" : "") +
              "</td>" +
            '<td class="sum-pm" data-label="PM">' + esc(r.p.owner || "—") + "</td>" +
            (r.last ? stateCell(r.last, "Snapshot " + fmt(r.snapAsOf), "Last week") : '<td class="sum-state sum-state-none" data-label="Last week" title="No snapshot from last week">—</td>') +
            stateCell(r.current, "Effective status, as on the cards", "This week") +
            notesCell(r) +
            goLiveCell(r.p) +
            stageCell(r.p) +
            "</tr>"
          );
        }).join("")
      : '<tr><td colspan="' + cols + '" class="sum-empty">No active projects match the current filter.</td></tr>';

    const gaps = (body.match(/class="sum-missing"/g) || []).length;
    const lastWeek = rows.map((r) => r.snapAsOf).filter(Boolean).sort().pop();
    const sub =
      "As of " + fmt(data.asOf) +
      (lastWeek ? " · Last State = week of " + fmt(NDC.weekStartMonday(lastWeek)) : " · No earlier week in history yet") +
      (gaps ? ' · <span class="sum-gap-count">⚠ ' + gaps + " item" + (gaps === 1 ? "" : "s") + " for PMs to update</span>" : "");

    root.innerHTML =
      '<div class="sum-card">' +
      '<div class="sum-head">' +
      '<div><h2>Project Status Summary</h2><p class="sum-sub">' + sub + "</p></div>" +
      '<div class="sum-counts">' +
      '<div class="sum-count sum-count-red"><b>' + counts.red + "</b><span>Red</span></div>" +
      '<div class="sum-count sum-count-amber"><b>' + counts.amber + "</b><span>Amber</span></div>" +
      '<div class="sum-count sum-count-green"><b>' + counts.green + "</b><span>Green</span></div>" +
      "</div></div>" +
      '<div class="sum-table-wrap"><table class="sum-table"><thead><tr>' +
      '<th class="sum-num">#</th><th class="sum-project">Project</th><th class="sum-pm">PM</th>' +
      '<th class="sum-state">Last week<span class="sum-th-sub">prior status</span></th>' +
      '<th class="sum-state">This week<span class="sum-th-sub">current status</span></th>' +
      '<th class="sum-notes">What changed</th>' +
      '<th class="sum-golive">Go-live<span class="sum-th-sub">hypercare end</span></th>' +
      '<th class="sum-stage">Stage</th>' +
      "</tr></thead><tbody>" + body + "</tbody></table></div>" +
      "</div>";

    const openRow = (row) => NDC.openProjectDetail(row.getAttribute("data-project"));
    root.querySelectorAll(".sum-row").forEach((row) => {
      row.addEventListener("click", (e) => {
        const badge = e.target.closest("[data-section]");
        if (badge) {
          NDC.openProjectDetail(row.getAttribute("data-project"), badge.getAttribute("data-section"));
          return;
        }
        openRow(row);
      });
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openRow(row);
        }
      });
    });
    layoutBars(root);
    if (!render._wired) {
      render._wired = true;
      window.addEventListener("resize", () => {
        const panel = document.getElementById("summaryPanel");
        if (panel) layoutBars(panel);
      });
    }
  }

  function draw() {
    if (window.NDC && window.NDC.getData()) render(window.NDC);
  }

  document.addEventListener("ndc:render", draw);
  document.querySelector('[data-tab="summary"]') &&
    document.querySelector('[data-tab="summary"]').addEventListener("click", () => {
      requestAnimationFrame(() => {
        const panel = document.getElementById("summaryPanel");
        if (panel) layoutBars(panel);
      });
    });
  draw();
})();
