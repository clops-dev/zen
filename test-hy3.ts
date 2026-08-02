import { streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { sql } from './src/lib/db.ts';

async function run() {
  const providers = await sql`SELECT name, base_url, api_key FROM providers`;
  const p = providers.find(p => p.base_url.includes('openrouter'));
  
  const openai = createOpenAICompatible({
    name: 'test',
    baseURL: 'https://openrouter.ai/api/v1',
    headers: { Authorization: `Bearer ${p.api_key}` }
  });

  const result = streamText({
    model: openai('chabang/tencent/hy3:free'),
    messages: [{role: 'user', content: 'hello'}]
  });

  result.usage.catch(() => {});
  result.text.catch(() => {});

  try {
    for await (const chunk of result.fullStream) {
      console.log(chunk.type);
    }
  } catch(e) {
    console.log("Error:", e);
  }
  process.exit(0);
}
run();
