import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  activePropertyCandidates, nextPropertyRefresh, normalizePropertyFilters, northwestArkansasFilters,
  propertyAvailabilitySql, propertyFeedParams, propertySnapshotLifetimeMs, sourceSeenLifetimeMs,
} from "../worker/property-refresh.ts";

const now = Date.now();
const listing = (id, changes = {}) => ({
  id, formattedAddress: "84 Apple Lane, Fayetteville, AR 72701", state: "AR", city: "Fayetteville", zipCode: "72701",
  propertyType: "Multi-Family", price: 400_000, lotSize: 5 * 43_560, squareFootage: 2_500, bedrooms: 4, bathrooms: 3,
  status: "Active", lastSeenDate: new Date(now).toISOString(), listedDate: "2023-01-01T00:00:00.000Z", ...changes,
});

test("hard-revalidates all normalized limits and excludes absent values", () => {
  const filters = normalizePropertyFilters({ city: "Fayetteville", state: "ar", zipCode: "72701-1234", propertyTypes: ["Multi-Family"], minPrice: 350_000, maxPrice: 450_000,
    minBedrooms: 4, maxBedrooms: 4, minBathrooms: 2, maxBathrooms: 3, minLotSquareFeet: 5 * 43_560, minSquareFeet: 2_000 });
  const cases = [listing("valid"), listing("city", { city: "Springdale" }), listing("state", { state: "MO" }), listing("zip", { zipCode: "72702" }),
    listing("type", { propertyType: "Single Family" }), listing("price-min", { price: 349_999 }), listing("price", { price: 450_001 }), listing("no-price", { price: null }),
    listing("no-bed", { bedrooms: "" }), listing("too-many-beds", { bedrooms: 5 }), listing("bath", { bathrooms: 3.5 }),
    listing("bad-lot", { lotSize: 5 * 43_560 - 1 }), listing("no-lot", { lotSize: null }), listing("small-interior", { squareFootage: 1_999 }), listing("inactive", { status: "Inactive" }),
    listing("not-recently-seen", { lastSeenDate: new Date(now - sourceSeenLifetimeMs - 1).toISOString() }), listing("hoa", { hoa: { fee: 40 } })];
  assert.deepEqual(activePropertyCandidates(cases, 100, "income", now, filters).map((item) => item.id), ["valid"]);
  assert.equal(propertyFeedParams(filters, 100).get("bedrooms"), "4:4");
  assert.equal(propertyFeedParams(filters, 100).get("bathrooms"), "2:3");
  assert.equal(propertyFeedParams(filters, 100).get("squareFootage"), "2000:*");
  assert.equal(propertyFeedParams(filters, 100).get("zipCode"), "72701");
});

test("Northwest Arkansas feed only accepts Arkansas multifamily or apartment listings under the cap", () => {
  assert.equal(propertyFeedParams(northwestArkansasFilters, 500).get("status"), "Active");
  assert.equal(propertyFeedParams(northwestArkansasFilters, 500).get("limit"), "500");
  assert.equal(propertyFeedParams(northwestArkansasFilters, 500).get("propertyType"), "Multi-Family|Apartment");
  assert.deepEqual(activePropertyCandidates([listing("valid"), listing("another-city", { city: "Bentonville" }), listing("missouri", { state: "MO" }), listing("missing-state", { state: null }), listing("single-family", { propertyType: "Single Family" }), listing("price", { price: 600_001 })], 500, "income", now, northwestArkansasFilters).map((item) => item.id), ["valid", "another-city"]);
});

test("exact address does not invent a radius and unsupported or contradictory bounds are refused", () => {
  const filters = normalizePropertyFilters({ address: "84 Apple Ln, Fayetteville, AR, 72701", minBedrooms: 4 });
  assert.deepEqual(Object.fromEntries(propertyFeedParams(filters, 100)), { address: filters.address });
  assert.deepEqual(activePropertyCandidates([listing("match"), listing("different-address", { formattedAddress: "87 Apple Lane, Fayetteville, AR 72701" })], 50, "primary", now, filters).map((item) => item.id), ["match"]);
  assert.throws(() => normalizePropertyFilters({ state: "Arkansas" }), /state code/);
  assert.throws(() => normalizePropertyFilters({ state: "AR", minPrice: 400_000, maxPrice: 300_000 }), /minimum cannot exceed/);
  assert.throws(() => normalizePropertyFilters({ state: "AR", propertyTypes: ["Manufactured"] }), /supported property type/);
  assert.throws(() => activePropertyCandidates({ error: "not available" }, 100, "primary", now), /invalid result/);
  assert.throws(() => activePropertyCandidates([{ formattedAddress: "Incomplete" }], 100, "primary", now), /invalid listings/);
  assert.deepEqual(activePropertyCandidates([], 100, "primary", now), []);
});

