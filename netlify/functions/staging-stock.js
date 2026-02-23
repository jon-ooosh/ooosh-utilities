/**
 * Netlify Function: staging-stock
 * 
 * Fetches staging equipment stock from HireHop's export endpoint.
 * Queries categories 445 (Decks/Platforms) and 446 (Legs & Hardware),
 * parses item names to extract dimensions, and returns a structured
 * STOCK object matching the staging calculator's format.
 * 
 * Env vars required:
 *   HIREHOP_EXPORT_ID  - HireHop company export ID (e.g. 2346)
 *   HIREHOP_EXPORT_KEY - HireHop export key (secret)
 * 
 * Returns: { success, stock, raw, timestamp }
 */

const HIREHOP_EXPORT_URL = 'https://myhirehop.com/modules/stock/export_data.php';

// Staging category IDs in HireHop
const CATEGORY_DECKS = 445;
const CATEGORY_HARDWARE = 446;

// Combiner height offset (universal constant — physical property, won't change)
const COMBINER_HEIGHT_OFFSET = 6;

// Leg colour mapping by height — these are physical paint colours on the legs
const LEG_COLOURS = {
  12: 'White end',
  24: 'Green end',
  30: 'Orange end',
  38: 'Blue end',
  48: 'Plain silver',
};

// Known wheel finished heights (physical property — wheel + adapter height)
const WHEEL_FINISHED_HEIGHTS = {
  '4"': 12,   // 4" wheel with deck pickup = 1ft finished
  '6"': 6,
  '8"': 8,
};

// Screwjack min/max usable range (physical property of the mechanism)
const SCREWJACK_RANGES = {
  8:    { minIn: 2, maxIn: 5.5 },
  19.5: { minIn: 2, maxIn: 13.5 },
};

// CORS headers
const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
};


// ============================================================================
// MAIN HANDLER
// ============================================================================

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const exportId = process.env.HIREHOP_EXPORT_ID;
  const exportKey = process.env.HIREHOP_EXPORT_KEY;

  if (!exportId || !exportKey) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'Missing HireHop export credentials. Set HIREHOP_EXPORT_ID and HIREHOP_EXPORT_KEY env vars.',
      }),
    };
  }

  try {
    // Fetch both categories in parallel
    const [decksRaw, hardwareRaw] = await Promise.all([
      fetchCategory(exportId, exportKey, CATEGORY_DECKS),
      fetchCategory(exportId, exportKey, CATEGORY_HARDWARE),
    ]);

    // Parse into structured STOCK format
    const stock = {
      decks: parseDecks(decksRaw),
      legs: parseLegs(hardwareRaw),
      combiners: parseCombiners(hardwareRaw),
      screwjacks: parseScrewjacks(hardwareRaw),
      wheels: parseWheels(hardwareRaw),
      handrails: parseHandrails(hardwareRaw),
      steps: parseSteps(hardwareRaw),
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        stock,
        // Include raw item count for debugging
        rawCounts: {
          decks: decksRaw.length,
          hardware: hardwareRaw.length,
        },
        timestamp: new Date().toISOString(),
      }),
    };
  } catch (err) {
    console.error('Staging stock fetch error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'Failed to fetch stock from HireHop',
        details: err.message,
      }),
    };
  }
};


// ============================================================================
// HIREHOP EXPORT FETCH
// ============================================================================

/**
 * Fetch all items in a HireHop category via the export endpoint.
 * Returns array of raw item objects.
 */
async function fetchCategory(exportId, exportKey, categoryId) {
  const params = new URLSearchParams({
    id: exportId,
    key: exportKey,
    cat: categoryId,
    sidx: 'TITLE',
    sord: 'asc',
  });

  const url = `${HIREHOP_EXPORT_URL}?${params.toString()}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HireHop API returned ${response.status} for category ${categoryId}`);
  }

  const text = await response.text();

  // Check for HTML error (auth failure)
  if (text.trim().startsWith('<')) {
    throw new Error(`HireHop returned HTML for category ${categoryId} — likely auth error`);
  }

  const data = JSON.parse(text);

  // Response can be array or object with items property
  return Array.isArray(data) ? data : (data.items || []);
}


// ============================================================================
// PARSERS — Extract structured data from HireHop item names
// ============================================================================

/**
 * Parse deck items from raw HireHop data.
 * Extracts dimensions from names like "8' x 4' Litedeck"
 */
function parseDecks(rawItems) {
  const decks = [];

  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);

    // Match patterns like "8' x 4' Litedeck" or "6' x 2' Steeldeck"
    const match = name.match(/(\d+)'\s*x\s*(\d+)'\s*(litedeck|steeldeck|deck)/i);
    if (match) {
      const lengthFt = parseInt(match[1]);
      const widthFt = parseInt(match[2]);
      const type = match[3].toLowerCase();

      decks.push({
        name,
        lengthIn: lengthFt * 12,
        widthIn: widthFt * 12,
        qty,
        type: type === 'steeldeck' ? 'steeldeck' : 'litedeck',
        hirehopId: item.ID || null,
      });
    }
  }

  return decks;
}

