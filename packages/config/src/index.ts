import { z } from "zod";
export const config = z
  .object({
    DATABASE_URL: z.string().url(),
    REDIS_URL: z.string().url(),
    JWT_SECRET: z.string().min(32),
    WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
    PORT: z.coerce.number().default(4000),
    WORKER_ID: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .default("worker-01"),
    WORKER_SLOTS: z.coerce.number().int().min(1).max(16).default(2),
    WORKER_MEMORY_MB: z.coerce.number().int().min(1024).default(2048),
  })
  .parse(process.env);
