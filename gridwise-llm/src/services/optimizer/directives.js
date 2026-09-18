/**
 * Apply validated directives to modify the optimization model parameters.
 * Returns modified effective_solar, charge/discharge bounds, battery min bounds, and grid caps.
 */

/**
 * @param {Array} hoursData - 24 hourly entries from request (sorted by hour)
 * @param {object} battery - Battery configuration
 * @param {Array} directives - Validated directive interpretations
 * @returns {object} Modified parameters for the LP solver
 */
export function applyDirectives(hoursData, battery, directives) {
  // Initialize per-hour parameters with base values
  const effectiveSolar = new Array(24);
  const maxCharge = new Array(24);
  const maxDischarge = new Array(24);
  const minBatteryEnergy = new Array(24);
  const maxGrid = new Array(24);

  // Sort hoursData by hour to ensure index alignment
  const sorted = [...hoursData].sort((a, b) => a.hour - b.hour);

  for (let h = 0; h < 24; h++) {
    effectiveSolar[h] = sorted[h].solar_kwh;
    maxCharge[h] = battery.max_charge_kwh_per_hour;
    maxDischarge[h] = battery.max_discharge_kwh_per_hour;
    minBatteryEnergy[h] = battery.minimum_energy_kwh;
    maxGrid[h] = Infinity; // No limit by default
  }

  // Apply each active directive
  for (const d of directives) {
    if (!d.applies || d.directive_type === 'no_op') continue;

    const adj = d.structured_adjustment;

    switch (d.directive_type) {
      case 'solar_reduction':
        for (const h of adj.hours) {
          effectiveSolar[h] = sorted[h].solar_kwh * adj.factor;
        }
        break;

      case 'minimum_battery_reserve':
        for (const h of adj.hours) {
          // Effective minimum = max(base minimum, directive minimum)
          minBatteryEnergy[h] = Math.max(minBatteryEnergy[h], adj.minimum_energy_kwh);
        }
        break;

      case 'no_charge_window':
        for (const h of adj.hours) {
          maxCharge[h] = 0;
        }
        break;

      case 'no_discharge_window':
        for (const h of adj.hours) {
          maxDischarge[h] = 0;
        }
        break;

      case 'max_grid_window':
        for (const h of adj.hours) {
          maxGrid[h] = adj.max_grid_kwh;
        }
        break;
    }
  }

  return {
    effectiveSolar,
    maxCharge,
    maxDischarge,
    minBatteryEnergy,
    maxGrid,
    hoursDataSorted: sorted
  };
}
