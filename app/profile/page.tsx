"use client";

import { FormEvent, useEffect, useState } from "react";
import HqMenu from "../HqMenu";
import HqHomeLink from "../HqHomeLink";

export default function ProfilePage() {
  const [username, setUsername] = useState("");
  const [frequency, setFrequency] = useState("weekly");
  const [isAdmin, setIsAdmin] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { fetch("/api/profile").then(async (response) => { if (response.status === 401) return window.location.assign("/login"); const result = await response.json() as { username?: string; isAdmin?: boolean; propertyRefresh?: string; error?: string }; if (!response.ok) throw new Error(result.error || "Unable to load profile."); setUsername(result.username ?? ""); setIsAdmin(Boolean(result.isAdmin)); setFrequency(result.propertyRefresh ?? "weekly"); }).catch((reason: Error) => setError(reason.message)); }, []);
  async function save(event: FormEvent) {
    event.preventDefault(); setSaved(false); setError("");
    const response = await fetch("/api/profile", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ propertyRefresh: frequency }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) return setError(result.error || "Unable to save profile.");
    setSaved(true);
  }
  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setSaved(false); setError("");
    const form = event.currentTarget; const values = new FormData(form);
    if (values.get("newPassword") !== values.get("confirmPassword")) return setError("The new passwords do not match.");
    const response = await fetch("/api/change-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: values.get("currentPassword"), newPassword: values.get("newPassword") }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) return setError(result.error || "Unable to change the password.");
    form.reset(); setSaved(true);
  }
  return <main className="lists-page">
    <header className="properties-header"><HqHomeLink /><HqMenu current="/profile" /></header>
    <section className="admin-shell">
      <div className="lists-heading"><p className="kicker">{username || "Profile"}</p><h1>Profile</h1><p>Manage your password and account settings.</p></div>
      <form className="admin-user-form" onSubmit={changePassword}>
        <label>Current password<input name="currentPassword" type="password" autoComplete="current-password" required /></label>
        <label>New password<input name="newPassword" type="password" minLength={12} autoComplete="new-password" required /></label>
        <label>Confirm new password<input name="confirmPassword" type="password" minLength={12} autoComplete="new-password" required /></label>
        <small>Use at least 12 characters. Changing your password signs out your other devices.</small>
        <button type="submit">Change password</button>
      </form>
      {isAdmin && <form className="admin-user-form" onSubmit={save}>
        <label>Property refresh schedule<select value={frequency} onChange={(event) => { setFrequency(event.target.value); setSaved(false); }}><option value="weekly">Weekly</option><option value="daily">Daily</option><option value="twice_daily">Twice daily</option></select></label>
        <small>Weekly is the default and uses the fewest RentCast requests. Searches you submit manually still run immediately.</small>
        <button type="submit">Save preference</button>
      </form>}
      {error && <p className="property-error" role="alert">{error}</p>}{saved && <p className="admin-success">Changes saved.</p>}
    </section>
  </main>;
}
