/** Respect the real API's shared IP budget; never disable its rate limiter for CI.
 * Quota 429s have no Retry-After and must remain visible to authorization tests.
 */
export async function limitedFetch(url: string, options: RequestInit) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, options);
    const retryAfter = response.headers.get("retry-after");
    if (response.status !== 429 || retryAfter === null || attempt >= 2)
      return response;
    const seconds = Number(retryAfter);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 60)
      return response;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, (seconds + 0.1) * 1000));
  }
}
