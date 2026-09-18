import logger from '../../utils/logger.js';

/**
 * Fallback time string parser (supports "noon", "midnight", "8 AM", "2 PM", "14:00", etc.)
 * @param {string} str
 * @returns {number|null} Hour as integer 0-23
 */
function parseTime(str) {
  str = str.trim().toLowerCase();
  if (str === 'noon') return 12;
  if (str === 'midnight') return 0;
  const match = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const period = match[3];
  if (period === 'pm' && hour < 12) hour += 12;
  if (period === 'am' && hour === 12) hour = 0;
  return hour;
}

/**
 * Extract start-inclusive, end-exclusive hours array from natural language text.
 * @param {string} text
 * @returns {number[]|null}
 */
function extractHours(text) {
  const patterns = [
    /(?:from|between)\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?|noon|midnight)\s+(?:to|until|and|-)\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?|noon|midnight)/i,
    /([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?|noon|midnight)\s*(?:to|until|-)\s*([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?|noon|midnight)/i
  ];

  for (const regex of patterns) {
    const m = text.match(regex);
    if (m) {
      let t1 = m[1].trim();
      let t2 = m[2].trim();
      // Handle "from 1 to 3 PM" -> t1 inherits PM
      if (!/(am|pm|noon|midnight)/i.test(t1) && /(am|pm)/i.test(t2)) {
        const p = t2.match(/(am|pm)/i)[0];
        t1 = `${t1} ${p}`;
      }
      const h1 = parseTime(t1);
      const h2 = parseTime(t2);
      if (h1 !== null && h2 !== null && h1 < h2 && h1 >= 0 && h2 <= 24) {
        const hours = [];
        for (let h = h1; h < h2; h++) hours.push(h);
        return hours;
      }
    }
  }
  return null;
}

/**
 * Deterministically interpret an operator note using rule-based heuristics.
 * Used as an offline fallback when Gemini API is unconfigured, unreachable, or rate-limited.
 *
 * @param {string} note - Natural language operator note
 * @param {number} index - Note index
 * @param {object} battery - Battery configuration
 * @returns {object} Directive interpretation object
 */
