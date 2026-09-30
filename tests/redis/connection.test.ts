import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Redis } from "ioredis";
import { redis, publish } from "../../packages/shared/src/events.js";
const admin = new Redis(process.env.REDIS_URL!, { commandTimeout: 10000 });
admin.on("error", () => {});
const id = crypto.randomUUID();
beforeAll(async () => {
  // The probe uses its own Redis instance; never pause the application broker here.
  if (redis.status !== "ready")
    await new Promise<void>((resolve) => redis.once("ready", resolve));
  await admin.ping();
});
afterAll(async () => {
  await admin.del(`events:${id}`);
  redis.disconnect();
  await admin.quit();
});
describe("bounded commands against a real Redis server", () => {
  it("publishes replayable events with an expiry", async () => {
    expect(await publish(id, "state", { state: "running" })).toBe(true);
    const rows = await redis.xrange(`events:${id}`, "-", "+");
    expect(rows[0][1]).toEqual([
      "type",
      "state",
      "data",
      '{"state":"running"}',
    ]);
    expect(await redis.ttl(`events:${id}`)).toBeGreaterThan(3500);
  });
  it("bounds publication when the connection stays open but Redis stops answering", async () => {
    await admin.call("CLIENT", "PAUSE", "4500", "ALL");
    const start = Date.now();
    expect(await publish(id, "output", { kind: "stdout", text: "probe" })).toBe(
      false,
    );
    expect(Date.now() - start).toBeLessThan(3000);
    await admin.ping();
    expect(await redis.ping()).toBe("PONG");
    expect(await publish(id, "state", { state: "completed" })).toBe(true);
  });
  it("rejects offline commands immediately and reconnects for later publication", async () => {
    const ended = new Promise<void>((resolve) => redis.once("end", resolve));
    redis.disconnect();
    await ended;
    const start = Date.now();
    expect(await publish(id, "state", {})).toBe(false);
    await expect(redis.ping()).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(500);
    await redis.connect();
    expect(await publish(id, "state", { state: "completed" })).toBe(true);
  });
});
