"use client";

import { useEffect, useState } from "react";

export default function HqMenu({ current }: { current: string }) {
  const [permissions, setPermissions] = useState<Record<string, boolean>>({});
  useEffect(() => { fetch("/api/me").then((response) => response.json()).then((result: { permissions?: Record<string, boolean> }) => setPermissions(result.permissions ?? {})).catch(() => undefined); }, []);
  return (
    <label className="hq-menu">
      <span className="sr-only">Jump to</span>
      <select aria-label="Jump to another Pauli HQ tool" value={current} onChange={(event) => window.location.assign(event.target.value)}>
        <option value="/portal">Home</option>
        {permissions.assistant && <option value="/assistant">Assistant</option>}
        {permissions.lists && <option value="/lists">Lists</option>}
        {permissions.properties && <option value="/properties">Property Finder</option>}
        <option value="/portfolio">Property Portfolio</option>
        {current === "/profile" && <option value="/profile">Profile</option>}
        {(permissions.user_management || current === "/admin/users") && <option value="/admin/users">User Management</option>}
      </select>
    </label>
  );
}
