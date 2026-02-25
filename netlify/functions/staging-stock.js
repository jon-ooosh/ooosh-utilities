/**
 * Netlify Function: staging-stock
 * 
 * Fetches staging equipment stock from HireHop's export endpoint.
 * Queries categories:
 *   445 — Decks/Platforms
 *   446 — Legs & Hardware (legs, combiners, wheels)
 *   447 — Screwjacks
 *   448 — Staging Accessories (handrails, steps, skirting)
 * 
 * Includes a 10-minute in-memory cache to avoid hitting HireHop's
 * rate limit (60 req/min). The cache persists as long as the Netlify
 * Function container stays warm.
 * 
 * Env vars required:
 *   HIREHOP_EXPORT_ID  - HireHop company export ID 
 *   HIREHOP_EXPORT_KEY - HireHop export key (secret)
 * 
 * Returns: { success, stock, raw, timestamp, cached }
 */

const HIREHOP_EXPORT_URL = 'https://myhirehop.com/modules/stock/export_data.php';
// Caching is handled at the CDN level via Cache-Control headers — see handler below.
// This means Netlify's CDN serves the response for 10 minutes without invoking the
// function at all, so HireHop is only hit once per 10 minutes across all users.

// Staging category IDs in HireHop
const CATEGORY_DECKS = 445;
const CATEGORY_HARDWARE = 446;
const CATEGORY_SCREWJACKS = 447;
const CATEGORY_ACCESSORIES = 448;

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

  // No in-function cache needed — CDN caching handles this (see response headers below).
  const now = Date.now();

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
    // Fetch ALL stock in a single call (no cat= filter) then split by category in JS.
    // This is the same approach used by the backline matcher — one request, no rate limit risk.
    const allRaw = await fetchCategory(exportId, exportKey, null);

    // TEMPORARY DEBUG — log first item's keys so we can see the exact field name for category
    if (allRaw.length > 0) {
      console.log('Raw item field names:', Object.keys(allRaw[0]));
      console.log('Raw item sample:', JSON.stringify(allRaw[0]));
    }

    const decksRaw       = allRaw.filter(i => parseInt(i.CAT || i.cat) === CATEGORY_DECKS);

    const decksRaw       = allRaw.filter(i => parseInt(i.CAT || i.cat) === CATEGORY_DECKS);
    const hardwareRaw    = allRaw.filter(i => parseInt(i.CAT || i.cat) === CATEGORY_HARDWARE);
    const screwjacksRaw  = allRaw.filter(i => parseInt(i.CAT || i.cat) === CATEGORY_SCREWJACKS);
    const accessoriesRaw = allRaw.filter(i => parseInt(i.CAT || i.cat) === CATEGORY_ACCESSORIES);

    // Parse into structured STOCK format
    // Handrails and steps can live in either hardware (446) or accessories (448)
    const allHardwareAndAccessories = [...hardwareRaw, ...accessoriesRaw];

    const stock = {
      decks: parseDecks(decksRaw),
      legs: parseLegs(hardwareRaw),
      combiners: parseCombiners(hardwareRaw),
      screwjacks: parseScrewjacks(screwjacksRaw),
      wheels: parseWheels(hardwareRaw),
      handrails: parseHandrails(allHardwareAndAccessories),
      steps: parseSteps(allHardwareAndAccessories),
      skirts: parseSkirts(accessoriesRaw),   // ← skirts live in accessories category 448
    };

    const responseBody = JSON.stringify({
      success: true,
      stock,
      rawCounts: {
        decks: decksRaw.length,
        hardware: hardwareRaw.length,
        screwjacks: screwjacksRaw.length,
        accessories: accessoriesRaw.length,
      },
      timestamp: new Date().toISOString(),
      cached: false,
    });

   console.log('Stock fetched from HireHop successfully. Skirts:', stock.skirts.length);

    return {
      statusCode: 200,
      headers: {
        ...headers,
        // Tell Netlify's CDN to cache this response for 10 minutes.
        // During that window, ALL users get the cached response — the function
        // (and HireHop) are not called at all. After 10 mins, one request
        // triggers a fresh fetch while stale data is served in the background.
        'Cache-Control': 'public, s-maxage=600, stale-while-revalidate=60',
        'Netlify-CDN-Cache-Control': 'public, max-age=600, stale-while-revalidate=3600',
      },
      body: responseBody,
    };

  } catch (err) {
    console.error('Staging stock fetch error:', err);

    // No stale fallback available — CDN may serve its own stale copy via
    // stale-while-revalidate if this error occurs during a background revalidation.

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
  // categoryId is optional — if null, fetches all stock (no cat= param)
  const params = new URLSearchParams({
    id: exportId,
    key: exportKey,
    sidx: 'TITLE',
    sord: 'asc',
  });
  if (categoryId !== null) {
    params.set('cat', categoryId);
  }

  const url = `${HIREHOP_EXPORT_URL}?${params.toString()}`;

  // Retry up to 3 times on 429 (rate limit), with a 1.5s pause between attempts
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 1500;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(url);

    if (response.status === 429) {
      if (attempt < MAX_RETRIES) {
        console.warn(`HireHop rate limit hit for category ${categoryId} (attempt ${attempt}/${MAX_RETRIES}) — retrying in ${RETRY_DELAY_MS}ms`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      } else {
        throw new Error(`HireHop rate limit (429) for category ${categoryId} — all ${MAX_RETRIES} attempts failed`);
      }
    }

    if (!response.ok) {
      throw new Error(`HireHop API returned ${response.status} for category ${categoryId}`);
    }

    const text = await response.text();

    // Check for HTML error (auth failure)
    if (text.trim().startsWith('<')) {
      throw new Error(`HireHop returned HTML for category ${categoryId} — likely auth error`);
    }

    const data = JSON.parse(text);
    return Array.isArray(data) ? data : (data.items || []);
  }
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

    // Must contain "leg" but NOT combiner, screwjack, wheel, handrail, step
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
 * Parse screwjacks from dedicated category 447.
 * Names like 'Screwjack - 8" / 20cm (48mm)' or 'Screwjack - 19.5" / 50cm (48mm)'
 * 
 * The heightIn stored is the TOTAL PHYSICAL length of the screwjack.
 * Useable extension range is approximately:
 *   min: 0" (wound all the way down, but in practice ~0")
 *   max: 70% of physical height
 * The staging-calculator.js matchLegs() function handles the range maths.
 */
