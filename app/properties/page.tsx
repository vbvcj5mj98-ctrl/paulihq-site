"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import HqMenu from "../HqMenu";
import HqHomeLink from "../HqHomeLink";

type Mode = "primary" | "income";
type Sort = "roi" | "ai" | "lot" | "beds" | "baths" | "sqft" | "price_low" | "price_high";
type Listing = { source_id: string; search_id: number; address: string; city?: string; state?: string; zip_code?: string; property_type?: string; price?: number; bedrooms?: number; bathrooms?: number; square_feet?: number; lot_size?: number; days_on_market?: number; search_label: string; ai_score?: number; ai_summary?: string; estimated_monthly_income?: number; estimated_roi?: number; latitude?: number; longitude?: number; image_url?: string; source_page_url?: string; is_favorite?: number };
type Search = { id: number; owner: string; mode: Mode; label: string; city?: string; state?: string; zip_code?: string };
type Usage = { requests: number; limit: number; period: string };

function listingUrl(listing: Listing) {
  return listing.source_page_url || `https://www.google.com/search?q=${encodeURIComponent(`${listing.address} ${listing.city ?? ""} ${listing.state ?? ""} ${listing.zip_code ?? ""} real estate listing`)}`;
}

function PropertyVisual({ listing }: { listing: Listing }) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const destination = listingUrl(listing);
  if (listing.image_url && !photoFailed) {
    return <a className="property-photo" href={destination} target="_blank" rel="noreferrer" aria-label={`View listing for ${listing.address}`}><img src={`/api/property-image?sourceId=${encodeURIComponent(listing.source_id)}&searchId=${listing.search_id}`} alt={`Property at ${listing.address}`} loading="lazy" onError={(event) => { const image = event.currentTarget; if (image.dataset.direct !== "true") { image.dataset.direct = "true"; image.src = listing.image_url!; } else setPhotoFailed(true); }} /></a>;
  }
  const location = encodeURIComponent([listing.address, listing.city, listing.state, listing.zip_code].filter(Boolean).join(", "));
  return <div className="property-photo location-preview"><iframe title={`Location preview for ${listing.address}`} loading="lazy" tabIndex={-1} aria-hidden="true" src={`https://maps.google.com/maps?q=${location}&z=16&output=embed`} /><a href={destination} target="_blank" rel="noreferrer" aria-label={`View listing for ${listing.address}`}><span>{listing.image_url ? "Photo blocked · view listing" : "Finding photo · view listing"}</span></a></div>;
}

