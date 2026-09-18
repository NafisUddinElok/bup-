import { z } from 'zod';
import logger from '../../utils/logger.js';

// ─── Allowed directive types ─────────────────────────────────────────────────
const ALLOWED_DIRECTIVE_TYPES = [
  'solar_reduction',
  'minimum_battery_reserve',
  'no_charge_window',
  'no_discharge_window',
  'max_grid_window',
  'no_op'
];

// ─── Request validation schema ───────────────────────────────────────────────
const hourSchema = z.object({
  hour: z.number().int().min(0).max(23),
  demand_kwh: z.number().nonnegative(),
  solar_kwh: z.number().nonnegative(),
  tariff_bdt_per_kwh: z.number().nonnegative()
});

const batterySchema = z.object({
  capacity_kwh: z.number().positive(),
  initial_energy_kwh: z.number().nonnegative(),
  minimum_energy_kwh: z.number().nonnegative(),
  max_charge_kwh_per_hour: z.number().positive(),
  max_discharge_kwh_per_hour: z.number().positive()
});

export const requestSchema = z.object({
  scenario_id: z.string().min(1),
  operator_notes: z.array(z.string().min(1)).min(1).max(3),
  hours: z.array(hourSchema).length(24),
  battery: batterySchema
});

/**
 * Validate the incoming request body.
 * Returns { success: true, data } or { success: false, error }.
 */
export function validateRequest(body) {
  const result = requestSchema.safeParse(body);
  if (!result.success) {
    return { success: false, error: result.error.format() };
  }
  // Verify hours are 0-23 and unique
  const hourNums = result.data.hours.map(h => h.hour).sort((a, b) => a - b);
  for (let i = 0; i < 24; i++) {
    if (hourNums[i] !== i) {
      return { success: false, error: `Missing or duplicate hour: expected ${i}, got ${hourNums[i]}` };
    }
  }
  return { success: true, data: result.data };
}

// ─── LLM output guardrail schema ────────────────────────────────────────────

/**
 * Validate and clean the LLM-interpreted directives.
 * @param {Array} interpretations - Raw directive array from LLM
 * @param {number} noteCount - Expected number of notes
 * @param {object} battery - Battery configuration from request
 * @returns {{ success: boolean, data?: Array, error?: string }}
 */
export function validateDirectives(interpretations, noteCount, battery) {
  // Must be an array with one entry per note
  if (!Array.isArray(interpretations)) {
    return { success: false, error: 'LLM output is not an array' };
  }
  if (interpretations.length !== noteCount) {
    return { success: false, error: `Expected ${noteCount} directives, got ${interpretations.length}` };
  }

  const cleaned = [];

  for (let i = 0; i < interpretations.length; i++) {
    const d = interpretations[i];

    // Validate note_index
    if (d.note_index !== i) {
      logger.warn(`Fixing note_index: expected ${i}, got ${d.note_index}`);
      d.note_index = i;
    }

    // Validate directive_type
    if (!ALLOWED_DIRECTIVE_TYPES.includes(d.directive_type)) {
      logger.warn(`Invalid directive_type "${d.directive_type}", falling back to no_op`);
      d.directive_type = 'no_op';
      d.applies = false;
      d.structured_adjustment = null;
      d.explanation = d.explanation || 'Invalid directive type was corrected to no_op.';
    }

    // Enforce applies semantics
    if (d.directive_type === 'no_op') {
      d.applies = false;
      d.structured_adjustment = null;
    } else {
      d.applies = true;
      // Validate structured_adjustment exists
      if (!d.structured_adjustment || typeof d.structured_adjustment !== 'object') {
        logger.warn(`Missing structured_adjustment for ${d.directive_type}, falling back to no_op`);
        d.directive_type = 'no_op';
        d.applies = false;
        d.structured_adjustment = null;
        d.explanation = (d.explanation || '') + ' [Guardrail: missing adjustment, corrected to no_op]';
        cleaned.push(d);
        continue;
      }
    }

    // Type-specific validation
    if (d.applies) {
      const adj = d.structured_adjustment;
      const validationResult = validateAdjustment(d.directive_type, adj, battery);
      if (!validationResult.success) {
        logger.warn(`Adjustment validation failed for note ${i}: ${validationResult.error}`);
        d.directive_type = 'no_op';
        d.applies = false;
        d.structured_adjustment = null;
        d.explanation = (d.explanation || '') + ` [Guardrail: ${validationResult.error}]`;
      } else {
        d.structured_adjustment = validationResult.data;
      }
    }

    // Ensure explanation exists
    if (!d.explanation || typeof d.explanation !== 'string') {
      d.explanation = d.applies
        ? `Directive ${d.directive_type} applied.`
        : 'This note does not affect today\'s energy schedule.';
    }

    cleaned.push(d);
  }

  return { success: true, data: cleaned };
}

/**
 * Validate and normalize the structured_adjustment for a specific directive type.
 */
function validateAdjustment(type, adj, battery) {
  switch (type) {
    case 'solar_reduction': {
      const hours = validateHours(adj.hours);
      if (!hours.success) return hours;
      const factor = Number(adj.factor);
      if (!Number.isFinite(factor) || factor < 0 || factor > 1) {
        return { success: false, error: `Invalid factor: ${adj.factor}. Must be 0-1.` };
      }
      return { success: true, data: { hours: hours.data, factor: Math.round(factor * 1000) / 1000 } };
    }

    case 'minimum_battery_reserve': {
      const hours = validateHours(adj.hours);
      if (!hours.success) return hours;
      const minE = Number(adj.minimum_energy_kwh);
      if (!Number.isFinite(minE) || minE < 0) {
        return { success: false, error: `Invalid minimum_energy_kwh: ${adj.minimum_energy_kwh}` };
      }
      if (minE > battery.capacity_kwh) {
        return { success: false, error: `Reserve ${minE} exceeds capacity ${battery.capacity_kwh}` };
      }
      return { success: true, data: { hours: hours.data, minimum_energy_kwh: minE } };
    }

    case 'no_charge_window': {
      const hours = validateHours(adj.hours);
      if (!hours.success) return hours;
      return { success: true, data: { hours: hours.data } };
    }

    case 'no_discharge_window': {
      const hours = validateHours(adj.hours);
      if (!hours.success) return hours;
      return { success: true, data: { hours: hours.data } };
    }

    case 'max_grid_window': {
      const hours = validateHours(adj.hours);
      if (!hours.success) return hours;
      const maxGrid = Number(adj.max_grid_kwh);
      if (!Number.isFinite(maxGrid) || maxGrid < 0) {
        return { success: false, error: `Invalid max_grid_kwh: ${adj.max_grid_kwh}` };
      }
      return { success: true, data: { hours: hours.data, max_grid_kwh: maxGrid } };
    }

    default:
      return { success: false, error: `Unknown directive type: ${type}` };
  }
}

/**
 * Validate and normalize an hours array: unique integers 0-23, ascending order.
 */
function validateHours(hours) {
  if (!Array.isArray(hours) || hours.length === 0) {
    return { success: false, error: 'hours must be a non-empty array' };
  }
  const nums = hours.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 23);
  if (nums.length === 0) {
    return { success: false, error: 'No valid hours found in array' };
  }
  // Deduplicate and sort ascending
  const unique = [...new Set(nums)].sort((a, b) => a - b);
  return { success: true, data: unique };
}
