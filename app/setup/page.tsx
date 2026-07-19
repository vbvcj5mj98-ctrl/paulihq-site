"use client";

import { FormEvent, useState } from "react";

export default function SetupPage() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== form.get("confirmPassword")) {
      setBusy(false);
      setError("Passwords do not match.");
      return;
    }
    const response = await fetch("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: form.get("username"),
        password,
        setupCode: form.get("setupCode"),
      }),
    });
    setBusy(false);
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      setError(result.error ?? "Unable to create account.");
      return;
    }
    setMessage("Password saved. You can now log in.");
    event.currentTarget.reset();
  }

  return (
    <main className="login-page">
      <section className="login-card setup-card">
        <h1>Set up account</h1>
        <p>Use this once for each approved Pauli HQ username.</p>
        <form className="login-form" onSubmit={submit}>
          <select name="username" aria-label="Username" required defaultValue="">
            <option value="" disabled>Choose username</option>
            <option value="carsonpauli">carsonpauli</option>
            <option value="jessipauli">jessipauli</option>
          </select>
          <input name="password" type="password" autoComplete="new-password" placeholder="New password" minLength={12} required />
          <input name="confirmPassword" type="password" autoComplete="new-password" placeholder="Confirm password" minLength={12} required />
          <input name="setupCode" type="password" autoComplete="off" placeholder="Private setup code" required />
          {error && <p className="form-error" role="alert">{error}</p>}
          {message && <p className="form-success" role="status">{message}</p>}
          <button type="submit" disabled={busy}>{busy ? "Saving..." : "Save password"}</button>
        </form>
      </section>
    </main>
  );
}