test("weekly default, failed attempt cadence and UTC monthly reset are respected", () => {
  const at = Date.UTC(2026, 10, 20, 10);
  assert.equal(nextPropertyRefresh(null, at, null, null, at), at + propertySnapshotLifetimeMs);
  assert.equal(nextPropertyRefresh("daily", at, at + 1000, "failed", at), at + 1000 + 24 * 60 * 60_000);
  assert.equal(nextPropertyRefresh("twice_daily", at, null, null, at), at + 12 * 60 * 60_000);
  assert.equal(nextPropertyRefresh("weekly", at, at + 1000, "quota_reached", at), Date.UTC(2026, 11, 1));
  assert.equal(nextPropertyRefresh("weekly", null, at, "quota_reached", Date.UTC(2026, 11, 1)), null);
});

test("SQLite live availability excludes inactive, missing-from-snapshot, expired and old out-of-limit rows", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE searches (id INTEGER PRIMARY KEY, active INTEGER, source_filters TEXT, last_synced_at INTEGER, state TEXT, city TEXT, zip_code TEXT, min_price INTEGER, max_price INTEGER);
      CREATE TABLE listings (id TEXT, search_id INTEGER, status TEXT, last_seen_at INTEGER, raw_json TEXT, state TEXT, city TEXT, zip_code TEXT, property_type TEXT, price INTEGER);`);
    db.prepare("INSERT INTO searches VALUES (-100, 1, NULL, ?, 'AR', 'Bentonville', NULL, NULL, 600000), (1, 0, '{}', ?, NULL, NULL, NULL, NULL, NULL), (2, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL)")
      .run(now, now - 9 * 24 * 60 * 60_000);
    const insert = db.prepare("INSERT INTO listings VALUES (?, ?, ?, ?, ?, ?, 'Fayetteville', '72701', ?, ?)");
    insert.run("current", -100, "Active", now, "{}", "AR", "Multi-Family", 575_000);
    insert.run("missing", -100, "Active", now - 1000, "{}", "AR", "Multi-Family", 575_000);
    insert.run("wrong-state", -100, "Active", now, "{}", "MO", "Multi-Family", 575_000);
    insert.run("wrong-kind", -100, "Active", now, "{}", "AR", "Single Family", 575_000);
    insert.run("wrong-price", -100, "Active", now, "{}", "AR", "Multi-Family", 601_000);
    insert.run("inactive", -100, "Inactive", now, "{}", "AR", "Multi-Family", 575_000);
    insert.run("old-source", -100, "Active", now, JSON.stringify({ lastSeenDate: new Date(now - sourceSeenLifetimeMs - 60000).toISOString() }), "AR", "Multi-Family", 575_000);
    insert.run("expired", 1, "Active", now - 9 * 24 * 60 * 60_000, "{}", "AR", "Multi-Family", 575_000);
    insert.run("unsupported-old-ai", 2, "Active", now, "{}", "AR", "Multi-Family", 575_000);
    const rows = db.prepare(`SELECT l.id, ${propertyAvailabilitySql} AS availability FROM listings l JOIN searches s ON s.id = l.search_id`).all();
    assert.deepEqual(rows.filter((row) => row.availability === "active").map((row) => row.id), ["current"]);
    assert.deepEqual(rows.filter((row) => row.availability === "stale").map((row) => row.id), ["old-source", "expired"]);
    db.prepare("UPDATE searches SET last_synced_at = ? WHERE id = -100").run(now + 1000);
    assert.deepEqual(db.prepare(`SELECT l.id FROM listings l JOIN searches s ON s.id = l.search_id WHERE (${propertyAvailabilitySql}) = 'active'`).all(), []);
    assert.equal(db.prepare("SELECT count(*) AS count FROM listings").get().count, 9);
  } finally { db.close(); }
});
