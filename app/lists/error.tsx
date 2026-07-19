"use client";

import Link from "next/link";

export default function ListsError({ reset }: { error: Error; reset: () => void }) {
  return <main className="feature-error"><h1>Lists unavailable</h1><p>The page encountered a temporary problem.</p><div><button onClick={reset}>Try again</button><Link href="/portal">Return to Pauli HQ</Link></div></main>;
}
