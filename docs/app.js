/* SME Digital & AI Readiness - page logic.
 *
 * Reads the curated bundle written by build_site.py. Three invariants from the
 * data layer are enforced here rather than assumed:
 *
 *   1. EU27_2020 is Eurostat's own published aggregate. It is displayed, never
 *      recomputed - a mean of the member states is a different number, and a
 *      reader who checks it against Eurostat must find ours matching.
 *   2. Every chart is pinned to one unit, and each names the population its
 *      percentage is a share of. Two 40%s are not comparable across bases.
 *   3. Neither breakdown is a partition. Size bands overlap (SME_10_249 holds
 *      SMALL_10_49); so do the individual cuts (IND_TOTAL holds every age).
 *      The page warns whenever the selected pair is not mutually exclusive.
 *
 * Both views share one shape: a country and a band, compared against either
 * another band or another country. In the Companies view the band is an
 * enterprise size class; in the Individuals view it is an age band. Everything
 * downstream is generic over that, which is why the two views need only one
 * set of renderers.
 */

const REF_GEO = "EU27_2020";
const SERIES_SLOTS = ["--series-1", "--series-2", "--series-3", "--series-4"];
const ORDINAL_SLOTS = [
  "--ordinal-1", "--ordinal-2", "--ordinal-3",
  "--ordinal-4", "--ordinal-5", "--ordinal-6",
];

const SIZE_ORDER = ["SMALL_10_49", "MEDIUM_50_249", "LARGE_GE250", "SME_10_249", "ALL_GE10"];
const AGE_ORDER = ["IND_TOTAL", "Y16_24", "Y25_34", "Y35_44", "Y45_54", "Y55_64", "Y65_74"];
const EDU_ORDER = ["I0_2", "I3_4", "I5_8"];

/* NACE sections, at one level so they never contain one another. Eurostat's own
 * labels are full legal definitions ("Wholesale and retail trade; repair of
 * motor vehicles and motorcycles"), which no control or axis can carry, so each
 * gets a short name for display. The full wording stays in the tooltips. */
const SECTIONS = ["C", "D", "E", "F", "G", "H", "I", "J", "L", "M", "N"];
const SECTOR_SHORT = {
  C: "Manufacturing",
  D: "Energy",
  E: "Water & waste",
  F: "Construction",
  G: "Wholesale & retail",
  H: "Transport & storage",
  I: "Accommodation & food",
  J: "Information & communication",
  L: "Real estate",
  M: "Professional & technical",
  N: "Admin & support",
};
const sectorLabel = (code) => SECTOR_SHORT[code] ?? label("nace_r2", code);

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
  geos: ["IT"],           // one country, or several averaged together
  firm: {
    band: "SMALL_10_49",
    compareMode: "band",          // band | geo
    compareBand: "LARGE_GE250",
    compareGeos: ["DE"],
  },
  sector: {
    band: "C",
    compareMode: "band",
    compareBand: "J",
    compareGeos: ["DE"],
  },
  individual: {
    band: "Y25_34",
    compareMode: "band",
    compareBand: "Y55_64",
    compareGeos: ["DE"],
  },
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

const DIMENSIONS = {
  firm: {
    control: "Size band", field: "size_emp",
    options: SIZE_ORDER, labelOf: bandLabel,
    clean: "10–49, 50–249 and 250+",
  },
  sector: {
    control: "Sector", field: "nace_r2",
    options: SECTIONS, labelOf: sectorLabel,
    clean: "any two sectors",
  },
  individual: {
    control: "Age band", field: "ind_type",
    options: AGE_ORDER, labelOf: cutLabel,
    clean: "any two of the six age bands",
  },
};

const dim = () => DIMENSIONS[state.view];
const sel = () => state[state.view];

/* Eurostat's geo codes are ISO 3166 alpha-2 apart from Greece, which it calls
 * EL. Badges show the code rather than a flag emoji on purpose: Windows ships
 * no flag glyphs, so an emoji flag renders there as the bare letter pair
 * anyway, while a badge renders identically on every platform. */
const GEO_BADGE = { EU27_2020: "EU", EL: "GR" };
const geoBadge = (code) => GEO_BADGE[code] ?? code;

/**
 * The one or two slices every chart draws.
 *
 * Comparing by band holds the country fixed and varies the band; comparing by
 * country holds the band fixed and varies the country. Labels name whichever
 * one is varying, because repeating the constant in both legend entries tells
 * the reader nothing.
 */
function facets() {
  const s = sel(), d = dim();
  const byBand = s.compareMode === "band";
  const a = {
    geos: state.geos, band: s.band, slot: SERIES_SLOTS[0],
    label: byBand ? d.labelOf(s.band) : geosLabel(state.geos),
  };
  const b = byBand
    ? { geos: state.geos, band: s.compareBand, slot: SERIES_SLOTS[1],
        label: d.labelOf(s.compareBand) }
    : { geos: s.compareGeos, band: s.band, slot: SERIES_SLOTS[1],
        label: geosLabel(s.compareGeos) };

  // Same slice twice is one series, not two identical bars.
  const same = a.band === b.band
    && a.geos.length === b.geos.length && a.geos.every((g) => b.geos.includes(g));
  return same ? [a] : [a, b];
}

