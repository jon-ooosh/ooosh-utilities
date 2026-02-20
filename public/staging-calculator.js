/**
 * OOOSH Staging Calculator
 * 
 * Calculates staging/deck requirements from desired dimensions.
 * Handles unit conversion, deck tiling, leg/combiner assignment,
 * and parts list generation.
 * 
 * Phase 1: Calculator engine + UI (read-only)
 * Phase 2: HireHop integration + PDF output (later)
 * 
 * v1.1 - Unit toggle pill, ft/in split fields, auto-convert,
 *         unit-aware display, nearest stock leg suggestions,
 *         stock-constrained deck alternatives
 */

// ============================================================================
// STOCK CATALOGUE
// Hardcoded from HireHop staging category. Heights parsed from item names.
// In Phase 2, this will be replaced with live HireHop API queries.
// ============================================================================

const STOCK = {
  // ----- DECKS (Category 445) -----
  // Dimensions in inches for internal calculation. qty = total owned.
  decks: [
    { name: "8' x 4' Litedeck",   lengthIn: 96, widthIn: 48, qty: 17, type: 'litedeck' },
    { name: "8' x 2' Litedeck",   lengthIn: 96, widthIn: 24, qty: 10, type: 'litedeck' },
    { name: "6' x 2' Litedeck",   lengthIn: 72, widthIn: 24, qty: 4,  type: 'litedeck' },
    { name: "6' x 2' Steeldeck",  lengthIn: 72, widthIn: 24, qty: 2,  type: 'steeldeck' },
    { name: "4' x 4' Litedeck",   lengthIn: 48, widthIn: 48, qty: 2,  type: 'litedeck' },
    { name: "4' x 2' Litedeck",   lengthIn: 48, widthIn: 24, qty: 9,  type: 'litedeck' },
    { name: "2' x 2' Litedeck",   lengthIn: 24, widthIn: 24, qty: 10, type: 'litedeck' },
    // Items with 0 stock or hidden — included so the engine knows they exist
    { name: "6' x 4' Litedeck",   lengthIn: 72, widthIn: 48, qty: 0,  type: 'litedeck' },
  ],

  // ----- LEGS (Category 446) -----
  // heightIn = FINISHED deck height (leg + deck surface)
  legs: [
    { name: '8" staging leg',                  heightIn: 8,  qty: 0,  colour: '' },
    { name: '12" / 1ft staging leg',           heightIn: 12, qty: 69, colour: 'White end' },
    { name: '18" / 1ft 6" staging leg',        heightIn: 18, qty: 49, colour: '' },
    { name: '24" / 2ft staging leg',           heightIn: 24, qty: 49, colour: 'Green end' },
    { name: '30" / 2ft 6" staging leg',        heightIn: 30, qty: 28, colour: 'Orange end' },
    { name: '38" / 3ft 2" staging leg',        heightIn: 38, qty: 24, colour: 'Blue end' },
    { name: '48" / 4ft staging leg',           heightIn: 48, qty: 16, colour: 'Plain silver' },
  ],

  // ----- COMBINERS -----
  // All combiners add 6" to the stack height
  combiners: {
    twoInOne: { name: '2-in-1 leg combiner', qty: 17, heightOffsetIn: 6 },
    fourInOne: { name: '4-in-1 leg combiner', qty: 30, heightOffsetIn: 6 },
  },

  // ----- SCREWJACKS -----
  // Go INSIDE a leg. Min usable ~2", max usable ~70% of total length.
  screwjacks: [
    { name: '8" / 20cm screwjack',    totalLengthIn: 8,    minIn: 2, maxIn: 5.5,  qty: 20 },
    { name: '19.5" / 50cm screwjack', totalLengthIn: 19.5, minIn: 2, maxIn: 13.5, qty: 8  },
  ],

  // ----- WHEELS -----
  wheels: [
    { name: '4" rolling riser wheel (w/ deck pickup)', heightIn: 12, qty: 63, note: '1ft finished height' },
    { name: '6" rolling riser wheel',                  heightIn: 6,  qty: 44, note: '' },
    { name: '8" rolling riser wheel',                  heightIn: 8,  qty: 8,  note: '' },
  ],

  // ----- ACCESSORIES -----
  handrails: [
    { name: "2' handrail", lengthIn: 24, qty: 2 },
    { name: "4' handrail", lengthIn: 48, qty: 4 },
    { name: "8' handrail", lengthIn: 96, qty: 4 },
  ],

  steps: [
    { name: "1ft step",   heightIn: 12, qty: 1 },
    { name: "2ft steps",  heightIn: 24, qty: 2 },
  ],
};

// Combiner height offset in inches (universal constant)
const COMBINER_HEIGHT_OFFSET = 6;

// Available leg heights for quick lookup (sorted ascending)
const LEG_HEIGHTS = STOCK.legs.map(l => l.heightIn).sort((a, b) => a - b);


// ============================================================================
// UNIT CONVERSION HELPERS
// ============================================================================

/** Convert meters to inches */
function metersToInches(m) {
  return m * 39.3701;
}

/** Convert feet to inches */
function feetToInches(ft) {
  return ft * 12;
}

/** Convert inches to feet and inches string, e.g. "2' 6\"" */
function inchesToFeetStr(inches) {
  let ft = Math.floor(inches / 12);
  let remainIn = Math.round(inches % 12);
  // Handle rounding up: if remainIn rounds to 12, carry to next foot
  if (remainIn >= 12) {
    ft += 1;
    remainIn = 0;
  }
  if (remainIn === 0) return `${ft}'`;
  if (ft === 0) return `${remainIn}"`;
  return `${ft}' ${remainIn}"`;
}

/** Convert inches to a friendly metric string */
function inchesToMetricStr(inches) {
  const cm = inches * 2.54;
  if (cm >= 100) return `${(cm / 100).toFixed(2)}m`;
  return `${Math.round(cm)}cm`;
}

/** Format inches in both imperial and metric */
function formatDimension(inches) {
  return `${inchesToFeetStr(inches)} (${inchesToMetricStr(inches)})`;
}

/** Format inches for the currently selected unit (primary display) */
function formatDimensionForUnit(inches, unit) {
  if (unit === 'm') {
    return inchesToMetricStr(inches);
  }
  return inchesToFeetStr(inches);
}

/** Format inches with primary unit first and secondary in brackets */
function formatDimensionPrimary(inches, unit) {
  if (unit === 'm') {
    return `${inchesToMetricStr(inches)} (${inchesToFeetStr(inches)})`;
  }
  return `${inchesToFeetStr(inches)} (${inchesToMetricStr(inches)})`;
}


// ============================================================================
// TILING ALGORITHM
// Tiles a rectangular area with available deck sizes.
// Strategy: greedy fill — largest decks first, row by row.
// ============================================================================

