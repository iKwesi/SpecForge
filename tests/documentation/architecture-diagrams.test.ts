import { describe, expect, it } from "vitest";

import { renderArchitectureDiagramsMarkdown } from "../../src/core/operations/architectureDiagrams.js";
import type { ArchitectureSummaryArtifact } from "../../src/core/operations/mapArchitectureFromRepo.js";
import type { RepoProfileArtifact } from "../../src/core/operations/profileRepository.js";

describe("architecture diagram generation", () => {
  it("renders deterministic mermaid diagrams and evidence-backed subsystem relationships", () => {
    const repoProfile = buildRepoProfile("/workspace/specforge");
    const architectureSummary = buildArchitectureSummary("/workspace/specforge");

    const markdown = renderArchitectureDiagramsMarkdown(repoProfile, architectureSummary);

    expect(markdown).toContain("## System Context Diagram");
    expect(markdown).toContain("```mermaid");
    expect(markdown).toContain('repository["Repository"]');
    expect(markdown).toContain('src_api["src/api');
    expect(markdown).toContain("repository --> src_api");
    expect(markdown).toContain("repository --> src_cli");
    expect(markdown).toContain("## Subsystem Relationship Diagram");
    expect(markdown).toContain("src_cli --> src_api");
    expect(markdown).toContain("tests_api -.-> src_api");
    expect(markdown).toContain("### Relationship Evidence");
    expect(markdown).toContain("src/cli -> src/api");
    expect(markdown).toContain("tests/api -> src/api");
    expect(markdown).toContain("src/api/routes.ts");
    expect(markdown).toContain("tests/api/routes.test.ts");
  });
});

function buildRepoProfile(repositoryRoot: string): RepoProfileArtifact {
  return {
    kind: "repo_profile",
    metadata: {
      artifact_id: "repo_profile",
      artifact_version: "v1",
      created_timestamp: "2026-03-16T00:00:00.000Z",
      generator: "operation.profileRepository",
      source_refs: [],
      checksum: "a".repeat(64)
    },
    project_mode: "existing-repo",
    repository_root: repositoryRoot,
    scan: {
      max_files: 200,
      scanned_file_count: 4,
      truncated: false,
      ignored_directories: [".git", ".specforge"]
    },
    evidence: {
      top_level_entries: ["src", "tests"],
      sampled_files: [
        "src/api/routes.ts",
        "src/api/service.ts",
        "src/cli/main.ts",
        "tests/api/routes.test.ts"
      ],
      extension_counts: [
        { extension: ".test.ts", count: 1 },
        { extension: ".ts", count: 3 }
      ],
      detected_manifests: ["package.json"],
      detected_tooling: ["node", "typescript", "vitest"]
    }
  };
}

function buildArchitectureSummary(repositoryRoot: string): ArchitectureSummaryArtifact {
  return {
    kind: "architecture_summary",
    metadata: {
      artifact_id: "architecture_summary",
      artifact_version: "v1",
      created_timestamp: "2026-03-16T00:00:05.000Z",
      generator: "operation.mapArchitectureFromRepo",
      source_refs: [{ artifact_id: "repo_profile", artifact_version: "v1" }],
      checksum: "b".repeat(64)
    },
    project_mode: "existing-repo",
    repository_root: repositoryRoot,
    subsystems: [
      {
        id: "src/api",
        label: "src/api",
        inferred_responsibility: "API/backend surface",
        file_count: 2,
        evidence_refs: ["src/api/routes.ts", "src/api/service.ts"],
        uncertainty: "low"
      },
      {
        id: "src/cli",
        label: "src/cli",
        inferred_responsibility: "CLI entrypoints",
        file_count: 1,
        evidence_refs: ["src/cli/main.ts"],
        uncertainty: "medium"
      },
      {
        id: "tests/api",
        label: "tests/api",
        inferred_responsibility: "Test coverage",
        file_count: 1,
        evidence_refs: ["tests/api/routes.test.ts"],
        uncertainty: "medium"
      }
    ],
    summary_markdown: "# Architecture Summary"
  };
}
