/**
 * Netlify Function: staging-push
 * 
 * Pushes calculated staging parts to a HireHop job via save_job.php.
 * Accepts an array of items with HireHop IDs and quantities,
 * builds the items map, and adds them all in one API call.
 * 
 * Uses the "b" prefix for hire/rental items (all staging equipment).
 * 
 * Env vars required:
 *   HIREHOP_API_TOKEN - HireHop API token
 *   HIREHOP_DOMAIN    - HireHop domain (default: myhirehop.com)
 * 
 * Accepts POST with JSON body:
 *   {
 *     jobId: "13422",
 *     items: [
 *       { hirehopId: 123, qty: 5 },
 *       { hirehopId: 456, qty: 2 },
 *       ...
 *     ]
 *   }
 * 
 * Returns:
 *   { success: true, itemCount: 7, timestamp: "..." }
 */

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ success: false, error: 'POST method required.' }),
    };
  }

  const token = process.env.HIREHOP_API_TOKEN;
  const domain = process.env.HIREHOP_DOMAIN || 'myhirehop.com';

  if (!token) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: 'Missing HIREHOP_API_TOKEN env var.' }),
    };
  }

  try {
    const body = JSON.parse(event.body);
    const { jobId, items } = body;

    // Validate inputs
    if (!jobId || !/^\d+$/.test(String(jobId))) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'Valid jobId required (integer).' }),
      };
    }

    if (!items || !Array.isArray(items) || items.length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'items array required (at least one item).' }),
      };
    }

    // Build the HireHop items map: { "b{hirehopId}": quantity }
    // "b" prefix = hire/rental item
    const itemsMap = {};
    let totalQty = 0;

    for (const item of items) {
      if (!item.hirehopId || !item.qty || item.qty <= 0) continue;
      const key = `b${item.hirehopId}`;
      // If same item appears multiple times, sum the quantities
      itemsMap[key] = (itemsMap[key] || 0) + item.qty;
      totalQty += item.qty;
    }

    if (Object.keys(itemsMap).length === 0) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'No valid items to push (all missing hirehopId or qty).' }),
      };
    }

    console.log(`Pushing ${Object.keys(itemsMap).length} item types (${totalQty} total) to job ${jobId}`);

    // Call HireHop save_job.php
    const url = `https://${domain}/api/save_job.php?token=${encodeURIComponent(token)}`;

    const formData = new URLSearchParams();
    formData.append('job', String(jobId));
    formData.append('items', JSON.stringify(itemsMap));

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    const text = await response.text();

    // Check for HTML error (auth failure)
    if (text.trim().startsWith('<')) {
      console.error('HireHop returned HTML on save — likely auth error');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Authentication error with HireHop. Check API token.',
        }),
      };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error('Failed to parse HireHop save response:', text.substring(0, 200));
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          success: false,
          error: 'Invalid response from HireHop.',
        }),
      };
    }

    // Check for HireHop error codes
    if (data.error) {
      console.error('HireHop save_job error:', data.error);
      const errorMessages = {
        1: 'Authentication failed',
        3: 'Missing required parameters',
      };
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          success: false,
          error: errorMessages[data.error] || `HireHop error code: ${data.error}`,
        }),
      };
    }

    console.log(`✅ Successfully pushed ${totalQty} items to job ${jobId}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        jobId: parseInt(jobId),
        itemTypes: Object.keys(itemsMap).length,
        totalQuantity: totalQty,
        timestamp: new Date().toISOString(),
      }),
    };

  } catch (err) {
    console.error('Staging push error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'Failed to push items to HireHop',
        details: err.message,
      }),
    };
  }
};