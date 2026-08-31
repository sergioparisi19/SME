# SME Digital & AI Readiness Index

**Status:** Draft — v0.1
**Scope:** Milan / EU-27

A lightweight, static web portal that turns EU-level statistics on SME digital and AI adoption into a clear, visual, shareable reference — built to be screenshotted, linked, and posted, not just browsed.

---

## Why

SMEs make up the overwhelming majority of Europe's businesses, yet they are consistently the last to benefit from digital and AI adoption. Large enterprises have the budget, talent, and internal data teams to adopt AI early — SMEs typically don't, and the resulting gap compounds into a widening competitiveness and productivity divide across the European economy.

This gap is well documented at policy level (Eurostat, European Commission DESI reports) but rarely translated into something an SME owner can read and act on in five minutes. This project exists to close that translation gap.

**Key figures** *(placeholders pending source confirmation)*:
- ~99% of EU businesses are SMEs — the backbone of the real economy *(confirm vs. Eurostat)*
- A measurable gap in AI adoption rate vs. large enterprises, by sector *(pending DESI figures)*
- A share of manual, repetitive workload estimated as automatable today *(to be sourced)*

## What

An HTML portal that turns EU-level statistics into a visual, shareable reference on SME digital and AI adoption: a self-contained web page — no login, no install — presenting a curated set of KPIs (adoption rates, digital tool penetration, workforce skills gap, estimated productivity impact) broken down by country and sector.

The first version is a static insight page. It is deliberately **not a product yet** — it's a content and credibility layer that precedes any commercial offer.

- **5–8** core KPIs tracked across countries and sectors
- **1 page**, static, fast-loading, link-shareable on LinkedIn
- **EU-27** initial geographic scope, sourced from public EU datasets

## How

- **Sourcing:** Eurostat, European Commission DESI reports, and OECD AI adoption surveys form the primary data backbone — cross-checked rather than taken at face value.
- **Design:** a single static HTML page with embedded charts, built for clarity first, and built to be posted as an image or linked directly on LinkedIn.
- **Cadence:** refreshed on a recurring schedule (e.g. monthly), each update paired with a short-form LinkedIn post pointing back to the portal — building an audience gradually rather than all at once.

| | |
|---|---|
| **3** | primary data sources: Eurostat, DESI, OECD |
| **Static** | HTML build — no backend, hosted on GitHub Pages or similar |
| **Monthly** | refresh cadence, paired with a LinkedIn post |

---

## Business Value

| | | |
|---|---|---|
| **Positioning** | Thought leadership | Establishes credibility on digitalization and AI adoption for SMEs — relevant to a move toward Lead Data Scientist / Advanced Analytics Manager roles, visible where hiring managers and peers look. |
| **Market** | Education | Most SMEs lack in-house data science expertise. The portal gives them a plain-language benchmark: where they stand versus peers, and where the largest opportunity gaps sit. |
| **Pipeline** | Lead generation | A genuinely useful, well-designed insight page creates its own inbound — companies who see themselves in the data start asking "what do we do about this?" |
| **Risk** | Low-cost validation | Shipping this first as content, not a paid tool, validates the angle and the audience before any investment goes into a productized solution. |

---

## Roadmap

1. **Data foundation** — Consolidate reliable EU-level sources
   Identify and validate sources (Eurostat DESI, EC SME reports, OECD AI adoption surveys) and define 5–8 core KPIs.

2. **Insight design** — Define the narrative angle
   Choose the story the data tells (e.g. "the AI adoption gap between large enterprises and SMEs is costing SMEs measurable productivity") and select visual formats: country comparisons, sector breakdowns, trend lines.

3. **Portal build (v1)** — Ship the static HTML page
   A single-page portal with embedded charts, editorial layout, and no backend dependency — hosted simply (GitHub Pages or similar).

4. **Content cadence** — Establish a publishing rhythm
   A recurring cycle (e.g. a monthly insight card) posted on LinkedIn, each pointing back to the live portal.

5. **Feedback loop** — Track what resonates
   Monitor LinkedIn engagement and portal traffic to see which KPIs and framings land with SME audiences, and refine accordingly.
