import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  IMAGES: { input(stream: ReadableStream): { transform(options: Record<string, unknown>): { output(options: { format: string; quality: number }): Promise<{ response(): Response }> } } };
  SETUP_CODE?: string;
}

interface ExecutionContext { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void; }

const encoder = new TextEncoder();
const approvedUsers = new Set(["carsonpauli", "jessipauli"]);

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
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 210_000 }, key, 256);
  return new Uint8Array(bits);
}

async function sha256(value: string) {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

async function ensureSchema(db: D1Database) {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, salt TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS login_attempts (username TEXT PRIMARY KEY, attempts INTEGER NOT NULL, last_attempt INTEGER NOT NULL);
  `);
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
  if (!token) return false;
  const row = await env.DB.prepare("SELECT username FROM sessions WHERE token_hash = ? AND expires_at > ?").bind(await sha256(token), Date.now()).first();
  return Boolean(row);
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
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/portal")) await ensureSchema(env.DB);
    if (request.method === "POST" && url.pathname === "/api/setup") return setup(request, env);
    if (request.method === "POST" && url.pathname === "/api/login") return login(request, env);
    if (request.method === "POST" && url.pathname === "/api/logout") return logout(request, env);
    if (url.pathname.startsWith("/portal") && !(await authenticated(request, env))) return Response.redirect(new URL("/login", request.url), 302);
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

export default worker;
