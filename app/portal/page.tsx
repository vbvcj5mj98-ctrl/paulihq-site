import Link from "next/link";

const spaces = [
  { icon: "AI", title: "HQ Assistant", text: "Ask questions, organize plans, and turn ideas into action." },
  { icon: "01", title: "Projects", text: "Track active builds, ideas, decisions, and next steps." },
  { icon: "02", title: "Documents", text: "A searchable home for important files and family records." },
  { icon: "03", title: "Property", text: "Keep property notes, plans, maintenance, and opportunities together." },
  { icon: "04", title: "Calendar", text: "See shared events, deadlines, reminders, and upcoming work." },
  { icon: "05", title: "Ideas", text: "Capture possibilities now and let AI help develop them later." },
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
        <button type="button" className="ask-box" aria-label="AI assistant coming soon">
          <span>Ask Pauli HQ anything...</span>
          <strong>Coming soon</strong>
        </button>
      </section>

      <section className="hq-grid" aria-label="Pauli HQ spaces">
        {spaces.map((space) => (
          <article className={`hq-card ${space.icon === "AI" ? "featured" : ""}`} key={space.title}>
            <span className="card-icon">{space.icon}</span>
            <div>
              <h2>{space.title}</h2>
              <p>{space.text}</p>
            </div>
            <span className="card-status">Coming soon</span>
          </article>
        ))}
      </section>
    </main>
  );
}
