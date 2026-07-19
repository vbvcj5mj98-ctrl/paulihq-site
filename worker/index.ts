import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: { input(stream: ReadableStream): { transform(options: Record<string, unknown>): { output(options: { format: string; quality: number }): Promise<{ response(): Response }> } } };
  SETUP_CODE?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  RENTCAST_API_KEY?: string;
}

interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; }
interface ScheduledController { scheduledTime: number; cron: string; noRetry(): void; }

const encoder = new TextEncoder();
const approvedUsers = new Set(["carsonpauli", "jessipauli"]);
const passwordHashIterations = 30_000;

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64ToBytes(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function secureEqual(left: Uint8Array, right: Uint8Array) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

async function passwordHash(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  // Keep this within the CPU allowance of Cloudflare's free Workers plan.
  // Unique salts, long passwords, and login throttling provide the other layers.
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: passwordHashIterations }, key, 256);
  return new Uint8Array(bits);
}

async function sha256(value: string) {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function ensureSchema(db: D1Database) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS login_attempts (username TEXT PRIMARY KEY, attempts INTEGER NOT NULL, last_attempt INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('user', 'assistant')), content TEXT NOT NULL, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS chat_messages_user_time_idx ON chat_messages (username, created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS workspace_items (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private' CHECK(visibility IN ('private', 'shared')), section TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS workspace_items_access_idx ON workspace_items (owner, visibility, section, updated_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS property_searches (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('primary', 'income')), label TEXT NOT NULL, city TEXT, state TEXT, zip_code TEXT, min_price INTEGER, max_price INTEGER, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS property_listings (source_id TEXT NOT NULL, search_id INTEGER NOT NULL, mode TEXT NOT NULL, address TEXT NOT NULL, city TEXT, state TEXT, zip_code TEXT, property_type TEXT, price INTEGER, bedrooms REAL, bathrooms REAL, square_feet INTEGER, lot_size INTEGER, days_on_market INTEGER, status TEXT, listed_at TEXT, source_url TEXT, raw_json TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, PRIMARY KEY (source_id, search_id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS property_listings_mode_seen_idx ON property_listings (mode, last_seen_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS list_items (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('project', 'grocery')), visibility TEXT NOT NULL DEFAULT 'shared' CHECK(visibility IN ('private', 'shared')), text TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, completed_at INTEGER)"),
    db.prepare("CREATE INDEX IF NOT EXISTS list_items_owner_kind_idx ON list_items (owner, kind, completed, created_at)"),
  ]);
}

