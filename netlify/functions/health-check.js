/**
 * health-check.js
 * 
 * System health monitoring endpoint for OOOSH systems.
 * Tests connectivity and configuration of all critical external services.
 * 
 * Called by: Google Apps Script timer (every 30 minutes)
 * 
 * Services checked:
 * - Monday.com API
 * - Idenfy API  
 * - Claude/Anthropic API
 * - SMTP configuration
 * - HireHop API
 * 
 * Returns JSON with status of each service and overall health.
 * 
 * v1.0 - Initial implementation (in driver-verification repo)
 * v1.1 - Fixed HireHop health check to use valid endpoint
 * v1.2 - Migrated to ooosh-utilities repo (central monitoring hub)
 */

// Timeout for each service check (ms)
const SERVICE_TIMEOUT = 10000; // 10 seconds

// Required environment variables for service checks
const REQUIRED_ENV_VARS = [
  'MONDAY_API_TOKEN',
  'ANTHROPIC_API_KEY',
  'IDENFY_API_KEY',
  'IDENFY_API_SECRET',
  'HIREHOP_API_TOKEN'
];

exports.handler = async (event) => {
  console.log('🏥 Health check initiated');
  const startTime = Date.now();
  
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Health-Check-Key',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const results = {
    timestamp: new Date().toISOString(),
    overall: 'healthy',
    services: {},
    environment: {},
    summary: {
      total: 0,
      healthy: 0,
      unhealthy: 0
    }
  };

  // Run all checks in parallel for speed
  const checks = await Promise.all([
    checkMondayAPI(),
    checkIdenfyAPI(),
    checkClaudeAPI(),
    checkSMTPConfig(),
    checkHireHopAPI(),
    checkEnvironmentVars()
  ]);

  // Process results
  const [monday, idenfy, claude, smtp, hirehop, envVars] = checks;
  
  results.services.monday = monday;
  results.services.idenfy = idenfy;
  results.services.claude = claude;
  results.services.smtp = smtp;
  results.services.hirehop = hirehop;
  results.environment = envVars;

  // Calculate summary
  const serviceResults = [monday, idenfy, claude, smtp, hirehop];
  results.summary.total = serviceResults.length;
  results.summary.healthy = serviceResults.filter(s => s.status === 'healthy').length;
  results.summary.unhealthy = serviceResults.filter(s => s.status === 'unhealthy').length;

  // Determine overall health
  // Critical services: Monday.com and SMTP (system can't function without these)
  const criticalHealthy = monday.status === 'healthy' && smtp.status === 'healthy';
  const allHealthy = results.summary.unhealthy === 0;
  
  if (!criticalHealthy) {
    results.overall = 'critical';
  } else if (!allHealthy) {
    results.overall = 'degraded';
  } else {
    results.overall = 'healthy';
  }

  // Add timing
  results.checkDurationMs = Date.now() - startTime;

  console.log(`🏥 Health check complete: ${results.overall} (${results.summary.healthy}/${results.summary.total} services healthy)`);

  return {
    statusCode: results.overall === 'healthy' ? 200 : 503,
    headers,
    body: JSON.stringify(results, null, 2)
  };
};

/**
 * Check Monday.com API connectivity
 */
async function checkMondayAPI() {
  const result = {
    name: 'Monday.com API',
    status: 'unknown',
    latencyMs: null,
    message: '',
    checkedAt: new Date().toISOString()
  };

  const token = process.env.MONDAY_API_TOKEN;
  
  if (!token) {
    result.status = 'unhealthy';
    result.message = 'MONDAY_API_TOKEN not configured';
    return result;
  }

  try {
    const startTime = Date.now();
    
    // Simple query to verify API access - just get account info
    const query = `query { me { id name } }`;
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SERVICE_TIMEOUT);
    
    const response = await fetch('https://api.monday.com/v2', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'API-Version': '2025-04'
      },
      body: JSON.stringify({ query }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    result.latencyMs = Date.now() - startTime;

    if (!response.ok) {
      result.status = 'unhealthy';
      result.message = `HTTP ${response.status}: ${response.statusText}`;
      return result;
    }

    const data = await response.json();
    
    if (data.errors) {
      result.status = 'unhealthy';
      result.message = data.errors[0]?.message || 'GraphQL error';
      return result;
    }

    if (data.data?.me?.id) {
      result.status = 'healthy';
      result.message = 'API responding normally';
    } else {
      result.status = 'unhealthy';
      result.message = 'Unexpected response structure';
    }

  } catch (error) {
    result.status = 'unhealthy';
    if (error.name === 'AbortError') {
      result.message = 'Request timeout (>10s)';
    } else {
      result.message = error.message;
    }
  }

  return result;
}

/**
 * Check Idenfy API connectivity
 */
