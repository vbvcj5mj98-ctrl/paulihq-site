import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: { input(stream: ReadableStream): { transform(options: Record<string, unknown>): { output(options: { format: string; quality: number }): Promise<{ response(): Response }> } } };
  SETUP_CODE?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  PROPERTY_RESEARCH_MODEL?: string;
  RENTCAST_API_KEY?: string;
  GOOGLE_MAPS_API_KEY?: string;
}

interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; }
interface ScheduledController { scheduledTime: number; cron: string; noRetry(): void; }

const encoder = new TextEncoder();
const approvedUsers = new Set(["carsonpauli", "jessipauli"]);
const passwordHashIterations = 30_000;
const monthlyRentCastRequestLimit = 50;
const monthlyPropertyResearchLimit = 20;

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
    db.prepare("CREATE TABLE IF NOT EXISTS property_searches (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('primary', 'income')), label TEXT NOT NULL, city TEXT, state TEXT, zip_code TEXT, min_price INTEGER, max_price INTEGER, criteria TEXT, active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS property_listings (source_id TEXT NOT NULL, search_id INTEGER NOT NULL, mode TEXT NOT NULL, address TEXT NOT NULL, city TEXT, state TEXT, zip_code TEXT, property_type TEXT, price INTEGER, bedrooms REAL, bathrooms REAL, square_feet INTEGER, lot_size INTEGER, days_on_market INTEGER, status TEXT, listed_at TEXT, source_url TEXT, raw_json TEXT NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, PRIMARY KEY (source_id, search_id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS property_listings_mode_seen_idx ON property_listings (mode, last_seen_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS list_items (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('project', 'grocery')), visibility TEXT NOT NULL DEFAULT 'shared' CHECK(visibility IN ('private', 'shared')), text TEXT NOT NULL, completed INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, completed_at INTEGER)"),
    db.prepare("CREATE INDEX IF NOT EXISTS list_items_owner_kind_idx ON list_items (owner, kind, completed, created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS api_usage (service TEXT NOT NULL, period TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (service, period))"),
    db.prepare("CREATE TABLE IF NOT EXISTS property_ai_rankings (source_id TEXT NOT NULL, search_id INTEGER NOT NULL, score INTEGER NOT NULL, summary TEXT NOT NULL, estimated_monthly_income INTEGER, estimated_roi REAL, ranked_at INTEGER NOT NULL, PRIMARY KEY (source_id, search_id))"),
    db.prepare("CREATE TABLE IF NOT EXISTS property_coordinates (source_id TEXT NOT NULL, search_id INTEGER NOT NULL, latitude REAL NOT NULL, longitude REAL NOT NULL, PRIMARY KEY (source_id, search_id))"),
    db.prepare("CREATE TABLE IF NOT EXISTS property_media (source_id TEXT NOT NULL, search_id INTEGER NOT NULL, image_url TEXT NOT NULL, source_page_url TEXT NOT NULL, found_at INTEGER NOT NULL, PRIMARY KEY (source_id, search_id))"),
    db.prepare("CREATE TABLE IF NOT EXISTS user_preferences (username TEXT PRIMARY KEY, property_refresh TEXT NOT NULL DEFAULT 'weekly' CHECK(property_refresh IN ('weekly', 'daily', 'twice_daily')), updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS user_page_permissions (username TEXT NOT NULL, page_key TEXT NOT NULL CHECK(page_key IN ('assistant', 'lists', 'properties', 'user_management')), allowed INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (username, page_key))"),
    db.prepare("CREATE TABLE IF NOT EXISTS user_property_limits (username TEXT PRIMARY KEY, monthly_limit INTEGER NOT NULL CHECK(monthly_limit >= 0 AND monthly_limit <= 50), updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS user_property_usage (username TEXT NOT NULL, period TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, PRIMARY KEY (username, period))"),
    db.prepare("CREATE TABLE IF NOT EXISTS property_favorites (username TEXT NOT NULL, source_id TEXT NOT NULL, search_id INTEGER NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('primary', 'income')), created_at INTEGER NOT NULL, PRIMARY KEY (username, source_id, search_id))"),
    db.prepare("CREATE INDEX IF NOT EXISTS property_favorites_user_mode_idx ON property_favorites (username, mode, created_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS portfolio_properties (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, name TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', apn TEXT NOT NULL DEFAULT '', county TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', occupancy TEXT NOT NULL CHECK(occupancy IN ('rented', 'primary', 'secondary', 'vacant')), estimated_value INTEGER NOT NULL DEFAULT 0, money_owed INTEGER NOT NULL DEFAULT 0, notes TEXT NOT NULL DEFAULT '', latitude REAL, longitude REAL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS portfolio_properties_owner_idx ON portfolio_properties (owner, updated_at)"),
    db.prepare("CREATE TABLE IF NOT EXISTS portfolio_members (property_id INTEGER NOT NULL, username TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (property_id, username))"),
    db.prepare("CREATE INDEX IF NOT EXISTS portfolio_members_user_idx ON portfolio_members (username, property_id)"),
    db.prepare("CREATE TABLE IF NOT EXISTS property_valuation_cache (address_key TEXT PRIMARY KEY, formatted_address TEXT NOT NULL, estimated_value INTEGER NOT NULL, range_low INTEGER, range_high INTEGER, latitude REAL, longitude REAL, refreshed_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS portfolio_parcel_data (property_id INTEGER PRIMARY KEY, assessor_id TEXT, assessed_value INTEGER, land_value INTEGER, improvement_value INTEGER, assessment_year INTEGER, annual_tax INTEGER, tax_year INTEGER, legal_description TEXT, zoning TEXT, last_sale_price INTEGER, last_sale_date TEXT, refreshed_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS property_researches (id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT NOT NULL, lookup_key TEXT NOT NULL, query_type TEXT NOT NULL CHECK(query_type IN ('address', 'apn')), query_text TEXT NOT NULL, county TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT '', result_json TEXT NOT NULL, starred INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, refreshed_at INTEGER NOT NULL, UNIQUE(owner, lookup_key))"),
    db.prepare("CREATE INDEX IF NOT EXISTS property_researches_owner_time_idx ON property_researches (owner, refreshed_at DESC)"),
  ]);
  const listColumns = await db.prepare("PRAGMA table_info(list_items)").all<{ name: string }>();
  if (!(listColumns.results ?? []).some((column) => column.name === "assignee")) {
    await db.prepare("ALTER TABLE list_items ADD COLUMN assignee TEXT CHECK(assignee IN ('carsonpauli', 'jessipauli'))").run();
  }
  if (!(listColumns.results ?? []).some((column) => column.name === "assignment")) {
    await db.prepare("ALTER TABLE list_items ADD COLUMN assignment TEXT CHECK(assignment IN ('shared', 'carsonpauli', 'jessipauli'))").run();
  }
  const searchColumns = await db.prepare("PRAGMA table_info(property_searches)").all<{ name: string }>();
  if (!(searchColumns.results ?? []).some((column) => column.name === "last_synced_at")) {
    await db.prepare("ALTER TABLE property_searches ADD COLUMN last_synced_at INTEGER").run();
  }
  if (!(searchColumns.results ?? []).some((column) => column.name === "criteria")) {
    await db.prepare("ALTER TABLE property_searches ADD COLUMN criteria TEXT").run();
  }
  const portfolioColumns = await db.prepare("PRAGMA table_info(portfolio_properties)").all<{ name: string }>();
  if (!(portfolioColumns.results ?? []).some((column) => column.name === "apn")) await db.prepare("ALTER TABLE portfolio_properties ADD COLUMN apn TEXT NOT NULL DEFAULT ''").run();
  if (!(portfolioColumns.results ?? []).some((column) => column.name === "money_owed")) await db.prepare("ALTER TABLE portfolio_properties ADD COLUMN money_owed INTEGER NOT NULL DEFAULT 0").run();
  if (!(portfolioColumns.results ?? []).some((column) => column.name === "notes")) await db.prepare("ALTER TABLE portfolio_properties ADD COLUMN notes TEXT NOT NULL DEFAULT ''").run();
  if (!(portfolioColumns.results ?? []).some((column) => column.name === "county")) await db.prepare("ALTER TABLE portfolio_properties ADD COLUMN county TEXT NOT NULL DEFAULT ''").run();
  if (!(portfolioColumns.results ?? []).some((column) => column.name === "state")) await db.prepare("ALTER TABLE portfolio_properties ADD COLUMN state TEXT NOT NULL DEFAULT ''").run();
  const rankingColumns = await db.prepare("PRAGMA table_info(property_ai_rankings)").all<{ name: string }>();
  if (!(rankingColumns.results ?? []).some((column) => column.name === "estimated_monthly_income")) await db.prepare("ALTER TABLE property_ai_rankings ADD COLUMN estimated_monthly_income INTEGER").run();
  if (!(rankingColumns.results ?? []).some((column) => column.name === "estimated_roi")) await db.prepare("ALTER TABLE property_ai_rankings ADD COLUMN estimated_roi REAL").run();
  await db.prepare("INSERT OR IGNORE INTO property_searches (id, owner, mode, label, city, state, zip_code, min_price, max_price, active, created_at) VALUES (-100, 'shared', 'income', 'Northwest Arkansas Multifamily', 'Bentonville', 'AR', NULL, NULL, 600000, 1, ?)").bind(Date.now()).run();
  const permissionTime = Date.now();
  await db.batch(["assistant", "lists", "properties"].map((page) => db.prepare("INSERT OR IGNORE INTO user_page_permissions (username, page_key, allowed, updated_at) VALUES ('jessipauli', ?, 1, ?)").bind(page, permissionTime)));
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

const pageKeys = ["assistant", "lists", "properties", "user_management"] as const;
type PageKey = typeof pageKeys[number];

async function pageAccess(env: Env, username: string, page: PageKey) {
  if (username === "carsonpauli") return true;
  const permission = await env.DB.prepare("SELECT allowed FROM user_page_permissions WHERE username = ? AND page_key = ?").bind(username, page).first<{ allowed: number }>();
  return permission?.allowed === 1;
}

async function permissionsFor(env: Env, username: string) {
  if (username === "carsonpauli") return Object.fromEntries(pageKeys.map((page) => [page, true]));
  const result = await env.DB.prepare("SELECT page_key, allowed FROM user_page_permissions WHERE username = ?").bind(username).all<{ page_key: string; allowed: number }>();
  const permissions = Object.fromEntries(pageKeys.map((page) => [page, false])) as Record<string, boolean>;
  for (const row of result.results ?? []) permissions[row.page_key] = row.allowed === 1;
  return permissions;
}

function responseText(payload: { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> }) {
  if (payload.output_text) return payload.output_text.trim();
  return (payload.output ?? []).flatMap((item) => item.content ?? []).filter((item) => item.type === "output_text").map((item) => item.text ?? "").join("\n").trim();
}

function safeOpenAIError(status: number, payload: { error?: { code?: string; type?: string; message?: string } }) {
  const code = payload.error?.code ?? payload.error?.type ?? "";
  const detail = payload.error?.message?.toLowerCase() ?? "";
  if (status === 401 || code === "invalid_api_key") return "The OpenAI API key is invalid. Replace the OPENAI_API_KEY secret in Cloudflare.";
  if (code === "insufficient_quota" || detail.includes("quota") || detail.includes("billing")) return "The OpenAI API account needs billing credit. Add a payment method or credit in the OpenAI Platform account.";
  if (code === "model_not_found" || detail.includes("does not have access to model")) return "This OpenAI account cannot use the selected model yet. Add OPENAI_MODEL with a model available to your account.";
  if (status === 429) return "The OpenAI account is temporarily rate limited. Please try again shortly.";
  return "The OpenAI service could not answer right now.";
}

