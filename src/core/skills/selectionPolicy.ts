import {
  SKILL_TRUST_LEVELS,
  type RegisteredSkill,
  type SkillRegistry,
  type SkillTrustLevel
} from "./registry.js";

const TRUST_LEVEL_RANK: Record<SkillTrustLevel, number> = {
  unverified: 1,
  verified: 2,
  trusted: 3
};

const VERIFICATION_STATUS_SCORE = {
  verified: 3,
  "self-attested": 2,
  unknown: 1
} as const;

export type SkillSelectionPolicyErrorCode = "invalid_registry" | "invalid_request" | "invalid_policy";

export class SkillSelectionPolicyError extends Error {
  readonly code: SkillSelectionPolicyErrorCode;
  readonly details?: unknown;

  constructor(code: SkillSelectionPolicyErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "SkillSelectionPolicyError";
    this.code = code;
    this.details = details;
  }
}

export interface SkillSelectionPolicy {
  minimum_trust_level: SkillTrustLevel;
  require_approval_on_first_use: boolean;
  prefer_built_in_providers: boolean;
}

export type SkillSelectionReasonCode =
  | "domain_supported"
  | "task_type_supported"
  | "contracts_compatible"
  | "trust_preferred"
  | "provider_preferred"
  | "first_use_requires_approval"
  | "provider_declares_approval_required"
  | "domain_not_supported"
  | "task_type_not_supported"
  | "input_contract_incompatible"
  | "output_contract_incompatible"
  | "trust_below_policy";

export interface RecommendSkillsInput {
  registry: SkillRegistry;
  domain: string;
  task_type: string;
  input_contract?: string;
  output_contract?: string;
  policy?: Partial<SkillSelectionPolicy>;
  previously_approved_skill_ids?: string[];
}

export interface SkillRecommendation {
  skill_id: string;
  display_name: string;
  provider_id: string;
  provider_source_type: RegisteredSkill["provider"]["source_type"];
  trust_level: RegisteredSkill["trust"]["trust_level"];
  verification_status: RegisteredSkill["trust"]["verification_status"];
  approval_required: boolean;
  score: number;
  reason_codes: SkillSelectionReasonCode[];
}

export interface RejectedSkillRecommendation {
  skill_id: string;
  reason_codes: SkillSelectionReasonCode[];
}

export interface SkillSelectionResult {
  policy: SkillSelectionPolicy;
  recommendations: SkillRecommendation[];
  rejected_skills: RejectedSkillRecommendation[];
}

interface NormalizedRecommendSkillsInput {
  registry: SkillRegistry;
  domain: string;
  task_type: string;
  input_contract?: string;
  output_contract?: string;
  policy: SkillSelectionPolicy;
  previously_approved_skill_ids: string[];
}

/**
 * Provide deterministic, auditable skill recommendations from registry metadata
 * and explicit policy input. The result includes both selected and rejected
 * candidates so planning can explain why a skill was or was not considered.
 */
export function recommendSkills(input: RecommendSkillsInput): SkillSelectionResult {
  const request = normalizeRecommendSkillsInput(input);
  const skills = request.registry.listSkills();
  const previouslyApprovedSkillIds = new Set(request.previously_approved_skill_ids);

  const accepted: SkillRecommendation[] = [];
  const rejected: RejectedSkillRecommendation[] = [];

  for (const skill of skills) {
    const rejectionReasons = getRejectionReasons(skill, request);
    if (rejectionReasons.length > 0) {
      rejected.push({
        skill_id: skill.skill_id,
        reason_codes: rejectionReasons
      });
      continue;
    }

    const approvalRequired =
      skill.trust.requires_approval ||
      (request.policy.require_approval_on_first_use &&
        skill.provider.source_type === "external" &&
        !previouslyApprovedSkillIds.has(skill.skill_id));

    accepted.push({
      skill_id: skill.skill_id,
      display_name: skill.display_name,
      provider_id: skill.provider_id,
      provider_source_type: skill.provider.source_type,
      trust_level: skill.trust.trust_level,
      verification_status: skill.trust.verification_status,
      approval_required: approvalRequired,
      score: scoreSkill(skill, request.policy, request.input_contract, request.output_contract),
      reason_codes: buildRecommendationReasons(
        skill,
        request.policy,
        request.input_contract,
        request.output_contract,
        approvalRequired,
        previouslyApprovedSkillIds
      )
    });
  }

  return {
    policy: request.policy,
    recommendations: accepted.sort(compareRecommendations),
    rejected_skills: rejected.sort((left, right) => left.skill_id.localeCompare(right.skill_id))
  };
}