/**
 * Tile a rectangular area (lengthIn x widthIn) with available deck sizes.
 * Returns an array of placed decks with positions, or null if impossible.
 * 
 * @param {number} targetLengthIn - Target length in inches
 * @param {number} targetWidthIn - Target width in inches
 * @param {boolean} inStockOnly - If true, only use decks with qty > 0
 * @returns {Array|null} Placed decks or null if impossible
 * 
 * Each placed deck: { deck, x, y, orientedLength, orientedWidth }
 * where x,y are the top-left corner in inches from origin.
 */
function tileRectangle(targetLengthIn, targetWidthIn, inStockOnly) {
  // Get available deck sizes
  // If inStockOnly, filter to decks we actually own
  const availableDecks = inStockOnly
    ? STOCK.decks.filter(d => d.lengthIn > 0 && d.qty > 0)
    : STOCK.decks.filter(d => d.lengthIn > 0);

  if (availableDecks.length === 0) return null;

  // Generate all possible orientations (each deck can be rotated 90°)
  const orientations = [];
  for (const deck of availableDecks) {
    // Normal orientation
    orientations.push({ deck, l: deck.lengthIn, w: deck.widthIn });
    // Rotated (only if it's not square)
    if (deck.lengthIn !== deck.widthIn) {
      orientations.push({ deck, l: deck.widthIn, w: deck.lengthIn });
    }
  }

  // Get unique row depths (widths) we can use, sorted largest first
  const possibleRowDepths = [...new Set(orientations.map(o => o.w))].sort((a, b) => b - a);

  // Try to fill the width with rows of these depths
  const rowCombos = findRowCombinations(targetWidthIn, possibleRowDepths);

  if (rowCombos.length === 0) {
    return null; // Can't tile this width with our deck depths
  }

  // Try each row combination and pick the one using fewest total decks
  let bestLayout = null;
  let bestDeckCount = Infinity;

  for (const rowDepths of rowCombos) {
    const layout = [];
    let currentY = 0;
    let valid = true;

    for (const rowDepth of rowDepths) {
      // For this row, find deck orientations that fit this depth
      const fittingOrientations = orientations.filter(o => o.w === rowDepth);

      // Fill the row length greedily with largest decks first
      const rowDecks = fillRow(targetLengthIn, fittingOrientations);

      if (!rowDecks) {
        valid = false;
        break;
      }

      // Place decks in this row
      let currentX = 0;
      for (const placed of rowDecks) {
        layout.push({
          deck: placed.deck,
          x: currentX,
          y: currentY,
          orientedLength: placed.l,
          orientedWidth: placed.w,
        });
        currentX += placed.l;
      }

      currentY += rowDepth;
    }

    if (valid && layout.length < bestDeckCount) {
      bestLayout = layout;
      bestDeckCount = layout.length;
    }
  }

  return bestLayout;
}

/**
 * Find combinations of row depths that sum to the target width.
 * Returns array of arrays, e.g. [[48, 48, 24], [48, 24, 24, 24]]
 * Limited to reasonable combinations (max 20 rows).
 */
function findRowCombinations(targetWidth, depths) {
  const results = [];

  function recurse(remaining, combo, minDepth) {
    if (remaining === 0) {
      results.push([...combo]);
      return;
    }
    if (remaining < 0 || combo.length > 20) return;

    for (const d of depths) {
      if (d > remaining) continue;
      if (d < minDepth) continue; // Avoid duplicate combos via ordering
      combo.push(d);
      recurse(remaining - d, combo, d);
      combo.pop();
    }
  }

  recurse(targetWidth, [], 0);
  return results;
}

/**
 * Fill a single row of given length using deck orientations of matching depth.
 * Greedy: largest decks first.
 * Returns array of { deck, l, w } or null if can't fill exactly.
 */
function fillRow(targetLength, orientations) {
  // Sort by length descending (use biggest decks first)
  const sorted = [...orientations].sort((a, b) => b.l - a.l);

  const result = [];
  let remaining = targetLength;

  // Greedy fill
  for (const ori of sorted) {
    while (remaining >= ori.l) {
      result.push(ori);
      remaining -= ori.l;
    }
  }

  return remaining === 0 ? result : null;
}


// ============================================================================
// SNAP TO ACHIEVABLE DIMENSIONS
// Find the nearest dimensions that can be exactly tiled with our deck sizes.
// ============================================================================

/**
 * Given a target dimension in inches, find the nearest achievable dimension
 * that can be built from our deck sizes (allowing both orientations).
 * Returns array of achievable dimensions near the target, sorted by proximity.
 * 
 * @param {number} targetIn - Target dimension in inches
 * @param {boolean} inStockOnly - If true, only consider decks with qty > 0
 */
function findNearestAchievable(targetIn, inStockOnly) {
  // All possible single-dimension lengths we can build from deck pieces
  const decksToUse = inStockOnly
    ? STOCK.decks.filter(d => d.qty > 0)
    : STOCK.decks;

  const deckLengths = [...new Set(
    decksToUse.flatMap(d => [d.lengthIn, d.widthIn])
  )].filter(l => l > 0).sort((a, b) => a - b);

  if (deckLengths.length === 0) return [];

  // Generate all achievable lengths up to ~2x target (within reason)
  const maxLen = Math.max(targetIn * 1.5, 240); // At least 20ft
  const achievable = new Set();

  // Simpler approach: additive combinations
  // Start with base lengths
  for (const l of deckLengths) {
    achievable.add(l);
  }
  // Build up by adding deck lengths to existing achievable lengths
  let lastRound = [...achievable];
  for (let round = 0; round < 10; round++) {
    const newLengths = [];
    for (const existing of lastRound) {
      for (const l of deckLengths) {
        const sum = existing + l;
        if (sum <= maxLen && !achievable.has(sum)) {
          achievable.add(sum);
          newLengths.push(sum);
        }
      }
    }
    if (newLengths.length === 0) break;
    lastRound = newLengths;
  }

  // Sort by proximity to target
  return [...achievable].sort((a, b) =>
    Math.abs(a - targetIn) - Math.abs(b - targetIn)
  );
}


// ============================================================================
// JUNCTION MAPPING
// Given a layout of placed decks, identify all corner junction points
// and classify them as solo (1 deck), edge (2 decks), or interior (4 decks).
// ============================================================================

/**
 * Map all junction points from a deck layout.
 * Returns array of { x, y, deckCount, type }
 * where type is 'solo' (1), 'edge' (2), or 'interior' (4).
 */
