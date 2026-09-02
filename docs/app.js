/* SME Digital & AI Readiness - page logic.
 *
 * Reads the curated bundle written by build_site.py. Three invariants from the
 * data layer are enforced here rather than assumed:
 *
 *   1. EU27_2020 is Eurostat's own published aggregate. It is displayed, never
 *      recomputed - a mean of the member states is a different number, and a
 *      reader who checks it against Eurostat must find ours matching.
 *   2. Only a unit that is a share of all enterprises may be weighted by
 *      enterprise_count, and only where a count exists (2021-2024). Anywhere
 *      that fails, the aggregate falls back to an unweighted mean and says so.
 *   3. Neither breakdown is a partition. Size bands overlap (SME_10_249 holds
 *      SMALL_10_49); so do the individual cuts (IND_TOTAL holds every age).
 *      The page warns whenever the selected pair is not mutually exclusive.
 *
 * Both views share one shape: a *primary* band compared against a *comparison*
 * band. In the Companies view those are enterprise size classes; in the
 * Individuals view they are age bands. Everything downstream is generic over
 * that choice, which is why the two views need only one set of renderers.
 */

const REF_GEO = "EU27_2020";
const MAX_COMPARE = 4;
const SERIES_SLOTS = ["--series-1", "--series-2", "--series-3", "--series-4"];
const ORDINAL_SLOTS = [
  "--ordinal-1", "--ordinal-2", "--ordinal-3",
  "--ordinal-4", "--ordinal-5", "--ordinal-6",
];

const SIZE_ORDER = ["SMALL_10_49", "MEDIUM_50_249", "LARGE_GE250", "SME_10_249", "ALL_GE10"];
const AGE_ORDER = ["IND_TOTAL", "Y16_24", "Y25_34", "Y35_44", "Y45_54", "Y55_64", "Y65_74"];
const EDU_ORDER = ["I0_2", "I3_4", "I5_8"];

/* Which band contains which. Used to warn when the selected pair overlaps -
 * SME_10_249 against SMALL_10_49 is not a comparison, it is a part against its
 * whole, and the same is true of IND_TOTAL against any single age band. */
const CONTAINS = {
  ALL_GE10: ["SMALL_10_49", "MEDIUM_50_249", "LARGE_GE250", "SME_10_249"],
  SME_10_249: ["SMALL_10_49", "MEDIUM_50_249"],
  IND_TOTAL: AGE_ORDER.filter((c) => c !== "IND_TOTAL").concat(EDU_ORDER),
};

const state = {
  view: "firm",
  geos: ["IT"],
  agg: "none",                                          // none | weighted | unweighted
  firm: { primary: "SMALL_10_49", compare: "LARGE_GE250" },
  individual: { primary: "Y25_34", compare: "Y55_64" },
};

let SERIES = {};
let LABELS = {};
let META = {};
const tooltip = document.createElement("div");
let gradientSeq = 0;

/* --- data access -------------------------------------------------------- */

/** Rehydrate a chart's positional rows into objects, once, on first use. */
function rows(chartId) {
  const chart = SERIES[chartId];
  if (!chart._objects) {
    chart._objects = chart.rows.map((row) => {
      const obj = {};
      chart.columns.forEach((col, i) => { obj[col] = row[i]; });
      return obj;
    });
  }
  return chart._objects;
}

function where(chartId, filter) {
  return rows(chartId).filter((r) =>
    Object.entries(filter).every(([k, v]) =>
      Array.isArray(v) ? v.includes(r[k]) : v === undefined || r[k] === v));
}

function yearsOf(chartId, filter = {}) {
  return [...new Set(where(chartId, filter).map((r) => r.time))].sort();
}

const latestYear = (chartId, filter) => yearsOf(chartId, filter).slice(-1)[0];

function label(kind, code) {
  const entry = LABELS[kind]?.[code];
  if (entry === undefined) return code;
  return typeof entry === "string" ? entry : entry.label;
}

/** Size-band labels read better without Eurostat's trailing boilerplate. */
const bandLabel = (code) => label("size_emp", code).replace(" persons employed", "");
const cutLabel = (code) => LABELS.ind_type?.[code]?.label ?? code;

/** The base population a unit's percentage is a share of - shown in every tooltip. */
function unitNoteFor(unitCode) {
  const entry = LABELS.unit?.[unitCode];
  if (!entry) return unitCode;
  return entry.base ? `${entry.label} · base: ${entry.base.replace(/_/g, " ")}` : entry.label;
}

/* Eurostat's indicator labels are full sentences, which makes an axis of them
 * unreadable. Strip the shared stem so the axis carries only what differs; the
 * tooltip and the table keep the full wording. */
const LABEL_STEMS = [
  /^Enterprises do not use AI technologies, because( of)?\s*/i,
  /^Enterprises using AI technologies for\s*/i,
  /^Enterprises with at least basic level of\s*/i,
  /^Individuals with\s*/i,
  /^Use of generative AI tools:\s*/i,
  /^Enterprises? (which |that )?/i,
  /^Enterprise /i,
];

function shortLabel(full, cap = 52) {
  let out = full;
  for (const stem of LABEL_STEMS) {
    const next = out.replace(stem, "");
    if (next !== out) { out = next; break; }
  }
  out = out.replace(/\s*\([^)]*\)\s*$/, "").trim();
  out = out.charAt(0).toUpperCase() + out.slice(1);
  return out.length > cap ? `${out.slice(0, cap - 1)}…` : out;
}

/* --- the active breakdown ----------------------------------------------- */

/**
 * The dimension the current view compares along. `field` is the column the
 * charts filter on, which is the only thing that differs between an enterprise
 * size class and a person's age band.
 */
const DIMENSIONS = {
  firm: {
    control: "Size band", field: "size_emp",
    options: SIZE_ORDER, labelOf: bandLabel,
    clean: "10–49, 50–249 and 250+",
  },
  individual: {
    control: "Age band", field: "ind_type",
    options: AGE_ORDER, labelOf: cutLabel,
    clean: "any two of the six age bands",
  },
};

const dim = () => DIMENSIONS[state.view];
const sel = () => state[state.view];

