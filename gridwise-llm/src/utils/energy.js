import logger from './logger.js';

/**
 * Post-solve verification: checks that the hourly plan satisfies all constraints.
 * Returns an array of error strings (empty = all good).
 *
 * @param {Array} hourlyPlan - 24 hourly plan entries from solver
 * @param {Array} hoursData - 24 hourly scenario entries (sorted by hour)
 * @param {object} battery - Battery config
 * @param {Array} directives - Validated directive interpretations
 * @returns {string[]} List of violations found (empty = valid)
 */
export function verifySchedule(hourlyPlan, hoursData, battery, directives) {
  const errors = [];
  const sorted = [...hoursData].sort((a, b) => a.hour - b.hour);
  const TOL = 0.02; // tolerance

  // Build effective solar map from directives
  const effectiveSolar = sorted.map(h => h.solar_kwh);
  const chargeBlocked = new Set();
  const dischargeBlocked = new Set();
  const gridCaps = {};
  const reserveMinimums = {};

  for (const d of directives) {
    if (!d.applies || d.directive_type === 'no_op') continue;
    const adj = d.structured_adjustment;
    switch (d.directive_type) {
      case 'solar_reduction':
        for (const h of adj.hours) effectiveSolar[h] = sorted[h].solar_kwh * adj.factor;
        break;
      case 'no_charge_window':
        for (const h of adj.hours) chargeBlocked.add(h);
        break;
      case 'no_discharge_window':
        for (const h of adj.hours) dischargeBlocked.add(h);
        break;
      case 'max_grid_window':
        for (const h of adj.hours) gridCaps[h] = adj.max_grid_kwh;
        break;
      case 'minimum_battery_reserve':
        for (const h of adj.hours) {
          reserveMinimums[h] = Math.max(
            reserveMinimums[h] || battery.minimum_energy_kwh,
            adj.minimum_energy_kwh
          );
        }
        break;
    }
  }

  // Check 24 hours
  if (hourlyPlan.length !== 24) {
    errors.push(`Expected 24 hours, got ${hourlyPlan.length}`);
    return errors;
  }

  let energy = battery.initial_energy_kwh;

  for (const entry of hourlyPlan) {
    const h = entry.hour;
    const demand = sorted[h].demand_kwh;
    const effSolar = effectiveSolar[h];

    // 1. Energy balance
    let lhs, rhs;
    if (entry.battery_action === 'charge') {
      lhs = entry.grid_kwh + entry.solar_used_kwh;
      rhs = demand + entry.battery_kwh;
    } else if (entry.battery_action === 'discharge') {
      lhs = entry.grid_kwh + entry.solar_used_kwh + entry.battery_kwh;
      rhs = demand;
    } else {
      lhs = entry.grid_kwh + entry.solar_used_kwh;
      rhs = demand;
    }
    if (Math.abs(lhs - rhs) > TOL) {
      errors.push(`h${h}: energy balance fail (${lhs.toFixed(2)} != ${rhs.toFixed(2)})`);
    }

    // 2. Solar usage
    if (entry.solar_used_kwh > effSolar + TOL) {
      errors.push(`h${h}: solar_used (${entry.solar_used_kwh}) > effective (${effSolar.toFixed(2)})`);
    }
    if (entry.solar_used_kwh < -TOL) {
      errors.push(`h${h}: negative solar_used`);
    }

    // 3. Grid non-negative
    if (entry.grid_kwh < -TOL) {
      errors.push(`h${h}: negative grid_kwh`);
    }

    // 4. Battery state transition
    if (entry.battery_action === 'charge') {
      energy += entry.battery_kwh;
    } else if (entry.battery_action === 'discharge') {
      energy -= entry.battery_kwh;
    }

    if (Math.abs(energy - entry.battery_energy_after_kwh) > TOL) {
      errors.push(`h${h}: battery state mismatch (expected ${energy.toFixed(2)}, got ${entry.battery_energy_after_kwh})`);
    }

    // 5. Battery bounds
    const effMin = reserveMinimums[h] || battery.minimum_energy_kwh;
    if (energy < effMin - TOL) {
      errors.push(`h${h}: battery (${energy.toFixed(2)}) below min (${effMin})`);
    }
    if (energy > battery.capacity_kwh + TOL) {
      errors.push(`h${h}: battery (${energy.toFixed(2)}) above cap (${battery.capacity_kwh})`);
    }

    // 6. Rate limits
    if (entry.battery_action === 'charge' && entry.battery_kwh > battery.max_charge_kwh_per_hour + TOL) {
      errors.push(`h${h}: charge rate (${entry.battery_kwh}) exceeds max (${battery.max_charge_kwh_per_hour})`);
    }
    if (entry.battery_action === 'discharge' && entry.battery_kwh > battery.max_discharge_kwh_per_hour + TOL) {
      errors.push(`h${h}: discharge rate (${entry.battery_kwh}) exceeds max (${battery.max_discharge_kwh_per_hour})`);
    }

    // 7. Directive constraints
    if (chargeBlocked.has(h) && entry.battery_action === 'charge' && entry.battery_kwh > TOL) {
      errors.push(`h${h}: charging blocked but charge=${entry.battery_kwh}`);
    }
    if (dischargeBlocked.has(h) && entry.battery_action === 'discharge' && entry.battery_kwh > TOL) {
      errors.push(`h${h}: discharge blocked but discharge=${entry.battery_kwh}`);
    }
    if (h in gridCaps && entry.grid_kwh > gridCaps[h] + TOL) {
      errors.push(`h${h}: grid (${entry.grid_kwh}) exceeds cap (${gridCaps[h]})`);
    }

    // 8. Idle must have battery_kwh = 0
    if (entry.battery_action === 'idle' && entry.battery_kwh > TOL) {
      errors.push(`h${h}: idle but battery_kwh=${entry.battery_kwh}`);
    }
  }

  // 9. End-of-day neutrality
  if (Math.abs(energy - battery.initial_energy_kwh) > TOL) {
    errors.push(`End-of-day: battery (${energy.toFixed(2)}) != initial (${battery.initial_energy_kwh})`);
  }

  if (errors.length > 0) {
    logger.warn(`Schedule verification found ${errors.length} issue(s): ${errors.join('; ')}`);
  } else {
    logger.info('Schedule verification passed');
  }

  return errors;
}
