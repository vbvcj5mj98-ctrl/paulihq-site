import Link from "next/link";

export default function HqHomeLink() {
  return (
    <Link className="hq-home-link" href="/portal" aria-label="Pauli HQ home">
      <img src="/paulihq-wordmark-earth.png" alt="Pauli HQ" />
    </Link>
  );
}