/** The two bands the view is currently comparing, de-duplicated. */
function bandPair() {
  const { primary, compare } = sel();
  return [primary, compare].filter((b, i, a) => a.indexOf(b) === i);
}

/** True when one band contains the other, so the pair is not a clean comparison. */
function bandsOverlap(a, b) {
  if (a === b) return true;
  return (CONTAINS[a] || []).includes(b) || (CONTAINS[b] || []).includes(a);
}

function overlapWarning() {
  const { primary, compare } = sel();
  if (!bandsOverlap(primary, compare)) return null;
  const d = dim();
  if (primary === compare) return "Both bands are the same, so only one series is shown.";
  return `${d.control}s overlap: ${d.labelOf(primary)} and ${d.labelOf(compare)} are not `
    + `mutually exclusive, so one contains the other. Pick ${d.clean} for a clean comparison.`;
}

/* --- aggregation -------------------------------------------------------- */

/**
 * Combine one value per geo into a single figure.
 *
 * `weighted` reports what actually happened, not what was requested: a missing
 * enterprise_count silently downgrades the arithmetic, so the caller must be
 * able to label the result honestly.
 */
function aggregate(records, mode, chartWeightable) {
  if (!records.length) return null;
  if (records.length === 1) {
    return { value: records[0].value, weighted: false, degraded: false, n: 1 };
  }
  const counts = records.map((r) => r.enterprise_count);
  const weightable = mode === "weighted" && chartWeightable
    && counts.every((c) => typeof c === "number" && c > 0);

  if (weightable) {
    const total = counts.reduce((a, b) => a + b, 0);
    const value = records.reduce((acc, r) => acc + r.value * r.enterprise_count, 0) / total;
    return { value, weighted: true, degraded: false, n: records.length };
  }
  const value = records.reduce((acc, r) => acc + r.value, 0) / records.length;
  return { value, weighted: false, degraded: mode === "weighted", n: records.length };
}

function focusValue(chartId, filter) {
  const records = where(chartId, { ...filter, geo: state.geos });
  if (state.geos.length === 1 || state.agg === "none") {
    const hit = records.find((r) => r.geo === state.geos[0]);
    return hit ? { value: hit.value, weighted: false, degraded: false, n: 1 } : null;
  }
  return aggregate(records, state.agg, SERIES[chartId].weightable === true);
}

function focusLabel(chartId) {
  if (state.geos.length === 1 || state.agg === "none") return label("geo", state.geos[0]);
  const canWeight = chartId ? SERIES[chartId].weightable === true : true;
  const how = state.agg === "weighted" && canWeight ? "weighted" : "unweighted";
  return `${state.geos.length} countries (${how} avg)`;
}

/** Read one value on the active breakdown - the single call every chart shares. */
const bandValue = (chartId, indicator, band, time) =>
  focusValue(chartId, { indicator, [dim().field]: band, time })?.value ?? null;

/* --- small helpers ------------------------------------------------------ */

const fmt = (v, digits = 1) => (v === null || v === undefined ? "n/a" : v.toFixed(digits));

/**
 * An axis scale whose ticks are round numbers.
 *
 * Rounding the maximum alone is not enough - a "nice" max of 75 still divides
 * into quarters of 18.75. Round the *step* instead and let the max follow.
 */
function niceScale(value, tickCount = 4) {
  const raw = Math.max(value, 1) / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 1.5, 2, 2.5, 3, 5, 10].find((s) => raw <= s * magnitude) ?? 10) * magnitude;
  return { max: step * tickCount, step };
}

/** EU27_2020's full label is 38 characters and blows out every axis gutter. */
const shortGeo = (code) => (code === REF_GEO ? "EU27" : label("geo", code));

const SVG_TAGS = new Set([
  "svg", "g", "rect", "line", "path", "text", "circle", "polyline",
  "defs", "linearGradient", "stop", "title",
]);

function el(tag, attrs = {}, children = []) {
  const node = SVG_TAGS.has(tag)
    ? document.createElementNS("http://www.w3.org/2000/svg", tag)
    : document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  (Array.isArray(children) ? children : [children]).forEach((c) => c && node.appendChild(c));
  return node;
}

/**
 * A flat fill reads as a block; a shallow ramp along the mark's own hue gives it
 * form without adding a second colour or a second meaning. Stops stay inside one
 * hue and never cross a palette slot, so identity is untouched.
 */
function gradientFill(svg, color, { vertical = false, from = 1, to = 0.68 } = {}) {
  const id = `g${++gradientSeq}`;
  let defs = svg.querySelector("defs");
  if (!defs) { defs = el("defs"); svg.insertBefore(defs, svg.firstChild); }
  const grad = el("linearGradient", {
    id, x1: 0, y1: 0, x2: vertical ? 0 : 1, y2: vertical ? 1 : 0,
  });
  grad.appendChild(el("stop", { offset: "0%", "stop-color": color, "stop-opacity": from }));
  grad.appendChild(el("stop", { offset: "100%", "stop-color": color, "stop-opacity": to }));
  defs.appendChild(grad);
  return `url(#${id})`;
}

function showTip(evt, html) {
  tooltip.innerHTML = html;
  tooltip.style.opacity = "1";
  const pad = 14;
  tooltip.style.left = `${Math.min(evt.clientX + pad, window.innerWidth - tooltip.offsetWidth - 8)}px`;
  tooltip.style.top = `${Math.max(8, evt.clientY - tooltip.offsetHeight - pad)}px`;
}
const hideTip = () => { tooltip.style.opacity = "0"; };

/**
 * `dim` marks the node as a data mark, which the sibling-dimming hover rule
 * acts on. Axis labels want the tooltip without the dimming, so they pass false.
 */
function attachTip(node, html, dim = true) {
  if (dim) node.classList.add("mark");
  node.addEventListener("mousemove", (e) => showTip(e, html));
  node.addEventListener("mouseleave", hideTip);
}

const tipRow = (color, text) =>
  `<div class="tt-row"><span class="swatch" style="background:${color}"></span>${text}</div>`;

/* --- chart primitives --------------------------------------------------- */

