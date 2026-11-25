import assert from "node:assert/strict";
import test from "node:test";

const { default: worker } = await import("../dist/server/index.js");
const env = { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) }, DB: {} };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const origin = "https://paulihq.test";

test("the public Pauli HQ page renders a sign-in form", async () => {
  const response = await worker.fetch(new Request(`${origin}/`, { headers: { accept: "text/html" } }), env, ctx);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Pauli HQ<\/title>/);
  assert.match(html, /name="username"/);
  assert.match(html, /name="password"/);
  assert.doesNotMatch(html, /codex-preview|building your site/i);
});

test("the private Photo Drop page does not render for visitors without a session", async () => {
  const response = await worker.fetch(new Request(`${origin}/photo-drop`), env, ctx);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), `${origin}/login`);
});

test("a Property Finder bookmark points to the selected view after sign-in", async () => {
  const view = "/properties?mode=primary&sort=lot&search=all&starred=1";
  const response = await worker.fetch(new Request(`${origin}${view}&prompt=discard-this`), env, ctx);
  assert.equal(response.status, 302);
  const login = new URL(response.headers.get("location"));
  assert.equal(login.origin, origin);
  assert.equal(login.pathname, "/login");
  assert.equal(login.searchParams.get("propertyView"), view);
  assert.equal(login.searchParams.size, 1);
});
