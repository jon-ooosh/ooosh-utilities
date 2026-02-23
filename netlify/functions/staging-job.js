/**
 * Netlify Function: staging-job
 * 
 * Fetches job details from HireHop API to extract hire start/end dates.
 * Used by the staging calculator to auto-populate date fields when
 * launched from the Staff Hub with a job number.
 * 
 * Env vars required:
 *   HIREHOP_API_TOKEN - HireHop API token
 *   HIREHOP_DOMAIN    - HireHop domain (default: myhirehop.com)
 * 
 * Query params:
 *   job - HireHop job number (integer)
 * 
 * Returns:
 *   {
 *     success: true,
 *     job: { id, name, startDate, endDate, status }
 *   }
 */

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
      body: JSON.stringify({ success: false, error: 'Missing HIREHOP_API_TOKEN env var.' }),
    };
  }

  const jobId = (event.queryStringParameters || {}).job;
  if (!jobId || !/^\d+$/.test(jobId)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ success: false, error: 'Valid job number required (?job=12345).' }),
    };
  }

  try {
    // Call HireHop's job_refresh endpoint to get job details
    const url = `https://${domain}/php_functions/job_refresh.php?job=${jobId}&token=${encodeURIComponent(token)}`;

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HireHop returned ${response.status}`);
    }

    const data = await response.json();

    // Check for HireHop error
    if (data.error) {
      throw new Error(`HireHop error code: ${data.error}`);
    }

    // Extract dates — HireHop uses JOB_START and JOB_END fields
    // Date format from API: "YYYY-MM-DD hh:mm:ss" (ISO 8601)
    const startDate = data.JOB_START ? data.JOB_START.substring(0, 10) : null;
    const endDate = data.JOB_END ? data.JOB_END.substring(0, 10) : null;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        job: {
          id: parseInt(jobId),
          name: data.JOB_NAME || data.NAME || '',
          startDate,
          endDate,
          status: data.JOB_STATUS || data.STATUS || null,
        },
      }),
    };

  } catch (err) {
    console.error('Job fetch error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: 'Failed to fetch job from HireHop',
        details: err.message,
      }),
    };
  }
};