async function checkIdenfyAPI() {
  const result = {
    name: 'Idenfy API',
    status: 'unknown',
    latencyMs: null,
    message: '',
    checkedAt: new Date().toISOString()
  };

  const apiKey = process.env.IDENFY_API_KEY;
  const apiSecret = process.env.IDENFY_API_SECRET;
  
  if (!apiKey || !apiSecret) {
    result.status = 'unhealthy';
    result.message = 'IDENFY credentials not configured';
    return result;
  }

  try {
    const startTime = Date.now();
    
    const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SERVICE_TIMEOUT);
    
    // Check account status endpoint
    const response = await fetch('https://ivs.idenfy.com/api/v2/status', {
      method: 'GET',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json'
      },
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    result.latencyMs = Date.now() - startTime;

    // Idenfy returns 401 for bad credentials
    if (response.status === 401 || response.status === 403) {
      result.status = 'unhealthy';
      result.message = 'Invalid API credentials';
      return result;
    }

    // Any other response (including 404) means API is reachable and auth worked
    result.status = 'healthy';
    result.message = 'API reachable and credentials valid';

  } catch (error) {
    result.status = 'unhealthy';
    if (error.name === 'AbortError') {
      result.message = 'Request timeout (>10s)';
    } else {
      result.message = error.message;
    }
  }

  return result;
}

/**
 * Check Claude/Anthropic API connectivity
 */
async function checkClaudeAPI() {
  const result = {
    name: 'Claude API',
    status: 'unknown',
    latencyMs: null,
    message: '',
    checkedAt: new Date().toISOString()
  };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  if (!apiKey) {
    result.status = 'unhealthy';
    result.message = 'ANTHROPIC_API_KEY not configured';
    return result;
  }

  try {
    const startTime = Date.now();
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SERVICE_TIMEOUT);
    
    // Minimal API call to verify access
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'hi' }]
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    result.latencyMs = Date.now() - startTime;

    if (response.status === 401) {
      result.status = 'unhealthy';
      result.message = 'Invalid API key';
      return result;
    }

    if (response.status === 429) {
      // Rate limited but API is working
      result.status = 'healthy';
      result.message = 'API responding (rate limited)';
      return result;
    }

    if (response.ok) {
      result.status = 'healthy';
      result.message = 'API responding normally';
    } else {
      const errorData = await response.json().catch(() => ({}));
      result.status = 'unhealthy';
      result.message = errorData.error?.message || `HTTP ${response.status}`;
    }

  } catch (error) {
    result.status = 'unhealthy';
    if (error.name === 'AbortError') {
      result.message = 'Request timeout (>10s)';
    } else {
      result.message = error.message;
    }
  }

  return result;
}

/**
 * Check SMTP configuration
 */
async function checkSMTPConfig() {
  const result = {
    name: 'SMTP Email',
    status: 'unknown',
    latencyMs: 0,
    message: '',
    checkedAt: new Date().toISOString()
  };

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  
  if (!host || !user || !pass) {
    result.status = 'unhealthy';
    result.message = 'SMTP configuration incomplete';
    return result;
  }

  // For SMTP, we just verify the config exists
  // Actually testing would require sending an email
  result.status = 'healthy';
  result.message = 'SMTP configured';

  return result;
}

/**
 * Check HireHop API connectivity
 * 
 * Uses job_refresh.php with job=0 (non-existent job).
 * - JSON response (even error) = API working, token valid
 * - HTML response = bad token
 * - Network error = API unreachable
 */
async function checkHireHopAPI() {
  const result = {
    name: 'HireHop API',
    status: 'unknown',
    latencyMs: null,
    message: '',
    checkedAt: new Date().toISOString()
  };

  const apiToken = process.env.HIREHOP_API_TOKEN;
  const domain = process.env.HIREHOP_DOMAIN || 'myhirehop.com';
  
  if (!apiToken) {
    result.status = 'unhealthy';
    result.message = 'HIREHOP_API_TOKEN not configured';
    return result;
  }

  try {
    const startTime = Date.now();
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SERVICE_TIMEOUT);
    
    // Use job_refresh.php with job=0 (doesn't exist)
    const encodedToken = encodeURIComponent(apiToken);
    const url = `https://${domain}/php_functions/job_refresh.php?job=0&token=${encodedToken}`;
    
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    result.latencyMs = Date.now() - startTime;

    const responseText = await response.text();
    
    // HTML response = auth failure
    if (responseText.trim().startsWith('<') || responseText.trim().startsWith('<!')) {
      result.status = 'unhealthy';
      result.message = 'Invalid token (HTML response)';
      return result;
    }
    
    // Try to parse as JSON
    let data;
    try {
      data = JSON.parse(responseText);
    } catch (parseError) {
      result.status = 'unhealthy';
      result.message = 'Invalid response format';
      return result;
    }
    
    // Valid JSON = API working
    result.status = 'healthy';
    result.message = 'API responding (token valid)';

  } catch (error) {
    result.status = 'unhealthy';
    if (error.name === 'AbortError') {
      result.message = 'Request timeout (>10s)';
    } else {
      result.message = error.message;
    }
  }

  return result;
}

/**
 * Check all required environment variables exist
 */
async function checkEnvironmentVars() {
  const result = {
    status: 'healthy',
    missing: [],
    present: [],
    checkedAt: new Date().toISOString()
  };

  for (const varName of REQUIRED_ENV_VARS) {
    if (process.env[varName]) {
      result.present.push(varName);
    } else {
      result.missing.push(varName);
    }
  }

  if (result.missing.length > 0) {
    result.status = 'unhealthy';
    result.message = `Missing: ${result.missing.join(', ')}`;
  } else {
    result.message = 'All required variables configured';
  }

  return result;
}