/** Horizontal ranked bars. One series, so one colour; `highlight` lifts members. */
function rankedBars(container, items, { unitNote }) {
  const rowH = 22, padL = 150, padR = 58, padT = 8;
  const height = items.length * rowH + padT + 18;
  const width = 780, plotW = width - padL - padR;
  const { max } = niceScale(Math.max(...items.map((d) => d.value), 1));
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  const fillMain = gradientFill(svg, `var(${SERIES_SLOTS[0]})`);
  const fillRef = gradientFill(svg, "var(--ink-muted)");

  [0, 0.25, 0.5, 0.75, 1].forEach((t) => {
    const x = padL + t * plotW;
    svg.appendChild(el("line", { x1: x, x2: x, y1: padT, y2: height - 18, class: "grid-line" }));
    svg.appendChild(el("text", {
      x, y: height - 4, class: "tick-label", "text-anchor": "middle",
      text: `${+(t * max).toFixed(1)}%`,
    }));
  });

  items.forEach((d, i) => {
    const y = padT + i * rowH;
    const w = Math.max(2, (d.value / max) * plotW);
    const bar = el("rect", {
      x: padL, y: y + 4, width: w, height: rowH - 10, rx: 4,
      class: "bar-x", fill: d.reference ? fillRef : fillMain,
      "fill-opacity": d.highlight || d.reference ? 1 : 0.4,
      style: `animation-delay:${Math.min(i * 3, 90)}ms`,
    });
    attachTip(bar, `<div class="tt-title">${d.label}</div>
      ${tipRow(d.reference ? "var(--ink-muted)" : `var(${SERIES_SLOTS[0]})`, `${fmt(d.value)}%`)}
      <div class="tt-base">${unitNote}</div>`);
    svg.appendChild(bar);
    svg.appendChild(el("text", {
      x: padL - 10, y: y + rowH / 2 + 1, class: "cat-label", "text-anchor": "end",
      "font-weight": d.highlight || d.reference ? 600 : 400, text: d.label,
    }));
    if (d.highlight || d.reference) {
      svg.appendChild(el("text", {
        x: padL + w + 8, y: y + rowH / 2 + 1, class: "value-label", text: `${fmt(d.value)}%`,
      }));
    }
  });
  container.appendChild(svg);
}

/** Grouped horizontal bars - the primary band against its comparison band. */
function groupedBars(container, categories, series, { unitNote }) {
  const groupH = 22 + series.length * 16, padL = 292, padR = 62, padT = 8;
  const height = categories.length * groupH + padT + 22;
  const width = 900, plotW = width - padL - padR;
  const { max } = niceScale(Math.max(...series.flatMap((s) => s.values.map((v) => v ?? 0)), 1), 2);
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  const fills = series.map((s) => gradientFill(svg, `var(${s.slot})`));

  [0, 0.5, 1].forEach((t) => {
    const x = padL + t * plotW;
    svg.appendChild(el("line", { x1: x, x2: x, y1: padT, y2: height - 22, class: "grid-line" }));
    svg.appendChild(el("text", {
      x, y: height - 6, class: "tick-label", "text-anchor": "middle",
      text: `${+(t * max).toFixed(1)}%`,
    }));
  });

  categories.forEach((cat, i) => {
    const top = padT + i * groupH;
    const tip = `<div class="tt-title">${cat.label}</div>
      ${series.map((o) => o.values[i] === null ? ""
        : tipRow(`var(${o.slot})`, `${o.label}: ${fmt(o.values[i])}%`)).join("")}
      <div class="tt-base">${unitNote}</div>`;

    // The label carries the same tooltip as the bars, so a name clipped to fit
    // the gutter is still readable - hovering it, or the row, gives the full
    // wording. A dotted rule marks the ones that are actually clipped, since a
    // cursor change alone is invisible in a screenshot.
    // Not `short !== label`: shortLabel also strips Eurostat's shared sentence
    // stem, so the two differ on rows that were never clipped. The ellipsis is
    // the only reliable signal that wording was actually lost.
    const clipped = cat.short.endsWith("…");
    const labelNode = el("text", {
      x: padL - 14, y: top + groupH / 2, "text-anchor": "end", text: cat.short,
      class: `cat-label${clipped ? " clipped" : ""}`,
    });
    labelNode.appendChild(el("title", { text: cat.label }));
    attachTip(labelNode, tip, false);
    svg.appendChild(labelNode);

    series.forEach((s, j) => {
      const v = s.values[i];
      if (v === null || v === undefined) return;
      // 2px surface gap between adjacent fills rather than a stroke around them.
      const y = top + 9 + j * 16;
      const w = Math.max(2, (v / max) * plotW);
      const bar = el("rect", {
        x: padL, y, width: w, height: 14, rx: 4, fill: fills[j], class: "bar-x",
        style: `animation-delay:${Math.min(i * 12 + j * 6, 90)}ms`,
      });
      attachTip(bar, tip);
      svg.appendChild(bar);
      svg.appendChild(el("text", {
        x: padL + w + 8, y: y + 11, class: "value-label", text: `${fmt(v, 0)}%`,
      }));
    });
  });
  container.appendChild(svg);
  container.appendChild(legend(series));
}

