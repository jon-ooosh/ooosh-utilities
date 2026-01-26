/**
 * date-copy-automation.js
 * 
 * Webhook handler for Monday.com board 2431480012.
 * Manages the relationship between date columns based on rehearsal status.
 * 
 * TRIGGERS (two webhooks point here):
 * 1. When "date_mkzzmse7" changes → recalculate target date
 * 2. When "dup__of_vehicle_" changes → recalculate target date
 * 
 * LOGIC:
 * - If "dup__of_vehicle_" status is "Rehearsal" → copy date as-is
 * - Otherwise (including blank) → copy date minus one day
 * 
 * TARGET: "dup__of_hire_starts" receives the calculated date
 * 
 * Webhook setup in Monday.com:
 * 1. Go to Board > Integrations > Webhooks
 * 2. Create TWO webhooks for "When column changes":
 *    - Webhook 1: Column = date_mkzzmse7
 *    - Webhook 2: Column = dup__of_vehicle_
 * 3. Both use URL: https://ooosh-utilities.netlify.app/.netlify/functions/date-copy-automation
 * 
 * v1.0 - Initial implementation (date trigger only)
 * v1.1 - Added rehearsal status trigger
 * v1.2 - Added retry logic for API calls
 */

// Board configuration
const BOARD_ID = 2431480012;
const SOURCE_DATE_COLUMN = 'date_mkzzmse7';        // The source date
const TARGET_DATE_COLUMN = 'dup__of_hire_starts';  // The date we write to
const VEHICLE_STATUS_COLUMN = 'dup__of_vehicle_';  // Status column (Rehearsal or blank)
const REHEARSAL_LABEL = 'Rehearsal';               // Status label that skips the -1 day

// Columns that trigger this automation
const MONITORED_COLUMNS = [SOURCE_DATE_COLUMN, VEHICLE_STATUS_COLUMN];

// Retry configuration
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000,  // 1 second, doubles each retry
  retryableErrors: ['ETIMEDOUT', 'ECONNRESET', 'rate limit', 'timeout', '429', '500', '502', '503', '504']
};

exports.handler = async (event) => {
  console.log('📅 Date copy automation triggered');
  
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

    // Verify this is a column we care about
    if (!MONITORED_COLUMNS.includes(columnId)) {
      console.log(`⏭️ Ignoring change to column ${columnId} (not monitored)`);
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

    // Log which trigger fired
    if (columnId === SOURCE_DATE_COLUMN) {
      console.log('🎯 Trigger: Source date changed');
    } else if (columnId === VEHICLE_STATUS_COLUMN) {
      console.log('🎯 Trigger: Rehearsal status changed');
    }

    // Fetch the item to get current column values (with retry)
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

    // Extract the source date and vehicle status
    const sourceDate = getColumnValue(itemData.column_values, SOURCE_DATE_COLUMN);
    const vehicleStatus = getStatusLabel(itemData.column_values, VEHICLE_STATUS_COLUMN);

    console.log(`📅 Source date: ${sourceDate || '(not set)'}`);
    console.log(`🎭 Rehearsal status: ${vehicleStatus || '(blank)'}`);

    // If no source date is set, nothing to calculate
    if (!sourceDate) {
      console.log('⏭️ No date set in source column - nothing to copy');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'No date to copy' })
      };
    }

    // Calculate target date based on rehearsal status
    let targetDate;
    let appliedRule;
    
    if (vehicleStatus === REHEARSAL_LABEL) {
      // Rehearsal: copy date as-is
      targetDate = sourceDate;
      appliedRule = 'copy-as-is';
      console.log(`🎭 Status is "${REHEARSAL_LABEL}" - copying date as-is`);
    } else {
      // Not rehearsal (blank or anything else): subtract one day
      targetDate = subtractOneDay(sourceDate);
      appliedRule = 'minus-one-day';
      console.log(`📆 Status is "${vehicleStatus || '(blank)'}" - subtracting one day`);
    }

    console.log(`✏️ Target date to write: ${targetDate}`);

    // Check current target date to avoid unnecessary updates
    const currentTargetDate = getColumnValue(itemData.column_values, TARGET_DATE_COLUMN);
    
    if (currentTargetDate === targetDate) {
      console.log('✓ Target date already correct - no update needed');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: 'No update needed - date already correct',
          itemId,
          sourceDate,
          targetDate,
          vehicleStatus: vehicleStatus || '(blank)',
          appliedRule
        })
      };
    }

    // Update the target column (with retry)
    await updateDateColumn(itemId, TARGET_DATE_COLUMN, targetDate);

    console.log('✅ Date copy complete');
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        itemId,
        sourceDate,
        targetDate,
        previousTargetDate: currentTargetDate || '(not set)',
        vehicleStatus: vehicleStatus || '(blank)',
        appliedRule,
        triggeredBy: columnId === SOURCE_DATE_COLUMN ? 'date-change' : 'status-change'
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
// MONDAY.COM API HELPERS (with retry logic)
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
 * Update a date column on an item
 */
async function updateDateColumn(itemId, columnId, dateValue) {
  // Date columns require format: { "date": "YYYY-MM-DD" }
  const columnValues = {
    [columnId]: { date: dateValue }
  };

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
      // Add delay before retry (not on first attempt)
      if (attempt > 1) {
        const delay = RETRY_CONFIG.baseDelayMs * Math.pow(2, attempt - 2);
        console.log(`⏳ Retry attempt ${attempt}/${RETRY_CONFIG.maxAttempts} after ${delay}ms...`);
        await sleep(delay);
      }
      
      return await callMondayAPI(query);
      
    } catch (error) {
      lastError = error;
      
      // Check if this error is retryable
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
      'API-Version': '2025-04'  // Using current API version
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
 * Get the date value from a column by ID
 */
function getColumnValue(columnValues, columnId) {
  const column = columnValues.find(col => col.id === columnId);
  if (!column) return null;
  
  // For date columns, extract the YYYY-MM-DD from the value JSON
  if (column.value) {
    try {
      const parsed = JSON.parse(column.value);
      if (parsed.date) {
        return parsed.date;
      }
    } catch (e) {
      // Fall back to text
    }
  }
  
  return column.text || null;
}

/**
 * Get the status label from a status column
 */
function getStatusLabel(columnValues, columnId) {
  const column = columnValues.find(col => col.id === columnId);
  if (!column) return null;
  
  // Status columns store the label in the value JSON
  if (column.value) {
    try {
      const parsed = JSON.parse(column.value);
      if (parsed.label) {
        return parsed.label;
      }
      // Some status columns use index instead of label
      if (parsed.index !== undefined) {
        // Fall back to text which contains the readable label
        return column.text || null;
      }
    } catch (e) {
      // Fall back to text
    }
  }
  
  return column.text || null;
}

/**
 * Subtract one day from a date string (YYYY-MM-DD format)
 */
function subtractOneDay(dateString) {
  const date = new Date(dateString + 'T12:00:00Z');  // Use noon to avoid timezone issues
  date.setUTCDate(date.getUTCDate() - 1);
  
  // Format back to YYYY-MM-DD
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
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