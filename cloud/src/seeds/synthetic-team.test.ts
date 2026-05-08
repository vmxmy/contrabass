import { describe, expect, it } from "vitest";

import seedSql from "../../seeds/synthetic-team.sql?raw";

async function sha256Hex(content: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));

  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

describe("synthetic smoke team seed", () => {
  it("keeps the active config hash equal to the seeded YAML", async () => {
    const configMatch = seedSql.match(
      /INSERT INTO team_configs \([\s\S]*?\) VALUES \(\s*'synthetic-smoke',\s*1,\s*'([a-f0-9]{64})',\s*'([\s\S]*?)',\s*'system:seed'/,
    );

    expect(configMatch).not.toBeNull();
    if (configMatch === null) {
      throw new Error("seeded team config row not found");
    }
    const [, contentHash, contentYaml] = configMatch;
    expect(contentHash).toBe(await sha256Hex(contentYaml));
    expect(seedSql).toContain(`active_content_hash,\n  activated_at`);
    expect(seedSql).toContain(`'${contentHash}',\n  '2026-05-08T00:00:00.000Z'`);
  });

  it("seeds the rows smoke tests need to register, poll, and audit", () => {
    expect(seedSql).toContain("INSERT INTO team_configs");
    expect(seedSql).toContain("INSERT INTO team_configs_active");
    expect(seedSql).toContain("INSERT INTO internal_board");
    expect(seedSql).toContain("INSERT INTO worker_enrollments");
    expect(seedSql).toContain("INSERT INTO audit_log");
    expect(seedSql).toContain("'SMOKE-1'");
    expect(seedSql).toContain("'enroll_synthetic_smoke_mock_worker'");
    expect(seedSql).toContain("ON CONFLICT");
  });
});