/**
 * How a country selection names itself. A bare count is ambiguous the moment
 * both sides of a comparison hold the same number of countries, so small groups
 * name their members and only larger ones fall back to a count.
 */
function geosLabel(geos) {
  if (geos.length === 1) return label("geo", geos[0]);
  if (geos.length <= 4) return geos.map(geoBadge).join(" · ");
  return `${geos.length} countries`;
}

/** What stays fixed across the comparison - it belongs in the title, not the legend. */
function heldConstant() {
  const s = sel();
  return s.compareMode === "band" ? geosLabel(state.geos) : dim().labelOf(s.band);
}

/**
 * Combine one value per country into a single figure, the way Eurostat builds
 * EU27: weighted by how many enterprises each country has, not a plain mean of
 * the countries. The two differ a lot, because adoption tracks economy size.
 *
 * Weighting needs an enterprise count, which exists only for a unit that is a
 * share of all enterprises, and only for 2021-2024. Where it is missing the
 * result falls back to an unweighted mean, and `weighted` says which happened
 * so the caller can label it honestly rather than implying precision it lacks.
 */
function aggregateValues(records, weightable) {
  if (!records.length) return null;
  if (records.length === 1) {
    return { value: records[0].value, weighted: false, n: 1 };
  }
  const counts = records.map((r) => r.enterprise_count);
  const canWeight = weightable !== false
    && counts.every((c) => typeof c === "number" && c > 0);
  if (canWeight) {
    const total = counts.reduce((a, b) => a + b, 0);
    return {
      value: records.reduce((acc, r) => acc + r.value * r.enterprise_count, 0) / total,
      weighted: true, n: records.length,
    };
  }
  return {
    value: records.reduce((acc, r) => acc + r.value, 0) / records.length,
    weighted: false, n: records.length,
  };
}

/**
 * Decide once, for a whole series, whether it can be weighted.
 *
 * Enterprise counts only exist for 2021-2024, so deciding year by year would
 * weight a trend's 2024 point and not its 2025 one - two different methods
 * inside one line, and a step in the series that is an artefact of the method
 * rather than anything in the data. If any year the series needs is missing a
 * count, the whole series falls back to a plain average.
 */
function weightingMode(chartId, indicator, f, times) {
  if (SERIES[chartId].weightable !== true) return false;
  if (f.geos.length < 2) return false;
  return times.every((t) => {
    const recs = where(chartId, { indicator, [dim().field]: f.band, time: t, geo: f.geos });
    return recs.length === f.geos.length
      && recs.every((r) => typeof r.enterprise_count === "number" && r.enterprise_count > 0);
  });
}

function facetStat(chartId, indicator, f, time, weightable) {
  const recs = where(chartId, { indicator, [dim().field]: f.band, time, geo: f.geos });
  return aggregateValues(recs, weightable);
}

const facetValue = (chartId, indicator, f, time, weightable) =>
  facetStat(chartId, indicator, f, time, weightable)?.value ?? null;

function bandsOverlap(a, b) {
  if (a === b) return true;
  return (CONTAINS[a] || []).includes(b) || (CONTAINS[b] || []).includes(a);
}

/** Only meaningful when the comparison varies the band; two countries never overlap. */
function overlapWarning() {
  const s = sel();
  if (s.compareMode !== "band") return null;
  if (!bandsOverlap(s.band, s.compareBand)) return null;
  const d = dim();
  if (s.band === s.compareBand) return "Both bands are the same, so only one series is shown.";
  return `${d.control}s overlap: ${d.labelOf(s.band)} and ${d.labelOf(s.compareBand)} are not `
    + `mutually exclusive, so one contains the other. Pick ${d.clean} for a clean comparison.`;
}

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

