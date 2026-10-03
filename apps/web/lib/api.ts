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


export async function downloadArtifact(id: string, filename: string) {
  const token =
    typeof window !== "undefined" ? sessionStorage.getItem("ca_access") : null;
  const response = await fetch(`${API}/v1/artifacts/${id}/download`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!response.ok) {
    let message = "Artifact download failed";
    try {
      const data = await response.json();
      message = data.error?.message || message;
    } catch {
      // Non-JSON error responses fall back to the generic download message.
    }
    throw new Error(message);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename || "artifact";
    anchor.rel = "noopener";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}
