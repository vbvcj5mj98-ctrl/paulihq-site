import assert from "node:assert/strict";
import test from "node:test";
import { parsePropertyView, propertyViewAfterLogin, propertyViewLoginPath, propertyViewPath } from "../app/properties/view.ts";
import { listingImageUrl, listingPageUrl, listingThumbnail, readListingBytes } from "../worker/listing-images.ts";

test("a Property Finder link restores its view after login without carrying private search content", () => {
  const view = { mode: "primary", sort: "lot", searchId: 25, starred: true };
  const path = propertyViewPath(view);
  assert.deepEqual(parsePropertyView(new URL(path, "https://example.test").search), view);
  const login = propertyViewLoginPath(path.slice("/properties".length) + "&prompt=private&session=secret");
  assert.doesNotMatch(login, /private|secret|prompt|session/);
  assert.equal(propertyViewAfterLogin(login.slice("/login".length)), path);
  assert.deepEqual(parsePropertyView(""), { mode: "income", sort: "roi", searchId: -100, starred: false });
  assert.deepEqual(parsePropertyView("?mode=primary&search=-100&sort=roi"), { mode: "primary", sort: "ai", searchId: undefined, starred: false });
  for (const query of ["search=all", "search=-3", "search=9007199254740992"]) assert.equal(parsePropertyView(query).searchId, undefined);
  for (const target of ["https://site.test/properties", "//site.test", "/portal", "/properties/extra"]) {
    assert.equal(propertyViewAfterLogin(new URLSearchParams({ propertyView: target }).toString()), "/portal");
  }
});

test("preview URLs are restricted to HTTPS listings and approved media hosts", () => {
  assert.equal(listingImageUrl("https://photos.zillowstatic.com/fp/sample.jpg#preview").href, "https://photos.zillowstatic.com/fp/sample.jpg");
  assert.equal(listingImageUrl("/images/sample.jpg", new URL("https://www.homes.com/property/1")).hostname, "www.homes.com");
  assert.equal(listingPageUrl("https://photos.zillowstatic.com/fp/sample.jpg"), null);
  for (const value of ["http://www.redfin.com/image", "https://www.redfin.com:993/image", "https://user:pwd@www.redfin.com/image", "https://www.redfin.com.example.test/image", "https://127.0.0.1/image", "https://unrelated.test/image"]) {
    assert.equal(listingImageUrl(value), null);
  }
});

test("a blocked or invalid photo fails softly and is not fetched twice", async (t) => {
  const cases = [
    () => new Response("Blocked", { status: 403 }),
    () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
    () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
    () => new Response(null, { status: 302, headers: { location: "https://unrelated.test/photo.jpg" } }),
    () => { throw new DOMException("Request timed out", "TimeoutError"); },
  ];
  const fetch = t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.redirect, "manual");
    assert.ok(options.signal instanceof AbortSignal);
    return cases.shift()();
  });
  for (let i = 0; i < 5; i++) {
    const response = await listingThumbnail("https://photos.zillowstatic.com/fp/sample.jpg", "https://www.zillow.com/listing");
    assert.equal(response.status, 204);
    assert.equal(response.headers.get("vary"), "Cookie");
    assert.equal(await response.text(), "");
  }
  assert.equal(fetch.mock.callCount(), 5);
});

test("a supported redirect can serve a bounded image without forwarding a listing path", async (t) => {
  const next = "https://photos.zillowstatic.com/fp/redirected.jpg";
  const content = Uint8Array.of(255, 216, 255, 217);
  const fetch = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.headers.get("referer"), "https://www.zillow.com/");
    return url.href === next ? new Response(content, { headers: { "content-type": "image/jpeg" } })
      : new Response(null, { status: 302, headers: { location: next } });
  });
  const response = await listingThumbnail("https://photos.zillowstatic.com/fp/source.jpg", "https://www.zillow.com/listing/example");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/jpeg");
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), content);
  assert.equal(fetch.mock.callCount(), 2);
  assert.equal(await readListingBytes(new Response("too many bytes"), 4), null);
  assert.equal(await readListingBytes(new Response("ok", { headers: { "content-length": "50" } }), 4), null);
});
