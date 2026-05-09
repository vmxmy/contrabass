import { describe, expect, it } from "vitest";

import workflowDemo from "../../../testdata/workflow.demo.md?raw";
import workflowLocal from "../../../testdata/workflow.local.md?raw";
import workflowMock from "../../../testdata/workflow.mock.md?raw";

import { isConfigParseError, parseWorkflowConfig } from "./parser";

type ParserParityCase = {
  name: string;
  content: string;
  expectedFrontMatter: Record<string, unknown>;
  expectedPromptContains: readonly string[];
};

describe("cloud workflow parser parity fixtures", () => {
  const cases: readonly ParserParityCase[] = [
    {
      name: "linear demo workflow",
      content: workflowDemo,
      expectedFrontMatter: {
        max_concurrency: 3,
        poll_interval_ms: 2000,
        max_retry_backoff_ms: 240000,
        model: "$CONTRABASS_MODEL",
        project_url: "$CONTRABASS_PROJECT_URL",
        agent_timeout_ms: 900000,
        stall_timeout_ms: 60000,
        tracker: { type: "linear", assignee_id: "$LINEAR_ASSIGNEE_ID" },
        codex: { binary_path: "codex app-server" },
      },
      expectedPromptContains: [
        "# Contrabass Demo Workflow",
        "{{ issue.title }}",
        "{{ issue.description }}",
        "{{ issue.url }}",
      ],
    },
    {
      name: "internal board local workflow",
      content: workflowLocal,
      expectedFrontMatter: {
        max_concurrency: 2,
        poll_interval_ms: 5000,
        max_retry_backoff_ms: 30000,
        model: "codex-mini",
        tracker: { type: "internal" },
        agent: { type: "codex" },
        codex: {
          binary_path: "codex app-server",
          approval_policy: "auto-edit",
          sandbox: "none",
        },
      },
      expectedPromptContains: [
        "# Contrabass Dogfood Task",
        "{{ workspace.path }}",
        "{{ issue.title }}",
        "{{ issue.description }}",
      ],
    },
    {
      name: "mock workflow",
      content: workflowMock,
      expectedFrontMatter: {
        max_concurrency: 3,
        poll_interval_ms: 2000,
        model: "mock",
        tracker: { type: "internal" },
        team: {
          max_workers: 3,
          max_fix_loops: 2,
        },
      },
      expectedPromptContains: [
        "# Mock Dogfood Task",
        "{{ workspace.path }}",
        "{{ issue.title }}",
        "{{ issue.description }}",
      ],
    },
  ];

  it("matches Go parser front matter and prompt trimming on shared WORKFLOW.md fixtures", () => {
    for (const testCase of cases) {
      const parsed = parseWorkflowConfig(testCase.content);

      expect(parsed.frontMatter, testCase.name).toMatchObject(testCase.expectedFrontMatter);
      expect(parsed.promptTemplate, testCase.name).toBe(parsed.promptTemplate.trim());
      for (const expectedPromptPart of testCase.expectedPromptContains) {
        expect(parsed.promptTemplate, testCase.name).toContain(expectedPromptPart);
      }
    }
  });

  it("keeps prompt-only and minimal front matter edge cases aligned with Go", () => {
    const casesWithExpectedPrompt: ReadonlyArray<{ name: string; content: string; expectedPrompt: string }> = [
      { name: "prompt only", content: "Fix the issue.\n", expectedPrompt: "Fix the issue." },
      { name: "opening delimiter only", content: "---", expectedPrompt: "" },
      { name: "opening delimiter newline", content: "---\n", expectedPrompt: "" },
      { name: "empty front matter block", content: "---\n---\n", expectedPrompt: "" },
    ];

    for (const testCase of casesWithExpectedPrompt) {
      expect(parseWorkflowConfig(testCase.content).promptTemplate, testCase.name).toBe(testCase.expectedPrompt);
    }
  });
});

describe("cloud workflow parser secret validation", () => {
  it("accepts tracker env references only when the secret is bound", () => {
    const content = "---\ntracker:\n  type: linear\n  token: $LINEAR_API_KEY\n---\nFix {{ issue.title }}.\n";

    expect(parseWorkflowConfig(content, { boundSecrets: ["LINEAR_API_KEY"] }).frontMatter).toMatchObject({
      tracker: { type: "linear", token: "$LINEAR_API_KEY" },
    });

    expect(() => parseWorkflowConfig(content)).toThrowError("config_invalid");
  });

  it("rejects any Liquid prompt reference under secrets", () => {
    const cases: ReadonlyArray<{ name: string; content: string }> = [
      { name: "direct secrets object", content: "---\ntracker:\n  type: internal\n---\n{{ secrets }}\n" },
      { name: "nested secret", content: "---\ntracker:\n  type: internal\n---\n{{ secrets.LINEAR_API_KEY }}\n" },
    ];

    for (const testCase of cases) {
      try {
        parseWorkflowConfig(testCase.content);
        throw new Error(`expected ${testCase.name} to fail`);
      } catch (error) {
        expect(isConfigParseError(error), testCase.name).toBe(true);
        if (isConfigParseError(error)) {
          expect(error.details, testCase.name).toEqual([{
            path: "prompt",
            message: "secrets are not allowed in prompts",
          }]);
        }
      }
    }
  });
});
