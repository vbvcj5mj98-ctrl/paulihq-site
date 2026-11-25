"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import AddressAutocomplete, { type AddressSuggestion } from "../AddressAutocomplete";
import HqHomeLink from "../HqHomeLink";
import HqMenu from "../HqMenu";

type Property = { id: number; owner: string; name: string; address: string; apn?: string; county?: string; state?: string; occupancy: "rented" | "primary" | "secondary" | "vacant"; estimated_value: number; money_owed: number; notes?: string; latitude?: number; longitude?: number; shared_with?: string; assessor_id?: string; assessed_value?: number; land_value?: number; improvement_value?: number; assessment_year?: number; annual_tax?: number; tax_year?: number; legal_description?: string; zoning?: string; last_sale_price?: number; last_sale_date?: string; parcel_refreshed_at?: number };
type Weather = { temperature_2m?: number; apparent_temperature?: number; weather_code?: number; wind_speed_10m?: number };
type User = { username: string };

const weatherNames: Record<number, string> = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy", 45: "Fog", 48: "Fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 80: "Rain showers", 81: "Rain showers", 82: "Heavy showers", 95: "Thunderstorms" };
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
type AddressData = { address?: string; latitude?: number; longitude?: number; error?: string };
type Valuation = AddressData & { estimatedValue?: number; rangeLow?: number; rangeHigh?: number };

async function addressRequest<T>(url: string, body: object, signal: AbortSignal) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const result = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(result.error || "The address service didn’t respond.");
  return result;
}

function WeatherPanel({ property }: { property: Property }) {
  const [weather, setWeather] = useState<Weather | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { fetch(`/api/portfolio-weather?id=${property.id}`).then(async (response) => { const result = await response.json() as { current?: Weather; error?: string }; if (!response.ok) throw new Error(result.error); setWeather(result.current ?? null); }).catch((reason: Error) => setError(reason.message)); }, [property.id]);
  if (error) return <div className="portfolio-weather"><small>Weather</small><span>Location unavailable</span></div>;
  if (!weather) return <div className="portfolio-weather"><small>Weather</small><span>Loading…</span></div>;
  return <div className="portfolio-weather"><small>Current weather</small><strong>{Math.round(Number(weather.temperature_2m))}°F</strong><span>{weatherNames[Number(weather.weather_code)] ?? "Current conditions"} · feels {Math.round(Number(weather.apparent_temperature))}° · {Math.round(Number(weather.wind_speed_10m))} mph wind</span></div>;
}

