/**
 * date-copy-automation.js
 * 
 * Webhook handler for Monday.com board 2431480012.
 * When date column "date_mkzzmse7" changes, copies the date to "dup__of_hire_starts"
 * with the following logic:
 * 
 * - If "dup__of_vehicle_" status is "Rehearsal" → copy date as-is
 * - Otherwise → copy date minus one day
 * 
 * Webhook setup in Monday.com:
 * 1. Go to Board > Integrations > Webhooks
 * 2. Create webhook for "When column changes"
 * 3. Select column: date_mkzzmse7
 * 4. URL: https://ooosh-utilities.netlify.app/.netlify/functions/date-copy-automation
 * 
 * v1.0 - Initial implementation
 */

// Board configuration
const BOARD_ID = 2431480012;
const SOURCE_DATE_COLUMN = 'date_mkzzmse7';        // The date that triggers the webhook
const TARGET_DATE_COLUMN = 'dup__of_hire_starts';  // The date we write to
const VEHICLE_STATUS_COLUMN = 'dup__of_vehicle_';  // Status column to check
const REHEARSAL_LABEL = 'Rehearsal';               // Status label that skips the -1 day

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

    // Verify this is the column we care about
    if (columnId !== SOURCE_DATE_COLUMN) {
      console.log(`⏭️ Ignoring change to column ${columnId} (not ${SOURCE_DATE_COLUMN})`);
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

    // Extract the source date and vehicle status
    const sourceDate = getColumnValue(itemData.column_values, SOURCE_DATE_COLUMN);
    const vehicleStatus = getStatusLabel(itemData.column_values, VEHICLE_STATUS_COLUMN);

    console.log(`📅 Source date: ${sourceDate}`);
    console.log(`🚗 Vehicle status: ${vehicleStatus}`);

    // If no date is set, nothing to copy
    if (!sourceDate) {
      console.log('⏭️ No date set in source column - nothing to copy');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'No date to copy' })
      };
    }

    // Calculate target date based on vehicle status
    let targetDate;
    if (vehicleStatus === REHEARSAL_LABEL) {
      // Rehearsal: copy date as-is
      targetDate = sourceDate;
      console.log(`🎭 Vehicle is "${REHEARSAL_LABEL}" - copying date as-is`);
    } else {
      // Not rehearsal: subtract one day
      targetDate = subtractOneDay(sourceDate);
      console.log(`📆 Vehicle is "${vehicleStatus || '(empty)'}" - subtracting one day`);
    }

    console.log(`✏️ Target date to write: ${targetDate}`);

    // Update the target column
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
        vehicleStatus: vehicleStatus || '(empty)',
        appliedRule: vehicleStatus === REHEARSAL_LABEL ? 'copy-as-is' : 'minus-one-day'
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

  const result = await callMondayAPI(query);
  
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

  return await callMondayAPI(mutation);
}

/**
 * Make a call to Monday.com GraphQL API
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
 * Get the text value from a column by ID
 */
function getColumnValue(columnValues, columnId) {
  const column = columnValues.find(col => col.id === columnId);
  if (!column) return null;
  
  // For date columns, the text is usually the formatted date
  // but we need the raw YYYY-MM-DD format from the value
  if (column.value) {
    try {
      const parsed = JSON.parse(column.value);
      if (parsed.date) {
        return parsed.date;  // Returns "YYYY-MM-DD"
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