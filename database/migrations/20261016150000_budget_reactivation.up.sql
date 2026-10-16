-- 20261016150000_budget_reactivation.up.sql
-- ADR 0003 §4: raising a key's budget puts an 'over_budget' key back to
-- 'active'. Ingest sets 'over_budget' when spend reaches budget_usd; this
-- trigger is the way back, so it holds for every writer of budget_usd (the
-- admin app, a future api route, a hand-run UPDATE) without each one having
-- to remember it. It fires only on a budget change and only for
-- 'over_budget' rows: 'revoked' is final and never touched, and an 'active'
-- key whose budget is lowered below its spend is flipped by ingest on its
-- next charged request, as any other key reaching its budget.

CREATE FUNCTION llm.reactivate_on_budget_raise() RETURNS trigger AS $$
BEGIN
  IF NEW.budget_usd IS NULL OR COALESCE(
    (SELECT spent_usd FROM llm.key_spend WHERE key_id = NEW.id), 0
  ) < NEW.budget_usd THEN
    NEW.status := 'active';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = llm, public;

CREATE TRIGGER keys_reactivate_on_budget_raise
  BEFORE UPDATE OF budget_usd ON llm.keys
  FOR EACH ROW
  WHEN (OLD.status = 'over_budget' AND NEW.status = 'over_budget')
  EXECUTE FUNCTION llm.reactivate_on_budget_raise();