export default function PortfolioPage() {
  const [properties, setProperties] = useState<Property[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [username, setUsername] = useState("");
  const [editing, setEditing] = useState<Property | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState("");
  const [addressInput, setAddressInput] = useState("");
  const [estimatedValueInput, setEstimatedValueInput] = useState("");
  const [coordinates, setCoordinates] = useState<{ latitude?: number; longitude?: number }>({});
  const [addressBusy, setAddressBusy] = useState(false);
  const [valuationNote, setValuationNote] = useState("");
  const [parcelBusy, setParcelBusy] = useState<number | null>(null);
  const addressWork = useRef<AbortController | null>(null);
  const [formRevision, setFormRevision] = useState(0);
  const load = useCallback(async () => {
    const [propertiesResponse, usersResponse, meResponse] = await Promise.all([fetch("/api/portfolio"), fetch("/api/portfolio-users"), fetch("/api/me")]);
    if (propertiesResponse.status === 401) return window.location.assign("/login");
    const propertyData = await propertiesResponse.json() as { properties?: Property[]; error?: string };
    if (!propertiesResponse.ok) throw new Error(propertyData.error || "Unable to load the portfolio.");
    const userData = await usersResponse.json() as { users?: User[] }; const me = await meResponse.json() as { username?: string };
    setProperties(propertyData.properties ?? []); setUsers(userData.users ?? []); setUsername(me.username ?? "");
  }, []);
  useEffect(() => { load().catch((reason: Error) => setError(reason.message)); }, [load]);

  useEffect(() => () => { addressWork.current?.abort(); addressWork.current = null; }, []);

  function stopAddressWork() {
    addressWork.current?.abort();
    addressWork.current = null;
    setAddressBusy(false);
  }

  function startNew() {
    stopAddressWork(); setFormRevision((previous) => previous + 1);
    setEditing(null); setShowForm(true); setAddressInput(""); setEstimatedValueInput(""); setCoordinates({}); setValuationNote("");
  }

  function startEdit(property: Property) {
    stopAddressWork(); setFormRevision((previous) => previous + 1);
    setEditing(property); setShowForm(false); setAddressInput(property.address ?? ""); setEstimatedValueInput(String(property.estimated_value || "")); setCoordinates({ latitude: property.latitude, longitude: property.longitude }); setValuationNote(""); window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function estimateValue(address: string, selection?: { placeId: string; sessionToken?: string }) {
    if (!address.trim()) return;
    stopAddressWork();
    const controller = new AbortController();
    addressWork.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 16_000);
    setAddressBusy(true);
    setValuationNote(selection ? "Confirming address…" : "Finding current market estimate…");
    try {
      if (selection) {
        const details = await addressRequest<AddressData>("/api/address-details", selection, controller.signal);
        if (addressWork.current !== controller) return;
        if (!details.address) throw new Error("Google couldn’t confirm the selected address.");
        address = details.address;
        setAddressInput(address);
        setCoordinates({ latitude: details.latitude, longitude: details.longitude });
        setValuationNote("Finding current market estimate…");
      }
      const result = await addressRequest<Valuation>("/api/portfolio-value", { address }, controller.signal);
      if (addressWork.current !== controller) return;
      if (!result.estimatedValue) throw new Error("No automatic estimate was available.");
      if (result.address) setAddressInput(result.address);
      setEstimatedValueInput(String(result.estimatedValue));
      setCoordinates((current) => ({ latitude: result.latitude ?? current.latitude, longitude: result.longitude ?? current.longitude }));
      setValuationNote(result.rangeLow && result.rangeHigh ? `RentCast estimate range: ${money.format(result.rangeLow)}–${money.format(result.rangeHigh)}` : "RentCast market estimate added.");
    } catch (reason) {
      if (addressWork.current !== controller) return;
      const message = controller.signal.aborted ? "The lookup timed out." : reason instanceof Error && reason.name === "Error" ? reason.message : "The lookup couldn’t be completed.";
      setValuationNote(`${message} You can still save the address and enter a value manually.`);
    } finally {
      window.clearTimeout(timer);
      if (addressWork.current === controller) { addressWork.current = null; setAddressBusy(false); }
    }
  }

  function chooseAddress(suggestion: AddressSuggestion, sessionToken?: string) {
    const address = suggestion.text.trim().replace(/,\s*USA$/i, "");
    setAddressInput(address); setCoordinates({});
    void estimateValue(address, { placeId: suggestion.placeId, sessionToken });
  }

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(""); stopAddressWork();
    const form = event.currentTarget; const values = new FormData(form);
    const response = await fetch("/api/portfolio", { method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: editing?.id, name: values.get("name"), address: addressInput, apn: values.get("apn"), county: values.get("county"), state: values.get("state"), occupancy: values.get("occupancy"), estimatedValue: estimatedValueInput, moneyOwed: values.get("moneyOwed"), notes: values.get("notes"), latitude: coordinates.latitude, longitude: coordinates.longitude, sharedWith: values.getAll("sharedWith") }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) return setError(result.error || "Unable to save the property.");
    form.reset(); setEditing(null); setShowForm(false); await load();
  }

  async function remove(property: Property) {
    if (!window.confirm(`Remove ${property.name} from the portfolio?`)) return;
    const response = await fetch("/api/portfolio", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: property.id }) });
    if (!response.ok) return setError("Unable to remove the property.");
    await load();
  }

  async function loadParcel(property: Property) {
    setParcelBusy(property.id); setError("");
    const response = await fetch("/api/portfolio-parcel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: property.id }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) setError(result.error || "Unable to retrieve the parcel record.");
    else await load();
    setParcelBusy(null);
  }

  const totalValue = properties.reduce((total, property) => total + Number(property.estimated_value || 0), 0);
  const totalOwed = properties.reduce((total, property) => total + Number(property.money_owed || 0), 0);
  return <main className="properties-page">
    <header className="properties-header"><HqHomeLink /><div className="properties-nav"><button onClick={startNew}>+ Add property</button><HqMenu current="/portfolio" /></div></header>
    <section className="portfolio-shell">
      <div className="portfolio-heading"><div><p className="kicker">Owned properties</p><h1>Property Portfolio</h1></div><div className="portfolio-summary"><div><small>Estimated value</small><strong>{money.format(totalValue)}</strong></div><div><small>Money owed</small><strong>{money.format(totalOwed)}</strong></div><div className="portfolio-total"><small>Estimated net equity</small><strong>{money.format(totalValue - totalOwed)}</strong><span>{properties.length} {properties.length === 1 ? "property" : "properties"}</span></div></div></div>
      {(showForm || editing) && <form key={formRevision} className="portfolio-form" onSubmit={save}>
        <div className="portfolio-form-title"><h2>{editing ? "Edit property" : "Add owned property"}</h2><button type="button" onClick={() => { stopAddressWork(); setEditing(null); setShowForm(false); }}>Close</button></div>
        <label>Property name<input name="name" defaultValue={editing?.name} placeholder="Bentonville duplex" required /></label>
        <AddressAutocomplete className="wide portfolio-address-field" fieldClassName="address-input" name="address" label="Full address" value={addressInput} placeholder="Start typing a street address…" onChange={(value) => { stopAddressWork(); setAddressInput(value); setCoordinates({}); setValuationNote(""); }} onSelect={chooseAddress} />
        <div className="portfolio-apn-fields wide">
          <label>APN<input name="apn" defaultValue={editing?.apn} placeholder="Assessor parcel number" /></label>
          <label>County<input name="county" defaultValue={editing?.county} placeholder="Benton" /></label>
          <label>State<input name="state" defaultValue={editing?.state} placeholder="AR" maxLength={2} autoCapitalize="characters" /></label>
          <small>For an APN-only property, include its county and two-letter state.</small>
        </div>
        <label>Use<select name="occupancy" defaultValue={editing?.occupancy ?? "rented"}><option value="rented">Rented</option><option value="primary">Primary residence</option><option value="secondary">Secondary residence</option><option value="vacant">Vacant</option></select></label>
        <label>Estimated value<div className="valuation-field"><input name="estimatedValue" type="number" min="0" step="1" value={estimatedValueInput} onChange={(event) => { stopAddressWork(); setValuationNote(""); setEstimatedValueInput(event.target.value); }} placeholder="Select an address to estimate" /><button type="button" disabled={addressBusy || !addressInput.trim()} onClick={() => estimateValue(addressInput)}>Refresh</button></div>{valuationNote && <small className="valuation-note" role="status">{valuationNote}</small>}</label>
        <label>Money owed<input name="moneyOwed" type="number" min="0" step="100" defaultValue={editing?.money_owed} placeholder="275000" /></label>
        <label className="wide">General notes<textarea name="notes" defaultValue={editing?.notes} placeholder="Loan details, repairs, tenants, reminders, or anything else about this property." /></label>
        <fieldset className="wide"><legend>Share with</legend><div>{users.filter((user) => user.username !== username).map((user) => <label key={user.username}><input type="checkbox" name="sharedWith" value={user.username} defaultChecked={editing?.shared_with?.split(",").includes(user.username)} />{user.username}</label>)}</div></fieldset>
        <button className="portfolio-save" type="submit">{editing ? "Save changes" : "Add to portfolio"}</button>
      </form>}
      {error && <p className="property-error" role="alert">{error}</p>}
      <section className="portfolio-grid">
        {properties.map((property) => <article className="portfolio-card" key={property.id}>
          <div className="portfolio-card-top"><span>{property.occupancy}</span><small>{property.owner === username ? "Owned by you" : `Shared by ${property.owner}`}</small></div>
          <h2>{property.name}</h2>{property.address ? <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(property.address)}`} target="_blank" rel="noreferrer">{property.address} ↗</a> : <p className="portfolio-apn">APN {property.apn}{property.county || property.state ? ` · ${[property.county && `${property.county} County`, property.state].filter(Boolean).join(", ")}` : ""}</p>}
          <div className="portfolio-finances"><div><small>Estimated value</small><strong>{money.format(property.estimated_value || 0)}</strong></div><div><small>Money owed</small><strong>{money.format(property.money_owed || 0)}</strong></div><div><small>Net equity</small><strong>{money.format((property.estimated_value || 0) - (property.money_owed || 0))}</strong></div></div>
          {property.assessor_id || property.assessed_value ? <div className="portfolio-parcel"><div className="portfolio-parcel-title"><small>County parcel record</small><button onClick={() => loadParcel(property)} disabled={parcelBusy === property.id}>{parcelBusy === property.id ? "Refreshing…" : "Refresh"}</button></div><dl><div><dt>APN</dt><dd>{property.assessor_id || property.apn || "—"}</dd></div><div><dt>Assessed value{property.assessment_year ? ` (${property.assessment_year})` : ""}</dt><dd>{property.assessed_value ? money.format(property.assessed_value) : "—"}</dd></div><div><dt>Land</dt><dd>{property.land_value ? money.format(property.land_value) : "—"}</dd></div><div><dt>Improvements</dt><dd>{property.improvement_value ? money.format(property.improvement_value) : "—"}</dd></div><div><dt>Property tax{property.tax_year ? ` (${property.tax_year})` : ""}</dt><dd>{property.annual_tax ? money.format(property.annual_tax) : "—"}</dd></div><div><dt>Zoning</dt><dd>{property.zoning || "—"}</dd></div></dl>{property.legal_description && <p>{property.legal_description}</p>}{property.last_sale_price ? <span>Last recorded sale: {money.format(property.last_sale_price)}{property.last_sale_date ? ` · ${new Date(property.last_sale_date).toLocaleDateString()}` : ""}</span> : null}</div> : <div className="portfolio-parcel-empty"><span>{property.apn ? "Look up this APN in nationwide county parcel records." : "APN and assessed value are available from county records."}</span>{(property.address || property.apn) && <button onClick={() => loadParcel(property)} disabled={parcelBusy === property.id}>{parcelBusy === property.id ? "Loading parcel record…" : "Load parcel record"}</button>}</div>}
          {property.address && <WeatherPanel property={property} />}
          {property.notes && <div className="portfolio-notes"><small>Notes</small><p>{property.notes}</p></div>}
          {property.shared_with && <p className="portfolio-shared">Shared with {property.shared_with.split(",").join(", ")}</p>}
          {property.owner === username && <div className="portfolio-actions"><button onClick={() => startEdit(property)}>Edit</button><button onClick={() => remove(property)}>Remove</button></div>}
        </article>)}
        {!properties.length && <div className="portfolio-empty"><h2>No owned properties yet</h2><p>Add a property to start tracking its use, value, weather, and shared access.</p><button onClick={startNew}>Add your first property</button></div>}
      </section>
    </section>
  </main>;
}
