-- ADR 0003 §1: the proxy meters, the api prices. Each row now says which
-- upstream served it (provider_slug, the route's provider) and carries the
-- cost the provider reported in its response, raw (provider_cost; cortecs'
-- usage.cost, unit undocumented). Both are NULL on rows from before this
-- migration and provider_cost is NULL when the provider reports none.
-- cost_usd stays: it is the catalog estimate key holders still read on
-- GET /usage until they move to the api, never what anyone is charged.
ALTER TABLE usage_log ADD COLUMN provider_slug TEXT;
ALTER TABLE usage_log ADD COLUMN provider_cost REAL;
