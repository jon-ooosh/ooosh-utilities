/**
 * qh-client-linked.js
 * 
 * Webhook handler for Monday.com board 2431480012 (Quotes & Hires).
 * Triggers when connect_boards7 (client link) changes.
 * 
 * ACTIONS:
 * - Copy mirror_14 (client email) → text1
 * - Copy mirror_145 (client name) → text6
 * 
 * WEBHOOK SETUP:
 * - Board: 2431480012
 * - Event: Column change
 * - Column: connect_boards7
 * - URL: https://ooosh-utilities.netlify.app/.netlify/functions/qh-client-linked
 * 
 * v1.0 - Initial implementation
 */

// Board configuration
const BOARD_ID = 2431480012;
const TRIGGER_COLUMN = 'connect_boards7';

// Column IDs
const COLUMNS = {
  mirrorEmail: 'mirror_14',    // Mirrored client email
  mirrorName: 'mirror_145',    // Mirrored client name
  clientEmail: 'text1',        // Target: client email
  clientName: 'text6'          // Target: client name
};

exports.handler = async (event) => {
  console.log('🔗 Q&H client linked automation triggered');
  
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { 
      statusCode: 405, 
      headers, 
      body: JSON.stringify({ error: 'Method not allowed' }) 
    };
  }

  try {
    const payload = JSON.parse(event.body);

    // Handle Monday.com challenge
    if (payload.challenge) {
      console.log('🤝 Responding to Monday.com webhook challenge');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ challenge: payload.challenge })
      };
    }

    const webhookEvent = payload.event;
    
    if (!webhookEvent) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'No event to process' })
      };
    }

    const itemId = webhookEvent.pulseId || webhookEvent.itemId;
    const columnId = webhookEvent.columnId;
    const boardId = webhookEvent.boardId;

    console.log(`📋 Event: Board ${boardId}, Item ${itemId}, Column ${columnId}`);

    // Verify correct column
    if (columnId !== TRIGGER_COLUMN) {
      console.log(`⏭️ Ignoring change to column ${columnId}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Column not monitored' })
      };
    }

    // Verify correct board
    if (boardId && boardId !== BOARD_ID) {
      console.log(`⏭️ Ignoring event from board ${boardId}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Board not monitored' })
      };
    }

    // Fetch item details including mirror columns
    const itemData = await fetchItemDetails(itemId);
    
    if (!itemData) {
      console.error('❌ Could not fetch item details');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch item details' })
      };
    }

    // Get values from mirror columns
    const mirroredEmail = getMirrorValue(itemData.column_values, COLUMNS.mirrorEmail);
    const mirroredName = getMirrorValue(itemData.column_values, COLUMNS.mirrorName);

    console.log(`📧 Mirrored email: "${mirroredEmail || '(empty)'}"`);
    console.log(`👤 Mirrored name: "${mirroredName || '(empty)'}"`);

    // Update target columns
    await updateMultipleColumns(itemId, {
      [COLUMNS.clientEmail]: mirroredEmail || '',
      [COLUMNS.clientName]: mirroredName || ''
    });

    console.log('✅ Client details copied from mirrors');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        itemId,
        updates: {
          [COLUMNS.clientEmail]: mirroredEmail || '',
          [COLUMNS.clientName]: mirroredName || ''
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
          ... on MirrorValue {
            display_value
          }
        }
      }
    }
  `;

  const result = await callMondayAPI(query);
  return result.data?.items?.[0] || null;
}

async function updateMultipleColumns(itemId, columns) {
  const columnValues = {};
  
  for (const [columnId, value] of Object.entries(columns)) {
    // Email columns need special format: { email: "...", text: "..." }
    if (columnId === COLUMNS.clientEmail && value) {
      columnValues[columnId] = { email: value, text: value };
    } else {
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

  return await callMondayAPI(mutation);
}

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
 * Get value from a mirror column
 * Mirror columns need display_value (not text) via the MirrorValue fragment
 */
function getMirrorValue(columnValues, columnId) {
  const column = columnValues.find(col => col.id === columnId);
  if (!column) return null;
  
  // Mirror columns use display_value, fall back to text for regular columns
  return column.display_value !== undefined ? column.display_value : column.text;
}

function escapeJson(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}