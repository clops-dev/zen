import { streamText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';

const openai = createOpenAICompatible({
  name: 'test',
  baseURL: 'https://openrouter.ai/api/v1',
  headers: { Authorization: 'Bearer fake' }
});

const result = streamText({
  model: openai('openrouter/auto'),
  messages: [{role: 'user', content: 'hello'}]
});

// NO catch handlers

async function run() {
  try {
    for await (const chunk of result.fullStream) {
      console.log(chunk.type);
    }
  } catch(e) {
    console.log("Caught from stream:", e.message);
  }
}
run();
