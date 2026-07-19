"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import HqMenu from "../HqMenu";

type Mode = "primary" | "income";
type Listing = { source_id: string; search_id: number; address: string; city?: string; state?: string; zip_code?: string; property_type?: string; price?: number; bedrooms?: number; bathrooms?: number; square_feet?: number; days_on_market?: number; search_label: string; ai_score?: number; ai_summary?: string; latitude?: number; longitude?: number; image_url?: string; source_page_url?: string };
type Search = { id: number; mode: Mode; label: string; city?: string; state?: string; zip_code?: string };
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
  const [listings, setListings] = useState<Listing[]>([]);
  const [searches, setSearches] = useState<Search[]>([]);
  const [sourceConnected, setSourceConnected] = useState(false);
  const [selected, setSelected] = useState<Listing | null>(null);
  const [usage, setUsage] = useState<Usage>({ requests: 0, limit: 50, period: "" });
  const [showSearch, setShowSearch] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const attemptedPhotos = useRef(new Set<string>());
  const automaticPhotoCount = useRef(0);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [listingResponse, searchResponse] = await Promise.all([fetch(`/api/properties?mode=${mode}`), fetch("/api/property-searches")]);
    if (listingResponse.status === 401) return window.location.assign("/login");
    const listingData = await listingResponse.json() as { listings?: Listing[]; sourceConnected?: boolean; usage?: Usage; error?: string };
    const searchData = await searchResponse.json() as { searches?: Search[] };
    if (!listingResponse.ok) throw new Error(listingData.error || "Unable to load properties.");
    setListings(listingData.listings ?? []);
    setSelected((current) => current ?? listingData.listings?.find((listing) => listing.latitude != null && listing.longitude != null) ?? null);
    setSourceConnected(Boolean(listingData.sourceConnected));
    if (listingData.usage) setUsage(listingData.usage);
    setSearches(searchData.searches ?? []);
  }, [mode]);

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
        <div className="properties-nav"><button onClick={() => setShowSearch((value) => !value)}>+ Add region</button><HqMenu current="/properties" /></div>
      </header>
      <section className="properties-hero">
        <p className="kicker">AI Property Finder</p>
        <h1>Find the right property.</h1>
        <p>Fresh opportunities, organized for living or investing and ready for AI analysis.</p>
      </section>
      <nav className="property-tabs" aria-label="Property type">
        <button className={mode === "income" ? "active" : ""} onClick={() => setMode("income")}>Income properties</button>
        <button className={mode === "primary" ? "active" : ""} onClick={() => setMode("primary")}>Primary residences</button>
      </nav>

      <form className="property-ai-search" onSubmit={(event) => {
        event.preventDefault();
        const prompt = String(new FormData(event.currentTarget).get("prompt") ?? "").trim();
        if (prompt) window.location.assign(`/assistant?prompt=${encodeURIComponent(`Property Finder request: ${prompt}. Search current information and help me evaluate the result as a ${mode === "income" ? "real-estate investment" : "primary residence"}.`)}`);
      }}>
        <input name="prompt" placeholder="Ask about a specific home, address, city, ZIP code, or area..." required />
        <button type="submit">Ask AI</button>
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
        <div>{activeSearches.map((search) => <span key={search.id}>{search.label}</span>)}</div>
        <div className="property-feed-state"><small>{sourceConnected ? `Weekly feed connected · ${usage.requests} of ${usage.limit} monthly requests used` : "Listing feed needs connection"}</small>{sourceConnected && <button disabled={syncing} onClick={async () => { setSyncing(true); setError(""); const response = await fetch("/api/properties/sync", { method: "POST" }); const result = await response.json() as { error?: string }; if (!response.ok) setError(result.error || "Unable to start the scan."); window.setTimeout(() => { setSyncing(false); load().catch(() => undefined); }, 5000); }}>{syncing ? "Scanning…" : "Scan now"}</button>}</div>
      </section>
      {error && <p className="property-error" role="alert">{error}</p>}
      {selected?.latitude != null && selected.longitude != null && (
        <section className="property-map">
          <iframe title={`Map showing ${selected.address}`} loading="lazy" referrerPolicy="no-referrer" src={`https://www.openstreetmap.org/export/embed.html?bbox=${selected.longitude - .04}%2C${selected.latitude - .025}%2C${selected.longitude + .04}%2C${selected.latitude + .025}&layer=mapnik&marker=${selected.latitude}%2C${selected.longitude}`} />
          <div><strong>{selected.address}</strong><span>{selected.ai_score ? `AI score ${selected.ai_score}/100` : "Selected property"}</span><a href={`https://www.openstreetmap.org/?mlat=${selected.latitude}&mlon=${selected.longitude}#map=14/${selected.latitude}/${selected.longitude}`} target="_blank" rel="noreferrer">Open larger map ↗</a></div>
        </section>
      )}
      {listings.length ? (
        <section className="property-grid">
          {listings.map((listing) => (
            <article className="property-card" key={`${listing.source_id}-${listing.search_label}`}>
              <PropertyVisual listing={listing} />
              <div className="property-card-top"><span>{listing.search_label}</span><small>{listing.ai_score ? `AI ${listing.ai_score}/100` : `${listing.days_on_market ?? "—"} days`}</small></div>
              <h2><a className="property-address-link" href={listingUrl(listing)} target="_blank" rel="noreferrer">{listing.address}</a></h2>
              <p>{[listing.city, listing.state, listing.zip_code].filter(Boolean).join(", ")}</p>
              <strong>{listing.price ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(listing.price) : "Price unavailable"}</strong>
              <dl><div><dt>Beds</dt><dd>{listing.bedrooms ?? "—"}</dd></div><div><dt>Baths</dt><dd>{listing.bathrooms ?? "—"}</dd></div><div><dt>Sq ft</dt><dd>{listing.square_feet?.toLocaleString() ?? "—"}</dd></div></dl>
              {listing.ai_summary && <p className="property-ai-summary">{listing.ai_summary}</p>}
              {listing.latitude != null && listing.longitude != null && <button className="map-button" onClick={() => { setSelected(listing); window.scrollTo({ top: 420, behavior: "smooth" }); }}>View on map</button>}
              <a className="listing-link" href={listingUrl(listing)} target="_blank" rel="noreferrer">View listing ↗</a>
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
