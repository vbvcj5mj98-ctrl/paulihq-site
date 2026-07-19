"use client";

import { FormEvent, useState } from "react";

export default function Home() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: form.get("username"), password: form.get("password") }) });
    setBusy(false);
    if (response.ok) return window.location.assign("/portal");
    const result = await response.json().catch(() => ({})) as { error?: string };
    setError(result.error ?? "Unable to sign in.");
  }

  return <main className="home-login-page">
    <section className="home-login-shell">
      <img className="home-login-logo" src="/paulihq-wordmark-earth.png" alt="Pauli HQ" />
      <form className="home-login-form" onSubmit={submit}>
        <p>Private access</p>
        <label className="sr-only" htmlFor="home-username">Username</label>
        <input id="home-username" name="username" autoComplete="username" placeholder="Username" required />
        <label className="sr-only" htmlFor="home-password">Password</label>
        <input id="home-password" name="password" type="password" autoComplete="current-password" placeholder="Password" required />
        {error && <span className="form-error" role="alert">{error}</span>}
        <button type="submit" disabled={busy}>{busy ? "Signing in…" : "Log in"}</button>
      </form>
    </section>
  </main>;
}
