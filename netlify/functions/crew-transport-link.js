/**
 * crew-transport-link.js
 * 
 * Webhook handler for Monday.com board 2431480012.
 * When the "link" column is populated with a HireHop job URL, this extracts
 * the job number and:
 * 1. Creates a nicely-formatted portal link in link_mm07k8n4
 * 2. Writes the job ID to text_mm07fcs (text7) - CRITICAL for other processes
 * 3. Updates the source link display text to show the job ID
 * 
 * TRIGGER:
 * When "link" column changes → extract job ID → write to multiple columns
 * 
 * INPUT EXAMPLE:
 * https://myhirehop.com/job.php?id=13422
 * 
 * OUTPUT:
 * - link_mm07k8n4: Portal URL with "Transport / crew" display text
 * - text_mm07fcs: Job ID as plain text (e.g., "13422") - ESSENTIAL for workflows
 * - link (source): Same URL but with job ID as display text
 * 
 * LOOP PROTECTION:
 * When we update the source link's display text, it triggers the webhook again.
 * We skip processing ONLY if both:
 * - Display text already matches job ID (would trigger loop)
 * - text7 already has the job ID (no update needed)
 * 
 * v1.0 - Initial implementation
 * v1.1 - Added text column and source link display text updates
 * v1.2 - Fixed loop protection to check text7, not just display text
 */

// Board configuration
const BOARD_ID = 2431480012;
const SOURCE_LINK_COLUMN = 'link';                 // The HireHop link column
const TARGET_LINK_COLUMN = 'link_mm07k8n4';        // Where we write the portal link
const TARGET_TEXT_COLUMN = 'text_mm07fcs';         // Where we write the job ID (text7)
const DISPLAY_TEXT = 'Transport / crew';           // What the portal link shows as
const PORTAL_BASE_URL = 'https://ooosh-freelancer-portal.netlify.app/staff/crew-transport?job=';

// Retry configuration (matching other functions in this repo)
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  retryableErrors: ['ETIMEDOUT', 'ECONNRESET', 'rate limit', 'timeout', '429', '500', '502', '503', '504']
};