function mapJunctions(layout) {
  // Each deck has 4 corners. Build a map of all corner positions
  // and count how many decks share each corner.
  const cornerMap = new Map(); // key: "x,y" → count

  for (const placed of layout) {
    const corners = [
      [placed.x, placed.y],                                                // top-left
      [placed.x + placed.orientedLength, placed.y],                        // top-right
      [placed.x, placed.y + placed.orientedWidth],                         // bottom-left
      [placed.x + placed.orientedLength, placed.y + placed.orientedWidth], // bottom-right
    ];

    for (const [cx, cy] of corners) {
      const key = `${cx},${cy}`;
      cornerMap.set(key, (cornerMap.get(key) || 0) + 1);
    }
  }

  // Convert to junction objects
  const junctions = [];
  for (const [key, count] of cornerMap) {
    const [x, y] = key.split(',').map(Number);
    let type;
    if (count === 1) type = 'solo';
    else if (count === 2) type = 'edge';
    else type = 'interior'; // 3 or 4
    junctions.push({ x, y, deckCount: count, type });
  }

  return junctions;
}


// ============================================================================
// LEG & COMBINER ASSIGNMENT
// Based on junction types and user combiner preference, assign the correct
// hardware to each junction point.
// ============================================================================

/**
 * Assign legs and combiners to junctions.
 * 
 * @param {Array} junctions - from mapJunctions()
 * @param {number} finishedHeightIn - desired finished stage height in inches
 * @param {string} combinerMode - 'all' | 'interior-only' | 'none'
 * @returns {Object} { assignments, legNeeds, combinerNeeds, warnings }
 */
function assignHardware(junctions, finishedHeightIn, combinerMode) {
  const assignments = [];
  const legNeeds = {};     // heightIn → count
  const combinerNeeds = { twoInOne: 0, fourInOne: 0 };
  const warnings = [];

  // Height needed under a combiner
  const combinerLegHeight = finishedHeightIn - COMBINER_HEIGHT_OFFSET;

  for (const junc of junctions) {
    const assignment = { ...junc, hardware: [] };

    // Decide if this junction gets a combiner
    let useCombiner = false;
    let combinerType = null;

    if (combinerMode === 'all' && junc.type !== 'solo') {
      useCombiner = true;
      combinerType = junc.type === 'interior' ? 'fourInOne' : 'twoInOne';
    } else if (combinerMode === 'interior-only' && junc.type === 'interior') {
      useCombiner = true;
      combinerType = 'fourInOne';
    }
    // combinerMode === 'none' → never use combiners

    if (useCombiner) {
      // Combiner + shorter leg
      combinerNeeds[combinerType]++;
      assignment.hardware.push({
        item: combinerType === 'fourInOne' ? '4-in-1 combiner' : '2-in-1 combiner',
        type: 'combiner'
      });

      const legH = combinerLegHeight;
      if (legH <= 0) {
        warnings.push(`Combiner at (${junc.x}", ${junc.y}"): finished height ${finishedHeightIn}" is too low for a combiner (need > ${COMBINER_HEIGHT_OFFSET}")`);
      } else {
        legNeeds[legH] = (legNeeds[legH] || 0) + 1;
        assignment.hardware.push({ item: `${legH}" leg`, type: 'leg', heightIn: legH });
      }
    } else {
      // No combiner — one leg per deck meeting at this junction
      // Solo corner: 1 leg. Edge without combiner: 2 separate legs. Interior without combiner: up to 4 legs.
      const legCount = junc.deckCount;
      legNeeds[finishedHeightIn] = (legNeeds[finishedHeightIn] || 0) + legCount;
      for (let i = 0; i < legCount; i++) {
        assignment.hardware.push({ item: `${finishedHeightIn}" leg`, type: 'leg', heightIn: finishedHeightIn });
      }
    }

    assignments.push(assignment);
  }

  return { assignments, legNeeds, combinerNeeds, warnings };
}


// ============================================================================
// LEG MATCHING
// Match required leg heights to actual stock, flag mismatches.
// ============================================================================

/**
 * Match required leg heights to available stock.
 * Returns { matched, screwjackNeeded, unavailable }
 */
function matchLegs(legNeeds) {
  const matched = [];      // { leg, qtyNeeded }
  const screwjackNeeded = []; // Heights that don't match any leg but could use screwjack
  const unavailable = [];  // Heights we simply can't do

  for (const [heightStr, qty] of Object.entries(legNeeds)) {
    const heightIn = parseFloat(heightStr);

    // Find exact match in stock
    const exactLeg = STOCK.legs.find(l => l.heightIn === heightIn);

    if (exactLeg) {
      matched.push({
        leg: exactLeg,
        qtyNeeded: qty,
        shortfall: Math.max(0, qty - exactLeg.qty),
      });
    } else {
      // No exact match — check if screwjack can bridge the gap
      // A screwjack goes inside a leg, adding adjustable height.
      // We'd need a leg + screwjack combo where:
      //   leg_height + screwjack_adjustment = desired_height
      // But wait — legs are FINISHED heights. Screwjack goes under the leg,
      // so we'd need: leg_height_without_deck + screwjack = physical_height_needed
      // 
      // Actually, simplest interpretation: no standard leg matches.
      // Flag as needing screwjack solution.
      screwjackNeeded.push({ heightIn, qty });
    }
  }

  return { matched, screwjackNeeded, unavailable };
}


// ============================================================================
// NEAREST STOCK HEIGHT SUGGESTIONS
// When leg height doesn't match stock, find the nearest standard heights
// above and below, considering combiner offset.
// ============================================================================

/**
 * Find alternative standard stage heights that would use in-stock legs.
 * Returns array of { stageHeightIn, legHeightIn, legName, direction }
 * 
 * @param {number} requestedHeightIn - The desired finished stage height
 * @param {string} combinerMode - affects whether offset is applied
 * @param {Array} junctions - to know if combiners are involved
 */