async function aiHealth(env: Env) {
  if (!env.OPENAI_API_KEY) return json({ configured: false, accessible: false, error: "OPENAI_API_KEY is missing." }, 503);
  const model = env.OPENAI_MODEL || "gpt-5.4-mini";
  const response = await fetch(`https://api.openai.com/v1/models/${encodeURIComponent(model)}`, { headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` } });
  const payload = await response.json() as { error?: { code?: string; type?: string; message?: string } };
  if (!response.ok) return json({ configured: true, accessible: false, model, error: safeOpenAIError(response.status, payload) }, 502);
  return json({ configured: true, accessible: true, model });
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
    env.DB.prepare("SELECT kind, text, completed FROM list_items ORDER BY created_at DESC LIMIT 100").all<{ kind: string; text: string; completed: number }>(),
  ]);
  const history = (historyResult.results ?? []).reverse();
  const workspace = workspaceResult.results ?? [];
  const workspaceContext = workspace.length
    ? workspace.map((item) => `[${item.section}] ${item.title}: ${item.content}`).join("\n")
    : "No saved Pauli HQ workspace items are available yet.";
  const listContext = (listResult.results ?? []).length
    ? (listResult.results ?? []).map((item) => `[${item.kind}] ${item.completed ? "completed" : "open"}: ${item.text}`).join("\n")
    : "No project or grocery list items are saved yet.";

  const requestBody = {
    model: env.OPENAI_MODEL || "gpt-5.4-mini",
    instructions: `You are the private Pauli HQ assistant for ${username}. Be practical, clear, and concise. You may answer general questions. You are also given authorized Pauli HQ workspace context from Projects, Documents, Property, Calendar, Tasks, Ideas, and Lists. Never claim you changed site data unless a tool explicitly confirms it. Distinguish saved workspace facts from general knowledge.\n\nAUTHORIZED WORKSPACE CONTEXT:\n${workspaceContext}\n\nAUTHORIZED LIST CONTEXT:\n${listContext}`,
    input: [...history, { role: "user", content: message }],
  };
  let openAIResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ ...requestBody, tools: [{ type: "web_search" }] }),
  });
  let payload = await openAIResponse.json() as { error?: { code?: string; type?: string; message?: string }; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  if (openAIResponse.status === 400 && (payload.error?.message?.toLowerCase().includes("tool") || payload.error?.message?.toLowerCase().includes("web_search"))) {
    openAIResponse = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    payload = await openAIResponse.json() as typeof payload;
  }
  if (!openAIResponse.ok) {
    console.error("OpenAI request failed", openAIResponse.status, payload.error?.message);
    return json({ error: safeOpenAIError(openAIResponse.status, payload) }, 502);
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
    const result = await env.DB.prepare("SELECT id, owner, COALESCE(assignment, assignee, owner) AS assignee, text, completed, created_at FROM list_items WHERE kind = ? AND completed = 0 ORDER BY created_at DESC").bind(kind).all();
    return json({ items: result.results ?? [] });
  }
  if (request.method === "POST") {
    const body = await request.json<{ text?: string; kind?: string; assignee?: string }>();
    const itemKind = body.kind === "grocery" ? "grocery" : "project";
    const assignment = body.assignee === "jessipauli" ? "jessipauli" : body.assignee === "carsonpauli" ? "carsonpauli" : "shared";
    const legacyAssignee = assignment === "shared" ? null : assignment;
    const itemText = String(body.text ?? "").trim().slice(0, 500);
    if (!itemText) return json({ error: "Add an item first." }, 400);
    await env.DB.prepare("INSERT INTO list_items (owner, assignee, assignment, kind, text, completed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)").bind(username, legacyAssignee, assignment, itemKind, itemText, Date.now()).run();
    return json({ ok: true }, 201);
  }
  return json({ error: "Method not allowed." }, 405);
}

async function updateListItem(request: Request, env: Env, username: string, id: number) {
  if (request.method !== "PATCH") return json({ error: "Method not allowed." }, 405);
  const body = await request.json<{ completed?: boolean }>();
  await env.DB.prepare("UPDATE list_items SET completed = ?, completed_at = ? WHERE id = ?")
    .bind(body.completed ? 1 : 0, body.completed ? Date.now() : null, id).run();
  return json({ ok: true });
}

async function simplifyList(request: Request, env: Env, username: string) {
  if (!env.OPENAI_API_KEY) return json({ error: "The AI connection has not been added to Cloudflare yet." }, 503);
  const body = await request.json<{ kind?: string; input?: string; assignee?: string }>();
  const kind = body.kind === "grocery" ? "grocery" : "project";
  const assignment = body.assignee === "jessipauli" ? "jessipauli" : body.assignee === "carsonpauli" ? "carsonpauli" : "shared";
  const legacyAssignee = assignment === "shared" ? null : assignment;
  const input = String(body.input ?? "").trim().slice(0, 4_000);
  if (!input) return json({ error: "Describe what you need first." }, 400);
  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.4-mini",
      instructions: kind === "grocery"
        ? "Convert the request into a concise grocery list while staying strictly grounded in what the user said. Correct spelling, capitalization, and grammar without changing meaning. Preserve requested items and clearly implied ingredients only. Do not add complementary products, brands, quantities, meal ideas, pantry staples, or guesses. If the request is already a simple item, return it with only necessary language corrections. Return one item per line with no bullets, headings, or commentary. Prefer fewer accurate items over a more complete-looking list."
        : "Turn the request into a short, practical checklist while staying strictly grounded in what the user said. Correct spelling, capitalization, and grammar without changing meaning. You may split a stated goal into only the minimum steps that are directly necessary or clearly implied. Preserve the user's wording and level of detail when possible. Do not add planning, research, purchasing, scheduling, cleanup, follow-up, or other tasks unless the user mentioned or necessarily implied them. If the request is already one checkable task, return one corrected task. Return one task per line with no bullets, headings, or commentary. Prefer fewer accurate tasks over an elaborate plan.",
      input,
    }),
  });
  const payload = await aiResponse.json() as { error?: { code?: string; type?: string; message?: string }; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  if (!aiResponse.ok) return json({ error: safeOpenAIError(aiResponse.status, payload) }, 502);
  const items = responseText(payload).split("\n").map((line) => line.replace(/^[-*\d.)\s]+/, "").trim()).filter(Boolean).slice(0, 30);
  if (!items.length) return json({ error: "The AI did not return any list items." }, 502);
  const now = Date.now();
  await env.DB.batch(items.map((item, index) => env.DB.prepare("INSERT INTO list_items (owner, assignee, assignment, kind, text, completed, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)").bind(username, legacyAssignee, assignment, kind, item.slice(0, 500), now + index)));
  return json({ items });
}

async function propertySearches(request: Request, env: Env, username: string) {
  if (request.method === "GET") {
    const result = await env.DB.prepare("SELECT id, owner, mode, label, city, state, zip_code, min_price, max_price, active, created_at FROM property_searches WHERE owner = ? OR owner = 'shared' ORDER BY created_at DESC").bind(username).all();
    return json({ searches: result.results ?? [] });
  }
  if (request.method === "DELETE") {
    const body = await request.json<{ id?: number }>();
    const id = Number(body.id);
    if (!Number.isInteger(id)) return json({ error: "Invalid property search." }, 400);
    const search = await env.DB.prepare("SELECT owner, label FROM property_searches WHERE id = ?").bind(id).first<{ owner: string; label: string }>();
    if (!search) return json({ error: "Property search not found." }, 404);
    if (search.owner !== username) return json({ error: "Only the person who created this search can delete it." }, 403);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM property_favorites WHERE search_id = ?").bind(id),
      env.DB.prepare("DELETE FROM property_media WHERE search_id = ?").bind(id),
      env.DB.prepare("DELETE FROM property_coordinates WHERE search_id = ?").bind(id),
      env.DB.prepare("DELETE FROM property_ai_rankings WHERE search_id = ?").bind(id),
      env.DB.prepare("DELETE FROM property_listings WHERE search_id = ?").bind(id),
      env.DB.prepare("DELETE FROM property_searches WHERE id = ? AND owner = ?").bind(id, username),
    ]);
    return json({ ok: true });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const body = await request.json<{ mode?: string; label?: string; city?: string; state?: string; zipCode?: string; minPrice?: number; maxPrice?: number }>();
  const mode = body.mode === "income" ? "income" : "primary";
  const label = String(body.label ?? "").trim().slice(0, 80);
  const city = String(body.city ?? "").trim().slice(0, 80);
  const state = String(body.state ?? "").trim().toUpperCase().slice(0, 2);
  const zipCode = String(body.zipCode ?? "").trim().slice(0, 10);
  if (!label || (!zipCode && (!city || state.length !== 2))) return json({ error: "Add a name and either a ZIP code or city and two-letter state." }, 400);
  const criteria = [label, city, state, zipCode, body.minPrice ? `minimum price ${body.minPrice}` : "", body.maxPrice ? `maximum price ${body.maxPrice}` : ""].filter(Boolean).join(", ");
  await env.DB.prepare("INSERT INTO property_searches (owner, mode, label, city, state, zip_code, min_price, max_price, criteria, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)")
    .bind(username, mode, label, city || null, state || null, zipCode || null, Number(body.minPrice) || null, Number(body.maxPrice) || null, criteria, Date.now()).run();
  return json({ ok: true }, 201);
}

async function propertyListings(request: Request, env: Env, username: string) {
  const url = new URL(request.url);
  const mode = url.searchParams.get("mode") === "income" ? "income" : "primary";
  const searchIdValue = url.searchParams.get("searchId");
  const requestedSearchId = searchIdValue == null ? null : Number(searchIdValue);
  const searchId = requestedSearchId != null && Number.isInteger(requestedSearchId) ? requestedSearchId : null;
  const starredOnly = url.searchParams.get("starred") === "1";
  const requestedSort = String(url.searchParams.get("sort") ?? (mode === "income" ? "roi" : "ai"));
  const sortClauses: Record<string, string> = {
    roi: "COALESCE(r.estimated_roi, r.score / 10.0, 0) DESC, l.price ASC",
    lot: "(l.lot_size IS NULL), l.lot_size DESC",
    beds: "(l.bedrooms IS NULL), l.bedrooms DESC",
    baths: "(l.bathrooms IS NULL), l.bathrooms DESC",
    sqft: "(l.square_feet IS NULL), l.square_feet DESC",
    price_low: "(l.price IS NULL), l.price ASC",
    price_high: "(l.price IS NULL), l.price DESC",
    ai: "COALESCE(r.score, 0) DESC, l.last_seen_at DESC",
  };
  const sort = requestedSort === "roi" && mode !== "income" ? "ai" : requestedSort in sortClauses ? requestedSort : mode === "income" ? "roi" : "ai";
  const result = await env.DB.prepare(`SELECT l.source_id, l.search_id, l.address, l.city, l.state, l.zip_code, l.property_type, l.price, l.bedrooms, l.bathrooms, l.square_feet, l.lot_size, l.days_on_market, l.status, l.listed_at, l.source_url, l.last_seen_at, s.label AS search_label, r.score AS ai_score, r.summary AS ai_summary, r.estimated_monthly_income, r.estimated_roi, c.latitude, c.longitude, m.image_url, m.source_page_url, CASE WHEN f.username IS NULL THEN 0 ELSE 1 END AS is_favorite
    FROM property_listings l JOIN property_searches s ON s.id = l.search_id LEFT JOIN property_ai_rankings r ON r.source_id = l.source_id AND r.search_id = l.search_id LEFT JOIN property_coordinates c ON c.source_id = l.source_id AND c.search_id = l.search_id LEFT JOIN property_media m ON m.source_id = l.source_id AND m.search_id = l.search_id LEFT JOIN property_favorites f ON f.username = ? AND f.source_id = l.source_id AND f.search_id = l.search_id
    WHERE (s.owner = ? OR s.owner = 'shared') AND l.mode = ? AND (? IS NULL OR l.search_id = ?) AND (? = 0 OR f.username IS NOT NULL) AND (l.mode != 'income' OR COALESCE(json_extract(l.raw_json, '$.hoa.fee'), 0) <= 0)
      AND (l.property_type IS NULL OR (lower(l.property_type) NOT LIKE '%mobile%' AND lower(l.property_type) NOT LIKE '%manufactured%'))
    ORDER BY ${sortClauses[sort]} LIMIT 50`).bind(username, username, mode, searchId, searchId, starredOnly ? 1 : 0).all();
  const period = new Date().toISOString().slice(0, 7);
  const usage = await env.DB.prepare("SELECT requests FROM api_usage WHERE service = 'rentcast' AND period = ?").bind(period).first<{ requests: number }>();
  return json({ listings: result.results ?? [], sort, sourceConnected: Boolean(env.RENTCAST_API_KEY), usage: { requests: usage?.requests ?? 0, limit: monthlyRentCastRequestLimit, period } });
}

async function propertyFavorite(request: Request, env: Env, username: string) {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const body = await request.json<{ sourceId?: string; searchId?: number; favorite?: boolean }>();
  const sourceId = String(body.sourceId ?? "").trim();
  const searchId = Number(body.searchId);
  if (!sourceId || !Number.isInteger(searchId)) return json({ error: "Invalid property." }, 400);
  const listing = await env.DB.prepare(`SELECT l.mode FROM property_listings l JOIN property_searches s ON s.id = l.search_id
    WHERE l.source_id = ? AND l.search_id = ? AND (s.owner = ? OR s.owner = 'shared')`)
    .bind(sourceId, searchId, username).first<{ mode: "primary" | "income" }>();
  if (!listing) return json({ error: "Property not found." }, 404);
  if (body.favorite) {
    await env.DB.prepare("INSERT INTO property_favorites (username, source_id, search_id, mode, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(username, source_id, search_id) DO UPDATE SET mode = excluded.mode")
      .bind(username, sourceId, searchId, listing.mode, Date.now()).run();
  } else {
    await env.DB.prepare("DELETE FROM property_favorites WHERE username = ? AND source_id = ? AND search_id = ?")
      .bind(username, sourceId, searchId).run();
  }
  return json({ ok: true, favorite: Boolean(body.favorite) });
}

async function geocodeAddress(address: string, env: Env) {
  if (!env.GOOGLE_MAPS_API_KEY) return null;
  try {
    const response = await fetch("https://places.googleapis.com/v1/places:searchText", { method: "POST", headers: { "content-type": "application/json", "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY, "X-Goog-FieldMask": "places.formattedAddress,places.location" }, body: JSON.stringify({ textQuery: address, includedType: "street_address", strictTypeFiltering: false, regionCode: "US", maxResultCount: 1 }) });
    if (!response.ok) return null;
    const result = await response.json() as { places?: Array<{ location?: { latitude?: number; longitude?: number } }> };
    const latitude = Number(result.places?.[0]?.location?.latitude); const longitude = Number(result.places?.[0]?.location?.longitude);
    return Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
  } catch { return null; }
}

async function addressAutocomplete(request: Request, env: Env) {
  if (!env.GOOGLE_MAPS_API_KEY) return json({ error: "Google address autocomplete is not connected yet." }, 503);
  const body = await request.json<{ input?: string; sessionToken?: string }>();
  const input = String(body.input ?? "").trim().slice(0, 180);
  if (input.length < 3) return json({ suggestions: [] });
  const response = await fetch("https://places.googleapis.com/v1/places:autocomplete", { method: "POST", headers: { "content-type": "application/json", "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY, "X-Goog-FieldMask": "suggestions.placePrediction.placeId,suggestions.placePrediction.text.text" }, body: JSON.stringify({ input, includedRegionCodes: ["us"], sessionToken: String(body.sessionToken ?? "").slice(0, 80) || undefined }) });
  const payload = await response.json() as { suggestions?: Array<{ placePrediction?: { placeId?: string; text?: { text?: string } } }>; error?: { message?: string } };
  if (!response.ok) return json({ error: "Address suggestions are temporarily unavailable." }, 502);
  return json({ suggestions: (payload.suggestions ?? []).flatMap((item) => item.placePrediction?.placeId && item.placePrediction.text?.text ? [{ placeId: item.placePrediction.placeId, text: item.placePrediction.text.text }] : []) });
}

async function addressDetails(request: Request, env: Env) {
  if (!env.GOOGLE_MAPS_API_KEY) return json({ error: "Google address autocomplete is not connected yet." }, 503);
  const body = await request.json<{ placeId?: string; sessionToken?: string }>();
  const placeId = String(body.placeId ?? "").trim();
  if (!placeId) return json({ error: "Choose an address." }, 400);
  const query = new URLSearchParams();
  if (body.sessionToken) query.set("sessionToken", String(body.sessionToken).slice(0, 80));
  const response = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}?${query}`, { headers: { "X-Goog-Api-Key": env.GOOGLE_MAPS_API_KEY, "X-Goog-FieldMask": "formattedAddress,location" } });
  const payload = await response.json() as { formattedAddress?: string; location?: { latitude?: number; longitude?: number } };
  if (!response.ok || !payload.formattedAddress) return json({ error: "Unable to load that address." }, 502);
  return json({ address: payload.formattedAddress.replace(/, USA$/, ""), latitude: payload.location?.latitude, longitude: payload.location?.longitude });
}

async function portfolioValuation(request: Request, env: Env) {
  if (!env.RENTCAST_API_KEY) return json({ error: "The property valuation connection is not configured." }, 503);
  const body = await request.json<{ address?: string }>();
  const address = String(body.address ?? "").trim().slice(0, 240);
  if (!address) return json({ error: "Choose a complete street address first." }, 400);
  const addressKey = address.toLowerCase().replace(/\s+/g, " ");
  const cached = await env.DB.prepare("SELECT formatted_address, estimated_value, range_low, range_high, latitude, longitude, refreshed_at FROM property_valuation_cache WHERE address_key = ? AND refreshed_at > ?").bind(addressKey, Date.now() - 30 * 24 * 60 * 60_000).first<{ formatted_address: string; estimated_value: number; range_low: number | null; range_high: number | null; latitude: number | null; longitude: number | null; refreshed_at: number }>();
  if (cached) return json({ address: cached.formatted_address, estimatedValue: cached.estimated_value, rangeLow: cached.range_low, rangeHigh: cached.range_high, latitude: cached.latitude, longitude: cached.longitude, cached: true });
  const params = new URLSearchParams({ address, compCount: "5", lookupSubjectAttributes: "true" });
  const response = await rentCastFetch(env, `https://api.rentcast.io/v1/avm/value?${params}`);
  if (!response) return json({ error: "The site's 50-request monthly property-data limit has been reached." }, 429);
  const payload = await response.json() as { price?: number; priceRangeLow?: number; priceRangeHigh?: number; subjectProperty?: { formattedAddress?: string; latitude?: number; longitude?: number }; message?: string };
  if (!response.ok || !Number.isFinite(Number(payload.price))) return json({ error: "No automatic value estimate was available for that address." }, 422);
  const formattedAddress = String(payload.subjectProperty?.formattedAddress || address).replace(/, USA$/, "");
  const estimatedValue = Math.round(Number(payload.price));
  await env.DB.prepare("INSERT INTO property_valuation_cache (address_key, formatted_address, estimated_value, range_low, range_high, latitude, longitude, refreshed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(address_key) DO UPDATE SET formatted_address=excluded.formatted_address, estimated_value=excluded.estimated_value, range_low=excluded.range_low, range_high=excluded.range_high, latitude=excluded.latitude, longitude=excluded.longitude, refreshed_at=excluded.refreshed_at")
    .bind(addressKey, formattedAddress, estimatedValue, Number(payload.priceRangeLow) || null, Number(payload.priceRangeHigh) || null, Number(payload.subjectProperty?.latitude) || null, Number(payload.subjectProperty?.longitude) || null, Date.now()).run();
  return json({ address: formattedAddress, estimatedValue, rangeLow: payload.priceRangeLow, rangeHigh: payload.priceRangeHigh, latitude: payload.subjectProperty?.latitude, longitude: payload.subjectProperty?.longitude, cached: false });
}

async function portfolioUsers(env: Env) {
  const result = await env.DB.prepare("SELECT username FROM users ORDER BY username").all<{ username: string }>();
  return json({ users: result.results ?? [] });
}

function latestYearValue<T>(values?: Record<string, T>) {
  const years = Object.keys(values ?? {}).filter((year) => /^\d{4}$/.test(year)).sort((left, right) => Number(right) - Number(left));
  const year = years[0];
  return year ? { year: Number(year), value: values?.[year] } : null;
}

function finiteNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

type PropertyResearchResult = {
  summary?: string;
  identity?: Record<string, unknown>;
  ownership?: Record<string, unknown>;
  property?: Record<string, unknown>;
  financial?: Record<string, unknown>;
  listing?: Record<string, unknown>;
  legal?: Record<string, unknown>;
  missing_fields?: string[];
  sources?: Array<{ title?: string; url?: string; supports?: string[] }>;
  researched_at?: string;
};

type ResearchInput = { queryType: "address" | "apn"; queryText: string; county: string; state: string; force?: boolean };

function parseJsonObject(text: string) {
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first < 0 || last <= first) throw new Error("No JSON object returned");
  return JSON.parse(cleaned.slice(first, last + 1)) as PropertyResearchResult;
}

function cleanUrl(value: unknown) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" ? url.toString() : "";
  } catch { return ""; }
}

function normalizeResearchResult(result: PropertyResearchResult) {
  const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const identity = object(result.identity);
  const ownershipRaw = object(result.ownership);
  const property = object(result.property);
  const financial = object(result.financial);
  const listing = object(result.listing);
  const legal = object(result.legal);
  const evidence = Array.isArray(ownershipRaw.evidence) ? ownershipRaw.evidence.map((item) => {
    const evidenceItem = object(item);
    return {
      source_kind: String(evidenceItem.source_kind ?? "public record").slice(0, 60),
      name: evidenceItem.name ? String(evidenceItem.name).slice(0, 180) : null,
      record_date: evidenceItem.record_date ? String(evidenceItem.record_date).slice(0, 40) : null,
      title: String(evidenceItem.title ?? "Ownership source").slice(0, 180),
      url: cleanUrl(evidenceItem.url),
      supports: String(evidenceItem.supports ?? "Ownership information").slice(0, 260),
    };
  }).filter((item) => item.url).slice(0, 10) : [];
  const confidence = String(ownershipRaw.ownership_confidence ?? "").toLowerCase();
  const ownership = {
    owner_name: ownershipRaw.owner_name ?? null,
    additional_owners: Array.isArray(ownershipRaw.additional_owners)
      ? ownershipRaw.additional_owners.map((item) => String(item).slice(0, 180)).filter(Boolean).slice(0, 10)
      : [],
    owner_type: ownershipRaw.owner_type ?? null,
    ownership_confidence: ["high", "medium", "low"].includes(confidence) ? confidence : null,
    record_as_of: ownershipRaw.record_as_of ?? null,
    deed_grantee: ownershipRaw.deed_grantee ?? null,
    deed_recorded_date: ownershipRaw.deed_recorded_date ?? null,
    deed_instrument: ownershipRaw.deed_instrument ?? null,
    entity_legal_name: ownershipRaw.entity_legal_name ?? null,
    entity_status: ownershipRaw.entity_status ?? null,
    entity_jurisdiction: ownershipRaw.entity_jurisdiction ?? null,
    ownership_source_tier: ownershipRaw.ownership_source_tier ?? null,
    official_record_found: typeof ownershipRaw.official_record_found === "boolean" ? ownershipRaw.official_record_found : null,
    secondary_record_found: typeof ownershipRaw.secondary_record_found === "boolean" ? ownershipRaw.secondary_record_found : null,
    rentcast_checked: typeof ownershipRaw.rentcast_checked === "boolean" ? ownershipRaw.rentcast_checked : null,
    rentcast_owner_found: typeof ownershipRaw.rentcast_owner_found === "boolean" ? ownershipRaw.rentcast_owner_found : null,
    homes_backup_checked: typeof ownershipRaw.homes_backup_checked === "boolean" ? ownershipRaw.homes_backup_checked : null,
    homes_backup_status: ownershipRaw.homes_backup_status ?? null,
    homes_source_url: cleanUrl(ownershipRaw.homes_source_url) || null,
    search_summary: ownershipRaw.search_summary ?? null,
    ownership_notes: ownershipRaw.ownership_notes ?? null,
    ownership_record_url: cleanUrl(ownershipRaw.ownership_record_url) || evidence.find((item) => /assessor|tax|recorder|deed/i.test(item.source_kind))?.url || null,
    public_business_phone: ownershipRaw.public_business_phone ?? null,
    public_business_email: ownershipRaw.public_business_email ?? null,
    public_business_website: cleanUrl(ownershipRaw.public_business_website) || null,
    contact_guidance: ownershipRaw.contact_guidance ?? null,
    contact_options: Array.isArray(ownershipRaw.contact_options) ? ownershipRaw.contact_options.map((item) => {
      const contact = object(item);
      return {
        contact_type: String(contact.contact_type ?? "public contact route").slice(0, 80),
        label: String(contact.label ?? "Contact option").slice(0, 160),
        value: contact.value ? String(contact.value).slice(0, 240) : null,
        url: cleanUrl(contact.url) || null,
        source_title: String(contact.source_title ?? "Published source").slice(0, 160),
        source_url: cleanUrl(contact.source_url),
        relationship: contact.relationship ? String(contact.relationship).slice(0, 180) : null,
        is_business_contact: contact.is_business_contact === true,
      };
    }).filter((item) => item.source_url && (item.is_business_contact || /agent|broker|contact form|government office/i.test(item.contact_type))).slice(0, 10) : [],
    evidence,
  };
  financial.valuation_evidence = Array.isArray(financial.valuation_evidence) ? financial.valuation_evidence.map((item) => {
    const valuation = object(item);
    return {
      source_name: String(valuation.source_name ?? "Value source").slice(0, 160),
      value: finiteNumber(valuation.value),
      value_type: String(valuation.value_type ?? "Published estimate").slice(0, 80),
      as_of: valuation.as_of ? String(valuation.as_of).slice(0, 40) : null,
      url: cleanUrl(valuation.url),
      notes: valuation.notes ? String(valuation.notes).slice(0, 260) : null,
      independent_source_group: valuation.independent_source_group ? String(valuation.independent_source_group).slice(0, 100) : null,
    };
  }).filter((item) => item.url && item.value !== null).slice(0, 10) : [];
  financial.comparable_sales = Array.isArray(financial.comparable_sales) ? financial.comparable_sales.map((item) => {
    const comparable = object(item);
    return {
      address: String(comparable.address ?? "Comparable property").slice(0, 180),
      sale_price: finiteNumber(comparable.sale_price),
      sale_date: comparable.sale_date ? String(comparable.sale_date).slice(0, 40) : null,
      distance_miles: finiteNumber(comparable.distance_miles),
      beds: finiteNumber(comparable.beds),
      baths: finiteNumber(comparable.baths),
      square_feet: finiteNumber(comparable.square_feet),
      lot_size_acres: finiteNumber(comparable.lot_size_acres),
      source_name: String(comparable.source_name ?? "Comparable source").slice(0, 140),
      url: cleanUrl(comparable.url),
      similarity_notes: comparable.similarity_notes ? String(comparable.similarity_notes).slice(0, 280) : null,
    };
  }).filter((item) => item.url && item.sale_price !== null).slice(0, 8) : [];
  financial.independent_estimate_count = Math.max(0, Math.min(20, Number(financial.independent_estimate_count) || 0));
  financial.market_context = Array.isArray(financial.market_context) ? financial.market_context.map((item) => {
    const trend = object(item);
    return {
      area_name: String(trend.area_name ?? "Local market").slice(0, 120),
      geography_type: String(trend.geography_type ?? "area").slice(0, 40),
      metric: String(trend.metric ?? "market trend").slice(0, 100),
      value: finiteNumber(trend.value),
      unit: String(trend.unit ?? "").slice(0, 40),
      as_of: trend.as_of ? String(trend.as_of).slice(0, 40) : null,
      source_name: String(trend.source_name ?? "Market source").slice(0, 160),
      url: cleanUrl(trend.url),
      notes: trend.notes ? String(trend.notes).slice(0, 240) : null,
    };
  }).filter((item) => item.url && item.value !== null).slice(0, 12) : [];
  const valueConfidence = String(financial.value_confidence ?? "").toLowerCase();
  financial.value_confidence = ["high", "medium", "low"].includes(valueConfidence) ? valueConfidence : null;
  listing.listing_url = cleanUrl(listing.listing_url) || null;
  const sources = Array.isArray(result.sources) ? result.sources.map((source) => ({
    title: String(source?.title ?? "Source").slice(0, 160),
    url: cleanUrl(source?.url),
    supports: Array.isArray(source?.supports) ? source.supports.map((item) => String(item).slice(0, 100)).slice(0, 12) : [],
  })).filter((source) => source.url).slice(0, 25) : [];
  return {
    summary: String(result.summary ?? "").slice(0, 2_000),
    identity,
    ownership,
    property,
    financial,
    listing,
    legal,
    missing_fields: Array.isArray(result.missing_fields) ? result.missing_fields.map((item) => String(item).slice(0, 100)).slice(0, 30) : [],
    sources,
    researched_at: new Date().toISOString(),
  } satisfies PropertyResearchResult;
}

