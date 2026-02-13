/**
 * address-book-item-created.js
 * 
 * Webhook handler for Monday.com board 2431071567 (Client Address Book).
 * Triggers when a new item is created.
 * 
 * ACTIONS:
 * 1. Copy item_id to item_id__gc_ (for use in automations that can't use actual item ID)
 * 2. Copy item name to text_14 (full client name for emails)
 * 3. Extract first name from item name to text (friendly name for emails)
 * 
 * WEBHOOK SETUP:
 * - Board: 2431071567
 * - Event: Item created
 * - URL: https://ooosh-utilities.netlify.app/.netlify/functions/address-book-item-created
 * 
 * v1.0 - Initial implementation
 */

// Board configuration
const BOARD_ID = 2431071567;

// Column IDs
const COLUMNS = {
  itemIdCopy: 'item_id__gc_',  // Where we copy the item ID
  fullName: 'text_14',         // Full client name
  firstName: 'text'            // Extracted first name
};

// Prefixes to remove when extracting first name
const NAME_PREFIXES = ['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'lady', 'rev', 'mx'];

exports.handler = async (event) => {
  console.log('📇 Address book item created automation triggered');
  
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
    const boardId = webhookEvent.boardId;

    console.log(`📋 Item created: Board ${boardId}, Item ${itemId}`);

    // Verify correct board
    if (boardId && boardId !== BOARD_ID) {
      console.log(`⏭️ Ignoring event from board ${boardId}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Board not monitored' })
      };
    }

    // Fetch item details to get the name
    const itemData = await fetchItemDetails(itemId);
    
    if (!itemData) {
      console.error('❌ Could not fetch item details');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch item details' })
      };
    }

    const itemName = itemData.name || '';
    const firstName = extractFirstName(itemName);

    console.log(`👤 Item name: "${itemName}"`);
    console.log(`👋 Extracted first name: "${firstName}"`);

    // Update all three columns
    await updateMultipleColumns(itemId, {
      [COLUMNS.itemIdCopy]: itemId.toString(),
      [COLUMNS.fullName]: itemName,
      [COLUMNS.firstName]: firstName
    });

    console.log('✅ All columns updated successfully');

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        itemId,
        itemName,
        firstName,
        updates: {
          [COLUMNS.itemIdCopy]: itemId.toString(),
          [COLUMNS.fullName]: itemName,
          [COLUMNS.firstName]: firstName
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
// FIRST NAME EXTRACTION
// ============================================================================

/**
 * Extract first name from a full name string
 * "Mr Jonathan Wood - Ooosh Tours" → "Jonathan"
 * "Mrs Sarah Smith" → "Sarah"
 * "Acme Corp Ltd" → "Acme"
 */
function extractFirstName(fullName) {
  if (!fullName || typeof fullName !== 'string') {
    return '';
  }

  // Split by common separators first (handle "Name - Company" format)
  let namePart = fullName.split(/\s*[-–—|/]\s*/)[0].trim();
  
  // Split into words
  const words = namePart.split(/\s+/).filter(w => w.length > 0);
  
  if (words.length === 0) {
    return '';
  }

  // Check if first word is a prefix
  const firstWordLower = words[0].toLowerCase().replace(/[.,]/g, '');
  
  if (NAME_PREFIXES.includes(firstWordLower) && words.length > 1) {
    // Return second word (the actual first name)
    return words[1];
  }
  
  // Return first word
  return words[0];
}

// ============================================================================
// MONDAY.COM API HELPERS
// ============================================================================

async function fetchItemDetails(itemId) {
  const query = `
    query {
      items(ids: [${itemId}]) {
        id
        name
      }
    }
  `;

  const result = await callMondayAPI(query);
  return result.data?.items?.[0] || null;
}

async function updateMultipleColumns(itemId, columns) {
  const columnValues = {};
  
  for (const [columnId, value] of Object.entries(columns)) {
    columnValues[columnId] = value;
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

function escapeJson(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}