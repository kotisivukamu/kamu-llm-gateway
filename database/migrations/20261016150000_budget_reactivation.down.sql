-- 20261016150000_budget_reactivation.down.sql
DROP TRIGGER keys_reactivate_on_budget_raise ON llm.keys;
DROP FUNCTION llm.reactivate_on_budget_raise();
