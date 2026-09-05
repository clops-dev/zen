-- Migration 013: Allow custom provider base URLs (e.g. Azure OpenAI, local vLLM, Ollama, custom gateways).
--
-- Why this migration exists:
-- Migration 008/010 restricted openai-compatible providers to hardcoded URLs
-- ('https://openrouter.ai/api/v1', 'https://agentrouter.org/v1').
-- This migration drops those constraints so operators can register any valid HTTP/HTTPS
-- provider base URL (such as Azure OpenAI endpoints: https://zencodeaiamine.openai.azure.com/).

BEGIN;

ALTER TABLE providers
  DROP CONSTRAINT IF EXISTS providers_base_url_openai_compatible;

ALTER TABLE providers
  DROP CONSTRAINT IF EXISTS providers_base_url_anthropic_compatible;

COMMIT;