/** Multi-line trend. Endpoints are direct-labelled; no number on every point. */
function lineChart(container, xs, series, { unitNote }) {
  const padL = 46, padR = 132, padT = 16, padB = 30;
  const width = 880, height = 320;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const { max } = niceScale(Math.max(...series.flatMap((s) => s.points.map((p) => p.y ?? 0)), 10));
  const x = (i) => padL + (xs.length === 1 ? plotW / 2 : (i / (xs.length - 1)) * plotW);
  const y = (v) => padT + plotH - (v / max) * plotH;
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });

  for (let t = 0; t <= 4; t++) {
    const gy = padT + (t / 4) * plotH;
    svg.appendChild(el("line", { x1: padL, x2: padL + plotW, y1: gy, y2: gy, class: "grid-line" }));
    svg.appendChild(el("text", {
      x: padL - 9, y: gy + 4, class: "tick-label", "text-anchor": "end",
      text: `${+(max - (t / 4) * max).toFixed(1)}%`,
    }));
  }
  xs.forEach((xv, i) => svg.appendChild(el("text", {
    x: x(i), y: height - 9, class: "tick-label", "text-anchor": "middle", text: xv,
  })));

  const endLabels = [];
  series.forEach((s, si) => {
    const stroke = s.reference ? "var(--ink-muted)" : `var(${s.slot})`;
    const pts = s.points.map((p, i) => (p.y === null ? null : [x(i), y(p.y)])).filter(Boolean);
    if (!pts.length) return;

    // Only the leading series gets an area wash - one filled shape reads as
    // emphasis, several stacked washes read as mud.
    if (si === 0 && !s.reference && pts.length > 1) {
      const area = gradientFill(svg, stroke, { vertical: true, from: 0.2, to: 0 });
      svg.appendChild(el("path", {
        d: `M${pts[0][0]},${padT + plotH} `
          + pts.map((p) => `L${p[0]},${p[1]} `).join("")
          + `L${pts[pts.length - 1][0]},${padT + plotH} Z`,
        fill: area, stroke: "none",
      }));
    }

    svg.appendChild(el("polyline", {
      points: pts.map((p) => p.join(",")).join(" "),
      fill: "none", stroke, "stroke-width": 2,
      "stroke-linejoin": "round", "stroke-linecap": "round",
    }));
    s.points.forEach((p, i) => {
      if (p.y === null) return;
      // 2px surface ring so overlapping markers stay readable.
      const dot = el("circle", {
        cx: x(i), cy: y(p.y), r: 4.5, fill: stroke,
        stroke: "var(--surface)", "stroke-width": 2,
      });
      attachTip(dot, `<div class="tt-title">${xs[i]}</div>
        ${series.map((o) => o.points[i]?.y === null || o.points[i] === undefined ? ""
          : tipRow(o.reference ? "var(--ink-muted)" : `var(${o.slot})`,
                   `${o.label}: ${fmt(o.points[i].y)}%`)).join("")}
        <div class="tt-base">${unitNote}</div>`);
      svg.appendChild(dot);
    });
    const last = s.points.map((p, i) => [p, i]).filter(([p]) => p.y !== null).pop();
    if (last) endLabels.push({ x: x(last[1]) + 11, y: y(last[0].y) + 4, text: s.label, fill: stroke });
  });

  // Endpoint labels sit at the series' own height, which collides whenever two
  // lines finish close together. Push them apart rather than letting them stack.
  const MIN_GAP = 15;
  endLabels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < endLabels.length; i++) {
    const overlap = endLabels[i - 1].y + MIN_GAP - endLabels[i].y;
    if (overlap > 0) endLabels[i].y += overlap;
  }
  endLabels.forEach((l) => svg.appendChild(el("text", {
    x: l.x, y: l.y, class: "series-label", fill: l.fill, text: l.text,
  })));

  container.appendChild(svg);
  container.appendChild(legend(series));
}

/** Ordered categories (age bands, education levels) get the ordinal ramp. */
function ordinalBars(container, items, { unitNote, highlight = [] }) {
  // A fixed coordinate space, with bars sized to fit inside it. Scaling the
  // viewBox with the item count would make a three-bar chart render its text
  // three times larger than a six-bar one on the same page.
  const width = 880, height = 236, baseline = 180;
  const slotW = width / Math.max(items.length, 1);
  const barW = Math.min(slotW - 26, 104);
  const { max } = niceScale(Math.max(...items.map((d) => d.value ?? 0), 1));
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });

  items.forEach((d, i) => {
    const cx = i * slotW + slotW / 2;
    const isPicked = highlight.includes(d.code);
    if (d.value !== null && d.value !== undefined) {
      const h = (d.value / max) * (baseline - 40);
      const color = `var(${ORDINAL_SLOTS[Math.min(i, ORDINAL_SLOTS.length - 1)]})`;
      const bar = el("rect", {
        x: cx - barW / 2, y: baseline - h, width: barW, height: h, rx: 5,
        class: "bar-y", fill: gradientFill(svg, color, { vertical: true, from: 1, to: 0.74 }),
        "fill-opacity": highlight.length && !isPicked ? 0.45 : 1,
        style: `animation-delay:${Math.min(i * 22, 110)}ms`,
      });
      attachTip(bar, `<div class="tt-title">${d.label}</div>
        ${tipRow(color, `${fmt(d.value)}%`)}<div class="tt-base">${unitNote}</div>`);
      svg.appendChild(bar);
      svg.appendChild(el("text", {
        x: cx, y: baseline - h - 9, class: "value-label", "text-anchor": "middle",
        text: `${fmt(d.value, 0)}%`,
      }));
    }
    svg.appendChild(el("text", {
      x: cx, y: baseline + 21, class: "cat-label", "text-anchor": "middle",
      "font-weight": isPicked ? 600 : 400, text: d.label,
    }));
  });
  svg.appendChild(el("line", { x1: 0, x2: width, y1: baseline, y2: baseline, class: "axis-line" }));
  container.appendChild(svg);
}

function legend(series) {
  const ul = el("ul", { class: "legend" });
  series.forEach((s) => {
    const li = el("li");
    li.appendChild(el("span", {
      class: "swatch",
      style: `background: ${s.reference ? "var(--ink-muted)" : `var(${s.slot})`}`,
    }));
    li.appendChild(el("span", { text: s.label }));
    ul.appendChild(li);
  });
  return ul;
}

/* --- card shell --------------------------------------------------------- */

/**
 * Every chart ships with a table view. Three light-mode palette slots sit below
 * 3:1 on the surface, and the relief rule for those is a readable table.
 */
function card(parent, { title, note, warn, draw, table }) {
  const box = el("div", { class: "card" });
  const head = el("div", { class: "card-head" });
  head.appendChild(el("h3", { class: "card-title", text: title }));
  const toggle = el("button", { class: "table-toggle", type: "button", text: "Show data" });
  head.appendChild(toggle);
  box.appendChild(head);
  if (note) box.appendChild(el("p", { class: "card-note", text: note }));
  if (warn) box.appendChild(el("p", { class: "card-warn", text: warn }));

  const chart = el("div", { class: "chart" });
  box.appendChild(chart);
  draw(chart);

  let tableNode = null;
  toggle.addEventListener("click", () => {
    if (tableNode) {
      tableNode.remove();
      tableNode = null;
      toggle.textContent = "Show data";
      return;
    }
    tableNode = renderTable(table());
    box.appendChild(tableNode);
    toggle.textContent = "Hide data";
  });
  parent.appendChild(box);
}

