export const SKILL_PROVIDER_SOURCE_TYPES = ["built-in", "external"] as const;
export const SKILL_TRUST_LEVELS = ["trusted", "verified", "unverified"] as const;
export const SKILL_VERIFICATION_STATUSES = ["verified", "self-attested", "unknown"] as const;

export type SkillProviderSourceType = (typeof SKILL_PROVIDER_SOURCE_TYPES)[number];
export type SkillTrustLevel = (typeof SKILL_TRUST_LEVELS)[number];
export type SkillVerificationStatus = (typeof SKILL_VERIFICATION_STATUSES)[number];

export type SkillRegistryErrorCode =
  | "invalid_provider"
  | "duplicate_provider"
  | "invalid_skill"
  | "duplicate_skill"
  | "provider_not_found";

export class SkillRegistryError extends Error {
  readonly code: SkillRegistryErrorCode;
  readonly details?: unknown;

  constructor(code: SkillRegistryErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "SkillRegistryError";
    this.code = code;
    this.details = details;
  }
}

export interface SkillProviderMetadata {
  provider_id: string;
  display_name: string;
  source_type: SkillProviderSourceType;
  publisher?: string;
  version?: string;
  installation_root?: string;
}

export interface SkillCapabilityContract {
  supported_domains: string[];
  supported_task_types: string[];
  input_contract: string;
  output_contract: string;
}

export interface SkillTrustMetadata {
  trust_level: SkillTrustLevel;
  verification_status: SkillVerificationStatus;
  requires_approval: boolean;
}

export interface SkillRegistration {
  skill_id: string;
  display_name: string;
  description?: string;
  version: string;
  provider_id: string;
  capability_contract: SkillCapabilityContract;
  trust: SkillTrustMetadata;
}

export interface RegisteredSkill extends SkillRegistration {
  provider: SkillProviderMetadata;
}

export interface ListSkillsInput {
  provider_id?: string;
  source_type?: SkillProviderSourceType;
  supported_domain?: string;
  supported_task_type?: string;
  requires_approval?: boolean;
}

export interface CreateSkillRegistryInput {
  providers?: SkillProviderMetadata[];
  skills?: SkillRegistration[];
}

export interface SkillRegistry {
  registerProvider(provider: SkillProviderMetadata): void;
  getProvider(provider_id: string): SkillProviderMetadata | undefined;
  listProviders(): SkillProviderMetadata[];
  registerSkill(skill: SkillRegistration): void;
  getSkill(skill_id: string): RegisteredSkill | undefined;
  listSkills(input?: ListSkillsInput): RegisteredSkill[];
}

/**
 * Create the provider-agnostic registry used to discover installed skills and
 * the metadata future selection policy will rely on.
 */
export function createSkillRegistry(input: CreateSkillRegistryInput = {}): SkillRegistry {
  const providers = new Map<string, SkillProviderMetadata>();
  const skills = new Map<string, SkillRegistration>();

  const registry: SkillRegistry = {
    registerProvider(provider) {
      const normalized = normalizeProvider(provider);
      if (providers.has(normalized.provider_id)) {
        throw new SkillRegistryError(
          "duplicate_provider",
          `Provider ${normalized.provider_id} is already registered.`
        );
      }

      providers.set(normalized.provider_id, normalized);
    },

    getProvider(provider_id) {
      const normalizedProviderId = normalizeNonEmptyString(
        provider_id,
        "provider_id",
        "invalid_provider"
      );
      const provider = providers.get(normalizedProviderId);
      return provider ? cloneProvider(provider) : undefined;
    },

    listProviders() {
      return [...providers.values()]
        .sort((left, right) => left.provider_id.localeCompare(right.provider_id))
        .map((provider) => cloneProvider(provider));
    },

    registerSkill(skill) {
      const normalized = normalizeSkill(skill);
      if (skills.has(normalized.skill_id)) {
        throw new SkillRegistryError(
          "duplicate_skill",
          `Skill ${normalized.skill_id} is already registered.`
        );
      }

      if (!providers.has(normalized.provider_id)) {
        throw new SkillRegistryError(
          "provider_not_found",
          `Skill ${normalized.skill_id} references unknown provider ${normalized.provider_id}.`
        );
      }

      skills.set(normalized.skill_id, normalized);
    },

    getSkill(skill_id) {
      const normalizedSkillId = normalizeNonEmptyString(skill_id, "skill_id", "invalid_skill");
      const skill = skills.get(normalizedSkillId);
      return skill ? materializeRegisteredSkill(skill, providers) : undefined;
    },

    listSkills(filters = {}) {
      return [...skills.values()]
        .map((skill) => materializeRegisteredSkill(skill, providers))
        .filter((skill) => matchesSkillFilters(skill, filters))
        .sort((left, right) => left.skill_id.localeCompare(right.skill_id));
    }
  };

  for (const provider of input.providers ?? []) {
    registry.registerProvider(provider);
  }

  for (const skill of input.skills ?? []) {
    registry.registerSkill(skill);
  }

  return registry;
}

function normalizeProvider(provider: SkillProviderMetadata): SkillProviderMetadata {
  const sourceType = normalizeEnumValue(
    provider.source_type,
    SKILL_PROVIDER_SOURCE_TYPES,
    "source_type",
    "invalid_provider"
  );

  return {
    provider_id: normalizeNonEmptyString(provider.provider_id, "provider_id", "invalid_provider"),
    display_name: normalizeNonEmptyString(
      provider.display_name,
      "display_name",
      "invalid_provider"
    ),
    source_type: sourceType,
    ...normalizeOptionalStringFields(provider, ["publisher", "version", "installation_root"])
  };
}

