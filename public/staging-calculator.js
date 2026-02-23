/**
 * OOOSH Staging Calculator
 * 
 * Calculates staging/deck requirements from desired dimensions.
 * Handles unit conversion, deck tiling, leg/combiner assignment,
 * and parts list generation.
 * 
 * v2.0 - Live HireHop stock (no hardcoded data), orientation
 *         optimization, unit toggle pill, ft/in split fields
 */

// ============================================================================
// STOCK — populated from HireHop API on page load (no hardcoded data)
// ============================================================================

let STOCK = null;          // Set by fetchStock()
let LEG_HEIGHTS = [];      // Rebuilt after stock loads
let AVAILABILITY = null;   // Set by fetchAvailability() — date-specific availability data

// Combiner height offset in inches (physical constant — the combiner plate is 6" tall)
const COMBINER_HEIGHT_OFFSET = 6;


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
 */
function tileRectangle(targetLengthIn, targetWidthIn, inStockOnly) {
  // Get available deck sizes
  const availableDecks = inStockOnly
    ? STOCK.decks.filter(d => d.lengthIn > 0 && d.qty > 0)
    : STOCK.decks.filter(d => d.lengthIn > 0);

  if (availableDecks.length === 0) return null;

  // Generate all possible orientations (each deck can be rotated 90°)
  const orientations = [];
  for (const deck of availableDecks) {
    orientations.push({ deck, l: deck.lengthIn, w: deck.widthIn });
    if (deck.lengthIn !== deck.widthIn) {
      orientations.push({ deck, l: deck.widthIn, w: deck.lengthIn });
    }
  }

  // Get unique row depths we can use, sorted largest first
  const possibleRowDepths = [...new Set(orientations.map(o => o.w))].sort((a, b) => b - a);

  // Try to fill the width with rows of these depths
  const rowCombos = findRowCombinations(targetWidthIn, possibleRowDepths);
  if (rowCombos.length === 0) return null;

  // Try each row combination and pick the one using fewest total decks
  let bestLayout = null;
  let bestDeckCount = Infinity;

  for (const rowDepths of rowCombos) {
    const layout = [];
    let currentY = 0;
    let valid = true;

    for (const rowDepth of rowDepths) {
      const fittingOrientations = orientations.filter(o => o.w === rowDepth);
      const rowDecks = fillRow(targetLengthIn, fittingOrientations);

      if (!rowDecks) {
        valid = false;
        break;
      }

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
      if (d < minDepth) continue;
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
 */
function fillRow(targetLength, orientations) {
  const sorted = [...orientations].sort((a, b) => b.l - a.l);
  const result = [];
  let remaining = targetLength;

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
// ============================================================================

/**
 * Given a target dimension in inches, find the nearest achievable dimension
 * that can be built from our deck sizes. Returns sorted by proximity.
 */
function findNearestAchievable(targetIn, inStockOnly) {
  const decksToUse = inStockOnly
    ? STOCK.decks.filter(d => d.qty > 0)
    : STOCK.decks;

  const deckLengths = [...new Set(
    decksToUse.flatMap(d => [d.lengthIn, d.widthIn])
  )].filter(l => l > 0).sort((a, b) => a - b);

  if (deckLengths.length === 0) return [];

  const maxLen = Math.max(targetIn * 1.5, 240);
  const achievable = new Set();

  for (const l of deckLengths) {
    achievable.add(l);
  }

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

  return [...achievable].sort((a, b) =>
    Math.abs(a - targetIn) - Math.abs(b - targetIn)
  );
}


// ============================================================================
// JUNCTION MAPPING
// ============================================================================

/**
 * Map all junction points from a deck layout.
 * Returns array of { x, y, deckCount, type }
 */
function mapJunctions(layout) {
  const cornerMap = new Map();

  for (const placed of layout) {
    const corners = [
      [placed.x, placed.y],
      [placed.x + placed.orientedLength, placed.y],
      [placed.x, placed.y + placed.orientedWidth],
      [placed.x + placed.orientedLength, placed.y + placed.orientedWidth],
    ];

    for (const [cx, cy] of corners) {
      const key = `${cx},${cy}`;
      cornerMap.set(key, (cornerMap.get(key) || 0) + 1);
    }
  }

  const junctions = [];
  for (const [key, count] of cornerMap) {
    const [x, y] = key.split(',').map(Number);
    let type;
    if (count === 1) type = 'solo';
    else if (count === 2) type = 'edge';
    else type = 'interior';
    junctions.push({ x, y, deckCount: count, type });
  }

  return junctions;
}


// ============================================================================
// LEG & COMBINER ASSIGNMENT
// ============================================================================

/**
 * Assign legs and combiners to junctions.
 */
function assignHardware(junctions, finishedHeightIn, combinerMode) {
  const assignments = [];
  const legNeeds = {};
  const combinerNeeds = { twoInOne: 0, fourInOne: 0 };
  const warnings = [];

  const combinerLegHeight = finishedHeightIn - COMBINER_HEIGHT_OFFSET;

  for (const junc of junctions) {
    const assignment = { ...junc, hardware: [] };

    let useCombiner = false;
    let combinerType = null;

    if (combinerMode === 'all' && junc.type !== 'solo') {
      useCombiner = true;
      combinerType = junc.type === 'interior' ? 'fourInOne' : 'twoInOne';
    } else if (combinerMode === 'interior-only' && junc.type === 'interior') {
      useCombiner = true;
      combinerType = 'fourInOne';
    }

    if (useCombiner) {
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
// ============================================================================

/**
 * Match required leg heights to available stock.
 */
function matchLegs(legNeeds) {
  const matched = [];
  const screwjackNeeded = [];
  const unavailable = [];

  for (const [heightStr, qty] of Object.entries(legNeeds)) {
    const heightIn = parseFloat(heightStr);
    const exactLeg = STOCK.legs.find(l => l.heightIn === heightIn);

    if (exactLeg) {
      matched.push({
        leg: exactLeg,
        qtyNeeded: qty,
        shortfall: Math.max(0, qty - exactLeg.qty),
      });
    } else {
      screwjackNeeded.push({ heightIn, qty });
    }
  }

  return { matched, screwjackNeeded, unavailable };
}


// ============================================================================
// NEAREST STOCK HEIGHT SUGGESTIONS
// ============================================================================

/**
 * Find alternative standard stage heights that would use in-stock legs.
 */
function findAlternativeHeights(requestedHeightIn, combinerMode, junctions) {
  const alternatives = [];
  const hasCombinerJunctions = junctions.some(j => j.type !== 'solo');

  for (const leg of STOCK.legs) {
    if (leg.qty === 0) continue;

    const directStageHeight = leg.heightIn;
    const combinerStageHeight = leg.heightIn + COMBINER_HEIGHT_OFFSET;

    if (combinerMode === 'none') {
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
      if (combinerStageHeight !== requestedHeightIn) {
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

  alternatives.sort((a, b) => a.delta - b.delta);

  const seen = new Set();
  const unique = [];
  for (const alt of alternatives) {
    if (!seen.has(alt.stageHeightIn)) {
      seen.add(alt.stageHeightIn);
      unique.push(alt);
    }
  }

  const lower = unique.filter(a => a.direction === 'lower').slice(0, 2);
  const higher = unique.filter(a => a.direction === 'higher').slice(0, 2);
  return [...lower, ...higher].sort((a, b) => a.stageHeightIn - b.stageHeightIn);
}


// ============================================================================
// COMPILE PARTS LIST
// ============================================================================

function compilePartsList(layout, hardware, legMatch) {
  const parts = [];

  // Decks
  const deckCounts = {};
  for (const placed of layout) {
    deckCounts[placed.deck.name] = (deckCounts[placed.deck.name] || 0) + 1;
  }
  for (const deck of STOCK.decks) {
    const needed = deckCounts[deck.name] || 0;
    if (needed > 0) {
      parts.push({
        category: 'Decks', name: deck.name,
        qtyNeeded: needed, qtyOwned: deck.qty,
        shortfall: Math.max(0, needed - deck.qty), note: '',
        hirehopId: deck.hirehopId || null,
      });
    }
  }

  // Combiners
  if (hardware.combinerNeeds.fourInOne > 0) {
    const c = STOCK.combiners.fourInOne;
    parts.push({
      category: 'Combiners', name: c.name,
      qtyNeeded: hardware.combinerNeeds.fourInOne, qtyOwned: c.qty,
      shortfall: Math.max(0, hardware.combinerNeeds.fourInOne - c.qty), note: '',
      hirehopId: c.hirehopId || null,
    });
  }
  if (hardware.combinerNeeds.twoInOne > 0) {
    const c = STOCK.combiners.twoInOne;
    parts.push({
      category: 'Combiners', name: c.name,
      qtyNeeded: hardware.combinerNeeds.twoInOne, qtyOwned: c.qty,
      shortfall: Math.max(0, hardware.combinerNeeds.twoInOne - c.qty), note: '',
      hirehopId: c.hirehopId || null,
    });
  }

  // Legs
  for (const m of legMatch.matched) {
    parts.push({
      category: 'Legs', name: m.leg.name,
      qtyNeeded: m.qtyNeeded, qtyOwned: m.leg.qty,
      shortfall: m.shortfall, note: m.leg.colour || '',
      hirehopId: m.leg.hirehopId || null,
    });
  }

  // Screwjack flags
  for (const sj of legMatch.screwjackNeeded) {
    parts.push({
      category: 'Legs', name: `${sj.heightIn}" leg (non-standard)`,
      qtyNeeded: sj.qty, qtyOwned: 0, shortfall: sj.qty,
      note: '⚠️ No standard leg — screwjack or sub-hire needed',
    });
  }

  return parts;
}


// ============================================================================
// MAIN CALCULATION ENTRY POINT
// ============================================================================

/**
 * Run the full staging calculation for a single orientation.
 */
function calculate(params) {
  const { length, width, height, unit, combinerMode, inStockOnly } = params;

  const toInches = unit === 'm' ? metersToInches : feetToInches;
  const targetLengthIn = toInches(length);
  const targetWidthIn = toInches(width);
  const targetHeightIn = toInches(height);

  const achievableLengths = findNearestAchievable(targetLengthIn, false);
  const achievableWidths = findNearestAchievable(targetWidthIn, false);

  let bestLength = achievableLengths[0];
  let bestWidth = achievableWidths[0];

  const exactLength = achievableLengths.find(l => l === targetLengthIn);
  const exactWidth = achievableWidths.find(w => w === targetWidthIn);
  if (exactLength) bestLength = exactLength;
  if (exactWidth) bestWidth = exactWidth;

  const layout = tileRectangle(bestLength, bestWidth, inStockOnly || false);

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

  const standardHeightMatch = LEG_HEIGHTS.includes(targetHeightIn);
  const nearestLegHeight = LEG_HEIGHTS.reduce((best, h) =>
    Math.abs(h - targetHeightIn) < Math.abs(best - targetHeightIn) ? h : best
  , LEG_HEIGHTS[0]);
  const effectiveHeight = standardHeightMatch ? targetHeightIn : nearestLegHeight;

  const junctions = mapJunctions(layout);
  const hardware = assignHardware(junctions, effectiveHeight, combinerMode);
  const legMatch = matchLegs(hardware.legNeeds);
  const partsList = compilePartsList(layout, hardware, legMatch);

  const totalDecks = layout.length;
  const hasShortfall = partsList.some(p => p.shortfall > 0);
  const dimensionMatch = (bestLength === targetLengthIn && bestWidth === targetWidthIn);

  // Height alternatives
  const hasNonStandardLegs = legMatch.screwjackNeeded.length > 0;
  const heightWasSnapped = !standardHeightMatch;
  let heightAlternatives = [];
  if (hasNonStandardLegs || heightWasSnapped) {
    heightAlternatives = findAlternativeHeights(effectiveHeight, combinerMode, junctions);
    heightAlternatives = heightAlternatives.filter(a => a.stageHeightIn !== effectiveHeight);
  }

  // Stock-constrained deck alternative (skip if already in stock-only mode)
  const hasDeckShortfall = partsList.some(p => p.category === 'Decks' && p.shortfall > 0);
  let stockAlternativeLayout = null;
  let stockAlternativeParts = null;

  if (hasDeckShortfall && !inStockOnly) {
    const altLayout = tileRectangle(bestLength, bestWidth, true);
    if (altLayout) {
      const altDeckCounts = {};
      for (const placed of altLayout) {
        altDeckCounts[placed.deck.name] = (altDeckCounts[placed.deck.name] || 0) + 1;
      }
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
              name: deck.name, qtyNeeded: needed, qtyOwned: deck.qty,
              shortfall: Math.max(0, needed - deck.qty), noShortfall: needed <= deck.qty,
            });
          }
        }
      }
    }

    // Try nearby dimensions with stock-only tiling
    if (!stockAlternativeLayout) {
      const stockLengths = findNearestAchievable(targetLengthIn, true);
      const stockWidths = findNearestAchievable(targetWidthIn, true);

      for (let li = 0; li < Math.min(3, stockLengths.length); li++) {
        for (let wi = 0; wi < Math.min(3, stockWidths.length); wi++) {
          const tryL = stockLengths[li];
          const tryW = stockWidths[wi];
          if (tryL === bestLength && tryW === bestWidth) continue;
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
                    name: deck.name, qtyNeeded: needed, qtyOwned: deck.qty,
                    shortfall: 0, noShortfall: true,
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

  // Total parts count (for orientation comparison)
  const totalParts = partsList.reduce((sum, p) => sum + p.qtyNeeded, 0);
  const totalShortfall = partsList.reduce((sum, p) => sum + p.shortfall, 0);

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
      total: junctions.length,
      solo: junctions.filter(j => j.type === 'solo').length,
      edge: junctions.filter(j => j.type === 'edge').length,
      interior: junctions.filter(j => j.type === 'interior').length,
      all: junctions,
    },
    hardware,
    legMatch,
    partsList,
    heightAlternatives,
    stockAlternativeLayout,
    stockAlternativeParts,
    summary: {
      totalDecks,
      totalParts,
      totalShortfall,
      hasShortfall,
      inStockOnly: inStockOnly || false,
      warnings: hardware.warnings,
      area: {
        sqFt: (bestLength * bestWidth) / 144,
        sqM: (bestLength * bestWidth) / 1550.0031,
      },
    },
  };
}


// ============================================================================
// ORIENTATION OPTIMISATION
// Try both L×W and W×L, pick the one with fewer total parts / less shortfall
// ============================================================================

/**
 * Run calculation in both orientations and return the better one.
 * "Better" = fewer shortfalls first, then fewer total parts.
 */
function calculateBestOrientation(params) {
  const { length, width, height, unit, combinerMode, inStockOnly } = params;

  // Orientation A: as entered
  const resultA = calculate({ length, width, height, unit, combinerMode, inStockOnly });

  // Orientation B: length and width swapped
  const resultB = calculate({ length: width, width: length, height, unit, combinerMode, inStockOnly });

  // If one fails and the other succeeds, use the successful one
  if (!resultA.success && !resultB.success) return resultA;
  if (!resultA.success) return resultB;
  if (!resultB.success) return resultA;

  // Both succeeded — pick the better one
  // Priority 1: fewer total shortfalls
  // Priority 2: fewer total parts (legs, combiners, decks)
  // Priority 3: fewer decks
  const scoreA = resultA.summary.totalShortfall * 1000 + resultA.summary.totalParts;
  const scoreB = resultB.summary.totalShortfall * 1000 + resultB.summary.totalParts;

  if (scoreA <= scoreB) {
    return resultA;
  } else {
    // Mark that we swapped orientation so we can tell the user
    resultB._orientationSwapped = true;
    return resultB;
  }
}


// ============================================================================
// STOCK FETCH — loads live data from HireHop via Netlify function
// ============================================================================

/**
 * Fetch staging stock from the Netlify function.
 * Returns true on success, false on failure.
 */
async function fetchStock() {
  try {
    const response = await fetch('/.netlify/functions/staging-stock');
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Unknown error');
    }

    // Set the global STOCK object
    STOCK = data.stock;

    // Rebuild LEG_HEIGHTS from live data
    LEG_HEIGHTS = STOCK.legs.map(l => l.heightIn).sort((a, b) => a - b);

    console.log('Stock loaded from HireHop:', {
      decks: STOCK.decks.length,
      legs: STOCK.legs.length,
      combiners: `${STOCK.combiners.twoInOne.qty} × 2-in-1, ${STOCK.combiners.fourInOne.qty} × 4-in-1`,
      timestamp: data.timestamp,
    });

    return true;
  } catch (err) {
    console.error('Failed to load stock from HireHop:', err);
    return false;
  }
}


// ============================================================================
// AVAILABILITY FETCH — date-specific availability from HireHop API
// ============================================================================

/**
 * Fetch date-based availability for all staging items.
 * Calls the staging-availability Netlify function with item IDs and dates.
 * Updates the global AVAILABILITY object.
 * 
 * @param {string} startDate - ISO date string (YYYY-MM-DD)
 * @param {string} endDate - ISO date string (YYYY-MM-DD)
 * @returns {boolean} true on success
 */
async function fetchAvailability(startDate, endDate) {
  try {
    // Collect all HireHop item IDs from STOCK
    const items = [];

    for (const deck of STOCK.decks) {
      if (deck.hirehopId) items.push({ id: deck.hirehopId });
    }
    for (const leg of STOCK.legs) {
      if (leg.hirehopId) items.push({ id: leg.hirehopId });
    }
    if (STOCK.combiners.twoInOne.hirehopId) {
      items.push({ id: STOCK.combiners.twoInOne.hirehopId });
    }
    if (STOCK.combiners.fourInOne.hirehopId) {
      items.push({ id: STOCK.combiners.fourInOne.hirehopId });
    }
    for (const sj of STOCK.screwjacks) {
      if (sj.hirehopId) items.push({ id: sj.hirehopId });
    }
    for (const w of STOCK.wheels) {
      if (w.hirehopId) items.push({ id: w.hirehopId });
    }
    for (const h of STOCK.handrails) {
      if (h.hirehopId) items.push({ id: h.hirehopId });
    }
    for (const s of STOCK.steps) {
      if (s.hirehopId) items.push({ id: s.hirehopId });
    }

    if (items.length === 0) {
      console.warn('No HireHop IDs found in stock — cannot check availability');
      return false;
    }

    console.log(`Fetching availability for ${items.length} items: ${startDate} to ${endDate}`);

    const response = await fetch('/.netlify/functions/staging-availability', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items, startDate, endDate }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json();
    if (!data.success) {
      throw new Error(data.error || 'Unknown error');
    }

    // Store availability data globally
    AVAILABILITY = {
      data: data.availability,      // Map of hirehopId → { stock, available, global }
      startDate,
      endDate,
      timestamp: data.timestamp,
    };

    console.log('Availability loaded:', {
      items: Object.keys(data.availability).length,
      startDate,
      endDate,
    });

    return true;
  } catch (err) {
    console.error('Failed to fetch availability:', err);
    AVAILABILITY = null;
    return false;
  }
}

/**
 * Look up the available quantity for a specific HireHop item ID.
 * Returns null if no availability data loaded, otherwise the available count.
 */
function getAvailableQty(hirehopId) {
  if (!AVAILABILITY || !AVAILABILITY.data || !hirehopId) return null;
  const entry = AVAILABILITY.data[String(hirehopId)];
  return entry ? entry.available : null;
}

/**
 * Look up availability for a parts list entry.
 * Uses the hirehopId stored in the part to find the availability.
 */
function getAvailableQtyForPart(part) {
  if (!part.hirehopId) return null;
  return getAvailableQty(part.hirehopId);
}


// ============================================================================
// UI LOGIC
// ============================================================================

let currentResult = null;
let currentUnit = 'm';

function getCurrentUnit() {
  return currentUnit;
}

/** Initialize the page */
document.addEventListener('DOMContentLoaded', async () => {
  // Check authentication
  const sessionToken = localStorage.getItem('staffHubSession');
  const sessionExpiry = localStorage.getItem('staffHubSessionExpiry');

  if (!sessionToken || !sessionExpiry || new Date(sessionExpiry) <= new Date()) {
    window.location.href = '/';
    return;
  }

  // Show loading state while fetching stock
  showLoading();

  // Fetch live stock from HireHop
  const stockLoaded = await fetchStock();

  if (!stockLoaded) {
    showStockError();
    return;
  }

  // Stock loaded — enable the form
  hideLoading();

  // Set up event listeners
  document.getElementById('calc-form').addEventListener('submit', handleCalculate);
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
// LOADING & ERROR STATES
// ============================================================================

function showLoading() {
  const form = document.getElementById('calc-form');
  const btn = form.querySelector('.btn-calculate');
  btn.disabled = true;
  btn.textContent = 'Loading stock…';

  // Show loading banner
  const resultsEl = document.getElementById('results');
  resultsEl.classList.remove('hidden');
  resultsEl.innerHTML = `<div class="loading-banner">
    <div class="loading-spinner"></div>
    <span>Loading stock from HireHop…</span>
  </div>`;
}

function hideLoading() {
  const form = document.getElementById('calc-form');
  const btn = form.querySelector('.btn-calculate');
  btn.disabled = false;
  btn.textContent = 'Calculate';

  const resultsEl = document.getElementById('results');
  resultsEl.classList.add('hidden');
  resultsEl.innerHTML = '';
}

function showStockError() {
  const form = document.getElementById('calc-form');
  const btn = form.querySelector('.btn-calculate');
  btn.disabled = true;
  btn.textContent = 'Stock unavailable';

  const resultsEl = document.getElementById('results');
  resultsEl.classList.remove('hidden');
  resultsEl.innerHTML = `<div class="error-banner">
    <strong>Could not load stock from HireHop</strong>
    <p>The staging calculator needs live stock data. Please check your internet connection and try refreshing the page.</p>
    <button class="chip" onclick="location.reload()" style="margin-top:10px">Refresh page</button>
  </div>`;
}


// ============================================================================
// UNIT TOGGLE & AUTO-CONVERSION
// ============================================================================

function handleUnitToggle(newUnit) {
  if (newUnit === currentUnit) return;

  const oldUnit = currentUnit;
  const lengthIn = readDimensionInches('length', oldUnit);
  const widthIn = readDimensionInches('width', oldUnit);
  const heightIn = readDimensionInches('height', oldUnit);

  currentUnit = newUnit;
  document.querySelectorAll('.unit-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.unit === newUnit);
  });
  syncFieldVisibility();

  if (lengthIn > 0) writeDimensionFromInches('length', lengthIn, newUnit);
  if (widthIn > 0) writeDimensionFromInches('width', widthIn, newUnit);
  if (heightIn > 0) writeDimensionFromInches('height', heightIn, newUnit);
}

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

function writeDimensionFromInches(dim, inches, unit) {
  if (unit === 'm') {
    const meters = inches * 0.0254;
    // Smart rounding: snap to nearest 5cm when within 1.5cm
    const rounded5cm = Math.round(meters * 20) / 20;
    const useSnapped = Math.abs(meters - rounded5cm) < 0.015;
    const display = useSnapped ? rounded5cm.toFixed(2) : meters.toFixed(2);
    document.getElementById(`stage-${dim}-m`).value = display;
  } else {
    let ft = Math.floor(inches / 12);
    let remainIn = Math.round(inches % 12);
    if (remainIn >= 12) {
      ft += 1;
      remainIn = 0;
    }
    document.getElementById(`stage-${dim}-ft`).value = ft || '';
    document.getElementById(`stage-${dim}-in`).value = remainIn || '';
  }
}

function syncFieldVisibility() {
  const isMetric = currentUnit === 'm';
  const dims = ['length', 'width', 'height'];

  for (const dim of dims) {
    const metricEl = document.getElementById(`${dim}-metric`);
    const imperialEl = document.getElementById(`${dim}-imperial`);

    if (isMetric) {
      metricEl.classList.remove('hidden');
      imperialEl.classList.add('hidden');
      document.getElementById(`stage-${dim}-m`).required = true;
      document.getElementById(`stage-${dim}-ft`).required = false;
    } else {
      metricEl.classList.add('hidden');
      imperialEl.classList.remove('hidden');
      document.getElementById(`stage-${dim}-m`).required = false;
      document.getElementById(`stage-${dim}-ft`).required = true;
    }
  }
}


// ============================================================================
// FORM SUBMISSION & CALCULATION
// ============================================================================

async function handleCalculate(e) {
  e.preventDefault();

  if (!STOCK) {
    showError('Stock data not loaded. Please refresh the page.');
    return;
  }

  const unit = getCurrentUnit();
  let length, width, height;

  if (unit === 'm') {
    length = parseFloat(document.getElementById('stage-length-m').value);
    width = parseFloat(document.getElementById('stage-width-m').value);
    height = parseFloat(document.getElementById('stage-height-m').value);
  } else {
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

  if (isNaN(length) || isNaN(width) || isNaN(height) || length <= 0 || width <= 0 || height <= 0) {
    showError('Please enter valid positive numbers for all dimensions.');
    return;
  }

  // Use orientation-optimised calculation
  currentResult = calculateBestOrientation({ length, width, height, unit, combinerMode });

  if (currentResult.success) {
    // If dates are set, fetch availability before rendering
    const startDate = document.getElementById('avail-start').value;
    const endDate = document.getElementById('avail-end').value;

    if (startDate) {
      // Show a brief loading indicator
      const resultsEl = document.getElementById('results');
      resultsEl.classList.remove('hidden');
      resultsEl.innerHTML = `<div class="loading-banner">
        <div class="loading-spinner"></div>
        <span>Checking availability for ${startDate}${endDate ? ' → ' + endDate : ''}…</span>
      </div>`;

      const availLoaded = await fetchAvailability(startDate, endDate || startDate);
      if (!availLoaded) {
        // Availability failed — render without it but show a warning
        AVAILABILITY = null;
        console.warn('Availability check failed — showing stock totals only');
      }
    } else {
      // No dates — clear any previous availability data
      AVAILABILITY = null;
    }

    renderResults(currentResult);
  } else {
    renderError(currentResult);
  }
}

function showError(msg) {
  const resultsEl = document.getElementById('results');
  resultsEl.classList.remove('hidden');
  resultsEl.innerHTML = `<div class="error-banner">${msg}</div>`;
}

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

function applySuggestion(dim, inches) {
  writeDimensionFromInches(dim, inches, getCurrentUnit());
  handleCalculate(new Event('submit'));
}

function applyHeightSuggestion(heightInches) {
  writeDimensionFromInches('height', heightInches, getCurrentUnit());
  handleCalculate(new Event('submit'));
}

function applyDimensionSuggestion(lengthInches, widthInches) {
  writeDimensionFromInches('length', lengthInches, getCurrentUnit());
  writeDimensionFromInches('width', widthInches, getCurrentUnit());
  handleCalculate(new Event('submit'));
}

/**
 * Recalculate using only in-stock decks.
 * Called when user clicks "Use this layout" on the stock alternative card.
 */
async function recalculateStockOnly() {
  if (!STOCK) return;

  const unit = getCurrentUnit();
  let length, width, height;

  if (unit === 'm') {
    length = parseFloat(document.getElementById('stage-length-m').value);
    width = parseFloat(document.getElementById('stage-width-m').value);
    height = parseFloat(document.getElementById('stage-height-m').value);
  } else {
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

  currentResult = calculateBestOrientation({
    length, width, height, unit, combinerMode, inStockOnly: true,
  });

  if (currentResult.success) {
    // Re-fetch availability if dates are set (availability data may already be loaded)
    const startDate = document.getElementById('avail-start').value;
    const endDate = document.getElementById('avail-end').value;
    if (startDate && !AVAILABILITY) {
      await fetchAvailability(startDate, endDate || startDate);
    }
    renderResults(currentResult);
  } else {
    renderError(currentResult);
  }
}

/**
 * Switch back to showing all stock (not just in-stock).
 */
function recalculateAllStock() {
  handleCalculate(new Event('submit'));
}


// ============================================================================
// RENDER RESULTS
// ============================================================================

function renderResults(result) {
  const resultsEl = document.getElementById('results');
  resultsEl.classList.remove('hidden');
  const unit = result.input.unit;

  let html = '';

  // Orientation swap notice
  if (result._orientationSwapped) {
    html += `<div class="info-banner">
      <strong>💡 Orientation optimised</strong> — swapped length and width to reduce parts count.
    </div>`;
  }

  // Dimension summary
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

  // Deck layout visual
  html += `<div class="result-card">
    <h2>Deck Layout <span class="badge">${result.summary.totalDecks} decks</span></h2>
    <div class="layout-visual-container">
      ${renderLayoutVisual(result.layout, result.result.actualLength.inches, result.result.actualWidth.inches, unit)}
    </div>`;

  // Stock-only mode banner OR stock-constrained alternative (both live inside the Deck Layout card)
  if (result.summary.inStockOnly) {
    // Currently viewing in-stock layout — show banner with toggle back
    html += `<div class="alt-section">
      <div class="info-banner stock-only-banner">
        <strong>📦 Showing in-stock layout only</strong> — using only decks you currently have available.
        <button class="chip" onclick="recalculateAllStock()" style="margin-left:10px">Show optimal layout</button>
      </div>
    </div>`;
  } else if (result.stockAlternativeParts) {
    // Optimal layout has shortfalls — show in-stock alternative with "Use this layout" button
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
        <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap">
          <button class="btn btn-calculate" style="padding:8px 20px; font-size:14px" onclick="recalculateStockOnly()">
            ✅ Use this layout
          </button>
          ${altDims ? `<button class="chip" onclick="applyDimensionSuggestion(${altDims.lengthIn}, ${altDims.widthIn})">
            Recalculate at ${altLabel}
          </button>` : ''}
        </div>
      </div>
    </div>`;
  }

  html += `</div>`;

  // Parts list (BEFORE junction points)
  const hasAvailability = AVAILABILITY !== null;
  const availDates = hasAvailability
    ? `${AVAILABILITY.startDate}${AVAILABILITY.endDate && AVAILABILITY.endDate !== AVAILABILITY.startDate ? ' → ' + AVAILABILITY.endDate : ''}`
    : '';

  html += `<div class="result-card">
    <h2>Parts List${hasAvailability ? ` <span class="badge">📅 ${availDates}</span>` : ''}</h2>`;

  // Show availability info banner when dates are active
  if (hasAvailability) {
    html += `<div class="info-banner" style="margin-bottom:12px">
      <strong>📅 Showing date-based availability</strong> — "Available" column shows what's not booked on ${availDates}.
    </div>`;
  }

  html += `<table class="parts-table">
      <thead>
        <tr>
          <th>Item</th>
          <th>Needed</th>
          <th>${hasAvailability ? 'Owned' : 'In Stock'}</th>
          ${hasAvailability ? '<th>Available</th>' : ''}
          <th>Status</th>
          <th>Notes</th>
        </tr>
      </thead>
      <tbody>`;

  let currentCategory = '';
  for (const part of result.partsList) {
    if (part.category !== currentCategory) {
      currentCategory = part.category;
      html += `<tr class="category-row"><td colspan="${hasAvailability ? 6 : 5}">${currentCategory}</td></tr>`;
    }

    // Look up date-based availability for this item
    const availQty = getAvailableQtyForPart(part);
    const effectiveQty = availQty !== null ? availQty : part.qtyOwned;
    const effectiveShortfall = Math.max(0, part.qtyNeeded - effectiveQty);

    const statusClass = effectiveShortfall > 0 ? 'status-short' :
      part.qtyNeeded <= effectiveQty * 0.8 ? 'status-ok' : 'status-tight';
    const statusText = effectiveShortfall > 0 ? `Short ${effectiveShortfall}` :
      part.qtyNeeded === effectiveQty ? 'Exact' : 'OK';
    const statusIcon = effectiveShortfall > 0 ? '🔴' : part.qtyNeeded >= effectiveQty ? '🟡' : '🟢';

    // Availability cell — show with colour coding
    let availCell = '';
    if (hasAvailability) {
      if (availQty !== null) {
        const availClass = availQty >= part.qtyNeeded ? 'ok' :
          availQty > 0 ? 'tight' : 'short';
        availCell = `<td class="num"><span class="avail-badge ${availClass}">${availQty}</span></td>`;
      } else {
        availCell = `<td class="num" style="color:#94a3b8">—</td>`;
      }
    }

    html += `<tr>
      <td>${part.name}</td>
      <td class="num">${part.qtyNeeded}</td>
      <td class="num">${part.qtyOwned}</td>
      ${availCell}
      <td class="${statusClass}">${statusIcon} ${statusText}</td>
      <td class="note">${part.note}</td>
    </tr>`;
  }

  html += `</tbody></table>`;

  // Height alternatives (still inside the parts list card)
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
          const legInfo = alt.combinerLeg ? `${alt.legName} + combiner` : alt.legName;
          return `<button class="alt-height-chip" onclick="applyHeightSuggestion(${alt.stageHeightIn})">
            <span class="alt-chip-label">${arrow} ${label}</span>
            <span class="alt-chip-desc">${secondary} — ${legInfo}${alt.legColour ? ` (${alt.legColour})` : ''}</span>
          </button>`;
        }).join('')}
      </div>
    </div>`;
  }

  html += `</div>`;

  // Junction summary (AFTER parts list)
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

  // Warnings
  if (result.summary.warnings.length > 0) {
    html += `<div class="result-card warnings-card">
      <h2>⚠️ Warnings</h2>
      <ul>${result.summary.warnings.map(w => `<li>${w}</li>`).join('')}</ul>
    </div>`;
  }

  resultsEl.innerHTML = html;
}


// ============================================================================
// 2D LAYOUT VISUAL (SVG) — unit-aware labels
// ============================================================================

function renderLayoutVisual(layout, totalLength, totalWidth, unit) {
  const maxViewWidth = 600;
  const maxViewHeight = 300;
  const padding = 30;

  const scaleX = (maxViewWidth - padding * 2) / totalLength;
  const scaleY = (maxViewHeight - padding * 2) / totalWidth;
  const scale = Math.min(scaleX, scaleY);

  const svgWidth = totalLength * scale + padding * 2;
  const svgHeight = totalWidth * scale + padding * 2;

  const deckColours = {
    96: { fill: '#dbeafe', stroke: '#3b82f6' },
    72: { fill: '#dcfce7', stroke: '#22c55e' },
    48: { fill: '#fef3c7', stroke: '#f59e0b' },
    24: { fill: '#fce7f3', stroke: '#ec4899' },
  };

  let svgContent = '';

  for (const placed of layout) {
    const x = placed.x * scale + padding;
    const y = placed.y * scale + padding;
    const w = placed.orientedLength * scale;
    const h = placed.orientedWidth * scale;
    const colour = deckColours[placed.deck.lengthIn] || { fill: '#f3f4f6', stroke: '#6b7280' };

    svgContent += `<rect x="${x}" y="${y}" width="${w}" height="${h}" 
      fill="${colour.fill}" stroke="${colour.stroke}" stroke-width="2" rx="3" />`;

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

  const totalLengthLabel = formatDimensionForUnit(totalLength, unit);
  const totalWidthLabel = formatDimensionForUnit(totalWidth, unit);

  svgContent += `<text x="${svgWidth / 2}" y="${padding - 10}" 
    text-anchor="middle" font-size="13" fill="#374151" font-weight="600"
    font-family="Inter, sans-serif">← ${totalLengthLabel} →</text>`;

  svgContent += `<text x="${padding - 10}" y="${svgHeight / 2}" 
    text-anchor="middle" font-size="13" fill="#374151" font-weight="600"
    font-family="Inter, sans-serif"
    transform="rotate(-90, ${padding - 10}, ${svgHeight / 2})">← ${totalWidthLabel} →</text>`;

  return `<svg viewBox="0 0 ${svgWidth} ${svgHeight}" width="100%" 
    style="max-width:${svgWidth}px" xmlns="http://www.w3.org/2000/svg">
    ${svgContent}
  </svg>`;
}