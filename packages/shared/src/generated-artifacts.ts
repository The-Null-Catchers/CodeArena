import { createHash } from "node:crypto";
import tar from "tar-stream";

export const GENERATED_ARTIFACT_MAX_FILES = 10;
export const GENERATED_ARTIFACT_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const GENERATED_ARTIFACT_MAX_TOTAL_BYTES = 10 * 1024 * 1024;

export interface GeneratedArtifact {
  filename: string;
  mimeType: string;
  body: Buffer;
  sha256: string;
}

export interface GeneratedArtifactCapture {
  items: GeneratedArtifact[];
  rejected: number;
  limited: boolean;
}

function startsWithBytes(body: Buffer, signature: number[]) {
  return (
    body.length >= signature.length &&
    signature.every((value, index) => body[index] === value)
  );
}

export function inspectGeneratedArtifactMime(filename: string, body: Buffer) {
  if (startsWithBytes(body, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (startsWithBytes(body, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (body.subarray(0, 5).toString("ascii") === "%PDF-")
    return "application/pdf";

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const lower = filename.toLowerCase();
    if (lower.endsWith(".json")) {
      try {
        JSON.parse(text);
        return "application/json";
      } catch {
        return "text/plain; charset=utf-8";
      }
    }
    if (lower.endsWith(".csv")) return "text/csv; charset=utf-8";
    return "text/plain; charset=utf-8";
  } catch {
    return "application/octet-stream";
  }
}

function safeGeneratedFilename(name: string) {
  if (!name.startsWith("artifacts/")) return undefined;
  const filename = name.slice("artifacts/".length);
  if (
    !filename ||
    filename.length > 128 ||
    filename.includes("/") ||
    filename === "." ||
    filename === ".." ||
    /[\u0000-\u001f\u007f]/.test(filename)
  )
    return undefined;
  return filename;
}

export async function extractGeneratedArtifacts(
  archive: Buffer,
): Promise<GeneratedArtifactCapture> {
  const extract = tar.extract();
  const items: GeneratedArtifact[] = [];
  let rejected = 0;
  let limited = false;
  let acceptedBytes = 0;

  await new Promise<void>((resolve, reject) => {
    extract.on("entry", (header, stream, next) => {
      const filename = safeGeneratedFilename(header.name);
      const fileLike = header.type === "file";
      const size = Number(header.size || 0);
      const canAccept =
        fileLike &&
        Boolean(filename) &&
        items.length < GENERATED_ARTIFACT_MAX_FILES &&
        size >= 0 &&
        size <= GENERATED_ARTIFACT_MAX_FILE_BYTES &&
        acceptedBytes + size <= GENERATED_ARTIFACT_MAX_TOTAL_BYTES;

      if (!canAccept) {
        if (fileLike) rejected += 1;
        if (
          fileLike &&
          (items.length >= GENERATED_ARTIFACT_MAX_FILES ||
            size > GENERATED_ARTIFACT_MAX_FILE_BYTES ||
            acceptedBytes + size > GENERATED_ARTIFACT_MAX_TOTAL_BYTES)
        )
          limited = true;
        stream.resume();
        stream.once("end", next);
        stream.once("error", reject);
        return;
      }

      const chunks: Buffer[] = [];
      let seen = 0;
      let overflow = false;
      stream.on("data", (chunk: Buffer) => {
        seen += chunk.length;
        if (
          seen > GENERATED_ARTIFACT_MAX_FILE_BYTES ||
          acceptedBytes + seen > GENERATED_ARTIFACT_MAX_TOTAL_BYTES
        ) {
          overflow = true;
          limited = true;
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      stream.once("error", reject);
      stream.once("end", () => {
        if (overflow || seen !== size) {
          rejected += 1;
          next();
          return;
        }
        const body = Buffer.concat(chunks);
        acceptedBytes += body.length;
        items.push({
          filename: filename!,
          mimeType: inspectGeneratedArtifactMime(filename!, body),
          body,
          sha256: createHash("sha256").update(body).digest("hex"),
        });
        next();
      });
    });
    extract.once("finish", resolve);
    extract.once("error", reject);
    extract.end(archive);
  });

  return { items, rejected, limited };
}