function findAlternativeHeights(requestedHeightIn, combinerMode, junctions) {
  const alternatives = [];
  const hasCombinerJunctions = junctions.some(j => j.type !== 'solo');
  const usesCombinersAtAll = combinerMode !== 'none' && hasCombinerJunctions;

  // For each standard leg height, calculate what stage height it produces
  for (const leg of STOCK.legs) {
    // Skip legs with zero stock
    if (leg.qty === 0) continue;

    // Without combiner: stage height = leg height
    // With combiner: stage height = leg height + 6"
    // We need to consider BOTH cases since a stage can have both types of junctions

    // Case 1: This leg used directly (solo corners, or no-combiner mode)
    const directStageHeight = leg.heightIn;

    // Case 2: This leg used under a combiner
    const combinerStageHeight = leg.heightIn + COMBINER_HEIGHT_OFFSET;

    // For the current combiner mode, what stage heights are possible?
    if (combinerMode === 'none') {
      // All junctions use direct legs
      if (directStageHeight !== requestedHeightIn) {
        alternatives.push({
          stageHeightIn: directStageHeight,
          legHeightIn: leg.heightIn,
          legName: leg.name,
          legColour: leg.colour,
          direction: directStageHeight < requestedHeightIn ? 'lower' : 'higher',
          delta: Math.abs(directStageHeight - requestedHeightIn),
        });
      }
    } else {
      // Mixed: solo corners need direct legs, combiner junctions need shorter legs
      // The stage height is determined by the combiner junctions (since solo corners
      // also need to match). So stage height = combiner_leg + 6" = direct_leg.
      // Both must equal the same finished height.
      // 
      // When combiners are in use:
      //   - Combiner junctions: leg_height + 6" = stage_height → leg = stage - 6"
      //   - Solo corners: leg_height = stage_height
      // Both leg heights must exist in stock for a clean solution.
      //
      // But for suggestions, we suggest stage heights where AT LEAST
      // the combiner legs match stock (the more numerous type).
      // Solo corners can use the same direct height.

      // Suggest based on combiner leg (the height that matters most)
      if (combinerStageHeight !== requestedHeightIn) {
        // Check if the solo-corner leg also exists in stock
        const soloLeg = STOCK.legs.find(l => l.heightIn === combinerStageHeight);
        const soloAvailable = soloLeg && soloLeg.qty > 0;

        alternatives.push({
          stageHeightIn: combinerStageHeight,
          legHeightIn: leg.heightIn,
          legName: leg.name,
          legColour: leg.colour,
          combinerLeg: true,
          soloLegAvailable: soloAvailable,
          soloLegName: soloLeg ? soloLeg.name : null,
          direction: combinerStageHeight < requestedHeightIn ? 'lower' : 'higher',
          delta: Math.abs(combinerStageHeight - requestedHeightIn),
        });
      }
    }
  }

  // Sort by proximity to requested height
  alternatives.sort((a, b) => a.delta - b.delta);

  // Deduplicate by stage height (keep closest)
  const seen = new Set();
  const unique = [];
  for (const alt of alternatives) {
    if (!seen.has(alt.stageHeightIn)) {
      seen.add(alt.stageHeightIn);
      unique.push(alt);
    }
  }

  // Return the nearest few (up to 4 — 2 below, 2 above)
  const lower = unique.filter(a => a.direction === 'lower').slice(0, 2);
  const higher = unique.filter(a => a.direction === 'higher').slice(0, 2);
  return [...lower, ...higher].sort((a, b) => a.stageHeightIn - b.stageHeightIn);
}


// ============================================================================
// COMPILE PARTS LIST
// Aggregate everything into a clear, printable parts list.
// ============================================================================

/**
 * Compile the full parts list from a calculation result.
 * @returns {Array} of { category, name, qtyNeeded, qtyOwned, shortfall, note }
 */
function compilePartsList(layout, hardware, legMatch) {
  const parts = [];

  // ----- DECKS -----
  const deckCounts = {};
  for (const placed of layout) {
    const key = placed.deck.name;
    deckCounts[key] = (deckCounts[key] || 0) + 1;
  }
  for (const deck of STOCK.decks) {
    const needed = deckCounts[deck.name] || 0;
    if (needed > 0) {
      parts.push({
        category: 'Decks',
        name: deck.name,
        qtyNeeded: needed,
        qtyOwned: deck.qty,
        shortfall: Math.max(0, needed - deck.qty),
        note: '',
      });
    }
  }

  // ----- COMBINERS -----
  if (hardware.combinerNeeds.fourInOne > 0) {
    const c = STOCK.combiners.fourInOne;
    parts.push({
      category: 'Combiners',
      name: c.name,
      qtyNeeded: hardware.combinerNeeds.fourInOne,
      qtyOwned: c.qty,
      shortfall: Math.max(0, hardware.combinerNeeds.fourInOne - c.qty),
      note: '',
    });
  }
  if (hardware.combinerNeeds.twoInOne > 0) {
    const c = STOCK.combiners.twoInOne;
    parts.push({
      category: 'Combiners',
      name: c.name,
      qtyNeeded: hardware.combinerNeeds.twoInOne,
      qtyOwned: c.qty,
      shortfall: Math.max(0, hardware.combinerNeeds.twoInOne - c.qty),
      note: '',
    });
  }

  // ----- LEGS -----
  for (const m of legMatch.matched) {
    parts.push({
      category: 'Legs',
      name: m.leg.name,
      qtyNeeded: m.qtyNeeded,
      qtyOwned: m.leg.qty,
      shortfall: m.shortfall,
      note: m.leg.colour || '',
    });
  }

  // ----- SCREWJACK FLAGS -----
  for (const sj of legMatch.screwjackNeeded) {
    parts.push({
      category: 'Legs',
      name: `${sj.heightIn}" leg (non-standard)`,
      qtyNeeded: sj.qty,
      qtyOwned: 0,
      shortfall: sj.qty,
      note: '⚠️ No standard leg — screwjack or sub-hire needed',
    });
  }

  return parts;
}


// ============================================================================
// MAIN CALCULATION ENTRY POINT
// ============================================================================

/**
 * Run the full staging calculation.
 * 
 * @param {Object} params
 * @param {number} params.length - Desired length (in the specified unit)
 * @param {number} params.width - Desired width (in the specified unit)
 * @param {number} params.height - Desired finished height (in the specified unit)
 * @param {string} params.unit - 'ft' or 'm'
 * @param {string} params.combinerMode - 'all' | 'interior-only' | 'none'
 * @returns {Object} Full calculation result
 */
