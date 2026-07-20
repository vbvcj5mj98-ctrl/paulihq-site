"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const spaces = [
  { key: "properties", title: "Property Finder", description: "Search, filter, map, and analyze real-estate opportunities.", href: "/properties" },
  { key: "properties", title: "Parcel Scout", description: "Investigate an address or APN across public property records and listings.", href: "/parcel-scout" },
  { key: "portfolio", title: "Property Portfolio", description: "Manage owned properties, values, occupancy, sharing, and local weather.", href: "/portfolio" },
  { key: "lists", title: "Lists", description: "Shared projects, assignments, and grocery lists in one place.", href: "/lists" },
];

export default function PortalPage() {
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  const [username, setUsername] = useState("");
  const [ready, setReady] = useState(false);
  useEffect(() => { fetch("/api/me").then((response) => response.json()).then((result: { username?: string; permissions?: Record<string, boolean> }) => { setUsername(result.username ?? ""); setPermissions(result.permissions ?? {}); setReady(true); }).catch(() => setReady(true)); }, []);
  const visibleSpaces = [...spaces.filter((space) => space.key === "portfolio" || permissions[space.key]), ...(permissions.user_management ? [{ key: "user_management", title: "User Management", description: "Create accounts, reset passwords, and manage page access.", href: "/admin/users" }] : [])];
  const displayName = username === "carsonpauli" ? "Carson" : username === "jessipauli" ? "Jessi" : username;
  return (
    <main className="hq-page">
      <header className="hq-header">
        <Link className="pauli-logo-link" href="/" aria-label="Pauli HQ home"><img className="pauli-logo pauli-logo-portal" src="/paulihq-wordmark-earth.png" alt="Pauli HQ" /></Link>
        <div className="hq-actions">
          {displayName && <span>{displayName}</span>}
          <Link className="hq-settings" href="/profile" aria-label="Profile settings" title="Profile settings">⚙</Link>
          <form action="/api/logout" method="post">
            <button type="submit" className="text-button">Log out</button>
          </form>
        </div>
      </header>

      <div className="hq-main">
        <section className="hq-intro"><p>Private workspace</p><h1>Everything in one place.</h1><span>Secure access for the Pauli household.</span></section>
        <section className="hq-grid" aria-label="Pauli HQ spaces">
          {!ready ? <div className="hq-loading">Loading workspace…</div> : visibleSpaces.map((space, index) => (
            <Link className="hq-card" href={space.href} key={space.title}>
              <div className="hq-card-top"><small>{String(index + 1).padStart(2, "0")}</small><span>{space.key.replace("_", " ")}</span></div>
              <div><h2>{space.title}</h2><p>{space.description}</p></div>
              <b aria-hidden="true">↗</b>
            </Link>
          ))}
        </section>
        <footer className="hq-footer"><img src="/paulihq-wordmark-earth.png" alt="Pauli HQ" /><span>Private · Secure · Shared</span></footer>
      </div>
    </main>
  );
}
