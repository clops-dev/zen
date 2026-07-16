import { z } from "zod";
const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.union([z.string(), z.array(z.object({ type: z.string() }).passthrough())]).nullish(),
}).passthrough();
const parsed = messageSchema.safeParse({ role: "user", content: [{ type: "text", text: "hello" }] });
if (parsed.success) {
  console.log("Success:", JSON.stringify(parsed.data));
} else {
  console.log("Error:", parsed.error);
}
