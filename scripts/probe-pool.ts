import { FreePoolRouter } from "../src/core/pool.js";

const router = new FreePoolRouter();
console.log("[probe] entries:", router.status().map((s) => s.name).join(", "));
try {
  const reply = await router.chat(
    [{ role: "user", content: "Reply with exactly this token and nothing else: POOL-OK" }],
    [],
  );
  console.log("[probe] reply:", JSON.stringify(reply.content));
} catch (err) {
  console.error("[probe] failed:", err instanceof Error ? err.message : err);
} finally {
  for (const s of router.status()) {
    console.log(`[probe] ${s.name}: healthy=${s.healthy} failures=${s.failures} lastError=${s.lastError || "-"}`);
  }
}
