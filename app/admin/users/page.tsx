"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import HqMenu from "../../HqMenu";

type User = { username: string; created_at: number };

export default function UserManagementPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async () => {
    const response = await fetch("/api/admin/users");
    if (response.status === 401) return window.location.assign("/login");
    if (response.status === 403) return window.location.assign("/portal");
    const result = await response.json() as { users?: User[]; error?: string };
    if (!response.ok) throw new Error(result.error || "Unable to load users.");
    setUsers(result.users ?? []);
  }, []);
  useEffect(() => { load().catch((reason: Error) => setError(reason.message)); }, [load]);

  async function createUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); setMessage("");
    const form = event.currentTarget;
    const values = new FormData(form);
    const response = await fetch("/api/admin/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: values.get("username"), password: values.get("password") }) });
    const result = await response.json() as { username?: string; error?: string };
    if (!response.ok) setError(result.error || "Unable to create the user.");
    else { setMessage(`${result.username} can now log in.`); form.reset(); await load(); }
    setBusy(false);
  }

  return <main className="lists-page">
    <header className="properties-header"><Link href="/portal">← Pauli HQ</Link><HqMenu current="/admin/users" /></header>
    <section className="admin-shell">
      <div className="lists-heading"><p className="kicker">Carson only</p><h1>User Management</h1><p>Create a login and share the temporary password privately with the new user.</p></div>
      <form className="admin-user-form" onSubmit={createUser}>
        <label>Username<input name="username" minLength={3} maxLength={32} autoCapitalize="none" autoCorrect="off" required /></label>
        <label>Temporary password<input name="password" type="password" minLength={12} autoComplete="new-password" required /></label>
        <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create login"}</button>
      </form>
      {error && <p className="property-error" role="alert">{error}</p>}
      {message && <p className="admin-success" role="status">{message}</p>}
      <section className="admin-users"><h2>Current users</h2>{users.map((user) => <div key={user.username}><strong>{user.username}</strong><span>Created {new Date(user.created_at).toLocaleDateString()}</span></div>)}</section>
    </section>
  </main>;
}
