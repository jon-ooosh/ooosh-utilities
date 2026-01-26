/**
 * bulk-date-migration.js
 * 
 * ONE-TIME USE: Bulk migration script to back-populate date_mkzzmse7 
 * from existing dup__of_hire_starts values.
 * 
 * This is the REVERSE of the ongoing automation:
 * - If "Rehearsal" → copy date as-is
 * - Otherwise → copy date PLUS one day
 * 
 * CHUNKED APPROACH: Processes 200 items per run to avoid Netlify's 60s timeout.
 * Run multiple times until it reports "COMPLETE".
 * 
 * USAGE:
 * - Dry run (preview only): 
 *   https://ooosh-utilities.netlify.app/.netlify/functions/bulk-date-migration
 * 
 * - Execute one chunk:
 *   https://ooosh-utilities.netlify.app/.netlify/functions/bulk-date-migration?execute=true
 * 
 * - Continue from specific cursor (auto-provided in response):
 *   https://ooosh-utilities.netlify.app/.netlify/functions/bulk-date-migration?execute=true&cursor=XXXXX
 * 
 * DELETE THIS FUNCTION AFTER USE - it's not needed ongoing.
 * 
 * v1.0 - Initial implementation
 * v1.1 - Chunked approach to handle large boards
 */

// Board configuration
const BOARD_ID = 2431480012;
const SOURCE_DATE_COLUMN = 'dup__of_hire_starts';  // Where dates currently live
const TARGET_DATE_COLUMN = 'date_mkzzmse7';        // Where we're copying TO
const VEHICLE_STATUS_COLUMN = 'dup__of_vehicle_';  // Rehearsal status
const REHEARSAL_LABEL = 'Rehearsal';

// Chunking configuration - keep well under 60s timeout
const ITEMS_PER_FETCH = 200;     // Items to fetch from Monday.com per run
const DELAY_BETWEEN_UPDATES = 100;  // 100ms between updates (rate limiting)

exports.handler = async (event) => {
  console.log('🔄 Bulk date migration initiated (chunked mode)');
  const startTime = Date.now();
  
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  // Check parameters
  const params = event.queryStringParameters || {};
  const executeForReal = params.execute === 'true';
  const startCursor = params.cursor || null;  // Resume from this cursor

  try {
    // Step 1: Fetch ONE chunk of items
    console.log(`📋 Fetching up to ${ITEMS_PER_FETCH} items...`);
    const { items, nextCursor } = await fetchItemsChunk(startCursor);
    console.log(`📊 Fetched ${items.length} items`);

    // Step 2: Analyze this chunk
    const analysis = {
      itemsFetched: items.length,
      itemsWithSourceDate: 0,
      itemsNeedingUpdate: 0,
      itemsAlreadyCorrect: 0,
      itemsSkipped: 0,
      rehearsals: 0,
      nonRehearsals: 0,
      updates: [],
      skipped: []
    };

    for (const item of items) {
      const sourceDate = getColumnValue(item.column_values, SOURCE_DATE_COLUMN);
      const currentTargetDate = getColumnValue(item.column_values, TARGET_DATE_COLUMN);
      const vehicleStatus = getStatusLabel(item.column_values, VEHICLE_STATUS_COLUMN);
      const isRehearsal = vehicleStatus === REHEARSAL_LABEL;

      // Skip if no source date
      if (!sourceDate) {
        analysis.skipped.push({
          itemId: item.id,
          name: item.name,
          reason: 'No source date set'
        });
        analysis.itemsSkipped++;
        continue;
      }

      analysis.itemsWithSourceDate++;

      // Calculate what the target date should be
      let calculatedTargetDate;
      if (isRehearsal) {
        calculatedTargetDate = sourceDate;
        analysis.rehearsals++;
      } else {
        calculatedTargetDate = addOneDay(sourceDate);
        analysis.nonRehearsals++;
      }

      // Check if update is needed
      if (currentTargetDate === calculatedTargetDate) {
        analysis.itemsAlreadyCorrect++;
        continue;
      }

      // Record the update needed
      analysis.itemsNeedingUpdate++;
      analysis.updates.push({
        itemId: item.id,
        name: item.name,
        sourceDate,
        currentTargetDate: currentTargetDate || '(empty)',
        newTargetDate: calculatedTargetDate,
        isRehearsal,
        rule: isRehearsal ? 'copy-as-is' : 'plus-one-day'
      });
    }

    // Step 3: If dry run, just return analysis
    if (!executeForReal) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          mode: 'DRY RUN - No changes made',
          instruction: 'Add ?execute=true to URL to run this chunk',
          chunk: {
            itemsFetched: analysis.itemsFetched,
            itemsNeedingUpdate: analysis.itemsNeedingUpdate,
            itemsAlreadyCorrect: analysis.itemsAlreadyCorrect,
            itemsSkipped: analysis.itemsSkipped,
            hasMoreItems: !!nextCursor
          },
          updatePreview: analysis.updates.slice(0, 20),
          nextCursor: nextCursor || null,
          nextUrl: nextCursor 
            ? `?execute=true&cursor=${encodeURIComponent(nextCursor)}`
            : null
        }, null, 2)
      };
    }

    // Step 4: Execute updates for this chunk
    console.log(`🚀 Executing ${analysis.updates.length} updates...`);
    
    let successCount = 0;
    let failCount = 0;
    const failures = [];

    for (const update of analysis.updates) {
      try {
        await updateDateColumn(update.itemId, TARGET_DATE_COLUMN, update.newTargetDate);
        successCount++;
        console.log(`  ✅ ${update.itemId}: ${update.sourceDate} → ${update.newTargetDate}`);
        
        // Small delay between updates
        if (analysis.updates.indexOf(update) < analysis.updates.length - 1) {
          await sleep(DELAY_BETWEEN_UPDATES);
        }
      } catch (error) {
        failCount++;
        failures.push({ itemId: update.itemId, name: update.name, error: error.message });
        console.log(`  ❌ ${update.itemId}: ${error.message}`);
      }
    }

    const duration = Date.now() - startTime;
    const isComplete = !nextCursor;

    console.log(`✅ Chunk complete: ${successCount} updated, ${failCount} failed, ${duration}ms`);

    // Build next URL for convenience
    const nextUrl = nextCursor 
      ? `?execute=true&cursor=${encodeURIComponent(nextCursor)}`
      : null;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        mode: 'EXECUTED',
        status: isComplete ? '🎉 COMPLETE - All items processed!' : '⏳ MORE TO DO - Run again with cursor',
        chunk: {
          itemsFetched: analysis.itemsFetched,
          updatesAttempted: analysis.updates.length,
          successful: successCount,
          failed: failCount,
          alreadyCorrect: analysis.itemsAlreadyCorrect,
          skipped: analysis.itemsSkipped,
          durationMs: duration
        },
        hasMoreItems: !isComplete,
        nextCursor: nextCursor || null,
        nextUrl: nextUrl,
        nextFullUrl: nextUrl 
          ? `https://ooosh-utilities.netlify.app/.netlify/functions/bulk-date-migration${nextUrl}`
          : null,
        failures: failures.length > 0 ? failures : undefined,
        instruction: isComplete 
          ? 'Migration complete! You can now delete this function.'
          : 'Copy the nextFullUrl and paste it in your browser to continue.'
      }, null, 2)
    };

  } catch (error) {
    console.error('❌ Migration error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: error.message,
        tip: 'If this keeps happening, try again - might be a temporary Monday.com issue'
      })
    };
  }
};