function setWhenMissing(target: Record<string, unknown>, key: string, value: unknown) {
  if ((target[key] === null || target[key] === undefined || target[key] === "") && value !== null && value !== undefined && value !== "") target[key] = value;
}

async function enrichResearchWithRentCast(result: PropertyResearchResult, env: Env, fallbackAddress: string) {
  const address = String(result.identity?.address ?? fallbackAddress).trim();
  if (!address || !env.RENTCAST_API_KEY) return result;
  const params = new URLSearchParams({ address, limit: "1" });
  const response = await rentCastFetch(env, `https://api.rentcast.io/v1/properties?${params}`);
  if (!response) {
    const ownership = result.ownership ?? (result.ownership = {});
    setWhenMissing(ownership, "search_summary", "RentCast enrichment was skipped because the site's 50-request monthly property-data limit has been reached.");
    return result;
  }
  const payload = await response.json() as Array<Record<string, unknown>> | { message?: string };
  const record = Array.isArray(payload) ? payload[0] : null;
  const ownershipState = result.ownership ?? (result.ownership = {});
  ownershipState.rentcast_checked = true;
  if (!response.ok || !record) {
    ownershipState.rentcast_owner_found = false;
    setWhenMissing(ownershipState, "search_summary", "RentCast did not return a matching property owner, so Parcel Scout will try its backup sources.");
    return result;
  }
  const identity = result.identity ?? (result.identity = {});
  const ownership = result.ownership ?? (result.ownership = {});
  const property = result.property ?? (result.property = {});
  const financial = result.financial ?? (result.financial = {});
  const legal = result.legal ?? (result.legal = {});
  setWhenMissing(identity, "address", record.formattedAddress);
  setWhenMissing(identity, "apn", record.assessorID);
  setWhenMissing(identity, "county", record.county);
  setWhenMissing(identity, "state", record.state);
  setWhenMissing(identity, "latitude", record.latitude);
  setWhenMissing(identity, "longitude", record.longitude);
  setWhenMissing(property, "property_type", record.propertyType);
  setWhenMissing(property, "beds", record.bedrooms);
  setWhenMissing(property, "baths", record.bathrooms);
  setWhenMissing(property, "square_feet", record.squareFootage);
  setWhenMissing(property, "lot_size_sqft", record.lotSize);
  setWhenMissing(property, "lot_size_acres", finiteNumber(record.lotSize) ? Number((Number(record.lotSize) / 43_560).toFixed(3)) : null);
  setWhenMissing(property, "year_built", record.yearBuilt);
  setWhenMissing(financial, "last_sale_price", record.lastSalePrice);
  setWhenMissing(financial, "last_sale_date", record.lastSaleDate);
  setWhenMissing(legal, "legal_description", record.legalDescription);
  setWhenMissing(legal, "zoning", record.zoning);
  const owner = record.owner as { names?: unknown[]; type?: unknown; ownerOccupied?: unknown } | undefined;
  const ownerNames = Array.isArray(owner?.names) ? owner.names.map((name) => String(name).trim()).filter(Boolean).slice(0, 10) : [];
  ownership.rentcast_checked = true;
  ownership.rentcast_owner_found = ownerNames.length > 0;
  if (ownerNames.length > 0) {
    setWhenMissing(ownership, "owner_name", ownerNames[0]);
    if (!Array.isArray(ownership.additional_owners) || ownership.additional_owners.length === 0) ownership.additional_owners = ownerNames.slice(1);
    setWhenMissing(ownership, "owner_type", owner?.type);
    setWhenMissing(ownership, "ownership_confidence", "medium");
    setWhenMissing(ownership, "ownership_source_tier", "structured public-record provider");
    if (typeof ownership.official_record_found !== "boolean") ownership.official_record_found = false;
    ownership.secondary_record_found = true;
    setWhenMissing(ownership, "search_summary", "RentCast returned current owner details from its normalized property-record data. The name is retained while Parcel Scout attempts to confirm it against an official county or recorder source.");
    setWhenMissing(ownership, "ownership_notes", typeof owner?.ownerOccupied === "boolean" ? `RentCast owner-occupied indicator: ${owner.ownerOccupied ? "yes" : "no"}.` : null);
    const ownerEvidence = Array.isArray(ownership.evidence) ? ownership.evidence as Array<Record<string, unknown>> : [];
    if (!ownerEvidence.some((item) => item.source_kind === "structured property record")) ownerEvidence.unshift({
      source_kind: "structured property record",
      name: ownerNames.join(" & "),
      record_date: null,
      title: "RentCast current owner record",
      url: "https://developers.rentcast.io/reference/property-data-schema",
      supports: "Current owner name and entity type returned for the exact address",
    });
    ownership.evidence = ownerEvidence.slice(0, 10);
  }
  const assessments = record.taxAssessments as Record<string, { value?: number; land?: number; improvements?: number }> | undefined;
  const taxes = record.propertyTaxes as Record<string, { total?: number } | number> | undefined;
  const assessment = latestYearValue(assessments);
  const tax = latestYearValue(taxes);
  setWhenMissing(financial, "assessed_value", assessment?.value?.value);
  setWhenMissing(financial, "land_value", assessment?.value?.land);
  setWhenMissing(financial, "improvement_value", assessment?.value?.improvements);
  setWhenMissing(financial, "assessment_year", assessment?.year);
  setWhenMissing(financial, "annual_tax", typeof tax?.value === "number" ? tax.value : tax?.value?.total);
  setWhenMissing(financial, "tax_year", tax?.year);
  result.sources = [...(result.sources ?? []), { title: "RentCast property record", url: "https://developers.rentcast.io/reference/property-data-schema", supports: ["current owner name and entity type when available", "structured property characteristics", "assessment and tax history"] }];
  return result;
}

function mergeHomesFallback(base: PropertyResearchResult, homes: PropertyResearchResult) {
  const homesOwner = homes.ownership ?? {};
  base = mergeDeepOwnership(base, homes);
  const baseOwner = base.ownership ?? (base.ownership = {});
  for (const key of ["homes_backup_checked", "homes_backup_status", "homes_source_url", "rentcast_checked", "rentcast_owner_found"] as const) {
    if (homesOwner[key] !== null && homesOwner[key] !== undefined && homesOwner[key] !== "") baseOwner[key] = homesOwner[key];
  }
  setWhenMissing(baseOwner, "search_summary", homesOwner.search_summary);
  setWhenMissing(baseOwner, "ownership_notes", homesOwner.ownership_notes);
  for (const sectionName of ["identity", "property", "financial", "listing", "legal"] as const) {
    const target = base[sectionName] ?? (base[sectionName] = {});
    for (const [key, value] of Object.entries(homes[sectionName] ?? {})) {
      if (Array.isArray(value)) {
        if (!Array.isArray(target[key]) || (target[key] as unknown[]).length === 0) target[key] = value;
      } else setWhenMissing(target, key, value);
    }
  }
  return base;
}

async function runHomesFallbackResearch(env: Env, input: ResearchInput, base: PropertyResearchResult) {
  const address = String(base.identity?.address ?? (input.queryType === "address" ? input.queryText : "")).trim();
  const apn = String(base.identity?.apn ?? (input.queryType === "apn" ? input.queryText : "")).trim();
  const county = String(base.identity?.county ?? input.county).trim();
  const state = String(base.identity?.state ?? input.state).trim();
  const fallbackModel = env.OPENAI_MODEL || "gpt-5.4-mini";
  const preferredModel = env.PROPERTY_RESEARCH_MODEL || "gpt-5.6-terra";

  async function requestHomes(model: string) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        tools: [{ type: "web_search" }],
        max_tool_calls: 6,
        include: ["web_search_call.action.sources"],
        instructions: `Use Homes.com as a targeted backup source for one exact US property after RentCast returned no owner.

Search requirements:
- Find the exact Homes.com property page using the quoted full address and, when useful, the exact APN.
- Run a targeted search-index query in the form: site:homes.com/property "FULL STREET ADDRESS" "Ownership History" "Current Owners". Also try the address without punctuation and with standard street abbreviations.
- Confirm the page matches the same address, city, state, county, and parcel before using any fact.
- Inspect the public page for ownership history, owner type, property facts, sale history, assessed values, Homes.com estimated value, listing status, and other exact-property details.
- If Homes.com explicitly displays an owner name on the consulted page, return it with medium confidence and secondary exact-property source status.
- If the Homes.com page hides the name behind sign-in but the search-index result visibly contains the exact full property address, the explicit phrase "Current Owners," an owner name, and a current ownership date range, the snippet may be returned as low-confidence secondary evidence. Set ownership_source_tier to "Homes.com search-index snippet", source_kind to "search-index ownership snippet", record_as_of to the visible ownership start date or range, and explain that the name was visible in the indexed snippet but gated on the destination page.
- Never use a snippet that omits the exact street address, labels only a possible resident, lacks an ownership label, or could describe a different parcel. Never promote snippet-only evidence above low confidence unless another independent exact-property source corroborates the same owner.
- If the ownership row says "Sign in to view," is otherwise gated, or does not display a name and no qualifying indexed ownership snippet exists, never guess or infer the owner. Set homes_backup_status to "owner gated by Homes.com sign-in" and leave owner_name null.
- When the exact gated page and a qualifying indexed ownership snippet are both found, preserve both facts: return the snippet-backed owner at low confidence and set homes_backup_status to "owner found in Homes.com search-index snippet; destination page is sign-in gated".
- Do not use people-search sites or return personal phone numbers, emails, mailing addresses, relatives, or social profiles.
- Preserve all direct source URLs. Use null for unsupported facts.

Return only one JSON object: {"identity":{"address":string|null,"apn":string|null,"county":string|null,"state":string|null},"ownership":{"owner_name":string|null,"additional_owners":string[],"owner_type":string|null,"ownership_confidence":"medium"|"low"|null,"ownership_source_tier":string|null,"official_record_found":false,"secondary_record_found":boolean,"rentcast_checked":true,"rentcast_owner_found":false,"homes_backup_checked":true,"homes_backup_status":string,"homes_source_url":string|null,"record_as_of":string|null,"search_summary":string,"ownership_notes":string|null,"ownership_record_url":string|null,"evidence":[{"source_kind":string,"name":string|null,"record_date":string|null,"title":string,"url":string,"supports":string}]},"property":{"property_type":string|null,"lot_size_acres":number|null,"lot_size_sqft":number|null,"beds":number|null,"baths":number|null,"square_feet":number|null,"year_built":number|null,"garage_spaces":number|null,"garage_sqft":number|null},"financial":{"assessed_value":number|null,"land_value":number|null,"improvement_value":number|null,"assessment_year":number|null,"annual_tax":number|null,"tax_year":number|null,"estimated_value":number|null,"last_sale_price":number|null,"last_sale_date":string|null,"valuation_evidence":[{"source_name":string,"value":number,"value_type":string,"as_of":string|null,"url":string,"notes":string|null,"independent_source_group":string|null}]},"listing":{"for_sale":boolean|null,"status":string|null,"price":number|null,"listing_url":string|null},"legal":{"legal_description":string|null,"zoning":string|null,"subdivision":string|null},"missing_fields":string[],"sources":[{"title":string,"url":string,"supports":string[]}]}.`,
        input: `Find the exact Homes.com backup record.\nAddress: ${address || "unknown"}\nAPN: ${apn || "unknown"}\nCounty: ${county || "unknown"}\nState: ${state || "unknown"}`,
      }),
    });
    const payload = await response.json() as { error?: { code?: string; type?: string; message?: string }; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
    return { response, payload };
  }

  let attempt = await requestHomes(preferredModel);
  const modelIssue = !attempt.response.ok && /model|access/i.test(`${attempt.payload.error?.code ?? ""} ${attempt.payload.error?.message ?? ""}`);
  if (modelIssue && preferredModel !== fallbackModel) attempt = await requestHomes(fallbackModel);
  if (!attempt.response.ok) throw new Error(safeOpenAIError(attempt.response.status, attempt.payload));
  const text = responseText(attempt.payload);
  if (!text) throw new Error("The Homes.com backup returned no usable information.");
  return normalizeResearchResult(parseJsonObject(text));
}

function mergeDeepOwnership(base: PropertyResearchResult, deep: PropertyResearchResult) {
  const baseOwner = base.ownership ?? (base.ownership = {});
  const deepOwner = deep.ownership ?? {};
  const baseEvidence = Array.isArray(baseOwner.evidence) ? baseOwner.evidence : [];
  const deepEvidence = Array.isArray(deepOwner.evidence) ? deepOwner.evidence : [];
  if (deepOwner.owner_name || deepOwner.deed_grantee || deepEvidence.length) {
    base.ownership = { ...baseOwner, ...deepOwner, evidence: [...deepEvidence, ...baseEvidence].filter((item, index, items) => {
      const url = String((item as Record<string, unknown>)?.url ?? "");
      return Boolean(url) && items.findIndex((candidate) => String((candidate as Record<string, unknown>)?.url ?? "") === url) === index;
    }).slice(0, 10) };
  } else if (deepOwner.search_summary || deepOwner.ownership_notes) {
    base.ownership = {
      ...baseOwner,
      search_summary: deepOwner.search_summary ?? baseOwner.search_summary,
      ownership_notes: [baseOwner.ownership_notes, deepOwner.ownership_notes].filter(Boolean).join(" ").slice(0, 1_000) || null,
    };
  }
  const baseIdentity = base.identity ?? (base.identity = {});
  for (const [key, value] of Object.entries(deep.identity ?? {})) setWhenMissing(baseIdentity, key, value);
  const allSources = [...(deep.sources ?? []), ...(base.sources ?? [])];
  base.sources = allSources.filter((source, index, items) => Boolean(source.url) && items.findIndex((candidate) => candidate.url === source.url) === index).slice(0, 25);
  if (base.ownership?.owner_name) base.missing_fields = (base.missing_fields ?? []).filter((field) => !/owner|ownership/i.test(field));
  return base;
}