function calculate(params) {
  const { length, width, height, unit, combinerMode } = params;

  // Convert to inches
  const toInches = unit === 'm' ? metersToInches : feetToInches;
  const targetLengthIn = toInches(length);
  const targetWidthIn = toInches(width);
  const targetHeightIn = toInches(height);

  // Find nearest achievable dimensions (allowing all decks)
  const achievableLengths = findNearestAchievable(targetLengthIn, false);
  const achievableWidths = findNearestAchievable(targetWidthIn, false);

  // Try exact first, then nearest
  let bestLength = achievableLengths[0];
  let bestWidth = achievableWidths[0];

  // Check if exact match exists
  const exactLength = achievableLengths.find(l => l === targetLengthIn);
  const exactWidth = achievableWidths.find(w => w === targetWidthIn);
  if (exactLength) bestLength = exactLength;
  if (exactWidth) bestWidth = exactWidth;

  // Tile the rectangle (using all decks, including sub-hire)
  const layout = tileRectangle(bestLength, bestWidth, false);

  if (!layout) {
    return {
      success: false,
      error: 'Could not tile these dimensions with available deck sizes.',
      suggestions: {
        lengths: achievableLengths.slice(0, 5).map(l => ({ inches: l, display: formatDimensionPrimary(l, unit) })),
        widths: achievableWidths.slice(0, 5).map(w => ({ inches: w, display: formatDimensionPrimary(w, unit) })),
      },
    };
  }

  // Check if height matches a standard leg
  const standardHeightMatch = LEG_HEIGHTS.includes(targetHeightIn);
  const nearestLegHeight = LEG_HEIGHTS.reduce((best, h) =>
    Math.abs(h - targetHeightIn) < Math.abs(best - targetHeightIn) ? h : best
  , LEG_HEIGHTS[0]);

  // Use the exact height if it matches a standard leg, otherwise use nearest
  const effectiveHeight = standardHeightMatch ? targetHeightIn : nearestLegHeight;

  // Map junctions
  const junctions = mapJunctions(layout);

  // Assign hardware
  const hardware = assignHardware(junctions, effectiveHeight, combinerMode);

  // Match legs to stock
  const legMatch = matchLegs(hardware.legNeeds);

  // Compile parts list
  const partsList = compilePartsList(layout, hardware, legMatch);

  // Calculate totals
  const totalDecks = layout.length;
  const totalJunctions = junctions.length;
  const hasShortfall = partsList.some(p => p.shortfall > 0);

  // Dimension info
  const dimensionMatch = (bestLength === targetLengthIn && bestWidth === targetWidthIn);

  // ----- ALTERNATIVE HEIGHT SUGGESTIONS -----
  // Show alternatives when:
  // 1. Legs are non-standard (screwjack needed)
  // 2. Height was snapped to nearest standard (user might prefer another option)
  const hasNonStandardLegs = legMatch.screwjackNeeded.length > 0;
  const heightWasSnapped = !standardHeightMatch;
  let heightAlternatives = [];
  if (hasNonStandardLegs || heightWasSnapped) {
    heightAlternatives = findAlternativeHeights(effectiveHeight, combinerMode, junctions);
    // If height was snapped (but legs are standard), also include the effective height
    // since the user might want to confirm that's the best option.
    // Filter out the current effective height since it's already being used
    heightAlternatives = heightAlternatives.filter(a => a.stageHeightIn !== effectiveHeight);
  }

  // ----- STOCK-CONSTRAINED DECK ALTERNATIVE -----
  // If primary layout has deck shortfalls, try tiling with in-stock decks only
  const hasDeckShortfall = partsList.some(p => p.category === 'Decks' && p.shortfall > 0);
  let stockAlternativeLayout = null;
  let stockAlternativeParts = null;

  if (hasDeckShortfall) {
    // Try tiling the same dimensions with only in-stock decks
    const altLayout = tileRectangle(bestLength, bestWidth, true);
    if (altLayout) {
      // Check if this alternative actually avoids shortfalls
      const altDeckCounts = {};
      for (const placed of altLayout) {
        const key = placed.deck.name;
        altDeckCounts[key] = (altDeckCounts[key] || 0) + 1;
      }
      const altHasShortfall = Object.entries(altDeckCounts).some(([name, needed]) => {
        const deck = STOCK.decks.find(d => d.name === name);
        return deck && needed > deck.qty;
      });

      // Only show alternative if it's different AND reduces/eliminates shortfalls
      const primaryDeckCounts = {};
      for (const placed of layout) {
        primaryDeckCounts[placed.deck.name] = (primaryDeckCounts[placed.deck.name] || 0) + 1;
      }
      const isDifferent = JSON.stringify(altDeckCounts) !== JSON.stringify(primaryDeckCounts);

      if (isDifferent) {
        stockAlternativeLayout = altLayout;
        stockAlternativeParts = [];
        for (const deck of STOCK.decks) {
          const needed = altDeckCounts[deck.name] || 0;
          if (needed > 0) {
            stockAlternativeParts.push({
              name: deck.name,
              qtyNeeded: needed,
              qtyOwned: deck.qty,
              shortfall: Math.max(0, needed - deck.qty),
              noShortfall: needed <= deck.qty,
            });
          }
        }
      }
    }

    // If same-dimension tiling with stock doesn't work or still has shortfalls,
    // also try to find nearest dimensions achievable purely from stock
    if (!stockAlternativeLayout) {
      const stockLengths = findNearestAchievable(targetLengthIn, true);
      const stockWidths = findNearestAchievable(targetWidthIn, true);

      // Try a few nearby combinations
      for (let li = 0; li < Math.min(3, stockLengths.length); li++) {
        for (let wi = 0; wi < Math.min(3, stockWidths.length); wi++) {
          const tryL = stockLengths[li];
          const tryW = stockWidths[wi];
          if (tryL === bestLength && tryW === bestWidth) continue; // Already tried
          const tryLayout = tileRectangle(tryL, tryW, true);
          if (tryLayout) {
            const tryCounts = {};
            for (const placed of tryLayout) {
              tryCounts[placed.deck.name] = (tryCounts[placed.deck.name] || 0) + 1;
            }
            const tryHasShortfall = Object.entries(tryCounts).some(([name, needed]) => {
              const deck = STOCK.decks.find(d => d.name === name);
              return deck && needed > deck.qty;
            });

            if (!tryHasShortfall) {
              stockAlternativeLayout = tryLayout;
              stockAlternativeLayout._altDimensions = { lengthIn: tryL, widthIn: tryW };
              stockAlternativeParts = [];
              for (const deck of STOCK.decks) {
                const needed = tryCounts[deck.name] || 0;
                if (needed > 0) {
                  stockAlternativeParts.push({
                    name: deck.name,
                    qtyNeeded: needed,
                    qtyOwned: deck.qty,
                    shortfall: 0,
                    noShortfall: true,
                  });
                }
              }
              break;
            }
          }
        }
        if (stockAlternativeLayout) break;
      }
    }
  }

  return {
    success: true,
    input: {
      requested: {
        length: { value: length, unit, inches: targetLengthIn, display: formatDimensionPrimary(targetLengthIn, unit) },
        width: { value: width, unit, inches: targetWidthIn, display: formatDimensionPrimary(targetWidthIn, unit) },
        height: { value: height, unit, inches: targetHeightIn, display: formatDimensionPrimary(targetHeightIn, unit) },
      },
      combinerMode,
      unit,
    },
    result: {
      actualLength: { inches: bestLength, display: formatDimensionPrimary(bestLength, unit) },
      actualWidth: { inches: bestWidth, display: formatDimensionPrimary(bestWidth, unit) },
      actualHeight: { inches: effectiveHeight, display: formatDimensionPrimary(effectiveHeight, unit) },
      dimensionMatch,
      heightMatch: standardHeightMatch,
      nearestLegHeight: !standardHeightMatch ? { inches: nearestLegHeight, display: formatDimensionPrimary(nearestLegHeight, unit) } : null,
    },
    layout,
    junctions: {
      total: totalJunctions,
      solo: junctions.filter(j => j.type === 'solo').length,
      edge: junctions.filter(j => j.type === 'edge').length,
      interior: junctions.filter(j => j.type === 'interior').length,
      all: junctions,
    },
    hardware,
    legMatch,
    partsList,
    // New: height alternatives and stock-constrained deck alternatives
    heightAlternatives,
    stockAlternativeLayout,
    stockAlternativeParts,
    summary: {
      totalDecks,
      hasShortfall,
      warnings: hardware.warnings,
      area: {
        sqFt: (bestLength * bestWidth) / 144,
        sqM: (bestLength * bestWidth) / 1550.0031,
      },
    },
  };
}


