"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";

type Mode = "primary" | "income";
type Listing = { source_id: string; address: string; city?: string; state?: string; zip_code?: string; property_type?: string; price?: number; bedrooms?: number; bathrooms?: number; square_feet?: number; days_on_market?: number; search_label: string };
type Search = { id: number; mode: Mode; label: string; city?: string; state?: string; zip_code?: string };
type Usage = { requests: number; limit: number; period: string };

export default function PropertiesPage() {
  const [mode, setMode] = useState<Mode>("primary");
  const [listings, setListings] = useState<Listing[]>([]);
  const [searches, setSearches] = useState<Search[]>([]);
  const [sourceConnected, setSourceConnected] = useState(false);
  const [usage, setUsage] = useState<Usage>({ requests: 0, limit: 50, period: "" });
  const [showSearch, setShowSearch] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [listingResponse, searchResponse] = await Promise.all([fetch(`/api/properties?mode=${mode}`), fetch("/api/property-searches")]);
    if (listingResponse.status === 401) return window.location.assign("/login");
    const listingData = await listingResponse.json() as { listings?: Listing[]; sourceConnected?: boolean; usage?: Usage; error?: string };
    const searchData = await searchResponse.json() as { searches?: Search[] };
    if (!listingResponse.ok) throw new Error(listingData.error || "Unable to load properties.");
    setListings(listingData.listings ?? []);
    setSourceConnected(Boolean(listingData.sourceConnected));
    if (listingData.usage) setUsage(listingData.usage);
    setSearches(searchData.searches ?? []);
  }, [mode]);

  useEffect(() => { load().catch((reason: Error) => setError(reason.message)); }, [load]);

  async function addSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/property-searches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
    const result = await response.json() as { error?: string };
    if (!response.ok) return setError(result.error || "Unable to save search.");
    event.currentTarget.reset();
    setShowSearch(false);
    await load();
  }

  const activeSearches = searches.filter((search) => search.mode === mode);

  return (
    <main className="properties-page">
      <header className="properties-header">
        <Link href="/portal">← Pauli HQ</Link>
        <button onClick={() => setShowSearch((value) => !value)}>+ Add region</button>
      </header>
      <section className="properties-hero">
        <p className="kicker">AI Property Finder</p>
        <h1>Find the right property.</h1>
        <p>Fresh opportunities, organized for living or investing and ready for AI analysis.</p>
      </section>
      <nav className="property-tabs" aria-label="Property type">
        <button className={mode === "primary" ? "active" : ""} onClick={() => setMode("primary")}>Primary residences</button>
        <button className={mode === "income" ? "active" : ""} onClick={() => setMode("income")}>Income properties</button>
      </nav>

      {showSearch && (
        <form className="property-search-form" onSubmit={addSearch}>
          <input type="hidden" name="mode" value={mode} />
          <input name="label" placeholder="Search name, e.g. North Coast" required />
          <input name="city" placeholder="City" />
          <input name="state" placeholder="State (CA)" maxLength={2} />
          <input name="zipCode" placeholder="ZIP code (optional)" />
          <input name="minPrice" type="number" min="0" placeholder="Minimum price" />
          <input name="maxPrice" type="number" min="0" placeholder="Maximum price" />
          <button type="submit">Save search</button>
        </form>
      )}

      <section className="property-toolbar">
        <div>{activeSearches.map((search) => <span key={search.id}>{search.label}</span>)}</div>
        <small>{sourceConnected ? `Listing feed connected · ${usage.requests} of ${usage.limit} monthly requests used` : "Listing feed needs connection"}</small>
      </section>
      {error && <p className="property-error" role="alert">{error}</p>}
      {listings.length ? (
        <section className="property-grid">
          {listings.map((listing) => (
            <article className="property-card" key={`${listing.source_id}-${listing.search_label}`}>
              <div className="property-card-top"><span>{listing.search_label}</span><small>{listing.days_on_market ?? "—"} days</small></div>
              <h2>{listing.address}</h2>
              <p>{[listing.city, listing.state, listing.zip_code].filter(Boolean).join(", ")}</p>
              <strong>{listing.price ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(listing.price) : "Price unavailable"}</strong>
              <dl><div><dt>Beds</dt><dd>{listing.bedrooms ?? "—"}</dd></div><div><dt>Baths</dt><dd>{listing.bathrooms ?? "—"}</dd></div><div><dt>Sq ft</dt><dd>{listing.square_feet?.toLocaleString() ?? "—"}</dd></div></dl>
              <button onClick={() => window.location.assign(`/assistant?prompt=${encodeURIComponent(`Analyze this ${mode} property: ${listing.address}, listed at ${listing.price ?? "unknown price"}.`)}`)}>Analyze with AI</button>
            </article>
          ))}
        </section>
      ) : (
        <section className="property-empty">
          <h2>No listings yet</h2>
          <p>Add a region now. Once the property-data connection is added, Pauli HQ will refresh matching listings twice each day.</p>
          <button onClick={() => setShowSearch(true)}>Add your first region</button>
        </section>
      )}
    </main>
  );
}
