/**
 * Netlify Function: staging-availability
 * 
 * Checks date-based availability of staging items via HireHop API.
 * Uses the "Get availability of products" endpoint which accepts up to 50
 * items and returns availability counts for a specific date/time.
 * 
 * Env vars required:
 *   HIREHOP_API_TOKEN - HireHop API token (server-side only)
 *   HIREHOP_DOMAIN    - HireHop domain (default: myhirehop.com)
 * 
 * Accepts POST with JSON body:
 *   {
 *     items: [{ id: 123 }, { id: 456 }, ...],  // HireHop item IDs (max 50)
 *     startDate: "2026-03-01",                   // ISO date string
 *     endDate: "2026-03-05"                      // ISO date string (optional)
 *   }
 * 
 * Returns:
 *   {
 *     success: true,
 *     availability: { "123": { stock: 10, available: 8 }, ... },
 *     checkedAt: "2026-03-01 09:00:00",
 *     timestamp: "2026-02-23T12:00:00Z"
 *   }
 */

// CORS headers
const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};


exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  const token = process.env.HIREHOP_API_TOKEN;
  const domain = process.env.HIREHOP_DOMAIN || 'myhirehop.com';

  if (!token) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'Missing HIREHOP_API_TOKEN env var.',
      }),
    };
  }

  try {
    // Parse request body
    let body;
    if (event.httpMethod === 'POST' && event.body) {
      body = JSON.parse(event.body);
    } else if (event.httpMethod === 'GET') {
      // Also support GET with query params for simple testing
      const qs = event.queryStringParameters || {};
      body = {
        items: qs.items ? JSON.parse(qs.items) : [],
        startDate: qs.startDate,
        endDate: qs.endDate,
      };
    } else {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'POST with JSON body required.' }),
      };
    }

    const { items, startDate, endDate } = body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'items array required (max 50 HireHop item IDs).' }),
      };
    }

    if (!startDate) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'startDate required (YYYY-MM-DD format).' }),
      };
    }

    if (items.length > 50) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'Maximum 50 items per request.' }),
      };
    }

    // Build the rows parameter for HireHop API
    // Each row needs: ID (product ID), TYPE (2=Rental), AVAILABLE (1), STOCK (1), GLOBAL (1)
    const rows = items.map(item => ({
      ID: item.id,
      TYPE: 2,          // Rental product
      ITEM_ID: 0,       // Not tied to a specific supplying list item
      AVAILABLE: 1,     // Request availability count
      STOCK: 1,         // Request stock count
      GLOBAL: 1,        // Include global depot
    }));

    // Format datetime for HireHop: "YYYY-MM-DD hh:mm:ss"
    const localDatetime = `${startDate} 09:00:00`;

    // Call HireHop API — check availability at start date
    const startResult = await callHireHopAvailability(domain, token, rows, localDatetime);

    // If end date provided and different from start, also check end date
    // and take the minimum availability (covers the full rental period)
    let endResult = null;
    if (endDate && endDate !== startDate) {
      const endDatetime = `${endDate} 09:00:00`;
      endResult = await callHireHopAvailability(domain, token, rows, endDatetime);
    }

    // Build availability map: itemId → { stock, available }
    const availability = {};

    for (const item of items) {
      const id = String(item.id);
      const startData = startResult[id] || { stock: 0, available: 0 };

      if (endResult) {
        const endData = endResult[id] || { stock: 0, available: 0 };
        // Take minimum availability across the date range
        availability[id] = {
          stock: startData.stock,
          available: Math.min(startData.available, endData.available),
        };
      } else {
        availability[id] = startData;
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        availability,
        checkedAt: localDatetime,
        endCheckedAt: endDate ? `${endDate} 09:00:00` : null,
        timestamp: new Date().toISOString(),
      }),
    };

  } catch (err) {
    console.error('Staging availability error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'Failed to check availability',
        details: err.message,
      }),
    };
  }
};


/**
 * Call HireHop's picklist_get_availability endpoint.
 * Returns a map of itemId → { stock, available }.
 */
async function callHireHopAvailability(domain, token, rows, localDatetime) {
  const url = `https://${domain}/php_functions/picklist_get_availability.php`;

  // Build query string — token + rows + local + tz
  const params = new URLSearchParams();
  params.set('token', token);
  params.set('rows', JSON.stringify(rows));
  params.set('local', localDatetime);
  params.set('tz', 'Europe/London');
  params.set('global_depot', '1');

  const fullUrl = `${url}?${params.toString()}`;

  console.log(`Calling HireHop availability: ${rows.length} items at ${localDatetime}`);

  const response = await fetch(fullUrl);

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HireHop API returned ${response.status}: ${text.substring(0, 200)}`);
  }

  const data = await response.json();

  // Check for HireHop error format: {"error": 3}
  if (data.error) {
    throw new Error(`HireHop API error code: ${data.error}`);
  }

  // Parse the response — HireHop returns the rows array back with availability data populated
  // Expected format: { rows: [{ ID: 123, AVAILABLE: 8, STOCK: 10, GLOBAL: 2 }, ...] }
  // OR it might return just the array directly
  const responseRows = data.rows || (Array.isArray(data) ? data : []);

  const result = {};
  for (const row of responseRows) {
    const id = String(row.ID);
    result[id] = {
      stock: parseInt(row.STOCK) || 0,
      available: parseInt(row.AVAILABLE) || 0,
      global: parseInt(row.GLOBAL) || 0,
    };
  }

  console.log(`HireHop availability response: ${responseRows.length} items returned`);

  return result;
}