"use client";

export default function HqMenu({ current }: { current: string }) {
  return (
    <label className="hq-menu">
      <span className="sr-only">Jump to</span>
      <select aria-label="Jump to another Pauli HQ tool" value={current} onChange={(event) => window.location.assign(event.target.value)}>
        <option value="/portal">Pauli HQ</option>
        <option value="/assistant">Assistant</option>
        <option value="/lists">Lists</option>
        <option value="/properties">Property Finder</option>
      </select>
    </label>
  );
}
