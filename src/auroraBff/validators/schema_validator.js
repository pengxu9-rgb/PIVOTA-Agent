const fs = require('fs');
const path = require('path');

/**
 * Validates SkillRequest and SkillResponse against the contract schema.
 * Uses lightweight structural validation (no external deps required).
 * In production, replace with ajv or json-schema-ref-parser for full $ref resolution.
 */

const CONTRACTS_DIR = path.resolve(__dirname, '../../../contracts/aurora_skills');

let _contractSchema = null;
let _skillRegistry = null;
let _qualityGates = null;
let _preconditionRules = null;

function loadContract(filename) {
  const filePath = path.join(CONTRACTS_DIR, filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function getContractSchema() {
  if (!_contractSchema) {
    _contractSchema = loadContract('skill_contract.schema.json');
  }
  return _contractSchema;
}

function getSkillRegistry() {
  if (!_skillRegistry) {
    _skillRegistry = loadContract('skill_registry.json');
  }
  return _skillRegistry;
}

function getQualityGates() {
  if (!_qualityGates) {
    _qualityGates = loadContract('quality_gates.json');
  }
  return _qualityGates;
}

function getPreconditionRules() {
  if (!_preconditionRules) {
    _preconditionRules = loadContract('precondition_rules.json');
  }
  return _preconditionRules;
}

function validateSkillRequest(request) {
  const errors = [];

  if (!request.skill_id && !request.intent) {
    errors.push('Either skill_id or intent is required');
  }

  if (request.skill_id && !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/.test(request.skill_id)) {
    errors.push(`Invalid skill_id format: ${request.skill_id}`);
  }

  if (request.skill_id) {
    const registry = getSkillRegistry();
    const registered = registry.skills.find((s) => s.skill_id === request.skill_id);
    if (!registered) {
      errors.push(`Unknown skill_id: ${request.skill_id}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateSkillResponse(response, skillId) {
  const errors = [];

  if (!response.cards || !Array.isArray(response.cards)) {
    errors.push('cards must be an array');
  }

  if (!response.ops) {
    errors.push('ops is required');
  }

  if (!response.quality) {
    errors.push('quality is required');
  }

  if (!response.telemetry) {
    errors.push('telemetry is required');
  }

  if (!response.next_actions || response.next_actions.length === 0) {
    errors.push('next_actions must be non-empty');
  }

  if (skillId) {
    const registry = getSkillRegistry();
    const registered = registry.skills.find((s) => s.skill_id === skillId);
    if (registered) {
      const allowedCardTypes = new Set([...registered.output_card_types, 'empty_state']);
      for (const card of response.cards || []) {
        if (!allowedCardTypes.has(card.card_type)) {
          errors.push(
            `Skill ${skillId} emitted card_type "${card.card_type}" not in allowed types: ${[...allowedCardTypes].join(', ')}`
          );
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

function getPreconditionsForSkill(skillId) {
  const rules = getPreconditionRules();
  return rules.rules.filter((r) => r.applies_to.includes(skillId));
}

function getQualityGateForSkill(skillId) {
  const gates = getQualityGates();
  const registry = getSkillRegistry();
  const registered = registry.skills.find((s) => s.skill_id === skillId);
  if (!registered) return null;
  return gates.gates.find((g) => g.gate_id === registered.quality_gate_id) || null;
}

module.exports = {
  validateSkillRequest,
  validateSkillResponse,
  getPreconditionsForSkill,
  getQualityGateForSkill,
  getContractSchema,
  getSkillRegistry,
  getQualityGates,
  getPreconditionRules,
};
