/**
 * Netlify Function: staging-push
 * 
 * Pushes calculated staging parts to a HireHop job via save_job.php.
 * Accepts an array of items with HireHop IDs and quantities,
 * builds the items map, and adds them all in one API call.
 * 
 * Also adds a job note with an optional 3D viewer share link.
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
 *     ],
 *     shareLink: "https://..."   // optional 3D viewer URL
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
    const { jobId, items, shareLink, stageSummary } = body;

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

    // ── Add a job note with the 3D viewer link (if provided) ──
    let noteAdded = false;
    try {
      noteAdded = await addJobNote(domain, token, jobId, totalQty, Object.keys(itemsMap).length, shareLink, stageSummary);
    } catch (noteErr) {
      // Note failure is non-fatal — items were already pushed successfully
      console.warn('Failed to add job note (non-fatal):', noteErr.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        jobId: parseInt(jobId),
        itemTypes: Object.keys(itemsMap).length,
        totalQuantity: totalQty,
        noteAdded,
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


/**
 * Add a job note to HireHop with staging details and 3D viewer link.
 * Uses notes_save.php endpoint. Non-blocking — failure won't affect item push.
 * 
 * @param {string} domain - HireHop domain
 * @param {string} token - API token
 * @param {string} jobId - Job number
 * @param {number} totalQty - Total items pushed
 * @param {number} itemTypes - Number of distinct item types
 * @param {string} shareLink - 3D viewer URL (optional)
 * @param {string} stageSummary - Human-readable stage description (optional)
 * @returns {boolean} true if note was added successfully
 */
async function addJobNote(domain, token, jobId, totalQty, itemTypes, shareLink, stageSummary) {
  const timestamp = new Date().toLocaleDateString('en-GB') + ' ' +
                    new Date().toLocaleTimeString('en-GB');

  let noteText = `🏗️ Staging Calculator — items added automatically`;
  if (stageSummary) {
    noteText += `\n${stageSummary}`;
  }
  noteText += `\n${itemTypes} item types, ${totalQty} total pieces added.`;
  if (shareLink) {
    noteText += `\n\n3D Stage Preview:\n${shareLink}`;
  }
  noteText += `\n\nAdded: ${timestamp}`;

  const url = `https://${domain}/php_functions/notes_save.php`;

  const formData = new URLSearchParams();
  formData.append('main_id', jobId);
  formData.append('type', '1');        // 1 = job note
  formData.append('note', noteText);
  formData.append('token', token);

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
    console.error('Note save returned HTML — possible auth error');
    return false;
  }

  console.log(`✅ Job note added to job ${jobId}`);
  return true;
}