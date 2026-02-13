/**
 * address-book-updates.js
 * 
 * Webhook handler for Monday.com board 2431071567 (Client Address Book).
 * Handles column changes for: name, email_1, link_to_duplicate_of_incoming___pending_enquiries
 * 
 * ACTIONS BY COLUMN:
 * - name: Extract first name → text, copy name → text_14, sync to linked Q&H items (text6)
 * - email_1: Sync to linked Q&H items (text1)
 * - link_to_duplicate_of_incoming___pending_enquiries: Set date4 to today
 * 
 * WEBHOOK SETUP:
 * - Board: 2431071567
 * - Event: Column change
 * - Columns: name, email_1, link_to_duplicate_of_incoming___pending_enquiries (3 separate webhooks)
 * - URL: https://ooosh-utilities.netlify.app/.netlify/functions/address-book-updates
 * 
 * v1.0 - Initial implementation
 */

// Board configuration
const ADDRESS_BOOK_BOARD_ID = 2431071567;
const QH_BOARD_ID = 2431480012;

// Column IDs - Address Book
const AB_COLUMNS = {
  fullName: 'text_14',
  firstName: 'text',
  email: 'email_1',
  linkedQH: 'link_to_duplicate_of_incoming___pending_enquiries',
  lastContactDate: 'date4'
};

// Column IDs - Quotes & Hires (targets for syncing)
const QH_COLUMNS = {
  clientName: 'text6',
  clientEmail: 'text1'
};

// Monitored columns (undefined = item name change, which Monday sends without a columnId)
const MONITORED_COLUMNS = ['name', undefined, AB_COLUMNS.email, AB_COLUMNS.linkedQH];

