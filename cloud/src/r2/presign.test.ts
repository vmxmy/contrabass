import { describe, expect, it } from "vitest";

import { createRunArtifactObjectKeys, presignR2PutURL, presignRunArtifactPutURLs } from "./presign";

const baseConfig = {
  accountId: "0123456789abcdef0123456789abcdef",
  accessKeyId: "test-access-key",
  secretAccessKey: "test-secret-key",
  bucketName: "contrabass-artifacts",
  now: new Date("2026-05-08T21:35:00.000Z"),
};

describe("presignR2PutURL", () => {
  it("generates a deterministic R2 S3 presigned PUT URL", async () => {
    const signedURL = await presignR2PutURL({
      ...baseConfig,
      objectKey: "teams/team-1/runs/run-1/artifacts/logs.ndjson",
      expiresInSec: 60,
    });

    const url = new URL(signedURL);

    expect(url.origin).toBe("https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
    expect(url.pathname).toBe("/contrabass-artifacts/teams/team-1/runs/run-1/artifacts/logs.ndjson");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "test-access-key/20260508/auto/s3/aws4_request",
    );
    expect(url.searchParams.get("X-Amz-Date")).toBe("20260508T213500Z");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("60");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Content-Sha256")).toBe("UNSIGNED-PAYLOAD");
    expect(url.searchParams.get("x-id")).toBe("PutObject");
    expect(url.searchParams.get("X-Amz-Signature")).toBe(
      "75870df6f302be10695c33ad55e0543b504eefcbd35152fe953b46b13aecfb43",
    );
  });

  it("encodes object key path segments without flattening folders", async () => {
    const signedURL = await presignR2PutURL({
      ...baseConfig,
      objectKey: "teams/team 1/runs/run+1/artifacts/diff patch.diff",
      expiresInSec: 120,
    });

    const url = new URL(signedURL);

    expect(url.pathname).toBe(
      "/contrabass-artifacts/teams/team%201/runs/run%2B1/artifacts/diff%20patch.diff",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("120");
  });

  it("rejects unsupported expiration windows", async () => {
    await expect(
      presignR2PutURL({
        ...baseConfig,
        objectKey: "teams/team-1/runs/run-1/artifacts/logs.ndjson",
        expiresInSec: 604801,
      }),
    ).rejects.toThrow("expiresInSec must be an integer between 1 and 604800");
  });
});

describe("presignRunArtifactPutURLs", () => {
  it("returns dispatch-shaped artifact URLs and matching completion object keys", async () => {
    const result = await presignRunArtifactPutURLs({
      ...baseConfig,
      teamId: "team-1",
      runId: "run-1",
      expiresInSec: 90,
      screenshotCount: 2,
    });

    expect(result.objectKeys).toEqual({
      logs: "teams/team-1/runs/run-1/artifacts/logs.ndjson",
      diff: "teams/team-1/runs/run-1/artifacts/diff.patch",
      summary: "teams/team-1/runs/run-1/artifacts/summary.md",
      screenshots: [
        "teams/team-1/runs/run-1/artifacts/screenshots/01.png",
        "teams/team-1/runs/run-1/artifacts/screenshots/02.png",
      ],
    });
    expect(result.urls.logs).toContain(
      "/contrabass-artifacts/teams/team-1/runs/run-1/artifacts/logs.ndjson?",
    );
    expect(result.urls.diff).toContain(
      "/contrabass-artifacts/teams/team-1/runs/run-1/artifacts/diff.patch?",
    );
    expect(result.urls.summary).toContain(
      "/contrabass-artifacts/teams/team-1/runs/run-1/artifacts/summary.md?",
    );
    expect(result.urls.screenshots).toHaveLength(2);
    expect(result.expiresAt).toBe("2026-05-08T21:36:30.000Z");
  });

  it("omits screenshots when no screenshot slots are requested", () => {
    expect(createRunArtifactObjectKeys({ teamId: "team-1", runId: "run-1" })).toEqual({
      logs: "teams/team-1/runs/run-1/artifacts/logs.ndjson",
      diff: "teams/team-1/runs/run-1/artifacts/diff.patch",
      summary: "teams/team-1/runs/run-1/artifacts/summary.md",
    });
  });
});
