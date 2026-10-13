-- 20261013075730_llm_usage_reader.down.sql
-- Drops the grants and policies. The role itself is left in place: LOGIN
-- users created out-of-band are members of it, and dropping it would silently
-- strip their membership. Drop it by hand once those users are gone.

DROP POLICY teams_select_reader ON llm.teams;
DROP POLICY keys_select_reader ON llm.keys;
DROP POLICY usage_log_select_reader ON llm.usage_log;

REVOKE SELECT ON llm.teams FROM llm_usage_reader;
REVOKE SELECT ON llm.keys FROM llm_usage_reader;
REVOKE SELECT ON llm.usage_log FROM llm_usage_reader;
REVOKE USAGE ON SCHEMA llm FROM llm_usage_reader;
