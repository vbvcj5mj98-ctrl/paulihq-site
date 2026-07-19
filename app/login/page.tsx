"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";

export default function LoginPage() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
    });
    setBusy(false);
    if (response.ok) {
      window.location.assign("/portal");
      return;
    }
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    setError(result.error ?? "Unable to sign in.");
  }

  return (
    <main className="login-page">
      <Link className="back-link" href="/" aria-label="Return home">&larr;</Link>
      <section className="login-card">
        <h1>Log in</h1>
        <form className="login-form" onSubmit={submit}>
          <label className="sr-only" htmlFor="username">Username</label>
          <input id="username" name="username" type="text" autoComplete="username" placeholder="Username" required />
          <label className="sr-only" htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" placeholder="Password" required />
          {error && <p className="form-error" role="alert">{error}</p>}
          <button type="submit" disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
        </form>
      </section>
    </main>
  );
}