// ============================================================================
// UI LOGIC
// ============================================================================

// State
let currentResult = null;
let currentUnit = 'm';

/** Get the current unit from the toggle pill */
function getCurrentUnit() {
  return currentUnit;
}

/** Initialize the page */
document.addEventListener('DOMContentLoaded', () => {
  // Check authentication (same localStorage pattern as hub)
  const sessionToken = localStorage.getItem('staffHubSession');
  const sessionExpiry = localStorage.getItem('staffHubSessionExpiry');

  if (!sessionToken || !sessionExpiry || new Date(sessionExpiry) <= new Date()) {
    // Not authenticated — redirect to hub
    window.location.href = '/';
    return;
  }

  // Set up event listeners
  document.getElementById('calc-form').addEventListener('submit', handleCalculate);

  // Unit toggle pill buttons
  const pillBtns = document.querySelectorAll('.unit-btn');
  pillBtns.forEach(btn => {
    btn.addEventListener('click', () => handleUnitToggle(btn.dataset.unit));
  });

  // Set default values (metric)
  currentUnit = 'm';
  document.getElementById('stage-length-m').value = '6';
  document.getElementById('stage-width-m').value = '4';
  document.getElementById('stage-height-m').value = '0.6';
  syncFieldVisibility();
});


// ============================================================================
// UNIT TOGGLE & AUTO-CONVERSION
// ============================================================================

/**
 * Handle switching between metric and imperial.
 * Reads current values, converts them, and populates the new fields.
 */
function handleUnitToggle(newUnit) {
  if (newUnit === currentUnit) return;

  const oldUnit = currentUnit;

  // Read current values in inches (our universal intermediate)
  const lengthIn = readDimensionInches('length', oldUnit);
  const widthIn = readDimensionInches('width', oldUnit);
  const heightIn = readDimensionInches('height', oldUnit);

  // Update state and UI
  currentUnit = newUnit;

  // Update pill active state
  document.querySelectorAll('.unit-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.unit === newUnit);
  });

  // Show/hide appropriate input fields
  syncFieldVisibility();

  // Write converted values into the new fields
  if (lengthIn > 0) writeDimensionFromInches('length', lengthIn, newUnit);
  if (widthIn > 0) writeDimensionFromInches('width', widthIn, newUnit);
  if (heightIn > 0) writeDimensionFromInches('height', heightIn, newUnit);
}

/**
 * Read a dimension's current value and return it in inches.
 * @param {string} dim - 'length' | 'width' | 'height'
 * @param {string} unit - 'm' or 'ft'
 */
function readDimensionInches(dim, unit) {
  if (unit === 'm') {
    const val = parseFloat(document.getElementById(`stage-${dim}-m`).value);
    return isNaN(val) ? 0 : metersToInches(val);
  } else {
    const ft = parseFloat(document.getElementById(`stage-${dim}-ft`).value) || 0;
    const inches = parseFloat(document.getElementById(`stage-${dim}-in`).value) || 0;
    return (ft * 12) + inches;
  }
}

/**
 * Write a value (in inches) into the appropriate fields for the given unit.
 * @param {string} dim - 'length' | 'width' | 'height'
 * @param {number} inches - Value in inches
 * @param {string} unit - 'm' or 'ft'
 */
function writeDimensionFromInches(dim, inches, unit) {
  if (unit === 'm') {
    const meters = inches * 0.0254;
    // Smart rounding: if within 1cm of a 5cm increment, snap to it.
    // This prevents 5.99m when the user originally entered 6m and toggled units.
    const rounded5cm = Math.round(meters * 20) / 20; // nearest 0.05m
    const useSnapped = Math.abs(meters - rounded5cm) < 0.015; // within 1.5cm
    const display = useSnapped ? rounded5cm.toFixed(2) : meters.toFixed(2);
    document.getElementById(`stage-${dim}-m`).value = display;
  } else {
    let ft = Math.floor(inches / 12);
    let remainIn = Math.round(inches % 12);
    // Handle rounding up: if remainIn rounds to 12, carry to next foot
    if (remainIn >= 12) {
      ft += 1;
      remainIn = 0;
    }
    document.getElementById(`stage-${dim}-ft`).value = ft || '';
    document.getElementById(`stage-${dim}-in`).value = remainIn || '';
  }
}

/** Show/hide metric vs imperial input fields */
function syncFieldVisibility() {
  const isMetric = currentUnit === 'm';
  const dims = ['length', 'width', 'height'];

  for (const dim of dims) {
    const metricEl = document.getElementById(`${dim}-metric`);
    const imperialEl = document.getElementById(`${dim}-imperial`);

    if (isMetric) {
      metricEl.classList.remove('hidden');
      imperialEl.classList.add('hidden');
      // Remove required from imperial, add to metric
      document.getElementById(`stage-${dim}-m`).required = true;
      document.getElementById(`stage-${dim}-ft`).required = false;
      document.getElementById(`stage-${dim}-in`).required = false;
    } else {
      metricEl.classList.add('hidden');
      imperialEl.classList.remove('hidden');
      // Remove required from metric, add to imperial ft
      document.getElementById(`stage-${dim}-m`).required = false;
      document.getElementById(`stage-${dim}-ft`).required = true;
      document.getElementById(`stage-${dim}-in`).required = false;
    }
  }
}


// ============================================================================
// FORM SUBMISSION & CALCULATION
// ============================================================================

/** Handle form submission */
function handleCalculate(e) {
  e.preventDefault();

  const unit = getCurrentUnit();
  let length, width, height;

  if (unit === 'm') {
    length = parseFloat(document.getElementById('stage-length-m').value);
    width = parseFloat(document.getElementById('stage-width-m').value);
    height = parseFloat(document.getElementById('stage-height-m').value);
  } else {
    // Combine ft + in into decimal feet for the engine
    const lFt = parseFloat(document.getElementById('stage-length-ft').value) || 0;
    const lIn = parseFloat(document.getElementById('stage-length-in').value) || 0;
    length = lFt + (lIn / 12);

    const wFt = parseFloat(document.getElementById('stage-width-ft').value) || 0;
    const wIn = parseFloat(document.getElementById('stage-width-in').value) || 0;
    width = wFt + (wIn / 12);

    const hFt = parseFloat(document.getElementById('stage-height-ft').value) || 0;
    const hIn = parseFloat(document.getElementById('stage-height-in').value) || 0;
    height = hFt + (hIn / 12);
  }

  const combinerMode = document.getElementById('combiner-mode').value;

  // Validate
  if (isNaN(length) || isNaN(width) || isNaN(height) || length <= 0 || width <= 0 || height <= 0) {
    showError('Please enter valid positive numbers for all dimensions.');
    return;
  }

  // Run calculation
  currentResult = calculate({ length, width, height, unit, combinerMode });

  // Render results
  if (currentResult.success) {
    renderResults(currentResult);
  } else {
    renderError(currentResult);
  }
}

