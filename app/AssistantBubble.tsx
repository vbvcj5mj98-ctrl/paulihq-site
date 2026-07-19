"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

type Message = { role: "user" | "assistant"; content: string };

export default function AssistantBubble() {
  const pathname = usePathname();
  const [available, setAvailable] = useState(false);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (["/", "/login", "/setup", "/assistant"].includes(pathname)) return setAvailable(false);
    fetch("/api/me").then(async (response) => {
      if (!response.ok) return setAvailable(false);
      const result = await response.json() as { permissions?: Record<string, boolean> };
      setAvailable(Boolean(result.permissions?.assistant));
    }).catch(() => setAvailable(false));
  }, [pathname]);

  useEffect(() => {
    const show = (event: Event) => {
      const prompt = (event as CustomEvent<{ prompt?: string }>).detail?.prompt;
      if (prompt) setDraft(prompt);
      setOpen(true);
    };
    window.addEventListener("open-pauli-assistant", show);
    return () => window.removeEventListener("open-pauli-assistant", show);
  }, []);

  useEffect(() => {
    if (!open || loaded) return;
    fetch("/api/chat").then(async (response) => {
      const result = await response.json() as { messages?: Message[]; error?: string };
      if (!response.ok) throw new Error(result.error || "Unable to load the assistant.");
      setMessages(result.messages ?? []); setLoaded(true);
    }).catch((reason: Error) => setError(reason.message));
  }, [loaded, open]);

  useEffect(() => { if (open) endRef.current?.scrollIntoView({ block: "end" }); }, [messages, busy, open]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;
    setDraft(""); setError(""); setBusy(true);
    setMessages((current) => [...current, { role: "user", content: message }]);
    try {
      const response = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) });
      const result = await response.json() as { answer?: string; error?: string };
      if (!response.ok || !result.answer) throw new Error(result.error || "Assistant unavailable.");
      setMessages((current) => [...current, { role: "assistant", content: result.answer! }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Assistant unavailable.");
    } finally { setBusy(false); }
  }

  if (!available) return null;
  return <aside className={`assistant-bubble${open ? " open" : ""}`}>
    {open && <section className="assistant-popover" role="dialog" aria-label="Pauli HQ Assistant">
      <header><div><small>PAULI HQ</small><strong>Assistant</strong></div><button onClick={() => setOpen(false)} aria-label="Close assistant">×</button></header>
      <div className="assistant-popover-messages" aria-live="polite">
        {!messages.length && !busy && <p className="assistant-popover-empty">Ask a question or work with anything saved in Pauli HQ.</p>}
        {messages.map((message, index) => <article className={message.role} key={`${message.role}-${index}`}><small>{message.role === "user" ? "You" : "HQ"}</small><p>{message.content}</p></article>)}
        {busy && <div className="assistant-popover-thinking"><i /><i /><i /><span className="sr-only">Assistant is thinking</span></div>}
        {error && <p className="assistant-popover-error" role="alert">{error}</p>}
        <div ref={endRef} />
      </div>
      <form onSubmit={send}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Ask Pauli HQ…" aria-label="Message Pauli HQ" rows={1} maxLength={8000} /><button type="submit" disabled={busy || !draft.trim()} aria-label="Send message">↑</button></form>
    </section>}
    <button className="assistant-launcher" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={open ? "Close Pauli HQ Assistant" : "Open Pauli HQ Assistant"}><span>{open ? "×" : "HQ"}</span></button>
  </aside>;
}
