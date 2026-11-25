export type Mode = "primary" | "income";
export type Sort = "roi" | "ai" | "lot" | "beds" | "baths" | "sqft" | "price_low" | "price_high";
export type PropertyView = { mode: Mode; sort: Sort; searchId?: number; starred: boolean };

export const defaultIncomeSearchId = -100;
const commonSorts: Sort[] = ["lot", "beds", "baths", "sqft", "price_low", "price_high"];

export function parsePropertyView(query: string): PropertyView {
  const params = new URLSearchParams(query);
  const mode = params.get("mode") === "primary" ? "primary" : "income";
  const defaultSort = mode === "primary" ? "ai" : "roi";
  const requestedSort = params.get("sort") as Sort | null;
  const sort = requestedSort && commonSorts.includes(requestedSort) ? requestedSort : defaultSort;
  const value = params.get("search");
  const searchId = value === String(defaultIncomeSearchId) && mode === "income" ? defaultIncomeSearchId
    : value && /^[1-9][0-9]*$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value)
    : value === null && mode === "income" ? defaultIncomeSearchId : undefined;
  return { mode, sort, searchId, starred: params.get("starred") === "1" };
}

export function propertyViewPath({ mode, sort, searchId, starred }: PropertyView) {
  const params = new URLSearchParams({ mode, sort, search: searchId === undefined ? "all" : String(searchId) });
  if (starred) params.set("starred", "1");
  return `/properties?${params}`;
}

export function propertyViewLoginPath(query: string) {
  return `/login?${new URLSearchParams({ propertyView: propertyViewPath(parsePropertyView(query)) })}`;
}

export function propertyViewAfterLogin(query: string) {
  const target = new URLSearchParams(query).get("propertyView");
  return target?.startsWith("/properties?") ? propertyViewPath(parsePropertyView(target.slice("/properties".length))) : "/portal";
}
