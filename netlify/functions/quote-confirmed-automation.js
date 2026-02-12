/**
 * quote-confirmed-automation.js
 * 
 * Webhook handler for Monday.com board 2431480012.
 * Triggers when status6 (Quote Status) changes to "Confirmed quote".
 * 
 * AUTOMATIONS:
 * 1. Last-minute alert: If hire date ≤ 3 days away, email info@oooshtours.co.uk
 * 2. Vehicle status: If dup__of_backline_ = "Vehicle":
 *    - If hire date ≤ 10 days away → set status8 = "Email now"
 *    - Otherwise → set status8 = "NEEDED"
 * 
 * WEBHOOK SETUP:
 * - Board: 2431480012
 * - Event: Column change
 * - Column: status6
 * - URL: https://ooosh-utilities.netlify.app/.netlify/functions/quote-confirmed-automation
 * 
 * v1.0 - Initial implementation
 */

const nodemailer = require('nodemailer');

// Board configuration
const BOARD_ID = 2431480012;
const TRIGGER_COLUMN = 'status6';
const TRIGGER_VALUE = 'Confirmed quote';

// Column IDs
const COLUMNS = {
  quoteStatus: 'status6',        // The trigger column
  hireStartDate: 'date',         // Hire start date
  jobNumber: 'text7',            // Job number (text)
  clientName: 'text6',           // Client name
  hirehopLink: 'link',           // HireHop job link
  itemType: 'dup__of_backline_', // "Vehicle" or other
  vehicleStatus: 'status8'       // Status to update for vehicles
};

// Thresholds (in days)
const LAST_MINUTE_THRESHOLD = 3;
const VEHICLE_EMAIL_NOW_THRESHOLD = 10;

// Email configuration
const ALERT_EMAIL = 'info@oooshtours.co.uk';

