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
 * TIME-AWARE: Monitors elapsed time and stops gracefully before the 60s 
 * Netlify timeout, ensuring it always returns a valid cursor to continue.
 * 
 * USAGE:
 * - Dry run (preview only): 
 *   https://ooosh-utilities.netlify.app/.netlify/functions/bulk-date-migration
 * 
 * - Execute:
 *   https://ooosh-utilities.netlify.app/.netlify/functions/bulk-date-migration?execute=true
 * 
 * - Continue from cursor (auto-provided in response):
 *   https://ooosh-utilities.netlify.app/.netlify/functions/bulk-date-migration?execute=true&cursor=XXXXX
 * 
 * IMPORTANT: Wait for each run to complete before starting the next!
 * 
 * DELETE THIS FUNCTION AFTER USE - it's not needed ongoing.
 * 
 * v1.0 - Initial implementation
 * v1.1 - Chunked approach to handle large boards
 * v1.2 - Time-aware processing to avoid timeouts
 */

// Board configuration
const BOARD_ID = 2431480012;
const SOURCE_DATE_COLUMN = 'dup__of_hire_starts';  // Where dates currently live
const TARGET_DATE_COLUMN = 'date_mkzzmse7';        // Where we're copying TO
const VEHICLE_STATUS_COLUMN = 'dup__of_vehicle_';  // Rehearsal status
const REHEARSAL_LABEL = 'Rehearsal';

// Time management - stop before Netlify's 60s timeout
const MAX_EXECUTION_MS = 50000;  // Stop after 50 seconds to leave buffer
const ITEMS_PER_FETCH = 100;     // Fetch 100 items at a time
const DELAY_BETWEEN_UPDATES = 50; // 50ms between updates

exports.handler = async (event) => {
  console.log('🔄 Bulk date migration initiated (time-aware mode)');
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
  const startCursor = params.cursor || null;

  // Helper to check if we're running low on time
  const isTimeRunningOut = () => (Date.now() - startTime) > MAX_EXECUTION_MS;
  const getElapsed = () => Date.now() - startTime;

  try {
    // Track overall progress
    const progress = {
      itemsFetched: 0,
      itemsAnalyzed: 0,
      updatesNeeded: 0,
      updatesCompleted: 0,
      updatesFailed: 0,
      alreadyCorrect: 0,
      skipped: 0,
      stoppedEarly: false,
      failures: []
    };

    let currentCursor = startCursor;
    let lastProcessedCursor = startCursor;

    // Keep fetching and processing until time runs out or no more items
    while (!isTimeRunningOut()) {
      console.log(`📋 Fetching items... (elapsed: ${getElapsed()}ms)`);
      
      const { items, nextCursor } = await fetchItemsChunk(currentCursor);
      progress.itemsFetched += items.length;
      
      console.log(`📊 Fetched ${items.length} items`);

      if (items.length === 0) {
        // No more items - we're done!
        console.log('✅ No more items to process - migration complete!');
        break;
      }

      // Process this batch
      for (const item of items) {
        // Check time before each item
        if (isTimeRunningOut()) {
          console.log(`⏰ Time limit approaching - stopping gracefully (elapsed: ${getElapsed()}ms)`);
          progress.stoppedEarly = true;
          break;
        }

        progress.itemsAnalyzed++;

        const sourceDate = getColumnValue(item.column_values, SOURCE_DATE_COLUMN);
        const currentTargetDate = getColumnValue(item.column_values, TARGET_DATE_COLUMN);
        const vehicleStatus = getStatusLabel(item.column_values, VEHICLE_STATUS_COLUMN);
        const isRehearsal = vehicleStatus === REHEARSAL_LABEL;

        // Skip if no source date
        if (!sourceDate) {
          progress.skipped++;
          continue;
        }

        // Calculate target date
        const calculatedTargetDate = isRehearsal ? sourceDate : addOneDay(sourceDate);

        // Skip if already correct
        if (currentTargetDate === calculatedTargetDate) {
          progress.alreadyCorrect++;
          continue;
        }

        progress.updatesNeeded++;

        // If dry run, don't actually update
        if (!executeForReal) {
          continue;
        }

        // Perform the update
        try {
          await updateDateColumn(item.id, TARGET_DATE_COLUMN, calculatedTargetDate);
          progress.updatesCompleted++;
          console.log(`  ✅ ${item.id}: ${sourceDate} → ${calculatedTargetDate}`);
          
          // Small delay between updates
          await sleep(DELAY_BETWEEN_UPDATES);
        } catch (error) {
          progress.updatesFailed++;
          progress.failures.push({ itemId: item.id, name: item.name, error: error.message });
          console.log(`  ❌ ${item.id}: ${error.message}`);
        }
      }

      // If we stopped early due to time, don't move to next cursor
      if (progress.stoppedEarly) {
        break;
      }

      // Move to next page
      lastProcessedCursor = nextCursor;
      currentCursor = nextCursor;

      // If no more pages, we're done
      if (!nextCursor) {
        console.log('✅ Reached end of items - migration complete!');
        break;
      }
    }

    // Check if we ran out of time before finishing this batch
    if (isTimeRunningOut() && !progress.stoppedEarly) {
      progress.stoppedEarly = true;
    }

    const duration = Date.now() - startTime;
    const isComplete = !progress.stoppedEarly && !lastProcessedCursor;

    console.log(`📊 Run complete: ${progress.updatesCompleted} updated, ${duration}ms elapsed`);

    // Build response
    const response = {
      mode: executeForReal ? 'EXECUTED' : 'DRY RUN',
      status: isComplete 
        ? '🎉 COMPLETE - All items processed!' 
        : '⏳ MORE TO DO - Run the nextFullUrl to continue',
      progress: {
        itemsFetched: progress.itemsFetched,
        itemsAnalyzed: progress.itemsAnalyzed,
        updatesNeeded: progress.updatesNeeded,
        updatesCompleted: executeForReal ? progress.updatesCompleted : '(dry run)',
        updatesFailed: progress.updatesFailed,
        alreadyCorrect: progress.alreadyCorrect,
        skippedNoDate: progress.skipped,
        durationMs: duration,
        stoppedDueToTime: progress.stoppedEarly
      },
      isComplete,
      nextCursor: isComplete ? null : lastProcessedCursor,
      nextFullUrl: isComplete 
        ? null 
        : `https://ooosh-utilities.netlify.app/.netlify/functions/bulk-date-migration?execute=true&cursor=${encodeURIComponent(lastProcessedCursor || '')}`,
      failures: progress.failures.length > 0 ? progress.failures : undefined,
      instruction: isComplete 
        ? 'Migration complete! You can now delete this function from your repo.'
        : executeForReal
          ? '👆 Copy the nextFullUrl above and paste it in your browser. WAIT for it to complete before running again!'
          : 'Add ?execute=true to the URL to run for real.'
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(response, null, 2)
    };

  } catch (error) {
    console.error('❌ Migration error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: error.message,
        elapsed: Date.now() - startTime,
        tip: 'Try running again - might be a temporary Monday.com issue'
      })
    };
  }
};

// ============================================================================
// MONDAY.COM API HELPERS
// ============================================================================

async function fetchItemsChunk(cursor) {
  let query;
  
  if (cursor) {
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
