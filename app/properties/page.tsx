"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import HqMenu from "../HqMenu";
import HqHomeLink from "../HqHomeLink";

type Mode = "primary" | "income";
type Sort = "roi" | "ai" | "lot" | "beds" | "baths" | "sqft" | "price_low" | "price_high";
type Listing = { source_id: string; search_id: number; address: string; city?: string; state?: string; zip_code?: string; property_type?: string; price?: number; bedrooms?: number; bathrooms?: number; square_feet?: number; lot_size?: number; days_on_market?: number; search_label: string; ai_score?: number; ai_summary?: string; estimated_monthly_income?: number; estimated_roi?: number; image_url?: string; source_page_url?: string; is_favorite?: number; availability?: "active" | "not_in_latest" | "stale" };
type Search = { id: number; owner: string; mode: Mode; label: string; city?: string; state?: string; zip_code?: string; last_synced_at?: number | null; next_refresh_at?: number | null; refresh_status?: string };
type Usage = { requests: number; limit: number; period: string };
const defaultIncomeSearchId = -100;
type SearchFilters = { city?: string; state?: string; zipCode?: string; address?: string; minPrice?: number; maxPrice?: number; minLotSquareFeet?: number; maxLotSquareFeet?: number; minBedrooms?: number; maxBedrooms?: number };

function filterSummary(filters?: SearchFilters) {
  if (!filters) return "";
  const money = (amount: number) => `$${amount.toLocaleString("en-US")}`;
  const acres = (amount: number) => `${(amount / 43560).toLocaleString("en-US", { maximumFractionDigits: 2 })} acres`;
  const place = filters.address || [filters.city, filters.state, filters.zipCode].filter(Boolean).join(", ");
  return [place, filters.minPrice !== undefined && `at least ${money(filters.minPrice)}`, filters.maxPrice !== undefined && `up to ${money(filters.maxPrice)}`, filters.minLotSquareFeet !== undefined && `at least ${acres(filters.minLotSquareFeet)}`, filters.maxLotSquareFeet !== undefined && `up to ${acres(filters.maxLotSquareFeet)}`, filters.minBedrooms !== undefined && `${filters.minBedrooms}+ beds`, filters.maxBedrooms !== undefined && `up to ${filters.maxBedrooms} beds`].filter(Boolean).join(" · ");
}

function listingUrl(listing: Listing) {
  return listing.source_page_url || `https://www.google.com/search?q=${encodeURIComponent(`${listing.address} ${listing.city ?? ""} ${listing.state ?? ""} ${listing.zip_code ?? ""} real estate listing`)}`;
}

function PropertyVisual({ listing }: { listing: Listing }) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const destination = listingUrl(listing);
  if (listing.image_url && !photoFailed) {
    return <a className="property-photo" href={destination} target="_blank" rel="noreferrer" aria-label={`View listing for ${listing.address}`}><img src={`/api/property-image?sourceId=${encodeURIComponent(listing.source_id)}&searchId=${listing.search_id}`} alt={`Property at ${listing.address}`} loading="lazy" onError={(event) => { const image = event.currentTarget; if (image.dataset.direct !== "true") { image.dataset.direct = "true"; image.src = listing.image_url!; } else setPhotoFailed(true); }} /></a>;
  }
  return <a className="property-photo location-preview" href={destination} target="_blank" rel="noreferrer" aria-label={`View listing for ${listing.address}`}><span>Photo unavailable · View listing</span></a>;
}

