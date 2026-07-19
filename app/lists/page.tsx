"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useState } from "react";
import HqMenu from "../HqMenu";

type Kind = "project" | "grocery";
type Item = { id: number; owner: string; text: string; completed: number; created_at: number };

type SpeechRecognitionInstance = { continuous: boolean; interimResults: boolean; lang: string; start(): void; stop(): void; onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

export default function ListsPage() {
  const [kind, setKind] = useState<Kind>("project");
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    const response = await fetch(`/api/list-items?kind=${kind}`);
    if (response.status === 401) return window.location.assign("/login");
    const result = await response.json() as { items?: Item[]; error?: string };
    if (!response.ok) throw new Error(result.error || "Unable to load the list.");
    setItems(result.items ?? []);
  }, [kind]);

  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab === "grocery") setKind("grocery");
  }, []);
  useEffect(() => { load().catch((reason: Error) => setError(reason.message)); }, [load]);

  async function simplify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!input.trim()) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/lists/simplify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, input }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Unable to create the list.");
      setInput("");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to create the list."); }
    finally { setBusy(false); }
  }

  async function toggle(item: Item) {
    await fetch(`/api/list-items/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ completed: !item.completed }) });
    setItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, completed: item.completed ? 0 : 1 } : entry));
  }

  function listen() {
    const speechWindow = window as typeof window & { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor };
    const Recognition = speechWindow.SpeechRecognition || speechWindow.webkitSpeechRecognition;
    if (!Recognition) return setError("Voice input is not supported in this browser. You can still type your request.");
    const recognition = new Recognition();
    recognition.continuous = false; recognition.interimResults = false; recognition.lang = "en-US";
    recognition.onresult = (event) => setInput((current) => `${current}${current ? " " : ""}${event.results[0][0].transcript}`);
    recognition.onend = () => setListening(false);
    recognition.onerror = () => { setListening(false); setError("I couldn't hear that clearly. Please try again."); };
    setListening(true); recognition.start();
  }

  return (
    <main className="lists-page">
      <header className="properties-header"><Link href="/portal">← Pauli HQ</Link><HqMenu current="/lists" /></header>
      <section className="lists-shell">
        <div className="lists-heading"><p className="kicker">AI-powered lists</p><h1>{kind === "project" ? "Turn plans into progress." : "Make shopping simple."}</h1></div>
        <nav className="property-tabs"><button className={kind === "project" ? "active" : ""} onClick={() => setKind("project")}>Projects</button><button className={kind === "grocery" ? "active" : ""} onClick={() => setKind("grocery")}>Grocery list</button></nav>
        <form className="list-capture" onSubmit={simplify}>
          <textarea value={input} onChange={(event) => setInput(event.target.value)} placeholder={kind === "project" ? "Describe what you want to accomplish..." : "Tell me what you need from the store..."} rows={4} />
          <div><button className={listening ? "listening" : ""} type="button" onClick={listen}>{listening ? "Listening…" : "● Speak"}</button><button type="submit" disabled={busy || !input.trim()}>{busy ? "Simplifying…" : "Create simple list"}</button></div>
        </form>
        {error && <p className="property-error" role="alert">{error}</p>}
        <section className="checklist" aria-label={kind === "project" ? "Project tasks" : "Grocery items"}>
          {items.length === 0 ? <p className="list-empty">Your shared list is ready for its first idea.</p> : items.map((item) => <label className={item.completed ? "complete" : ""} key={item.id}><input type="checkbox" checked={Boolean(item.completed)} onChange={() => toggle(item)} /><span>{item.text}<small>Added by {item.owner === "carsonpauli" ? "Carson" : "Jessica"}</small></span></label>)}
        </section>
      </section>
    </main>
  );
}
