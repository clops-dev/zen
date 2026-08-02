ALTER TABLE models 
  ADD COLUMN supports_tools BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN supports_vision BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN supports_json_mode BOOLEAN NOT NULL DEFAULT false;

-- Backfill common models

-- GPT-4 models: tool, vision, json
UPDATE models 
SET supports_tools = true, supports_vision = true, supports_json_mode = true 
WHERE model_id ILIKE '%gpt-4%';

-- Claude 3 models: tool, vision, json
UPDATE models 
SET supports_tools = true, supports_vision = true, supports_json_mode = true 
WHERE model_id ILIKE '%claude-3%';

-- Gemini 1.5/pro models: tool, vision, json
UPDATE models 
SET supports_tools = true, supports_vision = true, supports_json_mode = true 
WHERE model_id ILIKE '%gemini-1.5%';

-- Llama 3.1 and 3.3 models: tool, json (no vision for non-vision specific models typically)
UPDATE models 
SET supports_tools = true, supports_json_mode = true 
WHERE model_id ILIKE '%llama-3.1%' OR model_id ILIKE '%llama-3.3%';

-- Llama 3.2 Vision: tool, vision, json
UPDATE models 
SET supports_tools = true, supports_vision = true, supports_json_mode = true 
WHERE model_id ILIKE '%llama-3.2%vision%';
