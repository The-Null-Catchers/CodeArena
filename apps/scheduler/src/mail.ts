import nodemailer from "nodemailer";
import { pool, tx } from "../../../packages/db/src/index.js";
import { decryptSecret } from "./webhooks.js";
export async function deliverMail() {
  if (!process.env.SMTP_HOST) return;
  const mail = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 1025),
    secure: process.env.SMTP_SECURE === "true",
    ...(process.env.SMTP_USER
      ? {
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASSWORD,
          },
        }
      : {}),
  });
  const rows = await tx(async (c) => {
    const rows = await c.query(
      "SELECT * FROM mail_outbox WHERE status IN ('pending','delivering') AND next_attempt_at<=now() AND attempts<8 LIMIT 5 FOR UPDATE SKIP LOCKED",
    );
    for (const row of rows.rows)
      await c.query(
        "UPDATE mail_outbox SET status='delivering',attempts=attempts+1,next_attempt_at=now()+interval '60 seconds' WHERE id=$1",
        [row.id],
      );
    return rows.rows;
  });
  for (const row of rows) {
    let success = false;
    try {
      await mail.sendMail({
        from: process.env.SMTP_FROM || "CodeArena <no-reply@codearena.local>",
        to: row.recipient,
        subject: row.subject,
        text: decryptSecret(row.encrypted_body),
      });
      success = true;
    } catch {
      /* retry bounded outbox */
    }
    await pool.query(
      "UPDATE mail_outbox SET status=$2,next_attempt_at=now()+($3::int*interval '1 second') WHERE id=$1",
      [
        row.id,
        success
          ? "delivered"
          : row.attempts + 1 >= 8
            ? "dead_letter"
            : "pending",
        2 ** (row.attempts + 1),
      ],
    );
  }
}
