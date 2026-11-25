"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const spaces = [
  { key: "lists", title: "Lists", description: "Projects, groceries, and shared tasks.", href: "/lists" },
  { key: "photo_drop", title: "Photo Drop", description: "Send encrypted files to the home PC and NAS.", href: "/photo-drop" },
  { key: "assistant", title: "Assistant", description: "Ask a question or continue a chat.", href: "/assistant" },
  { key: "properties", title: "Property Finder", description: "Browse and save listings.", href: "/properties" },
  { key: "properties", title: "Parcel Scout", description: "Look up an address or parcel number.", href: "/parcel-scout" },
  { key: "portfolio", title: "Property Portfolio", description: "Manage the properties you own.", href: "/portfolio" },
];

export default function PortalPage() {
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  const [username, setUsername] = useState("");
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/me", { signal: controller.signal }).then(async (response) => {
      if (response.status === 401) { window.location.replace("/login"); return; }
      if (!response.ok) throw new Error("Unable to load workspace.");
      const result = await response.json() as { username?: string; permissions?: Record<string, boolean> };
      setUsername(result.username ?? ""); setPermissions(result.permissions ?? {}); setReady(true);
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, []);
  const visibleSpaces = [...spaces.filter((space) => space.key === "portfolio" || permissions[space.key]), ...(permissions.user_management ? [{ key: "user_management", title: "User Management", description: "Create accounts, reset passwords, and manage page access.", href: "/admin/users" }] : [])];
  const displayName = username === "carsonpauli" ? "Carson" : username === "jessipauli" ? "Jessi" : username;
  return (
    <main className="hq-page">
      <header className="hq-header">
        <Link className="pauli-logo-link" href="/portal" aria-label="Pauli HQ home"><img className="pauli-logo pauli-logo-portal" src="/paulihq-wordmark-earth.png" alt="Pauli HQ" /></Link>
        <div className="hq-actions">
          {displayName && <span>{displayName}</span>}
          <Link className="hq-settings" href="/profile" aria-label="Profile settings" title="Profile settings">⚙</Link>
          <form action="/api/logout" method="post">
            <button type="submit" className="text-button">Log out</button>
          </form>
        </div>
      </header>

      <div className="hq-main">
        <section className="hq-intro"><h1>Tools</h1></section>
        <section className="hq-grid" aria-label="Pauli HQ spaces">
          {failed ? <div className="hq-loading" role="alert">Couldn’t load your tools. <button className="text-button" onClick={() => window.location.reload()}>Try again</button></div> : !ready ? <div className="hq-loading" role="status">Loading workspace…</div> : visibleSpaces.map((space) => (
            <Link className="hq-card" href={space.href} key={space.title}>
              <div><h2>{space.title}</h2><p>{space.description}</p></div>
            </Link>
          ))}
        </section>
      </div>
    </main>
  );
}