/* Eurostat's geo codes are ISO 3166 alpha-2 apart from Greece, which it calls
 * EL. The badge shows the code rather than a flag emoji on purpose: Windows
 * ships no flag glyphs, so an emoji flag renders there as the bare letter pair
 * anyway, and a badge renders identically on every platform. */
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
 * form without adding a second colour or a second meaning.
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
function attachTip(node, html, dimOthers = true) {
  if (dimOthers) node.classList.add("mark");
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
  const fills = {
    main: gradientFill(svg, `var(${SERIES_SLOTS[0]})`),
    alt: gradientFill(svg, `var(${SERIES_SLOTS[1]})`),
    ref: gradientFill(svg, "var(--ink-muted)"),
  };

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
    const kind = d.reference ? "ref" : (d.alt ? "alt" : "main");
    const solid = d.reference ? "var(--ink-muted)" : `var(${SERIES_SLOTS[d.alt ? 1 : 0]})`;
    const lifted = d.highlight || d.reference;
    const bar = el("rect", {
      x: padL, y: y + 4, width: w, height: rowH - 10, rx: 4,
      class: "bar-x", fill: fills[kind], "fill-opacity": lifted ? 1 : 0.4,
      style: `animation-delay:${Math.min(i * 3, 90)}ms`,
    });
    attachTip(bar, `<div class="tt-title">${d.label}</div>
      ${tipRow(solid, `${fmt(d.value)}%`)}<div class="tt-base">${unitNote}</div>`);
    svg.appendChild(bar);
    svg.appendChild(el("text", {
      x: padL - 10, y: y + rowH / 2 + 1, class: "cat-label", "text-anchor": "end",
      "font-weight": lifted ? 600 : 400, text: d.label,
    }));
    if (lifted) {
      svg.appendChild(el("text", {
        x: padL + w + 8, y: y + rowH / 2 + 1, class: "value-label", text: `${fmt(d.value)}%`,
      }));
    }
  });
  container.appendChild(svg);
}

