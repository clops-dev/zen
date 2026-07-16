
import { z } from "zod";
const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough())]).nullish(),
}).passthrough();
const chatCompletionsSchema = z.object({
  model: z.string().optional(),
  messages: z.array(messageSchema).min(1),
  stream: z.boolean().default(false),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  tools: z.array(z.any()).optional(),
  tool_choice: z.any().optional(),
});
const result = chatCompletionsSchema.safeParse({
  messages: [
    { role: "tool", tool_call_id: "123", name: "bash", content: "hello" },
    { role: "assistant", tool_calls: [{ id: "123", type: "function", function: { name: "bash", arguments: "{}" } }] }
  ]
});
if (!result.success) {
  console.log(result.error.flatten());
} else {
  console.log("Success");
}
