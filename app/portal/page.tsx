import Link from "next/link";

const spaces = [
  { icon: "AI", title: "HQ Assistant", text: "Ask questions, organize plans, and work across everything in Pauli HQ.", href: "/assistant" },
  { icon: "01", title: "Projects & Lists", text: "Speak or type a plan and let AI turn it into simple, checkable steps.", href: "/lists" },
  { icon: "02", title: "Documents", text: "A searchable home for important files and family records." },
  { icon: "03", title: "Property Finder", text: "Track primary residences and analyze income-property opportunities.", href: "/properties" },
  { icon: "04", title: "Calendar", text: "See shared events, deadlines, reminders, and upcoming work." },
  { icon: "05", title: "Ideas", text: "Capture possibilities now and let AI help develop them later." },
  { icon: "06", title: "Grocery List", text: "Build and share an organized shopping list using voice or text.", href: "/lists?tab=grocery" },
];

export default function PortalPage() {
  return (
    <main className="hq-page">
      <header className="hq-header">
        <Link className="hq-mark" href="/">Pauli HQ</Link>
        <div className="hq-actions">
          <span>Private</span>
          <form action="/api/logout" method="post">
            <button type="submit" className="text-button">Log out</button>
          </form>
        </div>
      </header>

      <section className="hq-hero">
        <p className="kicker">Your private workspace</p>
        <h1>What should we work on?</h1>
        <Link href="/assistant" className="ask-box" aria-label="Open the Pauli HQ assistant">
          <span>Ask Pauli HQ anything...</span>
          <strong>Open assistant</strong>
        </Link>
      </section>

      <section className="hq-grid" aria-label="Pauli HQ spaces">
        {spaces.map((space) => (
          <article className={`hq-card ${space.icon === "AI" ? "featured" : ""}`} key={space.title}>
            <span className="card-icon">{space.icon}</span>
            <div>
              <h2>{space.title}</h2>
              <p>{space.text}</p>
            </div>
            {space.href ? <Link className="card-status card-link" href={space.href}>Open now →</Link> : <span className="card-status">Coming soon</span>}
          </article>
        ))}
      </section>
    </main>
  );
}
