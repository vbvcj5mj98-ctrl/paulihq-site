import Link from "next/link";

export default function LoginPage() {
  return (
    <main className="login-page">
      <Link className="back-link" href="/" aria-label="Return home">
        &larr;
      </Link>

      <section className="login-card">
        <h1>Log in</h1>
        <form className="login-form">
          <label className="sr-only" htmlFor="username">Username</label>
          <input
            id="username"
            name="username"
            type="text"
            autoComplete="username"
            placeholder="Username"
          />
          <label className="sr-only" htmlFor="password">Password</label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            placeholder="Password"
          />
          <button type="button">Sign in</button>
        </form>
      </section>
    </main>
  );
}