export function createDefaultSkillSelectionPolicy(): SkillSelectionPolicy {
  return {
    minimum_trust_level: "verified",
    require_approval_on_first_use: false,
    prefer_built_in_providers: true
  };
}

function normalizeRecommendSkillsInput(input: RecommendSkillsInput): NormalizedRecommendSkillsInput {
  if (!isPlainRecord(input)) {
    throw new SkillSelectionPolicyError(
      "invalid_request",
      "recommendSkills input must be a non-null object."
    );
  }

  if (!isSkillRegistry(input.registry)) {
    throw new SkillSelectionPolicyError(
      "invalid_registry",
      "registry must implement listSkills()."
    );
  }

  const policy = normalizePolicy(input.policy);

  return {
    registry: input.registry,
    domain: normalizeNonEmptyString(input.domain, "domain", "invalid_request"),
    task_type: normalizeNonEmptyString(input.task_type, "task_type", "invalid_request"),
    ...(input.input_contract !== undefined
      ? {
          input_contract: normalizeNonEmptyString(
            input.input_contract,
            "input_contract",
            "invalid_request"
          )
        }
      : {}),
    ...(input.output_contract !== undefined
      ? {
          output_contract: normalizeNonEmptyString(
            input.output_contract,
            "output_contract",
            "invalid_request"
          )
        }
      : {}),
    policy,
    previously_approved_skill_ids: normalizeOptionalStringArray(
      input.previously_approved_skill_ids,
      "previously_approved_skill_ids",
      "invalid_request"
    )
  };
}

function normalizePolicy(policy: Partial<SkillSelectionPolicy> | undefined): SkillSelectionPolicy {
  if (policy === undefined) {
    return createDefaultSkillSelectionPolicy();
  }

  if (!isPlainRecord(policy)) {
    throw new SkillSelectionPolicyError("invalid_policy", "policy must be a non-null object.");
  }

  const defaults = createDefaultSkillSelectionPolicy();
  return {
    minimum_trust_level:
      policy.minimum_trust_level !== undefined
        ? normalizeTrustLevel(policy.minimum_trust_level, "invalid_policy")
        : defaults.minimum_trust_level,
    require_approval_on_first_use:
      policy.require_approval_on_first_use !== undefined
        ? normalizeBoolean(
            policy.require_approval_on_first_use,
            "require_approval_on_first_use",
            "invalid_policy"
          )
        : defaults.require_approval_on_first_use,
    prefer_built_in_providers:
      policy.prefer_built_in_providers !== undefined
        ? normalizeBoolean(
            policy.prefer_built_in_providers,
            "prefer_built_in_providers",
            "invalid_policy"
          )
        : defaults.prefer_built_in_providers
  };
}

function getRejectionReasons(
  skill: RegisteredSkill,
  input: NormalizedRecommendSkillsInput
): SkillSelectionReasonCode[] {
  const reasons: SkillSelectionReasonCode[] = [];

  if (!skill.capability_contract.supported_domains.includes(input.domain)) {
    reasons.push("domain_not_supported");
  }

  if (!skill.capability_contract.supported_task_types.includes(input.task_type)) {
    reasons.push("task_type_not_supported");
  }

  if (
    input.input_contract !== undefined &&
    skill.capability_contract.input_contract !== input.input_contract
  ) {
    reasons.push("input_contract_incompatible");
  }

  if (
    input.output_contract !== undefined &&
    skill.capability_contract.output_contract !== input.output_contract
  ) {
    reasons.push("output_contract_incompatible");
  }

  if (TRUST_LEVEL_RANK[skill.trust.trust_level] < TRUST_LEVEL_RANK[input.policy.minimum_trust_level]) {
    reasons.push("trust_below_policy");
  }

  return reasons;
}

