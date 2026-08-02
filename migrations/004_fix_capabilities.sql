-- 1. Revert the unsafe broad matches from 003
UPDATE models 
SET supports_tools = false, supports_vision = false, supports_json_mode = false 
WHERE model_id ILIKE '%qwen%' OR model_id ILIKE '%openrouter/free%';

-- 2. Apply explicit, verified capabilities for specific known models
-- qwen3-coder and qwen3-32b support tools and json mode, but NOT vision.
UPDATE models 
SET supports_tools = true, supports_json_mode = true, supports_vision = false
WHERE model_id IN ('qwen/qwen3-coder:free', 'qwen/qwen3-32b');