export function fallbackInterpretNote(note, index, battery) {
  const lower = note.toLowerCase();

  // Distractor / Irrelevant check
  const distractorKeywords = [
    'registration deadline',
    'study room',
    'sports office',
    'next month',
    'library extended',
    'canteen',
    'exam schedule',
    'bus schedule'
  ];
  if (distractorKeywords.some(k => lower.includes(k))) {
    return {
      note_index: index,
      applies: false,
      directive_type: 'no_op',
      structured_adjustment: null,
      explanation: 'Note is unrelated to today\'s campus energy operations.'
    };
  }

  const hours = extractHours(note);

  // 1. Solar reduction
  if (
    /(solar|photovoltaic|panel|pv|rooftop|cloud)/i.test(lower) &&
    /(clean|wash|drop|reduc|curtail|diminish|cloud|shade|recalibration)/i.test(lower)
  ) {
    if (hours) {
      let factor = 0.5;
      const dropMatch = lower.match(/(?:drop to|treated as roughly|treated as|to|roughly)\s*(\d+(?:\.\d+)?)\s*%/i);
      const redMatch =
        lower.match(/(\d+(?:\.\d+)?)\s*%\s*reduction/i) ||
        lower.match(/reduced by\s*(\d+(?:\.\d+)?)\s*%/i);

      if (redMatch) {
        factor = Math.round((1 - parseFloat(redMatch[1]) / 100) * 1000) / 1000;
      } else if (dropMatch) {
        factor = Math.round((parseFloat(dropMatch[1]) / 100) * 1000) / 1000;
      } else if (lower.includes('half')) {
        factor = 0.5;
      } else if (lower.includes('one-third')) {
        factor = 0.333;
      } else if (lower.includes('quarter') || lower.includes('one-fourth')) {
        factor = 0.25;
      } else if (lower.includes('one-fifth')) {
        factor = 0.2;
      }

      return {
        note_index: index,
        applies: true,
        directive_type: 'solar_reduction',
        structured_adjustment: {
          hours,
          factor
        },
        explanation: `Solar generation reduced during hours ${hours[0]} to ${hours[hours.length - 1] + 1}.`
      };
    }
  }

  // 2. No charge window
  if (
    /(charge|charging|charger)/i.test(lower) &&
    !/discharge/i.test(lower) &&
    /(prohibit|no charge|cannot charge|no charging|blocked|not allowed|prevent|stop|isolated|unavailable|disabled)/i.test(lower)
  ) {
    if (hours) {
      return {
        note_index: index,
        applies: true,
        directive_type: 'no_charge_window',
        structured_adjustment: { hours },
        explanation: `Battery charging blocked during hours ${hours[0]} to ${hours[hours.length - 1] + 1}.`
      };
    }
  }

  // 3. No discharge window
  if (
    /(discharge|discharging)/i.test(lower) &&
    /(prohibit|no discharge|cannot discharge|no discharging|must not discharge|do not discharge|blocked|under no circumstances|not allowed|prevent|stop|disabled)/i.test(lower)
  ) {
    if (hours) {
      return {
        note_index: index,
        applies: true,
        directive_type: 'no_discharge_window',
        structured_adjustment: { hours },
        explanation: `Battery discharging blocked during hours ${hours[0]} to ${hours[hours.length - 1] + 1}.`
      };
    }
  }

  // 4. Minimum battery reserve
  if (/(reserve|maintain.*battery|keep at least.*battery|minimum.*battery|remain in the battery)/i.test(lower)) {
    if (hours) {
      let minEnergy = battery.minimum_energy_kwh;
      const pctMatch =
        lower.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of (?:the )?battery capacity|battery reserve)/i) ||
        lower.match(/(?:at least|minimum)\s*(\d+(?:\.\d+)?)\s*%/i);
      const kwhMatch =
        lower.match(/(?:at least|minimum|reserve of)\s*(\d+(?:\.\d+)?)\s*kwh/i) ||
        lower.match(/(\d+(?:\.\d+)?)\s*kwh.*(?:reserve|remain)/i);

      if (pctMatch) {
        minEnergy = battery.capacity_kwh * (parseFloat(pctMatch[1]) / 100);
      } else if (kwhMatch) {
        minEnergy = parseFloat(kwhMatch[1]);
      } else if (lower.includes('half the battery capacity') || lower.includes('half the capacity')) {
        minEnergy = battery.capacity_kwh * 0.5;
      }

      return {
        note_index: index,
        applies: true,
        directive_type: 'minimum_battery_reserve',
        structured_adjustment: {
          hours,
          minimum_energy_kwh: minEnergy
        },
        explanation: `Battery reserve requirement of ${minEnergy} kWh during hours ${hours[0]} to ${hours[hours.length - 1] + 1}.`
      };
    }
  }

  // 5. Max grid window
  if (
    /(grid|intake|feeder|transformer)/i.test(lower) &&
    /(draw|import|exceed|limit|cap|intake|stay at or below)/i.test(lower)
  ) {
    if (hours) {
      const capMatch =
        lower.match(/(?:not draw more than|cannot exceed|not exceed|limited to|limit of|cap of|maximum of|stay at or below|limit is)\s*(\d+(?:\.\d+)?)\s*kwh/i) ||
        lower.match(/(\d+(?:\.\d+)?)\s*kwh.*(?:from the grid|per hour|of grid import)/i);

      if (capMatch) {
        const maxGrid = parseFloat(capMatch[1]);
        return {
          note_index: index,
          applies: true,
          directive_type: 'max_grid_window',
          structured_adjustment: {
            hours,
            max_grid_kwh: maxGrid
          },
          explanation: `Grid import capped at ${maxGrid} kWh during hours ${hours[0]} to ${hours[hours.length - 1] + 1}.`
        };
      }
    }
  }

  // Default fallback: no_op
  return {
    note_index: index,
    applies: false,
    directive_type: 'no_op',
    structured_adjustment: null,
    explanation: 'Note does not require schedule adjustments.'
  };
}

/**
 * Interpret an array of operator notes using the deterministic offline fallback.
 * @param {string[]} operatorNotes
 * @param {object} battery
 * @returns {Array} Array of directive objects
 */
export function fallbackInterpretAll(operatorNotes, battery) {
  logger.info(`Running deterministic fallback interpreter on ${operatorNotes.length} note(s)`);
  return operatorNotes.map((note, index) => fallbackInterpretNote(note, index, battery));
}

