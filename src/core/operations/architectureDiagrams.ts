import type { ArchitectureSubsystem, ArchitectureSummaryArtifact } from "./mapArchitectureFromRepo.js";
import type { RepoProfileArtifact } from "./profileRepository.js";

type RelationshipKind = "likely invokes" | "validates";
type RelationshipStyle = "solid" | "dashed";

interface ArchitectureRelationship {
  source_subsystem_id: string;
  target_subsystem_id: string;
  kind: RelationshipKind;
  style: RelationshipStyle;
  evidence_refs: string[];
}

/**
 * Render deterministic Mermaid diagrams from bounded inspect artifacts. The
 * diagrams stay conservative: they show repository context, clearly justified
 * subsystem relationships, and the evidence refs behind each inferred edge.
 */
export function renderArchitectureDiagramsMarkdown(
  repoProfile: RepoProfileArtifact,
  architectureSummary: ArchitectureSummaryArtifact
): string {
  const sortedSubsystems = [...architectureSummary.subsystems].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const relationships = inferArchitectureRelationships(sortedSubsystems);
  const lines: string[] = [
    "## System Context Diagram",
    "",
    `Generated from ${repoProfile.metadata.artifact_id}@${repoProfile.metadata.artifact_version} and ${architectureSummary.metadata.artifact_id}@${architectureSummary.metadata.artifact_version}.`,
    "",
    "```mermaid",
    "flowchart LR",
    '  repository["Repository"]'
  ];

  for (const subsystem of sortedSubsystems) {
    lines.push(`  ${toMermaidNodeId(subsystem.id)}["${toMermaidLabel(subsystem)}"]`);
  }
  for (const subsystem of sortedSubsystems) {
    lines.push(`  repository --> ${toMermaidNodeId(subsystem.id)}`);
  }

  lines.push("```", "", "## Subsystem Relationship Diagram", "", "```mermaid", "flowchart LR");

  for (const subsystem of sortedSubsystems) {
    lines.push(`  ${toMermaidNodeId(subsystem.id)}["${toMermaidLabel(subsystem)}"]`);
  }
  for (const relationship of relationships) {
    lines.push(renderRelationshipEdge(relationship));
  }

  lines.push("```", "", "### Relationship Evidence");
  if (relationships.length === 0) {
    lines.push("- none inferred from bounded inspect evidence.");
  } else {
    for (const relationship of relationships) {
      const arrow = `${relationship.source_subsystem_id} -> ${relationship.target_subsystem_id}`;
      lines.push(
        `- ${arrow} (${relationship.kind}): ${relationship.evidence_refs.join(", ")}`
      );
    }
  }

  return lines.join("\n").trimEnd();
}

function inferArchitectureRelationships(
  subsystems: ArchitectureSubsystem[]
): ArchitectureRelationship[] {
  const runtimeSubsystems = subsystems.filter((subsystem) => !isTestCoverageSubsystem(subsystem));
  const relationships: ArchitectureRelationship[] = [];

  for (const source of runtimeSubsystems) {
    for (const target of runtimeSubsystems) {
      if (source.id === target.id) {
        continue;
      }

      if (isCliSubsystem(source) && isApiSubsystem(target)) {
        relationships.push({
          source_subsystem_id: source.id,
          target_subsystem_id: target.id,
          kind: "likely invokes",
          style: "solid",
          evidence_refs: sortUniqueStrings([...source.evidence_refs, ...target.evidence_refs])
        });
      }
    }
  }

  for (const testSubsystem of subsystems.filter(isTestCoverageSubsystem)) {
    const matchingRuntime = runtimeSubsystems.find(
      (runtimeSubsystem) => subsystemLeaf(runtimeSubsystem.id) === subsystemLeaf(testSubsystem.id)
    );
    if (!matchingRuntime) {
      continue;
    }

    relationships.push({
      source_subsystem_id: testSubsystem.id,
      target_subsystem_id: matchingRuntime.id,
      kind: "validates",
      style: "dashed",
      evidence_refs: sortUniqueStrings([
        ...testSubsystem.evidence_refs,
        ...matchingRuntime.evidence_refs
      ])
    });
  }

  return relationships
    .sort(compareRelationships)
    .filter((relationship, index, allRelationships) => {
      const previous = allRelationships[index - 1];
      return (
        !previous ||
        previous.source_subsystem_id !== relationship.source_subsystem_id ||
        previous.target_subsystem_id !== relationship.target_subsystem_id ||
        previous.kind !== relationship.kind
      );
    });
}

function isTestCoverageSubsystem(subsystem: ArchitectureSubsystem): boolean {
  return subsystem.id.startsWith("tests/") || subsystem.inferred_responsibility === "Test coverage";
}

function isCliSubsystem(subsystem: ArchitectureSubsystem): boolean {
  return subsystem.inferred_responsibility === "CLI entrypoints" || subsystem.id.endsWith("/cli");
}

function isApiSubsystem(subsystem: ArchitectureSubsystem): boolean {
  return (
    subsystem.inferred_responsibility === "API/backend surface" || subsystem.id.endsWith("/api")
  );
}

function subsystemLeaf(subsystemId: string): string {
  const segments = subsystemId.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? subsystemId;
}

function compareRelationships(left: ArchitectureRelationship, right: ArchitectureRelationship): number {
  const sourceComparison = left.source_subsystem_id.localeCompare(right.source_subsystem_id);
  if (sourceComparison !== 0) {
    return sourceComparison;
  }

  const targetComparison = left.target_subsystem_id.localeCompare(right.target_subsystem_id);
  if (targetComparison !== 0) {
    return targetComparison;
  }

  return left.kind.localeCompare(right.kind);
}

function renderRelationshipEdge(relationship: ArchitectureRelationship): string {
  const sourceId = toMermaidNodeId(relationship.source_subsystem_id);
  const targetId = toMermaidNodeId(relationship.target_subsystem_id);
  if (relationship.style === "dashed") {
    return `  ${sourceId} -.-> ${targetId}`;
  }

  return `  ${sourceId} --> ${targetId}`;
}

function stableMermaidIdHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }

  return (hash >>> 0).toString(36);
}

function toMermaidNodeId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const base =
    normalized.length === 0 ? "node" : /^[0-9]/.test(normalized) ? `n_${normalized}` : normalized;
  const rawHash = stableMermaidIdHash(value);
  const hashSuffix = rawHash.padStart(6, "0").slice(-6);

  return `${base}__${hashSuffix}`;
}

function escapeHtmlForMermaidLabel(value: string): string {
  return value.replace(/[&<>"]/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "\"":
        return "&quot;";
      default:
        return character;
    }
  });
}

function toMermaidLabel(subsystem: ArchitectureSubsystem): string {
  const safeId = escapeHtmlForMermaidLabel(subsystem.id);
  const safeResponsibility = escapeHtmlForMermaidLabel(subsystem.inferred_responsibility);

  return `${safeId}<br/>${safeResponsibility}`;
}

function sortUniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
