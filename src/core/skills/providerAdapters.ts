import {
  SKILL_TRUST_LEVELS,
  SKILL_VERIFICATION_STATUSES,
  type SkillProviderMetadata,
  type SkillRegistration,
  type SkillRegistry
} from "./registry.js";

export type ExternalSkillPackAdapterErrorCode =
  | "invalid_adapter"
  | "invalid_skill_pack"
  | "registration_failed"
  | "provider_mismatch";

export class ExternalSkillPackAdapterError extends Error {
  readonly code: ExternalSkillPackAdapterErrorCode;
  readonly details?: unknown;

  constructor(code: ExternalSkillPackAdapterErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "ExternalSkillPackAdapterError";
    this.code = code;
    this.details = details;
  }
}

export interface ExternalSkillPackDefinition {
  pack_id: string;
  provider: SkillProviderMetadata;
  skills: SkillRegistration[];
}

export interface ExternalSkillPackAdapter {
  adapter_id: string;
  load(): Promise<ExternalSkillPackDefinition>;
}

/**
 * Load an external skill pack through an explicit adapter boundary. This keeps
 * domain-specific extensions outside the deterministic core while still giving
 * the engine a typed, auditable contract to validate.
 */
export async function loadExternalSkillPack(
  adapter: ExternalSkillPackAdapter
): Promise<ExternalSkillPackDefinition> {
  if (!isPlainRecord(adapter) || typeof adapter.adapter_id !== "string" || adapter.adapter_id.trim().length === 0) {
    throw new ExternalSkillPackAdapterError(
      "invalid_adapter",
      "adapter_id must be a non-empty string."
    );
  }

  if (typeof adapter.load !== "function") {
    throw new ExternalSkillPackAdapterError(
      "invalid_adapter",
      "adapter must implement load()."
    );
  }

  try {
    const pack = await adapter.load();
    return validateExternalSkillPack(pack);
  } catch (error) {
    if (error instanceof ExternalSkillPackAdapterError) {
      throw error;
    }

    throw new ExternalSkillPackAdapterError(
      "invalid_adapter",
      `adapter.load() failed for adapter_id "${adapter.adapter_id}".`,
      {
        adapter_id: adapter.adapter_id,
        cause: error
      }
    );
  }
}

/**
 * Register a validated external pack into the existing registry. Providers are
 * added only when missing so multiple packs can share a provider identity
 * without re-registering the same provider metadata every time.
 */
export function registerExternalSkillPack(
  registry: SkillRegistry,
  pack: ExternalSkillPackDefinition
): void {
  if (!isSkillRegistry(registry)) {
    throw new ExternalSkillPackAdapterError(
      "registration_failed",
      "registry must implement provider and skill registration methods."
    );
  }

  const validatedPack = validateExternalSkillPack(pack);

  try {
    const existingProvider = registry.getProvider(validatedPack.provider.provider_id);
    if (!existingProvider) {
      registry.registerProvider(validatedPack.provider);
    } else if (!providersAreCompatible(existingProvider, validatedPack.provider)) {
      throw new ExternalSkillPackAdapterError(
        "provider_mismatch",
        `Existing provider metadata is incompatible with external skill pack ${validatedPack.pack_id} for provider_id ${validatedPack.provider.provider_id}.`,
        {
          existing_provider: existingProvider,
          pack_provider: validatedPack.provider
        }
      );
    }

    for (const skill of validatedPack.skills) {
      registry.registerSkill(skill);
    }
  } catch (error) {
    if (error instanceof ExternalSkillPackAdapterError) {
      throw error;
    }

    throw new ExternalSkillPackAdapterError(
      "registration_failed",
      `Unable to register external skill pack ${validatedPack.pack_id}.`,
      error
    );
  }
}

export function createPrototypePostgresSkillPack(): ExternalSkillPackDefinition {
  return {
    pack_id: "prototype.postgres-pack",
    provider: {
      provider_id: "pack.postgres",
      display_name: "Postgres Domain Pack",
      source_type: "external",
      publisher: "SpecForge Prototype Packs",
      version: "0.1.0"
    },
    skills: [
      {
        skill_id: "pack.postgres.query-review",
        display_name: "Postgres Query Review",
        description: "Reviews query-heavy changes for SQL safety and index awareness.",
        version: "0.1.0",
        provider_id: "pack.postgres",
        capability_contract: {
          supported_domains: ["database"],
          supported_task_types: ["review"],
          input_contract: "specforge.context_pack.v1",
          output_contract: "specforge.skill_result.v1"
        },
        trust: {
          trust_level: "verified",
          verification_status: "verified",
          requires_approval: false
        }
      },
      {
        skill_id: "pack.postgres.schema-risk",
        display_name: "Postgres Schema Risk Analysis",
        description: "Analyzes migration and schema-change plans for relational risk hotspots.",
        version: "0.1.0",
        provider_id: "pack.postgres",
        capability_contract: {
          supported_domains: ["database"],
          supported_task_types: ["analysis"],
          input_contract: "specforge.context_pack.v1",
          output_contract: "specforge.skill_result.v1"
        },
        trust: {
          trust_level: "verified",
          verification_status: "verified",
          requires_approval: false
        }
      }
    ]
  };
}