/** Grouped horizontal bars - one row per indicator, one bar per facet. */
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
    // the gutter is still readable. A dotted rule marks the ones actually
    // clipped, since a cursor change alone is invisible in a screenshot.
    // Not `short !== label`: shortLabel also strips Eurostat's shared sentence
    // stem, so the two differ on rows that were never clipped.
    const labelNode = el("text", {
      x: padL - 14, y: top + groupH / 2, "text-anchor": "end", text: cat.short,
      class: `cat-label${cat.short.endsWith("…") ? " clipped" : ""}`,
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
  const width = 900, height = 320;
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
  const width = 900, height = 236, baseline = 180;
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

function headlineTiles(root, { chartId, indicator }) {
  const year = latestYear(chartId, { indicator });
  const fs = facets();
  const ref = where(chartId, {
    indicator, [dim().field]: sel().band, time: year, geo: REF_GEO,
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

  const wA = weightingMode(chartId, indicator, fs[0], [year]);
  const a = facetValue(chartId, indicator, fs[0], year, wA);
  const b = fs[1]
    ? facetValue(chartId, indicator, fs[1], year, weightingMode(chartId, indicator, fs[1], [year]))
    : null;
  const who = `${heldConstant()}, ${year}`;
  tiles.appendChild(tile(fs[0].label, `${fmt(a)}%`, who, "accent", SERIES_SLOTS[0]));
  if (fs[1]) tiles.appendChild(tile(fs[1].label, `${fmt(b)}%`, who, "compare", SERIES_SLOTS[1]));
  const multiple = a && b ? b / a : null;
  tiles.appendChild(tile("The gap", multiple ? `${multiple.toFixed(1)}x` : "n/a",
    fs[1] ? `${fs[1].label} vs ${fs[0].label}` : "pick a different comparison"));
  tiles.appendChild(tile("EU27 benchmark", `${fmt(ref?.value)}%`,
    `Eurostat's published aggregate · ${dim().labelOf(sel().band)}`));
  root.appendChild(tiles);

  // Either side of the comparison can be a group of countries, and each side
  // decides its own weighting, so the note is built per side rather than
  // assuming the primary selection speaks for both.
  // Either side can be a group, and each decides its own weighting - but when
  // both land on the same method, saying so twice is noise.
  const groups = fs.filter((f) => f.geos.length > 1);
  const messages = new Set(groups.map((f) => {
    const w = weightingMode(chartId, indicator, f, [year]);
    return facetStat(chartId, indicator, f, year, w)?.weighted
      ? "Countries are combined the way Eurostat builds EU27 — weighted by how many enterprises each has, not a plain average of the countries."
      : "Countries are combined as a plain average, each counting equally. No enterprise counts exist for this measure or year, so they cannot be weighted the way EU27 is.";
  }));
  messages.forEach((text) => root.appendChild(el("p", { class: "card-warn", text })));
}

function trendCard(root, { chartId, indicator, title, note }) {
  const d = dim();
  const unitNote = unitNoteFor(SERIES[chartId].unit);
  const xs = yearsOf(chartId, { indicator });
  const fs = facets();
  const eu = (t) => where(chartId, {
    indicator, [d.field]: sel().band, time: t, geo: REF_GEO,
  })[0]?.value ?? null;

  card(root, {
    title: `${title} — ${heldConstant()}`,
    note, warn: overlapWarning(),
    draw: (c) => lineChart(c, xs, [
      ...fs.map((f) => {
        const w = weightingMode(chartId, indicator, f, xs);
        return {
          label: f.label, slot: f.slot,
          points: xs.map((t) => ({ y: facetValue(chartId, indicator, f, t, w) })),
        };
      }),
      { label: `EU27 · ${d.labelOf(sel().band)}`, reference: true,
        points: xs.map((t) => ({ y: eu(t) })) },
    ], { unitNote }),
    table: () => ({
      columns: ["Year", ...fs.map((f) => f.label), "EU27"],
      rows: xs.map((t) => [t,
        ...fs.map((f) => fmt(facetValue(chartId, indicator, f, t, weightingMode(chartId, indicator, f, xs)))),
        fmt(eu(t))]),
    }),
  });
}

function rankingCard(root, { chartId, indicator, title, note }) {
  const d = dim();
  const s = sel();
  const unitNote = unitNoteFor(SERIES[chartId].unit);
  const year = latestYear(chartId, { indicator });
  const build = () => where(chartId, { indicator, [d.field]: s.band, time: year })
    .map((r) => ({
      code: r.geo, label: shortGeo(r.geo), value: r.value,
      highlight: state.geos.includes(r.geo)
        || (s.compareMode === "geo" && s.compareGeos.includes(r.geo)),
      alt: s.compareMode === "geo" && s.compareGeos.includes(r.geo)
        && !state.geos.includes(r.geo),
      reference: r.geo === REF_GEO,
    }))
    .sort((a, b) => b.value - a.value);

  card(root, {
    title: `${title} — ${d.labelOf(s.band)}, ${year}`,
    note,
    draw: (c) => rankedBars(c, build(), { unitNote }),
    table: () => ({ columns: ["Country", "%"], rows: build().map((x) => [x.label, fmt(x.value)]) }),
  });
}

function comparisonCard(root, chartId, { title, note, indicators }) {
  const d = dim();
  const chart = SERIES[chartId];
  const unitNote = unitNoteFor(chart.unit);
  const codes = indicators || chart.indicators;
  const year = latestYear(chartId, {});
  const fs = facets();

  // An indicator the survey skipped this year would otherwise render as a
  // labelled row with no bar, which reads as "zero" rather than "not asked".
  const categories = codes
    .map((code) => {
      const full = label("indicator", code);
      // 46 chars is what fits the 292px label gutter at 12px; longer runs off
      // the left edge of the plot. The tooltip and table keep the full wording.
      return { code, label: full, short: shortLabel(full, 46) };
    })
    .filter((cat) => fs.some((f) => facetValue(chartId, cat.code, f, year,
      weightingMode(chartId, cat.code, f, [year])) !== null));

  // Rows run in descending order of the EU27 figure, not of the selection.
  // Sorting on the selection would reshuffle rows every time the reader changes
  // country, making two screenshots impossible to compare; the aggregate keeps
  // the running order fixed while the bars move. Anything EU27 does not report
  // sorts last rather than to the top on a null.
  const euValue = (code) => where(chartId, {
    indicator: code, [d.field]: sel().band, time: year, geo: REF_GEO,
  })[0]?.value ?? -1;
  categories.sort((a, b) => euValue(b.code) - euValue(a.code));

  const series = fs.map((f) => ({
    label: f.label, slot: f.slot,
    values: categories.map((cat) => facetValue(chartId, cat.code, f, year,
      weightingMode(chartId, cat.code, f, [year]))),
  }));

  card(root, {
    title: `${title} — ${heldConstant()}, ${year}`,
    note: `${note} Rows are ordered by the EU27 figure for ${d.labelOf(sel().band)}, so changing the selection moves the bars but never the row order.`,
    warn: overlapWarning(),
    draw: (c) => groupedBars(c, categories, series, { unitNote }),
    table: () => ({
      columns: ["Indicator", ...series.map((s) => s.label)],
      rows: categories.map((cat, i) => [cat.label, ...series.map((s) => fmt(s.values[i]))]),
    }),
  });
}

/**
 * Every value of the breakdown, ranked, for the current country selection.
 *
 * Sectors are nominal - no natural order - so this deliberately does NOT use
 * the ordinal ramp the age bands get. One series, one colour, with the selected
 * sectors lifted out of the field.
 */
function breakdownRankCard(root, { chartId, indicator, title, note }) {
  const d = dim();
  const unitNote = unitNoteFor(SERIES[chartId].unit);
  const year = latestYear(chartId, { indicator });
  const fs = facets();
  const picked = fs.map((f) => f.band);

  const build = () => d.options.map((code) => {
    const f = { geos: state.geos, band: code };
    return {
      code, label: d.labelOf(code),
      value: facetValue(chartId, indicator, f, year,
        weightingMode(chartId, indicator, f, [year])),
      highlight: picked.includes(code),
      alt: picked.indexOf(code) === 1,
    };
  }).filter((x) => x.value !== null).sort((a, b) => b.value - a.value);

  card(root, {
    title: `${title} — ${geosLabel(state.geos)}, ${year}`,
    note,
    draw: (c) => rankedBars(c, build(), { unitNote }),
    table: () => ({
      columns: [d.control, "%"], rows: build().map((x) => [x.label, fmt(x.value)]),
    }),
  });
}

function ordinalCard(root, { chartId, indicator, options, title, note, kindLabel }) {
  const d = dim();
  const unitNote = unitNoteFor(SERIES[chartId].unit);
  const year = latestYear(chartId, { indicator });
  const items = options.map((code) => ({
    code, label: d.labelOf(code),
    value: aggregateValues(
      where(chartId, { indicator, [d.field]: code, time: year, geo: state.geos }),
      weightingMode(chartId, indicator, { geos: state.geos, band: code }, [year]),
    )?.value ?? null,
  }));
  const picked = facets().filter((f) => options.includes(f.band)).map((f) => f.band);

  card(root, {
    title: `${title} — ${geosLabel(state.geos)}, ${year}`,
    note,
    draw: (c) => ordinalBars(c, items, { unitNote, highlight: picked }),
    table: () => ({
      columns: [kindLabel, "%"], rows: items.map((x) => [x.label, fmt(x.value)]),
    }),
  });
}

/* --- methodology -------------------------------------------------------- */

/* Plain-language versions of the datamap caveats. The originals are precise but
 * written in the vocabulary of the data product (unit bases, PC_ENT, partitions);
 * a reader who is not holding the codebook needs the same warnings in ordinary
 * words. Both ship: these up front, the exact wording behind the toggle. */
const PLAIN_NOTES = [
  ["The smallest businesses are missing",
   "The EU survey behind these numbers only reaches companies with 10 employees or more. Businesses smaller than that — which are the majority of firms in Europe — are never asked. So wherever this page says \"small firms\", it means 10 to 49 employees, not the corner shop."],
  ["Not every percentage is out of the same group",
   "Most figures here are a share of all companies. The \"why firms stay out\" figures are a share of only those companies that actually looked at AI and decided against it. Two numbers that both read 40% can therefore mean quite different things — each chart says underneath which group it is counting."],
  ["Size groups overlap, so never add them together",
   "\"10 to 249 employees\" already contains \"10 to 49\". Adding the two would count the same companies twice. That is why the page warns you when you compare a group against one it contains."],
  ["One company can appear in several bars",
   "A firm using AI for marketing, logistics and finance is counted in all three bars. The bars answer \"how many do this?\", not \"how do they split up?\", so they will not add to 100%."],
  ["The EU27 line is Eurostat's, not an average of what you picked",
   "The EU27 figure is published by Eurostat and weighted by how many businesses each country has. It is shown exactly as published and never recalculated, so it will always match Eurostat's own tables."],
  ["Counts of businesses are estimates",
   "Percentages come from one survey and the number of businesses from another. The two cover slightly different populations and only overlap for 2021 to 2024, so any figure expressed as a number of companies is an estimate, not an exact count."],
  ["A gap is not a cause",
   "This page shows where differences sit — between sizes, ages and countries. It cannot say what causes them. A country doing well may differ in a dozen ways this data never records."],
];

function renderMethodology(root) {
  const list = el("div", { class: "notes" });
  PLAIN_NOTES.forEach(([head, body]) => {
    const item = el("div", { class: "note" });
    item.appendChild(el("h3", { text: head }));
    item.appendChild(el("p", { text: body }));
    list.appendChild(item);
  });
  root.appendChild(list);

  const details = el("details", { class: "technical" });
  details.appendChild(el("summary", { text: "Technical notes — the exact wording from the data product" }));
  const ul = el("ul", { class: "caveats" });
  META.caveats.forEach((c) => ul.appendChild(el("li", { text: c })));
  details.appendChild(ul);
  root.appendChild(details);

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

const HOW_TO_READ = {
  id: "method", nav: "How to read this", h2: "How to read this",
  deck: "Seven things that change what these numbers mean. They are worth two minutes before you quote any figure from this page.",
  render: renderMethodology,
};

const VIEWS = {
  firm: {
    headline: "Europe's small firms are falling behind on AI",
    standfirst: "Eurostat's enterprise ICT surveys, read by firm size. Pick a country and a size band, then choose whether to compare it against another size band or against another country.",
    unitKey: "firm_level",
    sections: [
      { id: "gap", nav: "The gap", h2: "The gap, in one number",
        deck: "The EU27 figure is Eurostat's own published aggregate, not an average of what you selected — the two are different numbers and the page never conflates them.",
        render: (r) => {
          headlineTiles(r, { chartId: "ai_adoption", indicator: "E_AI_TANY" });
          trendCard(r, { chartId: "ai_adoption", indicator: "E_AI_TANY",
            title: "AI adoption over time",
            note: "Every chart in this view uses the same comparison, so it stays consistent as you scroll." });
        } },
      { id: "ranking", nav: "By country", h2: "Where each country stands",
        deck: "Ranked on the selected size band. Your selection stays emphasised as the ranking changes.",
        render: (r) => rankingCard(r, { chartId: "ai_adoption", indicator: "E_AI_TANY",
          title: "AI adoption by country",
          note: "Your selection and the EU27 aggregate are emphasised; the rest stay as context." }) },
      { id: "purposes", nav: "What AI is used for", h2: "What AI actually gets used for",
        deck: "Adoption is not one thing. The purposes firms report differ sharply by size.",
        render: (r) => comparisonCard(r, "ai_purposes", {
          title: "What AI gets used for",
          note: "All shares are of the same group — every company in the band — so the bars are directly comparable. A firm using AI for three purposes appears in three rows." }) },
      { id: "barriers", nav: "Why firms stay out", h2: "Why firms stay out",
        deck: "Eurostat asks the firms that considered AI and did not adopt it. Cost and a lack of in-house expertise dominate — and unlike the technology itself, both are addressable.",
        render: (r) => comparisonCard(r, "ai_barriers", {
          title: "Why enterprises do not adopt AI",
          note: "Shares of the companies that considered AI — not of all companies, which is the group every other chart here counts. Reasons are not exclusive." }) },
      { id: "foundations", nav: "Digital foundations", h2: "The foundations underneath",
        deck: "AI adoption rarely arrives on its own. Cloud services, data analytics practice and overall digital intensity are what it tends to sit on.",
        render: (r) => comparisonCard(r, "foundations", {
          title: "The digital foundations underneath AI",
          note: "Shares of every company in the band." }) },
      { id: "skills", nav: "ICT skills in the firm", h2: "The skills constraint",
        deck: "What firms report about hiring. The workforce side of the same shortage sits in the Individuals view.",
        render: (r) => comparisonCard(r, "skills", {
          title: "ICT skills inside the firm",
          note: "Recruitment difficulty is the constraint most often reported alongside a lack of AI expertise." }) },
      HOW_TO_READ,
    ],
  },

  sector: {
    headline: "AI adoption is six times higher in some industries than others",
    standfirst: "The same Eurostat enterprise survey, read by industry instead of by size. Pick a sector, then compare it against another sector or against another country.",
    unitKey: "firm_level",
    // Sector and size are never crossed in the source, so this view cannot
    // carry an SME cut and must not imply one.
    unitNote: "Sector figures cover every enterprise with 10 or more employees. Eurostat does not break sector down by company size, so there is no small-firm cut here — that lives in the Companies view.",
    sections: [
      { id: "gap", nav: "The gap", h2: "The gap, in one number",
        deck: "The EU27 figure is Eurostat's own published aggregate for this sector, not an average of what you selected.",
        render: (r) => {
          headlineTiles(r, { chartId: "sector_adoption", indicator: "E_AI_TANY" });
          trendCard(r, { chartId: "sector_adoption", indicator: "E_AI_TANY",
            title: "AI adoption over time",
            note: "Every chart in this view uses the same comparison, so it stays consistent as you scroll." });
        } },
      { id: "all-sectors", nav: "Every sector ranked", h2: "Where the divide actually sits",
        deck: "Every sector the survey reports for this selection, at once. Not all eleven are published for every country — Energy and Water are missing in many. Sectors have no natural order, so this is a single-colour ranking rather than the graded ramp the age bands get.",
        render: (r) => breakdownRankCard(r, { chartId: "sector_adoption", indicator: "E_AI_TANY",
          title: "AI adoption by sector",
          note: "The sectors you selected are emphasised; the rest stay as context." }) },
      { id: "by-country", nav: "By country", h2: "The same sector across Europe",
        deck: "How far your selected sector varies between countries.",
        render: (r) => rankingCard(r, { chartId: "sector_adoption", indicator: "E_AI_TANY",
          title: "AI adoption by country",
          note: "Your selection and the EU27 aggregate are emphasised; the rest stay as context." }) },
      { id: "purposes", nav: "What AI is used for", h2: "What AI actually gets used for",
        deck: "The purposes firms report differ as sharply by industry as they do by size.",
        render: (r) => comparisonCard(r, "sector_purposes", {
          title: "What AI gets used for",
          note: "All shares are of the same group — every company in the sector — so the bars are directly comparable. A firm using AI for three purposes appears in three rows." }) },
      { id: "technologies", nav: "Which technologies", h2: "Which technologies they actually run",
        deck: "Adoption headlines hide what is underneath: text mining and machine learning behave nothing like autonomous robots.",
        render: (r) => comparisonCard(r, "sector_tech", {
          title: "AI technologies in use",
          note: "Shares of every company in the sector. A firm running three technologies appears in three rows." }) },
      { id: "barriers", nav: "Why firms stay out", h2: "Why firms stay out",
        deck: "Asked of the firms that considered AI and decided against it.",
        render: (r) => comparisonCard(r, "sector_barriers", {
          title: "Why enterprises do not adopt AI",
          note: "Shares of the companies that considered AI — not of all companies, which is the group every other chart here counts. Reasons are not exclusive." }) },
      { id: "skills", nav: "ICT skills", h2: "The skills constraint",
        deck: "Whether the sector employs ICT specialists at all, and whether it trains its own people.",
        render: (r) => comparisonCard(r, "sector_skills", {
          title: "ICT skills inside the firm",
          note: "Shares of every company in the sector." }) },
      HOW_TO_READ,
    ],
  },

  individual: {
    headline: "The workforce Europe's SMEs hire from",
    standfirst: "Eurostat's household ICT survey — people, not companies. Age bands work exactly as size bands do in the Companies view: pick one, then compare it against another age band or against another country.",
    unitKey: "individual_level",
    sections: [
      { id: "age-gap", nav: "The age gap", h2: "The gap, in one number",
        deck: "Generative AI use in the last three months, for the age band you selected against whatever you are comparing it with.",
        render: (r) => {
          headlineTiles(r, { chartId: "workforce", indicator: "I_IUAI" });
          comparisonCard(r, "workforce", {
            title: "Generative AI and digital skills",
            note: "The same four measures, read for both sides of your comparison." });
        } },
      { id: "genai-country", nav: "By country", h2: "Generative AI use across Europe",
        deck: "The first year Eurostat surveyed generative AI use among the general population, ranked for your selected age band.",
        render: (r) => rankingCard(r, { chartId: "workforce", indicator: "I_IUAI",
          title: "Generative AI use by country",
          note: "Share of people in the selected age band who used a generative AI tool in the last three months." }) },
      { id: "genai-age", nav: "Across every age", h2: "Where the drop-off happens",
        deck: "Age bands are ordered, so they take the ordinal ramp rather than categorical hues. The bands you selected are emphasised.",
        render: (r) => {
          ordinalCard(r, { chartId: "workforce", indicator: "I_IUAI",
            options: AGE_ORDER.filter((c) => c !== "IND_TOTAL"),
            title: "Generative AI use by age", kindLabel: "Age band",
            note: "Bands are disjoint and cover the working-age population and just beyond." });
          ordinalCard(r, { chartId: "workforce", indicator: "I_IUAIWP",
            options: AGE_ORDER.filter((c) => c !== "IND_TOTAL"),
            title: "Generative AI use for work purposes", kindLabel: "Age band",
            note: "Share of all people in the age band, not of AI users — the closest proxy for what walks into an SME on Monday morning." });
        } },
      { id: "skills-edu", nav: "The talent pool", h2: "The talent pool",
        deck: "Basic-or-above overall digital skills by education level. This is the pool an SME hires from, and the one measure here with a history to trend.",
        render: (r) => {
          ordinalCard(r, { chartId: "workforce", indicator: "I_DSK2_BAB",
            options: EDU_ORDER, title: "Digital skills by education", kindLabel: "Education",
            note: "Shares of all people at that education level." });
          trendCard(r, { chartId: "workforce", indicator: "I_DSK2_BAB",
            title: "Digital skills over time",
            note: "Surveyed in 2021, 2023 and 2025 — the only individual-level measure here with more than one year." });
        } },
      HOW_TO_READ,
    ],
  },
};

/* --- country picker ----------------------------------------------------- */

/**
 * A searchable single-select. A native <select> over 34 countries cannot show
 * the colour a country carries in the charts, and cannot be typed into.
 */
function countryPicker(host, { options, selected, onToggle, hint }) {
  host.innerHTML = "";
  const button = el("button", {
    class: "dd-button", type: "button", id: "dd-geo-button",
    "aria-haspopup": "listbox", "aria-expanded": "false",
  });
  const badges = el("span", { class: "dd-badges" });
  const value = el("span", { class: "dd-value" });
  button.appendChild(badges);
  button.appendChild(value);
  button.appendChild(el("span", { class: "dd-caret", text: "▼" }));

  const panel = el("div", { class: "dd-panel", role: "listbox", hidden: "" });
  const search = el("input", {
    class: "dd-search", type: "search", placeholder: "Search countries…",
  });
  const list = el("div", { class: "dd-list" });
  const foot = el("p", { class: "dd-foot" });
  panel.appendChild(search);
  panel.appendChild(list);
  panel.appendChild(foot);
  host.appendChild(button);
  host.appendChild(panel);

  function paintButton() {
    const picked = selected();
    // Three badges is what fits the button; past that the count carries it.
    badges.innerHTML = "";
    picked.slice(0, 3).forEach((code) => badges.appendChild(
      el("span", { class: "geo-badge", text: geoBadge(code) })));
    value.textContent = picked.length === 1
      ? label("geo", picked[0])
      : `${picked.length} countries`;
    foot.textContent = picked.length === 1
      ? hint
      : `${picked.length} selected · combined into one averaged series.`;
  }

  function paintList() {
    const q = search.value.trim().toLowerCase();
    const picked = selected();
    list.innerHTML = "";
    options()
      .filter((code) => !q || label("geo", code).toLowerCase().includes(q)
        || geoBadge(code).toLowerCase().startsWith(q))
      // Selected countries lead the list, so a shared link shows its selection
      // without the reader having to scroll for it.
      .sort((a, b) => (picked.includes(b) - picked.includes(a))
        || label("geo", a).localeCompare(label("geo", b)))
      .forEach((code) => {
        const on = picked.includes(code);
        const opt = el("button", {
          class: "dd-option", type: "button", role: "option", "aria-selected": String(on),
        });
        opt.appendChild(el("span", { class: "geo-badge", text: geoBadge(code) }));
        opt.appendChild(el("span", { text: label("geo", code) }));
        if (on) opt.appendChild(el("span", { class: "dd-check", text: "✓" }));
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
  const s = sel();

  document.getElementById("headline").textContent = view.headline;
  document.getElementById("standfirst").textContent = view.standfirst;

  const banner = document.getElementById("unit-banner");
  banner.innerHTML = "";
  banner.appendChild(el("strong", { text: "Unit of observation:" }));
  banner.appendChild(document.createTextNode(
    ` ${view.unitNote ?? META.tables[view.unitKey].unit_of_observation}`));

  document.getElementById("lbl-primary").textContent = d.control;
  document.getElementById("opt-mode-band").textContent = d.control;

  const primarySel = document.getElementById("primary-select");
  primarySel.innerHTML = "";
  d.options.forEach((code) => primarySel.appendChild(
    el("option", { value: code, text: d.labelOf(code) })));
  primarySel.value = s.band;

  document.getElementById("compare-mode").value = s.compareMode;

  // The comparison list is either the other bands or the other countries -
  // whichever dimension the reader chose to vary.
  const cmpSel = document.getElementById("compare-select");
  const cmpPick = document.getElementById("dd-compare");
  const byBand = s.compareMode === "band";
  cmpSel.hidden = !byBand;
  cmpPick.hidden = byBand;
  if (byBand) {
    cmpSel.innerHTML = "";
    d.options.forEach((code) => cmpSel.appendChild(
      el("option", { value: code, text: d.labelOf(code) })));
    cmpSel.value = s.compareBand;
  }

  geoPicker?.paint();
  comparePicker?.paint();

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
let comparePicker = null;

const geoOptions = () => [...new Set(rows("ai_adoption").map((r) => r.geo))]
  .filter((g) => g !== REF_GEO)
  .sort((a, b) => label("geo", a).localeCompare(label("geo", b)));

/** Toggle a code in a list, refusing to empty it - a side with no country
 *  would leave the chart with nothing to draw. */
function toggleIn(list, code) {
  const i = list.indexOf(code);
  if (i >= 0) {
    if (list.length === 1) return;
    list.splice(i, 1);
  } else {
    list.push(code);
  }
  commit();
}

function buildControls() {
  geoPicker = countryPicker(document.getElementById("dd-geo"), {
    // When the comparison is itself a set of countries, a country can only sit
    // on one side of it; offering it on both invites a group to be compared
    // against a group that partly contains it.
    options: () => geoOptions().filter((g) =>
      sel().compareMode !== "geo" || !sel().compareGeos.includes(g)),
    selected: () => state.geos,
    hint: "Pick more to see their combined average.",
    onToggle: (code) => toggleIn(state.geos, code),
  });

  comparePicker = countryPicker(document.getElementById("dd-compare"), {
    options: () => geoOptions().filter((g) => !state.geos.includes(g)),
    selected: () => sel().compareGeos,
    hint: "Pick more to compare against their combined average.",
    onToggle: (code) => toggleIn(sel().compareGeos, code),
  });

  document.getElementById("primary-select").addEventListener("change", (e) => {
    sel().band = e.target.value; commit();
  });
  document.getElementById("compare-mode").addEventListener("change", (e) => {
    sel().compareMode = e.target.value; commit();
  });
  document.getElementById("compare-select").addEventListener("change", (e) => {
    sel().compareBand = e.target.value;
    commit();
  });

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

function syncUrl() {
  const s = sel();
  const params = new URLSearchParams();
  params.set("view", state.view);
  params.set("geo", state.geos.join(","));
  params.set("band", s.band);
  params.set("by", s.compareMode);
  params.set("vs", s.compareMode === "band" ? s.compareBand : s.compareGeos.join(","));
  history.replaceState(null, "", `?${params}`);
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  if (VIEWS[p.get("view")]) state.view = p.get("view");
  const s = sel(), opts = DIMENSIONS[state.view].options;
  const geos = (p.get("geo") || "").split(",")
    .filter((g) => LABELS.geo[g] && g !== REF_GEO);
  if (geos.length) state.geos = geos;
  if (opts.includes(p.get("band"))) s.band = p.get("band");
  if (p.get("by") === "band" || p.get("by") === "geo") s.compareMode = p.get("by");
  const vs = p.get("vs");
  if (s.compareMode === "band" && opts.includes(vs)) s.compareBand = vs;
  if (s.compareMode === "geo" && vs) {
    const list = vs.split(",").filter((g) => LABELS.geo[g] && g !== REF_GEO
      && !state.geos.includes(g));
    if (list.length) s.compareGeos = list;
  }
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