function renderTable({ columns, rows: body }) {
  const t = el("table", { class: "data" });
  const headRow = el("tr");
  columns.forEach((c) => headRow.appendChild(el("th", { text: c })));
  t.appendChild(el("thead", {}, headRow));
  const tbody = el("tbody");
  body.forEach((r) => {
    const tr = el("tr");
    r.forEach((cell, i) => tr.appendChild(el("td", {
      class: i > 0 ? "num" : "", text: cell === null || cell === undefined ? "n/a" : String(cell),
    })));
    tbody.appendChild(tr);
  });
  t.appendChild(tbody);
  return t;
}

/* --- generic section renderers ------------------------------------------ */

/** Headline tiles: the primary band, the comparison band, the multiple, EU27. */
function headlineTiles(root, { chartId, indicator }) {
  const d = dim();
  const year = latestYear(chartId, { indicator });
  const { primary, compare } = sel();
  const pv = bandValue(chartId, indicator, primary, year);
  const cv = bandValue(chartId, indicator, compare, year);
  const ref = where(chartId, {
    indicator, [d.field]: primary, time: year, geo: REF_GEO,
  })[0];

  const tiles = el("div", { class: "tiles" });
  const tile = (k, v, sub, cls, accent) => {
    const node = el("div", {
      class: `tile${cls ? ` ${cls}` : ""}`,
      style: accent ? `--tile-accent: var(${accent})` : null,
    });
    node.appendChild(el("div", { class: "k", text: k }));
    node.appendChild(el("div", { class: "v", text: v }));
    node.appendChild(el("div", { class: "sub", text: sub }));
    return node;
  };
  const who = `${focusLabel(chartId)}, ${year}`;
  tiles.appendChild(tile(d.labelOf(primary), `${fmt(pv)}%`, who, "accent", SERIES_SLOTS[0]));
  tiles.appendChild(tile(d.labelOf(compare), `${fmt(cv)}%`, who, "compare", SERIES_SLOTS[1]));
  const multiple = pv && cv ? cv / pv : null;
  tiles.appendChild(tile("The gap", multiple ? `${multiple.toFixed(1)}x` : "n/a",
    `${d.labelOf(compare)} vs ${d.labelOf(primary)}`));
  tiles.appendChild(tile("EU27 benchmark", `${fmt(ref?.value)}%`,
    `Eurostat's published aggregate · ${d.labelOf(primary)}`));
  root.appendChild(tiles);

  const degraded = focusValue(chartId, { indicator, [d.field]: primary, time: year })?.degraded;
  if (degraded) {
    root.appendChild(el("p", { class: "card-warn", text:
      "Weighted average unavailable for this year — no enterprise count in the universe table, so an unweighted country mean is shown." }));
  }
}

/** Trend over time for both bands, with EU27 on the primary band as reference. */
function trendCard(root, { chartId, indicator, title, note }) {
  const d = dim();
  const unitNote = unitNoteFor(SERIES[chartId].unit);
  const xs = yearsOf(chartId, { indicator });
  const bands = bandPair();
  const eu = (t) => where(chartId, {
    indicator, [d.field]: sel().primary, time: t, geo: REF_GEO,
  })[0]?.value ?? null;

  card(root, {
    title: `${title} — ${focusLabel(chartId)}`,
    note, warn: overlapWarning(),
    draw: (c) => lineChart(c, xs, [
      ...bands.map((band, i) => ({
        label: d.labelOf(band), slot: SERIES_SLOTS[i],
        points: xs.map((t) => ({ y: bandValue(chartId, indicator, band, t) })),
      })),
      { label: `EU27 · ${d.labelOf(sel().primary)}`, reference: true,
        points: xs.map((t) => ({ y: eu(t) })) },
    ], { unitNote }),
    table: () => ({
      columns: ["Year", ...bands.map(d.labelOf), "EU27"],
      rows: xs.map((t) => [t, ...bands.map((b) => fmt(bandValue(chartId, indicator, b, t))), fmt(eu(t))]),
    }),
  });
}

/** Every country ranked on one indicator, for the primary band. */
function rankingCard(root, { chartId, indicator, title, note }) {
  const d = dim();
  const unitNote = unitNoteFor(SERIES[chartId].unit);
  const year = latestYear(chartId, { indicator });
  const build = () => where(chartId, { indicator, [d.field]: sel().primary, time: year })
    .map((r) => ({
      code: r.geo, label: shortGeo(r.geo), value: r.value,
      highlight: state.geos.includes(r.geo), reference: r.geo === REF_GEO,
    }))
    .sort((a, b) => b.value - a.value);

  card(root, {
    title: `${title} — ${d.labelOf(sel().primary)}, ${year}`,
    note,
    draw: (c) => rankedBars(c, build(), { unitNote }),
    table: () => ({ columns: ["Country", "%"], rows: build().map((x) => [x.label, fmt(x.value)]) }),
  });
}