async function runDeepOwnershipResearch(env: Env, input: ResearchInput, base: PropertyResearchResult) {
  const address = String(base.identity?.address ?? (input.queryType === "address" ? input.queryText : "")).trim();
  const apn = String(base.identity?.apn ?? (input.queryType === "apn" ? input.queryText : "")).trim();
  const county = String(base.identity?.county ?? input.county).trim();
  const state = String(base.identity?.state ?? input.state).trim();
  const apnDigits = apn.replace(/\D/g, "");
  const subject = [`Address: ${address || "unknown"}`, `APN: ${apn || "unknown"}`, `APN digits: ${apnDigits || "unknown"}`, `County: ${county || "unknown"}`, `State: ${state || "unknown"}`].join("\n");
  const fallbackModel = env.OPENAI_MODEL || "gpt-5.4-mini";
  const preferredModel = env.PROPERTY_RESEARCH_MODEL || "gpt-5.6-terra";

  async function requestOwnership(model: string) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        tools: [{ type: "web_search" }],
        max_tool_calls: 12,
        include: ["web_search_call.action.sources"],
        instructions: `Find the latest publicly reported owner of one exact US parcel. This is a dedicated ownership pass; do not spend searches on valuation, neighborhood trends, photos, or general property description.

Success means either (a) a supported owner name with dated exact-parcel evidence or (b) a clear account of which relevant source types were checked and why ownership remains unverified.

Search strategy:
- Search the exact quoted street address with city/state and the terms owner, property record, assessor, parcel, tax, deed, grantee, and permit.
- Search the APN exactly as supplied, digits-only, and common punctuation variants with the county/state and the same ownership terms.
- Identify the official county assessor, tax collector/treasurer, GIS/parcel viewer, recorder/register of deeds, and clerk portals. Search their indexed pages and downloadable documents.
- Search exact-property pages on Homes.com, Redfin, Realtor.com, Zillow, LoopNet, and other reputable property portals. If one explicitly labels an owner for the exact address/APN, it is usable secondary evidence.
- Search official city/county permit archives, agendas, notices, deed indexes, and PDFs containing the exact address or APN. Permit owner names are historical evidence only unless their date is newer than any recorded sale or transfer evidence.
- If an entity owns the parcel, search the official state business registry for legal name, status, and jurisdiction.
- Try meaningful query variations when an initial result is empty. Do not stop after checking only one portal or one spelling.

Currentness and conflict rules:
- Match both geography and exact address/APN. Never merge a nearby or similarly named parcel.
- Compare every ownership record date against the latest sale or transfer date. Do not call a person the current owner when the only evidence predates a later sale.
- Prefer official assessor/tax/recorder records. When those are inaccessible but an exact Homes.com or similar page explicitly reports an owner, return it as secondary evidence with ownership_source_tier set to "secondary exact-property record" and confidence medium or low.
- If reliable sources disagree, describe the conflict and do not silently choose one. Use null if current ownership cannot be supported.
- Every owner claim must have a direct HTTPS source in both evidence and sources.

Privacy rules:
- Publicly recorded owner names are allowed.
- Never return a private phone number, email, personal mailing address, relative, employer, social profile, or people-search/data-broker result.
- Business contact details are allowed only when published by the organization itself or an official registry.

Confidence:
- high only for a current official assessor, tax, or recorder record matching the parcel;
- medium for exact, dated secondary property-record evidence that is consistent with transfer history;
- low for dated or indirect evidence, including permits, without a current official confirmation.

Return only one JSON object: {"identity":{"address":string|null,"apn":string|null,"county":string|null,"state":string|null},"ownership":{"owner_name":string|null,"additional_owners":string[],"owner_type":string|null,"ownership_confidence":"high"|"medium"|"low"|null,"ownership_source_tier":string|null,"official_record_found":boolean,"secondary_record_found":boolean,"record_as_of":string|null,"deed_grantee":string|null,"deed_recorded_date":string|null,"deed_instrument":string|null,"entity_legal_name":string|null,"entity_status":string|null,"entity_jurisdiction":string|null,"search_summary":string,"ownership_notes":string|null,"ownership_record_url":string|null,"public_business_phone":string|null,"public_business_email":string|null,"public_business_website":string|null,"evidence":[{"source_kind":string,"name":string|null,"record_date":string|null,"title":string,"url":string,"supports":string}]},"missing_fields":string[],"sources":[{"title":string,"url":string,"supports":string[]}]}.`,
        input: `Investigate ownership for this exact parcel:\n${subject}`,
      }),
    });
    const payload = await response.json() as { error?: { code?: string; type?: string; message?: string }; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
    return { response, payload };
  }

  let attempt = await requestOwnership(preferredModel);
  const modelIssue = !attempt.response.ok && /model|access/i.test(`${attempt.payload.error?.code ?? ""} ${attempt.payload.error?.message ?? ""}`);
  if (modelIssue && preferredModel !== fallbackModel) attempt = await requestOwnership(fallbackModel);
  if (!attempt.response.ok) throw new Error(safeOpenAIError(attempt.response.status, attempt.payload));
  const text = responseText(attempt.payload);
  if (!text) throw new Error("The deep ownership search returned no usable information.");
  return normalizeResearchResult(parseJsonObject(text));
}

async function runSecondaryOwnershipResearch(env: Env, input: ResearchInput, base: PropertyResearchResult) {
  const address = String(base.identity?.address ?? (input.queryType === "address" ? input.queryText : "")).trim();
  const apn = String(base.identity?.apn ?? (input.queryType === "apn" ? input.queryText : "")).trim();
  const county = String(base.identity?.county ?? input.county).trim();
  const state = String(base.identity?.state ?? input.state).trim();
  const existingOwner = base.ownership ?? {};
  const subject = [`Address: ${address || "unknown"}`, `APN: ${apn || "unknown"}`, `APN digits: ${apn.replace(/\D/g, "") || "unknown"}`, `County: ${county || "unknown"}`, `State: ${state || "unknown"}`, `Existing ownership candidate: ${JSON.stringify(existingOwner).slice(0, 3_000)}`].join("\n");
  const fallbackModel = env.OPENAI_MODEL || "gpt-5.4-mini";
  const preferredModel = env.PROPERTY_RESEARCH_MODEL || "gpt-5.6-terra";

  async function requestOwnership(model: string) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        tools: [{ type: "web_search" }],
        max_tool_calls: 14,
        include: ["web_search_call.action.sources"],
        instructions: `Perform an exhaustive secondary-source ownership sweep for one exact US parcel. An official-record pass has already run without producing a high-confidence answer. Focus only on ownership discovery and currentness.

Search independently across these source families:
1. Exact-property portals: Homes.com, Redfin, Realtor.com, Zillow, Trulia, LoopNet, PropertyShark, Movoto, Estately, Homesnap, Compass, and any exact-property page returned for the address or APN.
2. Listing and transaction sources: local MLS/IDX pages, listing brokerage pages, buyer or seller brokerage pages, sold-listing archives, auction pages, and reputable property-data pages.
3. Government-adjacent public documents: city/county permit archives, building department records, tax-sale records, planning packets, code-enforcement documents, public notices, agendas, minutes, recorded maps, and downloadable PDFs containing the exact address or APN.
4. Entity verification: official Secretary of State/business registry records when a candidate owner is an LLC, corporation, partnership, trust company, or nonprofit.
5. Search-engine variations: quote the full address; search street abbreviations and full street names; search APN with punctuation, without punctuation, and grouped differently; combine each with owner, owned by, property record, sale, transferred, grantee, parcel, permit, and tax.

Do not stop after one portal blocks access or returns nothing. Try other named sources and at least two materially different query patterns. A search-index snippet may support a low-confidence owner only when it visibly includes the exact full property address, an explicit current-owner label, the owner name, and a current date or ownership range. Preserve the linked exact-property URL and state that the evidence came from the index snippet.

Evidence rules:
- A secondary source may populate owner_name only when it explicitly associates that name with the exact address or APN.
- Homes.com and other exact-property pages are valid secondary evidence when they explicitly label the owner.
- A Homes.com or comparable search-index result is valid low-confidence secondary evidence when the snippet itself displays the exact full address, "Current Owners" or an equally explicit ownership label, the owner name, and a current ownership date. Do not use ordinary resident, directory, or people-search snippets.
- Confirm currentness against sale/transfer dates. A permit, directory, or archived listing dated before a later sale is historical only and must not be labeled current.
- Prefer two independent secondary sources. If only one exact-property source is available, report it, label the source tier, and lower confidence.
- If secondary sources conflict, return null for owner_name unless one is demonstrably newer; document every candidate and date in evidence and explain the conflict.
- Never merge a nearby parcel or a similar address.

Privacy rules:
- Publicly reported owner names are allowed.
- Exclude people-search sites, reverse-phone sites, social media, personal contact details, relatives, mailing addresses, and inferred household members.
- Business contact details are allowed only from the business itself or an official registry.

Confidence rules:
- medium: a current exact-property secondary record, preferably corroborated by another independent source and consistent with sale history;
- low: one dated exact-property source or older public-document evidence without current corroboration;
- never high, because this pass is secondary evidence.

Return only one JSON object: {"identity":{"address":string|null,"apn":string|null,"county":string|null,"state":string|null},"ownership":{"owner_name":string|null,"additional_owners":string[],"owner_type":string|null,"ownership_confidence":"medium"|"low"|null,"ownership_source_tier":string|null,"official_record_found":false,"secondary_record_found":boolean,"record_as_of":string|null,"deed_grantee":string|null,"deed_recorded_date":string|null,"deed_instrument":string|null,"entity_legal_name":string|null,"entity_status":string|null,"entity_jurisdiction":string|null,"search_summary":string,"ownership_notes":string|null,"ownership_record_url":string|null,"public_business_phone":string|null,"public_business_email":string|null,"public_business_website":string|null,"evidence":[{"source_kind":string,"name":string|null,"record_date":string|null,"title":string,"url":string,"supports":string}]},"missing_fields":string[],"sources":[{"title":string,"url":string,"supports":string[]}]}.`,
        input: `Find the best secondary ownership evidence for this exact parcel:\n${subject}`,
      }),
    });
    const payload = await response.json() as { error?: { code?: string; type?: string; message?: string }; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
    return { response, payload };
  }

  let attempt = await requestOwnership(preferredModel);
  const modelIssue = !attempt.response.ok && /model|access/i.test(`${attempt.payload.error?.code ?? ""} ${attempt.payload.error?.message ?? ""}`);
  if (modelIssue && preferredModel !== fallbackModel) attempt = await requestOwnership(fallbackModel);
  if (!attempt.response.ok) throw new Error(safeOpenAIError(attempt.response.status, attempt.payload));
  const text = responseText(attempt.payload);
  if (!text) throw new Error("The secondary ownership sweep returned no usable information.");
  return normalizeResearchResult(parseJsonObject(text));
}

function mergeOwnerContacts(base: PropertyResearchResult, contactResult: PropertyResearchResult) {
  const owner = base.ownership ?? (base.ownership = {});
  const contacts = contactResult.ownership ?? {};
  setWhenMissing(owner, "public_business_phone", contacts.public_business_phone);
  setWhenMissing(owner, "public_business_email", contacts.public_business_email);
  setWhenMissing(owner, "public_business_website", contacts.public_business_website);
  setWhenMissing(owner, "contact_guidance", contacts.contact_guidance);
  const baseOptions = Array.isArray(owner.contact_options) ? owner.contact_options : [];
  const newOptions = Array.isArray(contacts.contact_options) ? contacts.contact_options : [];
  owner.contact_options = [...newOptions, ...baseOptions].filter((item, index, items) => {
    const record = item as Record<string, unknown>;
    const key = `${record.source_url ?? ""}|${record.value ?? ""}|${record.url ?? ""}`;
    return Boolean(key.replaceAll("|", "")) && items.findIndex((candidate) => {
      const other = candidate as Record<string, unknown>;
      return `${other.source_url ?? ""}|${other.value ?? ""}|${other.url ?? ""}` === key;
    }) === index;
  }).slice(0, 10);
  const allSources = [...(contactResult.sources ?? []), ...(base.sources ?? [])];
  base.sources = allSources.filter((source, index, items) => Boolean(source.url) && items.findIndex((candidate) => candidate.url === source.url) === index).slice(0, 25);
  return base;
}

async function runOwnerContactResearch(env: Env, base: PropertyResearchResult) {
  const ownerName = String(base.ownership?.owner_name ?? "").trim();
  const ownerType = String(base.ownership?.owner_type ?? "").trim();
  const address = String(base.identity?.address ?? "").trim();
  const apn = String(base.identity?.apn ?? "").trim();
  const state = String(base.identity?.state ?? "").trim();
  const subject = [`Recorded owner: ${ownerName}`, `Owner type: ${ownerType || "unknown"}`, `Property: ${address || "unknown"}`, `APN: ${apn || "unknown"}`, `State: ${state || "unknown"}`].join("\n");
  const fallbackModel = env.OPENAI_MODEL || "gpt-5.4-mini";
  const preferredModel = env.PROPERTY_RESEARCH_MODEL || "gpt-5.6-terra";

  async function requestContacts(model: string) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        tools: [{ type: "web_search" }],
        max_tool_calls: 8,
        include: ["web_search_call.action.sources"],
        instructions: `Find legitimate public contact routes associated with a verified property owner. Ownership has already been established; do not redo ownership or property valuation research.

Search order:
1. If the owner is an entity, search the official state business registry, the entity's official website, its official contact page, and clearly associated professional profiles or licensing registries.
2. Search exact current/sold listing pages for a published listing agent and brokerage contact route connected to the property.
3. Search the owner organization's official website, public business phone, public business email, and contact form.
4. If no direct public business route exists, identify a legitimate intermediary such as the listing brokerage or relevant county assessor/recorder office and explain the route in contact_guidance.

Verification requirements:
- Every contact option must have a consulted HTTPS source and a clear relationship to the owner or property.
- Mark is_business_contact true only for an organization, licensed professional, listing agent/brokerage, or contact explicitly published for business use.
- Do not assume that a same-name person or business is the owner. Exclude ambiguous matches.

Privacy boundary:
- Never use people-search sites, reverse-phone/email services, data brokers, social media, relatives, neighbors, personal mailing addresses, personal phone numbers, or personal email addresses.
- Do not return registered-agent home addresses or an individual's personal contact details even if a database displays them.
- For a private individual without a verified public business connection, leave direct phone/email null and provide a safe intermediary route.

Return only one JSON object: {"ownership":{"public_business_phone":string|null,"public_business_email":string|null,"public_business_website":string|null,"contact_guidance":string|null,"contact_options":[{"contact_type":string,"label":string,"value":string|null,"url":string|null,"source_title":string,"source_url":string,"relationship":string|null,"is_business_contact":boolean}]},"sources":[{"title":string,"url":string,"supports":string[]}]}.`,
        input: `Find verified public contact routes for this owner and property:\n${subject}`,
      }),
    });
    const payload = await response.json() as { error?: { code?: string; type?: string; message?: string }; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
    return { response, payload };
  }

  let attempt = await requestContacts(preferredModel);
  const modelIssue = !attempt.response.ok && /model|access/i.test(`${attempt.payload.error?.code ?? ""} ${attempt.payload.error?.message ?? ""}`);
  if (modelIssue && preferredModel !== fallbackModel) attempt = await requestContacts(fallbackModel);
  if (!attempt.response.ok) throw new Error(safeOpenAIError(attempt.response.status, attempt.payload));
  const text = responseText(attempt.payload);
  if (!text) throw new Error("The public contact search returned no usable information.");
  return normalizeResearchResult(parseJsonObject(text));
}

function mergeDeepValuation(base: PropertyResearchResult, deep: PropertyResearchResult) {
  const baseFinancial = base.financial ?? (base.financial = {});
  const deepFinancial = deep.financial ?? {};
  const baseEvidence = Array.isArray(baseFinancial.valuation_evidence) ? baseFinancial.valuation_evidence : [];
  const deepEvidence = Array.isArray(deepFinancial.valuation_evidence) ? deepFinancial.valuation_evidence : [];
  const baseComps = Array.isArray(baseFinancial.comparable_sales) ? baseFinancial.comparable_sales : [];
  const deepComps = Array.isArray(deepFinancial.comparable_sales) ? deepFinancial.comparable_sales : [];
  const baseContext = Array.isArray(baseFinancial.market_context) ? baseFinancial.market_context : [];
  const deepContext = Array.isArray(deepFinancial.market_context) ? deepFinancial.market_context : [];
  const unique = (items: unknown[], key: (item: Record<string, unknown>) => string, limit: number) => items.filter((item, index, all) => {
    const value = key(item as Record<string, unknown>);
    return Boolean(value) && all.findIndex((candidate) => key(candidate as Record<string, unknown>) === value) === index;
  }).slice(0, limit);
  base.financial = {
    ...baseFinancial,
    ...deepFinancial,
    valuation_evidence: unique([...deepEvidence, ...baseEvidence], (item) => `${item.url ?? ""}|${item.value ?? ""}`, 10),
    comparable_sales: unique([...deepComps, ...baseComps], (item) => `${item.url ?? ""}|${item.address ?? ""}`, 8),
    market_context: unique([...deepContext, ...baseContext], (item) => `${item.url ?? ""}|${item.metric ?? ""}|${item.area_name ?? ""}`, 12),
  };
  const allSources = [...(deep.sources ?? []), ...(base.sources ?? [])];
  base.sources = allSources.filter((source, index, items) => Boolean(source.url) && items.findIndex((candidate) => candidate.url === source.url) === index).slice(0, 25);
  return base;
}

