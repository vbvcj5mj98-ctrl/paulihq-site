import Link from "next/link";

export default function Home() {
  return (
    <main className="photo-page">
      <div className="shade" />
      <header className="photo-header">
        <img className="pauli-logo pauli-logo-home" src="/paulihq-wordmark-earth.png" alt="Pauli HQ" />
        <Link className="login-link" href="/login">
          Log in
        </Link>
      </header>
    </main>
  );
}