// ============================================================================
// MONDAY.COM API HELPERS
// ============================================================================

/**
 * Fetch a chunk of items from the board
 */
async function fetchItemsChunk(cursor) {
  let query;
  
  if (cursor) {
    // Continue from cursor
    query = `query {
      next_items_page(cursor: "${cursor}", limit: ${ITEMS_PER_FETCH}) {
        cursor
        items {
          id
          name
          column_values {
            id
            text
            value
          }
        }
      }
    }`;
  } else {
    // First page
    query = `query {
      boards(ids: [${BOARD_ID}]) {
        items_page(limit: ${ITEMS_PER_FETCH}) {
          cursor
          items {
            id
            name
            column_values {
              id
              text
              value
            }
          }
        }
      }
    }`;
  }

  const result = await callMondayAPI(query);

  if (cursor) {
    return {
      items: result.data?.next_items_page?.items || [],
      nextCursor: result.data?.next_items_page?.cursor || null
    };
  } else {
    return {
      items: result.data?.boards?.[0]?.items_page?.items || [],
      nextCursor: result.data?.boards?.[0]?.items_page?.cursor || null
    };
  }
}

/**
 * Update a date column on an item
 */
async function updateDateColumn(itemId, columnId, dateValue) {
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

function getColumnValue(columnValues, columnId) {
  const column = columnValues.find(col => col.id === columnId);
  if (!column) return null;
  
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

function getStatusLabel(columnValues, columnId) {
  const column = columnValues.find(col => col.id === columnId);
  if (!column) return null;
  
  if (column.value) {
    try {
      const parsed = JSON.parse(column.value);
      if (parsed.label) {
        return parsed.label;
      }
      if (parsed.index !== undefined) {
        return column.text || null;
      }
    } catch (e) {
      // Fall back to text
    }
  }
  
  return column.text || null;
}

function addOneDay(dateString) {
  const date = new Date(dateString + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + 1);
  
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  
  return `${year}-${month}-${day}`;
}

function escapeJson(str) {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}