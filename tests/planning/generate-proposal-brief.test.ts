import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import type { IdeaBriefArtifact } from "../../src/core/operations/ideaInterview.js";
import {
  GenerateProposalBriefError,
  runGenerateProposalBrief
} from "../../src/core/operations/generateProposalBrief.js";
import {
  ARTIFACT_OWNERSHIP_REGISTRY,
  inferArtifactKindFromId
} from "../../src/core/spec/ownership.js";

function buildIdeaBrief(overrides?: Partial<IdeaBriefArtifact>): IdeaBriefArtifact {
  return {
    kind: "idea_brief",
    metadata: {
      artifact_id: "idea_brief",
      artifact_version: "v3",
      created_timestamp: "2026-03-12T00:00:00.000Z",
      generator: "operation.ideaInterview",
      source_refs: [],
      checksum: "c".repeat(64)
    },
    project_mode: "feature-proposal",
    buckets: {
      outcome: "Add feature-proposal mode for upstream contribution planning.",
      users_roles: "Maintainers and external contributors.",
      non_goals: "No automatic issue submission in v1.",
      inputs: "Approved idea brief inputs and target repository ownership.",
      outputs: "Proposal summary and a handoff draft.",
      workflow: "Capture proposal intent, request approval, then hand off for implementation.",
      interfaces: "CLI contract and markdown artifacts.",
      quality_bar: "Deterministic output and reviewable artifacts.",
      safety_compliance: "Do not imply approval or support that was not granted.",
      failure_modes: "Missing context or misrouted proposal draft.",
      evaluation: "Maintainers can review the proposal with minimal clarification.",
      operations: "Proposal flow remains bounded and auditable."
    },
    unresolved_assumptions: [],
    ...overrides
  };
}

describe("generateProposalBrief failure paths", () => {
  it("fails with a typed error when the idea_brief is missing", async () => {
    await expect(
      runGenerateProposalBrief({
        project_mode: "feature-proposal",
        idea_brief_status: "approved",
        repository_ownership: "owned"
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<GenerateProposalBriefError>>({
        code: "insufficient_idea_brief"
      })
    );
  });

  it("fails with a typed error when the mode is not feature-proposal", async () => {
    await expect(
      runGenerateProposalBrief({
        project_mode: "greenfield",
        idea_brief_status: "approved",
        repository_ownership: "owned",
        idea_brief: buildIdeaBrief({ project_mode: "greenfield" })
      })
    ).rejects.toEqual(
      expect.objectContaining<Partial<GenerateProposalBriefError>>({
        code: "invalid_mode"
      })
    );
  });
});

describe("generateProposalBrief success paths", () => {
  it("routes owned repositories to an issue draft and proposal approval gate", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-proposal-owned-"));

    const result = await runGenerateProposalBrief({
      project_mode: "feature-proposal",
      idea_brief_status: "accepted",
      repository_ownership: "owned",
      idea_brief: buildIdeaBrief(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T12:00:00.000Z")
    });

    expect(result.workflow.required_gate).toBe("proposal_approval");
    expect(result.workflow.repository_ownership).toBe("owned");
    expect(result.workflow.draft_channel).toBe("issue");
    expect(result.workflow.next_step).toBe("request_internal_proposal_approval");

    expect(result.proposal_summary.metadata.artifact_id).toBe("proposal_summary.md");
    expect(result.proposal_summary.metadata.artifact_version).toBe("v1");
    expect(result.proposal_draft.kind).toBe("proposal_issue_draft");
    expect(result.proposal_draft.metadata.artifact_id).toBe("proposal_issue.md");
    expect(result.proposal_draft.metadata.artifact_version).toBe("v1");

    const summaryOnDisk = await readFile(join(artifactDir, "proposal_summary.md"), "utf8");
    expect(summaryOnDisk).toContain("# Proposal Summary");
    expect(summaryOnDisk).toContain("## Problem");

    const issueDraftOnDisk = await readFile(join(artifactDir, "proposal_issue.md"), "utf8");
    expect(issueDraftOnDisk).toContain("# Proposal Issue Draft");
    expect(issueDraftOnDisk).toContain("## Requested Change");
  });

  it("routes external repositories to a discussion draft and preserves unresolved assumptions", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-proposal-external-"));

    const result = await runGenerateProposalBrief({
      project_mode: "feature-proposal",
      idea_brief_status: "approved",
      repository_ownership: "external",
      idea_brief: buildIdeaBrief({
        unresolved_assumptions: [
          {
            bucket_id: "interfaces",
            reason: "ambiguous",
            assumption: "Answer for interfaces is ambiguous: maintainer-owned integration surface is TBD"
          }
        ]
      }),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T12:15:00.000Z")
    });

    expect(result.workflow.repository_ownership).toBe("external");
    expect(result.workflow.draft_channel).toBe("discussion");
    expect(result.workflow.next_step).toBe("request_external_feedback");
    expect(result.proposal_draft.kind).toBe("proposal_discussion_draft");
    expect(result.proposal_draft.metadata.artifact_id).toBe("proposal_discussion.md");

    expect(result.proposal_summary.content).toContain(
      "Answer for interfaces is ambiguous: maintainer-owned integration surface is TBD"
    );
    expect(result.proposal_draft.content).toContain("I would like feedback before implementation.");

    const discussionDraftOnDisk = await readFile(
      join(artifactDir, "proposal_discussion.md"),
      "utf8"
    );
    expect(discussionDraftOnDisk).toContain("# Proposal Discussion Draft");
  });

  it("registers proposal artifacts in the ownership registry", () => {
    expect(ARTIFACT_OWNERSHIP_REGISTRY.proposal_summary.owner_operation).toBe(
      "operation.generateProposalBrief"
    );
    expect(ARTIFACT_OWNERSHIP_REGISTRY.proposal_draft.owner_operation).toBe(
      "operation.generateProposalBrief"
    );
    expect(inferArtifactKindFromId("proposal_summary.md")).toBe("proposal_summary");
    expect(inferArtifactKindFromId("proposal_issue.md")).toBe("proposal_draft");
    expect(inferArtifactKindFromId("proposal_discussion.md")).toBe("proposal_draft");
  });

  it("increments proposal artifact versions on subsequent runs", async () => {
    const artifactDir = await mkdtemp(join(tmpdir(), "specforge-proposal-version-"));

    await runGenerateProposalBrief({
      project_mode: "feature-proposal",
      idea_brief_status: "approved",
      repository_ownership: "owned",
      idea_brief: buildIdeaBrief(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T12:20:00.000Z")
    });

    const second = await runGenerateProposalBrief({
      project_mode: "feature-proposal",
      idea_brief_status: "approved",
      repository_ownership: "owned",
      idea_brief: buildIdeaBrief(),
      artifact_dir: artifactDir,
      created_timestamp: new Date("2026-03-12T12:25:00.000Z")
    });

    expect(second.proposal_summary.metadata.artifact_version).toBe("v2");
    expect(second.proposal_summary.metadata.parent_version).toBe("v1");
    expect(second.proposal_draft.metadata.artifact_version).toBe("v2");
    expect(second.proposal_draft.metadata.parent_version).toBe("v1");
  });
});
