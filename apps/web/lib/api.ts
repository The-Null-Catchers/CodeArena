import { connectSubmissionStream } from "./realtime";

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
  return connectSubmissionStream(
    `${API}/v1/submissions/${id}/events`,
    sessionStorage.getItem("ca_access") || "",
    signal,
    onEvent,
  );
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