function validateExternalSkillPack(pack: unknown): ExternalSkillPackDefinition {
  if (!isPlainRecord(pack)) {
    throw new ExternalSkillPackAdapterError(
      "invalid_skill_pack",
      "external skill pack must be a non-null object."
    );
  }

  const packId = normalizeNonEmptyString(pack.pack_id, "pack_id", "invalid_skill_pack");

  if (!isPlainRecord(pack.provider)) {
    throw new ExternalSkillPackAdapterError(
      "invalid_skill_pack",
      "provider must be a non-null object."
    );
  }

  const provider = validateExternalProvider(pack.provider);

  if (!Array.isArray(pack.skills) || pack.skills.length === 0) {
    throw new ExternalSkillPackAdapterError(
      "invalid_skill_pack",
      "skills must be a non-empty array."
    );
  }

  const skills = pack.skills.map((skill) =>
    validateExternalSkillRegistration(skill, provider.provider_id)
  );
  const seenSkillIds = new Set<string>();
  for (const skill of skills) {
    if (seenSkillIds.has(skill.skill_id)) {
      throw new ExternalSkillPackAdapterError(
        "invalid_skill_pack",
        `duplicate skill_id "${skill.skill_id}" in external skill pack "${packId}".`
      );
    }

    seenSkillIds.add(skill.skill_id);
  }

  return {
    pack_id: packId,
    provider,
    skills
  };
}

function validateExternalProvider(provider: Record<string, unknown>): SkillProviderMetadata {
  const sourceType = normalizeNonEmptyString(
    provider.source_type,
    "provider.source_type",
    "invalid_skill_pack"
  );
  if (sourceType !== "external") {
    throw new ExternalSkillPackAdapterError(
      "invalid_skill_pack",
      "provider.source_type must be external."
    );
  }

  return {
    provider_id: normalizeNonEmptyString(
      provider.provider_id,
      "provider.provider_id",
      "invalid_skill_pack"
    ),
    display_name: normalizeNonEmptyString(
      provider.display_name,
      "provider.display_name",
      "invalid_skill_pack"
    ),
    source_type: "external",
    ...normalizeOptionalStringFields(provider, ["publisher", "version", "installation_root"])
  };
}

function validateExternalSkillRegistration(
  skill: unknown,
  providerId: string
): SkillRegistration {
  if (!isPlainRecord(skill)) {
    throw new ExternalSkillPackAdapterError(
      "invalid_skill_pack",
      "each skill must be a non-null object."
    );
  }

  const skillProviderId = normalizeNonEmptyString(
    skill.provider_id,
    "skill.provider_id",
    "invalid_skill_pack"
  );
  if (skillProviderId !== providerId) {
    throw new ExternalSkillPackAdapterError(
      "invalid_skill_pack",
      `skill.provider_id must match provider.provider_id (${providerId}).`
    );
  }

  return {
    skill_id: normalizeNonEmptyString(skill.skill_id, "skill.skill_id", "invalid_skill_pack"),
    display_name: normalizeNonEmptyString(
      skill.display_name,
      "skill.display_name",
      "invalid_skill_pack"
    ),
    ...normalizeOptionalDescription(skill.description),
    version: normalizeNonEmptyString(skill.version, "skill.version", "invalid_skill_pack"),
    provider_id: skillProviderId,
    capability_contract: validateCapabilityContract(skill.capability_contract),
    trust: validateTrustMetadata(skill.trust)
  };
}