export default function PropertiesPage() {
  const [mode, setMode] = useState<Mode>("income");
  const [showStarred, setShowStarred] = useState(false);
  const [sort, setSort] = useState<Sort>("roi");
  const [listings, setListings] = useState<Listing[]>([]);
  const [searches, setSearches] = useState<Search[]>([]);
  const [sourceConnected, setSourceConnected] = useState(false);
  const [usage, setUsage] = useState<Usage>({ requests: 0, limit: 50, period: "" });
  const [showSearch, setShowSearch] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [querying, setQuerying] = useState(false);
  const attemptedPhotos = useRef(new Set<string>());
  const attemptedRankings = useRef(new Set<number>());
  const automaticPhotoCount = useRef(0);
  const [error, setError] = useState("");

  const load = useCallback(async (searchId?: number) => {
    const [listingResponse, searchResponse] = await Promise.all([fetch(`/api/properties?mode=${mode}&sort=${sort}${searchId ? `&searchId=${searchId}` : ""}${showStarred ? "&starred=1" : ""}`), fetch("/api/property-searches")]);
    if (listingResponse.status === 401) return window.location.assign("/login");
    const listingData = await listingResponse.json() as { listings?: Listing[]; sourceConnected?: boolean; usage?: Usage; error?: string };
    const searchData = await searchResponse.json() as { searches?: Search[] };
    if (!listingResponse.ok) throw new Error(listingData.error || "Unable to load properties.");
    setListings(listingData.listings ?? []);
    setSourceConnected(Boolean(listingData.sourceConnected));
    if (listingData.usage) setUsage(listingData.usage);
    setSearches(searchData.searches ?? []);
  }, [mode, showStarred, sort]);

  useEffect(() => { load().catch((reason: Error) => setError(reason.message)); }, [load]);

  useEffect(() => {
    if (automaticPhotoCount.current >= 12) return;
    const missing = listings.filter((listing) => !listing.image_url && !attemptedPhotos.current.has(`${listing.source_id}:${listing.search_id}`)).slice(0, Math.min(4, 12 - automaticPhotoCount.current));
    if (!missing.length) return;
    automaticPhotoCount.current += missing.length;
    for (const listing of missing) attemptedPhotos.current.add(`${listing.source_id}:${listing.search_id}`);
    Promise.allSettled(missing.map((listing) => fetch("/api/property-photo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: listing.source_id, searchId: listing.search_id }),
    }))).then(() => load().catch(() => undefined));
  }, [listings, load]);

  useEffect(() => {
    const searchIds = [...new Set(listings.filter((listing) => (mode === "income" ? !listing.estimated_monthly_income : !listing.ai_summary) && !attemptedRankings.current.has(listing.search_id)).map((listing) => listing.search_id))].slice(0, 3);
    if (!searchIds.length) return;
    for (const searchId of searchIds) attemptedRankings.current.add(searchId);
    Promise.allSettled(searchIds.map((searchId) => fetch("/api/properties/rank", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ searchId }) }))).then(() => load().catch(() => undefined));
  }, [listings, load, mode]);

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

  async function toggleFavorite(listing: Listing) {
    const favorite = !Boolean(listing.is_favorite);
    setListings((current) => showStarred && !favorite
      ? current.filter((item) => !(item.source_id === listing.source_id && item.search_id === listing.search_id))
      : current.map((item) => item.source_id === listing.source_id && item.search_id === listing.search_id ? { ...item, is_favorite: favorite ? 1 : 0 } : item));
    const response = await fetch("/api/property-favorites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceId: listing.source_id, searchId: listing.search_id, favorite }),
    });
    if (!response.ok) {
      setError("Unable to update the saved property.");
      await load();
    }
  }

  async function deleteSearch(search: Search) {
    if (!window.confirm(`Delete “${search.label}”? Its saved listings will also be removed and it will no longer receive weekly updates.`)) return;
    setError("");
    const response = await fetch("/api/property-searches", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: search.id }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) return setError(result.error || "Unable to delete the search.");
    setListings((current) => current.filter((listing) => listing.search_id !== search.id));
    setSearches((current) => current.filter((item) => item.id !== search.id));
    await load();
  }

  return (
    <main className="properties-page">
      <header className="properties-header">
        <HqHomeLink />
        <div className="properties-nav"><button onClick={() => setShowSearch((value) => !value)}>+ Add region</button><HqMenu current="/properties" /></div>
      </header>
      <section className="properties-hero">
        <p className="kicker">AI Property Finder</p>
        <h1>Find the right property.</h1>
        <p>Fresh opportunities, organized for living or investing and ready for AI analysis.</p>
      </section>
      <nav className="property-tabs" aria-label="Property type">
        <button className={mode === "income" ? "active" : ""} onClick={() => { setMode("income"); setSort("roi"); setShowStarred(false); }}>Income properties</button>
        <button className={mode === "primary" ? "active" : ""} onClick={() => { setMode("primary"); setSort("ai"); setShowStarred(false); }}>Primary residences</button>
      </nav>

      <nav className="property-folders" aria-label={`${mode} property folders`}>
        <button className={!showStarred ? "active" : ""} onClick={() => setShowStarred(false)}>All {mode === "income" ? "income" : "primary"}</button>
        <button className={showStarred ? "active" : ""} onClick={() => setShowStarred(true)}><span aria-hidden="true">★</span> Starred {mode === "income" ? "income" : "primary"}</button>
      </nav>
      <div className="property-sort"><label>Sort by<select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>{mode === "income" && <option value="roi">Best estimated ROI</option>}<option value="lot">Largest lot</option><option value="beds">Most beds</option><option value="baths">Most baths</option><option value="sqft">Most square feet</option><option value="price_low">Price: low to high</option><option value="price_high">Price: high to low</option>{mode === "primary" && <option value="ai">Best AI match</option>}</select></label>{mode === "income" && <small>Income and ROI are light AI screening estimates, not verified rent or net returns.</small>}</div>

      <form className="property-ai-search" onSubmit={async (event) => {
        event.preventDefault();
        const prompt = String(new FormData(event.currentTarget).get("prompt") ?? "").trim();
        if (!prompt) return;
        setQuerying(true); setError("");
        const response = await fetch("/api/properties/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, mode }) });
        const result = await response.json() as { searchId?: number; count?: number; error?: string };
        if (!response.ok || !result.searchId) setError(result.error || "Unable to search properties.");
        else { await load(result.searchId); if (!result.count) setError("The search completed, but no matching active listings were found. Try a wider area or fewer filters."); }
        setQuerying(false);
      }}>
        <input name="prompt" placeholder="Ask about a specific home, address, city, ZIP code, or area..." required />
        <button type="submit" disabled={querying}>{querying ? "Searching…" : "Find properties"}</button>
      </form>

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
        <div>{activeSearches.map((search) => <span className="property-query" key={search.id}>{search.label}{search.owner !== "shared" && <button onClick={() => deleteSearch(search)} aria-label={`Delete ${search.label}`} title="Delete this search and stop weekly updates">×</button>}</span>)}</div>
        <div className="property-feed-state"><small>{sourceConnected ? `Weekly feed connected · ${usage.requests} of ${usage.limit} monthly requests used` : "Listing feed needs connection"}</small>{sourceConnected && <button disabled={syncing} onClick={async () => { setSyncing(true); setError(""); const response = await fetch("/api/properties/sync", { method: "POST" }); const result = await response.json() as { error?: string }; if (!response.ok) setError(result.error || "Unable to start the scan."); window.setTimeout(() => { setSyncing(false); load().catch(() => undefined); }, 5000); }}>{syncing ? "Scanning…" : "Scan now"}</button>}</div>
      </section>
      {error && <p className="property-error" role="alert">{error}</p>}
      {listings.length ? (
        <section className="property-grid">
          {listings.map((listing) => (
            <article className="property-card" key={`${listing.source_id}-${listing.search_label}`}>
              <PropertyVisual listing={listing} />
              <div className="property-card-top"><span>{listing.search_label}</span><div><small>{listing.ai_score ? `AI ${listing.ai_score}/100` : `${listing.days_on_market ?? "—"} days`}</small><button className={`property-star${listing.is_favorite ? " active" : ""}`} onClick={() => toggleFavorite(listing)} aria-label={listing.is_favorite ? `Remove ${listing.address} from starred properties` : `Save ${listing.address} to starred properties`} title={listing.is_favorite ? "Remove from starred" : "Save to starred"}>{listing.is_favorite ? "★" : "☆"}</button></div></div>
              <h2><a className="property-address-link" href={listingUrl(listing)} target="_blank" rel="noreferrer">{listing.address}</a></h2>
              <p>{[listing.city, listing.state, listing.zip_code].filter(Boolean).join(", ")}</p>
              <strong>{listing.price ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(listing.price) : "Price unavailable"}</strong>
              <dl><div><dt>Beds</dt><dd>{listing.bedrooms ?? "—"}</dd></div><div><dt>Baths</dt><dd>{listing.bathrooms ?? "—"}</dd></div><div><dt>Sq ft</dt><dd>{listing.square_feet?.toLocaleString() ?? "—"}</dd></div><div><dt>Lot</dt><dd>{listing.lot_size ? listing.lot_size >= 43560 ? `${(listing.lot_size / 43560).toFixed(1)} ac` : `${listing.lot_size.toLocaleString()} sf` : "—"}</dd></div></dl>
              {mode === "income" && listing.estimated_monthly_income ? <div className="income-estimate"><div><small>Est. monthly income</small><strong>{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(listing.estimated_monthly_income)}</strong></div><div><small>Est. gross ROI</small><strong>{Number(listing.estimated_roi ?? 0).toFixed(1)}%</strong></div></div> : null}
              {listing.ai_summary && <div className={`property-ai-summary${mode === "primary" ? " primary" : ""}`}>{mode === "primary" && <small>AI overview</small>}<p>{listing.ai_summary}</p></div>}
              <a className="map-link" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([listing.address, listing.city, listing.state, listing.zip_code].filter(Boolean).join(", "))}`} target="_blank" rel="noreferrer">View map ↗</a>
              <a className="listing-link" href={listingUrl(listing)} target="_blank" rel="noreferrer">View listing ↗</a>
              <button onClick={() => window.dispatchEvent(new CustomEvent("open-pauli-assistant", { detail: { prompt: `Analyze this ${mode} property: ${listing.address}, listed at ${listing.price ?? "unknown price"}.` } }))}>Analyze with AI</button>
            </article>
          ))}
        </section>
      ) : (
        <section className="property-empty">
          <h2>{showStarred ? `No starred ${mode} properties yet` : "No listings yet"}</h2>
          <p>{showStarred ? "Select the star on any property to save it in this folder." : "Add a region now. Once the property-data connection is added, Pauli HQ will refresh matching listings twice each day."}</p>
          {!showStarred && <button onClick={() => setShowSearch(true)}>Add your first region</button>}
        </section>
      )}
    </main>
  );
}
