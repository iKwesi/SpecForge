import {
  createSkillRegistry,
  type CreateSkillRegistryInput,
  type SkillProviderMetadata,
  type SkillRegistration,
  type SkillRegistry
} from "./registry.js";

export const BUILT_IN_SKILL_PROVIDER_ID = "builtin";
const BUILT_IN_SKILL_PROVIDER: SkillProviderMetadata = {
  provider_id: BUILT_IN_SKILL_PROVIDER_ID,
  display_name: "SpecForge Built-ins",
  source_type: "built-in",
  publisher: "SpecForge",
  version: "1.0.0"
};

const BUILT_IN_SKILLS: SkillRegistration[] = [
  {
    skill_id: "builtin.idea-triage",
    display_name: "Built-in Idea Triage",
    description: "Triages idea briefs into planning hints for downstream orchestration.",
    version: "1.0.0",
    provider_id: BUILT_IN_SKILL_PROVIDER_ID,
    capability_contract: {
      supported_domains: ["planning"],
      supported_task_types: ["triage"],
      input_contract: "specforge.idea_brief.v1",
      output_contract: "specforge.plan_hint.v1"
    },
    trust: {
      trust_level: "trusted",
      verification_status: "verified",
      requires_approval: false
    }
  },
  {
    skill_id: "builtin.spec-drafter",
    display_name: "Built-in Spec Drafter",
    description: "Drafts PRD-oriented specification artifacts from normalized idea briefs.",
    version: "1.0.0",
    provider_id: BUILT_IN_SKILL_PROVIDER_ID,
    capability_contract: {
      supported_domains: ["planning"],
      supported_task_types: ["drafting"],
      input_contract: "specforge.idea_brief.v1",
      output_contract: "specforge.prd.v1"
    },
    trust: {
      trust_level: "trusted",
      verification_status: "verified",
      requires_approval: false
    }
  }
];

/**
 * Return the built-in provider metadata as a defensive copy so bootstrap callers
 * can inspect the default provider without mutating the source catalog.
 */
export function getBuiltInSkillProvider(): SkillProviderMetadata {
  return cloneProvider(BUILT_IN_SKILL_PROVIDER);
}

/**
 * Return the built-in skill catalog as defensive copies. The catalog stays
 * deterministic so selection policy and tests see the same default surface.
 */
export function getBuiltInSkillRegistrations(): SkillRegistration[] {
  return BUILT_IN_SKILLS.map((skill) => cloneSkill(skill));
}

/**
 * Create a registry that always includes the built-in provider and skills. User
 * supplied skills register first so trusted external skills can override a
 * built-in by reusing the same skill_id, while still allowing built-ins to fill
 * the remaining gaps when no override exists.
 */
export function createBootstrappedSkillRegistry(
  input: CreateSkillRegistryInput = {}
): SkillRegistry {
  const registry = createSkillRegistry({
    providers: [getBuiltInSkillProvider()]
  });

  for (const provider of input.providers ?? []) {
    registry.registerProvider(provider);
  }

  for (const skill of input.skills ?? []) {
    registry.registerSkill(skill);
  }

  for (const builtInSkill of getBuiltInSkillRegistrations()) {
    if (registry.getSkill(builtInSkill.skill_id)) {
      continue;
    }

    registry.registerSkill(builtInSkill);
  }

  return registry;
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
