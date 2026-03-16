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
    expect(markdown).toMatch(/src_api__[a-z0-9]{6}\["src\/api/);
    expect(markdown).toMatch(/repository --> src_api__[a-z0-9]{6}/);
    expect(markdown).toMatch(/repository --> src_cli__[a-z0-9]{6}/);
    expect(markdown).toContain("## Subsystem Relationship Diagram");
    expect(markdown).toMatch(/src_cli__[a-z0-9]{6} --> src_api__[a-z0-9]{6}/);
    expect(markdown).toMatch(/tests_api__[a-z0-9]{6} -.-> src_api__[a-z0-9]{6}/);
    expect(markdown).toContain("### Relationship Evidence");
    expect(markdown).toContain("src/cli -> src/api");
    expect(markdown).toContain("tests/api -> src/api");
    expect(markdown).toContain("src/api/routes.ts");
    expect(markdown).toContain("tests/api/routes.test.ts");
  });

  it("escapes mermaid labels and keeps node ids collision-safe", () => {
    const repoProfile = buildRepoProfile("/workspace/specforge");
    const architectureSummary = buildArchitectureSummary("/workspace/specforge");
    architectureSummary.subsystems = [
      {
        id: 'src/api<core>',
        label: 'src/api<core>',
        inferred_responsibility: 'API & "backend" <surface>',
        file_count: 1,
        evidence_refs: ["src/api/index.ts"],
        uncertainty: "medium"
      },
      {
        id: "src_api<core>",
        label: "src_api<core>",
        inferred_responsibility: "General subsystem",
        file_count: 1,
        evidence_refs: ["src_api/index.ts"],
        uncertainty: "medium"
      }
    ];

    const markdown = renderArchitectureDiagramsMarkdown(repoProfile, architectureSummary);
    const nodeIds = new Set(
      [...markdown.matchAll(/^\s{2}(src_api_core__[a-z0-9]{6})\[/gm)].map(([, nodeId]) => nodeId)
    );

    expect(nodeIds.size).toBe(2);
    expect(markdown).toContain("src/api&lt;core&gt;<br/>API &amp; &quot;backend&quot; &lt;surface&gt;");
    expect(markdown).not.toContain('src/api<core><br/>API & "backend" <surface>');
  });

  it("always emits fixed-width hash suffixes for mermaid node ids", () => {
    const repoProfile = buildRepoProfile("/workspace/specforge");
    const architectureSummary = buildArchitectureSummary("/workspace/specforge");
    architectureSummary.subsystems = [
      {
        id: "a",
        label: "a",
        inferred_responsibility: "General subsystem",
        file_count: 1,
        evidence_refs: ["a.ts"],
        uncertainty: "medium"
      }
    ];

    const markdown = renderArchitectureDiagramsMarkdown(repoProfile, architectureSummary);

    expect(markdown).toMatch(/a__[a-z0-9]{6}\["a<br\/>General subsystem"]/);
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
      extension_counts: [{ extension: ".ts", count: 4 }],
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