/** Several indicators, primary band against comparison band. */
function comparisonCard(root, chartId, { title, note, indicators }) {
  const d = dim();
  const chart = SERIES[chartId];
  const unitNote = unitNoteFor(chart.unit);
  const codes = indicators || chart.indicators;
  const year = latestYear(chartId, {});
  const bands = bandPair().map((code, i) => ({ code, slot: SERIES_SLOTS[i] }));

  // An indicator the survey skipped this year would otherwise render as a
  // labelled row with no bar, which reads as "zero" rather than "not asked".
  const categories = codes
    .map((code) => {
      const full = label("indicator", code);
      // 46 chars is what fits the 292px label gutter at 12px; longer runs off
      // the left edge of the plot. The tooltip and table keep the full wording.
      return { code, label: full, short: shortLabel(full, 46) };
    })
    .filter((cat) => bands.some((b) => bandValue(chartId, cat.code, b.code, year) !== null));

  // Rows run in descending order of the EU27 figure, not of the selected
  // country's. Sorting on the selection would reshuffle the rows every time the
  // reader switches country, which makes two screenshots impossible to compare;
  // the aggregate keeps the running order fixed while the bars move. Anything
  // EU27 does not report sorts last rather than to the top on a null.
  const euValue = (code) => where(chartId, {
    indicator: code, [d.field]: sel().primary, time: year, geo: REF_GEO,
  })[0]?.value ?? -1;
  categories.sort((a, b) => euValue(b.code) - euValue(a.code));

  const series = bands.map((b) => ({
    label: d.labelOf(b.code), slot: b.slot,
    values: categories.map((cat) => bandValue(chartId, cat.code, b.code, year)),
  }));

  card(root, {
    title: `${title} — ${focusLabel(chartId)}, ${year}`,
    note: `${note} Rows are ordered by the EU27 figure for ${d.labelOf(sel().primary)}, so changing country moves the bars but never the row order.`,
    warn: overlapWarning(),
    draw: (c) => groupedBars(c, categories, series, { unitNote }),
    table: () => ({
      columns: ["Indicator", ...series.map((s) => s.label)],
      rows: categories.map((cat, i) => [cat.label, ...series.map((s) => fmt(s.values[i]))]),
    }),
  });
}

/** One indicator across an ordered set of bands, with the selection emphasised. */
function ordinalCard(root, { chartId, indicator, options, title, note, kindLabel }) {
  const d = dim();
  const unitNote = unitNoteFor(SERIES[chartId].unit);
  const year = latestYear(chartId, { indicator });
  const items = options.map((code) => ({
    code, label: d.labelOf(code),
    value: focusValue(chartId, { indicator, [d.field]: code, time: year })?.value ?? null,
  }));
  const picked = options.includes(sel().primary) ? bandPair() : [];

  card(root, {
    title: `${title} — ${focusLabel(chartId)}, ${year}`,
    note,
    draw: (c) => ordinalBars(c, items, { unitNote, highlight: picked }),
    table: () => ({
      columns: [kindLabel, "%"], rows: items.map((x) => [x.label, fmt(x.value)]),
    }),
  });
}

function renderMethodology(root) {
  const list = el("ul", { class: "caveats" });
  META.caveats.forEach((c) => list.appendChild(el("li", { text: c })));
  root.appendChild(list);

  const sources = el("p", { class: "sources" });
  sources.appendChild(el("strong", { text: "Sources: " }));
  const seen = new Set();
  Object.values(META.sources).flat().forEach((s) => {
    if (seen.has(s.code)) return;
    seen.add(s.code);
    if (seen.size > 1) sources.appendChild(document.createTextNode(" · "));
    sources.appendChild(el("a", {
      href: s.browser_url, target: "_blank", rel: "noopener", text: s.code,
    }));
  });
  root.appendChild(sources);
}

/* --- view registry ------------------------------------------------------ */

const VIEWS = {
  firm: {
    headline: "Europe's small firms are falling behind on AI",
    standfirst: "Eurostat's enterprise ICT surveys, read by firm size. Pick a country and a size band; every chart below compares that band against the one you set as the comparison.",
    unitKey: "firm_level",
    sections: [
      { id: "gap", nav: "The gap", h2: "The gap, in one number",
        deck: "The EU27 figure is Eurostat's own published aggregate, not an average of the countries you selected — the two are different numbers and the page never conflates them.",
        render: (r) => {
          headlineTiles(r, { chartId: "ai_adoption", indicator: "E_AI_TANY" });
          trendCard(r, { chartId: "ai_adoption", indicator: "E_AI_TANY",
            title: "AI adoption over time",
            note: "Every chart in this view uses the same two bands, so the comparison stays consistent as you scroll." });
        } },
      { id: "ranking", nav: "By country", h2: "Where each country stands",
        deck: "Ranked on the selected size band. Your selection stays emphasised as the ranking changes.",
        render: (r) => rankingCard(r, { chartId: "ai_adoption", indicator: "E_AI_TANY",
          title: "AI adoption by country",
          note: "Selected countries and the EU27 aggregate are emphasised; the rest stay as context." }) },
      { id: "purposes", nav: "What AI is used for", h2: "What AI actually gets used for",
        deck: "Adoption is not one thing. The purposes firms report differ sharply by size.",
        render: (r) => comparisonCard(r, "ai_purposes", {
          title: "What AI gets used for",
          note: "All shares are of the same base — every enterprise in the band — so the bars are directly comparable. A firm using AI for three purposes appears in three rows." }) },
      { id: "barriers", nav: "Why firms stay out", h2: "Why firms stay out",
        deck: "Eurostat asks the firms that considered AI and did not adopt it. Cost and a lack of in-house expertise dominate — and unlike the technology itself, both are addressable.",
        render: (r) => comparisonCard(r, "ai_barriers", {
          title: "Why enterprises do not adopt AI",
          note: "Shares of the enterprises that considered AI — not of all enterprises, which is the base every other chart here uses. Reasons are not exclusive. Because this base is not the enterprise population, these figures are never weighted." }) },
      { id: "foundations", nav: "Digital foundations", h2: "The foundations underneath",
        deck: "AI adoption rarely arrives on its own. Cloud services, data analytics practice and overall digital intensity are what it tends to sit on.",
        render: (r) => comparisonCard(r, "foundations", {
          title: "The digital foundations underneath AI",
          note: "Shares of every enterprise in the band." }) },
      { id: "skills", nav: "ICT skills in the firm", h2: "The skills constraint",
        deck: "What firms report about hiring. The workforce side of the same shortage sits in the Individuals view.",
        render: (r) => comparisonCard(r, "skills", {
          title: "ICT skills inside the firm",
          note: "Recruitment difficulty is the constraint most often reported alongside a lack of AI expertise." }) },
      { id: "method", nav: "How to read this", h2: "How to read this",
        deck: "These constraints travel with the data itself rather than living in a repository. They are the difference between a figure that is directionally useful and one that is simply wrong.",
        render: renderMethodology },
    ],
  },

  individual: {
    headline: "The workforce Europe's SMEs hire from",
    standfirst: "Eurostat's household ICT survey — people, not companies. Age bands work exactly as size bands do in the Companies view: pick one, compare it against another, and every chart follows.",
    unitKey: "individual_level",
    sections: [
      { id: "age-gap", nav: "The age gap", h2: "The gap, in one number",
        deck: "Generative AI use in the last three months, for the age band you selected against the one you are comparing it with.",
        render: (r) => {
          headlineTiles(r, { chartId: "workforce", indicator: "I_IUAI" });
          comparisonCard(r, "workforce", {
            title: "Generative AI and digital skills by age",
            note: "The same four indicators, read for both age bands. Individual-level percentages have no population count attached, so multi-country figures here are always unweighted." });
        } },
      { id: "genai-country", nav: "By country", h2: "Generative AI use across Europe",
        deck: "The first year Eurostat surveyed generative AI use among the general population, ranked for your selected age band.",
        render: (r) => rankingCard(r, { chartId: "workforce", indicator: "I_IUAI",
          title: "Generative AI use by country",
          note: "Share of people in the selected age band who used a generative AI tool in the last three months." }) },
      { id: "genai-age", nav: "Across every age", h2: "Where the drop-off happens",
        deck: "Age bands are ordered, so they take the ordinal ramp rather than categorical hues. The two bands you selected are emphasised.",
        render: (r) => {
          ordinalCard(r, { chartId: "workforce", indicator: "I_IUAI",
            options: AGE_ORDER.filter((c) => c !== "IND_TOTAL"),
            title: "Generative AI use by age", kindLabel: "Age band",
            note: "Bands are disjoint and cover the working-age population and just beyond." });
          ordinalCard(r, { chartId: "workforce", indicator: "I_IUAIWP",
            options: AGE_ORDER.filter((c) => c !== "IND_TOTAL"),
            title: "Generative AI use for work purposes", kindLabel: "Age band",
            note: "Share of all individuals in the age band, not of AI users — the closest proxy for what walks into an SME on Monday morning." });
        } },
      { id: "skills-edu", nav: "The talent pool", h2: "The talent pool",
        deck: "Basic-or-above overall digital skills by education level. This is the pool an SME hires from, and the one indicator here with a history to trend.",
        render: (r) => {
          ordinalCard(r, { chartId: "workforce", indicator: "I_DSK2_BAB",
            options: EDU_ORDER, title: "Digital skills by education", kindLabel: "Education",
            note: "Shares of all individuals at that education level." });
          trendCard(r, { chartId: "workforce", indicator: "I_DSK2_BAB",
            title: "Digital skills over time",
            note: "Surveyed in 2021, 2023 and 2025 — the only individual-level indicator here with more than one year." });
        } },
      { id: "method-ind", nav: "How to read this", h2: "How to read this",
        deck: "The same constraints apply here, carried from the data product itself.",
        render: renderMethodology },
    ],
  },
};

