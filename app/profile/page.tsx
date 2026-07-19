"use client";

import { FormEvent, useEffect, useState } from "react";
import HqMenu from "../HqMenu";
import HqHomeLink from "../HqHomeLink";

export default function ProfilePage() {
  const [username, setUsername] = useState("");
  const [frequency, setFrequency] = useState("weekly");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { fetch("/api/profile").then(async (response) => { if (response.status === 401) return window.location.assign("/login"); if (response.status === 403) return window.location.assign("/portal"); const result = await response.json() as { username?: string; propertyRefresh?: string; error?: string }; if (!response.ok) throw new Error(result.error || "Unable to load profile."); setUsername(result.username ?? ""); setFrequency(result.propertyRefresh ?? "weekly"); }).catch((reason: Error) => setError(reason.message)); }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); setSaved(false); setError("");
    const response = await fetch("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ propertyRefresh: frequency }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) return setError(result.error || "Unable to save profile.");
    setSaved(true);
  }
  return <main className="lists-page">
    <header className="properties-header"><HqHomeLink /><HqMenu current="/profile" /></header>
    <section className="admin-shell">
      <div className="lists-heading"><p className="kicker">{username || "Profile"}</p><h1>Profile</h1><p>Choose how often your saved property searches refresh automatically.</p></div>
      <form className="admin-user-form" onSubmit={save}>
        <label>Property refresh schedule<select value={frequency} onChange={(event) => { setFrequency(event.target.value); setSaved(false); }}><option value="weekly">Weekly</option><option value="daily">Daily</option><option value="twice_daily">Twice daily</option></select></label>
        <small>Weekly is the default and uses the fewest RentCast requests. Searches you submit manually still run immediately.</small>
        <button type="submit">Save preference</button>
      </form>
      {error && <p className="property-error" role="alert">{error}</p>}{saved && <p className="admin-success">Preference saved.</p>}
    </section>
  </main>;
}
