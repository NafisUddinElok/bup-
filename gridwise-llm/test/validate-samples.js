import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { solveEnergySchedule } from '../src/services/optimizer/solver.js';
import { verifySchedule } from '../src/utils/energy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const samplesPath = path.resolve(__dirname, '../../BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json');
if (!fs.existsSync(samplesPath)) {
  console.error('Sample cases file not found at:', samplesPath);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(samplesPath, 'utf8'));
console.log(`\n=== Running GridWise Optimization Validation on ${data.cases.length} Public Cases ===\n`);

let passedCount = 0;

for (const c of data.cases) {
  const { id, label } = c;
  const input = c.input;
  const expected = c.expected_output;

  const result = await solveEnergySchedule(input.hours, input.battery, expected.directive_interpretation);
  const errors = verifySchedule(result.hourlyPlan, input.hours, input.battery, expected.directive_interpretation);

  const costDiff = Math.abs(result.totalCostBdt - expected.total_cost_bdt);
  const gridDiff = Math.abs(result.totalGridKwh - expected.total_grid_kwh);
  const peakDiff = Math.abs(result.peakGridKwh - expected.peak_grid_kwh);

  const isCostOk = costDiff < 0.05;
  const isGridOk = gridDiff < 0.05;
  const isPeakOk = peakDiff < 0.05;
  const isConstraintsOk = errors.length === 0;

  if (isCostOk && isGridOk && isPeakOk && isConstraintsOk) {
    console.log(`✅ [PASS] ${id}: ${label}`);
    console.log(`   Cost: ${result.totalCostBdt} BDT (Target: ${expected.total_cost_bdt})`);
    console.log(`   Grid: ${result.totalGridKwh} kWh | Peak: ${result.peakGridKwh} kWh/h\n`);
    passedCount++;
  } else {
    console.error(`❌ [FAIL] ${id}: ${label}`);
    if (!isCostOk) console.error(`   Cost mismatch: got ${result.totalCostBdt}, expected ${expected.total_cost_bdt}`);
    if (!isGridOk) console.error(`   Grid mismatch: got ${result.totalGridKwh}, expected ${expected.total_grid_kwh}`);
    if (!isPeakOk) console.error(`   Peak mismatch: got ${result.peakGridKwh}, expected ${expected.peak_grid_kwh}`);
    if (!isConstraintsOk) console.error(`   Constraint violations:`, errors);
    console.log();
  }
}

console.log(`\nResult: ${passedCount}/${data.cases.length} cases passed perfectly.`);
if (passedCount !== data.cases.length) {
  process.exit(1);
}