function validateCapabilityContract(capabilityContract: unknown): SkillRegistration["capability_contract"] {
  if (!isPlainRecord(capabilityContract)) {
    throw new ExternalSkillPackAdapterError(
      "invalid_skill_pack",
      "skill.capability_contract must be a non-null object."
    );
  }

  return {
    supported_domains: normalizeStringArray(
      capabilityContract.supported_domains,
      "skill.capability_contract.supported_domains",
      "invalid_skill_pack"
    ),
    supported_task_types: normalizeStringArray(
      capabilityContract.supported_task_types,
      "skill.capability_contract.supported_task_types",
      "invalid_skill_pack"
    ),
    input_contract: normalizeNonEmptyString(
      capabilityContract.input_contract,
      "skill.capability_contract.input_contract",
      "invalid_skill_pack"
    ),
    output_contract: normalizeNonEmptyString(
      capabilityContract.output_contract,
      "skill.capability_contract.output_contract",
      "invalid_skill_pack"
    )
  };
}

function validateTrustMetadata(trust: unknown): SkillRegistration["trust"] {
  if (!isPlainRecord(trust)) {
    throw new ExternalSkillPackAdapterError(
      "invalid_skill_pack",
      "skill.trust must be a non-null object."
    );
  }

  const trustLevel = normalizeNonEmptyString(
    trust.trust_level,
    "skill.trust.trust_level",
    "invalid_skill_pack"
  );
  if (!SKILL_TRUST_LEVELS.includes(trustLevel as SkillRegistration["trust"]["trust_level"])) {
    throw new ExternalSkillPackAdapterError(
      "invalid_skill_pack",
      `skill.trust.trust_level must be one of ${SKILL_TRUST_LEVELS.join(", ")}.`
    );
  }

  const verificationStatus = normalizeNonEmptyString(
    trust.verification_status,
    "skill.trust.verification_status",
    "invalid_skill_pack"
  );
  if (
    !SKILL_VERIFICATION_STATUSES.includes(
      verificationStatus as SkillRegistration["trust"]["verification_status"]
    )
  ) {
    throw new ExternalSkillPackAdapterError(
      "invalid_skill_pack",
      `skill.trust.verification_status must be one of ${SKILL_VERIFICATION_STATUSES.join(", ")}.`
    );
  }

  return {
    trust_level: trustLevel as SkillRegistration["trust"]["trust_level"],
    verification_status: verificationStatus as SkillRegistration["trust"]["verification_status"],
    requires_approval: normalizeBoolean(
      trust.requires_approval,
      "skill.trust.requires_approval",
      "invalid_skill_pack"
    )
  };
}

function normalizeOptionalStringFields<T extends Record<string, unknown>, K extends keyof T & string>(
  value: T,
  keys: readonly K[]
): Partial<Record<K, string>> {
  const normalized: Partial<Record<K, string>> = {};
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      normalized[key] = candidate.trim();
    }
  }
  return normalized;
}

function normalizeOptionalDescription(description: unknown): { description?: string } {
  if (description === undefined) {
    return {};
  }

  if (typeof description !== "string") {
    throw new ExternalSkillPackAdapterError(
      "invalid_skill_pack",
      "skill.description must be a string when provided."
    );
  }

  const trimmed = description.trim();
  return trimmed.length > 0 ? { description: trimmed } : {};
}

function normalizeStringArray(
  value: unknown,
  fieldName: string,
  code: ExternalSkillPackAdapterErrorCode
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ExternalSkillPackAdapterError(code, `${fieldName} must be a non-empty string array.`);
  }

  return [...new Set(value.map((entry) => normalizeNonEmptyString(entry, fieldName, code)))].sort(
    (left, right) => left.localeCompare(right)
  );
}

function normalizeNonEmptyString(
  value: unknown,
  fieldName: string,
  code: ExternalSkillPackAdapterErrorCode
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ExternalSkillPackAdapterError(code, `${fieldName} must be a non-empty string.`);
  }

  return value.trim();
}

function normalizeBoolean(
  value: unknown,
  fieldName: string,
  code: ExternalSkillPackAdapterErrorCode
): boolean {
  if (typeof value !== "boolean") {
    throw new ExternalSkillPackAdapterError(code, `${fieldName} must be a boolean.`);
  }

  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSkillRegistry(value: unknown): value is SkillRegistry {
  return (
    isPlainRecord(value) &&
    typeof value.getProvider === "function" &&
    typeof value.registerProvider === "function" &&
    typeof value.registerSkill === "function"
  );
}

function providersAreCompatible(
  existing: SkillProviderMetadata,
  expected: SkillProviderMetadata
): boolean {
  return (
    existing.provider_id === expected.provider_id &&
    existing.display_name === expected.display_name &&
    existing.source_type === expected.source_type &&
    existing.publisher === expected.publisher &&
    existing.version === expected.version &&
    existing.installation_root === expected.installation_root
  );
}
