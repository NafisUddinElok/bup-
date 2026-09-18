import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { interpretOperatorNotes } from '../src/services/llm/interpreter.js';
import { solveEnergySchedule } from '../src/services/optimizer/solver.js';
import { verifySchedule } from '../src/utils/energy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const samplesPath = path.resolve(__dirname, '../../BUP_CSE_FEST_2026_Preli_Public_Sample_Cases.json');
const data = JSON.parse(fs.readFileSync(samplesPath, 'utf8'));

console.log('\n================================================================');
console.log('  Testing Full End-to-End Pipeline in OFFLINE FALLBACK Mode');
console.log('  (Input Notes -> Offline Fallback Interpreter -> GLPK Solver)');
console.log('================================================================\n');

// Ensure no GEMINI_API_KEY is used
delete process.env.GEMINI_API_KEY;

let passed = 0;

for (const c of data.cases) {
  const { id, label, input, expected_output: expected } = c;

  // 1. Run interpretation through the fallback
  const directives = await interpretOperatorNotes(input.operator_notes, input.battery);

  // 2. Solve LP
  const result = await solveEnergySchedule(input.hours, input.battery, directives);

  // 3. Verify constraints
  const errors = verifySchedule(result.hourlyPlan, input.hours, input.battery, directives);

  const costDiff = Math.abs(result.totalCostBdt - expected.total_cost_bdt);
  const gridDiff = Math.abs(result.totalGridKwh - expected.total_grid_kwh);
  const peakDiff = Math.abs(result.peakGridKwh - expected.peak_grid_kwh);

  const isCostOk = costDiff < 0.05;
  const isGridOk = gridDiff < 0.05;
  const isPeakOk = peakDiff < 0.05;
  const isConstraintsOk = errors.length === 0;

  if (isCostOk && isGridOk && isPeakOk && isConstraintsOk) {
    console.log(`✅ [PASS] ${id}: ${label}`);
    console.log(`   Cost: ${result.totalCostBdt} BDT | Grid: ${result.totalGridKwh} kWh | Peak: ${result.peakGridKwh} kWh/h\n`);
    passed++;
  } else {
    console.error(`❌ [FAIL] ${id}: ${label}`);
    if (!isCostOk) console.error(`   Cost mismatch: got ${result.totalCostBdt}, expected ${expected.total_cost_bdt}`);
    if (!isGridOk) console.error(`   Grid mismatch: got ${result.totalGridKwh}, expected ${expected.total_grid_kwh}`);
    if (!isPeakOk) console.error(`   Peak mismatch: got ${result.peakGridKwh}, expected ${expected.peak_grid_kwh}`);
    if (!isConstraintsOk) console.error(`   Violations:`, errors);
    console.log();
  }
}

console.log(`Summary: ${passed}/${data.cases.length} cases passed end-to-end in offline fallback mode.\n`);

if (passed !== data.cases.length) {
  process.exit(1);
}

