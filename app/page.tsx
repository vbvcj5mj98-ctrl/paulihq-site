import Link from "next/link";

export default function Home() {
  return (
    <main className="photo-page">
      <div className="shade" />
      <header className="photo-header">
        <span className="pauli-wordmark pauli-wordmark-home">PAULI HQ</span>
        <Link className="login-link" href="/login">
          Log in
        </Link>
      </header>
    </main>
  );
}
