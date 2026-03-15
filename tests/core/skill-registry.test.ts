import { describe, expect, it } from "vitest";

import {
  SkillRegistryError,
  createSkillRegistry
} from "../../src/core/skills/registry.js";

describe("skill registry", () => {
  it("lists installed built-in and external skills with provider and trust metadata", () => {
    const registry = createSkillRegistry({
      providers: [
        {
          provider_id: "builtin",
          display_name: "SpecForge Built-ins",
          source_type: "built-in",
          version: "1.0.0"
        },
        {
          provider_id: "marketplace.acme",
          display_name: "Acme Marketplace",
          source_type: "external",
          publisher: "Acme",
          version: "2026.03"
        }
      ],
      skills: [
        {
          skill_id: "domain.postgres-review",
          display_name: "Postgres Review",
          version: "2.1.0",
          provider_id: "marketplace.acme",
          capability_contract: {
            supported_domains: ["database", "backend"],
            supported_task_types: ["review", "analysis"],
            input_contract: "specforge.context_pack.v1",
            output_contract: "specforge.skill_result.v1"
          },
          trust: {
            trust_level: "verified",
            verification_status: "verified",
            requires_approval: true
          }
        },
        {
          skill_id: "builtin.spec-drafter",
          display_name: "Spec Drafter",
          version: "1.0.0",
          provider_id: "builtin",
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
      ]
    });

    expect(registry.listProviders()).toEqual([
      {
        provider_id: "builtin",
        display_name: "SpecForge Built-ins",
        source_type: "built-in",
        version: "1.0.0"
      },
      {
        provider_id: "marketplace.acme",
        display_name: "Acme Marketplace",
        source_type: "external",
        publisher: "Acme",
        version: "2026.03"
      }
    ]);

    expect(registry.listSkills()).toEqual([
      {
        skill_id: "builtin.spec-drafter",
        display_name: "Spec Drafter",
        version: "1.0.0",
        provider_id: "builtin",
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
        },
        provider: {
          provider_id: "builtin",
          display_name: "SpecForge Built-ins",
          source_type: "built-in",
          version: "1.0.0"
        }
      },
      {
        skill_id: "domain.postgres-review",
        display_name: "Postgres Review",
        version: "2.1.0",
        provider_id: "marketplace.acme",
        capability_contract: {
          supported_domains: ["backend", "database"],
          supported_task_types: ["analysis", "review"],
          input_contract: "specforge.context_pack.v1",
          output_contract: "specforge.skill_result.v1"
        },
        trust: {
          trust_level: "verified",
          verification_status: "verified",
          requires_approval: true
        },
        provider: {
          provider_id: "marketplace.acme",
          display_name: "Acme Marketplace",
          source_type: "external",
          publisher: "Acme",
          version: "2026.03"
        }
      }
    ]);
  });

  it("filters installed skills by provider, source type, domain, task type, and approval requirement", () => {
    const registry = createSkillRegistry({
      providers: [
        {
          provider_id: "builtin",
          display_name: "SpecForge Built-ins",
          source_type: "built-in"
        },
        {
          provider_id: "vendor.delta",
          display_name: "Delta Skills",
          source_type: "external"
        }
      ],
      skills: [
        {
          skill_id: "builtin.idea-triage",
          display_name: "Idea Triage",
          version: "1.0.0",
          provider_id: "builtin",
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
          skill_id: "vendor.delta.fullstack-review",
          display_name: "Fullstack Review",
          version: "3.0.0",
          provider_id: "vendor.delta",
          capability_contract: {
            supported_domains: ["frontend", "backend"],
            supported_task_types: ["review", "analysis"],
            input_contract: "specforge.context_pack.v1",
            output_contract: "specforge.skill_result.v1"
          },
          trust: {
            trust_level: "unverified",
            verification_status: "self-attested",
            requires_approval: true
          }
        }
      ]
    });

    expect(
      registry.listSkills({
        source_type: "external",
        supported_domain: "frontend",
        supported_task_type: "review",
        requires_approval: true
      })
    ).toEqual([
      expect.objectContaining({
        skill_id: "vendor.delta.fullstack-review",
        provider_id: "vendor.delta"
      })
    ]);

    expect(
      registry.listSkills({
        provider_id: "builtin"
      })
    ).toEqual([
      expect.objectContaining({
        skill_id: "builtin.idea-triage"
      })
    ]);
  });

  it("fails with typed errors when providers or skills are invalid or duplicated", () => {
    const registry = createSkillRegistry();

    expect(() => registry.registerProvider(undefined as never)).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({
        code: "invalid_provider"
      })
    );

    expect(() =>
      registry.registerProvider({
        provider_id: "builtin",
        display_name: "SpecForge Built-ins",
        source_type: "built-in"
      })
    ).not.toThrow();

    expect(() =>
      registry.registerProvider({
        provider_id: "builtin",
        display_name: "Duplicate Built-ins",
        source_type: "built-in"
      })
    ).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({
        code: "duplicate_provider"
      })
    );

    expect(() =>
      registry.registerSkill({
        skill_id: "known.skill",
        display_name: "Known Skill",
        version: "1.0.0",
        provider_id: "builtin",
        capability_contract: {
          supported_domains: ["planning"],
          supported_task_types: ["drafting"],
          input_contract: "a",
          output_contract: "b"
        },
        trust: {
          trust_level: "trusted",
          verification_status: "verified",
          requires_approval: false
        }
      })
    ).not.toThrow();

    expect(() =>
      registry.registerSkill({
        skill_id: "known.skill",
        display_name: "Known Skill Duplicate",
        version: "1.1.0",
        provider_id: "builtin",
        capability_contract: {
          supported_domains: ["planning"],
          supported_task_types: ["drafting"],
          input_contract: "a",
          output_contract: "b"
        },
        trust: {
          trust_level: "trusted",
          verification_status: "verified",
          requires_approval: false
        }
      })
    ).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({
        code: "duplicate_skill"
      })
    );

    expect(() =>
      registry.registerSkill({
        skill_id: "bad.skill",
        display_name: "Bad Skill",
        version: "1.0.0",
        provider_id: "missing",
        capability_contract: {
          supported_domains: ["planning"],
          supported_task_types: ["drafting"],
          input_contract: "a",
          output_contract: "b"
        },
        trust: {
          trust_level: "trusted",
          verification_status: "verified",
          requires_approval: false
        }
      })
    ).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({
        code: "provider_not_found"
      })
    );

    expect(() =>
      createSkillRegistry({
        providers: [
          {
            provider_id: "builtin",
            display_name: "SpecForge Built-ins",
            source_type: "built-in"
          }
        ],
        skills: [
          {
            skill_id: "invalid.contract",
            display_name: "Invalid Contract",
            version: "1.0.0",
            provider_id: "builtin",
            capability_contract: {
              supported_domains: [],
              supported_task_types: ["drafting"],
              input_contract: "a",
              output_contract: "b"
            },
            trust: {
              trust_level: "trusted",
              verification_status: "verified",
              requires_approval: false
            }
          }
        ]
      })
    ).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({
        code: "invalid_skill"
      })
    );

    expect(() => registry.registerSkill(null as never)).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({
        code: "invalid_skill"
      })
    );

    expect(() =>
      registry.registerSkill({
        skill_id: "bad.description",
        display_name: "Bad Description",
        description: 123 as never,
        version: "1.0.0",
        provider_id: "builtin",
        capability_contract: {
          supported_domains: ["planning"],
          supported_task_types: ["drafting"],
          input_contract: "a",
          output_contract: "b"
        },
        trust: {
          trust_level: "trusted",
          verification_status: "verified",
          requires_approval: false
        }
      })
    ).toThrowError(
      expect.objectContaining<Partial<SkillRegistryError>>({
        code: "invalid_skill"
      })
    );
  });

  it("drops whitespace-only descriptions instead of storing empty metadata", () => {
    const registry = createSkillRegistry({
      providers: [
        {
          provider_id: "builtin",
          display_name: "SpecForge Built-ins",
          source_type: "built-in"
        }
      ],
      skills: [
        {
          skill_id: "builtin.whitespace-description",
          display_name: "Whitespace Description",
          description: "   ",
          version: "1.0.0",
          provider_id: "builtin",
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
      ]
    });

    const skill = registry.getSkill("builtin.whitespace-description");
    expect(skill).toEqual(
      expect.objectContaining({
        skill_id: "builtin.whitespace-description"
      })
    );
    expect(skill).not.toHaveProperty("description");
  });

  it("returns defensive copies so external mutation does not change registry state", () => {
    const registry = createSkillRegistry({
      providers: [
        {
          provider_id: "builtin",
          display_name: "SpecForge Built-ins",
          source_type: "built-in"
        }
      ],
      skills: [
        {
          skill_id: "builtin.spec-drafter",
          display_name: "Spec Drafter",
          version: "1.0.0",
          provider_id: "builtin",
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
      ]
    });

    const skill = registry.getSkill("builtin.spec-drafter");
    expect(skill).toBeDefined();

    skill!.provider.display_name = "Mutated";
    skill!.capability_contract.supported_domains.push("corrupted");

    expect(registry.getSkill("builtin.spec-drafter")).toEqual(
      expect.objectContaining({
        provider: expect.objectContaining({
          display_name: "SpecForge Built-ins"
        }),
        capability_contract: expect.objectContaining({
          supported_domains: ["planning"]
        })
      })
    );
  });
});
