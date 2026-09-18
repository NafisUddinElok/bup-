import { GoogleGenAI, Type } from '@google/genai';
import { buildPrompt } from './prompts.js';
import { validateDirectives } from '../guardrails/validator.js';
import logger from '../../utils/logger.js';

let aiClient = null;

function getClient() {
  if (!aiClient) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }
    aiClient = new GoogleGenAI({ apiKey });
  }
  return aiClient;
}

// Structured output schema for Gemini
const directiveResponseSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      note_index: {
        type: Type.INTEGER,
        description: 'Zero-based index of the corresponding operator note'
      },
      applies: {
        type: Type.BOOLEAN,
        description: 'true for applicable directives; false only for no_op'
      },
      directive_type: {
        type: Type.STRING,
        description: 'One of: solar_reduction, minimum_battery_reserve, no_charge_window, no_discharge_window, max_grid_window, no_op'
      },
      structured_adjustment: {
        type: Type.OBJECT,
        description: 'Machine-checkable directive parameters, or null for no_op',
        nullable: true,
        properties: {
          hours: {
            type: Type.ARRAY,
            items: { type: Type.INTEGER },
            description: 'Affected hours as unique integers 0-23 in ascending order',
            nullable: true
          },
          factor: {
            type: Type.NUMBER,
            description: 'Remaining usable solar fraction (0-1) for solar_reduction',
            nullable: true
          },
          minimum_energy_kwh: {
            type: Type.NUMBER,
            description: 'Minimum battery energy for minimum_battery_reserve',
            nullable: true
          },
          max_grid_kwh: {
            type: Type.NUMBER,
            description: 'Maximum grid import per hour for max_grid_window',
            nullable: true
          }
        }
      },
      explanation: {
        type: Type.STRING,
        description: 'Short explanation of the interpretation'
      }
    },
    required: ['note_index', 'applies', 'directive_type', 'structured_adjustment', 'explanation']
  }
};

/**
 * Interpret operator notes using Gemini LLM.
 * @param {string[]} operatorNotes - Array of 1-3 natural language notes
 * @param {object} battery - Battery configuration from request
 * @returns {Promise<Array>} Validated directive interpretations
 */
export async function interpretOperatorNotes(operatorNotes, battery) {
  const ai = getClient();
  const { systemPrompt, userMessage } = buildPrompt(operatorNotes, battery);

  logger.info(`Interpreting ${operatorNotes.length} operator note(s) via Gemini`);

  let rawResult;
  const maxRetries = 2;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: userMessage,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json',
          responseSchema: directiveResponseSchema,
          temperature: 0.1,
          thinkingConfig: {
            thinkingBudget: 0
          }
        }
      });

      const text = response.text;
      rawResult = JSON.parse(text);
      logger.info('Gemini response parsed successfully');
      break;
    } catch (err) {
      logger.error(`Gemini API attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxRetries) {
        throw new Error(`LLM interpretation failed after ${maxRetries} attempts: ${err.message}`);
      }
      // Wait before retry (exponential backoff)
      await new Promise(r => setTimeout(r, 1000 * attempt));
    }
  }

  // Run guardrails on LLM output
  const validated = validateDirectives(rawResult, operatorNotes.length, battery);
  if (!validated.success) {
    logger.error(`Directive validation failed: ${validated.error}`);
    throw new Error(`Guardrail validation failed: ${validated.error}`);
  }

  logger.info('Directive interpretation validated successfully');
  return validated.data;
}
