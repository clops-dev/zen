import { sql } from '../src/lib/db.ts';
import app from '../src/server.ts';

async function runE2E() {
  console.log('=== Starting End-to-End Enterprise Gateway & Model Verification ===');

  // 1. Get user and create an API key for testing
  const [user] = await sql`SELECT id FROM users LIMIT 1`;
  if (!user) {
    console.error('No user found in database');
    process.exit(1);
  }
  const { generateApiKey } = await import('../src/lib/apikeys.ts');
  const { raw, hash, prefix } = generateApiKey();
  await sql`
    INSERT INTO api_keys (user_id, key_hash, key_prefix, label, revoked)
    VALUES (${user.id}, ${hash}, ${prefix}, 'e2e-test-key', false)
  `;
  const { addCredits } = await import('../src/lib/credits.ts');
  await addCredits(user.id, 1000, 'admin_grant');
  const apiKey = raw;
  console.log(`Using API Key: ${prefix}...`);

  // 2. Test explicit model routing: gpt-5.1
  console.log('\n--- Test 1: Testing explicit model routing for gpt-5.1 ---');
  const res1 = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.1',
      messages: [{ role: 'user', content: `Say "GPT-5.1 READY ${Date.now()}" in exactly 4 words.` }],
      max_tokens: 32,
    }),
  });

  console.log('Test 1 HTTP status:', res1.status);
  const json1 = await res1.json();
  console.log('Test 1 response model:', (json1 as any).model);
  console.log('Test 1 content:', (json1 as any).choices?.[0]?.message?.content);

  if (res1.status !== 200 || !(json1 as any).model?.includes('gpt-5.1')) {
    console.error('Test 1 FAILED');
    process.exit(1);
  }
  console.log('Test 1 PASSED!');

  // 3. Test explicit model routing: gpt-4.1-mini
  console.log('\n--- Test 2: Testing explicit model routing for gpt-4.1-mini ---');
  const res2 = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [{ role: 'user', content: `Say "MINI READY ${Date.now()}" in exactly 3 words.` }],
      max_tokens: 32,
    }),
  });

  console.log('Test 2 HTTP status:', res2.status);
  const json2 = await res2.json();
  console.log('Test 2 response model:', (json2 as any).model);
  console.log('Test 2 content:', (json2 as any).choices?.[0]?.message?.content);

  if (res2.status !== 200 || !(json2 as any).model?.includes('gpt-4.1-mini')) {
    console.error('Test 2 FAILED');
    process.exit(1);
  }
  console.log('Test 2 PASSED!');

  // 4. Test Large Prompt Streaming with gpt-5.1 + keepalive verification
  console.log('\n--- Test 3: Large prompt streaming with gpt-5.1 (30k+ tokens) ---');
  const codeContext = `
export function processChunk(id: number) {
  const arr = Array.from({ length: 50 }, (_, i) => ({ id: i + id, active: true }));
  return arr.filter(x => x.id % 2 === 0);
}
`.repeat(500); // ~30,000 tokens

  console.log(`Payload size: ${codeContext.length} chars (approx ${Math.round(codeContext.length / 4)} tokens)`);
  const t0 = Date.now();

  const streamRes = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5.1',
      stream: true,
      max_tokens: 200,
      messages: [
        { role: 'system', content: 'You are an enterprise AI assistant. Be extremely concise.' },
        { role: 'user', content: `Context:\n${codeContext}\n\nTask: What does processChunk do? Answer in 1 sentence.` }
      ],
    }),
  });

  console.log('Stream HTTP status:', streamRes.status, `(headers received in ${Date.now() - t0}ms)`);
  if (streamRes.status !== 200) {
    console.error('Stream failed:', await streamRes.text());
    process.exit(1);
  }

  const reader = streamRes.body!.getReader();
  const decoder = new TextDecoder();
  let firstTokenMs = 0;
  let keepalivesReceived = 0;
  let textChunks = 0;
  let fullText = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    const chunkText = decoder.decode(value);
    
    // Check for keep-alives
    if (chunkText.includes(': keepalive')) {
      keepalivesReceived++;
      console.log(`[Keep-alive ping #${keepalivesReceived} received at ${Date.now() - t0}ms]`);
    }

    // Check for data chunks
    const lines = chunkText.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ') && line !== 'data: [DONE]') {
        try {
          const parsed = JSON.parse(line.slice(6));
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            if (!firstTokenMs) {
              firstTokenMs = Date.now() - t0;
              console.log(`\n>>> FIRST TOKEN ARRIVED in ${firstTokenMs}ms (${(firstTokenMs/1000).toFixed(2)}s) <<<`);
            }
            textChunks++;
            fullText += delta;
            process.stdout.write(delta);
          }
        } catch {}
      }
    }
  }

  const totalTime = Date.now() - t0;
  console.log(`\n\n--- Test 3 Results ---`);
  console.log(`Total duration: ${totalTime}ms (${(totalTime/1000).toFixed(2)}s)`);
  console.log(`First token latency: ${firstTokenMs}ms`);
  console.log(`Text chunks received: ${textChunks}`);
  console.log(`Keep-alives kept connection alive: ${keepalivesReceived}`);
  console.log(`Full answer: ${fullText.trim()}`);

  if (textChunks > 0 && fullText.length > 0) {
    console.log('\nALL ENTERPRISE VERIFICATION TESTS PASSED SUCCESSFULLY! 🚀');
    process.exit(0);
  } else {
    console.error('\nTest 3 FAILED: No output text generated.');
    process.exit(1);
  }
}

runE2E().catch(err => {
  console.error('Fatal error during E2E verification:', err);
  process.exit(1);
});