/** Show an error message */
function showError(msg) {
  const resultsEl = document.getElementById('results');
  resultsEl.classList.remove('hidden');
  resultsEl.innerHTML = `<div class="error-banner">${msg}</div>`;
}

/** Render calculation error with suggestions */
function renderError(result) {
  const resultsEl = document.getElementById('results');
  resultsEl.classList.remove('hidden');

  let html = `<div class="error-banner">
    <strong>Can't build these exact dimensions.</strong>
    <p>${result.error}</p>
  </div>`;

  if (result.suggestions) {
    html += `<div class="suggestions-card">
      <h3>Nearest achievable lengths:</h3>
      <div class="suggestion-chips">
        ${result.suggestions.lengths.map(l =>
          `<button class="chip" onclick="applySuggestion('length', ${l.inches})">${l.display}</button>`
        ).join('')}
      </div>
      <h3>Nearest achievable widths:</h3>
      <div class="suggestion-chips">
        ${result.suggestions.widths.map(w =>
          `<button class="chip" onclick="applySuggestion('width', ${w.inches})">${w.display}</button>`
        ).join('')}
      </div>
    </div>`;
  }

  resultsEl.innerHTML = html;
}

/** Apply a suggested dimension (from error chips or alternative chips) */
function applySuggestion(dim, inches) {
  writeDimensionFromInches(dim, inches, getCurrentUnit());
  handleCalculate(new Event('submit'));
}

/** Apply a suggested height and recalculate */
function applyHeightSuggestion(heightInches) {
  writeDimensionFromInches('height', heightInches, getCurrentUnit());
  handleCalculate(new Event('submit'));
}

/** Apply both length and width suggestions at once, then recalculate */
function applyDimensionSuggestion(lengthInches, widthInches) {
  writeDimensionFromInches('length', lengthInches, getCurrentUnit());
  writeDimensionFromInches('width', widthInches, getCurrentUnit());
  handleCalculate(new Event('submit'));
}


// ============================================================================
// RENDER RESULTS
// ============================================================================

/** Render full results */
function renderResults(result) {
  const resultsEl = document.getElementById('results');
  resultsEl.classList.remove('hidden');
  const unit = result.input.unit;

  let html = '';

  // ----- DIMENSION SUMMARY -----
  html += `<div class="result-card summary-card">
    <h2>Stage Configuration</h2>
    <div class="dim-grid">
      <div class="dim-item">
        <span class="dim-label">Length</span>
        <span class="dim-value">${formatDimensionForUnit(result.result.actualLength.inches, unit)}</span>
        <span class="dim-secondary">${formatDimensionForUnit(result.result.actualLength.inches, unit === 'm' ? 'ft' : 'm')}</span>
        ${!result.result.dimensionMatch && result.result.actualLength.inches !== result.input.requested.length.inches
          ? `<span class="dim-adjusted">Adjusted from ${result.input.requested.length.display}</span>` : ''}
      </div>
      <div class="dim-item">
        <span class="dim-label">Width</span>
        <span class="dim-value">${formatDimensionForUnit(result.result.actualWidth.inches, unit)}</span>
        <span class="dim-secondary">${formatDimensionForUnit(result.result.actualWidth.inches, unit === 'm' ? 'ft' : 'm')}</span>
        ${!result.result.dimensionMatch && result.result.actualWidth.inches !== result.input.requested.width.inches
          ? `<span class="dim-adjusted">Adjusted from ${result.input.requested.width.display}</span>` : ''}
      </div>
      <div class="dim-item">
        <span class="dim-label">Height</span>
        <span class="dim-value">${formatDimensionForUnit(result.result.actualHeight.inches, unit)}</span>
        <span class="dim-secondary">${formatDimensionForUnit(result.result.actualHeight.inches, unit === 'm' ? 'ft' : 'm')}</span>
        ${result.result.nearestLegHeight
          ? `<span class="dim-adjusted">Snapped from ${result.input.requested.height.display} (nearest standard leg)</span>` : ''}
      </div>
      <div class="dim-item">
        <span class="dim-label">Area</span>
        <span class="dim-value">${unit === 'm'
          ? `${result.summary.area.sqM.toFixed(1)} sq m`
          : `${result.summary.area.sqFt.toFixed(1)} sq ft`}</span>
        <span class="dim-secondary">${unit === 'm'
          ? `${result.summary.area.sqFt.toFixed(1)} sq ft`
          : `${result.summary.area.sqM.toFixed(1)} sq m`}</span>
      </div>
    </div>
  </div>`;

  // ----- DECK LAYOUT VISUAL -----
  html += `<div class="result-card">
    <h2>Deck Layout <span class="badge">${result.summary.totalDecks} decks</span></h2>
    <div class="layout-visual-container">
      ${renderLayoutVisual(result.layout, result.result.actualLength.inches, result.result.actualWidth.inches, unit)}
    </div>`;

  // Stock-constrained alternative deck layout (if any)
  if (result.stockAlternativeParts) {
    const altDims = result.stockAlternativeLayout._altDimensions;
    const altLabel = altDims
      ? `${formatDimensionForUnit(altDims.lengthIn, unit)} × ${formatDimensionForUnit(altDims.widthIn, unit)}`
      : 'same dimensions';

    html += `<div class="alt-section">
      <h3>🟢 In-stock alternative (${altLabel}, ${result.stockAlternativeLayout.length} decks)</h3>
      <div class="alt-deck-card">
        <h4>Uses only decks you currently own:</h4>
        <ul class="alt-deck-list">
          ${result.stockAlternativeParts.map(p =>
            `<li>${p.qtyNeeded}× ${p.name} (${p.qtyOwned} in stock${p.shortfall > 0 ? `, still short ${p.shortfall}` : ''})</li>`
          ).join('')}
        </ul>
        ${altDims ? `<div style="margin-top:10px">
          <button class="chip" onclick="applyDimensionSuggestion(${altDims.lengthIn}, ${altDims.widthIn})">
            Recalculate at ${altLabel}
          </button>
        </div>` : ''}
      </div>
    </div>`;
  }

  html += `</div>`;

  // ----- JUNCTION SUMMARY -----
  html += `<div class="result-card">
    <h2>Junction Points <span class="badge">${result.junctions.total} total</span></h2>
    <div class="junction-summary">
      <div class="junction-type">
        <span class="junction-dot solo"></span>
        <span>${result.junctions.solo} solo corners</span>
        <span class="junction-desc">1 deck → 1 standard leg</span>
      </div>
      <div class="junction-type">
        <span class="junction-dot edge"></span>
        <span>${result.junctions.edge} edge junctions</span>
        <span class="junction-desc">2 decks meet${result.input.combinerMode !== 'none' ? ' → 2-in-1 combiner' : ' → 2 separate legs'}</span>
      </div>
      <div class="junction-type">
        <span class="junction-dot interior"></span>
        <span>${result.junctions.interior} interior junctions</span>
        <span class="junction-desc">4 decks meet${result.input.combinerMode !== 'none' ? ' → 4-in-1 combiner' : ' → 4 separate legs'}</span>
      </div>
    </div>
  </div>`;

  // ----- PARTS LIST -----
  html += `<div class="result-card">
    <h2>Parts List</h2>
    <table class="parts-table">
      <thead>
        <tr>
          <th>Item</th>
          <th>Needed</th>
          <th>In Stock</th>
          <th>Status</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>`;

  let currentCategory = '';
  for (const part of result.partsList) {
    if (part.category !== currentCategory) {
      currentCategory = part.category;
      html += `<tr class="category-row"><td colspan="5">${currentCategory}</td></tr>`;
    }

    const statusClass = part.shortfall > 0 ? 'status-short' :
      part.qtyNeeded <= part.qtyOwned * 0.8 ? 'status-ok' : 'status-tight';
    const statusText = part.shortfall > 0 ? `Short ${part.shortfall}` :
      part.qtyNeeded === part.qtyOwned ? 'Exact' : 'OK';
    const statusIcon = part.shortfall > 0 ? '🔴' : part.qtyNeeded >= part.qtyOwned ? '🟡' : '🟢';

    html += `<tr>
      <td>${part.name}</td>
      <td class="num">${part.qtyNeeded}</td>
      <td class="num">${part.qtyOwned}</td>
      <td class="${statusClass}">${statusIcon} ${statusText}</td>
      <td class="note">${part.note}</td>
    </tr>`;
  }

  html += `</tbody></table>`;

  // ----- ALTERNATIVE HEIGHT SUGGESTIONS (inside parts card) -----
  if (result.heightAlternatives && result.heightAlternatives.length > 0) {
    html += `<div class="alt-section">
      <h3>📏 Nearest standard heights from stock</h3>
      <p style="font-size:13px; color:#6b7280; margin-bottom:10px">
        ${result.legMatch.screwjackNeeded.length > 0
          ? 'The required leg height isn\'t standard. Here are the closest achievable stage heights using legs you own:'
          : 'Your requested height was adjusted to the nearest standard leg. Other standard heights available:'}
      </p>
      <div class="alt-height-options">
        ${result.heightAlternatives.map(alt => {
          const label = formatDimensionForUnit(alt.stageHeightIn, unit);
          const secondary = formatDimensionForUnit(alt.stageHeightIn, unit === 'm' ? 'ft' : 'm');
          const arrow = alt.direction === 'lower' ? '↓' : '↑';
          const legInfo = alt.combinerLeg
            ? `${alt.legName} + combiner`
            : alt.legName;
          return `<button class="alt-height-chip" onclick="applyHeightSuggestion(${alt.stageHeightIn})">
            <span class="alt-chip-label">${arrow} ${label}</span>
            <span class="alt-chip-desc">${secondary} — ${legInfo}${alt.legColour ? ` (${alt.legColour})` : ''}</span>
          </button>`;
        }).join('')}
      </div>
    </div>`;
  }

  html += `</div>`;

  // ----- WARNINGS -----
  if (result.summary.warnings.length > 0) {
    html += `<div class="result-card warnings-card">
      <h2>⚠️ Warnings</h2>
      <ul>${result.summary.warnings.map(w => `<li>${w}</li>`).join('')}</ul>
    </div>`;
  }

  resultsEl.innerHTML = html;
}


