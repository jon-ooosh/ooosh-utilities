/**
 * crew-email-copy.js
 * 
 * Webhook handler for Monday.com Crewed Jobs board (18398014629).
 * When a freelancer is connected via the board relation column, this fetches
 * their email from the Freelance Crew board and copies it into a text column.
 * 
 * This replaces a General Caster automation that copied mirrored email data.
 * 
 * TRIGGER:
 * When "board_relation_mm09gh84" changes → look up connected freelancer →
 * fetch their email → write to text column
 * 
 * BOARDS:
 * - Crewed Jobs (18398014629): Main board with the connect column
 * - Freelance Crew (3463379885): Source board with email addresses
 * 
 * COLUMNS:
 * - board_relation_mm09gh84: Connect column (links to Freelance Crew)
 * - text_mm09da3v: Text column where email gets written
 * - email: Email column on Freelance Crew board
 * 
 * Webhook setup in Monday.com:
 * 1. Go to Crewed Jobs Board > Integrations > Webhooks
 * 2. Create webhook for "When column changes":
 *    - Column = board_relation_mm09gh84
 * 3. URL: https://ooosh-utilities.netlify.app/.netlify/functions/crew-email-copy
 * 
 * v1.0 - Initial implementation
 */

// Board configuration
const CREWED_JOBS_BOARD_ID = 18398014629;
const FREELANCE_CREW_BOARD_ID = 3463379885;
const CONNECT_COLUMN = 'board_relation_mm09gh84';  // Links to freelancer
const TARGET_TEXT_COLUMN = 'text_mm09da3v';        // Where we write the email
const SOURCE_EMAIL_COLUMN = 'email';               // Email column on Freelance Crew board

// Retry configuration (matching other functions in this repo)
const RETRY_CONFIG = {
  maxAttempts: 3,
  baseDelayMs: 1000,
  retryableErrors: ['ETIMEDOUT', 'ECONNRESET', 'rate limit', 'timeout', '429', '500', '502', '503', '504']
};

exports.handler = async (event) => {
  console.log('📧 Crew email copy automation triggered');
  
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
    if (columnId !== CONNECT_COLUMN) {
      console.log(`⏭️ Ignoring change to column ${columnId} (not "${CONNECT_COLUMN}")`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Column not monitored', columnId })
      };
    }

    // Verify this is the correct board
    if (boardId && boardId !== CREWED_JOBS_BOARD_ID) {
      console.log(`⏭️ Ignoring event from board ${boardId} (not ${CREWED_JOBS_BOARD_ID})`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Board not monitored', boardId })
      };
    }

    // Extract connected freelancer ID(s) directly from the webhook payload
    // The webhook value contains linkedPulseIds when a connection exists
    const webhookValue = webhookEvent.value || {};
    const linkedPulses = webhookValue.linkedPulseIds || [];
    const connectedIds = linkedPulses.map(item => item.linkedPulseId);
    console.log(`🔗 Connected freelancer IDs: ${connectedIds.length > 0 ? connectedIds.join(', ') : '(none)'}`);

    // If connection was removed (no linked items), clear the email field
    if (connectedIds.length === 0) {
      console.log('⏭️ No freelancer connected - clearing email field');
      await updateTextColumn(itemId, TARGET_TEXT_COLUMN, '');
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          success: true,
          message: 'Connection removed - email field cleared',
          itemId
        })
      };
    }

    // Use the first connected item (single connection mode)
    const freelancerId = connectedIds[0];
    console.log(`👤 Looking up freelancer ${freelancerId} on Crew board...`);

    // Fetch the freelancer's details from the Freelance Crew board
    const freelancerData = await fetchItemDetails(freelancerId, FREELANCE_CREW_BOARD_ID);
    
    if (!freelancerData) {
      console.error(`❌ Could not fetch freelancer ${freelancerId} details`);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch freelancer details' })
      };
    }

    // Extract the email from the freelancer's record
    const email = getEmailValue(freelancerData.column_values, SOURCE_EMAIL_COLUMN);
    console.log(`📧 Freelancer email: ${email || '(not set)'}`);
    console.log(`👤 Freelancer name: ${freelancerData.name}`);

    // Write the email to the text column on the Crewed Jobs item
    await updateTextColumn(itemId, TARGET_TEXT_COLUMN, email || '');

    console.log('✅ Email copied successfully');
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        itemId,
        freelancerId,
        freelancerName: freelancerData.name,
        email: email || '(not set)',
        targetColumn: TARGET_TEXT_COLUMN
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
 * Works for items on any board
 */
async function fetchItemDetails(itemId, boardId) {
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
 * Update a text column on a Crewed Jobs item
 */
async function updateTextColumn(itemId, columnId, textValue) {
  const columnValues = {
    [columnId]: textValue
  };

  const mutation = `
    mutation {
      change_multiple_column_values (
        item_id: ${itemId},
        board_id: ${CREWED_JOBS_BOARD_ID},
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
 * Get the email value from an email column
 */
function getEmailValue(columnValues, columnId) {
  const column = columnValues.find(col => col.id === columnId);
  if (!column) return null;
  
  // Email columns store data as { "email": "...", "text": "..." }
  if (column.value) {
    try {
      const parsed = JSON.parse(column.value);
      if (parsed.email) {
        return parsed.email;
      }
    } catch (e) {
      // Fall back to text
    }
  }
  
  // The text field often has the email too
  return column.text || null;
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