/**
 * Parse leg items. Heights from names like '24" / 2ft staging leg' or '8" staging leg'
 */
function parseLegs(rawItems) {
  const legs = [];

  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);

    // Must contain "staging leg" or "leg" but NOT "combiner", "screwjack", "wheel", etc.
    if (!name.match(/\bleg\b/i) || name.match(/combiner|screwjack|wheel|handrail|step/i)) continue;

    // Extract height in inches — try the leading inches first: '24" / 2ft staging leg'
    const inchMatch = name.match(/(\d+\.?\d*)\s*["″]/);
    if (inchMatch) {
      const heightIn = parseFloat(inchMatch[1]);
      legs.push({
        name,
        heightIn,
        qty,
        colour: LEG_COLOURS[heightIn] || '',
        hirehopId: item.ID || null,
      });
    }
  }

  return legs;
}

/**
 * Parse combiners. Names like '2-in-1 leg combiner', '4-in-1 leg combiner'
 */
function parseCombiners(rawItems) {
  const result = {
    twoInOne: { name: '2-in-1 leg combiner', qty: 0, heightOffsetIn: COMBINER_HEIGHT_OFFSET },
    fourInOne: { name: '4-in-1 leg combiner', qty: 0, heightOffsetIn: COMBINER_HEIGHT_OFFSET },
  };

  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);

    if (name.match(/2-in-1/i) && name.match(/combiner/i)) {
      result.twoInOne.name = name;
      result.twoInOne.qty = qty;
      result.twoInOne.hirehopId = item.ID || null;
    } else if (name.match(/4-in-1/i) && name.match(/combiner/i)) {
      result.fourInOne.name = name;
      result.fourInOne.qty = qty;
      result.fourInOne.hirehopId = item.ID || null;
    }
  }

  return result;
}

/**
 * Parse screwjacks. Names like '8" / 20cm screwjack' or '19.5" / 50cm screwjack'
 */
function parseScrewjacks(rawItems) {
  const screwjacks = [];

  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);

    if (!name.match(/screwjack/i)) continue;

    const inchMatch = name.match(/(\d+\.?\d*)\s*["″]/);
    if (inchMatch) {
      const totalLengthIn = parseFloat(inchMatch[1]);
      const range = SCREWJACK_RANGES[totalLengthIn] || { minIn: 2, maxIn: totalLengthIn * 0.7 };

      screwjacks.push({
        name,
        totalLengthIn,
        minIn: range.minIn,
        maxIn: range.maxIn,
        qty,
        hirehopId: item.ID || null,
      });
    }
  }

  return screwjacks;
}

/**
 * Parse wheels. Names like '4" rolling riser wheel (w/ deck pickup)'
 */
function parseWheels(rawItems) {
  const wheels = [];

  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);

    if (!name.match(/wheel/i)) continue;

    const inchMatch = name.match(/(\d+)\s*["″]/);
    if (inchMatch) {
      const wheelSize = `${inchMatch[1]}"`;
      const finishedHeight = WHEEL_FINISHED_HEIGHTS[wheelSize] || parseInt(inchMatch[1]);

      wheels.push({
        name,
        heightIn: finishedHeight,
        qty,
        note: finishedHeight !== parseInt(inchMatch[1]) ? `${finishedHeight / 12}ft finished height` : '',
        hirehopId: item.ID || null,
      });
    }
  }

  return wheels;
}

/**
 * Parse handrails. Names like "8' handrail"
 */
function parseHandrails(rawItems) {
  const handrails = [];

  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);

    if (!name.match(/handrail/i)) continue;

    const ftMatch = name.match(/(\d+)'\s*/);
    if (ftMatch) {
      handrails.push({
        name,
        lengthIn: parseInt(ftMatch[1]) * 12,
        qty,
        hirehopId: item.ID || null,
      });
    }
  }

  return handrails;
}

/**
 * Parse steps. Names like "1ft step" or "2ft steps"
 */
function parseSteps(rawItems) {
  const steps = [];

  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);

    if (!name.match(/\bsteps?\b/i)) continue;
    // Avoid matching "footswitch" or other false positives
    if (name.match(/switch|wheel|riser/i)) continue;

    const ftMatch = name.match(/(\d+)\s*ft/i);
    if (ftMatch) {
      steps.push({
        name,
        heightIn: parseInt(ftMatch[1]) * 12,
        qty,
        hirehopId: item.ID || null,
      });
    }
  }

  return steps;
}