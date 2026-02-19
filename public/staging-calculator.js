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
 * v1.0 - Initial implementation
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
  const ft = Math.floor(inches / 12);
  const remainIn = Math.round(inches % 12);
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


// ============================================================================
// TILING ALGORITHM
// Tiles a rectangular area with available deck sizes.
// Strategy: greedy fill — largest decks first, row by row.
// ============================================================================

/**
 * Tile a rectangular area (lengthIn x widthIn) with available deck sizes.
 * Returns an array of placed decks with positions, or null if impossible.
 * 
 * Each placed deck: { deck, x, y, orientedLength, orientedWidth }
 * where x,y are the top-left corner in inches from origin.
 */
function tileRectangle(targetLengthIn, targetWidthIn) {
  // Get available deck sizes (those with qty > 0 or that exist for sub-hire)
  // We include all sizes for calculation — stock check happens after.
  const availableDecks = STOCK.decks.filter(d => d.lengthIn > 0);

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
 */
function findNearestAchievable(targetIn) {
  // All possible single-dimension lengths we can build from deck pieces
  const deckLengths = [...new Set(
    STOCK.decks.flatMap(d => [d.lengthIn, d.widthIn])
  )].filter(l => l > 0).sort((a, b) => a - b);

  // Generate all achievable lengths up to ~2x target (within reason)
  const maxLen = Math.max(targetIn * 1.5, 240); // At least 20ft
  const achievable = new Set();

  // Brute force: try combinations of deck lengths that sum up
  function buildLengths(remaining, maxPiece) {
    if (remaining === 0) return;
    for (const len of deckLengths) {
      if (len > remaining) continue;
      achievable.add(maxPiece !== undefined ? maxPiece - remaining + len : len);
      // Keep going if we haven't exceeded max
      if (remaining - len >= Math.min(...deckLengths)) {
        // Add the total so far
        const total = (maxPiece || 0) + len;
        if (total <= maxLen) {
          achievable.add(total);
        }
      }
    }
  }

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
 * @param {number} params.length - Desired length
 * @param {number} params.width - Desired width
 * @param {number} params.height - Desired finished height
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

  // Find nearest achievable dimensions
  const achievableLengths = findNearestAchievable(targetLengthIn);
  const achievableWidths = findNearestAchievable(targetWidthIn);

  // Try exact first, then nearest
  let bestLength = achievableLengths[0];
  let bestWidth = achievableWidths[0];

  // Check if exact match exists
  const exactLength = achievableLengths.find(l => l === targetLengthIn);
  const exactWidth = achievableWidths.find(w => w === targetWidthIn);
  if (exactLength) bestLength = exactLength;
  if (exactWidth) bestWidth = exactWidth;

  // Tile the rectangle
  const layout = tileRectangle(bestLength, bestWidth);

  if (!layout) {
    return {
      success: false,
      error: 'Could not tile these dimensions with available deck sizes.',
      suggestions: {
        lengths: achievableLengths.slice(0, 5).map(l => ({ inches: l, display: formatDimension(l) })),
        widths: achievableWidths.slice(0, 5).map(w => ({ inches: w, display: formatDimension(w) })),
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

  return {
    success: true,
    input: {
      requested: {
        length: { value: length, unit, inches: targetLengthIn, display: formatDimension(targetLengthIn) },
        width: { value: width, unit, inches: targetWidthIn, display: formatDimension(targetWidthIn) },
        height: { value: height, unit, inches: targetHeightIn, display: formatDimension(targetHeightIn) },
      },
      combinerMode,
    },
    result: {
      actualLength: { inches: bestLength, display: formatDimension(bestLength) },
      actualWidth: { inches: bestWidth, display: formatDimension(bestWidth) },
      actualHeight: { inches: effectiveHeight, display: formatDimension(effectiveHeight) },
      dimensionMatch,
      heightMatch: standardHeightMatch,
      nearestLegHeight: !standardHeightMatch ? { inches: nearestLegHeight, display: formatDimension(nearestLegHeight) } : null,
    },
    layout,
    junctions: {
      total: totalJunctions,
      solo: junctions.filter(j => j.type === 'solo').length,
      edge: junctions.filter(j => j.type === 'edge').length,
      interior: junctions.filter(j => j.type === 'interior').length,
    },
    hardware,
    legMatch,
    partsList,
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
  document.getElementById('unit-toggle').addEventListener('change', handleUnitToggle);

  // Set default values
  document.getElementById('stage-length').value = '6';
  document.getElementById('stage-width').value = '4';
  document.getElementById('stage-height').value = '0.6';
  document.getElementById('unit-toggle').value = 'm';
  updatePlaceholders();
});

/** Handle unit toggle — update placeholders */
function handleUnitToggle() {
  updatePlaceholders();
}

function updatePlaceholders() {
  const unit = document.getElementById('unit-toggle').value;
  const suffix = unit === 'm' ? 'm' : 'ft';
  document.getElementById('stage-length').placeholder = `Length (${suffix})`;
  document.getElementById('stage-width').placeholder = `Width (${suffix})`;
  document.getElementById('stage-height').placeholder = `Height (${suffix})`;

  // Update labels
  document.getElementById('length-label').textContent = `Length (${suffix})`;
  document.getElementById('width-label').textContent = `Width (${suffix})`;
  document.getElementById('height-label').textContent = `Height (${suffix})`;
}

/** Handle form submission */
function handleCalculate(e) {
  e.preventDefault();

  const length = parseFloat(document.getElementById('stage-length').value);
  const width = parseFloat(document.getElementById('stage-width').value);
  const height = parseFloat(document.getElementById('stage-height').value);
  const unit = document.getElementById('unit-toggle').value;
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

/** Apply a suggested dimension */
function applySuggestion(dim, inches) {
  const unit = document.getElementById('unit-toggle').value;
  const value = unit === 'm' ? (inches * 0.0254).toFixed(2) : (inches / 12).toFixed(1);
  document.getElementById(dim === 'length' ? 'stage-length' : 'stage-width').value = value;
  handleCalculate(new Event('submit'));
}

/** Render full results */
function renderResults(result) {
  const resultsEl = document.getElementById('results');
  resultsEl.classList.remove('hidden');

  let html = '';

  // ----- DIMENSION SUMMARY -----
  html += `<div class="result-card summary-card">
    <h2>Stage Configuration</h2>
    <div class="dim-grid">
      <div class="dim-item">
        <span class="dim-label">Length</span>
        <span class="dim-value">${result.result.actualLength.display}</span>
        ${!result.result.dimensionMatch && result.result.actualLength.inches !== result.input.requested.length.inches
          ? `<span class="dim-adjusted">Adjusted from ${result.input.requested.length.display}</span>` : ''}
      </div>
      <div class="dim-item">
        <span class="dim-label">Width</span>
        <span class="dim-value">${result.result.actualWidth.display}</span>
        ${!result.result.dimensionMatch && result.result.actualWidth.inches !== result.input.requested.width.inches
          ? `<span class="dim-adjusted">Adjusted from ${result.input.requested.width.display}</span>` : ''}
      </div>
      <div class="dim-item">
        <span class="dim-label">Height</span>
        <span class="dim-value">${result.result.actualHeight.display}</span>
        ${result.result.nearestLegHeight
          ? `<span class="dim-adjusted">Snapped from ${result.input.requested.height.display} (nearest standard leg)</span>` : ''}
      </div>
      <div class="dim-item">
        <span class="dim-label">Area</span>
        <span class="dim-value">${result.summary.area.sqFt.toFixed(1)} sq ft / ${result.summary.area.sqM.toFixed(1)} sq m</span>
      </div>
    </div>
  </div>`;

  // ----- DECK LAYOUT VISUAL -----
  html += `<div class="result-card">
    <h2>Deck Layout <span class="badge">${result.summary.totalDecks} decks</span></h2>
    <div class="layout-visual-container">
      ${renderLayoutVisual(result.layout, result.result.actualLength.inches, result.result.actualWidth.inches)}
    </div>
  </div>`;

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

  html += `</tbody></table></div>`;

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
// ============================================================================

function renderLayoutVisual(layout, totalLength, totalWidth) {
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

  // Dimension labels
  const totalLengthFt = inchesToFeetStr(totalLength);
  const totalWidthFt = inchesToFeetStr(totalWidth);

  // Top dimension line
  svgContent += `<text x="${svgWidth / 2}" y="${padding - 10}" 
    text-anchor="middle" font-size="13" fill="#374151" font-weight="600"
    font-family="Inter, sans-serif">← ${totalLengthFt} →</text>`;

  // Left dimension line
  svgContent += `<text x="${padding - 10}" y="${svgHeight / 2}" 
    text-anchor="middle" font-size="13" fill="#374151" font-weight="600"
    font-family="Inter, sans-serif"
    transform="rotate(-90, ${padding - 10}, ${svgHeight / 2})">← ${totalWidthFt} →</text>`;

  return `<svg viewBox="0 0 ${svgWidth} ${svgHeight}" width="100%" 
    style="max-width:${svgWidth}px" xmlns="http://www.w3.org/2000/svg">
    ${svgContent}
  </svg>`;
}