async function runDeepValuationResearch(env: Env, input: ResearchInput, base: PropertyResearchResult) {
  const address = String(base.identity?.address ?? (input.queryType === "address" ? input.queryText : "")).trim();
  const apn = String(base.identity?.apn ?? (input.queryType === "apn" ? input.queryText : "")).trim();
  const county = String(base.identity?.county ?? input.county).trim();
  const state = String(base.identity?.state ?? input.state).trim();
  const property = base.property ?? {};
  const existingFinancial = base.financial ?? {};
  const subject = [`Address: ${address || "unknown"}`, `APN: ${apn || "unknown"}`, `County: ${county || "unknown"}`, `State: ${state || "unknown"}`, `Known characteristics: ${JSON.stringify(property).slice(0, 2_000)}`, `Existing value evidence: ${JSON.stringify(existingFinancial).slice(0, 3_000)}`].join("\n");
  const fallbackModel = env.OPENAI_MODEL || "gpt-5.4-mini";
  const preferredModel = env.PROPERTY_RESEARCH_MODEL || "gpt-5.6-terra";

  async function requestValuation(model: string) {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        tools: [{ type: "web_search" }],
        max_tool_calls: 14,
        include: ["web_search_call.action.sources"],
        instructions: `Build a multi-source valuation report for one exact US property. A general property pass found fewer than three independent price references. Focus on pricing, comparable sales, and local market context; do not research ownership.

Exact-property value sources to attempt independently:
- Zillow Zestimate and exact Zillow property page;
- Redfin Estimate and exact Redfin property page;
- Realtor.com estimated value and exact property page;
- Homes.com estimated value and exact property page;
- Trulia, Movoto, Estately, Xome, RE/MAX, Rocket Homes, Chase Home Value Estimator, Bank of America Real Estate Center, PennyMac, and other reputable exact-property valuation pages when indexed and publicly accessible;
- current listing price from the listing brokerage or MLS/IDX syndication;
- latest recorded sale price and dated sale history;
- official assessed value and official appraised/market value, kept clearly separate.

Search rules:
- Search the full quoted address and exact-property URL results. Search the APN as a fallback.
- Try multiple named sources instead of stopping after the first estimate or blocked page.
- A search-result snippet may guide discovery but cannot supply the final number unless the linked exact-property page is consulted.
- Do not use a nearby property's estimate, an area median, or an undated number as the subject property's value.
- Record the source name, value type, as-of date, direct URL, and any important limitation for every figure.
- Use independent_source_group to identify shared estimate families when obvious; for example, Trulia and Zillow may not be independent. Count independent source groups, not merely website URLs.

Comparable sales:
- Find up to eight recently sold, genuinely similar properties. Prefer the same neighborhood and smallest reasonable radius, similar property type, living area, beds/baths, lot size, and recent sale date.
- Include only a comp with a direct page showing the sale price and date. Explain why each comp is similar or materially different.
- Do not call active listings comparable sales.

Local trends:
- Prefer ZIP-level trends, then city, county, or metro. Capture dated median sale price, median price per square foot, year-over-year change, days on market, sale-to-list ratio, and inventory when available.
- Keep the geography, source, and as-of date attached to every metric. Trends are context, not the property's value.

Reconciliation:
- Keep assessed value, prior sale, list price, AVMs, and comps separate.
- Synthesize estimated_value and a defensible value_range_low/high from current market-oriented evidence. Weight recent similar sold comps and multiple independent exact-property estimates more heavily than assessed value or an old sale.
- Set value_confidence high only with several current, consistent independent sources and useful comps; medium with partial but credible evidence; low when sparse or conflicting.
- Explain the weighting, disagreements, exclusions, and data limitations in valuation_method_summary and value_notes. Never average blindly and never invent a value.

Return only one JSON object: {"identity":{"address":string|null,"apn":string|null,"county":string|null,"state":string|null},"financial":{"assessed_value":number|null,"land_value":number|null,"improvement_value":number|null,"assessment_year":number|null,"annual_tax":number|null,"tax_year":number|null,"estimated_value":number|null,"value_range_low":number|null,"value_range_high":number|null,"value_confidence":"high"|"medium"|"low"|null,"value_notes":string|null,"valuation_method_summary":string|null,"independent_estimate_count":number,"last_sale_price":number|null,"last_sale_date":string|null,"valuation_evidence":[{"source_name":string,"value":number,"value_type":string,"as_of":string|null,"url":string,"notes":string|null,"independent_source_group":string|null}],"comparable_sales":[{"address":string,"sale_price":number,"sale_date":string|null,"distance_miles":number|null,"beds":number|null,"baths":number|null,"square_feet":number|null,"lot_size_acres":number|null,"source_name":string,"url":string,"similarity_notes":string|null}],"market_context":[{"area_name":string,"geography_type":string,"metric":string,"value":number,"unit":string,"as_of":string|null,"source_name":string,"url":string,"notes":string|null}]},"missing_fields":string[],"sources":[{"title":string,"url":string,"supports":string[]}]}.`,
        input: `Research pricing for this exact property:\n${subject}`,
      }),
    });
    const payload = await response.json() as { error?: { code?: string; type?: string; message?: string }; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
    return { response, payload };
  }

  let attempt = await requestValuation(preferredModel);
  const modelIssue = !attempt.response.ok && /model|access/i.test(`${attempt.payload.error?.code ?? ""} ${attempt.payload.error?.message ?? ""}`);
  if (modelIssue && preferredModel !== fallbackModel) attempt = await requestValuation(fallbackModel);
  if (!attempt.response.ok) throw new Error(safeOpenAIError(attempt.response.status, attempt.payload));
  const text = responseText(attempt.payload);
  if (!text) throw new Error("The deep pricing search returned no usable information.");
  return normalizeResearchResult(parseJsonObject(text));
}

async function runPropertyResearch(env: Env, input: ResearchInput) {
  if (!env.OPENAI_API_KEY) throw new Error("The AI connection has not been added to Cloudflare yet.");
  const location = [input.county && `${input.county} County`, input.state].filter(Boolean).join(", ");
  const subject = input.queryType === "apn" ? `APN ${input.queryText}${location ? ` in ${location}` : ""}` : input.queryText;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.PROPERTY_RESEARCH_MODEL || env.OPENAI_MODEL || "gpt-5.6-terra",
      tools: [{ type: "web_search" }],
      max_tool_calls: 10,
      include: ["web_search_call.action.sources"],
      instructions: `Investigate one exact US property and produce a source-backed property and ownership report.

Success means:
- identify the exact parcel by APN, address, county, and state without mixing in a similarly named property;
- make ownership the highest-priority research area;
- show who the latest public record names, the record date, the evidence chain, and a confidence level;
- compare multiple independently published value references when available, with a date and source for every figure;
- report conflicts or stale records instead of silently choosing one;
- use null for anything not supported by a consulted source.

Ownership research:
1. Search the exact APN both with and without punctuation, plus the exact normalized address and jurisdiction.
2. Prioritize official county assessor, tax collector, treasurer, GIS, and parcel portals. Look for the named owner and the record's as-of or tax year.
3. Check an official county recorder, register of deeds, clerk, or deed-index source for the latest grantee, recording date, and instrument number when publicly searchable.
4. If the owner is an LLC, corporation, partnership, nonprofit, or other entity, check the official Secretary of State or state business registry. Report the legal entity name, status, and jurisdiction. Use an official entity website only for explicitly published business contact details.
5. Use current real-estate listings and brokerage pages as secondary evidence. Do not treat an unverified aggregator as stronger than an official record.
6. If a result is empty, partial, or appears stale, try a meaningful alternate official source before stopping. Stop when ownership has strong exact-parcel evidence or the available public sources are exhausted.

Value research:
1. Collect distinct value references for the exact parcel: official assessed value, official appraised/market value when published, current listing price, latest recorded sale, and reputable public automated valuation estimates when accessible.
2. Specifically attempt the exact-property Zillow Zestimate, Redfin Estimate, Realtor.com estimate, and Homes.com estimate. Include a figure only when the exact property page and value were actually consulted; never substitute a search-result snippet, nearby home, or generic area estimate. A blocked or unavailable estimate belongs in missing_fields, not in the report as a guessed number.
3. Do not convert assessed value into market value unless an official source explicitly publishes both or supplies the jurisdiction's documented calculation. Do not invent a value from tax amounts.
4. Keep different value types separate. A list price, assessed value, recorded sale, and automated estimate are not interchangeable.
5. Prefer figures with a clear as-of date and a direct exact-property page. Exclude figures that cannot be tied to the exact APN/address.
6. Provide value_range_low and value_range_high only from credible current market-oriented references. Weight exact-property sources by recency and relevance, not by brand name. Explain disagreement and the basis of the range in value_notes. If evidence is too weak, leave the range null.

Local market context:
1. Find dated local trends for the smallest reliable geography containing the property, preferring ZIP code, then city, then county or metro.
2. Look for median sale price, median price per square foot, year-over-year price change, median days on market, sale-to-list ratio, and active inventory. Use reputable housing-market reports or official data and identify the geography and as-of date for each metric.
3. Do not apply an area median directly as the property's value. Use local trends only as context for reconciling exact-property estimates.
4. Do not mix metrics from different geographies or time periods without labeling them. If a metric is unavailable, omit it.

Confidence rubric:
- high: a current official assessor/tax/recorder record matches the exact parcel and jurisdiction;
- medium: exact-parcel evidence is reliable but the official ownership record is dated, incomplete, or supported by only one usable source;
- low: ownership is indirect, conflicting, or supported only by secondary sources;
- never label ownership high without an official public record.

Evidence and privacy rules:
- Every factual owner claim must appear in ownership.evidence and in sources, with a direct HTTPS page actually consulted.
- Label inference separately in ownership_notes. Do not present an inference as a recorded fact.
- Owner names from public property records are allowed.
- Never return a private individual's phone number, email, social profile, personal mailing address, relative, employer, or people-search/data-broker information.
- Business contact fields may contain only contact details explicitly published by the owner organization itself or an official registry.
- Listing-agent fields may contain only professional details published with the listing.
- Do not infer bedrooms, bathrooms, garage, acreage, ownership, value, sale status, or contact details.

Return only one valid JSON object with this exact shape: {"summary":string,"identity":{"address":string|null,"apn":string|null,"county":string|null,"state":string|null,"latitude":number|null,"longitude":number|null},"ownership":{"owner_name":string|null,"additional_owners":string[],"owner_type":string|null,"ownership_confidence":"high"|"medium"|"low"|null,"record_as_of":string|null,"deed_grantee":string|null,"deed_recorded_date":string|null,"deed_instrument":string|null,"entity_legal_name":string|null,"entity_status":string|null,"entity_jurisdiction":string|null,"ownership_notes":string|null,"ownership_record_url":string|null,"public_business_phone":string|null,"public_business_email":string|null,"public_business_website":string|null,"evidence":[{"source_kind":string,"name":string|null,"record_date":string|null,"title":string,"url":string,"supports":string}]},"property":{"property_type":string|null,"lot_size_acres":number|null,"lot_size_sqft":number|null,"beds":number|null,"baths":number|null,"square_feet":number|null,"year_built":number|null,"garage_spaces":number|null,"garage_sqft":number|null},"financial":{"assessed_value":number|null,"land_value":number|null,"improvement_value":number|null,"assessment_year":number|null,"annual_tax":number|null,"tax_year":number|null,"estimated_value":number|null,"value_range_low":number|null,"value_range_high":number|null,"value_confidence":"high"|"medium"|"low"|null,"value_notes":string|null,"last_sale_price":number|null,"last_sale_date":string|null,"valuation_evidence":[{"source_name":string,"value":number,"value_type":string,"as_of":string|null,"url":string,"notes":string|null}],"market_context":[{"area_name":string,"geography_type":string,"metric":string,"value":number,"unit":string,"as_of":string|null,"source_name":string,"url":string,"notes":string|null}]},"listing":{"for_sale":boolean|null,"status":string|null,"price":number|null,"listing_url":string|null,"agent_name":string|null,"brokerage":string|null,"professional_phone":string|null,"professional_email":string|null},"legal":{"legal_description":string|null,"zoning":string|null,"subdivision":string|null},"missing_fields":string[],"sources":[{"title":string,"url":string,"supports":string[]}]}.`,
      input: `Research this exact property: ${subject}`,
    }),
  });
  const payload = await response.json() as { error?: { code?: string; type?: string; message?: string }; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  if (!response.ok) throw new Error(safeOpenAIError(response.status, payload));
  const text = responseText(payload);
  if (!text) throw new Error("The property search returned no usable information.");
  let result: PropertyResearchResult;
  try { result = normalizeResearchResult(parseJsonObject(text)); }
  catch { throw new Error("The property search could not organize its findings. Please try once more."); }
  result = await enrichResearchWithRentCast(result, env, input.queryType === "address" ? input.queryText : "");
  if (!String(result.ownership?.owner_name ?? "").trim() && result.ownership?.rentcast_owner_found !== true) {
    try { result = mergeHomesFallback(result, await runHomesFallbackResearch(env, input, result)); }
    catch (reason) {
      const ownership = result.ownership ?? (result.ownership = {});
      ownership.homes_backup_checked = true;
      ownership.homes_backup_status = `Homes.com backup could not finish: ${reason instanceof Error ? reason.message : "unknown error"}`.slice(0, 500);
    }
  }
  const ownerName = String(result.ownership?.owner_name ?? "").trim();
  const ownerConfidence = String(result.ownership?.ownership_confidence ?? "").toLowerCase();
  if (!ownerName || ownerConfidence !== "high") {
    try { result = mergeDeepOwnership(result, await runDeepOwnershipResearch(env, input, result)); }
    catch (reason) {
      const ownership = result.ownership ?? (result.ownership = {});
      ownership.search_summary = `The dedicated ownership pass could not finish: ${reason instanceof Error ? reason.message : "unknown error"}`.slice(0, 500);
      result.missing_fields = [...new Set([...(result.missing_fields ?? []), "current ownership confirmation"])];
    }
  }
  const officialOwnerName = String(result.ownership?.owner_name ?? "").trim();
  const officialOwnerConfidence = String(result.ownership?.ownership_confidence ?? "").toLowerCase();
  if (!officialOwnerName || officialOwnerConfidence !== "high") {
    try { result = mergeDeepOwnership(result, await runSecondaryOwnershipResearch(env, input, result)); }
    catch (reason) {
      const ownership = result.ownership ?? (result.ownership = {});
      ownership.search_summary = [ownership.search_summary, `The secondary ownership sweep could not finish: ${reason instanceof Error ? reason.message : "unknown error"}`].filter(Boolean).join(" ").slice(0, 800);
    }
  }
  const resolvedOwner = String(result.ownership?.owner_name ?? "").trim();
  const contactOptions = Array.isArray(result.ownership?.contact_options) ? result.ownership.contact_options : [];
  if (resolvedOwner && !result.ownership?.public_business_phone && !result.ownership?.public_business_email && !result.ownership?.public_business_website && contactOptions.length === 0) {
    try { result = mergeOwnerContacts(result, await runOwnerContactResearch(env, result)); }
    catch (reason) {
      const ownership = result.ownership ?? (result.ownership = {});
      ownership.contact_guidance = `No verified public contact route was added during this search${reason instanceof Error ? `: ${reason.message}` : "."}`.slice(0, 500);
    }
  }
  const valuationReferences = Array.isArray(result.financial?.valuation_evidence) ? result.financial.valuation_evidence : [];
  const distinctValueSources = new Set(valuationReferences.map((item) => String((item as Record<string, unknown>)?.independent_source_group || (item as Record<string, unknown>)?.source_name || (item as Record<string, unknown>)?.url || "")).filter(Boolean));
  if (distinctValueSources.size < 3) {
    try { result = mergeDeepValuation(result, await runDeepValuationResearch(env, input, result)); }
    catch (reason) {
      const financial = result.financial ?? (result.financial = {});
      financial.valuation_method_summary = [financial.valuation_method_summary, `The expanded pricing sweep could not finish: ${reason instanceof Error ? reason.message : "unknown error"}`].filter(Boolean).join(" ").slice(0, 800);
    }
  }
  return normalizeResearchResult(result);
}

async function researchLookup(env: Env, username: string, input: ResearchInput) {
  const lookupKey = `${input.queryType}:${input.queryText.toLowerCase().replace(/[^a-z0-9]/g, "")}:${input.county.toLowerCase().trim()}:${input.state.toUpperCase().trim()}`.slice(0, 320);
  const cached = !input.force ? await env.DB.prepare("SELECT id, result_json, starred, refreshed_at FROM property_researches WHERE owner = ? AND lookup_key = ? AND (starred = 1 OR refreshed_at > ?)").bind(username, lookupKey, Date.now() - 90 * 24 * 60 * 60_000).first<{ id: number; result_json: string; starred: number; refreshed_at: number }>() : null;
  if (cached) return { id: cached.id, result: JSON.parse(cached.result_json) as PropertyResearchResult, starred: cached.starred === 1, cached: true, refreshedAt: cached.refreshed_at };
  if (!(await reservePropertyResearchRequest(env.DB))) throw new Error("The site's 20-investigation monthly Parcel Scout limit has been reached.");
  const result = await runPropertyResearch(env, input);
  const now = Date.now();
  await env.DB.prepare(`INSERT INTO property_researches (owner, lookup_key, query_type, query_text, county, state, result_json, created_at, refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner, lookup_key) DO UPDATE SET query_type=excluded.query_type, query_text=excluded.query_text, county=excluded.county, state=excluded.state, result_json=excluded.result_json, refreshed_at=excluded.refreshed_at`)
    .bind(username, lookupKey, input.queryType, input.queryText, input.county, input.state, JSON.stringify(result), now, now).run();
  const saved = await env.DB.prepare("SELECT id FROM property_researches WHERE owner = ? AND lookup_key = ?").bind(username, lookupKey).first<{ id: number }>();
  return { id: saved?.id, result, starred: false, cached: false, refreshedAt: now };
}

async function propertyResearch(request: Request, env: Env, username: string) {
  if (request.method === "GET") {
    const rows = await env.DB.prepare("SELECT id, query_type, query_text, county, state, result_json, starred, refreshed_at FROM property_researches WHERE owner = ? AND (starred = 1 OR refreshed_at > ?) ORDER BY starred DESC, refreshed_at DESC LIMIT 100").bind(username, Date.now() - 90 * 24 * 60 * 60_000).all<{ id: number; query_type: string; query_text: string; county: string; state: string; result_json: string; starred: number; refreshed_at: number }>();
    const period = new Date().toISOString().slice(0, 7);
    const usage = await env.DB.prepare("SELECT requests FROM api_usage WHERE service = 'property_research' AND period = ?").bind(period).first<{ requests: number }>();
    const rentCastUsage = await env.DB.prepare("SELECT requests FROM api_usage WHERE service = 'rentcast' AND period = ?").bind(period).first<{ requests: number }>();
    return json({ researches: (rows.results ?? []).map((row) => ({ ...row, result: JSON.parse(row.result_json), result_json: undefined })), usage: { requests: usage?.requests ?? 0, limit: monthlyPropertyResearchLimit, period }, rentCastUsage: { requests: rentCastUsage?.requests ?? 0, limit: monthlyRentCastRequestLimit, period } });
  }
  const body = await request.json<{ id?: number; queryType?: string; queryText?: string; county?: string; state?: string; force?: boolean; starred?: boolean }>();
  if (request.method === "PATCH") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return json({ error: "Invalid saved lookup." }, 400);
    await env.DB.prepare("UPDATE property_researches SET starred = ? WHERE id = ? AND owner = ?").bind(body.starred ? 1 : 0, id, username).run();
    if (!body.starred) await env.DB.prepare("DELETE FROM property_researches WHERE id = ? AND owner = ? AND refreshed_at <= ?").bind(id, username, Date.now() - 90 * 24 * 60 * 60_000).run();
    return json({ ok: true, starred: Boolean(body.starred) });
  }
  if (request.method === "DELETE") {
    const id = Number(body.id);
    if (!Number.isInteger(id)) return json({ error: "Invalid saved lookup." }, 400);
    await env.DB.prepare("DELETE FROM property_researches WHERE id = ? AND owner = ?").bind(id, username).run();
    return json({ ok: true });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const queryType = body.queryType === "apn" ? "apn" : "address";
  const queryText = String(body.queryText ?? "").trim().slice(0, 240);
  const county = String(body.county ?? "").trim().replace(/\s+County$/i, "").slice(0, 80);
  const state = String(body.state ?? "").trim().toUpperCase().slice(0, 2);
  if (!queryText) return json({ error: `Enter ${queryType === "apn" ? "an APN" : "a property address"}.` }, 400);
  if (queryType === "apn" && (!county || state.length !== 2)) return json({ error: "APN searches need the county and two-letter state." }, 400);
  try { return json(await researchLookup(env, username, { queryType, queryText, county, state, force: Boolean(body.force) })); }
  catch (error) { return json({ error: error instanceof Error ? error.message : "Unable to research that property." }, 502); }
}

