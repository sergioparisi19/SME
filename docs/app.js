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

/* Short forms of the size bands. Eurostat's own labels ("From 10 to 49 persons
 * employed") do not fit a badge, and once several bands are combined into one
 * series they do not fit a legend entry either. */
const SIZE_BADGE = {
  SMALL_10_49: "10–49",
  MEDIUM_50_249: "50–249",
  LARGE_GE250: "250+",
  SME_10_249: "SME",
  ALL_GE10: "10+",
};
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

/* Both sides of the comparison are lists, never single codes: a side is one or
 * more countries crossed with one or more bands, and the whole page averages
 * over that set. A single selection is simply a list of one. */
const state = {
  view: "firm",
  geos: ["IT"],           // one country, or several combined into one figure
  firm: {
    bands: ["SMALL_10_49"],       // one size band, or several combined
    compareMode: "band",          // band | geo
    compareBands: ["LARGE_GE250"],
    compareGeos: ["DE"],
  },
  sector: {
    bands: ["C"],
    compareMode: "band",
    compareBands: ["J"],
    compareGeos: ["DE"],
  },
  individual: {
    bands: ["Y25_34"],
    compareMode: "band",
    compareBands: ["Y55_64"],
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

/* --- how many businesses sit in each cell -------------------------------- */

/**
 * Every average this page computes is weighted by the number of businesses in
 * each cell it combines - a cell being one country crossed with one band. The
 * weights are the business-register counts already carried on the rows; they
 * are indexed once here so any chart can look up the weight for a cell,
 * including the charts whose own percentages are a share of something narrower
 * than all enterprises and which therefore ship no counts of their own.
 *
 * Keyed by field, so a size band and a sector never collide.
 */
const WEIGHTS = {};

/* The breakdowns a group can be built from, and the column that says how big
 * each cell is. Only the enterprise column exists today: the household survey
 * publishes percentages of people with no population beside them, so an age
 * group is a plain average until a population table is added to the pipeline.
 * Naming the column here is all this layer needs to start weighting them. */
const BREAKDOWN_FIELDS = ["size_emp", "nace_r2", "ind_type"];
const COUNT_COLUMNS = ["enterprise_count", "person_count"];

function buildWeights() {
  Object.values(SERIES).forEach((chart) => {
    const field = BREAKDOWN_FIELDS.find((f) => chart.columns.includes(f));
    const countCol = COUNT_COLUMNS.find((c) => chart.columns.includes(c));
    if (!field || !countCol) return;
    const at = {
      geo: chart.columns.indexOf("geo"),
      time: chart.columns.indexOf("time"),
      code: chart.columns.indexOf(field),
      count: chart.columns.indexOf(countCol),
    };
    chart.rows.forEach((row) => {
      const count = row[at.count];
      if (typeof count !== "number" || count <= 0) return;
      const key = `${field}|${row[at.geo]}|${row[at.code]}`;
      (WEIGHTS[key] ??= {})[row[at.time]] = count;
    });
  });
}

/**
 * The weight for one cell: its own year's count where the register has one,
 * otherwise the nearest year's.
 *
 * The register runs 2021-2024 while the survey runs to 2025, so insisting on an
 * exact year would drop the newest figures back to an unweighted mean - and the
 * difference between a weighted and an unweighted average of countries is far
 * larger than the drift in how many businesses a country holds from one year to
 * the next. `exact` says which happened, so a card can label it.
 */
function weightAt(field, geo, code, time) {
  const byYear = WEIGHTS[`${field}|${geo}|${code}`];
  if (!byYear) return null;
  if (byYear[time]) return { count: byYear[time], year: time, exact: true };
  const nearest = Object.keys(byYear)
    .sort((a, b) => Math.abs(a - time) - Math.abs(b - time) || b - a)[0];
  return nearest === undefined
    ? null
    : { count: byYear[nearest], year: nearest, exact: false };
}

function label(kind, code) {
  const entry = LABELS[kind]?.[code];
  if (entry === undefined) return code;
  return typeof entry === "string" ? entry : entry.label;
}

const bandLabel = (code) => label("size_emp", code).replace(" persons employed", "");
const cutLabel = (code) => LABELS.ind_type?.[code]?.label ?? code;

/* Eurostat's age labels are already short ("25-34"), so the badge is the label
 * itself. Only the total needs shortening, and naming its range rather than
 * calling it "all" keeps it comparable to the bands beside it. */
const cutBadge = (code) => (code === "IND_TOTAL" ? "16–74" : cutLabel(code));

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
 * `multi` decides whether the breakdown is a multi-select.
 *
 * Only the age bands carry it. A size band is a group a reader compares, not
 * one they build: Eurostat already publishes the two combinations anyone wants
 * - SME_10_249 and ALL_GE10 - as their own bands, weighted by Eurostat, so
 * combining 10–49 with 50–249 by hand only reproduces a published figure less
 * accurately. Age bands have no such published combination: "the workforce",
 * "everyone under 45", "the cohort about to retire" exist only if the reader
 * builds them.
 */
const DIMENSIONS = {
  firm: {
    control: "Size band", field: "size_emp", noun: "size band", multi: false,
    options: SIZE_ORDER, labelOf: bandLabel, badgeOf: (c) => SIZE_BADGE[c] ?? c,
    clean: "10–49, 50–249 and 250+",
  },
  sector: {
    control: "Sector", field: "nace_r2", noun: "sector", multi: false,
    options: SECTIONS, labelOf: sectorLabel, badgeOf: (c) => c,
    clean: "any two sectors",
  },
  individual: {
    control: "Age band", field: "ind_type", noun: "age band", multi: true,
    options: AGE_ORDER, labelOf: cutLabel, badgeOf: cutBadge,
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

/* The project's home country. It stays the default selection, and leads the
 * badge row whenever it is part of a group, so a reader scanning a large
 * selection still sees Italy first. */
const HOME_GEO = "IT";
const homeFirst = (geos) =>
  [...geos].sort((a, b) => (b === HOME_GEO) - (a === HOME_GEO));

/**
 * The one or two slices every chart draws.
 *
 * Comparing by band holds the country fixed and varies the band; comparing by
 * country holds the band fixed and varies the country. Labels name whichever
 * one is varying, because repeating the constant in both legend entries tells
 * the reader nothing.
 */
function facets() {
  const s = sel();
  const byBand = s.compareMode === "band";
  const a = {
    geos: state.geos, bands: s.bands, slot: SERIES_SLOTS[0],
    label: byBand ? bandsLabel(s.bands) : geosLabel(state.geos),
  };
  const b = byBand
    ? { geos: state.geos, bands: s.compareBands, slot: SERIES_SLOTS[1],
        label: bandsLabel(s.compareBands) }
    : { geos: s.compareGeos, bands: s.bands, slot: SERIES_SLOTS[1],
        label: geosLabel(s.compareGeos) };

  // Same slice twice is one series, not two identical bars.
  const sameSet = (x, y) => x.length === y.length && x.every((v) => y.includes(v));
  return sameSet(a.bands, b.bands) && sameSet(a.geos, b.geos) ? [a] : [a, b];
}

/** Eurostat's own aggregate, read for whatever breakdown is selected. */
const euFacet = () => ({ geos: [REF_GEO], bands: sel().bands, label: "EU27" });

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

/**
 * The same for a selection of bands. A combined group is named with the short
 * badges joined by "+", which reads as the addition it is; past three the count
 * carries it, as with countries.
 */
function bandsLabel(bands) {
  const d = dim();
  if (bands.length === 1) return d.labelOf(bands[0]);
  if (bands.length <= 3) return bands.map((c) => d.badgeOf(c)).join(" + ");
  return `${bands.length} ${d.noun}s`;
}

/** What stays fixed across the comparison - it belongs in the title, not the legend. */
function heldConstant() {
  const s = sel();
  return s.compareMode === "band" ? geosLabel(state.geos) : bandsLabel(s.bands);
}

/**
 * Combine one value per cell into a single figure, the way Eurostat builds
 * EU27: weighted by how many businesses each cell holds, never one cell one
 * vote. A cell is a country crossed with a band, so this is the same operation
 * whether the reader selected several countries, several size bands, or both -
 * the group is the cross product and every member of it counts in proportion
 * to its businesses.
 *
 * Weighting needs a count for every cell. Where one is missing the result falls
 * back to an unweighted mean, and `weighted` says which happened so the caller
 * can label it honestly rather than implying precision it lacks.
 */
function aggregateValues(records, field, weightable) {
  const rs = records.filter((r) => typeof r.value === "number");
  if (!rs.length) return null;
  if (rs.length === 1) {
    return { value: rs[0].value, weighted: false, n: 1, carried: false };
  }
  const weights = rs.map((r) => weightAt(field, r.geo, r[field], r.time));
  const canWeight = weightable !== false && weights.every((w) => w && w.count > 0);
  if (canWeight) {
    const total = weights.reduce((a, w) => a + w.count, 0);
    return {
      value: rs.reduce((acc, r, i) => acc + r.value * weights[i].count, 0) / total,
      weighted: true, n: rs.length,
      carried: weights.some((w) => !w.exact),
    };
  }
  return {
    value: rs.reduce((acc, r) => acc + r.value, 0) / rs.length,
    weighted: false, n: rs.length, carried: false,
  };
}

/** The rows one side of the comparison covers in one year: geos x bands. */
const cellsOf = (chartId, indicator, f, time) =>
  where(chartId, { indicator, [dim().field]: f.bands, time, geo: f.geos });

/**
 * Decide once, for a whole series, whether it can be weighted.
 *
 * Deciding year by year would weight a trend's 2024 point and not its 2025 one
 * - two different methods inside one line, and a step in the series that is an
 * artefact of the method rather than anything in the data. If any cell in any
 * year the series needs has no weight, the whole series falls back to a plain
 * average.
 */
function weightingMode(chartId, indicator, f, times) {
  const field = dim().field;
  if (f.geos.length * f.bands.length < 2) return false;
  return times.every((t) => cellsOf(chartId, indicator, f, t)
    .every((r) => weightAt(field, r.geo, r[field], r.time)));
}

function facetStat(chartId, indicator, f, time, weightable) {
  return aggregateValues(cellsOf(chartId, indicator, f, time), dim().field, weightable);
}

const facetValue = (chartId, indicator, f, time, weightable) =>
  facetStat(chartId, indicator, f, time, weightable)?.value ?? null;

/**
 * Eurostat's published aggregate for the selected breakdown.
 *
 * With one band this is the published figure, shown exactly as published. With
 * several it combines EU27's own published figure for each band, weighted by
 * EU27's own business counts - still Eurostat's numbers throughout, never an
 * average of the member states.
 */
function euValueAt(chartId, indicator, time, times = [time]) {
  const f = euFacet();
  return facetValue(chartId, indicator, f, time,
    weightingMode(chartId, indicator, f, times));
}

/**
 * How a group was combined, in one sentence, or null when nothing was combined.
 *
 * Written per side and de-duplicated: two sides that landed on the same method
 * do not need saying twice.
 */
function weightingNote(chartId, indicator, fs, times) {
  if (!times.length) return null;
  const groups = fs.filter((f) => f.geos.length * f.bands.length > 1);
  const messages = new Set(groups.map((f) => {
    const stat = facetStat(chartId, indicator, f, times[times.length - 1],
      weightingMode(chartId, indicator, f, times));
    if (!stat?.weighted) {
      return "The selection is combined as a plain average, each part counting equally. "
        + (state.view === "individual"
          ? "These figures count people rather than businesses and Eurostat publishes no "
            + "population size beside them, so there is nothing to weight by."
          : "No business count is published for every part of this selection, so it cannot "
            + "be weighted the way EU27 is.");
    }
    let text = "The selection is combined the way Eurostat builds EU27 — every country and "
      + `${dim().noun} in it weighted by how many businesses it holds, not a plain average.`;
    if (SERIES[chartId].weightable !== true) {
      text += " This measure is a share of a narrower group than all businesses, and Eurostat "
        + "does not publish the size of that group, so the weights are how many businesses each "
        + "part holds in total — a proxy, not the exact denominator.";
    }
    if (stat.carried) {
      text += " Years the business register does not reach borrow the nearest year's counts,"
        + " so one method holds across the whole series.";
    }
    return text;
  }));
  return messages.size ? [...messages].join(" ") : null;
}

function bandsOverlap(a, b) {
  if (a === b) return true;
  return (CONTAINS[a] || []).includes(b) || (CONTAINS[b] || []).includes(a);
}

/** The first pair inside one selection where one band contains the other. */
function overlapInside(bands) {
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      if (bandsOverlap(bands[i], bands[j])) return [bands[i], bands[j]];
    }
  }
  return null;
}

/**
 * Overlap is now possible in two places, and they are different mistakes.
 *
 * Inside one selection it double-counts: combining "10 to 249" with "10 to 49"
 * puts the same firms in the group twice, and the weighted average leans on
 * them twice over. Between the two sides it is not a comparison at all, but a
 * part measured against its whole. Both get said, in that order.
 */
function overlapWarning() {
  const s = sel(), d = dim();
  const notes = [];

  const within = (bands, side) => {
    const pair = overlapInside(bands);
    if (!pair) return;
    notes.push(`${side} combines ${d.labelOf(pair[0])} with ${d.labelOf(pair[1])}, and one `
      + `contains the other, so those businesses count twice in it. Pick ${d.clean} for a `
      + "group that adds up.");
  };
  within(s.bands, "Your selection");

  if (s.compareMode === "band") {
    within(s.compareBands, "The comparison");
    const across = s.bands.some((a) => s.compareBands.some((b) => bandsOverlap(a, b)));
    if (across) {
      const identical = s.bands.length === s.compareBands.length
        && s.bands.every((c) => s.compareBands.includes(c));
      notes.push(identical
        ? "Both sides are the same selection, so only one series is shown."
        : `The two sides overlap: ${bandsLabel(s.bands)} and ${bandsLabel(s.compareBands)} are `
          + `not mutually exclusive, so one holds part of the other. Pick ${d.clean} for a `
          + "clean comparison.");
    }
  }
  return notes.length ? notes.join(" ") : null;
}

/* --- small helpers ------------------------------------------------------ */

const NOT_PUBLISHED = "Not published";

const fmt = (v, digits = 1) =>
  (v === null || v === undefined ? NOT_PUBLISHED : v.toFixed(digits));

/**
 * Why a figure is missing. Eurostat withholds a cell when too few surveyed
 * firms fall into it to give a reliable estimate, so an empty row means "not
 * enough of this kind of business to measure", not "none of them do this" -
 * two readings a blank space cannot distinguish on its own.
 */
const MISSING_REASON = "Eurostat withholds figures where too few surveyed businesses fall into the cell to be reliable.";

/** One sentence naming what is absent, or null when nothing is. */
function missingNote(labels) {
  if (!labels.length) return null;
  const list = labels.length <= 3
    ? labels.join(", ").replace(/, ([^,]*)$/, " and $1")
    : `${labels.length} of them`;
  return `${list} not published for this selection. ${MISSING_REASON}`;
}

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

/* A touch has no mouseleave. Mobile browsers synthesize a mousemove on tap, so
 * a tooltip does appear - and would then sit there until the next tap landed on
 * another mark. Scrolling or touching anywhere else dismisses it. */
document.addEventListener("touchstart", hideTip, { passive: true });

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

/* --- responsive geometry ------------------------------------------------ */

/**
 * The coordinate space a chart draws in, decided from the width it will really
 * occupy rather than from the device.
 *
 * Above the breakpoint nothing changes: the charts keep the fixed 780/900-unit
 * viewBox they were designed in, which the container scales up slightly. Below
 * it, the viewBox is set to the container's own pixel width so that one unit is
 * one pixel — the whole reason a phone renders these unreadably today is that a
 * 900-unit box squeezed into 320px takes a 12px label down to four.
 *
 * Everything downstream branches on `narrow`, never on a user-agent string: a
 * desktop window dragged narrow has exactly the same problem as a phone.
 */
const NARROW_AT = 560;

function geometry(container, wide) {
  const measured = Math.round(container.getBoundingClientRect().width) || wide;
  return measured < NARROW_AT
    ? { narrow: true, width: Math.max(280, measured) }
    : { narrow: false, width: wide };
}

/**
 * Cut a label to what fits a gutter, keeping the full text for the tooltip.
 *
 * ~6.1px per character at 11-12px in the system sans, measured on the labels
 * this page actually draws (country and sector names, not caps or digits).
 */
function fitLabel(text, px) {
  const max = Math.max(4, Math.floor(px / 6.1));
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/* --- chart primitives --------------------------------------------------- */

/** Horizontal ranked bars. One series, so one colour; `highlight` lifts members. */
function rankedBars(container, items, { unitNote }) {
  const { narrow, width } = geometry(container, 780);
  // A row is also a hit target: 26 units, one pixel each, clears the 24px floor
  // a finger needs. The label gutter is the first thing a phone cannot afford,
  // so it shrinks and the names that no longer fit are clipped, with the full
  // one on the label's own tooltip.
  const rowH = narrow ? 26 : 22;
  const padL = narrow ? 92 : 150;
  const padR = narrow ? 46 : 58;
  const padT = 8;
  const height = items.length * rowH + padT + 18;
  const plotW = width - padL - padR;
  const { max } = niceScale(Math.max(...items.map((d) => d.value ?? 0), 1), narrow ? 2 : 4);
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  const fills = {
    main: gradientFill(svg, `var(${SERIES_SLOTS[0]})`),
    alt: gradientFill(svg, `var(${SERIES_SLOTS[1]})`),
    ref: gradientFill(svg, "var(--ink-muted)"),
  };
  // Ordered categories bring their own ramp step with them; one gradient per
  // distinct colour, not per bar.
  const ramp = {};
  const rampFill = (color) => (ramp[color] ??= gradientFill(svg, color));

  (narrow ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).forEach((t) => {
    const x = padL + t * plotW;
    svg.appendChild(el("line", { x1: x, x2: x, y1: padT, y2: height - 18, class: "grid-line" }));
    svg.appendChild(el("text", {
      x, y: height - 4, class: "tick-label", "text-anchor": "middle",
      text: `${narrow ? Math.round(t * max) : +(t * max).toFixed(1)}%`,
    }));
  });

  // The gutter, less the 10 units of air before the bar starts.
  const fitted = (d) => fitLabel(d.label, padL - 12);
  const catLabel = (d, attrs) => {
    const node = el("text", { ...attrs, text: fitted(d) });
    if (fitted(d) !== d.label) {
      node.classList.add("clipped");
      node.appendChild(el("title", { text: d.label }));
    }
    return node;
  };

  items.forEach((d, i) => {
    const y = padT + i * rowH;
    if (d.value === null || d.value === undefined) {
      // A dropped row reads as "we never asked"; a marked one reads as
      // "measured, then withheld", which is what actually happened.
      svg.appendChild(catLabel(d, {
        x: padL - 10, y: y + rowH / 2 + 1, class: "cat-label missing",
        "text-anchor": "end",
      }));
      svg.appendChild(el("line", {
        x1: padL, x2: padL + 14, y1: y + rowH / 2 - 1, y2: y + rowH / 2 - 1,
        class: "missing-rule",
      }));
      const tag = el("text", {
        x: padL + 20, y: y + rowH / 2 + 1, class: "value-label missing",
        text: NOT_PUBLISHED,
      });
      tag.appendChild(el("title", { text: MISSING_REASON }));
      svg.appendChild(tag);
      return;
    }
    const w = Math.max(2, (d.value / max) * plotW);
    const kind = d.reference ? "ref" : (d.alt ? "alt" : "main");
    const solid = d.color ?? (d.reference ? "var(--ink-muted)" : `var(${SERIES_SLOTS[d.alt ? 1 : 0]})`);
    const lifted = d.highlight || d.reference;
    const bar = el("rect", {
      x: padL, y: y + 4, width: w, height: rowH - 10, rx: 4,
      class: "bar-x", fill: d.color ? rampFill(d.color) : fills[kind],
      "fill-opacity": lifted ? 1 : 0.4,
      style: `animation-delay:${Math.min(i * 3, 90)}ms`,
    });
    attachTip(bar, `<div class="tt-title">${d.label}</div>
      ${tipRow(solid, `${fmt(d.value)}%`)}<div class="tt-base">${unitNote}</div>`);
    svg.appendChild(bar);
    svg.appendChild(catLabel(d, {
      x: padL - 10, y: y + rowH / 2 + 1, class: "cat-label", "text-anchor": "end",
      "font-weight": lifted ? 600 : 400,
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
  const { narrow, width } = geometry(container, 900);
  // Eurostat's indicator names are sentences. A 292-unit gutter holds one; a
  // phone has no such gutter to give, so the name moves onto its own line above
  // the bars it belongs to and the bars take the full width underneath.
  const barH = narrow ? 13 : 14;
  const rowGap = narrow ? 15 : 16;
  const labelBand = narrow ? 19 : 0;
  const groupH = labelBand + (narrow ? 14 : 22) + series.length * rowGap;
  const padL = narrow ? 0 : 292;
  const padR = narrow ? 44 : 62;
  const padT = 8;
  const height = categories.length * groupH + padT + 22;
  const plotW = width - padL - padR;
  const { max } = niceScale(Math.max(...series.flatMap((s) => s.values.map((v) => v ?? 0)), 1), 2);
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });
  const fills = series.map((s) => gradientFill(svg, `var(${s.slot})`));

  [0, 0.5, 1].forEach((t) => {
    const x = padL + t * plotW;
    svg.appendChild(el("line", { x1: x, x2: x, y1: padT, y2: height - 22, class: "grid-line" }));
    svg.appendChild(el("text", {
      // With no label gutter the zero tick sits on the left edge, where a
      // centred label would hang outside the box.
      x, y: height - 6, class: "tick-label",
      "text-anchor": narrow && t === 0 ? "start" : "middle",
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
    const text = narrow ? fitLabel(cat.short, plotW + padR - 6) : cat.short;
    const labelNode = el("text", {
      x: narrow ? 0 : padL - 14,
      y: narrow ? top + 11 : top + groupH / 2,
      "text-anchor": narrow ? "start" : "end", text,
      class: `cat-label${text.endsWith("…") ? " clipped" : ""}`,
    });
    labelNode.appendChild(el("title", { text: cat.label }));
    attachTip(labelNode, tip, false);
    svg.appendChild(labelNode);

    series.forEach((s, j) => {
      const v = s.values[i];
      const y = top + labelBand + (narrow ? 1 : 9) + j * rowGap;
      if (v === null || v === undefined) {
        svg.appendChild(el("line", {
          x1: padL, x2: padL + 14, y1: y + barH / 2, y2: y + barH / 2, class: "missing-rule",
        }));
        const tag = el("text", {
          x: padL + 20, y: y + barH - 3, class: "value-label missing", text: NOT_PUBLISHED,
        });
        tag.appendChild(el("title", { text: MISSING_REASON }));
        svg.appendChild(tag);
        return;
      }
      // 2px surface gap between adjacent fills rather than a stroke around them.
      const w = Math.max(2, (v / max) * plotW);
      const bar = el("rect", {
        x: padL, y, width: w, height: barH, rx: 4, fill: fills[j], class: "bar-x",
        style: `animation-delay:${Math.min(i * 12 + j * 6, 90)}ms`,
      });
      attachTip(bar, tip);
      svg.appendChild(bar);
      svg.appendChild(el("text", {
        x: padL + w + 8, y: y + barH - 3, class: "value-label", text: `${fmt(v, 0)}%`,
      }));
    });
  });
  container.appendChild(svg);
  container.appendChild(legend(series));
}

/** Multi-line trend. Endpoints are direct-labelled; no number on every point. */
function lineChart(container, xs, series, { unitNote }) {
  const { narrow, width } = geometry(container, 900);
  // The endpoint labels keep their gutter on a phone but not their length: a
  // series names itself in the legend directly underneath, so the label on the
  // line only has to be enough to tell three lines apart.
  const padL = narrow ? 38 : 46;
  const padR = narrow ? 54 : 132;
  const padT = 16, padB = 30;
  const height = narrow ? 250 : 320;
  const plotW = width - padL - padR, plotH = height - padT - padB;
  const { max } = niceScale(Math.max(...series.flatMap((s) => s.points.map((p) => p.y ?? 0)), 10));
  const x = (i) => padL + (xs.length === 1 ? plotW / 2 : (i / (xs.length - 1)) * plotW);
  const y = (v) => padT + plotH - (v / max) * plotH;
  const svg = el("svg", { viewBox: `0 0 ${width} ${height}`, role: "img" });

  for (let t = 0; t <= 4; t++) {
    const gy = padT + (t / 4) * plotH;
    svg.appendChild(el("line", { x1: padL, x2: padL + plotW, y1: gy, y2: gy, class: "grid-line" }));
    const tick = max - (t / 4) * max;
    svg.appendChild(el("text", {
      // A decimal point costs six units of a gutter a phone does not have, and
      // the tooltip carries the exact figure anyway.
      x: padL - 9, y: gy + 4, class: "tick-label", "text-anchor": "end",
      text: `${narrow ? Math.round(tick) : +tick.toFixed(1)}%`,
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
      const tip = `<div class="tt-title">${xs[i]}</div>
        ${series.map((o) => o.points[i]?.y === null || o.points[i] === undefined ? ""
          : tipRow(o.reference ? "var(--ink-muted)" : `var(${o.slot})`,
                   `${o.label}: ${fmt(o.points[i].y)}%`)).join("")}
        <div class="tt-base">${unitNote}</div>`;
      attachTip(dot, tip);
      svg.appendChild(dot);
      // A 9px dot is a fingertip's worth of nothing. On a phone an invisible
      // 26px disc sits over it and carries the same tooltip.
      if (narrow) {
        const hit = el("circle", { cx: x(i), cy: y(p.y), r: 13, fill: "transparent" });
        attachTip(hit, tip, false);
        svg.appendChild(hit);
      }
    });
    const last = s.points.map((p, i) => [p, i]).filter(([p]) => p.y !== null).pop();
    if (last) {
      endLabels.push({
        x: x(last[1]) + (narrow ? 7 : 11), y: y(last[0].y) + 4, fill: stroke,
        text: narrow ? fitLabel(s.short ?? s.label, padR - 10) : s.label,
      });
    }
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
function card(parent, { title, note, warn, empty, draw, table }) {
  const box = el("div", { class: "card" });
  const head = el("div", { class: "card-head" });
  head.appendChild(el("h3", { class: "card-title", text: title }));
  const toggle = el("button", { class: "table-toggle", type: "button", text: "Show data" });
  if (!empty) head.appendChild(toggle);
  box.appendChild(head);
  if (note) box.appendChild(el("p", { class: "card-note", text: note }));
  if (warn) box.appendChild(el("p", { class: "card-warn", text: warn }));

  // Nothing to draw at all. An empty plot with axes and a legend reads as
  // "everything is zero"; saying so in words reads as what it is.
  if (empty) {
    box.appendChild(el("p", { class: "card-empty", text: empty }));
    parent.appendChild(box);
    return;
  }

  const chart = el("div", { class: "chart" });
  box.appendChild(chart);
  // In the document before it is drawn, so the chart can measure the width it
  // will actually occupy rather than assuming a desktop one.
  parent.appendChild(box);
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
}

function renderTable({ columns, rows: body }) {
  // The table is the relief for every chart, so it must survive a narrow card:
  // it scrolls inside its own box rather than widening the page.
  const scroller = el("div", { class: "table-scroll" });
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
  scroller.appendChild(t);
  return scroller;
}

/* --- absolute counts ----------------------------------------------------- */

/** 1,393,956 -> "1.39 million". Percentages are precise; counts are estimates,
 *  so showing every digit would claim an accuracy the join does not have. */
function compactCount(n) {
  if (n === null || n === undefined) return NOT_PUBLISHED;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} million`;
  if (n >= 1e3) return `${Math.round(n / 1e3)},000`;
  return Math.round(n).toLocaleString();
}

/**
 * Turn percentages into a number of businesses.
 *
 * Strictly same-year: the count must come from the very year the rest of the
 * page is showing. The business register often trails the survey by a year,
 * and pairing this year's percentage with last year's business count produces
 * a figure that looks authoritative and belongs to neither year. Where the
 * years do not line up this returns null, and the section removes itself
 * rather than quoting a number from a different year.
 */
function absoluteCounts(chartId, indicator, f) {
  if (SERIES[chartId].weightable !== true) return null;
  // Summing overlapping bands would count the same firms twice, and a count is
  // the one figure on this page a reader is entitled to read as a count. The
  // section removes itself rather than publishing a number that double-counts.
  if (overlapInside(f.bands)) return null;
  const time = latestYear(chartId, { indicator });
  if (!time) return null;
  const recs = cellsOf(chartId, indicator, f, time)
    .filter((r) => typeof r.enterprise_count === "number" && r.enterprise_count > 0);
  if (!recs.length) return null;
  const total = recs.reduce((a, r) => a + r.enterprise_count, 0);
  const doing = recs.reduce((a, r) => a + r.enterprise_count * r.value / 100, 0);
  return { time, total, doing, missing: total - doing, n: recs.length };
}

function countsCard(root, { chartId, indicator, title, note }) {
  const f = facets()[0];
  const c = absoluteCounts(chartId, indicator, f);
  if (!c) return;   // the section is filtered out before this, but stay safe

  const tiles = el("div", { class: "tiles" });
  const tile = (k, v, sub, accent) => {
    const node = el("div", { class: "tile", style: accent ? `--tile-accent: var(${accent})` : null });
    node.appendChild(el("div", { class: "k", text: k }));
    node.appendChild(el("div", { class: "v v-count", text: v }));
    node.appendChild(el("div", { class: "sub", text: sub }));
    return node;
  };
  const who = `${bandsLabel(f.bands)} · ${geosLabel(f.geos)}, ${c.time}`;
  tiles.appendChild(tile("Businesses of this size", compactCount(c.total), who));
  tiles.appendChild(tile("Using AI", compactCount(c.doing), who, SERIES_SLOTS[0]));
  tiles.appendChild(tile("Not using AI", compactCount(c.missing), who, SERIES_SLOTS[1]));
  root.appendChild(tiles);

  root.appendChild(el("p", { class: "card-warn", text:
    `${note} Counts come from the business register and percentages from the ICT survey — two overlapping but not identical populations — so these are estimates, not exact counts. Both figures are for ${c.time}; where the register has not caught up with the survey this section is not shown at all.` }));
}

/* --- generic section renderers ------------------------------------------ */

function headlineTiles(root, { chartId, indicator }) {
  const year = latestYear(chartId, { indicator });
  const fs = facets();
  const ref = euValueAt(chartId, indicator, year);

  const tiles = el("div", { class: "tiles" });
  const tile = (k, v, sub, cls, accent) => {
    const node = el("div", {
      class: `tile${cls ? ` ${cls}` : ""}`,
      style: accent ? `--tile-accent: var(${accent})` : null,
    });
    node.appendChild(el("div", { class: "k", text: k }));
    node.appendChild(el("div", {
      class: `v${/^[0-9]/.test(String(v)) ? "" : " v-text"}`, text: v,
    }));
    node.appendChild(el("div", { class: "sub", text: sub }));
    return node;
  };

  const wA = weightingMode(chartId, indicator, fs[0], [year]);
  const a = facetValue(chartId, indicator, fs[0], year, wA);
  const b = fs[1]
    ? facetValue(chartId, indicator, fs[1], year, weightingMode(chartId, indicator, fs[1], [year]))
    : null;
  const who = `${heldConstant()}, ${year}`;
  const pct = (v) => (v === null || v === undefined ? NOT_PUBLISHED : `${fmt(v)}%`);
  const why = (v) => (v === null || v === undefined ? MISSING_REASON : who);
  tiles.appendChild(tile(fs[0].label, pct(a), why(a), "accent", SERIES_SLOTS[0]));
  if (fs[1]) tiles.appendChild(tile(fs[1].label, pct(b), why(b), "compare", SERIES_SLOTS[1]));
  const multiple = a && b ? b / a : null;
  const gapSub = !fs[1] ? "Pick a different comparison to see a gap."
    : multiple ? `${fs[1].label} vs ${fs[0].label}`
    : "A gap needs a published figure on both sides.";
  tiles.appendChild(tile("The gap", multiple ? `${multiple.toFixed(1)}x` : "—", gapSub));
  tiles.appendChild(tile("EU27 benchmark", `${fmt(ref)}%`,
    `Eurostat's published aggregate · ${bandsLabel(sel().bands)}`));
  root.appendChild(tiles);

  // Either side of the comparison can be a group - of countries, of bands, or
  // of both - and each side decides its own weighting, so the note is built per
  // side rather than assuming the primary selection speaks for both.
  const method = weightingNote(chartId, indicator, fs, [year]);
  if (method) root.appendChild(el("p", { class: "card-warn", text: method }));
  if (sel().bands.length > 1) {
    const euWeighted = weightingMode(chartId, indicator, euFacet(), [year]);
    root.appendChild(el("p", { class: "card-warn", text:
      "The EU27 benchmark combines Eurostat's own published figure for each selected "
      + `${dim().noun}, ${euWeighted ? "weighted by EU27's own counts" : "as a plain average"}.`
      + " It is never an average of the member states, and with a single band selected it is"
      + " shown exactly as published." }));
  }
  const overlap = overlapWarning();
  if (overlap) root.appendChild(el("p", { class: "card-warn", text: overlap }));
}

function trendCard(root, { chartId, indicator, title, note }) {
  const unitNote = unitNoteFor(SERIES[chartId].unit);
  const xs = yearsOf(chartId, { indicator });
  const fs = facets();
  const eu = (t) => euValueAt(chartId, indicator, t, xs);

  card(root, {
    title: `${title} — ${heldConstant()}`,
    note: [note, weightingNote(chartId, indicator, fs, xs)].filter(Boolean).join(" "),
    warn: overlapWarning(),
    draw: (c) => lineChart(c, xs, [
      ...fs.map((f) => {
        const w = weightingMode(chartId, indicator, f, xs);
        return {
          label: f.label, slot: f.slot,
          points: xs.map((t) => ({ y: facetValue(chartId, indicator, f, t, w) })),
        };
      }),
      { label: `EU27 · ${bandsLabel(sel().bands)}`, short: "EU27", reference: true,
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
  const present = where(chartId, { indicator, [d.field]: s.bands, time: year });
  const have = new Set(present.map((r) => r.geo));
  const mine = [...state.geos, ...(s.compareMode === "geo" ? s.compareGeos : []), REF_GEO];

  // One bar per country, each its own weighted average over the selected bands
  // - the ranking varies the country, so the bands are what gets combined.
  const valueOf = (geo) => {
    const f = { geos: [geo], bands: s.bands };
    return facetValue(chartId, indicator, f, year,
      weightingMode(chartId, indicator, f, [year]));
  };

  // Countries the reader actually chose appear even when Eurostat publishes
  // nothing for them - their absence is the finding. Everyone else is counted
  // in a note rather than padding the chart with empty rows.
  const missingMine = mine.filter((g) => !have.has(g));
  const othersMissing = geoOptions().filter((g) => !have.has(g) && !mine.includes(g)).length;

  const decorate = (geo, value) => ({
    code: geo, label: shortGeo(geo), value,
    highlight: state.geos.includes(geo)
      || (s.compareMode === "geo" && s.compareGeos.includes(geo)),
    alt: s.compareMode === "geo" && s.compareGeos.includes(geo)
      && !state.geos.includes(geo),
    reference: geo === REF_GEO,
  });

  const build = () => [
    ...[...have].map((geo) => decorate(geo, valueOf(geo))),
    ...missingMine.map((g) => decorate(g, null)),
  ].sort((a, b) => (b.value ?? -1) - (a.value ?? -1));

  const notes = [note, missingNote(missingMine.map(shortGeo))];
  if (othersMissing) {
    notes.push(`${othersMissing} further ${othersMissing === 1 ? "country does" : "countries do"} not publish this figure and are left out of the ranking.`);
  }
  if (s.bands.length > 1) {
    const weighted = weightingMode(chartId, indicator,
      { geos: [state.geos[0]], bands: s.bands }, [year]);
    notes.push(`Each bar combines the selected ${d.noun}s`
      + (weighted ? ", weighted by how many that country holds in each." : " as a plain average.")
      + " A country that publishes only some of them is averaged over the ones it publishes.");
  }

  card(root, {
    title: `${title} — ${bandsLabel(s.bands)}, ${year}`,
    note: notes.filter(Boolean).join(" "),
    draw: (c) => rankedBars(c, build(), { unitNote }),
    table: () => ({ columns: ["Country", "%"], rows: build().map((x) => [x.label, fmt(x.value)]) }),
  });
}

function comparisonCard(root, chartId, { title, note, indicators }) {
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
  const euValue = (code) => euValueAt(chartId, code, year) ?? -1;
  categories.sort((a, b) => euValue(b.code) - euValue(a.code));

  const series = fs.map((f) => ({
    label: f.label, slot: f.slot,
    values: categories.map((cat) => facetValue(chartId, cat.code, f, year,
      weightingMode(chartId, cat.code, f, [year]))),
  }));

  const gaps = categories.filter((cat, i) => series.some((ser) => ser.values[i] === null));

  card(root, {
    title: `${title} — ${heldConstant()}, ${year}`,
    empty: categories.length ? null
      : `Eurostat publishes none of these figures for ${heldConstant()} in ${year}. ${MISSING_REASON} Not every country takes part in every part of the survey.`,
    note: [
      note,
      `Rows are ordered by the EU27 figure for ${bandsLabel(sel().bands)}, so changing the selection moves the bars but never the row order.`,
      gaps.length ? `${gaps.length} row${gaps.length === 1 ? " is" : "s are"} missing a figure on one side. ${MISSING_REASON}` : null,
      // Read off the first row that actually has figures: an indicator with no
      // data would report the fallback method rather than the one in use.
      categories.length ? weightingNote(chartId, categories[0].code, fs, [year]) : null,
    ].filter(Boolean).join(" "),
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
  const picked = fs.flatMap((f) => f.bands);

  const build = () => d.options.map((code) => {
    const f = { geos: state.geos, bands: [code] };
    return {
      code, label: d.labelOf(code),
      value: facetValue(chartId, indicator, f, year,
        weightingMode(chartId, indicator, f, [year])),
      highlight: picked.includes(code),
      // The comparison colour belongs to whatever is only on the second side.
      alt: fs.length > 1 && fs[1].bands.includes(code) && !fs[0].bands.includes(code),
    };
  }).sort((a, b) => (b.value ?? -1) - (a.value ?? -1));

  const absent = build().filter((x) => x.value === null).map((x) => x.label);

  card(root, {
    title: `${title} — ${geosLabel(state.geos)}, ${year}`,
    empty: build().some((x) => x.value !== null) ? null
      : `Eurostat publishes none of these figures for ${geosLabel(state.geos)} in ${year}. ${MISSING_REASON}`,
    note: [note, missingNote(absent)].filter(Boolean).join(" "),
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
  const items = options.map((code) => {
    const f = { geos: state.geos, bands: [code] };
    return {
      code, label: d.labelOf(code),
      value: facetValue(chartId, indicator, f, year,
        weightingMode(chartId, indicator, f, [year])),
    };
  });
  const picked = facets().flatMap((f) => f.bands).filter((c) => options.includes(c));

  card(root, {
    title: `${title} — ${geosLabel(state.geos)}, ${year}`,
    note: [note, missingNote(items.filter((x) => x.value === null).map((x) => x.label))]
      .filter(Boolean).join(" "),
    // Six upright bars need six label slots along the bottom, and a phone has
    // room for about three. Turned on its side each label gets a whole line, so
    // a narrow screen gets the ranked layout carrying the ordinal ramp with it -
    // the ordering survives as top-to-bottom instead of left-to-right.
    draw: (c) => {
      if (!geometry(c, 900).narrow) {
        ordinalBars(c, items, { unitNote, highlight: picked });
        return;
      }
      const anyPicked = items.some((x) => picked.includes(x.code));
      rankedBars(c, items.map((x, i) => ({
        ...x,
        color: `var(${ORDINAL_SLOTS[Math.min(i, ORDINAL_SLOTS.length - 1)]})`,
        highlight: !anyPicked || picked.includes(x.code),
      })), { unitNote });
    },
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
  ["Groups overlap, so never add them together",
   "\"10 to 249 employees\" already contains \"10 to 49\", and \"all individuals\" contains every age band. Adding the two would count the same people or companies twice. That is why the page warns you when you compare a group against one it contains — and when you select two overlapping bands into the same group, where the double-counting would sit inside a single number."],
  ["Several countries are combined by weight, not by vote",
   "Select three countries and the page reports one figure for the lot. It builds that figure the way Eurostat builds its EU27 aggregate: each country counts in proportion to how many businesses it has, so Germany does not weigh the same as Malta. Where the business register does not reach the survey's newest year, the nearest year's counts are used rather than dropping the whole series to a plain average."],
  ["Several age bands are combined as a plain average",
   "In the Individuals view you can select several age bands and read them as one group. Eurostat publishes those figures as percentages of people with no population count beside them, so the bands can only be averaged equally — a group of \"16-24 and 25-34\" treats the two as the same size, when in most countries the older band holds more people. It is close enough to compare against another group built the same way, and not exact enough to quote as the figure for everyone aged 16 to 34. Each chart says so underneath."],
  ["One company can appear in several bars",
   "A firm using AI for marketing, logistics and finance is counted in all three bars. The bars answer \"how many do this?\", not \"how do they split up?\", so they will not add to 100%."],
  ["The EU27 line is Eurostat's, not an average of what you picked",
   "The EU27 figure is published by Eurostat and weighted by how many businesses each country has. It is shown exactly as published and never recalculated, so it will always match Eurostat's own tables."],
  ["Counts of businesses are estimates",
   "Percentages come from one survey and the number of businesses from another. The two cover slightly different populations and only overlap for 2021 to 2024, so any figure expressed as a number of companies is an estimate, not an exact count."],
  ["Some figures are simply not published",
   "Where a chart says “not published”, Eurostat measured the cell but withheld the number because too few surveyed businesses fell into it to be reliable. Italy’s energy and water sectors in 2025 are an example: too few firms of 10 or more employees for a dependable estimate. A blank therefore means “too small to measure here”, never “nobody does this” — and it happens more often in small countries and narrow sectors."],
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
  id: "method", part: "Reading it", nav: "How to read this", h2: "How to read this",
  deck: "Ten things that change what these numbers mean. They are worth two minutes before you quote any figure from this page.",
  render: renderMethodology,
};

/* The arc every view follows. Sections are written in whatever order is
 * convenient and sorted into this one, so a part can never appear twice in the
 * nav and the page always reads scale -> distribution -> cause -> foundation. */
const PART_ORDER = [
  "The scale",
  "Where it sits",
  "Why they don't",
  "What is missing underneath",
  "Who can do it",
  "Reading it",
];
const orderedSections = (sections) => [...sections]
  // A section whose data does not exist for this selection is removed, not
  // rendered as an empty shell - a permanent "no data" panel is just clutter.
  .filter((spec) => !spec.available || spec.available())
  .sort((a, b) => PART_ORDER.indexOf(a.part) - PART_ORDER.indexOf(b.part));

const VIEWS = {
  firm: {
    headline: "Europe's small firms are falling behind on AI",
    standfirst: "Eurostat's enterprise ICT surveys, read by firm size. Pick a size band and one or more countries — several countries combine into a single figure, weighted by how many businesses each has — then choose whether to compare it against another size band or against other countries.",
    unitKey: "firm_level",
    sections: [
      { id: "gap", part: "The scale", nav: "The gap", h2: "The gap, in one number",
        deck: "The EU27 figure is Eurostat's own published aggregate, not an average of what you selected — the two are different numbers and the page never conflates them.",
        render: (r) => {
          headlineTiles(r, { chartId: "ai_adoption", indicator: "E_AI_TANY" });
          trendCard(r, { chartId: "ai_adoption", indicator: "E_AI_TANY",
            title: "AI adoption over time",
            note: "Every chart in this view uses the same comparison, so it stays consistent as you scroll." });
        } },
      { id: "how-many", part: "The scale", nav: "How many firms", h2: "How many businesses is that?",
        available: () => absoluteCounts("ai_adoption", "E_AI_TANY", facets()[0]) !== null,
        deck: "A percentage is arguable; a number of companies is harder to wave away. This is the same figure expressed as businesses.",
        render: (r) => countsCard(r, { chartId: "ai_adoption", indicator: "E_AI_TANY",
          title: "Businesses of this size",
          note: "Applies the survey's percentage to the number of registered businesses in the selection." }) },
      { id: "ranking", part: "Where it sits", nav: "By country", h2: "Where each country stands",
        deck: "Ranked on the selected size band. Your selection stays emphasised as the ranking changes.",
        render: (r) => rankingCard(r, { chartId: "ai_adoption", indicator: "E_AI_TANY",
          title: "AI adoption by country",
          note: "Your selection and the EU27 aggregate are emphasised; the rest stay as context." }) },
      { id: "purposes", part: "Where it sits", nav: "What AI is used for", h2: "What AI actually gets used for",
        deck: "Adoption is not one thing. The purposes firms report differ sharply by size.",
        render: (r) => comparisonCard(r, "ai_purposes", {
          title: "What AI gets used for",
          note: "All shares are of the same group — every company in the band — so the bars are directly comparable. A firm using AI for three purposes appears in three rows." }) },
      { id: "barriers", part: "Why they don't", nav: "Why firms stay out", h2: "Why firms stay out",
        deck: "Eurostat asks the firms that considered AI and did not adopt it. Cost and a lack of in-house expertise dominate — and unlike the technology itself, both are addressable.",
        render: (r) => comparisonCard(r, "ai_barriers", {
          title: "Why enterprises do not adopt AI",
          note: "Shares of the companies that considered AI — not of all companies, which is the group every other chart here counts. Reasons are not exclusive." }) },
      { id: "foundations", part: "What is missing underneath", nav: "Digital foundations", h2: "The foundations underneath",
        deck: "AI adoption rarely arrives on its own. Cloud services, data analytics practice and overall digital intensity are what it tends to sit on.",
        render: (r) => comparisonCard(r, "foundations", {
          title: "The digital foundations underneath AI",
          note: "Shares of every company in the band." }) },
      { id: "security", part: "What is missing underneath", nav: "ICT security", h2: "Security is the other unbuilt foundation",
        deck: "The firms without AI expertise are largely the firms without security practice. It is the nearest neighbour to AI adoption — and the one an owner already believes matters.",
        render: (r) => comparisonCard(r, "security", {
          title: "ICT security measures in place",
          note: "Shares of every company in the band." }) },
      { id: "presence", part: "What is missing underneath", nav: "Digital presence", h2: "Before AI, a shop window",
        deck: "Websites, social media and selling online — what a small firm recognises about itself long before it recognises an AI use case.",
        render: (r) => comparisonCard(r, "presence", {
          title: "Digital presence and selling online",
          note: "Shares of every company in the band." }) },
      { id: "skills", part: "What is missing underneath", nav: "ICT skills in the firm", h2: "The skills constraint",
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
      { id: "gap", part: "The scale", nav: "The gap", h2: "The gap, in one number",
        deck: "The EU27 figure is Eurostat's own published aggregate for this sector, not an average of what you selected.",
        render: (r) => {
          headlineTiles(r, { chartId: "sector_adoption", indicator: "E_AI_TANY" });
          trendCard(r, { chartId: "sector_adoption", indicator: "E_AI_TANY",
            title: "AI adoption over time",
            note: "Every chart in this view uses the same comparison, so it stays consistent as you scroll." });
        } },
      { id: "all-sectors", part: "Where it sits", nav: "Every sector ranked", h2: "Where the divide actually sits",
        deck: "Every sector the survey reports for this selection, at once. Not all eleven are published for every country — Energy and Water are missing in many. Sectors have no natural order, so this is a single-colour ranking rather than the graded ramp the age bands get.",
        render: (r) => breakdownRankCard(r, { chartId: "sector_adoption", indicator: "E_AI_TANY",
          title: "AI adoption by sector",
          note: "The sectors you selected are emphasised; the rest stay as context." }) },
      { id: "by-country", part: "Where it sits", nav: "By country", h2: "The same sector across Europe",
        deck: "How far your selected sector varies between countries.",
        render: (r) => rankingCard(r, { chartId: "sector_adoption", indicator: "E_AI_TANY",
          title: "AI adoption by country",
          note: "Your selection and the EU27 aggregate are emphasised; the rest stay as context." }) },
      { id: "purposes", part: "Where it sits", nav: "What AI is used for", h2: "What AI actually gets used for",
        deck: "The purposes firms report differ as sharply by industry as they do by size.",
        render: (r) => comparisonCard(r, "sector_purposes", {
          title: "What AI gets used for",
          note: "All shares are of the same group — every company in the sector — so the bars are directly comparable. A firm using AI for three purposes appears in three rows." }) },
      { id: "technologies", part: "Where it sits", nav: "Which technologies", h2: "Which technologies they actually run",
        deck: "Adoption headlines hide what is underneath: text mining and machine learning behave nothing like autonomous robots.",
        render: (r) => comparisonCard(r, "sector_tech", {
          title: "AI technologies in use",
          note: "Shares of every company in the sector. A firm running three technologies appears in three rows." }) },
      { id: "barriers", part: "Why they don't", nav: "Why firms stay out", h2: "Why firms stay out",
        deck: "Asked of the firms that considered AI and decided against it.",
        render: (r) => comparisonCard(r, "sector_barriers", {
          title: "Why enterprises do not adopt AI",
          note: "Shares of the companies that considered AI — not of all companies, which is the group every other chart here counts. Reasons are not exclusive." }) },
      { id: "skills", part: "What is missing underneath", nav: "ICT skills", h2: "The skills constraint",
        deck: "Whether the sector employs ICT specialists at all, and whether it trains its own people.",
        render: (r) => comparisonCard(r, "sector_skills", {
          title: "ICT skills inside the firm",
          note: "Shares of every company in the sector." }) },
      HOW_TO_READ,
    ],
  },

  individual: {
    headline: "The workforce Europe's SMEs hire from",
    standfirst: "Eurostat's household ICT survey — people, not companies. Pick as many age bands as you like and they combine into one group, so you can read \"everyone under 45\" or \"the cohort about to retire\" rather than one band at a time, then compare that group against other bands or against other countries.",
    unitKey: "individual_level",
    sections: [
      { id: "age-gap", part: "The scale", nav: "The age gap", h2: "The gap, in one number",
        deck: "Generative AI use in the last three months, for the age band you selected against whatever you are comparing it with.",
        render: (r) => {
          headlineTiles(r, { chartId: "workforce", indicator: "I_IUAI" });
          comparisonCard(r, "workforce", {
            title: "Generative AI and digital skills",
            note: "The same four measures, read for both sides of your comparison." });
        } },
      { id: "genai-country", part: "Where it sits", nav: "By country", h2: "Generative AI use across Europe",
        deck: "The first year Eurostat surveyed generative AI use among the general population, ranked for your selected age band.",
        render: (r) => rankingCard(r, { chartId: "workforce", indicator: "I_IUAI",
          title: "Generative AI use by country",
          note: "Share of people in the selected age band who used a generative AI tool in the last three months." }) },
      { id: "genai-age", part: "Where it sits", nav: "Across every age", h2: "Where the drop-off happens",
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
      { id: "occupation", part: "Who can do it", nav: "By occupation", h2: "It tracks the job, not the person",
        deck: "The single widest divide in this data. Whether someone uses AI depends less on their age than on what they do all day.",
        render: (r) => ordinalCard(r, { chartId: "workforce", indicator: "I_IUAI",
          options: ["ISCO_ICT", "ISCO0_5", "ISCO_ICTX", "ISCO6_9"],
          title: "Generative AI use by occupation", kindLabel: "Occupation",
          note: "Ordered from most to least digital work, so the ramp follows the ordering." }) },
      { id: "place", part: "Where it sits", nav: "City vs countryside", h2: "The divide is geographic too",
        deck: "Where someone lives shifts their likelihood of using AI almost as much as their education does.",
        render: (r) => ordinalCard(r, { chartId: "workforce", indicator: "I_IUAI",
          options: ["IND_DEG1", "IND_DEG2", "IND_DEG3"],
          title: "Generative AI use by where people live", kindLabel: "Area",
          note: "Cities, towns and suburbs, and rural areas — Eurostat's three degrees of urbanisation." }) },
      { id: "status", part: "Who can do it", nav: "By work status", h2: "Students are already there",
        deck: "The cohort entering the labour market has adopted these tools at rates the working population has not.",
        render: (r) => ordinalCard(r, { chartId: "workforce", indicator: "I_IUAI",
          options: ["STUD", "SAL_SELF_FAM", "UNE", "RETIR_OTHER"],
          title: "Generative AI use by labour-force status", kindLabel: "Status",
          note: "These groups do not overlap, but they are not a partition of the population either." }) },
      { id: "gender", part: "Who can do it", nav: "The gender gap", h2: "A gap that survives education",
        deck: "Eurostat publishes no plain male/female total — sex is only crossed with education. That turns out to be the more useful cut anyway: the gap persists at every level.",
        render: (r) => ordinalCard(r, { chartId: "workforce", indicator: "I_IUAI",
          options: ["M_I5_8", "F_I5_8", "M_I3_4", "F_I3_4", "M_I0_2", "F_I0_2"],
          title: "Generative AI use by sex within education level", kindLabel: "Group",
          note: "Read them in pairs: men and women at the same level of education." }) },
      { id: "skills-edu", part: "Who can do it", nav: "The talent pool", h2: "The talent pool",
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

/* --- multi-select picker ------------------------------------------------- */

/**
 * A multi-select the native <select> cannot be.
 *
 * Built for countries first - 34 of them, needing search and a badge a native
 * control cannot carry - and now shared with the size bands, which need the
 * same thing for a different reason: several bands combine into one group, and
 * a <select> can only hold one. The differences between the two are all
 * configuration: whether there is a search box, whether "select all" is on
 * offer (it is not for bands, where selecting every band would combine groups
 * that contain one another), and how a selection names itself.
 */
function optionPicker(host, {
  buttonId, options, selected, onToggle, onSelectAll, hint, summarize,
  labelOf, badgeOf, order = (list) => list, keepOrder = false, maxBadges = 3,
  searchable = true, searchPlaceholder = "Search…", allLabel,
}) {
  host.innerHTML = "";
  const button = el("button", {
    class: "dd-button", type: "button", id: buttonId,
    "aria-haspopup": "listbox", "aria-expanded": "false",
  });
  const badges = el("span", { class: "dd-badges" });
  const value = el("span", { class: "dd-value" });
  button.appendChild(badges);
  button.appendChild(value);
  button.appendChild(el("span", { class: "dd-caret", text: "▼" }));

  const panel = el("div", { class: "dd-panel", role: "listbox", hidden: "" });
  const search = el("input", {
    class: "dd-search", type: "search", placeholder: searchPlaceholder,
  });
  const list = el("div", { class: "dd-list" });
  const foot = el("p", { class: "dd-foot" });
  if (searchable) panel.appendChild(search);
  panel.appendChild(list);
  panel.appendChild(foot);
  host.appendChild(button);
  host.appendChild(panel);

  function paintButton() {
    const picked = order(selected());
    // Only so many badges fit the button; past that the count carries it, and
    // a wide badge ("50–249") runs out of room sooner than a country code.
    badges.innerHTML = "";
    picked.slice(0, maxBadges).forEach((code) => badges.appendChild(
      el("span", { class: "geo-badge", text: badgeOf(code) })));
    value.textContent = picked.length === 1 ? labelOf(picked[0]) : summarize(picked);
    foot.textContent = picked.length === 1
      ? hint
      : `${picked.length} selected · combined into one averaged series.`;
  }

  function paintList() {
    const q = searchable ? search.value.trim().toLowerCase() : "";
    const picked = selected();
    list.innerHTML = "";

    // "Select all" leads the list, but only when nothing is being searched -
    // offering it beside three filtered results would not mean what it says.
    if (!q && onSelectAll) {
      const every = options().every((c) => picked.includes(c));
      const all = el("button", {
        class: "dd-option dd-all", type: "button", role: "option",
        "aria-selected": String(every),
      });
      all.appendChild(el("span", { class: "geo-badge", text: "ALL" }));
      all.appendChild(el("span", { text: allLabel(options().length, every) }));
      if (every) all.appendChild(el("span", { class: "dd-check", text: "✓" }));
      all.addEventListener("click", () => {
        onSelectAll(every);
        paintButton();
        paintList();
      });
      list.appendChild(all);
    }

    const shown = options()
      .filter((code) => !q || labelOf(code).toLowerCase().includes(q)
        || badgeOf(code).toLowerCase().startsWith(q));
    // Selected options lead the list, so a shared link shows its selection
    // without the reader having to scroll for it - except where the options
    // carry their own order, as size bands do, and reshuffling them by what
    // happens to be selected would cost more than it saves.
    if (!keepOrder) {
      shown.sort((a, b) => (picked.includes(b) - picked.includes(a))
        || labelOf(a).localeCompare(labelOf(b)));
    }

    shown.forEach((code) => {
      const on = picked.includes(code);
      const opt = el("button", {
        class: "dd-option", type: "button", role: "option", "aria-selected": String(on),
      });
      opt.appendChild(el("span", { class: "geo-badge", text: badgeOf(code) }));
      opt.appendChild(el("span", { text: labelOf(code) }));
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
    if (!panel.hidden) {
      search.value = "";
      paintList();
      if (searchable) search.focus();
    }
  });
  panel.addEventListener("click", (e) => e.stopPropagation());
  search.addEventListener("input", paintList);
  document.addEventListener("click", close);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });

  paintButton();
  paintList();
  return {
    paint: () => { paintButton(); paintList(); },
    // The options actually on offer, which already exclude the other side's
    // picks - selecting "all" must never claim a country the other side holds.
    currentOptions: () => options(),
  };
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

  // A dimension that can hold several values at once gets the picker; one that
  // cannot keeps the native select, which is lighter and needs no explaining.
  // Both controls exist in the markup and take turns, so the label's `for`
  // has to follow whichever is showing.
  const primaryLabel = document.getElementById("lbl-primary");
  primaryLabel.textContent = d.multi ? `${d.control}s` : d.control;
  primaryLabel.setAttribute("for", d.multi ? "dd-primary-button" : "primary-select");
  document.getElementById("opt-mode-band").textContent = d.control;

  const primarySel = document.getElementById("primary-select");
  const primaryPick = document.getElementById("dd-primary");
  primarySel.hidden = d.multi;
  primaryPick.hidden = !d.multi;
  if (!d.multi) {
    primarySel.innerHTML = "";
    d.options.forEach((code) => primarySel.appendChild(
      el("option", { value: code, text: d.labelOf(code) })));
    primarySel.value = s.bands[0];
  }

  document.getElementById("compare-mode").value = s.compareMode;

  // The comparison is either the other bands or the other countries - whichever
  // dimension the reader chose to vary - and the band side takes the same
  // picker-or-select turn the primary control does.
  const cmpSel = document.getElementById("compare-select");
  const cmpBandPick = document.getElementById("dd-compare-band");
  const cmpGeoPick = document.getElementById("dd-compare");
  const byBand = s.compareMode === "band";
  cmpSel.hidden = !byBand || d.multi;
  cmpBandPick.hidden = !byBand || !d.multi;
  cmpGeoPick.hidden = byBand;
  document.getElementById("lbl-compare").setAttribute("for",
    byBand ? (d.multi ? "dd-compare-band-button" : "compare-select") : "dd-compare-button");
  if (byBand && !d.multi) {
    cmpSel.innerHTML = "";
    d.options.forEach((code) => cmpSel.appendChild(
      el("option", { value: code, text: d.labelOf(code) })));
    cmpSel.value = s.compareBands[0];
  }

  geoPicker?.paint();
  comparePicker?.paint();
  primaryPicker?.paint();
  compareBandPicker?.paint();

  const host = document.getElementById("sections");
  host.innerHTML = "";
  orderedSections(view.sections).forEach((spec) => {
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

/**
 * The nav is grouped by narrative part, not numbered flat.
 *
 * With nine sections a bare list reads as a menu; grouped under "The scale",
 * "Where it sits", "Why" and "What sits underneath" it reads as an argument,
 * and a reader can see the shape of it before scrolling.
 */
function buildNav() {
  const nav = document.getElementById("nav");
  nav.innerHTML = "";
  let lastPart = null;
  orderedSections(VIEWS[state.view].sections).forEach((spec) => {
    if (spec.part && spec.part !== lastPart) {
      nav.appendChild(el("li", { class: "nav-part", text: spec.part }));
      lastPart = spec.part;
    }
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
let primaryPicker = null;
let compareBandPicker = null;

const geoOptions = () => [...new Set(rows("ai_adoption").map((r) => r.geo))]
  .filter((g) => g !== REF_GEO)
  .sort((a, b) => label("geo", a).localeCompare(label("geo", b)));

/** Toggle a code in a list, refusing to empty it - a side with nothing selected
 *  would leave the chart with nothing to draw. `order` keeps the selection in
 *  the dimension's own order rather than the order it was clicked. */
function toggleIn(list, code, order) {
  const i = list.indexOf(code);
  if (i >= 0) {
    if (list.length === 1) return;
    list.splice(i, 1);
  } else {
    list.push(code);
    if (order) list.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  }
  commit();
}

/** Shared configuration for the two country pickers. */
const GEO_PICKER = {
  labelOf: (code) => label("geo", code),
  badgeOf: geoBadge,
  order: homeFirst,
  summarize: (picked) => `${picked.length} countries`,
  searchPlaceholder: "Search countries…",
  allLabel: (n, every) => (every ? `All ${n} countries` : "Select all countries"),
};

/**
 * Shared configuration for the two band pickers.
 *
 * No "select all": the bands are not a partition, so selecting every one of
 * them would build a group holding the same businesses several times over.
 * Whatever is selected on the other side is off the list for the same reason
 * countries are - a side cannot be compared against itself.
 */
const bandPicker = (host, which) => optionPicker(host, {
  buttonId: `dd-${which}-button`,
  options: () => {
    const s = sel();
    const taken = s.compareMode !== "band" ? []
      : (which === "primary" ? s.compareBands : s.bands);
    return dim().options.filter((c) => !taken.includes(c));
  },
  selected: () => (which === "primary" ? sel().bands : sel().compareBands),
  onToggle: (code) => toggleIn(
    which === "primary" ? sel().bands : sel().compareBands, code, dim().options),
  labelOf: (code) => dim().labelOf(code),
  badgeOf: (code) => dim().badgeOf(code),
  summarize: (picked) => `${picked.length} ${dim().noun}s`,
  hint: which === "primary"
    ? "Pick more to combine them into one group."
    : "Pick more to compare against their combined figure.",
  keepOrder: true,
  searchable: false,
  maxBadges: 2,
});

function buildControls() {
  geoPicker = optionPicker(document.getElementById("dd-geo"), {
    ...GEO_PICKER,
    buttonId: "dd-geo-button",
    // When the comparison is itself a set of countries, a country can only sit
    // on one side of it; offering it on both invites a group to be compared
    // against a group that partly contains it.
    options: () => geoOptions().filter((g) =>
      sel().compareMode !== "geo" || !sel().compareGeos.includes(g)),
    selected: () => state.geos,
    hint: "Pick more to see their combined average.",
    onToggle: (code) => toggleIn(state.geos, code),
    // Selecting everything then unselecting it has to land somewhere, and a
    // selection of none would leave the charts with nothing to draw; it falls
    // back to the home country rather than to an empty page.
    onSelectAll: (isAll) => {
      state.geos = isAll ? [HOME_GEO] : geoPicker.currentOptions();
      commit();
    },
  });

  comparePicker = optionPicker(document.getElementById("dd-compare"), {
    ...GEO_PICKER,
    buttonId: "dd-compare-button",
    options: () => geoOptions().filter((g) => !state.geos.includes(g)),
    selected: () => sel().compareGeos,
    hint: "Pick more to compare against their combined average.",
    onToggle: (code) => toggleIn(sel().compareGeos, code),
    onSelectAll: (isAll) => {
      const opts = comparePicker.currentOptions();
      // Unselecting all lands on the default comparison where it is still on
      // offer, rather than on whatever happens to sort first.
      sel().compareGeos = isAll ? [opts.includes("DE") ? "DE" : opts[0]] : opts;
      commit();
    },
  });

  primaryPicker = bandPicker(document.getElementById("dd-primary"), "primary");
  compareBandPicker = bandPicker(document.getElementById("dd-compare-band"), "compare-band");

  document.getElementById("primary-select").addEventListener("change", (e) => {
    sel().bands = [e.target.value]; commit();
  });
  document.getElementById("compare-mode").addEventListener("change", (e) => {
    sel().compareMode = e.target.value; commit();
  });
  document.getElementById("compare-select").addEventListener("change", (e) => {
    sel().compareBands = [e.target.value];
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

/**
 * Charts are drawn at the width they had when they were drawn, so a window that
 * changes width - a rotated phone, a dragged desktop window - has to redraw
 * them. Only when the width actually moved enough to matter: a mobile browser
 * fires resize every time its address bar slides away, and redrawing thirteen
 * charts on a scroll gesture is how a page starts to feel broken.
 */
function watchWidth() {
  const contentWidth = () =>
    document.getElementById("sections").getBoundingClientRect().width;
  let last = contentWidth();
  let timer = null;
  window.addEventListener("resize", () => {
    const now = contentWidth();
    const crossed = (last < NARROW_AT) !== (now < NARROW_AT);
    if (!crossed && Math.abs(now - last) < 48) return;
    last = now;
    clearTimeout(timer);
    timer = setTimeout(renderAll, 150);
  });
}

function syncUrl() {
  const s = sel();
  const params = new URLSearchParams();
  params.set("view", state.view);
  params.set("geo", state.geos.join(","));
  params.set("band", s.bands.join(","));
  params.set("by", s.compareMode);
  params.set("vs", s.compareMode === "band"
    ? s.compareBands.join(",") : s.compareGeos.join(","));
  history.replaceState(null, "", `?${params}`);
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  if (VIEWS[p.get("view")]) state.view = p.get("view");
  const s = sel(), d = DIMENSIONS[state.view], opts = d.options;
  const geos = (p.get("geo") || "").split(",")
    .filter((g) => LABELS.geo[g] && g !== REF_GEO);
  if (geos.length) state.geos = geos;
  // A link can name several bands; a dimension that is single-select keeps the
  // first of them rather than a selection its control could not display.
  const codes = (param) => {
    const list = (p.get(param) || "").split(",").filter((c) => opts.includes(c));
    return list.length ? (d.multi ? list : [list[0]]) : null;
  };
  const bands = codes("band");
  if (bands) s.bands = bands;
  if (p.get("by") === "band" || p.get("by") === "geo") s.compareMode = p.get("by");
  const vs = p.get("vs");
  if (s.compareMode === "band") {
    const compare = codes("vs");
    if (compare) s.compareBands = compare;
  }
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
  buildWeights();

  tooltip.className = "tooltip";
  document.body.appendChild(tooltip);

  readUrl();
  document.getElementById("app").hidden = false;
  document.getElementById("boot").remove();

  buildControls();
  renderAll();
  watchWidth();

  document.getElementById("generated").textContent =
    `Data generated ${META.generated_utc.slice(0, 10)} from Eurostat.`;
}

boot().catch((err) => {
  document.getElementById("boot").textContent = `Could not load the data bundle: ${err.message}`;
});
