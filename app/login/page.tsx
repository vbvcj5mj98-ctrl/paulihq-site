import Link from "next/link";

export default function LoginPage() {
  return (
    <main className="login-page">
      <Link className="back-link" href="/" aria-label="Return home">
        ← Carson Pauli
      </Link>

      <section className="login-card">
        <p className="kicker">Private access</p>
        <h1>Log in</h1>
        <p className="login-note">
          This space is reserved for a future private portal. Access is not
          enabled yet.
        </p>

        <form className="login-form">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="email" disabled />
          <label htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" disabled />
          <button type="button" disabled>Coming soon</button>
        </form>
      </section>
    </main>
  );
}
