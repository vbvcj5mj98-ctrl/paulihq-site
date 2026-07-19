import Link from "next/link";

export default function PortalPage() {
  return (
    <main className="portal-page">
      <header className="portal-header">
        <Link className="name" href="/">Pauli HQ</Link>
        <a className="logout-link" href="/cdn-cgi/access/logout">Log out</a>
      </header>
      <section className="portal-content">
        <p className="kicker">Private space</p>
        <h1>Welcome to Pauli HQ.</h1>
        <p>
          This secure area is ready. We can add family documents, projects,
          calendars, property information, or anything else you want next.
        </p>
      </section>
    </main>
  );
}
