export const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
export async function api(path: string, options: RequestInit = {}) {
  const token =
    typeof window !== "undefined" ? sessionStorage.getItem("ca_access") : null;
  const response = await fetch(API + path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || "Request failed");
  return data;
}
export async function stream(
  id: string,
  signal: AbortSignal,
  onEvent: (event: string, data: any) => void,
) {
  const token = sessionStorage.getItem("ca_access");
  const response = await fetch(`${API}/v1/submissions/${id}/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal,
  });
  if (!response.ok || !response.body)
    throw new Error("Could not connect to execution stream");
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = frame
        .split("\n")
        .find((x) => x.startsWith("event: "))
        ?.slice(7);
      const data = frame
        .split("\n")
        .find((x) => x.startsWith("data: "))
        ?.slice(6);
      if (event && data) onEvent(event, JSON.parse(data));
    }
  }
}
