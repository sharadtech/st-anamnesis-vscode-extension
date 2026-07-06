/* Anamnesis webview: dual-mode knowledge graph viewer.
   Default: Table view (instant render, no layout computation).
   Optional: Graph view via Cytoscape.js (cose/circle/grid/concentric/preset).
   Communicates with the extension host via acquireVsCodeApi(). */
(function () {
  const vscode = acquireVsCodeApi();
  let cy = null;
  let lastGraph = null;
  let lastStats = null;
  let currentView = "table"; // "table" | "graph"
  let currentLayout = "cose"; // graph layout name
  let tableFilter = ""; // search filter for the table view
  let graphInited = false; // defer cytoscape init until graph view is chosen
  let graphViewDisabled = false;
  let graphViewNodeLimit = 1000;

  // ---- Loading overlay control ----
  // Shows a full-screen spinner over the graph area so the user sees clear
  // feedback while the (potentially heavy) Cytoscape init + layout runs.
  // Critical: we yield to the event loop *before* and *around* the heavy work
  // so the VS Code webview host never raises its "unresponsive" dialog.
  const loaderOverlay = document.getElementById("loader-overlay");
  const loaderText = document.getElementById("loader-text");
  let loaderTimer = null;

  function showLoader(text) {
    if (text) loaderText.textContent = text;
    loaderOverlay.classList.add("show");
    // If we hold the main thread too long, animate the pulse + tick a counter
    // so the user perceives progress and the window keeps receiving paint.
  }
  function hideLoader() {
    loaderOverlay.classList.remove("show");
  }
  // Tick the loader elapsed time so the user sees live progress. This also
  // forces the renderer to paint, which keeps the host frame happy.
  const loaderStartedAt = { value: 0 };
  function startLoaderTimer() {
    stopLoaderTimer();
    loaderStartedAt.value = Date.now();
    loaderTimer = setInterval(() => {
      const secs = Math.max(0, Math.round((Date.now() - loaderStartedAt.value) / 1000));
      loaderText.textContent = loaderText.textContent.replace(/\s*\(.*\)\/s*$/, "");
      loaderText.setAttribute("data-elapsed", String(secs));
      // move the spinner label slightly so the text node updates and repaints
      loaderText.style.opacity = "1";
    }, 1000);
  }
  function stopLoaderTimer() {
    if (loaderTimer) {
      clearInterval(loaderTimer);
      loaderTimer = null;
    }
  }
  // Cooperative yield: lets pending paint/input be handled (deferred to next frame).
  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  // Double requestAnimationFrame: the first rAF schedules a paint, the second
  // fires AFTER that paint has been committed. This is the reliable way to be
  // sure the spinner overlay is actually visible on-screen before we begin the
  // heavy synchronous Cytoscape work that would otherwise block painting.
  function doubleRaf() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  }

  // ---- Cytoscape style ----
  const palette = [
    "#5B8FF9", "#5AD8A6", "#5D7092", "#F6BD16", "#E8684A",
    "#6DC8EC", "#9270CA", "#FF9D4D", "#269A99", "#FF99C3",
    "#BCE6FB", "#C2C8D5", "#EFE0B5", "#F6C3B7", "#D3C2EA",
  ];
  function colorForCommunity(c) {
    if (c === undefined || c === null || c === "") return "#9AA0A6";
    const n = typeof c === "number" ? c : String(c).charCodeAt(0);
    return palette[n % palette.length];
  }

  function buildElements(graph) {
    const nodes = (graph.nodes || []).map((n) => {
      const label = n.label || n.id;
      const kind = n.kind || n.type || "";
      const isJenkins = kind.startsWith("jenkins_") || String(n.id).startsWith("Jenkins");
      return {
        data: {
          id: n.id,
          label: typeof label === "string" ? label : String(label),
          kind,
          source_file: n.source_file || "",
          loc: n.loc || "",
          community: n.community,
          confidence: n.confidence || "",
          isJenkins: isJenkins,
          raw: n,
        },
      };
    });
    const nodeIds = new Set(nodes.map((n) => n.data.id));
    const edges = (graph.edges || [])
      .filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target))
      .map((e, i) => ({
        data: {
          id: `e${i}`,
          source: e.source,
          target: e.target,
          relation: e.relation || e.label || "",
          confidence: e.confidence || "",
        },
      }));
    return { nodes, edges };
  }

  function layoutConfig(name) {
    const common = { name, animate: false, fit: true, padding: 20 };
    switch (name) {
      case "circle":
        return { ...common, spacingFactor: 0.8 };
      case "grid":
        return { ...common, avoidOverlap: true, spacingFactor: 1.1, condense: true };
      case "concentric":
        return { ...common, concentric: (n) => n.degree(), minNodeSpacing: 8 };
      case "preset":
        return { ...common, positions: undefined };
      case "cose":
      default:
        return {
          name: "cose",
          animate: false,
          nodeRepulsion: () => 8000,
          idealEdgeLength: () => 60,
          nodeOverlap: 10,
          randomize: true,
          componentSpacing: 80,
          fit: true,
          padding: 20,
        };
    }
  }

  function initCytoscape(elements) {
    const container = document.getElementById("cy-container");
    if (cy) {
      cy.destroy();
      cy = null;
    }
    // NOTE: we intentionally pass `layout: { name: "preset" }` (no positions) so
    // the constructor does NOT run a heavy force-directed layout. Cytoscape runs
    // the layout passed to the constructor synchronously, which blocks the main
    // thread and triggers VS Code's "unresponsive webview" dialog on big graphs.
    // The real layout is run separately in switchView() AFTER the spinner paints.
    cy = cytoscape({
      container: container,
      elements: { nodes: elements.nodes, edges: elements.edges },
      style: [
        {
          selector: "node",
          style: {
            "label": "data(label)",
            "text-valign": "bottom",
            "text-halign": "center",
            "text-wrap": "ellipsis",
            "text-max-width": "100px",
            "font-size": "9px",
            "color": "#333",
            "background-color": (ele) => colorForCommunity(ele.data("community")),
            "width": (ele) => (ele.data("isJenkins") ? "26px" : "22px"),
            "height": (ele) => (ele.data("isJenkins") ? "26px" : "22px"),
            "shape": (ele) => (ele.data("isJenkins") ? "diamond" : "ellipse"),
            "border-width": "1px",
            "border-color": "#fff",
          },
        },
        {
          selector: "node:selected",
          style: { "border-width": "3px", "border-color": "#0a6f0a" },
        },
        {
          selector: "node.dimmed",
          style: { opacity: 0.15 },
        },
        {
          selector: "node.highlight",
          style: { "border-width": "3px", "border-color": "#ff6600" },
        },
        {
          selector: "edge",
          style: {
            "width": "1px",
            "line-color": "#bbb",
            "target-arrow-color": "#bbb",
            "target-arrow-shape": "triangle",
            "curve-style": "bezier",
            "arrow-scale": 0.7,
            opacity: 0.6,
          },
        },
        {
          selector: "edge.dimmed",
          style: { opacity: 0.05 },
        },
      ],
      // Cheap no-op layout for construction; real layout runs via runLayout() later.
      layout: { name: "preset" },
    });

    cy.on("tap", "node", (evt) => showInspector(evt.target.id()));
    cy.on("tap", (evt) => {
      if (evt.target === cy) clearInspector();
    });
    cy.on("dbltap", "node", (evt) => {
      const node = evt.target;
      const sf = node.data("source_file");
      const loc = node.data("loc");
      if (sf && !sf.startsWith("<")) {
        let line = null;
        const m = String(loc).match(/L?(\d+)/);
        if (m) line = m[1];
        vscode.postMessage({ type: "navigate", path: sf, line: line });
      }
    });
    graphInited = true;
  }

  // ---- Inspector (shared by both views) ----
  function showInspector(nodeId) {
    if (!lastGraph) return;
    const node = (lastGraph.nodes || []).find((n) => n.id === nodeId);
    if (!node) return;
    const d = node;
    const empty = document.getElementById("inspector-empty");
    const content = document.getElementById("inspector-content");
    empty.style.display = "none";
    content.style.display = "block";

    const rows = [
      ["Label", d.label || d.id],
      ["ID", d.id],
      ["Kind", d.kind || d.type || ""],
      ["Community", d.community === undefined ? "" : d.community],
      ["Source file", d.source_file || ""],
      ["LOC", d.loc || ""],
      ["Confidence", d.confidence || ""],
    ];
    let html = '<table class="props"><tbody>';
    for (const [k, v] of rows) {
      html += `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(String(v))}</td></tr>`;
    }
    html += "</tbody></table>";

    // Neighbors computed from raw graph (works in both views, no cy dependency)
    const neighbors = (lastGraph.edges || []).filter(
      (e) => e.source === nodeId || e.target === nodeId
    );
    html += `<h4>Neighbors (${neighbors.length})</h4>`;
    if (neighbors.length === 0) {
      html += '<div class="muted">none</div>';
    } else {
      html += '<ul class="nblist">';
      for (const e of neighbors) {
        const otherId = e.source === nodeId ? e.target : e.source;
        const otherNode = (lastGraph.nodes || []).find((n) => n.id === otherId);
        const rel = e.relation || e.label || "";
        const otherLabel = otherNode ? otherNode.label || otherNode.id : otherId;
        html += `<li><span class="rel">${escapeHtml(rel)}</span> ` +
          `<a class="nb" data-id="${escapeHtml(otherId)}">${escapeHtml(otherLabel)}</a></li>`;
      }
      html += "</ul>";
    }

    if (d.source_file && !String(d.source_file).startsWith("<")) {
      let line = null;
      const m = String(d.loc).match(/L?(\d+)/);
      if (m) line = m[1];
      html += `<button id="jumpBtn" data-path="${escapeHtml(d.source_file)}" data-line="${line || ""}">Open source at line</button>`;
    }

    content.innerHTML = html;

    const jumpBtn = document.getElementById("jumpBtn");
    if (jumpBtn) {
      jumpBtn.onclick = () => {
        vscode.postMessage({
          type: "navigate",
          path: jumpBtn.getAttribute("data-path"),
          line: jumpBtn.getAttribute("data-line") || null,
        });
      };
    }
    content.querySelectorAll("a.nb").forEach((a) => {
      a.onclick = () => {
        const id = a.getAttribute("data-id");
        if (id) showInspector(id);
      };
    });
  }

  function clearInspector() {
    document.getElementById("inspector-empty").style.display = "block";
    document.getElementById("inspector-content").style.display = "none";
    if (cy) cy.elements().unselect();
    document.querySelectorAll(".graph-row.selected").forEach((r) => r.classList.remove("selected"));
  }

  // ---- Table view (default: instant render) ----
  function renderTable() {
    const container = document.getElementById("table-container");
    if (!lastGraph) {
      container.innerHTML = '<div class="muted">No data.</div>';
      return;
    }
    const nodes = lastGraph.nodes || [];
    const edges = lastGraph.edges || [];
    const q = tableFilter.toLowerCase().trim();
    let filtered = nodes;
    if (q) {
      filtered = nodes.filter((n) =>
        String(n.label || n.id || "").toLowerCase().includes(q) ||
        String(n.id || "").toLowerCase().includes(q) ||
        String(n.kind || n.type || "").toLowerCase().includes(q) ||
        String(n.source_file || "").toLowerCase().includes(q)
      );
    }
    // Render top 500 rows for performance; user can filter to see more.
    const limit = 500;
    const shown = filtered.slice(0, limit);
    let html = `<div class="table-info">Showing ${shown.length} of ${filtered.length} nodes` +
      (filtered.length > limit ? ` (first ${limit}, filter to narrow)` : "") +
      ` &middot; ${edges.length} edges`;
    if (graphViewDisabled) {
      html += ` &middot; Graph view disabled (&gt; ${graphViewNodeLimit} nodes)`;
    }
    html += `</div>`;
    html += '<table class="nodes-table"><thead><tr>' +
      "<th>Label</th><th>Kind</th><th>Community</th><th>Source file</th><th>LOC</th>" +
      "</tr></thead><tbody>";
    for (const n of shown) {
      const id = escapeHtml(n.id);
      const label = escapeHtml(n.label || n.id);
      const kind = escapeHtml(n.kind || n.type || "");
      const comm = escapeHtml(n.community === undefined ? "" : String(n.community));
      const sf = escapeHtml(n.source_file || "");
      const loc = escapeHtml(n.loc || "");
      html += `<tr class="graph-row" data-id="${id}">` +
        `<td class="col-label">${label}</td><td>${kind}</td><td>${comm}</td>` +
        `<td class="col-sf">${sf}</td><td>${loc}</td></tr>`;
    }
    html += "</tbody></table>";
    container.innerHTML = html;

    container.querySelectorAll(".graph-row").forEach((row) => {
      row.onclick = () => {
        document.querySelectorAll(".graph-row.selected").forEach((r) => r.classList.remove("selected"));
        row.classList.add("selected");
        showInspector(row.getAttribute("data-id"));
      };
    });
  }

  // ---- View switching ----
  async function switchView(view) {
    if (view === "graph" && graphViewDisabled) {
      return;
    }
    currentView = view;
    const tableEl = document.getElementById("table-view");
    const graphEl = document.getElementById("graph-view");
    const layoutWrap = document.getElementById("layout-wrap");
    const fitBtn = document.getElementById("fitBtn");
    const tableBtn = document.getElementById("viewTableBtn");
    const graphBtn = document.getElementById("viewGraphBtn");
    if (view === "table") {
      tableEl.style.display = "block";
      graphEl.style.display = "none";
      layoutWrap.style.display = "none";
      fitBtn.style.display = "none";
      tableBtn.classList.add("active");
      graphBtn.classList.remove("active");
      renderTable();
      return;
    }
    // --- Graph view ---
    tableEl.style.display = "none";
    graphEl.style.display = "block";
    layoutWrap.style.display = "inline-flex";
    fitBtn.style.display = "";
    tableBtn.classList.remove("active");
    graphBtn.classList.add("active");

    if (!lastGraph) {
      // waiting on data; cytoscape inits when graph arrives.
      return;
    }

    // Show the loader FIRST, then guarantee it has painted (double-rAF) before
    // any heavy synchronous work begins. This is what keeps VS Code's
    // "unresponsive webview" dialog (Wait / Close / Keep Waiting) from firing.
    showLoader("Preparing graph elements...");
    startLoaderTimer();
    await doubleRaf(); // spinner is now actually on screen

    try {
      if (!graphInited) {
        showLoader(`Rendering ${lastGraph.nodes.length} nodes...`);
        await nextFrame();
        const els = buildElements(lastGraph);
        await delay(16); // break the long task so the host stays responsive
        // initCytoscape no longer runs a heavy layout in its constructor.
        initCytoscape(els);
        await delay(16);
      }
      if (cy) {
        showLoader(`Computing ${currentLayout} layout...`);
        // The layout run is the single heaviest step. Yield with double-rAF so
        // the loader label change is painted, then resize + run the layout.
        await doubleRaf();
        cy.resize();
        cy.layout(layoutConfig(currentLayout)).run();
      }
    } finally {
      hideLoader();
      stopLoaderTimer();
    }
  }

  // ---- Graph-only helpers ----
  function applySearch(query) {
    if (currentView === "table") {
      tableFilter = query;
      renderTable();
      return;
    }
    if (!cy || !lastGraph) return;
    const q = (query || "").toLowerCase().trim();
    if (!q) {
      cy.elements().removeClass("dimmed highlight");
      return;
    }
    cy.elements().removeClass("dimmed highlight").addClass("dimmed");
    const matches = cy.nodes().filter((n) => {
      const label = String(n.data("label") || "").toLowerCase();
      const id = String(n.id() || "").toLowerCase();
      const kind = String(n.data("kind") || "").toLowerCase();
      const sf = String(n.data("source_file") || "").toLowerCase();
      return label.includes(q) || id.includes(q) || kind.includes(q) || sf.includes(q);
    });
    matches.removeClass("dimmed").addClass("highlight");
    matches.neighborhood().removeClass("dimmed");
    if (matches.length > 0) {
      cy.animate({ center: { eles: matches }, zoom: 1.2 }, { duration: 300 });
    }
  }

  function updateStats(stats, graph) {
    const el = document.getElementById("stats");
    let text = "";
    if (stats && stats.nodes !== undefined) {
      text = `${stats.nodes} nodes | ${stats.edges} edges`;
      if (stats.communities !== undefined) text += ` | ${stats.communities} communities`;
      if (stats.built_at_commit) text += ` | commit: ${String(stats.built_at_commit).slice(0, 8)}`;
      if (stats.tag) text += ` | tag: ${stats.tag}`;
    } else if (graph) {
      text = `${graph.nodes.length} nodes | ${graph.edges.length} edges (no stats)`;
    }
    el.textContent = text;
  }

  function highlightNode(id) {
    if (currentView === "table") {
      // scroll table to node and select
      const row = document.querySelector(`.graph-row[data-id="${cssEscape(id)}"]`);
      if (row) {
        document.querySelectorAll(".graph-row.selected").forEach((r) => r.classList.remove("selected"));
        row.classList.add("selected");
        row.scrollIntoView({ block: "center" });
        showInspector(id);
      }
      return;
    }
    if (!cy) return;
    const n = cy.getElementById(id);
    if (n && n.length > 0) {
      cy.elements().removeClass("highlight").addClass("dimmed");
      n.removeClass("dimmed").addClass("highlight");
      n.neighborhood().removeClass("dimmed");
      cy.animate({ center: { eles: n }, zoom: 1.6 }, { duration: 400 });
    }
  }

  function findNodeBySourceFile(path, loc) {
    if (!lastGraph) return null;
    const base = path.split("/").pop();
    for (const n of lastGraph.nodes) {
      const sf = String(n.source_file || "");
      if (sf === path || sf.endsWith("/" + path) || sf.split("/").pop() === base) {
        return n.id;
      }
    }
    return null;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function cssEscape(s) {
    return String(s).replace(/[^a-zA-Z0-9_-]/g, (m) => "\\" + m);
  }

  function setGraphViewEnabled(enabled, nodeCount) {
    graphViewDisabled = !enabled;
    const graphBtn = document.getElementById("viewGraphBtn");
    if (enabled) {
      graphBtn.disabled = false;
      graphBtn.title = "Graph view (Cytoscape)";
    } else {
      graphBtn.disabled = true;
      graphBtn.title =
        `Graph view disabled (${nodeCount} nodes; limit is ${graphViewNodeLimit} for IDE performance)`;
      if (currentView === "graph") {
        switchView("table");
      }
    }
  }

  // ---- Wire up UI ----
  document.getElementById("refreshBtn").addEventListener("click", () => {
    vscode.postMessage({ type: "refresh" });
  });
  document.getElementById("fitBtn").addEventListener("click", () => {
    if (cy) cy.animate({ fit: { eles: cy.elements(), padding: 20 } }, { duration: 200 });
  });
  document.getElementById("viewTableBtn").addEventListener("click", () => switchView("table"));
  document.getElementById("viewGraphBtn").addEventListener("click", () => {
    if (!graphViewDisabled) {
      switchView("graph");
    }
  });
  const layoutSelect = document.getElementById("layoutSelect");
  layoutSelect.addEventListener("change", (e) => {
    currentLayout = e.target.value;
    if (currentView === "graph" && cy) {
      // Re-running a layout is heavy too; show loader + double-rAF to stay responsive.
      showLoader(`Computing ${currentLayout} layout...`);
      startLoaderTimer();
      doubleRaf().then(() => {
        try {
          cy.layout(layoutConfig(currentLayout)).run();
        } finally {
          hideLoader();
          stopLoaderTimer();
        }
      });
    }
  });
  let searchTimer = null;
  document.getElementById("search").addEventListener("input", (e) => {
    const q = e.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => applySearch(q), 200);
  });

  // ---- Receive messages from extension host ----
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg) return;
    if (msg.type === "loading") {
      document.getElementById("stats").textContent = `Loading graph for ${msg.tag}...`;
      document.getElementById("table-container").innerHTML =
        '<div class="muted">Loading...</div>';
      document.getElementById("viewGraphBtn").disabled = true;
      clearInspector();
      // Keep any graph-render loader hidden during data fetch; it's for Cytoscape work only.
      hideLoader();
      stopLoaderTimer();
    } else if (msg.type === "graph") {
      lastGraph = msg.graph;
      lastStats = msg.stats;
      graphInited = false; // reset so graph view rebuilds with new data
      if (typeof msg.graphViewNodeLimit === "number") {
        graphViewNodeLimit = msg.graphViewNodeLimit;
      }
      const nodeCount =
        msg.nodeCount !== undefined
          ? msg.nodeCount
          : msg.stats && msg.stats.nodes !== undefined
            ? msg.stats.nodes
            : (msg.graph.nodes || []).length;
      const disableGraph =
        msg.graphViewDisabled === true || nodeCount > graphViewNodeLimit;
      setGraphViewEnabled(!disableGraph, nodeCount);
      updateStats(msg.stats, msg.graph);
      // Large graphs stay in table view only; smaller graphs also open in table first.
      hideLoader();
      stopLoaderTimer();
      switchView("table");
      // Reset cy if it was open
      if (cy) { cy.destroy(); cy = null; }
      if (msg.highlight) {
        const id = findNodeBySourceFile(msg.highlight);
        if (id) setTimeout(() => highlightNode(id), 400);
      }
    } else if (msg.type === "error") {
      hideLoader();
      stopLoaderTimer();
      document.getElementById("stats").textContent = `Error: ${msg.error}`;
      document.getElementById("table-container").innerHTML =
        `<div class="error">Error: ${escapeHtml(msg.error)}</div>`;
    }
  });
})();
