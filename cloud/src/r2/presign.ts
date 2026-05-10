const R2_REGION = "auto";
const S3_SERVICE = "s3";
const AWS4_REQUEST = "aws4_request";
const SIGNING_ALGORITHM = "AWS4-HMAC-SHA256";
const MAX_PRESIGN_EXPIRES_SEC = 7 * 24 * 60 * 60;
const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";

export type ArtifactUploadURLs = {
  logs: string;
  diff: string;
  summary: string;
  screenshots?: string[];
};

export type ArtifactObjectKeys = {
  logs: string;
  diff: string;
  summary: string;
  screenshots?: string[];
};

export type R2PresignConfig = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucketName: string;
  endpoint?: string;
};

export type PresignPutURLOptions = R2PresignConfig & {
  objectKey: string;
  expiresInSec: number;
  now?: Date;
};

export type ArtifactPresignOptions = R2PresignConfig & {
  teamId: string;
  runId: string;
  expiresInSec: number;
  screenshotCount?: number;
  now?: Date;
};

export type ArtifactPresignResult = {
  urls: ArtifactUploadURLs;
  objectKeys: ArtifactObjectKeys;
  expiresAt: string;
};

export async function presignR2PutURL(options: PresignPutURLOptions): Promise<string> {
  validatePresignOptions(options);

  const now = options.now ?? new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${R2_REGION}/${S3_SERVICE}/${AWS4_REQUEST}`;
  const endpoint = r2Endpoint(options);
  const objectPath = `${encodePathSegment(options.bucketName)}/${encodeObjectKey(options.objectKey)}`;
  const url = new URL(`/${objectPath}`, endpoint);

  const signedHeaders = "host";
  const queryParams: Record<string, string> = {
    "X-Amz-Algorithm": SIGNING_ALGORITHM,
    "X-Amz-Content-Sha256": UNSIGNED_PAYLOAD,
    "X-Amz-Credential": `${options.accessKeyId}/${credentialScope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(options.expiresInSec),
    "X-Amz-SignedHeaders": signedHeaders,
    "x-id": "PutObject",
  };

  const canonicalQuery = canonicalQueryString(queryParams);
  const canonicalRequest = [
    "PUT",
    url.pathname,
    canonicalQuery,
    `host:${url.host}\n`,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join("\n");
  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = [SIGNING_ALGORITHM, amzDate, credentialScope, canonicalRequestHash].join("\n");
  const signingKey = await createSigningKey(options.secretAccessKey, dateStamp);
  const signature = await hmacHex(signingKey, stringToSign);

  url.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
  return url.toString();
}

export async function presignRunArtifactPutURLs(
  options: ArtifactPresignOptions,
): Promise<ArtifactPresignResult> {
  validateArtifactPresignOptions(options);

  const objectKeys = createRunArtifactObjectKeys(options);
  const shared = {
    accountId: options.accountId,
    accessKeyId: options.accessKeyId,
    secretAccessKey: options.secretAccessKey,
    bucketName: options.bucketName,
    endpoint: options.endpoint,
    expiresInSec: options.expiresInSec,
    now: options.now,
  };

  const [logs, diff, summary, screenshots] = await Promise.all([
    presignR2PutURL({ ...shared, objectKey: objectKeys.logs }),
    presignR2PutURL({ ...shared, objectKey: objectKeys.diff }),
    presignR2PutURL({ ...shared, objectKey: objectKeys.summary }),
    Promise.all(
      (objectKeys.screenshots ?? []).map((objectKey) => presignR2PutURL({ ...shared, objectKey })),
    ),
  ]);

  return {
    urls: screenshots.length > 0 ? { logs, diff, summary, screenshots } : { logs, diff, summary },
    objectKeys,
    expiresAt: new Date((options.now ?? new Date()).getTime() + options.expiresInSec * 1000).toISOString(),
  };
}

export function createRunArtifactObjectKeys(options: {
  teamId: string;
  runId: string;
  screenshotCount?: number;
}): ArtifactObjectKeys {
  const screenshotCount = options.screenshotCount ?? 0;
  if (!Number.isInteger(screenshotCount) || screenshotCount < 0 || screenshotCount > 32) {
    throw new Error("screenshotCount must be an integer between 0 and 32");
  }

  const prefix = `teams/${safePathPart(options.teamId, "teamId")}/runs/${safePathPart(options.runId, "runId")}`;
  const keys: ArtifactObjectKeys = {
    logs: `${prefix}/artifacts/logs.ndjson`,
    diff: `${prefix}/artifacts/diff.patch`,
    summary: `${prefix}/artifacts/summary.md`,
  };

  if (screenshotCount > 0) {
    keys.screenshots = Array.from({ length: screenshotCount }, (_, index) => {
      const imageNumber = String(index + 1).padStart(2, "0");
      return `${prefix}/artifacts/screenshots/${imageNumber}.png`;
    });
  }

  return keys;
}

function validatePresignOptions(options: PresignPutURLOptions): void {
  validateR2Config(options);
  if (
    options.objectKey.length === 0 ||
    options.objectKey.startsWith("/") ||
    /[\u0000-\u001f\u007f]/u.test(options.objectKey)
  ) {
    throw new Error("objectKey must be non-empty, relative, and free of control characters");
  }
  if (
    !Number.isInteger(options.expiresInSec) ||
    options.expiresInSec < 1 ||
    options.expiresInSec > MAX_PRESIGN_EXPIRES_SEC
  ) {
    throw new Error(`expiresInSec must be an integer between 1 and ${MAX_PRESIGN_EXPIRES_SEC}`);
  }
}

function validateArtifactPresignOptions(options: ArtifactPresignOptions): void {
  validatePresignOptions({ ...options, objectKey: "validation-placeholder" });
  safePathPart(options.teamId, "teamId");
  safePathPart(options.runId, "runId");
  createRunArtifactObjectKeys(options);
}

function validateR2Config(options: R2PresignConfig): void {
  if (!/^[a-f0-9]{32}$/iu.test(options.accountId)) {
    throw new Error("accountId must be a 32-character Cloudflare account id");
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u.test(options.bucketName)) {
    throw new Error("bucketName must be a DNS-compatible bucket name");
  }
  if (options.accessKeyId.length === 0) {
    throw new Error("accessKeyId is required");
  }
  if (options.secretAccessKey.length === 0) {
    throw new Error("secretAccessKey is required");
  }
}

function safePathPart(value: string, fieldName: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new Error(`${fieldName} must be URL-path safe`);
  }
  return value;
}