/* --- multi-select dropdown ---------------------------------------------- */

/**
 * A checkbox menu behind a button. A plain <select multiple> cannot show the
 * per-country series colour, and holding ctrl to pick four countries is not a
 * thing anyone discovers.
 */
function multiSelect(host, { options, labelOf, colorOf, isSelected, onToggle, max }) {
  host.innerHTML = "";
  const button = el("button", { class: "dd-button", type: "button", id: "dd-geo-button",
    "aria-haspopup": "listbox", "aria-expanded": "false" });
  const dots = el("span", { class: "dd-dots" });
  const value = el("span", { class: "dd-value" });
  button.appendChild(dots);
  button.appendChild(value);
  button.appendChild(el("span", { class: "dd-caret", text: "▼" }));

  const panel = el("div", { class: "dd-panel", role: "listbox", hidden: "" });
  const search = el("input", { class: "dd-search", type: "search", placeholder: "Search countries…" });
  const list = el("div", { class: "dd-list" });
  const foot = el("p", { class: "dd-foot" });
  panel.appendChild(search);
  panel.appendChild(list);
  panel.appendChild(foot);

  host.appendChild(button);
  host.appendChild(panel);

  function paintButton() {
    const picked = options.filter(isSelected);
    dots.innerHTML = "";
    picked.forEach((code) => dots.appendChild(
      el("i", { style: `background:${colorOf(code)}` })));
    value.textContent = picked.length === 1
      ? labelOf(picked[0])
      : `${labelOf(picked[0])} +${picked.length - 1}`;
    foot.textContent = `${picked.length} of max ${max} selected`;
  }

  function paintList() {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = "";
    options
      .filter((code) => !q || labelOf(code).toLowerCase().includes(q))
      .sort((a, b) => (isSelected(b) - isSelected(a)) || labelOf(a).localeCompare(labelOf(b)))
      .forEach((code) => {
        const on = isSelected(code);
        const opt = el("button", {
          class: "dd-option", type: "button", role: "option",
          "aria-selected": String(on),
          style: on ? `color:${colorOf(code)}` : null,
        });
        opt.appendChild(el("span", { class: "dd-box" }));
        opt.appendChild(el("span", { text: labelOf(code) }));
        opt.addEventListener("click", () => {
          onToggle(code);
          paintButton();
          paintList();
        });
        list.appendChild(opt);
      });
  }

  const close = () => { panel.hidden = true; button.setAttribute("aria-expanded", "false"); };
  button.addEventListener("click", (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    button.setAttribute("aria-expanded", String(!panel.hidden));
    if (!panel.hidden) { search.value = ""; paintList(); search.focus(); }
  });
  panel.addEventListener("click", (e) => e.stopPropagation());
  search.addEventListener("input", paintList);
  document.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  paintButton();
  paintList();
  return { paint: () => { paintButton(); paintList(); } };
}

/* --- rendering ---------------------------------------------------------- */

