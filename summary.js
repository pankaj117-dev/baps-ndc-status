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
 * pending hotfix). `summaryPosition` (1-based) pins a row to a slot after
 * sorting. The Project/PM filter bar applies here too.
 *
 * app.js shares what this needs as window.NDC and fires "ndc:render"
 * whenever the data or the filters change. */
(function () {
  "use strict";

  const SEVERITY = { green: 0, amber: 1, red: 2, black: 3 };
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

  function stateCell(status, title) {
    if (!status) return '<td class="sum-state sum-state-none">' + missing("Not updated", "Overall status") + "</td>";
    return '<td class="sum-state sum-state-' + status + '" title="' + esc(title || "") + '">' + WORD[status] + "</td>";
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
      // Worst first, then the ones that changed, then by name: the order
      // the deck reads in.
      .sort((a, b) =>
        (SEVERITY[b.current] ?? 9) - (SEVERITY[a.current] ?? 9) ||
        (SEVERITY[b.last] ?? -1) - (SEVERITY[a.last] ?? -1) ||
        a.p.name.localeCompare(b.p.name)
      );
    // Pinned rows go to their slot (lowest slot first) once the rest are sorted.
    const pinned = rows.filter((r) => r.p.summaryPosition > 0).sort((a, b) => a.p.summaryPosition - b.p.summaryPosition);
    const out = rows.filter((r) => !(r.p.summaryPosition > 0));
    pinned.forEach((r) => out.splice(Math.min(r.p.summaryPosition - 1, out.length), 0, r));
    return out;
  }

  function notesCell(r) {
    const reason = String(r.p.statusChangeReason || "").trim();
    const needsReason = (r.current && r.current !== "green") || (r.last && r.current && r.last !== r.current);
    if (reason) return '<td class="sum-notes">' + esc(reason) + "</td>";
    return '<td class="sum-notes">' + (needsReason ? missing("Reason missing", "Reason for status change") : "-") + "</td>";
  }

  function goLiveCell(p) {
    const go = p.goLive ? fmt(p.goLive) : "TBD";
    const inHypercare = /hypercare/i.test(p.stage || "");
    if (!inHypercare) return '<td class="sum-golive">' + go + "</td>";
    const end = hypercareEnd(p);
    return '<td class="sum-golive">' + go + " /<br>" +
      (end ? fmt(end) : missing("Not set", "Current stage — planned completion date")) + "</td>";
  }

  function stageCell(p) {
    const stage = p.stageLabel || p.stage;
    return '<td class="sum-stage">' + (stage ? esc(stage) : missing("Not updated", "Pipeline stage")) + "</td>";
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
    const body = rows.length
      ? rows.map((r, i) =>
          "<tr>" +
          '<td class="sum-num">' + (i + 1) + "</td>" +
          '<td class="sum-project"><button type="button" class="sum-project-link" data-project="' + esc(r.p.id) +
            '" title="Open ' + esc(r.p.name) + ' details">' + esc(r.p.name) + "</button></td>" +
          (r.last ? stateCell(r.last, "Snapshot " + fmt(r.snapAsOf)) : '<td class="sum-state sum-state-none" title="No snapshot from last week">—</td>') +
          stateCell(r.current, "Effective status, as on the cards") +
          notesCell(r) +
          goLiveCell(r.p) +
          stageCell(r.p) +
          "</tr>"
        ).join("")
      : '<tr><td colspan="7" class="sum-empty">No active projects match the current filter.</td></tr>';

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
      '<th class="sum-num">#</th><th>Project</th><th>Last State</th><th>Current State</th>' +
      "<th>State Change Notes</th><th>Go-Live /<br>Hypercare</th><th>Stage</th>" +
      "</tr></thead><tbody>" + body + "</tbody></table></div>" +
      "</div>";

    root.querySelectorAll(".sum-project-link").forEach((b) =>
      b.addEventListener("click", () => NDC.openProjectDetail(b.getAttribute("data-project")))
    );
  }

  function draw() {
    if (window.NDC && window.NDC.getData()) render(window.NDC);
  }

  document.addEventListener("ndc:render", draw);
  draw();
})();
