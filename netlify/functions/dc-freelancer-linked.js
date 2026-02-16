/**
 * dc-freelancer-linked.js
 * 
 * Webhook handler for Monday.com board 2028045828 (D&C Board).
 * Triggers when connect_boards3 (freelancer link) changes.
 * 
 * ACTIONS:
 * - Copy mirror1 (freelancer email) → driver_email__gc_
 * 
 * WEBHOOK SETUP:
 * - Board: 2028045828
 * - Event: Column change
 * - Column: connect_boards3
 * - URL: https://ooosh-utilities.netlify.app/.netlify/functions/dc-freelancer-linked
 * 
 * v1.0 - Initial implementation
 */

// Board configuration
const BOARD_ID = 2028045828;
const TRIGGER_COLUMN = 'connect_boards3';

// Column IDs
const COLUMNS = {
  mirrorEmail: 'mirror1',           // Mirrored freelancer email
  driverEmail: 'driver_email__gc_'  // Target: driver email
};

exports.handler = async (event) => {
  console.log('🔗 D&C freelancer linked automation triggered');
  
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

    // Get value from mirror column
    const mirroredEmail = getMirrorValue(itemData.column_values, COLUMNS.mirrorEmail);

    console.log(`📧 Mirrored email: "${mirroredEmail || '(empty)'}"`);

    // Update target column (text format - driver_email__gc_ is a text column)
    await updateTextColumn(itemId, COLUMNS.driverEmail, mirroredEmail || '');

    console.log('✅ Driver email copied from mirror');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        itemId,
        updates: {
          [COLUMNS.driverEmail]: mirroredEmail || ''
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
  // Use MirrorValue fragment for mirror columns
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

async function updateTextColumn(itemId, columnId, value) {
  // driver_email__gc_ is a text column, not an email column
  const columnValues = {
    [columnId]: value || ''
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
 * Mirror columns need display_value via the MirrorValue fragment
 */
function getMirrorValue(columnValues, columnId) {
  const column = columnValues.find(col => col.id === columnId);
  if (!column) return null;
  
  return column.display_value !== undefined ? column.display_value : column.text;
}

function escapeJson(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}