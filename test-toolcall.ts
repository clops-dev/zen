import { streamText, tool, jsonSchema } from 'ai';
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

  const todowrite = tool({
    description: 'Write a list of todos',
    parameters: jsonSchema({
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              status: { type: 'string' }
            }
          }
        }
      },
      required: ['todos']
    })
  });

  const result = streamText({
    model: openai('tencent/hy3:free'),
    messages: [{role: 'user', content: 'Write 2 todos using the todowrite tool. The todos should be about buying groceries and walking the dog.'}],
    tools: { todowrite },
    toolChoice: 'required',
    maxRetries: 0,
  });

  Promise.resolve(result.usage).catch(() => {});
  Promise.resolve(result.text).catch(() => {});

  try {
    for await (const chunk of result.fullStream) {
      console.log("CHUNK:", chunk.type, JSON.stringify(chunk));
    }
  } catch(e) {
    console.log("Error:", e);
  }
  process.exit(0);
}
run();
