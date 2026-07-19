import Link from "next/link";

export default function LoginPage() {
  return (
    <main className="login-page">
      <Link className="back-link" href="/" aria-label="Return home">
        &larr; Pauli HQ
      </Link>

      <section className="login-card">
        <p className="kicker">Private family access</p>
        <h1>Welcome home.</h1>
        <p className="login-note">
          Continue to Cloudflare&apos;s secure sign-in. Access is limited to the
          two approved family email addresses.
        </p>
        <Link className="secure-login" href="/portal">
          Continue to sign in
        </Link>
        <p className="login-help">
          Cloudflare will email you a temporary code. No password is stored by
          this website.
        </p>
      </section>
    </main>
  );
}
