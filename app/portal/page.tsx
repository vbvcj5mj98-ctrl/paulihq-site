import Link from "next/link";

const spaces = [
  { title: "Assistant", href: "/assistant" },
  { title: "Lists", href: "/lists" },
  { title: "Property Finder", href: "/properties" },
];

export default function PortalPage() {
  return (
    <main className="hq-page">
      <header className="hq-header">
        <Link className="hq-mark" href="/">Pauli HQ</Link>
        <div className="hq-actions">
          <form action="/api/logout" method="post">
            <button type="submit" className="text-button">Log out</button>
          </form>
        </div>
      </header>

      <section className="hq-grid" aria-label="Pauli HQ spaces">
        {spaces.map((space) => (
          <Link className="hq-card" href={space.href} key={space.title}>
            <h2>{space.title}</h2>
            <span aria-hidden="true">→</span>
          </Link>
        ))}
      </section>
    </main>
  );
}