async function portfolioParcel(request: Request, env: Env, username: string) {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const body = await request.json<{ id?: number }>();
  const id = Number(body.id);
  if (!Number.isInteger(id)) return json({ error: "Invalid property." }, 400);
  const property = await env.DB.prepare(`SELECT p.address, p.apn, p.county, p.state FROM portfolio_properties p WHERE p.id = ? AND
    (p.owner = ? OR EXISTS (SELECT 1 FROM portfolio_members m WHERE m.property_id = p.id AND m.username = ?))`).bind(id, username, username).first<{ address: string; apn: string; county: string; state: string }>();
  if (!property) return json({ error: "Property not found." }, 404);

  const cached = await env.DB.prepare("SELECT * FROM portfolio_parcel_data WHERE property_id = ? AND refreshed_at > ?").bind(id, Date.now() - 30 * 24 * 60 * 60_000).first();
  if (cached) return json({ parcel: cached, cached: true });
  if (property.apn && (!property.county || property.state.length !== 2)) return json({ error: "Edit this APN-only property and add its county and two-letter state first." }, 422);
  if (!property.apn && !property.address) return json({ error: "Add an APN or street address to retrieve parcel records." }, 422);
  let research: PropertyResearchResult;
  try {
    research = (await researchLookup(env, username, { queryType: property.apn ? "apn" : "address", queryText: property.apn || property.address, county: property.county, state: property.state })).result;
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to research this parcel." }, 502);
  }
  const identity = research.identity ?? {};
  const financial = research.financial ?? {};
  const legal = research.legal ?? {};
  const parcel = {
    property_id: id,
    assessor_id: String(identity.apn ?? property.apn).slice(0, 100) || null,
    assessed_value: finiteNumber(financial.assessed_value) === null ? null : Math.round(finiteNumber(financial.assessed_value)!),
    land_value: finiteNumber(financial.land_value) === null ? null : Math.round(finiteNumber(financial.land_value)!),
    improvement_value: finiteNumber(financial.improvement_value) === null ? null : Math.round(finiteNumber(financial.improvement_value)!),
    assessment_year: finiteNumber(financial.assessment_year),
    annual_tax: finiteNumber(financial.annual_tax) === null ? null : Math.round(finiteNumber(financial.annual_tax)!),
    tax_year: finiteNumber(financial.tax_year),
    legal_description: String(legal.legal_description ?? "").slice(0, 1_000) || null,
    zoning: String(legal.zoning ?? "").slice(0, 120) || null,
    last_sale_price: finiteNumber(financial.last_sale_price) === null ? null : Math.round(finiteNumber(financial.last_sale_price)!),
    last_sale_date: String(financial.last_sale_date ?? "").slice(0, 40) || null,
    refreshed_at: Date.now(),
  };
  await env.DB.prepare(`INSERT INTO portfolio_parcel_data (property_id, assessor_id, assessed_value, land_value, improvement_value, assessment_year, annual_tax, tax_year, legal_description, zoning, last_sale_price, last_sale_date, refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(property_id) DO UPDATE SET assessor_id=excluded.assessor_id, assessed_value=excluded.assessed_value, land_value=excluded.land_value, improvement_value=excluded.improvement_value, assessment_year=excluded.assessment_year, annual_tax=excluded.annual_tax, tax_year=excluded.tax_year, legal_description=excluded.legal_description, zoning=excluded.zoning, last_sale_price=excluded.last_sale_price, last_sale_date=excluded.last_sale_date, refreshed_at=excluded.refreshed_at`)
    .bind(parcel.property_id, parcel.assessor_id, parcel.assessed_value, parcel.land_value, parcel.improvement_value, parcel.assessment_year, parcel.annual_tax, parcel.tax_year, parcel.legal_description, parcel.zoning, parcel.last_sale_price, parcel.last_sale_date, parcel.refreshed_at).run();
  const discoveredAddress = String(identity.address ?? "").slice(0, 240);
  const discoveredCounty = String(identity.county ?? property.county).slice(0, 80);
  const discoveredState = String(identity.state ?? property.state).toUpperCase().slice(0, 2);
  const estimatedValue = finiteNumber(financial.estimated_value);
  await env.DB.prepare("UPDATE portfolio_properties SET address = CASE WHEN address = '' THEN ? ELSE address END, apn = CASE WHEN apn = '' THEN ? ELSE apn END, county = CASE WHEN county = '' THEN ? ELSE county END, state = CASE WHEN state = '' THEN ? ELSE state END, estimated_value = CASE WHEN estimated_value = 0 AND ? IS NOT NULL THEN ? ELSE estimated_value END, latitude = COALESCE(latitude, ?), longitude = COALESCE(longitude, ?), updated_at = ? WHERE id = ?")
    .bind(discoveredAddress, parcel.assessor_id ?? "", discoveredCounty, discoveredState, estimatedValue, estimatedValue, finiteNumber(identity.latitude), finiteNumber(identity.longitude), Date.now(), id).run();
  return json({ parcel, cached: false, source: "Parcel Scout public-record research" });
}

