import { createHash, createHmac } from "node:crypto";

export interface StoredObject {
  key: string;
  size: number;
  sha256: string;
  contentType: string;
}

export interface ObjectStorage {
  ensureBucket(): Promise<void>;
  put(key: string, body: Buffer, contentType: string): Promise<StoredObject>;
  get(key: string): Promise<{ body: Buffer; contentType: string; size: number }>;
  remove(key: string): Promise<void>;
}

const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) =>
  createHmac("sha256", key).update(value).digest();

function encodePath(value: string) {
  return value
    .split("/")
    .map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) =>
      "%" + c.charCodeAt(0).toString(16).toUpperCase(),
    ))
    .join("/");
}

export class S3CompatibleStorage implements ObjectStorage {
  readonly endpoint: URL;
  readonly bucket: string;
  readonly region: string;
  readonly accessKey: string;
  readonly secretKey: string;

  constructor() {
    if (!process.env.OBJECT_STORAGE_ENDPOINT)
      throw new Error("OBJECT_STORAGE_ENDPOINT_REQUIRED");
    this.endpoint = new URL(process.env.OBJECT_STORAGE_ENDPOINT);
    this.bucket = process.env.OBJECT_STORAGE_BUCKET || "codearena";
    this.region = process.env.OBJECT_STORAGE_REGION || "us-east-1";
    this.accessKey = process.env.OBJECT_STORAGE_ACCESS_KEY || "";
    this.secretKey = process.env.OBJECT_STORAGE_SECRET_KEY || "";
    if (!this.accessKey || !this.secretKey)
      throw new Error("OBJECT_STORAGE_CREDENTIALS_REQUIRED");
  }

  private async request(
    method: string,
    key = "",
    body: Buffer = Buffer.alloc(0),
    contentType = "application/octet-stream",
  ) {
    const now = new Date();
    const amzDate = now
      .toISOString()
      .replace(/[:-]|\.\d{3}/g, "")
      .replace(".000", "");
    const date = amzDate.slice(0, 8);
    const payloadHash = sha256(body);
    const pathname = "/" + encodePath([this.bucket, key].filter(Boolean).join("/"));
    const canonicalHeaders =
      `content-type:${contentType}\nhost:${this.endpoint.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
    const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [
      method,
      pathname,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const scope = `${date}/${this.region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      amzDate,
      scope,
      sha256(canonicalRequest),
    ].join("\n");
    const kDate = hmac("AWS4" + this.secretKey, date);
    const kRegion = hmac(kDate, this.region);
    const kService = hmac(kRegion, "s3");
    const kSigning = hmac(kService, "aws4_request");
    const signature = createHmac("sha256", kSigning)
      .update(stringToSign)
      .digest("hex");
    const url = new URL(pathname, this.endpoint);
    return fetch(url, {
      method,
      headers: {
        "content-type": contentType,
        "x-amz-content-sha256": payloadHash,
        "x-amz-date": amzDate,
        authorization:
          `AWS4-HMAC-SHA256 Credential=${this.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      body: ["GET", "HEAD"].includes(method) ? undefined : body,
      signal: AbortSignal.timeout(10_000),
    });
  }

  async ensureBucket() {
    let lastStatus = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        const head = await this.request("HEAD");
        lastStatus = head.status;
        if (head.ok) return;
        if (head.status === 404) {
          const created = await this.request("PUT");
          lastStatus = created.status;
          if (created.ok || created.status === 409) return;
        } else if (head.status >= 400 && head.status < 500) {
          throw new Error(`OBJECT_STORAGE_HEAD_${head.status}`);
        }
      } catch (error) {
        if (attempt === 19) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`OBJECT_STORAGE_NOT_READY_${lastStatus}`);
  }

  async put(key: string, body: Buffer, contentType: string) {
    if (!key || key.startsWith("/") || key.includes(".."))
      throw new Error("INVALID_OBJECT_KEY");
    const response = await this.request("PUT", key, body, contentType);
    if (!response.ok) throw new Error(`OBJECT_STORAGE_PUT_${response.status}`);
    return { key, size: body.byteLength, sha256: sha256(body), contentType };
  }

  async get(key: string) {
    const response = await this.request("GET", key);
    if (response.status === 404) throw Object.assign(new Error("Artifact not found"), { statusCode: 404 });
    if (!response.ok) throw new Error(`OBJECT_STORAGE_GET_${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    return {
      body,
      size: body.byteLength,
      contentType: response.headers.get("content-type") || "application/octet-stream",
    };
  }

  async remove(key: string) {
    const response = await this.request("DELETE", key);
    if (!response.ok && response.status !== 404)
      throw new Error(`OBJECT_STORAGE_DELETE_${response.status}`);
  }
}

let storage: ObjectStorage | undefined;
export function objectStorage() {
  storage ??= new S3CompatibleStorage();
  return storage;
}

export function objectStorageEnabled() {
  return Boolean(process.env.OBJECT_STORAGE_ENDPOINT);
}