function normalizeSkill(skill: SkillRegistration): SkillRegistration {
  return {
    skill_id: normalizeNonEmptyString(skill.skill_id, "skill_id", "invalid_skill"),
    display_name: normalizeNonEmptyString(skill.display_name, "display_name", "invalid_skill"),
    ...(skill.description ? { description: skill.description.trim() } : {}),
    version: normalizeNonEmptyString(skill.version, "version", "invalid_skill"),
    provider_id: normalizeNonEmptyString(skill.provider_id, "provider_id", "invalid_skill"),
    capability_contract: normalizeCapabilityContract(skill.capability_contract),
    trust: normalizeTrustMetadata(skill.trust)
  };
}

function normalizeCapabilityContract(
  capabilityContract: SkillCapabilityContract
): SkillCapabilityContract {
  if (!capabilityContract || typeof capabilityContract !== "object") {
    throw new SkillRegistryError(
      "invalid_skill",
      "capability_contract must define supported domains, task types, and input/output contracts."
    );
  }

  return {
    supported_domains: normalizeStringList(
      capabilityContract.supported_domains,
      "supported_domains",
      "invalid_skill"
    ),
    supported_task_types: normalizeStringList(
      capabilityContract.supported_task_types,
      "supported_task_types",
      "invalid_skill"
    ),
    input_contract: normalizeNonEmptyString(
      capabilityContract.input_contract,
      "input_contract",
      "invalid_skill"
    ),
    output_contract: normalizeNonEmptyString(
      capabilityContract.output_contract,
      "output_contract",
      "invalid_skill"
    )
  };
}

function normalizeTrustMetadata(trust: SkillTrustMetadata): SkillTrustMetadata {
  if (!trust || typeof trust !== "object") {
    throw new SkillRegistryError(
      "invalid_skill",
      "trust metadata must define trust_level, verification_status, and requires_approval."
    );
  }

  return {
    trust_level: normalizeEnumValue(
      trust.trust_level,
      SKILL_TRUST_LEVELS,
      "trust_level",
      "invalid_skill"
    ),
    verification_status: normalizeEnumValue(
      trust.verification_status,
      SKILL_VERIFICATION_STATUSES,
      "verification_status",
      "invalid_skill"
    ),
    requires_approval: normalizeBoolean(trust.requires_approval, "requires_approval", "invalid_skill")
  };
}

function normalizeNonEmptyString(
  value: unknown,
  fieldName: string,
  code: SkillRegistryErrorCode
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new SkillRegistryError(code, `${fieldName} must be a non-empty string.`);
  }

  return value.trim();
}

function normalizeStringList(
  value: unknown,
  fieldName: string,
  code: SkillRegistryErrorCode
): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SkillRegistryError(code, `${fieldName} must be a non-empty string array.`);
  }

  return [...new Set(value.map((entry) => normalizeNonEmptyString(entry, fieldName, code)))].sort(
    (left, right) => left.localeCompare(right)
  );
}

function normalizeBoolean(
  value: unknown,
  fieldName: string,
  code: SkillRegistryErrorCode
): boolean {
  if (typeof value !== "boolean") {
    throw new SkillRegistryError(code, `${fieldName} must be a boolean.`);
  }

  return value;
}

function normalizeEnumValue<T extends readonly string[]>(
  value: unknown,
  allowedValues: T,
  fieldName: string,
  code: SkillRegistryErrorCode
): T[number] {
  if (typeof value !== "string" || !allowedValues.includes(value)) {
    throw new SkillRegistryError(
      code,
      `${fieldName} must be one of ${allowedValues.join(", ")}.`
    );
  }

  return value as T[number];
}

function materializeRegisteredSkill(
  skill: SkillRegistration,
  providers: ReadonlyMap<string, SkillProviderMetadata>
): RegisteredSkill {
  const provider = providers.get(skill.provider_id);
  if (!provider) {
    throw new SkillRegistryError(
      "provider_not_found",
      `Skill ${skill.skill_id} references unknown provider ${skill.provider_id}.`
    );
  }

  return {
    ...cloneSkill(skill),
    provider: cloneProvider(provider)
  };
}

function matchesSkillFilters(skill: RegisteredSkill, filters: ListSkillsInput): boolean {
  if (filters.provider_id && skill.provider_id !== filters.provider_id.trim()) {
    return false;
  }

  if (filters.source_type && skill.provider.source_type !== filters.source_type) {
    return false;
  }

  if (filters.supported_domain && !skill.capability_contract.supported_domains.includes(filters.supported_domain.trim())) {
    return false;
  }

  if (
    filters.supported_task_type &&
    !skill.capability_contract.supported_task_types.includes(filters.supported_task_type.trim())
  ) {
    return false;
  }

  if (
    typeof filters.requires_approval === "boolean" &&
    skill.trust.requires_approval !== filters.requires_approval
  ) {
    return false;
  }

  return true;
}

function normalizeOptionalStringFields<T extends object, K extends keyof T & string>(
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

function cloneProvider(provider: SkillProviderMetadata): SkillProviderMetadata {
  return {
    ...provider
  };
}

function cloneSkill(skill: SkillRegistration): SkillRegistration {
  return {
    ...skill,
    capability_contract: {
      ...skill.capability_contract,
      supported_domains: [...skill.capability_contract.supported_domains],
      supported_task_types: [...skill.capability_contract.supported_task_types]
    },
    trust: {
      ...skill.trust
    }
  };
}