function r2Endpoint(options: R2PresignConfig): URL {
  const endpoint = options.endpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`;
  const url = new URL(endpoint);
  if (url.protocol !== "https:") {
    throw new Error("R2 endpoint must use https");
  }
  return url;
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\.\d{3}Z$/u, "Z");
}

function encodeObjectKey(objectKey: string): string {
  return objectKey.split("/").map(encodePathSegment).join("/");
}

function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalQueryString(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([key, value]) => [encodeRfc3986(key), encodeRfc3986(value)] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/gu,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

async function createSigningKey(secretAccessKey: string, dateStamp: string): Promise<CryptoKey> {
  const dateKey = await hmacBytes(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = await hmacBytes(dateKey, R2_REGION);
  const serviceKey = await hmacBytes(regionKey, S3_SERVICE);
  return hmacKey(await hmacBytes(serviceKey, AWS4_REQUEST));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8(value));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacBytes(key: string | Uint8Array, value: string): Promise<Uint8Array> {
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(key), utf8(value));
  return new Uint8Array(signature);
}

async function hmacHex(key: CryptoKey, value: string): Promise<string> {
  const signature = await crypto.subtle.sign("HMAC", key, utf8(value));
  return bytesToHex(new Uint8Array(signature));
}

async function hmacKey(key: string | Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? utf8(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
