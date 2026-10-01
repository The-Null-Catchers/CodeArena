import type { Redis } from "ioredis";

export interface AdmissionBudget {
  key: string;
  limit: number;
  windowSeconds?: number;
}

export async function consumeAdmissionBudgets(
  redis: Redis,
  budgets: AdmissionBudget[],
) {
  if (!budgets.length) return;
  const keys = budgets.map((b) => `budget:submission:${b.key}`);
  const argv = budgets.flatMap((b) => [
    String(b.limit),
    String(b.windowSeconds ?? 60),
  ]);
  const script = `
    local maxRetry = 0
    for i,key in ipairs(KEYS) do
      local limit = tonumber(ARGV[(i-1)*2+1])
      local current = tonumber(redis.call('GET', key) or '0')
      if current >= limit then
        local remaining = redis.call('TTL', key)
        if remaining < 1 then remaining = tonumber(ARGV[(i-1)*2+2]) end
        if remaining > maxRetry then maxRetry = remaining end
        return {1,maxRetry}
      end
    end
    for i,key in ipairs(KEYS) do
      local ttl = tonumber(ARGV[(i-1)*2+2])
      local current = redis.call('INCR', key)
      if current == 1 then redis.call('EXPIRE', key, ttl) end
    end
    return {0,0}
  `;
  const result = (await redis.eval(
    script,
    keys.length,
    ...keys,
    ...argv,
  )) as [number, number];
  if (Number(result[0]) === 1)
    throw Object.assign(new Error("Submission rate limit exceeded"), {
      statusCode: 429,
      retryAfter: Math.max(1, Number(result[1]) || 60),
    });
}

export function tenantConcurrencyAvailable(active: number, maxConcurrent: number) {
  return active < maxConcurrent;
}
