"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

const spaces = [
  { key: "assistant", title: "Assistant", href: "/assistant" },
  { key: "lists", title: "Lists", href: "/lists" },
  { key: "properties", title: "Property Finder", href: "/properties" },
];

export default function PortalPage() {
  const [isAdmin, setIsAdmin] = useState(false);
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  useEffect(() => { fetch("/api/me").then((response) => response.json()).then((result: { isAdmin?: boolean; permissions?: Record<string, boolean> }) => { setIsAdmin(Boolean(result.isAdmin)); setPermissions(result.permissions ?? {}); }).catch(() => undefined); }, []);
  const visibleSpaces = [...spaces.filter((space) => permissions[space.key]), ...(isAdmin ? [{ key: "profile", title: "Profile", href: "/profile" }] : []), ...(permissions.user_management ? [{ key: "user_management", title: "User Management", href: "/admin/users" }] : [])];
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
        {visibleSpaces.map((space, index) => (
          <Link className="hq-card" href={space.href} key={space.title}>
            <small>{String(index + 1).padStart(2, "0")}</small>
            <h2>{space.title}</h2>
            <span aria-hidden="true">→</span>
          </Link>
        ))}
      </section>
    </main>
  );
}
