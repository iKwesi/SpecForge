export const ARTIFACT_KINDS = [
  "idea_brief",
  "prd",
  "spec",
  "readme_update_result",
  "replan_subgraph",
  "architecture_summary",
  "delta_spec",
  "task_execution_result",
  "critic_result",
  "proposal_summary",
  "proposal_draft",
  "context_pack",
  "repo_profile",
  "validation_report"
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export interface ArtifactOwnershipContract {
  artifact_kind: ArtifactKind;
  owner_operation: string;
}

// Each artifact kind has one canonical owning operation. Validation and
// maintenance code relies on this registry instead of inferring broader write
// permissions from file paths or command names.
export const ARTIFACT_OWNERSHIP_REGISTRY: Record<ArtifactKind, ArtifactOwnershipContract> = {
  idea_brief: {
    artifact_kind: "idea_brief",
    owner_operation: "operation.ideaInterview"
  },
  prd: {
    artifact_kind: "prd",
    owner_operation: "operation.generatePRD"
  },
  spec: {
    artifact_kind: "spec",
    owner_operation: "operation.generateSpecPack"
  },
  readme_update_result: {
    artifact_kind: "readme_update_result",
    owner_operation: "operation.updateReadme"
  },
  replan_subgraph: {
    artifact_kind: "replan_subgraph",
    owner_operation: "operation.replanAffectedSubgraph"
  },
  architecture_summary: {
    artifact_kind: "architecture_summary",
    owner_operation: "operation.mapArchitectureFromRepo"
  },
  delta_spec: {
    artifact_kind: "delta_spec",
    owner_operation: "operation.generateDeltaSpec"
  },
  task_execution_result: {
    artifact_kind: "task_execution_result",
    owner_operation: "operation.devTDDTask"
  },
  critic_result: {
    artifact_kind: "critic_result",
    owner_operation: "operation.criticRalphLoop"
  },
  proposal_summary: {
    artifact_kind: "proposal_summary",
    owner_operation: "operation.generateProposalBrief"
  },
  proposal_draft: {
    artifact_kind: "proposal_draft",
    owner_operation: "operation.generateProposalBrief"
  },
  context_pack: {
    artifact_kind: "context_pack",
    owner_operation: "operation.buildContextPack"
  },
  repo_profile: {
    artifact_kind: "repo_profile",
    owner_operation: "operation.profileRepository"
  },
  validation_report: {
    artifact_kind: "validation_report",
    owner_operation: "operation.validateSpecPack"
  }
};

/**
 * Infer the owned artifact kind from the published artifact_id naming scheme.
 * The mapping is intentionally conservative: unknown ids stay unknown instead
 * of being coerced into a nearby kind.
 */
export function inferArtifactKindFromId(artifactId: string): ArtifactKind | undefined {
  if (artifactId === "idea_brief") {
    return "idea_brief";
  }

  if (artifactId.startsWith("prd.")) {
    return "prd";
  }

  if (artifactId.startsWith("spec.")) {
    return "spec";
  }

  if (artifactId.startsWith("readme_update_result.")) {
    return "readme_update_result";
  }

  if (artifactId === "replan_subgraph") {
    return "replan_subgraph";
  }

  if (artifactId === "architecture_summary") {
    return "architecture_summary";
  }

  if (artifactId === "delta_spec") {
    return "delta_spec";
  }

  if (artifactId.startsWith("task_execution_result.")) {
    return "task_execution_result";
  }

  if (artifactId.startsWith("critic_result.")) {
    return "critic_result";
  }

  if (artifactId === "proposal_summary.md") {
    return "proposal_summary";
  }

  if (artifactId === "proposal_issue.md" || artifactId === "proposal_discussion.md") {
    return "proposal_draft";
  }

  if (artifactId.startsWith("context_pack.")) {
    return "context_pack";
  }

  if (artifactId === "repo_profile") {
    return "repo_profile";
  }

  if (artifactId.startsWith("validation_report.")) {
    return "validation_report";
  }

  return undefined;
}

/**
 * Guard helper for validation paths that receive artifact-kind strings from
 * serialized artifacts or inferred ids.
 */
export function isOwnedArtifactKind(kind: string): kind is ArtifactKind {
  return ARTIFACT_KINDS.includes(kind as ArtifactKind);
}
