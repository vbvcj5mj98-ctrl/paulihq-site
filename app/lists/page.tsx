"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import HqMenu from "../HqMenu";
import HqHomeLink from "../HqHomeLink";

type Kind = "project" | "grocery";
type Assignee = "shared" | "carsonpauli" | "jessipauli";
type Item = { id: number; owner: string; assignee: Assignee; text: string; completed: number; created_at: number };

type SpeechRecognitionInstance = { continuous: boolean; interimResults: boolean; lang: string; start(): void; stop(): void; onresult: ((event: { results: ArrayLike<{ 0: { transcript: string } }> }) => void) | null; onend: (() => void) | null; onerror: (() => void) | null };
type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

export default function ListsPage() {
  const [kind, setKind] = useState<Kind>("project");
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [assignee, setAssignee] = useState<Assignee>("shared");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const activeKind = useRef(kind);
  activeKind.current = kind;

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch(`/api/list-items?kind=${kind}`, { signal });
    if (response.status === 401) return window.location.assign("/login");
    const result = await response.json() as { items?: Item[]; error?: string };
    if (!response.ok) throw new Error(result.error || "Unable to load the list.");
    if (kind === activeKind.current && !signal?.aborted) setItems(result.items ?? []);
  }, [kind]);

  useEffect(() => {
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab === "grocery") setKind("grocery");
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadFailed(false); setError("");
    load(controller.signal).catch((reason: Error) => {
      if (!controller.signal.aborted) { setError(reason.message); setLoadFailed(true); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [load]);

  async function add(useAI: boolean) {
    if (busy || !input.trim()) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(useAI ? "/api/lists/simplify" : "/api/list-items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(useAI ? { kind, input, assignee } : { kind, texts: input.split(/\r?\n/).map((line) => line.trim()).filter(Boolean), assignee }) });
      if (response.status === 401) { window.location.assign("/login"); return; }
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "Unable to create the list.");
      setInput("");
      try { await load(); setLoadFailed(false); }
      catch { setError("Saved, but we couldn’t refresh. Reload to see your new items."); }
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to create the list."); }
    finally { setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void add(false); }

  async function toggle(item: Item) {
    setItems((current) => current.filter((entry) => entry.id !== item.id));
    try {
      const response = await fetch(`/api/list-items/${item.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ completed: true }) });
      if (response.status === 401) { window.location.assign("/login"); return; }
      if (!response.ok) throw new Error();
    } catch {
      if (kind !== activeKind.current) return;
      setItems((current) => current.some((entry) => entry.id === item.id) ? current : [...current, item].sort((a, b) => b.created_at - a.created_at));
      setError("Couldn’t confirm that change. The item is back in your list.");
    }
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
    try { recognition.start(); setListening(true); }
    catch { setListening(false); setError("Voice input couldn’t start. You can still type."); }
  }

  return (
    <main className="lists-page">
      <header className="properties-header"><HqHomeLink /><HqMenu current="/lists" /></header>
      <section className="lists-shell">
        <div className="lists-heading"><h1>Lists</h1></div>
        <nav className="property-tabs" aria-label="List type"><button className={kind === "project" ? "active" : ""} aria-pressed={kind === "project"} disabled={busy} onClick={() => setKind("project")}>Projects</button><button className={kind === "grocery" ? "active" : ""} aria-pressed={kind === "grocery"} disabled={busy} onClick={() => setKind("grocery")}>Grocery list</button></nav>
        <form className="list-capture" onSubmit={submit}>
          <textarea aria-label="New list items" value={input} onChange={(event) => setInput(event.target.value)} placeholder={kind === "project" ? "Add a task. Use a new line for each task." : "Add groceries. Use a new line for each item."} rows={3} maxLength={4000} disabled={busy} />
          <div className="list-controls"><label>For <select value={assignee} disabled={busy} onChange={(event) => setAssignee(event.target.value as Assignee)}><option value="shared">Shared</option><option value="carsonpauli">Carson</option><option value="jessipauli">Jessi</option></select></label><span><button className={listening ? "listening" : ""} type="button" onClick={listen} disabled={busy || listening}>{listening ? "Listening…" : "Speak"}</button><button type="button" onClick={() => void add(true)} disabled={busy || !input.trim()}>Clean up with AI</button><button type="submit" disabled={busy || !input.trim()}>{busy ? "Saving…" : "Add items"}</button></span></div>
        </form>
        {error && <p className="property-error" role="alert">{error}</p>}
        <section className="checklist" aria-label={kind === "project" ? "Project tasks" : "Grocery items"}>
          {loading ? <p className="list-empty" role="status">Loading list…</p> : loadFailed ? <button className="text-button" type="button" onClick={() => window.location.reload()}>Reload list</button> : items.length === 0 ? <p className="list-empty">No items yet.</p> : items.map((item) => <label key={item.id}><input type="checkbox" checked={false} onChange={() => void toggle(item)} /><span>{item.text}<small>For {item.assignee === "shared" ? "Carson + Jessi" : item.assignee === "carsonpauli" ? "Carson" : "Jessi"} · added by {item.owner === "carsonpauli" ? "Carson" : item.owner === "jessipauli" ? "Jessi" : item.owner}</small></span></label>)}
        </section>
      </section>
    </main>
  );
}
