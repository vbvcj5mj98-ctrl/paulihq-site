"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import HqHomeLink from "../HqHomeLink";
import HqMenu from "../HqMenu";

type Property = { id: number; owner: string; name: string; address: string; apn?: string; occupancy: "rented" | "primary" | "secondary" | "vacant"; estimated_value: number; money_owed: number; notes?: string; latitude?: number; longitude?: number; shared_with?: string };
type Weather = { temperature_2m?: number; apparent_temperature?: number; weather_code?: number; wind_speed_10m?: number };
type User = { username: string };

const weatherNames: Record<number, string> = { 0: "Clear", 1: "Mostly clear", 2: "Partly cloudy", 3: "Cloudy", 45: "Fog", 48: "Fog", 51: "Light drizzle", 53: "Drizzle", 55: "Heavy drizzle", 61: "Light rain", 63: "Rain", 65: "Heavy rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow", 80: "Rain showers", 81: "Rain showers", 82: "Heavy showers", 95: "Thunderstorms" };
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

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
  const load = useCallback(async () => {
    const [propertiesResponse, usersResponse, meResponse] = await Promise.all([fetch("/api/portfolio"), fetch("/api/portfolio-users"), fetch("/api/me")]);
    if (propertiesResponse.status === 401) return window.location.assign("/login");
    const propertyData = await propertiesResponse.json() as { properties?: Property[]; error?: string };
    if (!propertiesResponse.ok) throw new Error(propertyData.error || "Unable to load the portfolio.");
    const userData = await usersResponse.json() as { users?: User[] }; const me = await meResponse.json() as { username?: string };
    setProperties(propertyData.properties ?? []); setUsers(userData.users ?? []); setUsername(me.username ?? "");
  }, []);
  useEffect(() => { load().catch((reason: Error) => setError(reason.message)); }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const form = event.currentTarget; const values = new FormData(form);
    const response = await fetch("/api/portfolio", { method: editing ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: editing?.id, name: values.get("name"), address: values.get("address"), apn: values.get("apn"), occupancy: values.get("occupancy"), estimatedValue: values.get("estimatedValue"), moneyOwed: values.get("moneyOwed"), notes: values.get("notes"), sharedWith: values.getAll("sharedWith") }) });
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

  const totalValue = properties.reduce((total, property) => total + Number(property.estimated_value || 0), 0);
  const totalOwed = properties.reduce((total, property) => total + Number(property.money_owed || 0), 0);
  return <main className="properties-page">
    <header className="properties-header"><HqHomeLink /><div className="properties-nav"><button onClick={() => { setEditing(null); setShowForm(true); }}>+ Add property</button><HqMenu current="/portfolio" /></div></header>
    <section className="portfolio-shell">
      <div className="portfolio-heading"><div><p className="kicker">Owned properties</p><h1>Property Portfolio</h1></div><div className="portfolio-summary"><div><small>Estimated value</small><strong>{money.format(totalValue)}</strong></div><div><small>Money owed</small><strong>{money.format(totalOwed)}</strong></div><div className="portfolio-total"><small>Estimated net equity</small><strong>{money.format(totalValue - totalOwed)}</strong><span>{properties.length} {properties.length === 1 ? "property" : "properties"}</span></div></div></div>
      {(showForm || editing) && <form className="portfolio-form" onSubmit={save}>
        <div className="portfolio-form-title"><h2>{editing ? "Edit property" : "Add owned property"}</h2><button type="button" onClick={() => { setEditing(null); setShowForm(false); }}>Close</button></div>
        <label>Property name<input name="name" defaultValue={editing?.name} placeholder="Bentonville duplex" required /></label>
        <label className="wide">Full address<input name="address" defaultValue={editing?.address} placeholder="Street, city, state, ZIP (optional when using an APN)" /></label>
        <label>APN<input name="apn" defaultValue={editing?.apn} placeholder="Assessor parcel number" /></label>
        <label>Use<select name="occupancy" defaultValue={editing?.occupancy ?? "rented"}><option value="rented">Rented</option><option value="primary">Primary residence</option><option value="secondary">Secondary residence</option><option value="vacant">Vacant</option></select></label>
        <label>Estimated value<input name="estimatedValue" type="number" min="0" step="1000" defaultValue={editing?.estimated_value} placeholder="450000" /></label>
        <label>Money owed<input name="moneyOwed" type="number" min="0" step="100" defaultValue={editing?.money_owed} placeholder="275000" /></label>
        <label className="wide">General notes<textarea name="notes" defaultValue={editing?.notes} placeholder="Loan details, repairs, tenants, reminders, or anything else about this property." /></label>
        <fieldset className="wide"><legend>Share with</legend><div>{users.filter((user) => user.username !== username).map((user) => <label key={user.username}><input type="checkbox" name="sharedWith" value={user.username} defaultChecked={editing?.shared_with?.split(",").includes(user.username)} />{user.username}</label>)}</div></fieldset>
        <button className="portfolio-save" type="submit">{editing ? "Save changes" : "Add to portfolio"}</button>
      </form>}
      {error && <p className="property-error" role="alert">{error}</p>}
      <section className="portfolio-grid">
        {properties.map((property) => <article className="portfolio-card" key={property.id}>
          <div className="portfolio-card-top"><span>{property.occupancy}</span><small>{property.owner === username ? "Owned by you" : `Shared by ${property.owner}`}</small></div>
          <h2>{property.name}</h2>{property.address ? <a href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(property.address)}`} target="_blank" rel="noreferrer">{property.address} ↗</a> : <p className="portfolio-apn">APN {property.apn}</p>}
          <div className="portfolio-finances"><div><small>Estimated value</small><strong>{money.format(property.estimated_value || 0)}</strong></div><div><small>Money owed</small><strong>{money.format(property.money_owed || 0)}</strong></div><div><small>Net equity</small><strong>{money.format((property.estimated_value || 0) - (property.money_owed || 0))}</strong></div></div>
          {property.address && <WeatherPanel property={property} />}
          {property.notes && <div className="portfolio-notes"><small>Notes</small><p>{property.notes}</p></div>}
          {property.shared_with && <p className="portfolio-shared">Shared with {property.shared_with.split(",").join(", ")}</p>}
          {property.owner === username && <div className="portfolio-actions"><button onClick={() => { setEditing(property); setShowForm(false); window.scrollTo({ top: 0, behavior: "smooth" }); }}>Edit</button><button onClick={() => remove(property)}>Remove</button></div>}
        </article>)}
        {!properties.length && <div className="portfolio-empty"><h2>No owned properties yet</h2><p>Add a property to start tracking its use, value, weather, and shared access.</p><button onClick={() => setShowForm(true)}>Add your first property</button></div>}
      </section>
    </section>
  </main>;
}