exports.handler = async (event) => {
  console.log('📋 Quote confirmed automation triggered');
  
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
    console.log('📨 Webhook payload received');

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
    if (columnId !== TRIGGER_COLUMN) {
      console.log(`⏭️ Ignoring change to column ${columnId} (not "${TRIGGER_COLUMN}")`);
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

    // Check if status6 is "Confirmed quote"
    const quoteStatus = getColumnText(itemData.column_values, COLUMNS.quoteStatus);
    console.log(`📊 Quote status: "${quoteStatus}"`);

    if (quoteStatus !== TRIGGER_VALUE) {
      console.log(`⏭️ Status is "${quoteStatus}", not "${TRIGGER_VALUE}" - skipping`);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ 
          message: 'Status not confirmed quote',
          currentStatus: quoteStatus
        })
      };
    }

    // Extract all needed data
    const jobNumber = getColumnText(itemData.column_values, COLUMNS.jobNumber);
    const clientName = getColumnText(itemData.column_values, COLUMNS.clientName);
    const hirehopLink = getLinkUrl(itemData.column_values, COLUMNS.hirehopLink);
    const hireStartDate = getColumnText(itemData.column_values, COLUMNS.hireStartDate);
    const itemType = getColumnText(itemData.column_values, COLUMNS.itemType);
    const itemName = itemData.name;

    console.log(`📋 Job details:
      - Item name: ${itemName}
      - Job number: ${jobNumber || '(not set)'}
      - Client: ${clientName || '(not set)'}
      - Hire date: ${hireStartDate || '(not set)'}
      - Item type: ${itemType || '(not set)'}
      - HireHop link: ${hirehopLink || '(not set)'}`);

    // Calculate days until hire
    const daysUntilHire = calculateDaysUntil(hireStartDate);
    console.log(`📅 Days until hire: ${daysUntilHire !== null ? daysUntilHire : 'unknown'}`);

    const actions = [];

    // ========================================
    // AUTOMATION 1: Last-minute email alert
    // ========================================
    if (daysUntilHire !== null && daysUntilHire <= LAST_MINUTE_THRESHOLD) {
      console.log(`🚨 Last-minute booking! (${daysUntilHire} days away, threshold: ${LAST_MINUTE_THRESHOLD})`);
      
      try {
        await sendLastMinuteEmail({
          itemName,
          jobNumber,
          clientName,
          hireStartDate,
          hirehopLink,
          daysUntilHire
        });
        actions.push('sent_last_minute_email');
        console.log('✅ Last-minute email sent');
      } catch (emailError) {
        console.error('❌ Failed to send last-minute email:', emailError.message);
        actions.push('email_failed');
      }
    }

    // ========================================
    // AUTOMATION 2: Vehicle status update
    // ========================================
    if (itemType === 'Vehicle') {
      console.log('🚚 Item is a Vehicle - checking status update needed');
      
      let newStatus;
      if (daysUntilHire !== null && daysUntilHire <= VEHICLE_EMAIL_NOW_THRESHOLD) {
        newStatus = 'Email now';
        console.log(`📧 Hire within ${VEHICLE_EMAIL_NOW_THRESHOLD} days - setting status8 to "Email now"`);
      } else {
        newStatus = 'NEEDED';
        console.log(`📋 Hire more than ${VEHICLE_EMAIL_NOW_THRESHOLD} days away - setting status8 to "NEEDED"`);
      }

      try {
        await updateColumnValue(itemId, COLUMNS.vehicleStatus, newStatus);
        actions.push(`set_status8_${newStatus.replace(/\s+/g, '_').toLowerCase()}`);
        console.log(`✅ Status8 set to "${newStatus}"`);
      } catch (updateError) {
        console.error('❌ Failed to update status8:', updateError.message);
        actions.push('status_update_failed');
      }
    } else {
      console.log(`⏭️ Item type is "${itemType || 'not set'}", not "Vehicle" - skipping status update`);
    }

    // Summary
    console.log(`✅ Automation complete. Actions taken: ${actions.length > 0 ? actions.join(', ') : 'none'}`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        itemId,
        itemName,
        jobNumber,
        clientName,
        hireStartDate,
        daysUntilHire,
        itemType,
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
// EMAIL FUNCTION
// ============================================================================

/**
 * Send last-minute booking alert email
 */
async function sendLastMinuteEmail({ itemName, jobNumber, clientName, hireStartDate, hirehopLink, daysUntilHire }) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });

  // Format the date nicely
  const formattedDate = formatDate(hireStartDate);
  
  // Build urgency indicator
  let urgencyText;
  if (daysUntilHire <= 0) {
    urgencyText = '🔴 TODAY';
  } else if (daysUntilHire === 1) {
    urgencyText = '🟠 TOMORROW';
  } else {
    urgencyText = `🟡 In ${daysUntilHire} days`;
  }

  // Build job link HTML
  const jobLinkHtml = hirehopLink 
    ? `<a href="${hirehopLink}" style="color: #2563eb; text-decoration: none; font-weight: 600;">Job ${jobNumber || 'link'}</a>`
    : `Job ${jobNumber || '(no number)'}`;

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
    </head>
    <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background-color: #f3f4f6; margin: 0; padding: 20px;">
      <div style="max-width: 600px; margin: 0 auto; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
        
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); padding: 24px; text-align: center;">
          <h1 style="color: white; margin: 0; font-size: 24px;">⚡ Last-Minute Booking</h1>
          <p style="color: rgba(255,255,255,0.9); margin: 8px 0 0 0; font-size: 16px;">${urgencyText}</p>
        </div>
        
        <!-- Content -->
        <div style="padding: 32px;">
          <p style="font-size: 16px; color: #374151; line-height: 1.6; margin: 0 0 24px 0;">
            Heads up! ${jobLinkHtml} for <strong>${clientName || 'a client'}</strong> has just been confirmed, starting on <strong>${formattedDate}</strong>.
          </p>
          
          <!-- Details Card -->
          <div style="background: #f9fafb; border-radius: 8px; padding: 20px; margin-bottom: 24px;">
            <table style="width: 100%; border-collapse: collapse;">
              <tr>
                <td style="padding: 8px 0; color: #6b7280; width: 120px;">Job:</td>
                <td style="padding: 8px 0; color: #111827; font-weight: 500;">${itemName || '-'}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280;">Job Number:</td>
                <td style="padding: 8px 0; color: #111827; font-weight: 500;">${jobNumber || '-'}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280;">Client:</td>
                <td style="padding: 8px 0; color: #111827; font-weight: 500;">${clientName || '-'}</td>
              </tr>
              <tr>
                <td style="padding: 8px 0; color: #6b7280;">Hire Date:</td>
                <td style="padding: 8px 0; color: #111827; font-weight: 500;">${formattedDate}</td>
              </tr>
            </table>
          </div>
          
          ${hirehopLink ? `
          <div style="text-align: center;">
            <a href="${hirehopLink}" style="display: inline-block; background: #2563eb; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600;">
              View in HireHop →
            </a>
          </div>
          ` : ''}
        </div>
        
        <!-- Footer -->
        <div style="background: #f9fafb; padding: 16px; text-align: center; border-top: 1px solid #e5e7eb;">
          <p style="margin: 0; color: #9ca3af; font-size: 12px;">
            (This is an automated alert)
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  await transporter.sendMail({
    from: `"OOOSH Alerts" <${process.env.SMTP_USER}>`,
    to: ALERT_EMAIL,
    subject: `⚡ Last-minute: Job ${jobNumber || ''} for ${clientName || 'client'} - starts ${formattedDate}`,
    html: html
  });
}

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
 * Update a status column value
 */
async function updateColumnValue(itemId, columnId, value) {
  const mutation = `
    mutation {
      change_simple_column_value (
        item_id: ${itemId},
        board_id: ${BOARD_ID},
        column_id: "${columnId}",
        value: "${value}"
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
 * Get text value from a column
 */
function getColumnText(columnValues, columnId) {
  const column = columnValues.find(col => col.id === columnId);
  return column?.text || null;
}

/**
 * Get the URL from a link column
 */
function getLinkUrl(columnValues, columnId) {
  const column = columnValues.find(col => col.id === columnId);
  if (!column) return null;
  
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
  
  return column.text || null;
}

/**
 * Calculate days until a date (0 = today, 1 = tomorrow, etc.)
 * Returns null if date is invalid
 */
function calculateDaysUntil(dateStr) {
  if (!dateStr) return null;
  
  try {
    const targetDate = new Date(dateStr);
    targetDate.setHours(0, 0, 0, 0);
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    const diffTime = targetDate.getTime() - today.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    
    return diffDays;
  } catch {
    return null;
  }
}

/**
 * Format a date string nicely
 */
function formatDate(dateStr) {
  if (!dateStr) return 'unknown date';
  
  try {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-GB', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric'
    });
  } catch {
    return dateStr;
  }
}