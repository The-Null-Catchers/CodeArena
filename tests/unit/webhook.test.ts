import { describe, expect, it, afterEach } from "vitest";
import {
  allowedUrl,
  signature,
  encryptSecret,
  decryptSecret,
} from "../../apps/delivery-worker/src/webhooks.js";
afterEach(() => {
  delete process.env.WEBHOOK_ALLOWED_HOSTS;
  delete process.env.WEBHOOK_ENCRYPTION_KEY;
});
describe("webhook security", () => {
  it("rejects non-allowlisted destinations, insecure protocols and userinfo", () => {
    process.env.WEBHOOK_ALLOWED_HOSTS = "hooks.example.com";
    expect(allowedUrl("https://hooks.example.com/events").hostname).toBe(
      "hooks.example.com",
    );
    for (const u of [
      "http://hooks.example.com",
      "https://evil.example.com",
      "https://user:pass@hooks.example.com",
      "https://hooks.example.com:8443",
      "https://127.0.0.1",
    ])
      expect(() => allowedUrl(u)).toThrow();
  });
  it("authenticates event identity, timestamp, and exact body bytes", () => {
    const sig = signature("secret", "event", "100", '{"ok":true}');
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
    expect(signature("secret", "other", "100", '{"ok":true}')).not.toBe(sig);
    expect(signature("secret", "event", "101", '{"ok":true}')).not.toBe(sig);
    expect(signature("secret", "event", "100", '{ "ok":true}')).not.toBe(sig);
  });
  it("encrypts signing secrets with authenticated encryption and randomized nonces", () => {
    process.env.WEBHOOK_ENCRYPTION_KEY = "ab".repeat(32);
    const a = encryptSecret("secret"),
      b = encryptSecret("secret");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("secret");
    const altered = Buffer.from(a, "base64");
    altered[13] ^= 1;
    expect(() => decryptSecret(altered.toString("base64"))).toThrow();
  });
});
