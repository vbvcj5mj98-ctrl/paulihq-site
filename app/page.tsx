import Link from "next/link";

export default function Home() {
  return (
    <main className="photo-page">
      <div className="shade" />
      <header className="photo-header">
        <a className="name" href="#home" aria-label="Carson Pauli home">
          Pauli HQ
        </a>
        <Link className="login-link" href="/login">
          Log in
        </Link>
      </header>

      <section className="photo-content" id="home">
        <p className="kicker">Carson &amp; family</p>
        <h1>In progress.</h1>
        <p className="intro">
          Projects, ideas, and more to come.
        </p>
      </section>

      <footer className="photo-footer">
        <p>California</p>
        <p>© {new Date().getFullYear()}</p>
      </footer>
    </main>
  );
}
