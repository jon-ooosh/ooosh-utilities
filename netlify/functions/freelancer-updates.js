/**
 * freelancer-updates.js
 * 
 * Webhook handler for Monday.com board 3463379885 (Freelancer Board).
 * Handles email column changes.
 * 
 * ACTIONS:
 * - When email changes: Find all D&C items linked to this freelancer, update driver_email__gc_
 * 
 * WEBHOOK SETUP:
 * - Board: 3463379885
 * - Event: Column change
 * - Column: email
 * - URL: https://ooosh-utilities.netlify.app/.netlify/functions/freelancer-updates
 * 
 * v1.0 - Initial implementation
 */

// Board configuration
const FREELANCER_BOARD_ID = 3463379885;
const DC_BOARD_ID = 2028045828;

// Column IDs
const COLUMNS = {
  freelancerEmail: 'email',          // Freelancer board email column
  dcDriverEmail: 'driver_email__gc_', // D&C board target column
  dcConnectColumn: 'connect_boards3'  // D&C board connect column to Freelancer
};

exports.handler = async (event) => {
  console.log('👷 Freelancer update automation triggered');
  
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
    if (columnId !== COLUMNS.freelancerEmail) {
      console.log(`⏭️ Ignoring change to column ${columnId}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Column not monitored' })
      };
    }

    // Verify correct board
    if (boardId && boardId !== FREELANCER_BOARD_ID) {
      console.log(`⏭️ Ignoring event from board ${boardId}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Board not monitored' })
      };
    }

    // Fetch freelancer item to get the new email
    const itemData = await fetchItemDetails(itemId);
    
    if (!itemData) {
      console.error('❌ Could not fetch item details');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch item details' })
      };
    }

    const email = getColumnText(itemData.column_values, COLUMNS.freelancerEmail);
    console.log(`📧 Email changed to: "${email || '(empty)'}"`);

    // Find D&C items that link to this freelancer
    console.log(`🔍 Searching D&C board for items linked to Freelancer item ${itemId}...`);
    const linkedDCIds = await findDCItemsLinkedToFreelancer(itemId);
    console.log(`🔗 Found ${linkedDCIds.length} linked D&C items`);

    const actions = [];

    // Update each linked D&C item
    for (const dcItemId of linkedDCIds) {
      await updateEmailColumn(DC_BOARD_ID, dcItemId, COLUMNS.dcDriverEmail, email || '');
      console.log(`✅ Updated D&C item ${dcItemId}`);
    }

    if (linkedDCIds.length > 0) {
      actions.push(`synced_email_to_${linkedDCIds.length}_dc_items`);
    }

    console.log(`✅ Automation complete. Actions: ${actions.length > 0 ? actions.join(', ') : 'none'}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        itemId,
        email,
        linkedDCItems: linkedDCIds.length,
        actions
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
        }
      }
    }
  `;

  const result = await callMondayAPI(query);
  return result.data?.items?.[0] || null;
}

/**
 * Find D&C items that link to a specific Freelancer
 * Uses BoardRelationValue fragment to properly read connect_boards columns
 */
async function findDCItemsLinkedToFreelancer(freelancerItemId) {
  const query = `
    query {
      boards(ids: [${DC_BOARD_ID}]) {
        items_page(limit: 500) {
          items {
            id
            column_values(ids: ["${COLUMNS.dcConnectColumn}"]) {
              id
              ... on BoardRelationValue {
                linked_item_ids
              }
            }
          }
        }
      }
    }
  `;

  const result = await callMondayAPI(query);
  const items = result.data?.boards?.[0]?.items_page?.items || [];
  
  const linkedIds = [];
  
  for (const item of items) {
    const connectColumn = item.column_values.find(c => c.id === COLUMNS.dcConnectColumn);
    
    if (connectColumn?.linked_item_ids && connectColumn.linked_item_ids.length > 0) {
      const linksToUs = connectColumn.linked_item_ids.some(
        linkedId => String(linkedId) === String(freelancerItemId)
      );
      
      if (linksToUs) {
        linkedIds.push(item.id);
      }
    }
  }
  
  return linkedIds;
}

async function updateEmailColumn(boardId, itemId, columnId, email) {
  const columnValues = {};
  
  if (email) {
    columnValues[columnId] = { email: email, text: email };
  } else {
    columnValues[columnId] = '';
  }

  const mutation = `
    mutation {
      change_multiple_column_values (
        item_id: ${itemId},
        board_id: ${boardId},
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

function getColumnText(columnValues, columnId) {
  const column = columnValues.find(col => col.id === columnId);
  return column?.text || null;
}

function escapeJson(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}