async function portfolio(request: Request, env: Env, username: string) {
  if (request.method === "GET") {
    const result = await env.DB.prepare(`SELECT p.id, p.owner, p.name, p.address, p.apn, p.county, p.state, p.occupancy, p.estimated_value, p.money_owed, p.notes, p.latitude, p.longitude, p.updated_at,
      d.assessor_id, d.assessed_value, d.land_value, d.improvement_value, d.assessment_year, d.annual_tax, d.tax_year, d.legal_description, d.zoning, d.last_sale_price, d.last_sale_date, d.refreshed_at AS parcel_refreshed_at,
      GROUP_CONCAT(m.username) AS shared_with FROM portfolio_properties p LEFT JOIN portfolio_members m ON m.property_id = p.id LEFT JOIN portfolio_parcel_data d ON d.property_id = p.id
      WHERE p.owner = ? OR EXISTS (SELECT 1 FROM portfolio_members mine WHERE mine.property_id = p.id AND mine.username = ?)
      GROUP BY p.id ORDER BY p.updated_at DESC`).bind(username, username).all();
    return json({ properties: result.results ?? [] });
  }
  const body = await request.json<{ id?: number; name?: string; address?: string; apn?: string; county?: string; state?: string; occupancy?: string; estimatedValue?: number; moneyOwed?: number; notes?: string; latitude?: number; longitude?: number; sharedWith?: string[] }>();
  const name = String(body.name ?? "").trim().slice(0, 100);
  const address = String(body.address ?? "").trim().slice(0, 240);
  const apn = String(body.apn ?? "").trim().slice(0, 80);
  const county = String(body.county ?? "").trim().replace(/\s+County$/i, "").slice(0, 80);
  const state = String(body.state ?? "").trim().toUpperCase().slice(0, 2);
  const occupancy = ["rented", "primary", "secondary", "vacant"].includes(String(body.occupancy)) ? String(body.occupancy) : "vacant";
  const estimatedValue = Math.max(0, Math.round(Number(body.estimatedValue) || 0));
  const moneyOwed = Math.max(0, Math.round(Number(body.moneyOwed) || 0));
  const notes = String(body.notes ?? "").trim().slice(0, 5_000);
  const requestedMembers = [...new Set((body.sharedWith ?? []).map((value) => String(value).trim()).filter((value) => value && value !== username))];
  const validUsers = requestedMembers.length ? await env.DB.prepare(`SELECT username FROM users WHERE username IN (${requestedMembers.map(() => "?").join(",")})`).bind(...requestedMembers).all<{ username: string }>() : { results: [] as Array<{ username: string }> };
  const members = (validUsers.results ?? []).map((row) => row.username);
  if (request.method === "POST") {
    if (!name || (!address && !apn)) return json({ error: "Add a property name and either a full address or APN." }, 400);
    const suppliedLatitude = Number(body.latitude); const suppliedLongitude = Number(body.longitude);
    const coordinates = Number.isFinite(suppliedLatitude) && Number.isFinite(suppliedLongitude) ? { latitude: suppliedLatitude, longitude: suppliedLongitude } : address ? await geocodeAddress(address, env) : null;
    const now = Date.now();
    const created = await env.DB.prepare("INSERT INTO portfolio_properties (owner, name, address, apn, county, state, occupancy, estimated_value, money_owed, notes, latitude, longitude, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(username, name, address, apn, county, state, occupancy, estimatedValue, moneyOwed, notes, coordinates?.latitude ?? null, coordinates?.longitude ?? null, now, now).run();
    const id = Number(created.meta.last_row_id);
    if (members.length) await env.DB.batch(members.map((member) => env.DB.prepare("INSERT INTO portfolio_members (property_id, username, created_at) VALUES (?, ?, ?)").bind(id, member, now)));
    return json({ ok: true, id }, 201);
  }
  const id = Number(body.id);
  if (!Number.isInteger(id)) return json({ error: "Invalid property." }, 400);
  const owned = await env.DB.prepare("SELECT address FROM portfolio_properties WHERE id = ? AND owner = ?").bind(id, username).first<{ address: string }>();
  if (!owned) return json({ error: "Only the property owner can make this change." }, 403);
  if (request.method === "DELETE") {
    await env.DB.batch([env.DB.prepare("DELETE FROM portfolio_members WHERE property_id = ?").bind(id), env.DB.prepare("DELETE FROM portfolio_parcel_data WHERE property_id = ?").bind(id), env.DB.prepare("DELETE FROM portfolio_properties WHERE id = ? AND owner = ?").bind(id, username)]);
    return json({ ok: true });
  }
  if (request.method === "PATCH") {
    if (!name || (!address && !apn)) return json({ error: "Add a property name and either a full address or APN." }, 400);
    const suppliedLatitude = Number(body.latitude); const suppliedLongitude = Number(body.longitude);
    const coordinates = Number.isFinite(suppliedLatitude) && Number.isFinite(suppliedLongitude) ? { latitude: suppliedLatitude, longitude: suppliedLongitude } : address && address !== owned.address ? await geocodeAddress(address, env) : null;
    await env.DB.prepare("UPDATE portfolio_properties SET name = ?, address = ?, apn = ?, county = ?, state = ?, occupancy = ?, estimated_value = ?, money_owed = ?, notes = ?, latitude = CASE WHEN ? = '' THEN NULL ELSE COALESCE(?, latitude) END, longitude = CASE WHEN ? = '' THEN NULL ELSE COALESCE(?, longitude) END, updated_at = ? WHERE id = ? AND owner = ?")
      .bind(name, address, apn, county, state, occupancy, estimatedValue, moneyOwed, notes, address, coordinates?.latitude ?? null, address, coordinates?.longitude ?? null, Date.now(), id, username).run();
    await env.DB.prepare("DELETE FROM portfolio_members WHERE property_id = ?").bind(id).run();
    if (members.length) await env.DB.batch(members.map((member) => env.DB.prepare("INSERT INTO portfolio_members (property_id, username, created_at) VALUES (?, ?, ?)").bind(id, member, Date.now())));
    return json({ ok: true });
  }
  return json({ error: "Method not allowed." }, 405);
}

async function portfolioWeather(request: Request, env: Env, username: string) {
  const id = Number(new URL(request.url).searchParams.get("id"));
  const property = await env.DB.prepare(`SELECT p.latitude, p.longitude FROM portfolio_properties p WHERE p.id = ? AND
    (p.owner = ? OR EXISTS (SELECT 1 FROM portfolio_members m WHERE m.property_id = p.id AND m.username = ?))`).bind(id, username, username).first<{ latitude: number | null; longitude: number | null }>();
  if (!property) return json({ error: "Property not found." }, 404);
  if (property.latitude == null || property.longitude == null) return json({ error: "Weather location unavailable for this address." }, 422);
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${property.latitude}&longitude=${property.longitude}&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=auto`);
  if (!response.ok) return json({ error: "Weather is temporarily unavailable." }, 502);
  const data = await response.json() as { current?: Record<string, number | string> };
  return json({ current: data.current ?? {} });
}

async function aiPropertyQuery(request: Request, env: Env, username: string) {
  if (!env.OPENAI_API_KEY) return json({ error: "The AI connection is not configured." }, 503);
  if (!env.RENTCAST_API_KEY) return json({ error: "The property-data connection is not configured." }, 503);
  const body = await request.json<{ prompt?: string; mode?: string }>();
  const prompt = String(body.prompt ?? "").trim().slice(0, 1_500);
  const mode = body.mode === "primary" ? "primary" : "income";
  if (!prompt) return json({ error: "Describe the properties you want to find." }, 400);

  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.4-mini",
      instructions: `Convert a user's US real-estate request into strict filters for a property listing API. Preserve every word such as must, minimum, maximum, only, at least, and no. Return only valid JSON with: label (short string), address (street address or null), city (or null), state (two-letter abbreviation or null), zip_code (or null), radius (integer miles 1-100 or null), property_types (array containing only Single Family, Condo, Townhouse, Multi-Family, Apartment, or Land), min_price, max_price, min_bedrooms, min_bathrooms, and min_lot_acres (numbers or null). Convert state names to two-letter abbreviations. Never include mobile homes or manufactured homes. Do not invent or relax a location or constraint. If the request says Arkansas, state must be AR. If it says a minimum number of acres, min_lot_acres must contain that number. If this is an income search and no property type is stated, use [\"Multi-Family\",\"Apartment\"]. If this is a primary-residence search and no type is stated, leave property_types empty.`,
      input: `${mode === "income" ? "Income property" : "Primary residence"} request: ${prompt}`,
    }),
  });
  const aiPayload = await aiResponse.json() as { error?: { code?: string; type?: string; message?: string }; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  if (!aiResponse.ok) return json({ error: safeOpenAIError(aiResponse.status, aiPayload) }, 502);
  let filters: { label?: string; address?: string | null; city?: string | null; state?: string | null; zip_code?: string | null; radius?: number | null; property_types?: string[]; min_price?: number | null; max_price?: number | null; min_bedrooms?: number | null; min_bathrooms?: number | null; min_lot_acres?: number | null };
  try {
    filters = JSON.parse(responseText(aiPayload).replace(/^```json\s*/i, "").replace(/```\s*$/, ""));
  } catch { return json({ error: "The request could not be converted into property filters. Try including a city, state, or ZIP code." }, 422); }
  const promptRequiresArkansas = /\b(?:arkansas|ar)\b/i.test(prompt);
  const acreMatch = prompt.match(/\b(\d+(?:\.\d+)?)\s*(?:\+\s*)?acres?\b/i);
  const address = String(filters.address ?? "").trim().slice(0, 160);
  const city = String(filters.city ?? "").trim().slice(0, 80);
  const state = (promptRequiresArkansas ? "AR" : String(filters.state ?? "").trim().toUpperCase()).slice(0, 2);
  const zipCode = String(filters.zip_code ?? "").trim().slice(0, 10);
  const minLotAcres = Math.max(0, Number(acreMatch?.[1] ?? filters.min_lot_acres) || 0);
  const minLotSquareFeet = minLotAcres > 0 ? Math.ceil(minLotAcres * 43_560) : 0;
  if (!address && !city && !state && !zipCode) return json({ error: "Please include a city, state, ZIP code, or property address." }, 400);
  const userReservation = await reserveUserPropertyRequest(env.DB, username);
  if (!userReservation.ok) return json({ error: `Your monthly Property Finder limit of ${userReservation.limit} request${userReservation.limit === 1 ? "" : "s"} has been reached.` }, 429);
  const allowedTypes = new Set(["Single Family", "Condo", "Townhouse", "Multi-Family", "Apartment", "Land"]);
  const propertyTypes = (filters.property_types ?? []).filter((type) => allowedTypes.has(type));
  const params = new URLSearchParams({ status: "Active", limit: "500" });
  if (zipCode) params.set("zipCode", zipCode);
  else if (address) { params.set("address", address); params.set("radius", String(Math.max(1, Math.min(100, Math.round(Number(filters.radius) || 20))))); }
  else { if (city) params.set("city", city); if (state) params.set("state", state); }
  if (propertyTypes.length) params.set("propertyType", propertyTypes.join("|"));
  if (filters.min_price != null || filters.max_price != null) params.set("price", `${Number(filters.min_price) || "*"}:${Number(filters.max_price) || "*"}`);
  if (filters.min_bedrooms != null) params.set("bedrooms", `${Math.max(0, Number(filters.min_bedrooms) || 0)}:*`);
  if (filters.min_bathrooms != null) params.set("bathrooms", `${Math.max(0, Number(filters.min_bathrooms) || 0)}:*`);
  if (minLotSquareFeet > 0) params.set("lotSize", `${minLotSquareFeet}:*`);
  const feedResponse = await rentCastFetch(env, `https://api.rentcast.io/v1/listings/sale?${params}`);
  if (!feedResponse) {
    await env.DB.prepare("UPDATE user_property_usage SET requests = MAX(0, requests - 1), updated_at = ? WHERE username = ? AND period = ?").bind(Date.now(), username, userReservation.period).run();
    return json({ error: "The site's 50-request monthly property-data limit has been reached." }, 429);
  }
  if (!feedResponse.ok) return json({ error: "The property service could not complete that search. Try a broader location or fewer filters." }, 502);
  const feedListings = await feedResponse.json() as Array<Record<string, unknown>>;
  const label = String(filters.label || prompt).trim().slice(0, 80);
  const created = await env.DB.prepare("INSERT INTO property_searches (owner, mode, label, city, state, zip_code, min_price, max_price, criteria, active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)")
    .bind(username, mode, label, city || address || null, state || null, zipCode || null, Number(filters.min_price) || null, Number(filters.max_price) || null, prompt, Date.now()).run();
  const searchId = Number(created.meta.last_row_id);
  const now = Date.now();
  let saved = 0;
  for (const item of feedListings.slice(0, 500)) {
    const hoa = item.hoa && typeof item.hoa === "object" ? Number((item.hoa as { fee?: unknown }).fee ?? 0) : 0;
    if (mode === "income" && hoa > 0) continue;
    const propertyType = String(item.propertyType ?? "").toLowerCase();
    if (propertyType.includes("mobile") || propertyType.includes("manufactured")) continue;
    if (state && String(item.state ?? "").toUpperCase() !== state) continue;
    if (minLotSquareFeet > 0 && Number(item.lotSize ?? 0) < minLotSquareFeet) continue;
    const sourceId = String(item.id ?? "");
    const address = String(item.formattedAddress ?? "");
    if (!sourceId || !address) continue;
    await env.DB.prepare(`INSERT INTO property_listings (source_id, search_id, mode, address, city, state, zip_code, property_type, price, bedrooms, bathrooms, square_feet, lot_size, days_on_market, status, listed_at, source_url, raw_json, first_seen_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(sourceId, searchId, mode, address, item.city ?? null, item.state ?? null, item.zipCode ?? null, item.propertyType ?? null, item.price ?? null, item.bedrooms ?? null, item.bathrooms ?? null, item.squareFootage ?? null, item.lotSize ?? null, item.daysOnMarket ?? null, item.status ?? null, item.listedDate ?? null, null, JSON.stringify(item), now, now).run();
    if (Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude))) await env.DB.prepare("INSERT INTO property_coordinates (source_id, search_id, latitude, longitude) VALUES (?, ?, ?, ?)").bind(sourceId, searchId, Number(item.latitude), Number(item.longitude)).run();
    saved++;
  }
  if (saved > 0) {
    if (mode === "income") await rankIncomeSearch(env, searchId);
    else await rankPrimarySearch(env, searchId);
  }
  return json({ ok: true, searchId, count: saved, label });
}

const approvedListingHosts = ["zillow.com", "redfin.com", "realtor.com", "homes.com", "trulia.com", "compass.com", "coldwellbankerhomes.com", "kw.com", "loopnet.com", "crexi.com"];

function approvedListingUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && approvedListingHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url : null;
  } catch { return null; }
}

function absoluteHttpsUrl(value: string, base: URL) {
  try {
    const url = new URL(value, base);
    return url.protocol === "https:" ? url.toString() : null;
  } catch { return null; }
}

async function findPropertyPhoto(request: Request, env: Env, username: string) {
  if (!env.OPENAI_API_KEY) return json({ error: "The AI connection is not configured." }, 503);
  const body = await request.json<{ sourceId?: string; searchId?: number }>();
  const sourceId = String(body.sourceId ?? "").slice(0, 300);
  const searchId = Number(body.searchId);
  const listing = await env.DB.prepare(`SELECT l.address, s.owner FROM property_listings l JOIN property_searches s ON s.id = l.search_id
    WHERE l.source_id = ? AND l.search_id = ? AND (s.owner = ? OR s.owner = 'shared')`).bind(sourceId, searchId, username).first<{ address: string; owner: string }>();
  if (!listing) return json({ error: "Property not found." }, 404);
  const cached = await env.DB.prepare("SELECT image_url, source_page_url FROM property_media WHERE source_id = ? AND search_id = ?").bind(sourceId, searchId).first<{ image_url: string; source_page_url: string }>();
  if (cached) return json(cached);

  const aiResponse = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.4-mini",
      instructions: "Find a current public real-estate listing page and its main exterior property photo for the exact US property address. Prefer Zillow, Redfin, Realtor.com, Homes.com, Trulia, Compass, Coldwell Banker, Keller Williams, LoopNet, or Crexi. Return only JSON in this form: {\"source_page_url\":\"https://...\",\"image_url\":\"https://...\"}. The image_url must point directly to a real image of that exact property, not a logo, map, avatar, or search result. Do not invent URLs. If you cannot verify the direct image, return an empty image_url.",
      input: listing.address,
      tools: [{ type: "web_search" }],
    }),
  });
  const aiPayload = await aiResponse.json() as { error?: { code?: string; type?: string; message?: string }; output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  if (!aiResponse.ok) return json({ error: safeOpenAIError(aiResponse.status, aiPayload) }, 502);
  let sourcePage: URL | null = null;
  let discoveredImage: string | null = null;
  try {
    const parsed = JSON.parse(responseText(aiPayload).replace(/^```json\s*/i, "").replace(/```\s*$/, "")) as { source_page_url?: string; image_url?: string };
    sourcePage = approvedListingUrl(String(parsed.source_page_url ?? ""));
    if (sourcePage && parsed.image_url) discoveredImage = absoluteHttpsUrl(String(parsed.image_url), sourcePage);
  } catch { sourcePage = null; }
  if (!sourcePage) return json({ error: "No approved listing page was found for this address." }, 404);

  if (discoveredImage) {
    await env.DB.prepare("INSERT INTO property_media (source_id, search_id, image_url, source_page_url, found_at) VALUES (?, ?, ?, ?, ?)")
      .bind(sourceId, searchId, discoveredImage, sourcePage.toString(), Date.now()).run();
    return json({ image_url: discoveredImage, source_page_url: sourcePage.toString() });
  }

  const pageResponse = await fetch(sourcePage.toString(), { headers: { "user-agent": "Mozilla/5.0 (compatible; PauliHQ/1.0; private property research)" }, redirect: "follow" });
  if (!pageResponse.ok) return json({ error: "The listing website blocked its preview image." }, 502);
  const finalPage = approvedListingUrl(pageResponse.url);
  if (!finalPage) return json({ error: "The listing redirected to an unsupported website." }, 502);
  const html = (await pageResponse.text()).slice(0, 1_500_000);
  const match = html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i);
  const imageUrl = match ? absoluteHttpsUrl(match[1].replaceAll("&amp;", "&"), finalPage) : null;
  if (!imageUrl) return json({ error: "That listing page does not expose a usable preview image." }, 404);
  await env.DB.prepare("INSERT INTO property_media (source_id, search_id, image_url, source_page_url, found_at) VALUES (?, ?, ?, ?, ?)")
    .bind(sourceId, searchId, imageUrl, finalPage.toString(), Date.now()).run();
  return json({ image_url: imageUrl, source_page_url: finalPage.toString() });
}

async function propertyImage(request: Request, env: Env, username: string) {
  const url = new URL(request.url);
  const sourceId = String(url.searchParams.get("sourceId") ?? "").slice(0, 300);
  const searchId = Number(url.searchParams.get("searchId"));
  const media = await env.DB.prepare(`SELECT m.image_url, m.source_page_url FROM property_media m
    JOIN property_searches s ON s.id = m.search_id WHERE m.source_id = ? AND m.search_id = ? AND (s.owner = ? OR s.owner = 'shared')`)
    .bind(sourceId, searchId, username).first<{ image_url: string; source_page_url: string }>();
  if (!media) return new Response("Image not found", { status: 404 });
  let imageUrl: URL;
  try {
    imageUrl = new URL(media.image_url);
    if (imageUrl.protocol !== "https:" || imageUrl.hostname === "localhost" || /^\d+\.\d+\.\d+\.\d+$/.test(imageUrl.hostname)) throw new Error("Unsupported image host");
  } catch { return new Response("Unsupported image", { status: 400 }); }
  const requestHeaders = { referer: media.source_page_url, accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36" };
  let upstream = await fetch(imageUrl.toString(), { headers: requestHeaders, redirect: "follow" });
  let contentType = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !contentType.startsWith("image/")) {
    upstream = await fetch(imageUrl.toString(), { headers: { accept: requestHeaders.accept, "user-agent": requestHeaders["user-agent"] }, redirect: "follow" });
    contentType = upstream.headers.get("content-type") ?? "";
  }
  if (!upstream.ok || !contentType.startsWith("image/")) return new Response("Image unavailable", { status: 502 });
  return new Response(upstream.body, { headers: { "content-type": contentType, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" } });
}

async function reserveRentCastRequest(db: D1Database) {
  const period = new Date().toISOString().slice(0, 7);
  await db.prepare("INSERT OR IGNORE INTO api_usage (service, period, requests, updated_at) VALUES ('rentcast', ?, 0, ?)").bind(period, Date.now()).run();
  const reservation = await db.prepare("UPDATE api_usage SET requests = requests + 1, updated_at = ? WHERE service = 'rentcast' AND period = ? AND requests < ?")
    .bind(Date.now(), period, monthlyRentCastRequestLimit).run();
  return Number(reservation.meta.changes ?? 0) === 1;
}

async function rentCastFetch(env: Env, url: string) {
  if (!env.RENTCAST_API_KEY || !url.startsWith("https://api.rentcast.io/")) return null;
  if (!(await reserveRentCastRequest(env.DB))) return null;
  return fetch(url, { headers: { "X-Api-Key": env.RENTCAST_API_KEY } });
}

async function reservePropertyResearchRequest(db: D1Database) {
  const period = new Date().toISOString().slice(0, 7);
  await db.prepare("INSERT OR IGNORE INTO api_usage (service, period, requests, updated_at) VALUES ('property_research', ?, 0, ?)").bind(period, Date.now()).run();
  const reservation = await db.prepare("UPDATE api_usage SET requests = requests + 1, updated_at = ? WHERE service = 'property_research' AND period = ? AND requests < ?")
    .bind(Date.now(), period, monthlyPropertyResearchLimit).run();
  return Number(reservation.meta.changes ?? 0) === 1;
}

async function reserveUserPropertyRequest(db: D1Database, username: string) {
  const period = new Date().toISOString().slice(0, 7);
  const configured = await db.prepare("SELECT monthly_limit FROM user_property_limits WHERE username = ?").bind(username).first<{ monthly_limit: number }>();
  const limit = configured?.monthly_limit ?? (username === "carsonpauli" ? 50 : 5);
  await db.prepare("INSERT OR IGNORE INTO user_property_usage (username, period, requests, updated_at) VALUES (?, ?, 0, ?)").bind(username, period, Date.now()).run();
  const reservation = await db.prepare("UPDATE user_property_usage SET requests = requests + 1, updated_at = ? WHERE username = ? AND period = ? AND requests < ?").bind(Date.now(), username, period, limit).run();
  return { ok: Number(reservation.meta.changes ?? 0) === 1, limit, period };
}

async function rankIncomeSearch(env: Env, searchId: number) {
  if (!env.OPENAI_API_KEY) return;
  const result = await env.DB.prepare("SELECT source_id, address, city, state, zip_code, property_type, price, bedrooms, bathrooms, square_feet, lot_size, days_on_market FROM property_listings WHERE search_id = ? AND mode = 'income' AND status = 'Active' AND (property_type IS NULL OR (lower(property_type) NOT LIKE '%mobile%' AND lower(property_type) NOT LIKE '%manufactured%')) ORDER BY last_seen_at DESC LIMIT 120").bind(searchId).all<Record<string, unknown>>();
  const candidates = result.results ?? [];
  if (!candidates.length) return;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.4-mini",
      instructions: "Lightly screen these US income-property listings for investment potential. Use only the supplied location, property type, price, bedrooms, bathrooms, square footage, lot size, and days on market. Provide a conservative estimated_monthly_income for comparison using broad market assumptions; it is a screening estimate, not verified rent. Calculate estimated_roi as estimated annual gross income divided by purchase price times 100. Favor price efficiency, useful size, and likely income potential. Never claim known tenants, occupancy, expenses, condition, exact unit count, cap rate, or verified rent. Return only valid JSON as an array with up to 50 objects: source_id (string), score (integer 0-100), estimated_monthly_income (positive integer), estimated_roi (number), summary (one short sentence that explains the ranking and says the income is estimated).",
      input: JSON.stringify(candidates),
    }),
  });
  if (!response.ok) {
    console.error("Property AI ranking failed", response.status);
    return;
  }
  const payload = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  try {
    const cleaned = responseText(payload).replace(/^```json\s*/i, "").replace(/```\s*$/, "");
    const rankings = JSON.parse(cleaned) as Array<{ source_id?: string; score?: number; estimated_monthly_income?: number; estimated_roi?: number; summary?: string }>;
    const valid = rankings.filter((item) => item.source_id && Number.isFinite(item.score) && Number.isFinite(item.estimated_monthly_income)).slice(0, 50);
    if (!valid.length) return;
    const now = Date.now();
    await env.DB.batch(valid.map((item) => {
      const listing = candidates.find((candidate) => candidate.source_id === item.source_id);
      const income = Math.max(0, Math.round(Number(item.estimated_monthly_income) || 0));
      const calculatedRoi = Number(listing?.price) > 0 ? income * 12 / Number(listing?.price) * 100 : 0;
      const roi = Number.isFinite(Number(item.estimated_roi)) ? Number(item.estimated_roi) : calculatedRoi;
      return env.DB.prepare("INSERT INTO property_ai_rankings (source_id, search_id, score, summary, estimated_monthly_income, estimated_roi, ranked_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_id, search_id) DO UPDATE SET score=excluded.score, summary=excluded.summary, estimated_monthly_income=excluded.estimated_monthly_income, estimated_roi=excluded.estimated_roi, ranked_at=excluded.ranked_at")
        .bind(item.source_id, searchId, Math.max(0, Math.min(100, Math.round(item.score ?? 0))), String(item.summary ?? "AI-ranked candidate with an estimated income range.").slice(0, 400), income, Math.max(0, Math.min(100, roi)), now);
    }));
  } catch (error) {
    console.error("Property AI ranking response was invalid", error);
  }
}

async function rankPrimarySearch(env: Env, searchId: number) {
  if (!env.OPENAI_API_KEY) return;
  const search = await env.DB.prepare("SELECT label, city, state, zip_code, min_price, max_price, criteria FROM property_searches WHERE id = ? AND mode = 'primary'").bind(searchId).first<{ label: string; city: string | null; state: string | null; zip_code: string | null; min_price: number | null; max_price: number | null; criteria: string | null }>();
  if (!search) return;
  const result = await env.DB.prepare("SELECT source_id, address, city, state, zip_code, property_type, price, bedrooms, bathrooms, square_feet, lot_size, days_on_market FROM property_listings WHERE search_id = ? AND mode = 'primary' AND status = 'Active' AND (property_type IS NULL OR (lower(property_type) NOT LIKE '%mobile%' AND lower(property_type) NOT LIKE '%manufactured%')) ORDER BY last_seen_at DESC LIMIT 100").bind(searchId).all<Record<string, unknown>>();
  const candidates = result.results ?? [];
  if (!candidates.length) return;
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: env.OPENAI_MODEL || "gpt-5.4-mini",
      instructions: "Compare primary-residence listings with the user's exact stated criteria. Use only the supplied criteria and listing facts. Never invent acreage, location, features, condition, commute, neighborhood quality, school quality, or other missing details. Treat words such as must, minimum, maximum, only, and at least as strict. Explicitly identify an important requested fact as unverified when the listing data does not provide it. Return only valid JSON as an array with up to 50 objects: source_id (string), score (integer 0-100), summary (one or two concise sentences describing the strongest matches, conflicts, and any important unverified criterion).",
      input: JSON.stringify({ criteria: search.criteria || search.label, savedFilters: { city: search.city, state: search.state, zipCode: search.zip_code, minPrice: search.min_price, maxPrice: search.max_price }, listings: candidates }),
    }),
  });
  if (!response.ok) { console.error("Primary property AI overview failed", response.status); return; }
  const payload = await response.json() as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  try {
    const rankings = JSON.parse(responseText(payload).replace(/^```json\s*/i, "").replace(/```\s*$/, "")) as Array<{ source_id?: string; score?: number; summary?: string }>;
    const sourceIds = new Set(candidates.map((candidate) => String(candidate.source_id)));
    const valid = rankings.filter((item) => item.source_id && sourceIds.has(String(item.source_id)) && Number.isFinite(Number(item.score)) && item.summary).slice(0, 50);
    if (!valid.length) return;
    const now = Date.now();
    await env.DB.batch(valid.map((item) => env.DB.prepare("INSERT INTO property_ai_rankings (source_id, search_id, score, summary, estimated_monthly_income, estimated_roi, ranked_at) VALUES (?, ?, ?, ?, NULL, NULL, ?) ON CONFLICT(source_id, search_id) DO UPDATE SET score=excluded.score, summary=excluded.summary, estimated_monthly_income=NULL, estimated_roi=NULL, ranked_at=excluded.ranked_at")
      .bind(String(item.source_id), searchId, Math.max(0, Math.min(100, Math.round(Number(item.score)))), String(item.summary).slice(0, 600), now)));
  } catch (error) { console.error("Primary property AI overview response was invalid", error); }
}

async function rankPropertySearch(request: Request, env: Env, username: string) {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (!env.OPENAI_API_KEY) return json({ error: "The AI connection is not configured." }, 503);
  const body = await request.json<{ searchId?: number }>();
  const searchId = Number(body.searchId);
  if (!Number.isInteger(searchId)) return json({ error: "Invalid property search." }, 400);
  const search = await env.DB.prepare("SELECT id, mode FROM property_searches WHERE id = ? AND (owner = ? OR owner = 'shared')").bind(searchId, username).first<{ id: number; mode: string }>();
  if (!search) return json({ error: "Property search not found." }, 404);
  if (search.mode === "income") await rankIncomeSearch(env, searchId);
  else await rankPrimarySearch(env, searchId);
  return json({ ok: true });
}

async function syncPropertyListings(env: Env, force = false) {
  if (!env.RENTCAST_API_KEY) return;
  await ensureSchema(env.DB);
  const searchResult = await env.DB.prepare(`SELECT s.id, s.mode, s.city, s.state, s.zip_code, s.min_price, s.max_price, s.last_synced_at, COALESCE(p.property_refresh, 'weekly') AS refresh_frequency
    FROM property_searches s LEFT JOIN user_preferences p ON p.username = s.owner WHERE s.active = 1`).all<{ id: number; mode: string; city: string | null; state: string | null; zip_code: string | null; min_price: number | null; max_price: number | null; last_synced_at: number | null; refresh_frequency: string }>();
  for (const search of searchResult.results ?? []) {
    const refreshInterval = search.refresh_frequency === "twice_daily" ? 12 * 60 * 60_000 : search.refresh_frequency === "daily" ? 24 * 60 * 60_000 : 7 * 24 * 60 * 60_000;
    if (!force && search.last_synced_at && Date.now() - search.last_synced_at < refreshInterval) continue;
    const params = new URLSearchParams({ limit: search.id === -100 ? "500" : "100", status: "Active" });
    if (search.id === -100) {
      params.set("address", "Bentonville, AR");
      params.set("radius", "40");
      params.set("propertyType", "Multi-Family|Apartment");
      params.set("price", "*:600000");
    } else if (search.zip_code) params.set("zipCode", search.zip_code);
    else {
      if (search.city) params.set("city", search.city);
      if (search.state) params.set("state", search.state);
    }
    if (search.id !== -100 && (search.min_price || search.max_price)) params.set("price", `${search.min_price ?? "*"}:${search.max_price ?? "*"}`);
    const response = await rentCastFetch(env, `https://api.rentcast.io/v1/listings/sale?${params}`);
    if (!response) {
      console.log("RentCast monthly request limit reached; property sync stopped.");
      break;
    }
    if (!response.ok) {
      console.error("Property feed request failed", search.id, response.status);
      continue;
    }
    const listings = await response.json() as Array<Record<string, unknown>>;
    const now = Date.now();
    for (const item of listings.slice(0, search.id === -100 ? 500 : 100)) {
      const hoa = item.hoa && typeof item.hoa === "object" ? Number((item.hoa as { fee?: unknown }).fee ?? 0) : 0;
      if (search.mode === "income" && hoa > 0) continue;
      const propertyType = String(item.propertyType ?? "").toLowerCase();
      if (propertyType.includes("mobile") || propertyType.includes("manufactured")) continue;
      const sourceId = String(item.id ?? "");
      const address = String(item.formattedAddress ?? "");
      if (!sourceId || !address) continue;
      await env.DB.prepare(`INSERT INTO property_listings (source_id, search_id, mode, address, city, state, zip_code, property_type, price, bedrooms, bathrooms, square_feet, lot_size, days_on_market, status, listed_at, source_url, raw_json, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_id, search_id) DO UPDATE SET price=excluded.price, days_on_market=excluded.days_on_market, status=excluded.status, raw_json=excluded.raw_json, last_seen_at=excluded.last_seen_at`)
        .bind(sourceId, search.id, search.mode, address, item.city ?? null, item.state ?? null, item.zipCode ?? null, item.propertyType ?? null, item.price ?? null, item.bedrooms ?? null, item.bathrooms ?? null, item.squareFootage ?? null, item.lotSize ?? null, item.daysOnMarket ?? null, item.status ?? null, item.listedDate ?? null, null, JSON.stringify(item), now, now).run();
      if (Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude))) {
        await env.DB.prepare("INSERT INTO property_coordinates (source_id, search_id, latitude, longitude) VALUES (?, ?, ?, ?) ON CONFLICT(source_id, search_id) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude")
          .bind(sourceId, search.id, Number(item.latitude), Number(item.longitude)).run();
      }
    }
    await env.DB.prepare("UPDATE property_searches SET last_synced_at = ? WHERE id = ?").bind(now, search.id).run();
    if (search.mode === "income") await rankIncomeSearch(env, search.id);
    else await rankPrimarySearch(env, search.id);
  }
  await env.DB.prepare("DELETE FROM property_listings WHERE mode = 'income' AND COALESCE(json_extract(raw_json, '$.hoa.fee'), 0) > 0").run();
  await env.DB.prepare("DELETE FROM property_listings WHERE lower(COALESCE(property_type, '')) LIKE '%mobile%' OR lower(COALESCE(property_type, '')) LIKE '%manufactured%'").run();
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