// ============================================================================
// 2D LAYOUT VISUAL (SVG)
// Now unit-aware — labels display in the selected unit
// ============================================================================

function renderLayoutVisual(layout, totalLength, totalWidth, unit) {
  const maxViewWidth = 600;
  const maxViewHeight = 300;
  const padding = 30;

  // Scale to fit
  const scaleX = (maxViewWidth - padding * 2) / totalLength;
  const scaleY = (maxViewHeight - padding * 2) / totalWidth;
  const scale = Math.min(scaleX, scaleY);

  const svgWidth = totalLength * scale + padding * 2;
  const svgHeight = totalWidth * scale + padding * 2;

  // Colours for different deck sizes
  const deckColours = {
    96: { fill: '#dbeafe', stroke: '#3b82f6' }, // 8ft - blue
    72: { fill: '#dcfce7', stroke: '#22c55e' }, // 6ft - green
    48: { fill: '#fef3c7', stroke: '#f59e0b' }, // 4ft - amber
    24: { fill: '#fce7f3', stroke: '#ec4899' }, // 2ft - pink
  };

  let svgContent = '';

  // Draw decks
  for (const placed of layout) {
    const x = placed.x * scale + padding;
    const y = placed.y * scale + padding;
    const w = placed.orientedLength * scale;
    const h = placed.orientedWidth * scale;

    const colour = deckColours[placed.deck.lengthIn] || { fill: '#f3f4f6', stroke: '#6b7280' };

    svgContent += `<rect x="${x}" y="${y}" width="${w}" height="${h}" 
      fill="${colour.fill}" stroke="${colour.stroke}" stroke-width="2" rx="3" />`;

    // Label (only if big enough)
    if (w > 40 && h > 20) {
      const labelSize = Math.min(12, w / 6, h / 3);
      svgContent += `<text x="${x + w / 2}" y="${y + h / 2}" 
        text-anchor="middle" dominant-baseline="middle" 
        font-size="${labelSize}" fill="${colour.stroke}" font-weight="600"
        font-family="Inter, sans-serif">
        ${placed.deck.lengthIn / 12}'×${placed.deck.widthIn / 12}'
      </text>`;
    }
  }

  // Dimension labels — now unit-aware
  const totalLengthLabel = formatDimensionForUnit(totalLength, unit);
  const totalWidthLabel = formatDimensionForUnit(totalWidth, unit);

  // Top dimension line
  svgContent += `<text x="${svgWidth / 2}" y="${padding - 10}" 
    text-anchor="middle" font-size="13" fill="#374151" font-weight="600"
    font-family="Inter, sans-serif">← ${totalLengthLabel} →</text>`;

  // Left dimension line
  svgContent += `<text x="${padding - 10}" y="${svgHeight / 2}" 
    text-anchor="middle" font-size="13" fill="#374151" font-weight="600"
    font-family="Inter, sans-serif"
    transform="rotate(-90, ${padding - 10}, ${svgHeight / 2})">← ${totalWidthLabel} →</text>`;

  return `<svg viewBox="0 0 ${svgWidth} ${svgHeight}" width="100%" 
    style="max-width:${svgWidth}px" xmlns="http://www.w3.org/2000/svg">
    ${svgContent}
  </svg>`;
}