function parseScrewjacks(rawItems) {
  const screwjacks = [];

  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);

    // Items in this category should all be screwjacks, but be defensive
    if (qty <= 0) continue;

    // Extract total physical height in inches from name
    const inchMatch = name.match(/(\d+\.?\d*)\s*["″]/);
    if (inchMatch) {
      const heightIn = parseFloat(inchMatch[1]);
      screwjacks.push({
        name,
        heightIn,     // total physical length — matchLegs uses heightIn * 0.70 as max extension
        qty,
        hirehopId: item.ID || null,
      });
    } else {
      // Fallback: try to parse from cm value in name ("50cm" → ~19.7")
      const cmMatch = name.match(/(\d+)\s*cm/i);
      if (cmMatch) {
        const heightIn = parseInt(cmMatch[1]) / 2.54;
        screwjacks.push({
          name,
          heightIn,
          qty,
          hirehopId: item.ID || null,
        });
      }
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
 * Parse handrails.
 * Matches names like:
 *   "Litedeck 8ft open-style handrail - staging"   (Xft format)
 *   "8' handrail"                                    (X' format)
 *   "Handrail 4ft"                                   (word then Xft)
 */
function parseHandrails(rawItems) {
  const handrails = [];

  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);

    if (!name.match(/handrail/i)) continue;

    // Try "Xft" format first (e.g. "Litedeck 8ft open-style handrail")
    let ftMatch = name.match(/(\d+)\s*ft/i);
    // Fall back to "X'" format (e.g. "8' handrail")
    if (!ftMatch) ftMatch = name.match(/(\d+)'\s*/);

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
 * Parse steps.
 * Matches names like:
 *   "Staging step / box tread - 1ft high"   (Xft format)
 *   "2ft steps"                              (Xft format)
 *   "1' step"                                (X' format)
 */
function parseSteps(rawItems) {
  const steps = [];

  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);

    if (!name.match(/\bsteps?\b/i) && !name.match(/\btread\b/i)) continue;
    // Avoid matching "footswitch" or other false positives
    if (name.match(/switch|wheel|riser/i)) continue;

    // Try "Xft" format first
    let ftMatch = name.match(/(\d+)\s*ft/i);
    // Fall back to "X'" format
    if (!ftMatch) ftMatch = name.match(/(\d+)'\s*/);

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

/**
 * Parse skirting / scrim items from accessories category (448).
 * 
 * HireHop name patterns (confirmed from live stock):
 *   "Black staging SKIRT - 1ft drop - 10ft length"         → heightIn: 12, lengthIn: 120
 *   "Black staging SKIRT - 3ft drop - 8ft length"          → heightIn: 36, lengthIn: 96
 *   "Black staging SKIRT - 3ft 6" drop (110cm) - 11ft length" → heightIn: 42, lengthIn: 132
 * 
 * The height is the "drop" (how far the skirt hangs down — matches stage height).
 * The length is the individual piece length.
 */
function parseSkirts(rawItems) {
  const skirts = [];

  for (const item of rawItems) {
    const name = item.NAME || item.name || '';
    const qty = parseInt(item.QTY || item.qty || 0);

    // Must be a SKIRT item
    if (!name.match(/\bSKIRT\b/i)) continue;

    // ── Parse drop height ──
    // Try "Xft Y" drop" first (handles "3ft 6" drop (110cm)" etc.)
    let heightIn = null;
    const ftInMatch = name.match(/(\d+)ft\s+(\d+)["″]\s*drop/i);
    if (ftInMatch) {
      heightIn = parseInt(ftInMatch[1]) * 12 + parseInt(ftInMatch[2]);
    } else {
      // Plain "Xft drop"
      const ftMatch = name.match(/(\d+)ft\s+drop/i);
      if (ftMatch) {
        heightIn = parseInt(ftMatch[1]) * 12;
      }
    }

    if (heightIn === null) continue;

    // ── Parse piece length ──
    const lenMatch = name.match(/(\d+)ft\s+length/i);
    if (!lenMatch) continue;
    const lengthIn = parseInt(lenMatch[1]) * 12;

    skirts.push({
      name,
      heightIn,
      lengthIn,
      qty,
      hirehopId: item.ID || null,
    });
  }

  // Sort by height then by length (longest pieces first within same height)
  skirts.sort((a, b) => a.heightIn - b.heightIn || b.lengthIn - a.lengthIn);

  return skirts;
}