-- Broaden backfill to hit models that we saw in the DB
UPDATE models 
SET supports_tools = true, supports_vision = true, supports_json_mode = true 
WHERE model_id ILIKE '%qwen%'
   OR model_id ILIKE '%openrouter/free%';