function renderAll() {
  const view = VIEWS[state.view];
  const d = dim();
  document.getElementById("headline").textContent = view.headline;
  document.getElementById("standfirst").textContent = view.standfirst;

  const banner = document.getElementById("unit-banner");
  banner.innerHTML = "";
  banner.appendChild(el("strong", { text: "Unit of observation:" }));
  banner.appendChild(document.createTextNode(` ${META.tables[view.unitKey].unit_of_observation}`));

  document.getElementById("lbl-primary").textContent = d.control;
  const primarySel = document.getElementById("primary-select");
  const compareSel = document.getElementById("compare-select");
  [primarySel, compareSel].forEach((s) => { s.innerHTML = ""; });
  d.options.forEach((code) => {
    primarySel.appendChild(el("option", { value: code, text: d.labelOf(code) }));
    compareSel.appendChild(el("option", { value: code, text: d.labelOf(code) }));
  });
  primarySel.value = sel().primary;
  compareSel.value = sel().compare;

  // Weighting is an enterprise-count operation; there is no count on people.
  const aggSel = document.getElementById("agg-select");
  aggSel.querySelector('option[value="weighted"]').disabled = state.view === "individual";
  if (state.view === "individual" && state.agg === "weighted") {
    state.agg = "unweighted";
    aggSel.value = state.agg;
  }

  const host = document.getElementById("sections");
  host.innerHTML = "";
  view.sections.forEach((spec) => {
    const section = el("section", { id: `sec-${spec.id}` });
    section.appendChild(el("h2", { text: spec.h2 }));
    section.appendChild(el("p", { class: "deck", text: spec.deck }));
    const body = el("div");
    section.appendChild(body);
    host.appendChild(section);
    spec.render(body);
  });

  buildNav();
}

function buildNav() {
  const nav = document.getElementById("nav");
  nav.innerHTML = "";
  VIEWS[state.view].sections.forEach((spec) => {
    nav.appendChild(el("li", {}, el("a", {
      href: `#sec-${spec.id}`, text: spec.nav, "data-target": `sec-${spec.id}`,
    })));
  });
  observeSections();
}

/* Highlight the analysis currently on screen, so the sidebar tracks the scroll. */
let sectionObserver = null;
function observeSections() {
  if (sectionObserver) sectionObserver.disconnect();
  const links = new Map([...document.querySelectorAll("nav.analyses a")]
    .map((a) => [a.dataset.target, a]));
  sectionObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      links.forEach((a) => a.removeAttribute("aria-current"));
      links.get(entry.target.id)?.setAttribute("aria-current", "true");
    });
  }, { rootMargin: "-15% 0px -70% 0px" });
  document.querySelectorAll("main section").forEach((s) => sectionObserver.observe(s));
}

/* --- controls ----------------------------------------------------------- */

let geoPicker = null;

function buildControls() {
  const geoCodes = [...new Set(rows("ai_adoption").map((r) => r.geo))]
    .filter((g) => g !== REF_GEO)
    .sort((a, b) => label("geo", a).localeCompare(label("geo", b)));

  geoPicker = multiSelect(document.getElementById("dd-geo"), {
    options: geoCodes, max: MAX_COMPARE,
    labelOf: (code) => label("geo", code),
    // Colour follows the entity's selection slot, so filtering never repaints.
    colorOf: (code) => {
      const i = state.geos.indexOf(code);
      return i >= 0 ? `var(${SERIES_SLOTS[i % SERIES_SLOTS.length]})` : "var(--ink-muted)";
    },
    isSelected: (code) => state.geos.includes(code),
    onToggle: (code) => { toggleGeo(code); },
  });

  document.getElementById("primary-select").addEventListener("change", (e) => {
    sel().primary = e.target.value; commit();
  });
  document.getElementById("compare-select").addEventListener("change", (e) => {
    sel().compare = e.target.value; commit();
  });
  const aggSel = document.getElementById("agg-select");
  aggSel.value = state.agg;
  aggSel.addEventListener("change", () => { state.agg = aggSel.value; commit(); });

  document.querySelectorAll("#viewswitch button").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (state.view === btn.dataset.view) return;
      state.view = btn.dataset.view;
      syncViewSwitch();
      commit();
      window.scrollTo({ top: 0 });
    });
  });
  syncViewSwitch();
}

function syncViewSwitch() {
  document.querySelectorAll("#viewswitch button").forEach((btn) => {
    btn.setAttribute("aria-selected", String(btn.dataset.view === state.view));
  });
}

const commit = () => { syncUrl(); renderAll(); };

function toggleGeo(code) {
  const i = state.geos.indexOf(code);
  if (i >= 0) {
    if (state.geos.length === 1) return;   // never leave the page with no country
    state.geos.splice(i, 1);
  } else {
    if (state.geos.length >= MAX_COMPARE) state.geos.shift();
    state.geos.push(code);
  }
  commit();
}

function syncUrl() {
  const params = new URLSearchParams();
  params.set("view", state.view);
  params.set("geo", state.geos.join(","));
  params.set("band", sel().primary);
  params.set("vs", sel().compare);
  if (state.agg !== "none") params.set("agg", state.agg);
  history.replaceState(null, "", `?${params}`);
}

function readUrl() {
  const params = new URLSearchParams(location.search);
  if (VIEWS[params.get("view")]) state.view = params.get("view");
  const geo = params.get("geo");
  if (geo) {
    const valid = geo.split(",").filter((g) => LABELS.geo[g] && g !== REF_GEO);
    if (valid.length) state.geos = valid.slice(0, MAX_COMPARE);
  }
  const opts = DIMENSIONS[state.view].options;
  if (opts.includes(params.get("band"))) sel().primary = params.get("band");
  if (opts.includes(params.get("vs"))) sel().compare = params.get("vs");
  const agg = params.get("agg");
  if (agg === "weighted" || agg === "unweighted") state.agg = agg;
}

/* --- boot --------------------------------------------------------------- */

async function boot() {
  const [series, labels, meta] = await Promise.all(
    ["series", "labels", "meta"].map((f) => fetch(`data/${f}.json`).then((r) => {
      if (!r.ok) throw new Error(`${f}.json: ${r.status}`);
      return r.json();
    })));
  SERIES = series; LABELS = labels; META = meta;

  tooltip.className = "tooltip";
  document.body.appendChild(tooltip);

  readUrl();
  document.getElementById("app").hidden = false;
  document.getElementById("boot").remove();

  buildControls();
  renderAll();

  document.getElementById("generated").textContent =
    `Data generated ${META.generated_utc.slice(0, 10)} from Eurostat.`;
}

boot().catch((err) => {
  document.getElementById("boot").textContent = `Could not load the data bundle: ${err.message}`;
});
