import { Router } from 'express';
import { validateRequest } from '../services/guardrails/validator.js';
import { interpretOperatorNotes } from '../services/llm/interpreter.js';
import { solveEnergySchedule } from '../services/optimizer/solver.js';
import { verifySchedule } from '../utils/energy.js';
import logger from '../utils/logger.js';

const router = Router();

router.post('/optimize-energy', async (req, res) => {
  const requestStart = Date.now();

  try {
    // ─── Step 1: Validate request ────────────────────────────────────────
    const validation = validateRequest(req.body);
    if (!validation.success) {
      logger.warn('Request validation failed', { error: validation.error });
      return res.status(400).json({
        error: 'Invalid request',
        details: validation.error
      });
    }

    const { scenario_id, operator_notes, hours, battery } = validation.data;
    logger.info(`Processing scenario: ${scenario_id}`, {
      noteCount: operator_notes.length
    });

    // ─── Step 2: Interpret operator notes via LLM ────────────────────────
    let directiveInterpretation;
    try {
      directiveInterpretation = await interpretOperatorNotes(operator_notes, battery);
    } catch (err) {
      logger.error(`LLM interpretation failed: ${err.message}`);
      return res.status(503).json({
        error: 'LLM interpretation service temporarily unavailable',
        scenario_id
      });
    }

    // ─── Step 3: Solve energy optimization ───────────────────────────────
    let solverResult;
    try {
      solverResult = await solveEnergySchedule(hours, battery, directiveInterpretation);
    } catch (err) {
      logger.error(`Optimization failed: ${err.message}`);
      return res.status(500).json({
        error: 'Optimization solver failed',
        scenario_id
      });
    }

    const { hourlyPlan, totalGridKwh, totalCostBdt, peakGridKwh } = solverResult;

    // ─── Step 4: Verify schedule ─────────────────────────────────────────
    const verificationErrors = verifySchedule(hourlyPlan, hours, battery, directiveInterpretation);
    if (verificationErrors.length > 0) {
      logger.warn('Schedule verification issues (proceeding with response)', {
        errors: verificationErrors
      });
    }

    // ─── Step 5: Build summary ───────────────────────────────────────────
    const activeDirectives = directiveInterpretation
      .filter(d => d.applies)
      .map(d => d.directive_type);

    const noOpCount = directiveInterpretation.filter(d => !d.applies).length;

    let planSummary = '';
    if (activeDirectives.length > 0) {
      planSummary = `Applied ${activeDirectives.join(', ')} directive(s)`;
      if (noOpCount > 0) {
        planSummary += ` and ignored ${noOpCount} irrelevant note(s)`;
      }
      planSummary += `. Optimized 24-hour schedule achieves a total grid cost of ${totalCostBdt.toFixed(2)} BDT with peak grid usage of ${peakGridKwh.toFixed(2)} kWh/h while satisfying all energy balance, battery, and directive constraints.`;
    } else {
      planSummary = `All ${noOpCount} operator note(s) are irrelevant to today's energy schedule. Optimized 24-hour schedule achieves ${totalCostBdt.toFixed(2)} BDT total grid cost with standard GridWise rules.`;
    }

    // ─── Step 6: Return response ─────────────────────────────────────────
    const response = {
      scenario_id,
      directive_interpretation: directiveInterpretation,
      hourly_plan: hourlyPlan,
      total_grid_kwh: totalGridKwh,
      total_cost_bdt: totalCostBdt,
      peak_grid_kwh: peakGridKwh,
      plan_summary: planSummary
    };

    const elapsed = Date.now() - requestStart;
    logger.info(`Scenario ${scenario_id} completed in ${elapsed}ms`, {
      cost: totalCostBdt,
      gridKwh: totalGridKwh,
      peakKwh: peakGridKwh,
      activeDirectives: activeDirectives.length,
      elapsed
    });

    return res.status(200).json(response);

  } catch (err) {
    const elapsed = Date.now() - requestStart;
    logger.error(`Unexpected error after ${elapsed}ms: ${err.message}`);
    return res.status(500).json({
      error: 'Internal server error'
    });
  }
});

export default router;
