import {
  createHmac,
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { lookup } from "node:dns/promises";
import https from "node:https";
import ipaddr from "ipaddr.js";
import { pool, tx } from "../../../packages/db/src/index.js";
function key() {
  const value = Buffer.from(process.env.WEBHOOK_ENCRYPTION_KEY || "", "hex");
  if (value.length !== 32) throw new Error("WEBHOOK_ENCRYPTION_KEY_REQUIRED");
  return value;
}
export function encryptSecret(secret: string) {
  const nonce = randomBytes(12),
    c = createCipheriv("aes-256-gcm", key(), nonce);
  return Buffer.concat([
    nonce,
    c.update(secret),
    c.final(),
    c.getAuthTag(),
  ]).toString("base64");
}
export function decryptSecret(secret: string) {
  const data = Buffer.from(secret, "base64"),
    c = createDecipheriv("aes-256-gcm", key(), data.subarray(0, 12));
  c.setAuthTag(data.subarray(-16));
  return Buffer.concat([
    c.update(data.subarray(12, -16)),
    c.final(),
  ]).toString();
}
export function allowedUrl(value: string) {
  const url = new URL(value);
  const allowed = (process.env.WEBHOOK_ALLOWED_HOSTS || "")
    .split(",")
    .filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !allowed.includes(url.hostname)
  )
    throw new Error("WEBHOOK_HOST_NOT_ALLOWED");
  return url;
}
export function signature(
  secret: string,
  id: string,
  timestamp: string,
  body: string,
) {
  return createHmac("sha256", secret)
    .update(`${id}.${timestamp}.${body}`)
    .digest("hex");
}
export async function deliverWebhooks() {
  const rows = await tx(async (c) => {
    const deliveries = await c.query(
      "SELECT d.*,e.url,e.secret FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id=d.endpoint_id AND e.enabled WHERE d.status IN ('pending','delivering') AND d.next_attempt_at<=now() AND d.attempts<8 ORDER BY d.next_attempt_at LIMIT 5 FOR UPDATE OF d SKIP LOCKED",
    );
    for (const d of deliveries.rows)
      await c.query(
        "UPDATE webhook_deliveries SET status='delivering',attempts=attempts+1,next_attempt_at=now()+interval '30 seconds' WHERE id=$1",
        [d.id],
      );
    return deliveries.rows;
  });
  for (const d of rows) {
    let code = 0;
    try {
      const url = allowedUrl(d.url),
        addresses = await lookup(url.hostname, { all: true });
      if (
        !addresses.length ||
        addresses.some((a) => ipaddr.process(a.address).range() !== "unicast")
      )
        throw new Error("PRIVATE_DESTINATION");
      const pinned = addresses[0];
      const body = JSON.stringify(d.payload),
        timestamp = String(Math.floor(Date.now() / 1000)),
        sig = signature(decryptSecret(d.secret), d.id, timestamp, body);
      code = await new Promise<number>((resolve, reject) => {
        const req = https.request(
          url,
          {
            method: "POST",
            lookup: (_host, _opts, cb: any) =>
              cb(null, pinned.address, pinned.family),
            timeout: 5000,
            headers: {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
              "x-codearena-event-id": d.id,
              "x-codearena-timestamp": timestamp,
              "x-codearena-signature": `v1=${sig}`,
            },
          },
          (res) => {
            resolve(res.statusCode || 0);
            res.destroy();
          },
        );
        req.on("timeout", () => req.destroy(new Error("TIMEOUT")));
        req.on("error", reject);
        req.end(body);
      });
    } catch {
      /* Fail closed on forbidden endpoints, DNS rebinding, network errors. */
    }
    await pool.query(
      "UPDATE webhook_deliveries SET response_code=$2,status=$3,next_attempt_at=now()+($4::int*interval '1 second') WHERE id=$1",
      [
        d.id,
        code,
        code >= 200 && code < 300
          ? "delivered"
          : d.attempts + 1 >= 8
            ? "dead_letter"
            : "pending",
        Math.min(3600, 2 ** (d.attempts + 1)),
      ],
    );
  }
  await pool.query(
    "UPDATE webhook_deliveries SET status='dead_letter' WHERE attempts>=8 AND status='delivering' AND next_attempt_at<now()",
  );
}
