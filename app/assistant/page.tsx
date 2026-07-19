"use client";

import Link from "next/link";
import { FormEvent, useEffect, useRef, useState } from "react";
import HqMenu from "../HqMenu";

type Message = { role: "user" | "assistant"; content: string; created_at?: number };

export default function AssistantPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const suggestedPrompt = new URLSearchParams(window.location.search).get("prompt");
    if (suggestedPrompt) setDraft(suggestedPrompt);
    fetch("/api/chat").then(async (response) => {
      if (response.status === 401) return window.location.assign("/login");
      const result = await response.json() as { messages?: Message[]; error?: string };
      if (!response.ok) throw new Error(result.error || "Unable to load the conversation.");
      setMessages(result.messages ?? []);
    }).catch((reason: Error) => setError(reason.message));
  }, []);

  useEffect(() => {
    const marker = endRef.current;
    if (marker && typeof marker.scrollIntoView === "function") marker.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || busy) return;
    setDraft("");
    setError("");
    setBusy(true);
    setMessages((current) => [...current, { role: "user", content: message }]);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const result = await response.json() as { answer?: string; error?: string };
      if (response.status === 401) return window.location.assign("/login");
      if (!response.ok || !result.answer) throw new Error(result.error || "Unable to get an answer.");
      setMessages((current) => [...current, { role: "assistant", content: result.answer! }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to get an answer.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="assistant-page">
      <header className="assistant-header">
        <Link href="/portal" className="assistant-back">← Pauli HQ</Link>
        <HqMenu current="/assistant" />
      </header>

      <section className="chat-shell">
        <div className="chat-heading">
          <p className="kicker">Pauli HQ AI</p>
          <h1>How can I help?</h1>
          <p>Ask a general question or work with anything saved across your HQ.</p>
        </div>

        <div className="chat-messages" aria-live="polite">
          {messages.length === 0 && !busy && (
            <div className="chat-starters">
              <button onClick={() => setDraft("Help me organize the priorities for this week.")}>Plan this week</button>
              <button onClick={() => setDraft("Help me develop a new project idea.")}>Develop an idea</button>
              <button onClick={() => setDraft("What can you help Carson and Jessica manage in Pauli HQ?")}>Explore Pauli HQ</button>
            </div>
          )}
          {messages.map((message, index) => (
            <article className={`chat-message ${message.role}`} key={`${message.role}-${index}`}>
              <span>{message.role === "user" ? "You" : "HQ"}</span>
              <p>{message.content}</p>
            </article>
          ))}
          {busy && <div className="chat-thinking"><i /><i /><i /><span className="sr-only">Assistant is thinking</span></div>}
          {error && <p className="chat-error" role="alert">{error}</p>}
          <div ref={endRef} />
        </div>

        <form className="chat-composer" onSubmit={send}>
          <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }} placeholder="Ask Pauli HQ anything..." aria-label="Message Pauli HQ" rows={1} maxLength={8000} />
          <button type="submit" disabled={busy || !draft.trim()} aria-label="Send message">↑</button>
          <small>AI can make mistakes. Verify important information.</small>
        </form>
      </section>
    </main>
  );
}
