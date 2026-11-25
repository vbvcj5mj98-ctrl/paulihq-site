"use client";

import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";

export type AddressSuggestion = { placeId: string; text: string };

type Props = {
  label: string;
  className?: string;
  fieldClassName?: string;
  name?: string;
  value: string;
  placeholder: string;
  required?: boolean;
  onChange: (value: string) => void;
  onSelect: (suggestion: AddressSuggestion, sessionToken?: string) => void;
};

type Query = { input: string; revision: number };
type Result =
  | { state: "idle" | "loading" | "empty" }
  | { state: "error"; message: string }
  | { state: "ready"; suggestions: AddressSuggestion[] };

const fallbackMessage = "Address suggestions are unavailable.";

function createSessionToken() {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  if (typeof crypto?.getRandomValues !== "function") return undefined;
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isSuggestion(value: unknown): value is AddressSuggestion {
  if (!value || typeof value !== "object") return false;
  const suggestion = value as Partial<AddressSuggestion>;
  return typeof suggestion.placeId === "string" && Boolean(suggestion.placeId.trim()) &&
    typeof suggestion.text === "string" && Boolean(suggestion.text.trim());
}

export default function AddressAutocomplete({ label, className, fieldClassName, name, value, placeholder, required, onChange, onSelect }: Props) {
  const id = useId();
  const [query, setQuery] = useState<Query | null>(null);
  const [result, setResult] = useState<Result>({ state: "idle" });
  const [activeIndex, setActiveIndex] = useState(-1);
  const revision = useRef(0);
  const token = useRef<string | undefined>(undefined);
  const pending = useRef<AbortController | null>(null);

  function close() {
    revision.current++;
    pending.current?.abort();
    token.current = undefined;
    setQuery(null);
    setResult({ state: "idle" });
    setActiveIndex(-1);
  }

  function edit(input: string) {
    pending.current?.abort();
    const nextRevision = ++revision.current;
    if (!input.trim()) token.current = undefined;
    setActiveIndex(-1);
    setQuery(input.trim().length >= 4 ? { input, revision: nextRevision } : null);
    setResult({ state: "idle" });
    onChange(input);
  }

  useEffect(() => {
    if (!query || query.input !== value) return;
    const controller = new AbortController();
    pending.current = controller;
    let timeout: number | undefined;
    const current = () => !controller.signal.aborted && query.revision === revision.current;
    const debounce = window.setTimeout(async () => {
      if (!current()) return;
      setResult({ state: "loading" });
      token.current ??= createSessionToken();
      timeout = window.setTimeout(() => {
        if (!current()) return;
        controller.abort();
        setResult({ state: "error", message: "Address suggestions timed out." });
      }, 8_000);
      try {
        const response = await fetch("/api/address-autocomplete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: query.input, sessionToken: token.current }),
          signal: controller.signal,
        });
        const payload = await response.json().catch(() => null) as { suggestions?: unknown; error?: string } | null;
        if (!current()) return;
        if (!response.ok || !Array.isArray(payload?.suggestions)) {
          setResult({ state: "error", message: response.status === 401 ? "Sign in again to use address suggestions." :
            typeof payload?.error === "string" && payload.error.trim() ? payload.error.trim() : fallbackMessage });
          return;
        }
        const suggestions = payload.suggestions.filter(isSuggestion).slice(0, 8);
        setResult(suggestions.length ? { state: "ready", suggestions } : { state: "empty" });
      } catch {
        if (current()) setResult({ state: "error", message: fallbackMessage });
      } finally {
        window.clearTimeout(timeout);
      }
    }, 350);
    return () => {
      window.clearTimeout(debounce);
      window.clearTimeout(timeout);
      controller.abort();
      if (pending.current === controller) pending.current = null;
    };
  }, [query, value]);

  const visible = query?.input === value;
  const suggestions = visible && result.state === "ready" ? result.suggestions : [];
  const expanded = suggestions.length > 0;
  const status = !visible ? "" : result.state === "loading" ? "Looking up addresses…" :
    result.state === "empty" ? "No matching addresses. You can type the full address." :
    result.state === "error" ? `${result.message} You can still type the full address.` : "";

  function choose(suggestion: AddressSuggestion) {
    const sessionToken = token.current;
    close();
    onSelect(suggestion, sessionToken);
  }

  function handleKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape" && query) { event.preventDefault(); close(); return; }
    if (!expanded) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((index) => index < 0 ? (direction > 0 ? 0 : suggestions.length - 1) : (index + direction + suggestions.length) % suggestions.length);
    }
    if (event.key === "Enter") {
      if (activeIndex < 0 || !suggestions[activeIndex]) { close(); return; }
      event.preventDefault();
      choose(suggestions[activeIndex]);
    }
  }

  return <div className={className}>
    <label htmlFor={id}>{label}</label>
    <div className={fieldClassName}>
      <input id={id} name={name} value={value} placeholder={placeholder} required={required} autoComplete="off"
        role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? `${id}-list` : undefined}
        aria-activedescendant={expanded && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
        aria-describedby={status ? `${id}-status` : undefined}
        onChange={(event) => edit(event.target.value)} onKeyDown={handleKey} onBlur={close} />
      {expanded && <div className="address-suggestions">
        <div role="listbox" id={`${id}-list`} aria-label="Address suggestions">
          {suggestions.map((suggestion, index) => <button key={suggestion.placeId} type="button" tabIndex={-1} role="option"
            id={`${id}-option-${index}`} aria-selected={index === activeIndex}
            onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(suggestion)}>
            {suggestion.text}
          </button>)}
        </div>
        <img src="https://maps.gstatic.com/mapfiles/api-3/images/powered-by-google-on-white3.png" alt="Powered by Google" />
      </div>}
    </div>
    {status && <small id={`${id}-status`} className="address-suggestion-status" role="status">{status}</small>}
  </div>;
}