function json(body: Record<string, unknown>, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function cookieValue(request: Request, name: string) {
  const found = request.headers.get("cookie")?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return found?.slice(name.length + 1) ?? "";
}

async function authenticated(request: Request, env: Env) {
  const token = cookieValue(request, "paulihq_session");
  if (!token) return null;
  const row = await env.DB.prepare("SELECT username FROM sessions WHERE token_hash = ? AND expires_at > ?").bind(await sha256(token), Date.now()).first<{ username: string }>();
  return row?.username ?? null;
}

function responseText(payload: { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }) {
  if (payload.output_text) return payload.output_text.trim();
  return (payload.output ?? []).flatMap((item) => item.content ?? []).filter((item) => item.type === "output_text").map((item) => item.text ?? "").join("\n").trim();
}

async function chatHistory(env: Env, username: string) {
  const result = await env.DB.prepare("SELECT role, content, created_at FROM chat_messages WHERE username = ? ORDER BY id DESC LIMIT 60").bind(username).all<{ role: string; content: string; created_at: number }>();
  return json({ messages: (result.results ?? []).reverse() });
}

async function chat(request: Request, env: Env, username: string) {
  if (!env.OPENAI_API_KEY) return json({ error: "The AI connection has not been added to Cloudflare yet." }, 503);
  const body = await request.json<{ message?: string }>();
  const message = String(body.message ?? "").trim();
  if (!message) return json({ error: "Please enter a message." }, 400);
  if (message.length > 8_000) return json({ error: "That message is too long." }, 400);

  const [historyResult, workspaceResult, listResult] = await Promise.all([
    env.DB.prepare("SELECT role, content FROM chat_messages WHERE username = ? ORDER BY id DESC LIMIT 24").bind(username).all<{ role: "user" | "assistant"; content: string }>(),
    env.DB.prepare("SELECT section, title, content, owner, visibility, updated_at FROM workspace_items WHERE owner = ? OR visibility = 'shared' ORDER BY updated_at DESC LIMIT 80").bind(username).all<{ section: string; title: string; content: string; owner: string; visibility: string; updated_at: number }>(),
    env.DB.prepare("SELECT kind, text, completed FROM list_items WHERE owner = ? OR visibility = 'shared' ORDER BY created_at DESC LIMIT 100").bind(username).all<{ kind: string; text: string; completed: number }>(),
  ]);
  const history = (historyResult.results ?? []).reverse();
  const workspace = workspaceResult.results ?? [];
  const workspaceContext = workspace.length
    ? workspace.map((item) => `[${item.section}] ${item.title}: ${item.content}`).join("\n")
    : "No saved Pauli HQ workspace items are available yet.";
  const listContext = (listResult.results ?? []).length
    ? (listResult.results ?? []).map((item) => `[${item.kind}] ${item.completed ? "completed" : "open"}: ${item.text}`).join("\n")
    : "No project or grocery list items are saved yet.";

  const openAIResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.6-terra",
      instructions: `You are the private Pauli HQ assistant for ${username}. Be practical, clear, and concise. You may answer general questions. You are also given authorized Pauli HQ workspace context from Projects, Documents, Property, Calendar, Tasks, Ideas, and Lists. Never claim you changed site data unless a tool explicitly confirms it. Distinguish saved workspace facts from general knowledge.\n\nAUTHORIZED WORKSPACE CONTEXT:\n${workspaceContext}\n\nAUTHORIZED LIST CONTEXT:\n${listContext}`,
      input: [...history, { role: "user", content: message }],
      tools: [{ type: "web_search" }],
    }),
  });
  const payload = await openAIResponse.json() as { error?: { message?: string }; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  if (!openAIResponse.ok) {
    console.error("OpenAI request failed", openAIResponse.status, payload.error?.message);
    return json({ error: openAIResponse.status === 401 ? "The OpenAI API key is not valid." : "The AI service could not answer right now." }, 502);
  }
  const answer = responseText(payload);
  if (!answer) return json({ error: "The AI service returned an empty answer." }, 502);
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO chat_messages (username, role, content, created_at) VALUES (?, 'user', ?, ?)").bind(username, message, now),
    env.DB.prepare("INSERT INTO chat_messages (username, role, content, created_at) VALUES (?, 'assistant', ?, ?)").bind(username, answer, now + 1),
  ]);
  return json({ answer });
}

async function listItems(request: Request, env: Env, username: string) {
  const url = new URL(request.url);
  const kind = url.searchParams.get("kind") === "grocery" ? "grocery" : "project";
  if (request.method === "GET") {
    const result = await env.DB.prepare("SELECT id, owner, text, completed, created_at FROM list_items WHERE kind = ? AND (owner = ? OR visibility = 'shared') ORDER BY completed ASC, created_at DESC").bind(kind, username).all();
    return json({ items: result.results ?? [] });
  }
  if (request.method === "POST") {
    const body = await request.json<{ text?: string; kind?: string }>();
    const itemKind = body.kind === "grocery" ? "grocery" : "project";
    const itemText = String(body.text ?? "").trim().slice(0, 500);
    if (!itemText) return json({ error: "Add an item first." }, 400);
    await env.DB.prepare("INSERT INTO list_items (owner, kind, visibility, text, completed, created_at) VALUES (?, ?, 'shared', ?, 0, ?)").bind(username, itemKind, itemText, Date.now()).run();
    return json({ ok: true }, 201);
  }
  return json({ error: "Method not allowed." }, 405);
}