export default function PropertiesPage() {
  const [mode, setMode] = useState<Mode>("income");
  const [showStarred, setShowStarred] = useState(false);
  const [sort, setSort] = useState<Sort>("roi");
  const [listings, setListings] = useState<Listing[]>([]);
  const [searches, setSearches] = useState<Search[]>([]);
  const [sourceConnected, setSourceConnected] = useState(false);
  const [canRefresh, setCanRefresh] = useState(false);
  const [usage, setUsage] = useState<Usage>({ requests: 0, limit: 50, period: "" });
  const [showSearch, setShowSearch] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [querying, setQuerying] = useState(false);
  const [selectedSearchId, setSelectedSearchId] = useState<number | undefined>(defaultIncomeSearchId);
  const [visibleCount, setVisibleCount] = useState(12);
  const [loading, setLoading] = useState(true);
  const [loadingPhoto, setLoadingPhoto] = useState("");
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const loadSequence = useRef(0);
  const currentView = `${mode}:${sort}:${selectedSearchId ?? "all"}:${showStarred}`;
  const activeView = useRef(currentView);
  useEffect(() => { activeView.current = currentView; }, [currentView]);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (activeView.current !== currentView) return;
    const sequence = ++loadSequence.current;
    const [listingResponse, searchResponse] = await Promise.all([fetch(`/api/properties?mode=${mode}&sort=${sort}${selectedSearchId === undefined ? "" : `&searchId=${selectedSearchId}`}${showStarred ? "&starred=1" : ""}`, { signal, cache: "no-store" }), fetch("/api/property-searches", { signal, cache: "no-store" })]);
    if (listingResponse.status === 401 || searchResponse.status === 401) return window.location.assign("/login");
    const listingData = await listingResponse.json() as { listings?: Listing[]; sourceConnected?: boolean; canRefresh?: boolean; usage?: Usage; error?: string };
    const searchData = await searchResponse.json() as { searches?: Search[]; error?: string };
    if (sequence !== loadSequence.current || activeView.current !== currentView || signal?.aborted) return;
    if (!listingResponse.ok) throw new Error(listingData.error || "Unable to load properties.");
    if (!searchResponse.ok) throw new Error(searchData.error || "Unable to load saved searches.");
    setListings(listingData.listings ?? []);
    setSourceConnected(Boolean(listingData.sourceConnected));
    setCanRefresh(Boolean(listingData.canRefresh));
    if (listingData.usage) setUsage(listingData.usage);
    setSearches(searchData.searches ?? []);
  }, [mode, showStarred, sort, selectedSearchId, currentView]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setVisibleCount(12);
    load(controller.signal).catch((reason: Error) => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load]);

  async function findPhoto(listing: Listing) {
    setLoadingPhoto(`${listing.source_id}:${listing.search_id}`); setError("");
    try {
      const response = await fetch("/api/property-photo", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceId: listing.source_id, searchId: listing.search_id }) });
      const result = await response.json() as { error?: string; image_url?: string };
      if (!response.ok) throw new Error(result.error ?? "Couldn’t look up a photo.");
      if (!result.image_url) setNotice("No usable photo was found. You can still open the listing.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn’t look up a photo."); }
    finally { setLoadingPhoto(""); }
  }

  async function refreshSearch(search: Search) {
    if (syncing) return;
    setSyncing(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/properties/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ searchId: search.id }) });
      if (response.status === 401) { window.location.assign("/login"); return; }
      const result = await response.json() as { status?: string; count?: number; error?: string };
      if (!response.ok || result.status !== "updated") throw new Error(result.error ?? "Couldn’t refresh this search.");
      setNotice(`Search refreshed. ${result.count ?? 0} matching active listings.`);
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Couldn’t refresh this search."); }
    finally { setSyncing(false); }
  }

  async function addSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError("");
    try {
      const response = await fetch("/api/property-searches", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
      const result = await response.json() as { error?: string; searchId?: number };
      if (!response.ok) throw new Error(result.error || "Unable to save search.");
      setShowSearch(false);
      if (typeof result.searchId === "number") { setShowStarred(false); setSelectedSearchId(result.searchId); }
      else await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save search."); }
  }

  const activeSearches = searches.filter((search) => search.mode === mode);
  const chosenSearch = activeSearches.find((search) => search.id === selectedSearchId);

  async function toggleFavorite(listing: Listing) {
    const favorite = !Boolean(listing.is_favorite);
    setListings((current) => showStarred && !favorite
      ? current.filter((item) => !(item.source_id === listing.source_id && item.search_id === listing.search_id))
      : current.map((item) => item.source_id === listing.source_id && item.search_id === listing.search_id ? { ...item, is_favorite: favorite ? 1 : 0 } : item));
    try {
      const response = await fetch("/api/property-favorites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId: listing.source_id, searchId: listing.search_id, favorite }),
      });
      if (!response.ok) throw new Error();
    } catch {
      setError("Unable to update the saved property.");
      await load().catch(() => undefined);
    }
  }

  async function deleteSearch(search: Search) {
    if (!window.confirm(`Delete “${search.label}”? Its saved listings will also be removed and it will no longer receive weekly updates.`)) return;
    setError("");
    try {
      const response = await fetch("/api/property-searches", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: search.id }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Unable to delete the search.");
      setListings((current) => current.filter((listing) => listing.search_id !== search.id));
      setSearches((current) => current.filter((item) => item.id !== search.id));
      if (search.id === selectedSearchId) setSelectedSearchId(undefined);
      else await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to delete the search."); }
  }

  return (
    <main className="properties-page">
      <header className="properties-header">
        <HqHomeLink />
        <div className="properties-nav"><button onClick={() => setShowSearch((value) => !value)}>+ Add region</button><HqMenu current="/properties" /></div>
      </header>
      <section className="properties-hero">
        <h1>Property Finder</h1>
      </section>
      <nav className="property-tabs" aria-label="Property type">
        <button className={mode === "income" ? "active" : ""} disabled={querying || syncing} onClick={() => { if (mode !== "income") setSelectedSearchId(defaultIncomeSearchId); setMode("income"); setSort("roi"); setShowStarred(false); setError(""); setNotice(""); }}>Income properties</button>
        <button className={mode === "primary" ? "active" : ""} disabled={querying || syncing} onClick={() => { if (mode !== "primary") setSelectedSearchId(undefined); setMode("primary"); setSort("ai"); setShowStarred(false); setError(""); setNotice(""); }}>Primary residences</button>
      </nav>

      <nav className="property-folders" aria-label={`${mode} property folders`}>
        <button className={!showStarred ? "active" : ""} onClick={() => setShowStarred(false)}>All {mode === "income" ? "income" : "primary"}</button>
        <button className={showStarred ? "active" : ""} onClick={() => { setShowStarred(true); setSelectedSearchId(undefined); }}><span aria-hidden="true">★</span> Starred {mode === "income" ? "income" : "primary"}</button>
      </nav>
      <div className="property-sort"><label>Sort by<select value={sort} onChange={(event) => setSort(event.target.value as Sort)}>{mode === "income" && <option value="roi">Best estimated ROI</option>}<option value="lot">Largest lot</option><option value="beds">Most beds</option><option value="baths">Most baths</option><option value="sqft">Most square feet</option><option value="price_low">Price: low to high</option><option value="price_high">Price: high to low</option>{mode === "primary" && <option value="ai">Best AI match</option>}</select></label>{mode === "income" && <small>Income and ROI are light AI screening estimates, not verified rent or net returns.</small>}</div>

      <form className="property-ai-search" onSubmit={async (event) => {
        event.preventDefault();
        const prompt = String(new FormData(event.currentTarget).get("prompt") ?? "").trim();
        if (!prompt || querying || syncing) return;
        setQuerying(true); setError(""); setNotice("");
        try {
          const response = await fetch("/api/properties/query", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt, mode }) });
          const result = await response.json() as { searchId?: number; count?: number; filters?: SearchFilters; error?: string };
          if (!response.ok || typeof result.searchId !== "number") throw new Error(result.error || "Unable to search properties.");
          setShowStarred(false); setSelectedSearchId(result.searchId);
          const summary = filterSummary(result.filters);
          setNotice(`${result.count ? `${result.count} active listing${result.count === 1 ? "" : "s"} matched.` : "No active listings matched all the limits."}${summary ? ` Filters: ${summary}` : ""}`);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to search properties."); }
        finally { setQuerying(false); }
      }}>
        <input name="prompt" aria-label="Property search" placeholder="Enter a location and limits, such as acreage, beds, or price limits" required />
        <button type="submit" disabled={querying || syncing}>{querying ? "Searching…" : "Find properties"}</button>
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
        <div className="property-search-controls">
          <label>Saved search <select value={selectedSearchId ?? ""} disabled={querying || syncing} onChange={(event) => { setSelectedSearchId(event.target.value ? Number(event.target.value) : undefined); setError(""); setNotice(""); }}>
            <option value="">All searches</option>{activeSearches.map((search) => <option key={search.id} value={search.id}>{search.label}</option>)}
          </select></label>
          {chosenSearch && chosenSearch.owner !== "shared" && <button onClick={() => void deleteSearch(chosenSearch)} disabled={syncing || querying}>Delete search</button>}
        </div>
        <div className="property-feed-state">
          <small>{sourceConnected ? `${usage.requests} of ${usage.limit} monthly requests used` : "Listing feed not connected"}</small>
          {chosenSearch && <small>{chosenSearch.last_synced_at ? `Last checked ${new Date(chosenSearch.last_synced_at).toLocaleString()}` : "Not checked yet"}{chosenSearch.next_refresh_at ? ` · Next due ${new Date(chosenSearch.next_refresh_at).toLocaleDateString()}` : ""}{chosenSearch.refresh_status === "failed" ? " · Last check failed" : chosenSearch.refresh_status === "quota_reached" ? " · Monthly limit reached" : chosenSearch.refresh_status === "snapshot" ? " · One-time search" : ""}</small>}
          {sourceConnected && canRefresh && chosenSearch && chosenSearch.refresh_status !== "snapshot" && <button disabled={syncing || querying || usage.requests >= usage.limit} onClick={() => void refreshSearch(chosenSearch)}>{syncing ? "Checking listings…" : "Refresh this search"}</button>}
        </div>
      </section>
      {error && <p className="property-error" role="alert">{error}</p>}
      {notice && <p className="property-notice" role="status">{notice}</p>}
      {loading ? <p className="property-empty" role="status">Loading listings…</p> : listings.length ? (
        <section className="property-grid">
          {listings.slice(0, visibleCount).map((listing) => (
            <article className="property-card" key={`${listing.source_id}-${listing.search_id}`}>
              <PropertyVisual listing={listing} />
              <div className="property-card-top"><span>{listing.search_label}</span><div><small>{listing.ai_score ? `AI ${listing.ai_score}/100` : `${listing.days_on_market ?? "—"} days`}</small><button className={`property-star${listing.is_favorite ? " active" : ""}`} onClick={() => toggleFavorite(listing)} aria-label={listing.is_favorite ? `Remove ${listing.address} from starred properties` : `Save ${listing.address} to starred properties`} title={listing.is_favorite ? "Remove from starred" : "Save to starred"}>{listing.is_favorite ? "★" : "☆"}</button></div></div>
              {listing.availability && listing.availability !== "active" && <p className="property-availability">{listing.availability === "stale" ? "Saved copy · Not recently verified" : "Saved copy · Not in the latest active feed"}</p>}
              <h2><a className="property-address-link" href={listingUrl(listing)} target="_blank" rel="noreferrer">{listing.address}</a></h2>
              <p>{[listing.city, listing.state, listing.zip_code].filter(Boolean).join(", ")}</p>
              <strong>{listing.price ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(listing.price) : "Price unavailable"}</strong>
              <dl><div><dt>Beds</dt><dd>{listing.bedrooms ?? "—"}</dd></div><div><dt>Baths</dt><dd>{listing.bathrooms ?? "—"}</dd></div><div><dt>Sq ft</dt><dd>{listing.square_feet?.toLocaleString() ?? "—"}</dd></div><div><dt>Lot</dt><dd>{listing.lot_size ? listing.lot_size >= 43560 ? `${(listing.lot_size / 43560).toFixed(1)} ac` : `${listing.lot_size.toLocaleString()} sf` : "—"}</dd></div></dl>
              {mode === "income" && listing.estimated_monthly_income ? <div className="income-estimate"><div><small>Est. monthly income</small><strong>{new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(listing.estimated_monthly_income)}</strong></div><div><small>Est. gross ROI</small><strong>{Number(listing.estimated_roi ?? 0).toFixed(1)}%</strong></div></div> : null}
              {listing.ai_summary && <div className={`property-ai-summary${mode === "primary" ? " primary" : ""}`}>{mode === "primary" && <small>AI overview</small>}<p>{listing.ai_summary}</p></div>}
              <a className="map-link" href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([listing.address, listing.city, listing.state, listing.zip_code].filter(Boolean).join(", "))}`} target="_blank" rel="noreferrer">View map</a>
              <a className="listing-link" href={listingUrl(listing)} target="_blank" rel="noreferrer">View listing</a>
              {!listing.image_url && <button type="button" disabled={Boolean(loadingPhoto)} onClick={() => void findPhoto(listing)}>{loadingPhoto === `${listing.source_id}:${listing.search_id}` ? "Looking for photo…" : "Find photo"}</button>}
              <button onClick={() => window.dispatchEvent(new CustomEvent("open-pauli-assistant", { detail: { prompt: `Analyze this ${mode} property: ${listing.address}, listed at ${listing.price ?? "unknown price"}.` } }))}>Analyze with AI</button>
            </article>
          ))}
          {visibleCount < listings.length && <button className="property-more" onClick={() => setVisibleCount((count) => count + 12)}>Show more ({visibleCount} of {listings.length})</button>}
        </section>
      ) : (
        <section className="property-empty">
          <h2>{showStarred ? `No starred ${mode} properties yet` : "No listings yet"}</h2>
          <p>{showStarred ? "Select the star on any property to save it in this folder." : "No recently verified active listings match this view. Saved searches are checked weekly by default."}</p>
          {!showStarred && !activeSearches.length && <button onClick={() => setShowSearch(true)}>Add a region</button>}
        </section>
      )}
    </main>
  );
}
