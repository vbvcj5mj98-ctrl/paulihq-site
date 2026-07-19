"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import HqMenu from "../../HqMenu";
import HqHomeLink from "../../HqHomeLink";

type Permissions = Record<"assistant" | "lists" | "properties" | "user_management", boolean>;
type User = { username: string; created_at: number; permissions?: Permissions; property_limit?: number; property_usage?: number };
const pageLabels: Array<[keyof Permissions, string]> = [["assistant", "Assistant"], ["lists", "Lists"], ["properties", "Property Finder"], ["user_management", "New Users"]];

export default function UserManagementPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [accessUsers, setAccessUsers] = useState<User[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const [meResponse, usersResponse] = await Promise.all([fetch("/api/me"), fetch("/api/admin/users")]);
    if (usersResponse.status === 401) return window.location.assign("/login");
    if (usersResponse.status === 403) return window.location.assign("/portal");
    const me = await meResponse.json() as { isAdmin?: boolean };
    const result = await usersResponse.json() as { users?: User[]; error?: string };
    if (!usersResponse.ok) throw new Error(result.error || "Unable to load users.");
    setUsers(result.users ?? []); setIsOwner(Boolean(me.isAdmin));
    if (me.isAdmin) {
      const accessResponse = await fetch("/api/admin/access");
      const accessResult = await accessResponse.json() as { users?: User[]; error?: string };
      if (!accessResponse.ok) throw new Error(accessResult.error || "Unable to load page access.");
      setAccessUsers(accessResult.users ?? []);
    }
  }, []);
  useEffect(() => { load().catch((reason: Error) => setError(reason.message)); }, [load]);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    const form = event.currentTarget; const values = new FormData(form);
    const response = await fetch("/api/admin/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: values.get("username"), password: values.get("password") }) });
    const result = await response.json() as { username?: string; error?: string };
    if (!response.ok) setError(result.error || "Unable to create the user.");
    else { setMessage(`${result.username} can now log in. Choose their page access below.`); form.reset(); await load(); }
    setBusy(false);
  }

  async function changeAccess(user: User, key: keyof Permissions, allowed: boolean) {
    if (!user.permissions || user.username === "carsonpauli") return;
    const previous = accessUsers;
    const permissions = { ...user.permissions, [key]: allowed };
    setAccessUsers((current) => current.map((entry) => entry.username === user.username ? { ...entry, permissions } : entry));
    const response = await fetch("/api/admin/access", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: user.username, permissions }) });
    if (!response.ok) { setAccessUsers(previous); const result = await response.json() as { error?: string }; setError(result.error || "Unable to change access."); }
  }

  async function resetPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    const form = event.currentTarget; const values = new FormData(form);
    const response = await fetch("/api/admin/password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: values.get("username"), password: values.get("password") }) });
    const result = await response.json() as { username?: string; error?: string };
    if (!response.ok) setError(result.error || "Unable to reset the password.");
    else { setMessage(`Password reset for ${result.username}. Their previous sessions were signed out.`); form.reset(); }
    setBusy(false);
  }

  async function savePropertyLimit(user: User) {
    const response = await fetch("/api/admin/property-limit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: user.username, monthlyLimit: user.property_limit }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) setError(result.error || "Unable to save the Property Finder limit."); else setMessage(`Property Finder limit saved for ${user.username}.`);
  }

  return <main className="lists-page">
    <header className="properties-header"><HqHomeLink /><HqMenu current="/admin/users" /></header>
    <section className="admin-shell">
      <div className="lists-heading"><p className="kicker">{isOwner ? "Carson admin" : "User management"}</p><h1>User Management</h1><p>Create a login and share the temporary password privately with the new user.</p></div>
      <form className="admin-user-form" onSubmit={createUser}>
        <label>Username<input name="username" minLength={3} maxLength={32} autoCapitalize="none" autoCorrect="off" required /></label>
        <label>Temporary password<input name="password" type="password" minLength={12} autoComplete="new-password" required /></label>
        <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create login"}</button>
      </form>
      {error && <p className="property-error" role="alert">{error}</p>}{message && <p className="admin-success" role="status">{message}</p>}
      {isOwner && <section className="access-panel"><h2>Page access</h2><p>Choose exactly what each person can open.</p>{accessUsers.map((user) => <div className="access-user" key={user.username}><strong>{user.username}</strong><div>{pageLabels.map(([key, label]) => <label key={key}><input type="checkbox" checked={Boolean(user.permissions?.[key])} disabled={user.username === "carsonpauli"} onChange={(event) => changeAccess(user, key, event.target.checked)} />{label}</label>)}</div></div>)}</section>}
      {isOwner && <section className="access-panel"><h2>Property Finder limits</h2><p>Set each person's maximum manual property searches per month. Zero disables manual searches.</p>{accessUsers.map((user) => <div className="property-limit-row" key={user.username}><span><strong>{user.username}</strong><small>{user.property_usage ?? 0} used this month</small></span><input type="number" min="0" max="50" value={user.property_limit ?? 5} aria-label={`Monthly Property Finder limit for ${user.username}`} onChange={(event) => setAccessUsers((current) => current.map((entry) => entry.username === user.username ? { ...entry, property_limit: Number(event.target.value) } : entry))} /><button type="button" onClick={() => savePropertyLimit(user)}>Save</button></div>)}</section>}
      {isOwner && <section className="access-panel"><h2>Reset password</h2><p>Set a new temporary password and sign that user out of their other sessions.</p><form className="password-reset-form" onSubmit={resetPassword}><select name="username" required defaultValue=""><option value="" disabled>Select user</option>{accessUsers.map((user) => <option value={user.username} key={user.username}>{user.username}</option>)}</select><input name="password" type="password" minLength={12} placeholder="New temporary password" autoComplete="new-password" required /><button type="submit" disabled={busy}>{busy ? "Saving…" : "Reset password"}</button></form></section>}
      <section className="admin-users"><h2>Current users</h2>{users.map((user) => <div key={user.username}><strong>{user.username}</strong><span>Created {new Date(user.created_at).toLocaleDateString()}</span></div>)}</section>
    </section>
  </main>;
}