async function updateListItem(request: Request, env: Env, username: string, id: number) {
  if (request.method !== "PATCH") return json({ error: "Method not allowed." }, 405);
  const body = await request.json<{ completed?: boolean }>();
  await env.DB.prepare("UPDATE list_items SET completed = ?, completed_at = ? WHERE id = ? AND (owner = ? OR visibility = 'shared')")
    .bind(body.completed ? 1 : 0, body.completed ? Date.now() : null, id, username).run();
  return json({ ok: true });
}

async function simplifyList(request: Request, env: Env, username: string) {
  if (!env.OPENAI_API_KEY) return json({ error: "The AI connection has not been added to Cloudflare yet." }, 503);
  const body = await request.json<{ kind?: string; input?: string }>();
  const kind = body.kind === "grocery" ? "grocery" : "project";
  const input = String(body.input ?? "").trim().slice(0, 4_000);
  if (!input) return json({ error: "Describe what you need first." }, 400);
  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.6-terra",
      instructions: kind === "grocery"
        ? "Convert the request into a concise grocery shopping list. Return one item per line, no bullets, headings, quantities you cannot infer, or commentary."
        : "Convert the request into a simple ordered action list. Each item must be a short, concrete, checkable task. Return one task per line, no bullets, headings, or commentary.",
      input,
    }),
  });
  const payload = await aiResponse.json() as { error?: { message?: string }; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  if (!aiResponse.ok) return json({ error: aiResponse.status === 401 ? "The OpenAI API key is not valid." : "The AI could not create the list right now." }, 502);
  const items = responseText(payload).split("\n").map((line) => line.replace(/^[-*\d.)\s]+/, "").trim()).filter(Boolean).slice(0, 30);
  if (!items.length) return json({ error: "The AI did not return any list items." }, 502);
  const now = Date.now();
  await env.DB.batch(items.map((item, index) => env.DB.prepare("INSERT INTO list_items (owner, kind, visibility, text, completed, created_at) VALUES (?, ?, 'shared', ?, 0, ?)").bind(username, kind, item.slice(0, 500), now + index)));
  return json({ items });
}