exports.handler = async (event) => {
  console.log('🔗 Crew transport link automation triggered');
  
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  // Handle preflight OPTIONS request
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Only accept POST requests
  if (event.httpMethod !== 'POST') {
    return { 
      statusCode: 405, 
      headers, 
      body: JSON.stringify({ error: 'Method not allowed' }) 
    };
  }

  try {
    // Parse the webhook payload from Monday.com
    const payload = JSON.parse(event.body);
    console.log('📨 Webhook payload received:', JSON.stringify(payload, null, 2));

    // Monday.com sends a challenge for webhook verification
    if (payload.challenge) {
      console.log('🤝 Responding to Monday.com webhook challenge');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ challenge: payload.challenge })
      };
    }

    // Extract event details
    const webhookEvent = payload.event;
    
    if (!webhookEvent) {
      console.log('⚠️ No event in payload - possibly a test ping');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'No event to process' })
      };
    }

    const itemId = webhookEvent.pulseId || webhookEvent.itemId;
    const columnId = webhookEvent.columnId;
    const boardId = webhookEvent.boardId;

    console.log(`📋 Event details: Board ${boardId}, Item ${itemId}, Column ${columnId}`);

    // Verify this is the column we care about
    if (columnId !== SOURCE_LINK_COLUMN) {
      console.log(`⏭️ Ignoring change to column ${columnId} (not "${SOURCE_LINK_COLUMN}")`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Column not monitored', columnId })
      };
    }

    // Verify this is the correct board
    if (boardId && boardId !== BOARD_ID) {
      console.log(`⏭️ Ignoring event from board ${boardId} (not ${BOARD_ID})`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Board not monitored', boardId })
      };
    }

    // Fetch the item to get current column values
    console.log(`🔍 Fetching item ${itemId} details...`);
    const itemData = await fetchItemDetails(itemId);
    
    if (!itemData) {
      console.error('❌ Could not fetch item details');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch item details' })
      };
    }

    // Extract the HireHop link URL and current display text
    const hirehopUrl = getLinkUrl(itemData.column_values, SOURCE_LINK_COLUMN);
    const currentDisplayText = getLinkDisplayText(itemData.column_values, SOURCE_LINK_COLUMN);
    console.log(`🔗 Source HireHop URL: ${hirehopUrl || '(not set)'}`);
    console.log(`📝 Current display text: ${currentDisplayText || '(not set)'}`);

    // If no URL is set, nothing to do
    if (!hirehopUrl) {
      console.log('⏭️ No URL set in source column - nothing to process');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'No URL to process' })
      };
    }

    // Extract the job ID from the HireHop URL
    // Expected format: https://myhirehop.com/job.php?id=13422
    const jobId = extractJobId(hirehopUrl);
    
    if (!jobId) {
      console.log(`⚠️ Could not extract job ID from URL: ${hirehopUrl}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          message: 'Could not extract job ID from URL',
          url: hirehopUrl,
          hint: 'Expected format: https://myhirehop.com/job.php?id=12345'
        })
      };
    }

    console.log(`🔢 Extracted job ID: ${jobId}`);

    // Get current value of text7 column - this is the CRITICAL column for other processes
    const currentText7Value = getTextColumnValue(itemData.column_values, TARGET_TEXT_COLUMN);
    console.log(`📋 Current text7 value: ${currentText7Value || '(empty)'}`);

    // LOOP PROTECTION: Only skip if BOTH conditions are met:
    // 1. Display text already shows job ID (so updating it would trigger webhook again)
    // 2. text7 already has the job ID (so we don't need to update it)
    // 
    // If text7 is empty or different, we MUST process even if display text is already set!
    if (currentDisplayText === jobId && currentText7Value === jobId) {
      console.log('🔄 Both display text AND text7 already set to job ID - skipping to prevent loop');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          message: 'Already fully processed',
          jobId,
          displayTextMatches: true,
          text7Matches: true,
          skippedToPreventLoop: true
        })
      };
    }

    // Build the portal URL
    const portalUrl = PORTAL_BASE_URL + jobId;
    console.log(`✨ Portal URL: ${portalUrl}`);

    // Update all three columns
    // 1. Target link column (portal link with "Transport / crew" text)
    // 2. Text column (just the job ID) - CRITICAL for workflows
    // 3. Source link column (same URL but with job ID as display text)
    await updateMultipleColumns(itemId, {
      [TARGET_LINK_COLUMN]: { url: portalUrl, text: DISPLAY_TEXT },
      [TARGET_TEXT_COLUMN]: jobId,
      [SOURCE_LINK_COLUMN]: { url: hirehopUrl, text: jobId }
    });

    console.log('✅ All columns updated successfully');
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        itemId,
        jobId,
        sourceUrl: hirehopUrl,
        portalUrl,
        updates: {
          [TARGET_LINK_COLUMN]: `${portalUrl} ("${DISPLAY_TEXT}")`,
          [TARGET_TEXT_COLUMN]: jobId,
          [SOURCE_LINK_COLUMN]: `display text set to "${jobId}"`
        }
      })
    };

  } catch (error) {
    console.error('❌ Error processing webhook:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: error.message })
    };
  }
};

// ============================================================================
// MONDAY.COM API HELPERS
// ============================================================================

/**
 * Fetch item details including all column values
 */
async function fetchItemDetails(itemId) {
  const query = `
    query {
      items(ids: [${itemId}]) {
        id
        name
        column_values {
          id
          text
          value
        }
      }
    }
  `;

  const result = await callMondayAPIWithRetry(query);
  
  if (result.data?.items?.[0]) {
    return result.data.items[0];
  }
  
  return null;
}

/**
 * Update multiple columns at once (handles link and text columns)
 */
async function updateMultipleColumns(itemId, columns) {
  // Build column values object with correct format for each type
  const columnValues = {};
  
  for (const [columnId, value] of Object.entries(columns)) {
    if (typeof value === 'object' && value.url !== undefined) {
      // Link column format: { "url": "...", "text": "..." }
      columnValues[columnId] = { url: value.url, text: value.text };
    } else {
      // Text column format: just the string value
      columnValues[columnId] = value;
    }
  }

  const mutation = `
    mutation {
      change_multiple_column_values (
        item_id: ${itemId},
        board_id: ${BOARD_ID},
        column_values: "${escapeJson(JSON.stringify(columnValues))}"
      ) {
        id
      }
    }
  `;

  return await callMondayAPIWithRetry(mutation);
}

/**
 * Make a call to Monday.com GraphQL API with retry logic
 */
async function callMondayAPIWithRetry(query) {
  let lastError;
  
  for (let attempt = 1; attempt <= RETRY_CONFIG.maxAttempts; attempt++) {
    try {
      if (attempt > 1) {
        const delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 2);
        console.log(`⏳ Retry attempt ${attempt}/${RETRY_CONFIG.maxAttempts} after ${delay}ms...`);
        await sleep(delay);
      }
      
      return await callMondayAPI(query);
      
    } catch (error) {
      lastError = error;
      
      const isRetryable = RETRY_CONFIG.retryableErrors.some(errType => 
        error.message?.toLowerCase().includes(errType.toLowerCase())
      );
      
      if (!isRetryable) {
        console.log(`❌ Non-retryable error: ${error.message}`);
        throw error;
      }
      
      if (attempt === RETRY_CONFIG.maxAttempts) {
        console.log(`❌ All ${RETRY_CONFIG.maxAttempts} attempts failed`);
        throw error;
      }
      
      console.log(`⚠️ Attempt ${attempt} failed (${error.message}), will retry...`);
    }
  }
  
  throw lastError;
}

/**
 * Make a single call to Monday.com GraphQL API
 */
async function callMondayAPI(query) {
  const token = process.env.MONDAY_API_TOKEN;
  
  if (!token) {
    throw new Error('MONDAY_API_TOKEN not configured');
  }

  const response = await fetch('https://api.monday.com/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'API-Version': '2025-04'
    },
    body: JSON.stringify({ query })
  });

  const result = await response.json();

  if (result.errors) {
    console.error('Monday.com GraphQL errors:', result.errors);
    throw new Error(`GraphQL error: ${result.errors[0]?.message}`);
  }

  return result;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Get the URL from a link column
 */
function getLinkUrl(columnValues, columnId) {
  const column = columnValues.find(col => col.id === columnId);
  if (!column) return null;
  
  // Link columns store the URL in the value JSON
  if (column.value) {
    try {
      const parsed = JSON.parse(column.value);
      if (parsed.url) {
        return parsed.url;
      }
    } catch (e) {
      // Fall back to text
    }
  }
  
  // Sometimes the text field has the URL
  return column.text || null;
}

/**
 * Get the display text from a link column
 */
function getLinkDisplayText(columnValues, columnId) {
  const column = columnValues.find(col => col.id === columnId);
  if (!column) return null;
  
  // Link columns store the display text in the value JSON
  if (column.value) {
    try {
      const parsed = JSON.parse(column.value);
      if (parsed.text) {
        return parsed.text;
      }
    } catch (e) {
      // No display text set
    }
  }
  
  return null;
}

/**
 * Get the value from a text column
 */
function getTextColumnValue(columnValues, columnId) {
  const column = columnValues.find(col => col.id === columnId);
  if (!column) return null;
  
  // Text columns have the value directly in the text field
  return column.text || null;
}

/**
 * Extract job ID from a HireHop URL
 * Expected formats:
 * - https://myhirehop.com/job.php?id=13422
 * - https://myhirehop.com/job.php?id=13422&other=params
 */
function extractJobId(url) {
  if (!url) return null;
  
  // Match "id=" followed by one or more digits
  const match = url.match(/[?&]id=(\d+)/);
  
  if (match && match[1]) {
    return match[1];
  }
  
  return null;
}

/**
 * Escape JSON string for embedding in GraphQL
 */
function escapeJson(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
