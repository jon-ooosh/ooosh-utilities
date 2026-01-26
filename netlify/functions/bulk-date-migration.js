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
 * USAGE:
 * - Dry run (preview only): 
 *   https://ooosh-utilities.netlify.app/.netlify/functions/bulk-date-migration
 * 
 * - Actually run the migration:
 *   https://ooosh-utilities.netlify.app/.netlify/functions/bulk-date-migration?execute=true
 * 
 * DELETE THIS FUNCTION AFTER USE - it's not needed ongoing.
 * 
 * v1.0 - Initial implementation
 */

// Board configuration
const BOARD_ID = 2431480012;
const SOURCE_DATE_COLUMN = 'dup__of_hire_starts';  // Where dates currently live
const TARGET_DATE_COLUMN = 'date_mkzzmse7';        // Where we're copying TO
const VEHICLE_STATUS_COLUMN = 'dup__of_vehicle_';  // Rehearsal status
const REHEARSAL_LABEL = 'Rehearsal';

// Rate limiting - Monday.com allows ~50 requests per minute for mutations
const BATCH_SIZE = 25;           // Items to update per batch
const DELAY_BETWEEN_BATCHES = 2000;  // 2 seconds between batches

exports.handler = async (event) => {
  console.log('🔄 Bulk date migration initiated');
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

  // Check if this is a dry run or actual execution
  const params = event.queryStringParameters || {};
  const executeForReal = params.execute === 'true';

  try {
    // Step 1: Fetch all items from the board
    console.log('📋 Fetching all items from board...');
    const allItems = await fetchAllItems();
    console.log(`📊 Found ${allItems.length} items total`);

    // Step 2: Analyze each item and determine what needs updating
    const analysis = {
      totalItems: allItems.length,
      itemsWithSourceDate: 0,
      itemsNeedingUpdate: 0,
      itemsAlreadyCorrect: 0,
      itemsSkipped: 0,
      rehearsals: 0,
      nonRehearsals: 0,
      updates: [],
      skipped: [],
      errors: []
    };

    for (const item of allItems) {
      try {
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
          calculatedTargetDate = sourceDate;  // Copy as-is
          analysis.rehearsals++;
        } else {
          calculatedTargetDate = addOneDay(sourceDate);  // Add one day
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

      } catch (itemError) {
        analysis.errors.push({
          itemId: item.id,
          name: item.name,
          error: itemError.message
        });
      }
    }

    // Step 3: If this is a dry run, just return the analysis
    if (!executeForReal) {
      console.log('🔍 Dry run complete - no changes made');
      
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          mode: 'DRY RUN - No changes made',
          instruction: 'Add ?execute=true to URL to actually run the migration',
          summary: {
            totalItems: analysis.totalItems,
            itemsWithSourceDate: analysis.itemsWithSourceDate,
            itemsNeedingUpdate: analysis.itemsNeedingUpdate,
            itemsAlreadyCorrect: analysis.itemsAlreadyCorrect,
            itemsSkipped: analysis.itemsSkipped,
            rehearsals: analysis.rehearsals,
            nonRehearsals: analysis.nonRehearsals,
            errors: analysis.errors.length
          },
          // Show first 50 updates as preview
          updatePreview: analysis.updates.slice(0, 50),
          totalUpdatesQueued: analysis.updates.length,
          skipped: analysis.skipped.slice(0, 20),
          errors: analysis.errors
        }, null, 2)
      };
    }

    // Step 4: Execute the updates in batches
    console.log(`🚀 Executing ${analysis.updates.length} updates...`);
    
    let successCount = 0;
    let failCount = 0;
    const failedUpdates = [];

    // Process in batches
    for (let i = 0; i < analysis.updates.length; i += BATCH_SIZE) {
      const batch = analysis.updates.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(analysis.updates.length / BATCH_SIZE);
      
      console.log(`📦 Processing batch ${batchNumber}/${totalBatches} (${batch.length} items)...`);

      // Process each item in the batch
      for (const update of batch) {
        try {
          await updateDateColumn(update.itemId, TARGET_DATE_COLUMN, update.newTargetDate);
          successCount++;
          console.log(`  ✅ Updated item ${update.itemId}: ${update.sourceDate} → ${update.newTargetDate}`);
        } catch (updateError) {
          failCount++;
          failedUpdates.push({
            itemId: update.itemId,
            name: update.name,
            error: updateError.message
          });
          console.log(`  ❌ Failed item ${update.itemId}: ${updateError.message}`);
        }
      }

      // Delay between batches (except for the last one)
      if (i + BATCH_SIZE < analysis.updates.length) {
        console.log(`  ⏳ Waiting ${DELAY_BETWEEN_BATCHES}ms before next batch...`);
        await sleep(DELAY_BETWEEN_BATCHES);
      }
    }

    const duration = Date.now() - startTime;
    console.log(`✅ Migration complete: ${successCount} updated, ${failCount} failed, took ${duration}ms`);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        mode: 'EXECUTED',
        summary: {
          totalItems: analysis.totalItems,
          itemsProcessed: analysis.updates.length,
          successfulUpdates: successCount,
          failedUpdates: failCount,
          itemsAlreadyCorrect: analysis.itemsAlreadyCorrect,
          itemsSkipped: analysis.itemsSkipped,
          durationMs: duration
        },
        failures: failedUpdates,
        message: failCount === 0 
          ? '🎉 All updates completed successfully!' 
          : `⚠️ ${failCount} items failed - see failures array for details`
      }, null, 2)
    };

  } catch (error) {
    console.error('❌ Migration error:', error);
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
 * Fetch ALL items from the board using cursor-based pagination
 */
async function fetchAllItems() {
  const allItems = [];
  let cursor = null;
  let pageCount = 0;

  do {
    pageCount++;
    console.log(`  📄 Fetching page ${pageCount}...`);

    const query = cursor
      ? `query {
          next_items_page(cursor: "${cursor}", limit: 100) {
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
        }`
      : `query {
          boards(ids: [${BOARD_ID}]) {
            items_page(limit: 100) {
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

    const result = await callMondayAPI(query);

    let items, newCursor;

    if (cursor) {
      // Subsequent pages use next_items_page
      items = result.data?.next_items_page?.items || [];
      newCursor = result.data?.next_items_page?.cursor;
    } else {
      // First page uses boards.items_page
      items = result.data?.boards?.[0]?.items_page?.items || [];
      newCursor = result.data?.boards?.[0]?.items_page?.cursor;
    }

    allItems.push(...items);
    cursor = newCursor;

    console.log(`    Found ${items.length} items (total: ${allItems.length})`);

  } while (cursor);

  return allItems;
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

/**
 * Get the date value from a column by ID
 */
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

/**
 * Get the status label from a status column
 */
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

/**
 * Add one day to a date string (YYYY-MM-DD format)
 */
function addOneDay(dateString) {
  const date = new Date(dateString + 'T12:00:00Z');
  date.setUTCDate(date.getUTCDate() + 1);
  
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

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}