async function propertySearches(request: Request, env: Env, username: string) {
  if (request.method === "GET") {
    const result = await env.DB.prepare("SELECT id, mode, label, city, state, zip_code, min_price, max_price, active, created_at FROM property_searches WHERE owner = ? ORDER BY created_at DESC").bind(username).all();
    return json({ searches: result.results ?? [] });
  }
  const body = await request.json<{ mode?: string; label?: string; city?: string; state?: string; zipCode?: string; minPrice?: number; maxPrice?: number }>();
  const mode = body.mode === "income" ? "income" : "primary";
  const label = String(body.label ?? "").trim().slice(0, 80);
  const city = String(body.city ?? "").trim().slice(0, 80);
  const state = String(body.state ?? "").trim().toUpperCase().slice(0, 2);
  const zipCode = String(body.zipCode ?? "").trim().slice(0, 10);
  if (!label || (!zipCode && (!city || state.length !== 2))) return json({ error: "Add a name and either a ZIP code or city and two-letter state." }, 400);
  await env.DB.prepare("INSERT INTO property_searches (owner, mode, label, city, state, zip_code, min_price, max_price, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
    .bind(username, mode, label, city || null, state || null, zipCode || null, Number(body.minPrice) || null, Number(body.maxPrice) || null, Date.now()).run();
  return json({ ok: true }, 201);
}

async function propertyListings(request: Request, env: Env, username: string) {
  const mode = new URL(request.url).searchParams.get("mode") === "income" ? "income" : "primary";
  const result = await env.DB.prepare(`SELECT l.source_id, l.address, l.city, l.state, l.zip_code, l.property_type, l.price, l.bedrooms, l.bathrooms, l.square_feet, l.lot_size, l.days_on_market, l.status, l.listed_at, l.source_url, l.last_seen_at, s.label AS search_label
    FROM property_listings l JOIN property_searches s ON s.id = l.search_id WHERE s.owner = ? AND l.mode = ? ORDER BY l.last_seen_at DESC, l.price ASC LIMIT 250`).bind(username, mode).all();
  return json({ listings: result.results ?? [], sourceConnected: Boolean(env.RENTCAST_API_KEY) });
}

async function syncPropertyListings(env: Env) {
  if (!env.RENTCAST_API_KEY) return;
  await ensureSchema(env.DB);
  const searchResult = await env.DB.prepare("SELECT id, mode, city, state, zip_code, min_price, max_price FROM property_searches WHERE active = 1").all<{ id: number; mode: string; city: string | null; state: string | null; zip_code: string | null; min_price: number | null; max_price: number | null }>();
  for (const search of searchResult.results ?? []) {
    const params = new URLSearchParams({ limit: "100", status: "Active" });
    if (search.zip_code) params.set("zipCode", search.zip_code);
    else {
      if (search.city) params.set("city", search.city);
      if (search.state) params.set("state", search.state);
    }
    if (search.min_price) params.set("priceMin", String(search.min_price));
    if (search.max_price) params.set("priceMax", String(search.max_price));
    const response = await fetch(`https://api.rentcast.io/v1/listings/sale?${params}`, { headers: { "X-Api-Key": env.RENTCAST_API_KEY } });
    if (!response.ok) {
      console.error("Property feed request failed", search.id, response.status);
      continue;
    }
    const listings = await response.json() as Array<Record<string, unknown>>;
    const now = Date.now();
    for (const item of listings.slice(0, 100)) {
      const sourceId = String(item.id ?? "");
      const address = String(item.formattedAddress ?? "");
      if (!sourceId || !address) continue;
      await env.DB.prepare(`INSERT INTO property_listings (source_id, search_id, mode, address, city, state, zip_code, property_type, price, bedrooms, bathrooms, square_feet, lot_size, days_on_market, status, listed_at, source_url, raw_json, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, search_id) DO UPDATE SET price=excluded.price, days_on_market=excluded.days_on_market, status=excluded.status, raw_json=excluded.raw_json, last_seen_at=excluded.last_seen_at`)
        .bind(sourceId, search.id, search.mode, address, item.city ?? null, item.state ?? null, item.zipCode ?? null, item.propertyType ?? null, item.price ?? null, item.bedrooms ?? null, item.bathrooms ?? null, item.squareFootage ?? null, item.lotSize ?? null, item.daysOnMarket ?? null, item.status ?? null, item.listedDate ?? null, null, JSON.stringify(item), now, now).run();
    }
  }
}

async function setup(request: Request, env: Env) {
  if (!env.SETUP_CODE) return json({ error: "Setup is not enabled." }, 503);
  const body = await request.json<{ username?: string; password?: string; setupCode?: string }>();
  const username = String(body.username ?? "").toLowerCase();
  const password = String(body.password ?? "");
  const suppliedCode = encoder.encode(String(body.setupCode ?? ""));
  const expectedCode = encoder.encode(env.SETUP_CODE);
  if (!secureEqual(suppliedCode, expectedCode)) return json({ error: "Invalid setup code." }, 403);
  if (!approvedUsers.has(username)) return json({ error: "Username is not approved." }, 400);
  if (password.length < 12) return json({ error: "Use at least 12 characters." }, 400);
  const existing = await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(username).first();
  if (existing) return json({ error: "That account is already configured." }, 409);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await passwordHash(password, salt);
  await env.DB.prepare("INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)")
    .bind(username, bytesToBase64(hash), bytesToBase64(salt), Date.now()).run();
  return json({ ok: true });
}

async function login(request: Request, env: Env) {
  const body = await request.json<{ username?: string; password?: string }>();
  const username = String(body.username ?? "").toLowerCase();
  const password = String(body.password ?? "");
  const now = Date.now();
  const attempts = await env.DB.prepare("SELECT attempts, last_attempt FROM login_attempts WHERE username = ?").bind(username).first<{ attempts: number; last_attempt: number }>();
  if (attempts && attempts.attempts >= 8 && now - attempts.last_attempt < 15 * 60_000) return json({ error: "Too many attempts. Try again later." }, 429);
  const user = await env.DB.prepare("SELECT password_hash, salt FROM users WHERE username = ?").bind(username).first<{ password_hash: string; salt: string }>();
  const valid = user ? secureEqual(await passwordHash(password, base64ToBytes(user.salt)), base64ToBytes(user.password_hash)) : false;
  if (!valid) {
    await env.DB.prepare("INSERT INTO login_attempts (username, attempts, last_attempt) VALUES (?, 1, ?) ON CONFLICT(username) DO UPDATE SET attempts = CASE WHEN ? - last_attempt > 900000 THEN 1 ELSE attempts + 1 END, last_attempt = ?")
      .bind(username, now, now, now).run();
    return json({ error: "Incorrect username or password." }, 401);
  }
  await env.DB.prepare("DELETE FROM login_attempts WHERE username = ?").bind(username).run();
  const token = bytesToBase64(crypto.getRandomValues(new Uint8Array(32)));
  const expires = now + 30 * 24 * 60 * 60_000;
  await env.DB.prepare("INSERT INTO sessions (token_hash, username, expires_at) VALUES (?, ?, ?)").bind(await sha256(token), username, expires).run();
  return json({ ok: true }, 200, { "set-cookie": `paulihq_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000` });
}

async function logout(request: Request, env: Env) {
  const token = cookieValue(request, "paulihq_session");
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256(token)).run();
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL("/", request.url).toString(),
      "set-cookie": "paulihq_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    },
  });
}

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/portal")) {
      if (!env.DB) return json({ error: "The Cloudflare database binding is not connected." }, 503);
      try {
        await ensureSchema(env.DB);
      } catch (error) {
        console.error("D1 schema initialization failed", error);
        return json({ error: "The authentication database is connected but unavailable." }, 503);
      }
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      return json({ database: true, setupCode: Boolean(env.SETUP_CODE), ai: Boolean(env.OPENAI_API_KEY), schema: true });
    }
    try {
      if (request.method === "POST" && url.pathname === "/api/setup") return setup(request, env);
      if (request.method === "POST" && url.pathname === "/api/login") return login(request, env);
      if (request.method === "POST" && url.pathname === "/api/logout") return logout(request, env);
      if (url.pathname.startsWith("/api/chat")) {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        if (request.method === "GET") return chatHistory(env, username);
        if (request.method === "POST") return chat(request, env, username);
        return json({ error: "Method not allowed." }, 405);
      }
      if (url.pathname === "/api/property-searches" || url.pathname === "/api/properties") {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        if (url.pathname === "/api/property-searches") return propertySearches(request, env, username);
        if (request.method === "GET") return propertyListings(request, env, username);
        return json({ error: "Method not allowed." }, 405);
      }
      if (url.pathname === "/api/list-items" || url.pathname === "/api/lists/simplify" || url.pathname.startsWith("/api/list-items/")) {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        if (url.pathname === "/api/list-items") return listItems(request, env, username);
        if (url.pathname === "/api/lists/simplify" && request.method === "POST") return simplifyList(request, env, username);
        const id = Number(url.pathname.split("/").pop());
        if (!Number.isInteger(id)) return json({ error: "Invalid list item." }, 400);
        return updateListItem(request, env, username, id);
      }
      if ((url.pathname.startsWith("/portal") || url.pathname.startsWith("/assistant") || url.pathname.startsWith("/properties") || url.pathname.startsWith("/lists")) && !(await authenticated(request, env))) return Response.redirect(new URL("/login", request.url), 302);
    } catch (error) {
      console.error("Authentication request failed", error);
      return json({ error: "The authentication service encountered an error." }, 500);
    }
    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      return handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => (await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality })).response(),
      }, allowedWidths);
    }
    return handler.fetch(request, env, ctx);
  },
};

Object.assign(worker, {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(syncPropertyListings(env));
  },
});

export default worker;