function buildRecommendationReasons(
  skill: RegisteredSkill,
  policy: SkillSelectionPolicy,
  inputContract: string | undefined,
  outputContract: string | undefined,
  approvalRequired: boolean,
  previouslyApprovedSkillIds: ReadonlySet<string>
): SkillSelectionReasonCode[] {
  const reasons: SkillSelectionReasonCode[] = ["domain_supported", "task_type_supported"];

  if (
    (inputContract !== undefined || outputContract !== undefined) &&
    (inputContract === undefined || skill.capability_contract.input_contract === inputContract) &&
    (outputContract === undefined || skill.capability_contract.output_contract === outputContract)
  ) {
    reasons.push("contracts_compatible");
  }

  if (skill.trust.trust_level === "trusted") {
    reasons.push("trust_preferred");
  }

  if (policy.prefer_built_in_providers && skill.provider.source_type === "built-in") {
    reasons.push("provider_preferred");
  }

  if (
    approvalRequired &&
    policy.require_approval_on_first_use &&
    skill.provider.source_type === "external" &&
    !previouslyApprovedSkillIds.has(skill.skill_id)
  ) {
    reasons.push("first_use_requires_approval");
  }

  if (skill.trust.requires_approval) {
    reasons.push("provider_declares_approval_required");
  }

  return reasons;
}

function scoreSkill(
  skill: RegisteredSkill,
  policy: SkillSelectionPolicy,
  inputContract: string | undefined,
  outputContract: string | undefined
): number {
  let score = TRUST_LEVEL_RANK[skill.trust.trust_level] * 100;
  score +=
    VERIFICATION_STATUS_SCORE[
      skill.trust.verification_status as keyof typeof VERIFICATION_STATUS_SCORE
    ] * 10;

  if (policy.prefer_built_in_providers && skill.provider.source_type === "built-in") {
    score += 15;
  }

  if (inputContract !== undefined && skill.capability_contract.input_contract === inputContract) {
    score += 5;
  }

  if (outputContract !== undefined && skill.capability_contract.output_contract === outputContract) {
    score += 5;
  }

  return score;
}

function compareRecommendations(left: SkillRecommendation, right: SkillRecommendation): number {
  if (left.score !== right.score) {
    return right.score - left.score;
  }

  return left.skill_id.localeCompare(right.skill_id);
}

function normalizeTrustLevel(
  value: unknown,
  code: SkillSelectionPolicyErrorCode
): SkillTrustLevel {
  if (typeof value !== "string" || !SKILL_TRUST_LEVELS.includes(value as SkillTrustLevel)) {
    throw new SkillSelectionPolicyError(
      code,
      `minimum_trust_level must be one of ${SKILL_TRUST_LEVELS.join(", ")}.`
    );
  }

  return value as SkillTrustLevel;
}

function normalizeNonEmptyString(
  value: unknown,
  fieldName: string,
  code: SkillSelectionPolicyErrorCode
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SkillSelectionPolicyError(code, `${fieldName} must be a non-empty string.`);
  }

  return value.trim();
}

function normalizeOptionalStringArray(
  value: unknown,
  fieldName: string,
  code: SkillSelectionPolicyErrorCode
): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new SkillSelectionPolicyError(code, `${fieldName} must be a string array.`);
  }

  return [...new Set(value.map((entry) => normalizeNonEmptyString(entry, fieldName, code)))].sort(
    (left, right) => left.localeCompare(right)
  );
}

function normalizeBoolean(
  value: unknown,
  fieldName: string,
  code: SkillSelectionPolicyErrorCode
): boolean {
  if (typeof value !== "boolean") {
    throw new SkillSelectionPolicyError(code, `${fieldName} must be a boolean.`);
  }

  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSkillRegistry(value: unknown): value is SkillRegistry {
  return isPlainRecord(value) && typeof value.listSkills === "function";
}
