"use client";

import Link from "next/link";

export default function AssistantError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <main className="feature-error"><h1>Assistant unavailable</h1><p>{error.message || "The page encountered a temporary problem."}</p>{error.digest && <small>Diagnostic: {error.digest}</small>}<div><button onClick={reset}>Try again</button><Link href="/portal">Return to Pauli HQ</Link></div></main>;
}
