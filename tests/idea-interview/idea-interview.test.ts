import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  IDEA_BUCKET_DEFINITIONS,
  runIdeaInterview
} from "../../src/core/skills/ideaInterview.js";

function buildCompleteAnswers(): Record<string, string> {
  const answers: Record<string, string> = {};
  for (const bucket of IDEA_BUCKET_DEFINITIONS) {
    answers[bucket.id] = `${bucket.label} clear answer`;
  }

  return answers;
}

describe("ideaInterview question planning", () => {
  it("asks questions only for missing or ambiguous buckets", async () => {
    const answers = buildCompleteAnswers();
    answers.non_goals = "TBD";
    answers.evaluation = "";

    const result = await runIdeaInterview({
      project_mode: "greenfield",
      answers,
      proceed_with_assumptions: false
    });

    expect(result.assessment.should_stop).toBe(false);
    expect(result.assessment.questions.map((question) => question.bucket_id)).toEqual([
      "non_goals",
      "evaluation"
    ]);
  });

  it("enforces maximum 10 questions per round", async () => {
    const result = await runIdeaInterview({
      project_mode: "greenfield",
      answers: {},
      proceed_with_assumptions: false
    });

    expect(result.assessment.questions).toHaveLength(10);
    expect(result.assessment.should_stop).toBe(false);
  });

  it("supports explicit proceed-with-assumptions flow", async () => {
    const answers = buildCompleteAnswers();
    answers.failure_modes = "maybe";
    answers.operations = "";

    const result = await runIdeaInterview({
      project_mode: "greenfield",
      answers,
      proceed_with_assumptions: true
    });

    expect(result.assessment.should_stop).toBe(true);
    expect(result.assessment.questions).toEqual([]);
    expect(result.assessment.unresolved_assumptions).toHaveLength(2);
  });

  it("stops when minimum required clarity is reached", async () => {
    const result = await runIdeaInterview({
      project_mode: "greenfield",
      answers: buildCompleteAnswers(),
      proceed_with_assumptions: false
    });

    expect(result.assessment.should_stop).toBe(true);
    expect(result.assessment.unresolved_assumptions).toEqual([]);
    expect(result.assessment.questions).toEqual([]);
  });

  it("records unresolved assumptions with deterministic reasons", async () => {
    const answers = buildCompleteAnswers();
    answers.workflow = "";
    answers.interfaces = "unknown";

    const result = await runIdeaInterview({
      project_mode: "greenfield",
      answers,
      proceed_with_assumptions: true
    });

    expect(result.assessment.unresolved_assumptions).toEqual([
      {
        bucket_id: "workflow",
        reason: "missing",
        assumption: "No answer was provided for workflow."
      },
      {
        bucket_id: "interfaces",
        reason: "ambiguous",
        assumption: "Answer for interfaces is ambiguous: unknown"
      }
    ]);
  });
});

describe("idea_brief artifact publishing", () => {
  it("writes idea_brief.json with required metadata and versions", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-idea-interview-"));
    const answers = buildCompleteAnswers();

    const first = await runIdeaInterview({
      project_mode: "greenfield",
      answers,
      proceed_with_assumptions: false,
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-08T12:00:00.000Z")
    });

    expect(first.artifact).toBeDefined();
    expect(first.artifact?.metadata.artifact_id).toBe("idea_brief");
    expect(first.artifact?.metadata.artifact_version).toBe("v1");
    expect(first.artifact?.metadata.parent_version).toBeUndefined();
    expect(first.artifact?.metadata.generator).toBe("skill.ideaInterview");
    expect(first.artifact?.metadata.created_timestamp).toBe("2026-03-08T12:00:00.000Z");
    expect(first.artifact?.metadata.checksum).toHaveLength(64);

    const second = await runIdeaInterview({
      project_mode: "greenfield",
      answers,
      proceed_with_assumptions: false,
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-08T12:10:00.000Z")
    });

    expect(second.artifact?.metadata.artifact_version).toBe("v2");
    expect(second.artifact?.metadata.parent_version).toBe("v1");

    const written = JSON.parse(
      await readFile(join(artifactDir, "idea_brief.json"), { encoding: "utf8" })
    );
    expect(written.metadata.artifact_id).toBe("idea_brief");
    expect(written.metadata.artifact_version).toBe("v2");
  });
});

