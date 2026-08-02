import { z } from "zod";
const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough())]).nullable().optional(),
}).passthrough();

const payload1 = {
  role: "assistant",
  content: null,
  tool_calls: [{id: "123", type: "function", function: {name: "test", arguments: "{}"}}]
};

const payload2 = {
  role: "tool",
  tool_call_id: "123",
  content: "success"
};

const res1 = messageSchema.safeParse(payload1);
console.log("res1", res1.success, !res1.success ? res1.error.flatten() : res1.data);

const res2 = messageSchema.safeParse(payload2);
console.log("res2", res2.success, !res2.success ? res2.error.flatten() : res2.data);
