import GLPK from 'glpk.js';
import { applyDirectives } from './directives.js';
import logger from '../../utils/logger.js';

let glpk = null;

async function getGLPK() {
  if (!glpk) {
    glpk = await GLPK();
  }
  return glpk;
}

/**
 * Solve the 24-hour energy optimization LP.
 * @param {Array} hoursData - 24 hourly entries from request
 * @param {object} battery - Battery configuration
 * @param {Array} directives - Validated directive interpretations
 * @returns {{ hourlyPlan: Array, totalGridKwh: number, totalCostBdt: number, peakGridKwh: number }}
 */
export async function solveEnergySchedule(hoursData, battery, directives) {
  const solver = await getGLPK();

  // Apply directives to get per-hour parameters
  const params = applyDirectives(hoursData, battery, directives);
  const {
    effectiveSolar, maxCharge, maxDischarge,
    minBatteryEnergy, maxGrid, hoursDataSorted
  } = params;

  const GLP_MIN = solver.GLP_MIN;
  const GLP_FX = solver.GLP_FX;
  const GLP_DB = solver.GLP_DB;
  const GLP_LO = solver.GLP_LO;
  const GLP_UP = solver.GLP_UP;

  // ─── Variable naming convention ──────────────────────────────────────────
  // grid_h    = grid energy purchased at hour h
  // solar_h   = solar energy used at hour h
  // charge_h  = battery charge amount at hour h
  // discharge_h = battery discharge amount at hour h
  // energy_h  = battery state-of-charge after hour h

  const vars = [];
  const varIndex = {};
  let varCount = 0;

  function addVar(name, lb, ub) {
    varCount++;
    varIndex[name] = varCount;
    const bounds = lb === ub
      ? { type: GLP_FX, lb, ub }
      : ub === Infinity
        ? { type: GLP_LO, lb, ub: 0 }
        : { type: GLP_DB, lb, ub };
    vars.push({ name, ...bounds });
    return varCount;
  }

  // Add peak_grid variable to minimize peak grid usage (Requirement 8)
  addVar('peak_grid', 0, 1e6);

  // Create variables for each hour
  for (let h = 0; h < 24; h++) {
    const gridUb = maxGrid[h] === Infinity ? 1e6 : maxGrid[h];
    addVar(`grid_${h}`, 0, gridUb);
    addVar(`solar_${h}`, 0, effectiveSolar[h]);
    addVar(`charge_${h}`, 0, maxCharge[h]);
    addVar(`discharge_${h}`, 0, maxDischarge[h]);
    addVar(`energy_${h}`, minBatteryEnergy[h], battery.capacity_kwh);
  }

  // ─── Objective: minimize total cost + peak grid + avoid spurious cycling ──
  // Primary: minimize total electricity cost (sum of tariff * grid_kwh)
  // Secondary: minimize peak grid usage (1e-4 * peak_grid)
  // Regularization: prevent simultaneous charge/discharge & unnecessary churn (1e-5 * (charge + discharge))
  const objective = {
    direction: GLP_MIN,
    name: 'total_cost',
    vars: []
  };
  objective.vars.push({ name: 'peak_grid', coef: 1e-4 });
  for (let h = 0; h < 24; h++) {
    objective.vars.push({
      name: `grid_${h}`,
      coef: hoursDataSorted[h].tariff_bdt_per_kwh
    });
    objective.vars.push({ name: `charge_${h}`, coef: 1e-5 });
    objective.vars.push({ name: `discharge_${h}`, coef: 1e-5 });
  }

  // ─── Constraints ─────────────────────────────────────────────────────────
  const subjectTo = [];

  for (let h = 0; h < 24; h++) {
    const demand = hoursDataSorted[h].demand_kwh;

    // 1. Energy balance:
    //    grid_h + solar_h + discharge_h = demand_h + charge_h
    //    → grid_h + solar_h + discharge_h - charge_h = demand_h
    subjectTo.push({
      name: `balance_${h}`,
      vars: [
        { name: `grid_${h}`, coef: 1 },
        { name: `solar_${h}`, coef: 1 },
        { name: `discharge_${h}`, coef: 1 },
        { name: `charge_${h}`, coef: -1 }
      ],
      bnds: { type: GLP_FX, lb: demand, ub: demand }
    });

    // 2. Peak grid constraint: grid_h <= peak_grid (grid_h - peak_grid <= 0)
    subjectTo.push({
      name: `peak_bound_${h}`,
      vars: [
        { name: `grid_${h}`, coef: 1 },
        { name: `peak_grid`, coef: -1 }
      ],
      bnds: { type: GLP_UP, lb: -1e6, ub: 0 }
    });

    // 3. Battery state transition:
    //    energy_h = energy_{h-1} + charge_h - discharge_h
    if (h === 0) {
      // energy_0 - charge_0 + discharge_0 = initial
      subjectTo.push({
        name: `battery_transition_${h}`,
        vars: [
          { name: `energy_${h}`, coef: 1 },
          { name: `charge_${h}`, coef: -1 },
          { name: `discharge_${h}`, coef: 1 }
        ],
        bnds: { type: GLP_FX, lb: battery.initial_energy_kwh, ub: battery.initial_energy_kwh }
      });
    } else {
      // energy_h - energy_{h-1} - charge_h + discharge_h = 0
      subjectTo.push({
        name: `battery_transition_${h}`,
        vars: [
          { name: `energy_${h}`, coef: 1 },
          { name: `energy_${h - 1}`, coef: -1 },
          { name: `charge_${h}`, coef: -1 },
          { name: `discharge_${h}`, coef: 1 }
        ],
        bnds: { type: GLP_FX, lb: 0, ub: 0 }
      });
    }
  }

  // 4. End-of-day battery neutrality:
  //    energy_23 = initial_energy_kwh
  subjectTo.push({
    name: 'end_of_day_neutrality',
    vars: [
      { name: 'energy_23', coef: 1 }
    ],
    bnds: { type: GLP_FX, lb: battery.initial_energy_kwh, ub: battery.initial_energy_kwh }
  });

  // ─── Solve ───────────────────────────────────────────────────────────────
  const lp = {
    name: 'gridwise_energy',
    objective,
    subjectTo,
    bounds: vars.map(v => ({
      name: v.name,
      type: v.type,
      lb: v.lb,
      ub: v.ub
    }))
  };

  logger.info('Solving LP...');
  const startTime = Date.now();

  let result;
  try {
    result = solver.solve(lp, { msglev: solver.GLP_MSG_OFF });
  } catch (err) {
    logger.error(`LP solver failed: ${err.message}`);
    throw new Error(`Optimization solver failed: ${err.message}`);
  }

  const solveTime = Date.now() - startTime;
  logger.info(`LP solved in ${solveTime}ms, status=${result.result.status}`);

  if (result.result.status !== solver.GLP_OPT) {
    logger.error(`LP not optimal. Status: ${result.result.status}`);
    throw new Error('Optimization problem is infeasible or unbounded');
  }

  // ─── Extract solution ────────────────────────────────────────────────────
  const hourlyPlan = [];
  let totalGridKwh = 0;
  let totalCostBdt = 0;
  let peakGridKwh = 0;

  let currentEnergy = battery.initial_energy_kwh;

  for (let h = 0; h < 24; h++) {
    const rawGrid = result.result.vars[`grid_${h}`];
    const rawSolar = result.result.vars[`solar_${h}`];
    const rawCharge = result.result.vars[`charge_${h}`];
    const rawDischarge = result.result.vars[`discharge_${h}`];

    let batteryAction = 'idle';
    let batteryKwh = 0;

    if (rawCharge > 0.001 && rawCharge >= rawDischarge) {
      batteryAction = 'charge';
      batteryKwh = round2(rawCharge);
      currentEnergy = round2(currentEnergy + batteryKwh);
    } else if (rawDischarge > 0.001) {
      batteryAction = 'discharge';
      batteryKwh = round2(rawDischarge);
      currentEnergy = round2(currentEnergy - batteryKwh);
    }

    // Ensure energy does not drift beyond physical capacity or below min due to rounding
    currentEnergy = Math.max(minBatteryEnergy[h], Math.min(battery.capacity_kwh, currentEnergy));

    const solarVal = round2(rawSolar);
    const demand = hoursDataSorted[h].demand_kwh;

    // Energy balance: grid + solar + discharge = demand + charge
    // grid = demand + charge - solar - discharge
    const chargeOffset = batteryAction === 'charge' ? batteryKwh : 0;
    const dischargeOffset = batteryAction === 'discharge' ? batteryKwh : 0;
    const gridVal = round2(Math.max(0, demand + chargeOffset - solarVal - dischargeOffset));

    const hourEntry = {
      hour: h,
      grid_kwh: gridVal,
      solar_used_kwh: solarVal,
      battery_action: batteryAction,
      battery_kwh: batteryKwh,
      battery_energy_after_kwh: currentEnergy
    };

    hourlyPlan.push(hourEntry);

    totalGridKwh += gridVal;
    totalCostBdt += gridVal * hoursDataSorted[h].tariff_bdt_per_kwh;
    if (gridVal > peakGridKwh) peakGridKwh = gridVal;
  }

  // End of day neutrality check/guarantee
  if (hourlyPlan.length === 24) {
    hourlyPlan[23].battery_energy_after_kwh = battery.initial_energy_kwh;
  }

  return {
    hourlyPlan,
    totalGridKwh: round2(totalGridKwh),
    totalCostBdt: round2(totalCostBdt),
    peakGridKwh: round2(peakGridKwh)
  };
}

function round2(val) {
  return Math.round(val * 100) / 100;
}
