/**
 * generate-tool-token.js
 * 
 * Generates a short-lived handoff token for launching external tools.
 * These tokens are valid for 5 minutes and allow tools to trust
 * that the user has authenticated via the Staff Hub.
 * 
 * POST body: { sessionToken: "...", toolId: "...", jobId: "..." }
 * Returns: { success: true, token: "..." } or { success: false, error: "..." }
 * 
 * Environment variables required:
 * - STAFF_HUB_SECRET: Secret for signing tokens
 */

const crypto = require('crypto');

// Handoff token duration: 5 minutes
const TOKEN_DURATION_MS = 5 * 60 * 1000;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Only accept POST
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ success: false, error: 'Method not allowed' })
    };
  }

  try {
    const { sessionToken, toolId, jobId } = JSON.parse(event.body || '{}');
    
    const secret = process.env.STAFF_HUB_SECRET;
    if (!secret) {
      console.error('STAFF_HUB_SECRET environment variable not set');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ success: false, error: 'Server configuration error' })
      };
    }

    // Validate session token
    if (!validateSessionToken(sessionToken, secret)) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ success: false, error: 'Invalid or expired session' })
      };
    }

    // Validate inputs
    if (!toolId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ success: false, error: 'Tool ID required' })
      };
    }

    // Generate handoff token
    const timestamp = Date.now();
    const expiry = timestamp + TOKEN_DURATION_MS;
    const jobPart = jobId || 'none';
    
    const payload = `${expiry}.${toolId}.${jobPart}`;
    const signature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex')
      .substring(0, 32);
    
    const token = `${payload}.${signature}`;

    console.log(`🎫 Generated tool token for ${toolId} (job: ${jobPart})`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        token,
        expiresAt: new Date(expiry).toISOString()
      })
    };

  } catch (error) {
    console.error('Token generation error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: 'Server error' })
    };
  }
};

/**
 * Validates a session token
 */
function validateSessionToken(token, secret) {
  if (!token || !secret) return false;
  
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    
    const [type, expiry, signature] = parts;
    if (type !== 'session') return false;
    
    // Check expiry
    const expiryTime = parseInt(expiry, 10);
    if (isNaN(expiryTime) || Date.now() > expiryTime) {
      return false;
    }
    
    // Verify signature
    const payload = `${type}.${expiry}`;
    const expectedSig = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex')
      .substring(0, 32);
    
    return signature === expectedSig;
  } catch {
    return false;
  }
}