async function adminUsers(request: Request, env: Env, username: string) {
  if (!(await pageAccess(env, username, "user_management"))) return json({ error: "You do not have access to user management." }, 403);
  if (request.method === "GET") {
    const result = await env.DB.prepare("SELECT username, created_at FROM users ORDER BY created_at ASC").all();
    return json({ users: result.results ?? [] });
  }
  if (request.method === "DELETE") {
    if (username !== "carsonpauli") return json({ error: "Only Carson can delete users." }, 403);
    const body = await request.json<{ username?: string }>();
    const target = String(body.username ?? "").trim().toLowerCase();
    if (!target) return json({ error: "Choose a user to delete." }, 400);
    if (target === "carsonpauli") return json({ error: "Carson's owner account cannot be deleted." }, 400);
    const existing = await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(target).first();
    if (!existing) return json({ error: "User not found." }, 404);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM property_ai_rankings WHERE search_id IN (SELECT id FROM property_searches WHERE owner = ?)").bind(target),
      env.DB.prepare("DELETE FROM property_coordinates WHERE search_id IN (SELECT id FROM property_searches WHERE owner = ?)").bind(target),
      env.DB.prepare("DELETE FROM property_media WHERE search_id IN (SELECT id FROM property_searches WHERE owner = ?)").bind(target),
      env.DB.prepare("DELETE FROM property_favorites WHERE username = ? OR search_id IN (SELECT id FROM property_searches WHERE owner = ?)").bind(target, target),
      env.DB.prepare("DELETE FROM property_listings WHERE search_id IN (SELECT id FROM property_searches WHERE owner = ?)").bind(target),
      env.DB.prepare("DELETE FROM property_searches WHERE owner = ?").bind(target),
      env.DB.prepare("DELETE FROM portfolio_members WHERE username = ? OR property_id IN (SELECT id FROM portfolio_properties WHERE owner = ?)").bind(target, target),
      env.DB.prepare("DELETE FROM portfolio_properties WHERE owner = ?").bind(target),
      env.DB.prepare("DELETE FROM chat_messages WHERE username = ?").bind(target),
      env.DB.prepare("DELETE FROM workspace_items WHERE owner = ?").bind(target),
      env.DB.prepare("DELETE FROM list_items WHERE owner = ?").bind(target),
      env.DB.prepare("DELETE FROM user_page_permissions WHERE username = ?").bind(target),
      env.DB.prepare("DELETE FROM user_preferences WHERE username = ?").bind(target),
      env.DB.prepare("DELETE FROM user_property_limits WHERE username = ?").bind(target),
      env.DB.prepare("DELETE FROM user_property_usage WHERE username = ?").bind(target),
      env.DB.prepare("DELETE FROM sessions WHERE username = ?").bind(target),
      env.DB.prepare("DELETE FROM login_attempts WHERE username = ?").bind(target),
      env.DB.prepare("DELETE FROM users WHERE username = ?").bind(target),
    ]);
    return json({ ok: true, username: target });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const body = await request.json<{ username?: string; password?: string }>();
  const newUsername = String(body.username ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(newUsername)) return json({ error: "Use 3–32 lowercase letters, numbers, periods, underscores, or hyphens." }, 400);
  if (password.length < 12) return json({ error: "Use a temporary password with at least 12 characters." }, 400);
  const existing = await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(newUsername).first();
  if (existing) return json({ error: "That username already exists." }, 409);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await passwordHash(password, salt);
  await env.DB.prepare("INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)")
    .bind(newUsername, bytesToBase64(hash), bytesToBase64(salt), Date.now()).run();
  return json({ ok: true, username: newUsername }, 201);
}

async function adminAccess(request: Request, env: Env, username: string) {
  if (username !== "carsonpauli") return json({ error: "Only Carson can change page access." }, 403);
  if (request.method === "GET") {
    const users = await env.DB.prepare("SELECT username, created_at FROM users ORDER BY created_at ASC").all<{ username: string; created_at: number }>();
    const permissions = await env.DB.prepare("SELECT username, page_key, allowed FROM user_page_permissions").all<{ username: string; page_key: string; allowed: number }>();
    const limits = await env.DB.prepare("SELECT username, monthly_limit FROM user_property_limits").all<{ username: string; monthly_limit: number }>();
    const usage = await env.DB.prepare("SELECT username, requests FROM user_property_usage WHERE period = ?").bind(new Date().toISOString().slice(0, 7)).all<{ username: string; requests: number }>();
    return json({ users: (users.results ?? []).map((user) => ({ ...user, property_limit: (limits.results ?? []).find((item) => item.username === user.username)?.monthly_limit ?? (user.username === "carsonpauli" ? 50 : 5), property_usage: (usage.results ?? []).find((item) => item.username === user.username)?.requests ?? 0, permissions: user.username === "carsonpauli" ? Object.fromEntries(pageKeys.map((page) => [page, true])) : Object.fromEntries(pageKeys.map((page) => [page, (permissions.results ?? []).some((item) => item.username === user.username && item.page_key === page && item.allowed === 1)])) })) });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const body = await request.json<{ username?: string; permissions?: Record<string, boolean> }>();
  const target = String(body.username ?? "").trim().toLowerCase();
  if (!target || target === "carsonpauli") return json({ error: "Carson's owner access cannot be changed." }, 400);
  const user = await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(target).first();
  if (!user) return json({ error: "User not found." }, 404);
  const now = Date.now();
  await env.DB.batch(pageKeys.map((page) => env.DB.prepare("INSERT INTO user_page_permissions (username, page_key, allowed, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(username, page_key) DO UPDATE SET allowed=excluded.allowed, updated_at=excluded.updated_at").bind(target, page, body.permissions?.[page] ? 1 : 0, now)));
  return json({ ok: true });
}

async function adminPropertyLimit(request: Request, env: Env, username: string) {
  if (username !== "carsonpauli") return json({ error: "Only Carson can change Property Finder limits." }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const body = await request.json<{ username?: string; monthlyLimit?: number }>();
  const target = String(body.username ?? "").trim().toLowerCase();
  const monthlyLimit = Math.max(0, Math.min(50, Math.floor(Number(body.monthlyLimit))));
  if (!Number.isFinite(monthlyLimit)) return json({ error: "Enter a limit from 0 to 50." }, 400);
  const user = await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(target).first();
  if (!user) return json({ error: "User not found." }, 404);
  await env.DB.prepare("INSERT INTO user_property_limits (username, monthly_limit, updated_at) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET monthly_limit=excluded.monthly_limit, updated_at=excluded.updated_at").bind(target, monthlyLimit, Date.now()).run();
  return json({ ok: true, username: target, monthlyLimit });
}

async function adminPassword(request: Request, env: Env, username: string) {
  if (username !== "carsonpauli") return json({ error: "Only Carson can reset user passwords." }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const body = await request.json<{ username?: string; password?: string }>();
  const target = String(body.username ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  if (password.length < 12) return json({ error: "Use a temporary password with at least 12 characters." }, 400);
  const user = await env.DB.prepare("SELECT username FROM users WHERE username = ?").bind(target).first();
  if (!user) return json({ error: "User not found." }, 404);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await passwordHash(password, salt);
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE username = ?").bind(bytesToBase64(hash), bytesToBase64(salt), target),
    env.DB.prepare("DELETE FROM sessions WHERE username = ?").bind(target),
    env.DB.prepare("DELETE FROM login_attempts WHERE username = ?").bind(target),
  ]);
  return json({ ok: true, username: target });
}

async function profileSettings(request: Request, env: Env, username: string) {
  if (request.method === "GET") {
    const preference = await env.DB.prepare("SELECT property_refresh FROM user_preferences WHERE username = ?").bind(username).first<{ property_refresh: string }>();
    return json({ username, isAdmin: username === "carsonpauli", propertyRefresh: preference?.property_refresh ?? "weekly" });
  }
  if (username !== "carsonpauli") return json({ error: "Only Carson can change the property refresh schedule." }, 403);
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const body = await request.json<{ propertyRefresh?: string }>();
  const propertyRefresh = ["weekly", "daily", "twice_daily"].includes(String(body.propertyRefresh)) ? String(body.propertyRefresh) : "weekly";
  await env.DB.prepare("INSERT INTO user_preferences (username, property_refresh, updated_at) VALUES (?, ?, ?) ON CONFLICT(username) DO UPDATE SET property_refresh=excluded.property_refresh, updated_at=excluded.updated_at")
    .bind(username, propertyRefresh, Date.now()).run();
  return json({ ok: true, propertyRefresh });
}

async function changeOwnPassword(request: Request, env: Env, username: string) {
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
  const body = await request.json<{ currentPassword?: string; newPassword?: string }>();
  const currentPassword = String(body.currentPassword ?? "");
  const newPassword = String(body.newPassword ?? "");
  if (newPassword.length < 12) return json({ error: "Use a new password with at least 12 characters." }, 400);
  if (currentPassword === newPassword) return json({ error: "Choose a new password that is different from the current one." }, 400);
  const user = await env.DB.prepare("SELECT password_hash, salt FROM users WHERE username = ?").bind(username).first<{ password_hash: string; salt: string }>();
  if (!user || !secureEqual(await passwordHash(currentPassword, base64ToBytes(user.salt)), base64ToBytes(user.password_hash))) return json({ error: "The current password is incorrect." }, 401);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await passwordHash(newPassword, salt);
  const currentTokenHash = await sha256(cookieValue(request, "paulihq_session"));
  await env.DB.batch([
    env.DB.prepare("UPDATE users SET password_hash = ?, salt = ? WHERE username = ?").bind(bytesToBase64(hash), bytesToBase64(salt), username),
    env.DB.prepare("DELETE FROM sessions WHERE username = ? AND token_hash != ?").bind(username, currentTokenHash),
    env.DB.prepare("DELETE FROM login_attempts WHERE username = ?").bind(username),
  ]);
  return json({ ok: true });
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
      if (url.pathname === "/api/me") {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        return json({ username, isAdmin: username === "carsonpauli", permissions: await permissionsFor(env, username) });
      }
      if (url.pathname === "/api/admin/users") {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        return adminUsers(request, env, username);
      }
      if (url.pathname === "/api/admin/access") {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        return adminAccess(request, env, username);
      }
      if (url.pathname === "/api/admin/password") {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        return adminPassword(request, env, username);
      }
      if (url.pathname === "/api/admin/property-limit") {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        return adminPropertyLimit(request, env, username);
      }
      if (url.pathname === "/api/profile") {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        return profileSettings(request, env, username);
      }
      if (url.pathname === "/api/change-password") {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        return changeOwnPassword(request, env, username);
      }
      if (url.pathname.startsWith("/api/chat")) {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        if (!(await pageAccess(env, username, "assistant"))) return json({ error: "You do not have access to Assistant." }, 403);
        if (request.method === "GET") return chatHistory(env, username);
        if (request.method === "POST") return chat(request, env, username);
        return json({ error: "Method not allowed." }, 405);
      }
      if (url.pathname === "/api/ai-health") {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        if (!(await pageAccess(env, username, "assistant"))) return json({ error: "You do not have access to Assistant." }, 403);
        return aiHealth(env);
      }
      if (url.pathname === "/api/portfolio" || url.pathname === "/api/portfolio-users" || url.pathname === "/api/portfolio-weather") {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        if (url.pathname === "/api/portfolio-users" && request.method === "GET") return portfolioUsers(env);
        if (url.pathname === "/api/portfolio-weather" && request.method === "GET") return portfolioWeather(request, env, username);
        return portfolio(request, env, username);
      }
      if (url.pathname === "/api/portfolio-parcel") {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        return portfolioParcel(request, env, username);
      }
      if (url.pathname === "/api/address-autocomplete" || url.pathname === "/api/address-details" || url.pathname === "/api/portfolio-value") {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
        if (url.pathname === "/api/address-autocomplete") return addressAutocomplete(request, env);
        if (url.pathname === "/api/address-details") return addressDetails(request, env);
        return portfolioValuation(request, env);
      }
      if (url.pathname === "/api/property-searches" || url.pathname === "/api/properties" || url.pathname === "/api/properties/query" || url.pathname === "/api/properties/sync" || url.pathname === "/api/properties/rank" || url.pathname === "/api/property-photo" || url.pathname === "/api/property-image" || url.pathname === "/api/property-favorites") {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        if (!(await pageAccess(env, username, "properties"))) return json({ error: "You do not have access to Property Finder." }, 403);
        if (url.pathname === "/api/property-searches") return propertySearches(request, env, username);
        if (url.pathname === "/api/property-photo" && request.method === "POST") return findPropertyPhoto(request, env, username);
        if (url.pathname === "/api/property-image" && request.method === "GET") return propertyImage(request, env, username);
        if (url.pathname === "/api/property-favorites") return propertyFavorite(request, env, username);
        if (url.pathname === "/api/properties/query" && request.method === "POST") return aiPropertyQuery(request, env, username);
        if (url.pathname === "/api/properties/rank") return rankPropertySearch(request, env, username);
        if (url.pathname === "/api/properties/sync" && request.method === "POST") {
          ctx.waitUntil(syncPropertyListings(env, true));
          return json({ ok: true, message: "The weekly property scan has started." }, 202);
        }
        if (request.method === "GET") return propertyListings(request, env, username);
        return json({ error: "Method not allowed." }, 405);
      }
      if (url.pathname === "/api/property-research") {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        if (!(await pageAccess(env, username, "properties"))) return json({ error: "You do not have access to Parcel Scout." }, 403);
        return propertyResearch(request, env, username);
      }
      if (url.pathname === "/api/list-items" || url.pathname === "/api/lists/simplify" || url.pathname.startsWith("/api/list-items/")) {
        const username = await authenticated(request, env);
        if (!username) return json({ error: "Please log in again." }, 401);
        if (!(await pageAccess(env, username, "lists"))) return json({ error: "You do not have access to Lists." }, 403);
        if (url.pathname === "/api/list-items") return listItems(request, env, username);
        if (url.pathname === "/api/lists/simplify" && request.method === "POST") return simplifyList(request, env, username);
        const id = Number(url.pathname.split("/").pop());
        if (!Number.isInteger(id)) return json({ error: "Invalid list item." }, 400);
        return updateListItem(request, env, username, id);
      }
      if (url.pathname.startsWith("/profile")) {
        const username = await authenticated(request, env);
        if (!username) return Response.redirect(new URL("/login", request.url), 302);
      }
      if (url.pathname.startsWith("/admin/users")) {
        const username = await authenticated(request, env);
        if (!username) return Response.redirect(new URL("/login", request.url), 302);
        if (!(await pageAccess(env, username, "user_management"))) return Response.redirect(new URL("/portal", request.url), 302);
      }
      if (url.pathname.startsWith("/assistant") || url.pathname.startsWith("/properties") || url.pathname.startsWith("/parcel-scout") || url.pathname.startsWith("/lists")) {
        const username = await authenticated(request, env);
        if (!username) return Response.redirect(new URL("/login", request.url), 302);
        const page: PageKey = url.pathname.startsWith("/assistant") ? "assistant" : url.pathname.startsWith("/properties") || url.pathname.startsWith("/parcel-scout") ? "properties" : "lists";
        if (!(await pageAccess(env, username, page))) return Response.redirect(new URL("/portal", request.url), 302);
      }
      if ((url.pathname.startsWith("/portal") || url.pathname.startsWith("/assistant") || url.pathname.startsWith("/properties") || url.pathname.startsWith("/parcel-scout") || url.pathname.startsWith("/lists") || url.pathname.startsWith("/profile")) && !(await authenticated(request, env))) return Response.redirect(new URL("/login", request.url), 302);
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