// Prefixes to remove when extracting first name
const NAME_PREFIXES = ['mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'lady', 'rev', 'mx'];

exports.handler = async (event) => {
  console.log('📇 Address book update automation triggered');
  
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

    // Verify correct board
    if (boardId && boardId !== ADDRESS_BOOK_BOARD_ID) {
      console.log(`⏭️ Ignoring event from board ${boardId}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Board not monitored' })
      };
    }

    // Verify column is one we care about
    // Note: Item name changes come through with columnId = undefined
    const isNameChange = columnId === undefined || columnId === 'name';
    
    if (!isNameChange && !MONITORED_COLUMNS.includes(columnId)) {
      console.log(`⏭️ Ignoring change to column ${columnId}`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Column not monitored' })
      };
    }

    // Fetch item details
    const itemData = await fetchItemDetails(itemId);
    
    if (!itemData) {
      console.error('❌ Could not fetch item details');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch item details' })
      };
    }

    const actions = [];

    // ========================================
    // HANDLE: Item name changed
    // ========================================
      if (columnId === 'name' || columnId === undefined) {
      const itemName = itemData.name || '';
      const firstName = extractFirstName(itemName);

      console.log(`👤 Name changed to: "${itemName}"`);
      console.log(`👋 Extracted first name: "${firstName}"`);

      // Update local columns
      await updateMultipleColumns(ADDRESS_BOOK_BOARD_ID, itemId, {
        [AB_COLUMNS.fullName]: itemName,
        [AB_COLUMNS.firstName]: firstName
      });
      actions.push('updated_name_columns');

      // Sync to linked Q&H items
      // Debug: Log the raw connected column value
      const linkedColumn = itemData.column_values.find(col => col.id === AB_COLUMNS.linkedQH);
      console.log(`🔍 DEBUG - Connected column ID: ${AB_COLUMNS.linkedQH}`);
      console.log(`🔍 DEBUG - Connected column raw value: ${linkedColumn?.value || '(null)'}`);
      console.log(`🔍 DEBUG - Connected column text: ${linkedColumn?.text || '(null)'}`);

      // Sync to linked Q&H items
      const linkedQHIds = getLinkedItemIds(itemData.column_values, AB_COLUMNS.linkedQH);
      console.log(`🔗 Found ${linkedQHIds.length} linked Q&H items`);

      for (const qhItemId of linkedQHIds) {
        await updateMultipleColumns(QH_BOARD_ID, qhItemId, {
          [QH_COLUMNS.clientName]: itemName
        });
        console.log(`✅ Synced name to Q&H item ${qhItemId}`);
      }
      
      if (linkedQHIds.length > 0) {
        actions.push(`synced_name_to_${linkedQHIds.length}_qh_items`);
      }
    }

    // ========================================
    // HANDLE: Email changed
    // ========================================
   if (columnId === AB_COLUMNS.email) {
      const email = getColumnText(itemData.column_values, AB_COLUMNS.email);
      console.log(`📧 Email changed to: "${email || '(empty)'}"`);

      // Debug: Log the raw connected column value
      const linkedColumn = itemData.column_values.find(col => col.id === AB_COLUMNS.linkedQH);
      console.log(`🔍 DEBUG - Connected column ID: ${AB_COLUMNS.linkedQH}`);
      console.log(`🔍 DEBUG - Connected column raw value: ${linkedColumn?.value || '(null)'}`);
      console.log(`🔍 DEBUG - Connected column text: ${linkedColumn?.text || '(null)'}`);

      // Sync to linked Q&H items
      const linkedQHIds = getLinkedItemIds(itemData.column_values, AB_COLUMNS.linkedQH);
      console.log(`🔗 Found ${linkedQHIds.length} linked Q&H items`);

      for (const qhItemId of linkedQHIds) {
        await updateMultipleColumns(QH_BOARD_ID, qhItemId, {
          [QH_COLUMNS.clientEmail]: email || ''
        });
        console.log(`✅ Synced email to Q&H item ${qhItemId}`);
      }
      
      if (linkedQHIds.length > 0) {
        actions.push(`synced_email_to_${linkedQHIds.length}_qh_items`);
      }
    }

    // ========================================
    // HANDLE: Linked Q&H column changed (client contacted)
    // ========================================
    if (columnId === AB_COLUMNS.linkedQH) {
      const today = new Date().toISOString().split('T')[0];
      console.log(`📅 Setting last contact date to: ${today}`);

      await updateDateColumn(ADDRESS_BOOK_BOARD_ID, itemId, AB_COLUMNS.lastContactDate, today);
      actions.push('updated_last_contact_date');
    }

    console.log(`✅ Automation complete. Actions: ${actions.length > 0 ? actions.join(', ') : 'none'}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        itemId,
        columnId,
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
// FIRST NAME EXTRACTION
// ============================================================================

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
    return words[1];
  }
  
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

async function updateMultipleColumns(boardId, itemId, columns) {
  const columnValues = {};
  
  for (const [columnId, value] of Object.entries(columns)) {
    // Email columns need special format: { email: "...", text: "..." }
    // text1 is the client email column on Q&H board
    if (columnId === QH_COLUMNS.clientEmail && value) {
      columnValues[columnId] = { email: value, text: value };
    } else {
      columnValues[columnId] = value;
    }
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

async function updateDateColumn(boardId, itemId, columnId, dateValue) {
  // Date columns need the JSON format via change_multiple_column_values
  const columnValues = {
    [columnId]: { date: dateValue }
  };

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

/**
 * Get linked item IDs from a connect_boards column
 */
function getLinkedItemIds(columnValues, columnId) {
  const column = columnValues.find(col => col.id === columnId);
  if (!column || !column.value) return [];
  
  try {
    const parsed = JSON.parse(column.value);
    // Connect boards columns store linked IDs in linkedPulseIds array
    if (parsed.linkedPulseIds && Array.isArray(parsed.linkedPulseIds)) {
      return parsed.linkedPulseIds.map(item => item.linkedPulseId);
    }
  } catch (e) {
    console.error('Error parsing linked items:', e);
  }
  
  return [];
}

function escapeJson(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}