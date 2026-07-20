"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import HqHomeLink from "../HqHomeLink";
import HqMenu from "../HqMenu";

type ResearchResult = {
  summary?: string;
  identity?: Record<string, unknown>;
  ownership?: Record<string, unknown>;
  property?: Record<string, unknown>;
  financial?: Record<string, unknown>;
  listing?: Record<string, unknown>;
  legal?: Record<string, unknown>;
  missing_fields?: string[];
  sources?: Array<{ title?: string; url?: string; supports?: string[] }>;
  researched_at?: string;
};

type Research = { id: number; query_type: "address" | "apn"; query_text: string; county: string; state: string; starred: number | boolean; refreshed_at: number; result: ResearchResult };
type Usage = { requests: number; limit: number; period: string };

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

function present(value: unknown) { return value !== null && value !== undefined && value !== ""; }
function display(value: unknown, kind?: "money" | "number" | "yesno") {
  if (!present(value)) return "Not found";
  if (kind === "money" && Number.isFinite(Number(value))) return money.format(Number(value));
  if (kind === "number" && Number.isFinite(Number(value))) return number.format(Number(value));
  if (kind === "yesno" && typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function DetailGrid({ values }: { values: Array<[string, unknown, ("money" | "number" | "yesno")?]> }) {
  return <dl className="scout-details">{values.map(([label, value, kind]) => <div className={present(value) ? "" : "missing"} key={label}><dt>{label}</dt><dd>{display(value, kind)}</dd></div>)}</dl>;
}

export default function ParcelScoutPage() {
  const [queryType, setQueryType] = useState<"address" | "apn">("address");
  const [queryText, setQueryText] = useState("");
  const [county, setCounty] = useState("");
  const [state, setState] = useState("");
  const [researches, setResearches] = useState<Research[]>([]);
  const [current, setCurrent] = useState<Research | null>(null);
  const [usage, setUsage] = useState<Usage>({ requests: 0, limit: 20, period: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const loadHistory = useCallback(async () => {
    const response = await fetch("/api/property-research");
    if (response.status === 401) return window.location.assign("/login");
    const data = await response.json() as { researches?: Research[]; usage?: Usage; error?: string };
    if (!response.ok) throw new Error(data.error || "Unable to load Parcel Scout.");
    setResearches(data.researches ?? []); if (data.usage) setUsage(data.usage);
  }, []);

  useEffect(() => { loadHistory().catch((reason: Error) => setError(reason.message)); }, [loadHistory]);

  async function investigate(event?: FormEvent<HTMLFormElement>, force = false) {
    event?.preventDefault(); setBusy(true); setError("");
    const response = await fetch("/api/property-research", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ queryType, queryText, county, state, force }) });
    const data = await response.json() as { id?: number; result?: ResearchResult; starred?: boolean; cached?: boolean; refreshedAt?: number; error?: string };
    if (!response.ok || !data.result || !data.id) setError(data.error || "Parcel Scout could not complete that investigation.");
    else {
      const record: Research = { id: data.id, query_type: queryType, query_text: queryText, county, state, starred: Boolean(data.starred), refreshed_at: data.refreshedAt ?? Date.now(), result: data.result };
      setCurrent(record); await loadHistory();
    }
    setBusy(false);
  }

  function openResearch(research: Research) {
    setCurrent(research); setQueryType(research.query_type); setQueryText(research.query_text); setCounty(research.county); setState(research.state); setError(""); window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function toggleStar() {
    if (!current) return;
    const starred = !Boolean(current.starred);
    const response = await fetch("/api/property-research", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: current.id, starred }) });
    if (!response.ok) return setError("Unable to update the star.");
    setCurrent({ ...current, starred }); await loadHistory();
  }

  async function remove(research: Research) {
    const response = await fetch("/api/property-research", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: research.id }) });
    if (!response.ok) return setError("Unable to remove that lookup.");
    if (current?.id === research.id) setCurrent(null);
    await loadHistory();
  }

  const result = current?.result;
  const identity = result?.identity ?? {};
  const ownership = result?.ownership ?? {};
  const property = result?.property ?? {};
  const financial = result?.financial ?? {};
  const listing = result?.listing ?? {};
  const legal = result?.legal ?? {};

  return <main className="properties-page scout-page">
    <header className="properties-header"><HqHomeLink /><HqMenu current="/parcel-scout" /></header>
    <section className="scout-shell">
      <div className="scout-heading"><p className="kicker">Public-record property research</p><h1>Parcel Scout</h1><p>Enter an address or APN. Parcel Scout checks public assessor records, tax and GIS pages, listing sources, and available structured property data.</p></div>
      <form className="scout-form" onSubmit={(event) => investigate(event)}>
        <div className="scout-type" role="group" aria-label="Lookup type"><button type="button" className={queryType === "address" ? "active" : ""} onClick={() => setQueryType("address")}>Address</button><button type="button" className={queryType === "apn" ? "active" : ""} onClick={() => setQueryType("apn")}>APN</button></div>
        <label className="scout-query">{queryType === "apn" ? "Assessor parcel number" : "Property address"}<input value={queryText} onChange={(event) => setQueryText(event.target.value)} placeholder={queryType === "apn" ? "Enter the complete APN" : "Enter a complete street address"} required /></label>
        {queryType === "apn" && <><label>County<input value={county} onChange={(event) => setCounty(event.target.value)} placeholder="Benton" required /></label><label>State<input value={state} onChange={(event) => setState(event.target.value.toUpperCase())} placeholder="AR" maxLength={2} required /></label></>}
        <button className="scout-submit" type="submit" disabled={busy}>{busy ? "Investigating…" : "Scout property"}</button>
        <small>New investigations start unstarred. Unstarred reports are cached for 90 days; starred reports stay saved until you unstar them. {usage.requests} of {usage.limit} new investigations used this month.</small>
      </form>
      {error && <p className="property-error" role="alert">{error}</p>}

      {current && result && <article className="scout-report">
        <header className="scout-report-header"><div><small>{current.query_type === "apn" ? `APN ${current.query_text}` : "Property report"}</small><h2>{String(identity.address || current.query_text)}</h2><p>{result.summary || "Source-backed property details found during this investigation."}</p></div><div className="scout-report-actions"><button className={current.starred ? "starred" : ""} onClick={toggleStar} aria-pressed={Boolean(current.starred)}>{current.starred ? "★ Starred" : "☆ Star"}</button><button onClick={() => investigate(undefined, true)} disabled={busy}>Refresh research</button></div></header>
        <div className="scout-report-grid">
          <section><h3>Parcel identity</h3><DetailGrid values={[["Address", identity.address], ["APN", identity.apn], ["County", identity.county], ["State", identity.state]]} /></section>
          <section><h3>Property</h3><DetailGrid values={[["Type", property.property_type], ["Lot size", property.lot_size_acres, "number"], ["Lot square feet", property.lot_size_sqft, "number"], ["Bedrooms", property.beds, "number"], ["Bathrooms", property.baths, "number"], ["Interior square feet", property.square_feet, "number"], ["Year built", property.year_built, "number"], ["Garage spaces", property.garage_spaces, "number"], ["Garage square feet", property.garage_sqft, "number"]]} /></section>
          <section><h3>Owner</h3><DetailGrid values={[["Current owner", ownership.owner_name], ["Owner type", ownership.owner_type], ["Public business phone", ownership.public_business_phone], ["Public business email", ownership.public_business_email], ["Business website", ownership.public_business_website]]} /></section>
          <section><h3>Value, tax & sale</h3><DetailGrid values={[["Estimated value", financial.estimated_value, "money"], ["Assessed value", financial.assessed_value, "money"], ["Land value", financial.land_value, "money"], ["Improvement value", financial.improvement_value, "money"], ["Assessment year", financial.assessment_year, "number"], ["Annual property tax", financial.annual_tax, "money"], ["Tax year", financial.tax_year, "number"], ["Last sale price", financial.last_sale_price, "money"], ["Last sale date", financial.last_sale_date]]} /></section>
          <section><h3>Current listing</h3><DetailGrid values={[["For sale", listing.for_sale, "yesno"], ["Status", listing.status], ["Listing price", listing.price, "money"], ["Agent", listing.agent_name], ["Brokerage", listing.brokerage], ["Agent phone", listing.professional_phone], ["Agent email", listing.professional_email]]} />{present(listing.listing_url) && <a className="scout-source-link" href={String(listing.listing_url)} target="_blank" rel="noreferrer">Open current listing ↗</a>}</section>
          <section><h3>Legal & land use</h3><DetailGrid values={[["Zoning", legal.zoning], ["Subdivision", legal.subdivision], ["Legal description", legal.legal_description]]} /></section>
        </div>
        {(result.missing_fields?.length ?? 0) > 0 && <section className="scout-missing"><h3>Not verified</h3><p>{result.missing_fields!.join(" · ")}</p></section>}
        <section className="scout-sources"><h3>Sources checked</h3>{result.sources?.length ? result.sources.map((source, index) => <a href={source.url} target="_blank" rel="noreferrer" key={`${source.url}-${index}`}><span><strong>{source.title || "Public source"}</strong>{source.supports?.length ? <small>{source.supports.join(" · ")}</small> : null}</span><b>↗</b></a>) : <p>No direct source links were returned. Treat the report as unverified.</p>}</section>
      </article>}

      <section className="scout-history"><div><p className="kicker">Saved locally in Pauli HQ</p><h2>Recent lookups</h2></div>{researches.length ? <div className="scout-history-list">{researches.map((research) => <article key={research.id}><button className="scout-history-open" onClick={() => openResearch(research)}><span>{Boolean(research.starred) ? "★" : "☆"}</span><div><strong>{String(research.result.identity?.address || research.query_text)}</strong><small>{research.query_type === "apn" ? `APN ${research.query_text} · ${research.county}, ${research.state}` : "Address lookup"}</small></div></button><button className="scout-delete" onClick={() => remove(research)} aria-label={`Remove lookup for ${research.query_text}`}>Remove</button></article>)}</div> : <p className="scout-history-empty">No property investigations yet.</p>}</section>
    </section>
  </main>;
}
