CREATE TABLE IF NOT EXISTS portfolio_parcel_data (
  property_id INTEGER PRIMARY KEY,
  assessor_id TEXT,
  assessed_value INTEGER,
  land_value INTEGER,
  improvement_value INTEGER,
  assessment_year INTEGER,
  annual_tax INTEGER,
  tax_year INTEGER,
  legal_description TEXT,
  zoning TEXT,
  last_sale_price INTEGER,
  last_sale_date TEXT,
  refreshed_at INTEGER NOT NULL
);
