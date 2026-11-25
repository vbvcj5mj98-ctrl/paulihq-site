"use client";

import { useCallback, useEffect, useState } from "react";
import HqHomeLink from "../HqHomeLink";
import HqMenu from "../HqMenu";
import { encryptFile, MAX_FILE_BYTES, recipientFingerprint } from "./packet";

const pairingKey = "pauli-photo-drop-recipient-v1";
const statuses: Record<string, string> = { queued: "Waiting for PC", on_pc: "Received on PC", backed_up: "NAS backup verified", expired: "Queue expired" };
type Item = { id: string; status: string; bytes: number; createdAt: number; expiresAt: number };
type Queue = { configured: boolean; recipient?: string; items?: Item[]; error?: string };
type Selection = { id: string; file: File; status: string; packet?: Blob; digest?: string };

function message(reason: unknown) {
  return reason instanceof Error ? reason.message : "Something went wrong. Try again.";
}

export default function PhotoDropPage() {
  const [queue, setQueue] = useState<Queue>();
  const [selected, setSelected] = useState<Selection[]>([]);
  const [pinned, setPinned] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/photo-drop", { signal, cache: "no-store" });
    if (response.status === 401) { window.location.assign("/login"); return; }
    const data = await response.json() as Queue;
    if (!response.ok) throw new Error(data.error ?? "Couldn’t load Photo Drop.");
    setQueue(data);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    try { setPinned(localStorage.getItem(pairingKey) ?? ""); }
    catch { setError("This browser can’t save your PC pairing. Enable local site storage to upload."); }
    load(controller.signal).catch((reason) => { if (!controller.signal.aborted) setError(message(reason)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    const timer = window.setInterval(() => {
      if (!document.hidden) void load(controller.signal).catch(() => undefined);
    }, 45000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [load]);

  const paired = Boolean(pinned && pinned === queue?.recipient);

  async function pair() {
    if (!queue?.recipient) return;
    setError("");
    try {
      if (code.trim().toLowerCase() !== await recipientFingerprint(queue.recipient)) {
        throw new Error("That code doesn’t match the home PC. Check it before pairing.");
      }
      localStorage.setItem(pairingKey, queue.recipient);
      setPinned(queue.recipient);
      setCode("");
    } catch (reason) { setError(message(reason)); }
  }

  async function refresh() {
    setError("");
    setLoading(true);
    try { await load(); }
    catch (reason) { setError(message(reason)); }
    finally { setLoading(false); }
  }

  function choose(files: FileList | null) {
    if (!files) return;
    const valid = Array.from(files).filter((file) => file.size > 0 && file.size <= MAX_FILE_BYTES);
    const slots = 20 - selected.filter((item) => item.status !== "Queued").length;
    setError(valid.length < files.length ? "Empty files and files over 25 MB were skipped." : valid.length > slots ? "Choose up to 20 files at a time." : "");
    setSelected((current) => [...current.filter((item) => item.status !== "Queued"), ...valid.slice(0, slots).map((file) => ({ id: crypto.randomUUID(), file, status: "Ready" }))]);
  }

  async function send() {
    const recipient = queue?.recipient;
    if (busy || !paired || !recipient) return;
    setBusy(true);
    setError("");
    let failures = 0;
    function update(id: string, change: Partial<Selection>) {
      setSelected((current) => current.map((item) => item.id === id ? { ...item, ...change } : item));
    }
    for (const item of selected.filter((entry) => entry.status !== "Queued")) {
      try {
        update(item.id, { status: "Encrypting…" });
        const packet = item.packet ?? await encryptFile(item.file, recipient);
        const digest = item.digest ?? Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await packet.arrayBuffer())), (byte) => byte.toString(16).padStart(2, "0")).join("");
        update(item.id, { status: "Uploading…", packet, digest });
        const response = await fetch("/api/photo-drop", { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-Photo-Drop-Upload-Id": item.id, "X-Photo-Drop-SHA256": digest }, body: packet });
        if (response.status === 401) throw new Error("Your session ended. Sign in again before uploading.");
        const result = await response.json() as { error?: string; id?: string; status?: string };
        if (response.status === 410) update(item.id, { id: crypto.randomUUID(), status: "Needs retry", packet: undefined, digest: undefined });
        if (!response.ok) throw new Error(result.error ?? "Couldn’t queue this file.");
        if (!result.id || !["queued", "on_pc", "backed_up"].includes(result.status ?? "")) throw new Error("Couldn’t confirm the upload. Retry to check the same file.");
        update(item.id, { status: "Queued", packet: undefined, digest: undefined });
      } catch (reason) {
        failures++;
        update(item.id, { status: "Needs retry" });
        setError(message(reason));
      }
    }
    try { await load(); }
    catch (reason) { if (!failures) setError(`Your upload was accepted, but the queue couldn’t refresh. ${message(reason)}`); }
    finally { setBusy(false); }
  }

  return (
    <main className="lists-page">
      <header className="properties-header"><HqHomeLink /><HqMenu current="/photo-drop" /></header>
      <section className="lists-shell drop-shell">
        <h1>Photo Drop</h1>
        <p>Send photos and files to the home PC. Files are encrypted before upload, and the PC makes a verified copy on the NAS.</p>
        {error && <p className="property-error" role="alert">{error}</p>}
        {!queue?.configured && <div className="drop-panel"><p>{loading ? "Checking the queue…" : queue ? "Photo Drop isn’t set up yet. The home PC and private queue need to be connected before uploads are available." : "The queue is unavailable."}</p>{!loading && <button onClick={refresh} type="button">Check again</button>}</div>}
        {queue?.configured && !paired && <form className="drop-panel" onSubmit={(event) => { event.preventDefault(); void pair(); }}>
          <h2>Pair with the home PC</h2>
          <p>{pinned ? "The home PC’s encryption key changed. Uploads are paused until you verify its new pairing code." : "Enter the 16-character pairing code shown on the PC to verify where your files will go."}</p>
          <label htmlFor="drop-pair">PC pairing code</label>
          <div className="drop-actions"><input id="drop-pair" value={code} maxLength={16} autoCapitalize="off" autoComplete="off" spellCheck={false} onChange={(event) => setCode(event.target.value)} /><button type="submit" disabled={!/^[a-f0-9]{16}$/i.test(code.trim())}>Pair this browser</button></div>
        </form>}
        {paired && <div className="drop-panel">
          <h2>Upload files</h2>
          <p>Up to 20 photos or files per batch, 25 MB each. Keep this page open until they’re queued.</p>
          <label htmlFor="drop-files" className="sr-only">Choose photos or files</label>
          <input id="drop-files" type="file" multiple disabled={busy} onChange={(event) => { choose(event.target.files); event.target.value = ""; }} />
          {selected.length > 0 && <ul className="drop-items" aria-label="Selected files" aria-live="polite">{selected.map(({ id, file, status }) => <li key={id}><span className="drop-name">{file.name}</span><strong>{status}</strong></li>)}</ul>}
          <div className="drop-actions"><button type="button" disabled={busy || selected.every((item) => item.status === "Queued")} onClick={() => void send()}>{busy ? "Sending…" : selected.some((item) => item.status === "Needs retry") ? "Retry files" : "Encrypt and upload"}</button>{selected.length > 0 && <button type="button" className="drop-secondary" disabled={busy} onClick={() => setSelected([])}>Clear selection</button>}</div>
        </div>}
        {queue?.configured && <div className="drop-panel">
          <div className="drop-heading"><h2>Recent uploads</h2><button type="button" className="drop-secondary" disabled={loading} onClick={() => void refresh()}>Refresh</button></div>
          {(queue.items ?? []).length ? <ul className="drop-items">{queue.items?.map((item) => <li key={item.id}><span>{new Date(item.createdAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}{item.status === "queued" && <small>Queue expires {new Date(item.expiresAt).toLocaleDateString()}</small>}</span><strong>{statuses[item.status] ?? "Pending"}</strong></li>)}</ul> : <p>No uploads yet.</p>}
        </div>}
      </section>
    </main>
  );
}
