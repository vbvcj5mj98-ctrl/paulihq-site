"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

export default function HqMenu({ current }: { current: string }) {
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  const [username, setUsername] = useState("");
  useEffect(() => { fetch("/api/me").then((response) => response.json()).then((result: { username?: string; permissions?: Record<string, boolean> }) => { setPermissions(result.permissions ?? {}); setUsername(result.username ?? ""); }).catch(() => undefined); }, []);
  const menuValue = current === "/profile" ? "/portal" : current;
  return (
    <div className="hq-user-menu">
      <label className="hq-menu">
        <span className="sr-only">Jump to</span>
        <select aria-label="Jump to another Pauli HQ tool" value={menuValue} onChange={(event) => window.location.assign(event.target.value)}>
          <option value="/portal">Home</option>
          {permissions.assistant && <option value="/assistant">Assistant</option>}
          {permissions.lists && <option value="/lists">Lists</option>}
          {permissions.properties && <option value="/properties">Property Finder</option>}
          <option value="/portfolio">Property Portfolio</option>
          {(permissions.user_management || current === "/admin/users") && <option value="/admin/users">User Management</option>}
        </select>
      </label>
      <span className="hq-username">{username}</span>
      <Link className={`hq-settings${current === "/profile" ? " active" : ""}`} href="/profile" aria-label="Profile settings" title="Profile settings">⚙</Link>
    </div>
  );
}
