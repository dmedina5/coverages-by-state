const mysql = require('mysql2/promise');
const fs = require('fs').promises;
const crypto = require('crypto');
const https = require('https');

// Configuration from environment
// Password is base64 encoded to preserve special characters
const decodedPassword = Buffer.from(process.env.DB_PASSWORD, 'base64').toString('utf-8');

const DB_CONFIG = {
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER,
  password: decodedPassword,
  database: process.env.DB_NAME,
  connectTimeout: 30000,
  ssl: { rejectUnauthorized: false }
};

// Slack configuration
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;  // General channel
const SLACK_APPROVAL_WEBHOOK_URL = process.env.SLACK_APPROVAL_WEBHOOK_URL;  // Daniel's DM for approval
const TOOL_URL = 'https://dmedina5.github.io/coverages-by-state/';
const APPROVED_MODE = process.env.APPROVED === 'true';  // Set via workflow_dispatch to send to general channel

const COMPANY_ID_MAPPING = {
  5245: "Accredited Non-Admitted 1st",
  6607: "Accredited Non-Admitted New",
  5696: "Ascot Non-Admitted",
  6155: "Everspan Non-Admitted MunichRe",
  6156: "Everspan Admitted MunichRe",
};

const DEFAULT_CARRIER_STATUS = {
  "Everspan Admitted GenRe": "N/A",
  "Everspan Non-Admitted GenRe": "turned off permanently",
  "Knight Non-Admitted": "turned off permanently"
};

const STATE_QUERY = `
  SELECT c.id AS company_id, c.name AS company_name, s.code AS state_code,
         cs.active, cs.dsg_allowed
  FROM companies c
  INNER JOIN company_state cs ON c.id = cs.company_id
  INNER JOIN states s ON cs.state_id = s.id
  WHERE c.id IN (5245, 6607, 5696, 6155, 6156)
  ORDER BY s.code, c.id
`;

const CARRIER_QUERY = `
  SELECT DISTINCT c.id, c.name, s.code, cs.active,
         CASE WHEN cs.active = TRUE AND s.specific_lottery = FALSE THEN c.lottery_al
              WHEN cs.active = TRUE AND s.specific_lottery = TRUE THEN cs.lottery_al
              ELSE NULL END AS lottery_al,
         cs.dsg_allowed
  FROM companies c
  INNER JOIN company_state cs ON c.id = cs.company_id
  INNER JOIN states s ON cs.state_id = s.id
  ORDER BY s.code, c.id
`;

function computeHash(rows) {
  const str = rows.map(r => `${r.state_code}:${r.company_id}:${r.active}:${r.dsg_allowed}`).sort().join('|');
  return crypto.createHash('md5').update(str).digest('hex');
}

function processCarrierData(rows) {
  const stateCarriers = {};
  const allStates = new Set();
  for (const row of rows) {
    if (!row.code) continue;
    allStates.add(row.code);
    const key = COMPANY_ID_MAPPING[row.id];
    if (!key) continue;
    if (!stateCarriers[row.code]) stateCarriers[row.code] = {};
    stateCarriers[row.code][key] = row.active ? "Y" : "turned off";
  }
  const result = {};
  for (const state of allStates) {
    result[state] = { ...DEFAULT_CARRIER_STATUS, ...stateCarriers[state] };
    for (const key of Object.values(COMPANY_ID_MAPPING)) {
      if (!(key in result[state])) result[state][key] = "N/A";
    }
  }
  return result;
}

/**
 * Compute DS&G eligibility per state based on dsg_allowed column.
 * Logic: If ANY carrier has dsg_allowed = 1 for a state, that state is enabled for DS&G ("Y")
 *        If NO carriers have dsg_allowed = 1, the state shows "N/A"
 */
function computeDsgEligibility(dbResults) {
  const stateDsgStatus = {};
  for (const row of dbResults) {
    const stateCode = row.code;
    const dsgAllowed = row.dsg_allowed;
    if (!stateCode) continue;
    if (dsgAllowed === 1 || dsgAllowed === true) {
      stateDsgStatus[stateCode] = "Y";
    } else if (!(stateCode in stateDsgStatus)) {
      stateDsgStatus[stateCode] = "N/A";
    }
  }
  return stateDsgStatus;
}

/**
 * Compute Admitted AL eligibility per state based on company 6156 (Everspan Admitted MunichRe).
 * If company 6156 is active in a state, that state has Admitted AL, Hotshots, and UIIA.
 * Exception: FL has Admitted AL UIIA as N/A.
 */
function computeAdmittedALEligibility(dbResults) {
  const ADMITTED_CARRIER_ID = 6156; // Everspan Admitted MunichRe
  const stateAdmittedStatus = {};
  for (const row of dbResults) {
    const stateCode = row.code;
    if (!stateCode) continue;
    if (row.id === ADMITTED_CARRIER_ID && (row.active === 1 || row.active === true)) {
      stateAdmittedStatus[stateCode] = {
        "Admitted AL": "Y",
        "Admitted AL Hotshots": "Y",
        "Admitted AL UIIA": stateCode === "FL" ? "N/A" : "Y"
      };
    } else if (!(stateCode in stateAdmittedStatus)) {
      stateAdmittedStatus[stateCode] = {
        "Admitted AL": "N/A",
        "Admitted AL Hotshots": "N/A",
        "Admitted AL UIIA": "N/A"
      };
    }
  }
  return stateAdmittedStatus;
}

/**
 * Detect specific changes between old and new state
 */
function detectChanges(oldRows, newRows) {
  const changes = [];
  const oldMap = new Map();
  for (const row of (oldRows || [])) {
    const key = `${row.state_code}:${row.company_id}`;
    oldMap.set(key, row);
  }
  const newMap = new Map();
  for (const row of newRows) {
    const key = `${row.state_code}:${row.company_id}`;
    newMap.set(key, row);
  }

  for (const [key, newRow] of newMap) {
    const oldRow = oldMap.get(key);
    const carrierName = COMPANY_ID_MAPPING[newRow.company_id] || newRow.company_name;

    if (!oldRow) {
      changes.push({
        type: 'NEW',
        state: newRow.state_code,
        carrier: carrierName,
        message: `New entry: ${newRow.state_code} - ${carrierName}`
      });
    } else {
      if (oldRow.active !== newRow.active) {
        const oldStatus = oldRow.active ? 'enabled' : 'disabled';
        const newStatus = newRow.active ? 'enabled' : 'disabled';
        changes.push({
          type: 'ACTIVE',
          state: newRow.state_code,
          carrier: carrierName,
          oldValue: oldRow.active,
          newValue: newRow.active,
          message: `${newRow.state_code} - ${carrierName}: active ${oldStatus} → ${newStatus}`
        });
      }
      if (oldRow.dsg_allowed !== newRow.dsg_allowed) {
        const oldStatus = oldRow.dsg_allowed ? 'allowed' : 'not allowed';
        const newStatus = newRow.dsg_allowed ? 'allowed' : 'not allowed';
        changes.push({
          type: 'DSG',
          state: newRow.state_code,
          carrier: carrierName,
          oldValue: oldRow.dsg_allowed,
          newValue: newRow.dsg_allowed,
          message: `${newRow.state_code} - ${carrierName}: DSG ${oldStatus} → ${newStatus}`
        });
      }
    }
  }

  for (const [key, oldRow] of oldMap) {
    if (!newMap.has(key)) {
      const carrierName = COMPANY_ID_MAPPING[oldRow.company_id] || oldRow.company_name;
      changes.push({
        type: 'REMOVED',
        state: oldRow.state_code,
        carrier: carrierName,
        message: `Removed: ${oldRow.state_code} - ${carrierName}`
      });
    }
  }
  return changes;
}

/**
 * Send a notification to Slack focusing on carrier eligibility changes
 */
function sendSlackNotification(changes, dsgEligibility, admittedALEligibility) {
  return new Promise((resolve) => {
    if (!SLACK_WEBHOOK_URL) {
      console.log('No Slack webhook URL configured, skipping notification');
      resolve(false);
      return;
    }

    // States that were already enabled for DSG before this update
    const PREVIOUSLY_ENABLED_DSG_STATES = ['AL', 'AR', 'AZ', 'CA', 'CO', 'DE', 'GA', 'IA', 'ID', 'IN', 'MD', 'ME', 'MI', 'MN', 'MO', 'MS', 'MT', 'ND', 'NE', 'NH', 'OH', 'OK', 'OR', 'PA', 'RI', 'SD', 'TN', 'TX', 'UT', 'VA', 'WA', 'WV'];

    // Get NEW states where DSG is enabled (excluding previously enabled)
    const newDsgEnabledStates = Object.entries(dsgEligibility)
      .filter(([state, status]) => status === "Y" && !PREVIOUSLY_ENABLED_DSG_STATES.includes(state))
      .map(([state]) => state)
      .sort();

    // Filter for DSG-specific changes (only newly enabled, excluding previously enabled states)
    const dsgChanges = changes.filter(c => c.type === 'DSG' && !PREVIOUSLY_ENABLED_DSG_STATES.includes(c.state));
    const activeChanges = changes.filter(c => c.type === 'ACTIVE');

    // Identify admitted carrier (Everspan Admitted MunichRe) active changes
    const admittedCarrierChanges = activeChanges.filter(c => c.carrier === 'Everspan Admitted MunichRe');

    // Build message sections
    const blocks = [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: "🔔 Carrier Eligibility Update",
          emoji: true
        }
      }
    ];

    // Admitted AL changes (Everspan Admitted MunichRe becoming active in new states)
    if (admittedCarrierChanges.length > 0) {
      const admittedLines = admittedCarrierChanges.map(c => {
        const status = c.newValue ? 'now available ✅' : 'no longer available ❌';
        return `• ${c.state}: Everspan Admitted (MunichRe) ${status}`;
      });
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Admitted AL Changes:*\n${admittedLines.join('\n')}`
        }
      });

      // Show updated admitted AL count
      if (admittedALEligibility) {
        const admittedCount = Object.values(admittedALEligibility)
          .filter(v => v["Admitted AL"] === "Y").length;
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Permitted Admitted AL Operations:* ${admittedCount} states`
          }
        });
      }
    }

    // NEW DSG enabled states summary (excluding previously enabled)
    if (newDsgEnabledStates.length > 0) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*DS&G is now enabled in ${newDsgEnabledStates.length} NEW states:*\n${newDsgEnabledStates.join(', ')}`
        }
      });
    }

    // Show specific DSG changes if any
    if (dsgChanges.length > 0) {
      const dsgLines = dsgChanges.slice(0, 10).map(c => {
        const status = c.newValue ? 'enabled ✅' : 'disabled ❌';
        return `• ${c.state}: DS&G ${status}`;
      });
      if (dsgChanges.length > 10) {
        dsgLines.push(`• ... and ${dsgChanges.length - 10} more DS&G changes`);
      }
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*DS&G changes detected:*\n${dsgLines.join('\n')}`
        }
      });
    }

    // Show other carrier active status changes (excluding admitted which are shown above)
    const otherActiveChanges = activeChanges.filter(c => c.carrier !== 'Everspan Admitted MunichRe');
    if (otherActiveChanges.length > 0) {
      const activeLines = otherActiveChanges.slice(0, 10).map(c => {
        const status = c.newValue ? 'enabled ✅' : 'disabled ❌';
        return `• ${c.state} - ${c.carrier}: ${status}`;
      });
      if (otherActiveChanges.length > 10) {
        activeLines.push(`• ... and ${otherActiveChanges.length - 10} more carrier changes`);
      }
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Carrier status changes:*\n${activeLines.join('\n')}`
        }
      });
    }

    // Link to tool
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `<${TOOL_URL}|View Coverages by State Tool>`
      }
    });

    // Determine which webhook to use based on approval mode
    let webhookUrl;
    let messageBlocks;

    if (APPROVED_MODE) {
      // Send to general channel (approved)
      webhookUrl = SLACK_WEBHOOK_URL;
      messageBlocks = blocks;
      console.log('Sending APPROVED message to general channel');
    } else {
      // Send to Daniel for approval first
      webhookUrl = SLACK_APPROVAL_WEBHOOK_URL || SLACK_WEBHOOK_URL;

      // Add approval header and instructions
      const approvalBlocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "⏳ *PENDING APPROVAL* - Review the message below before sending to the general channel:"
          }
        },
        { type: "divider" },
        ...blocks,
        { type: "divider" },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "✅ To approve and send to general channel, run:\n`gh workflow run carrier-monitor.yml -f approved=true`\n\n❌ To modify, edit the message in the script and re-run."
          }
        }
      ];
      messageBlocks = approvalBlocks;
      console.log('Sending message to Daniel for approval');
    }

    if (!webhookUrl) {
      console.log('No webhook URL configured');
      resolve(false);
      return;
    }

    const message = { blocks: messageBlocks };
    const payload = JSON.stringify(message);
    const url = new URL(webhookUrl);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          console.log('Slack notification sent successfully');
          resolve(true);
        } else {
          console.log(`WARNING: Slack responded with ${res.statusCode}: ${data}`);
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      console.log(`WARNING: Failed to send Slack notification: ${err.message}`);
      resolve(false);
    });

    req.write(payload);
    req.end();
  });
}

async function connectWithRetry(config, maxRetries = 3, delayMs = 5000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`Connection attempt ${attempt}/${maxRetries}...`);
      const conn = await mysql.createConnection(config);
      console.log('Connected successfully');
      return conn;
    } catch (err) {
      console.log(`Attempt ${attempt} failed: ${err.message}`);
      if (attempt === maxRetries) {
        // Exit gracefully instead of throwing - prevents workflow failure
        console.log('::warning::Database unavailable after retries - will try again next run');
        process.exit(0);  // Exit with success to prevent workflow failure
      }
      console.log(`Waiting ${delayMs/1000}s before retry...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  console.log('Connecting to database...');
  console.log(`Host: ${DB_CONFIG.host}`);
  console.log(`Port: ${DB_CONFIG.port}`);
  console.log(`User: ${DB_CONFIG.user}`);
  console.log(`Database: ${DB_CONFIG.database}`);

  let connection;
  try {
    connection = await connectWithRetry(DB_CONFIG, 3, 5000);
  } catch (err) {
    console.log('::error::Database connection failed after 3 attempts: ' + err.message);
    process.exit(1);
  }

  try {
    // Get current state
    const [stateRows] = await connection.execute(STATE_QUERY);
    const currentHash = computeHash(stateRows);
    console.log(`Current state hash: ${currentHash}`);
    console.log(`Records: ${stateRows.length}`);

    // Load saved state
    let savedState = null;
    try {
      const data = await fs.readFile('monitor_state.json', 'utf-8');
      savedState = JSON.parse(data);
      console.log(`Saved state hash: ${savedState.hash}`);
    } catch (e) {
      console.log('No saved state found (first run)');
    }

    // Compare
    if (savedState && savedState.hash === currentHash) {
      console.log('No changes detected');
      await connection.end();
      return;
    }

    console.log('Changes detected! Updating...');

    // Detect specific changes for reporting
    const changes = detectChanges(savedState?.data || [], stateRows);
    console.log(`Detected ${changes.length} specific change(s)`);
    for (const change of changes.slice(0, 10)) {
      console.log(`  - ${change.message}`);
    }
    if (changes.length > 10) {
      console.log(`  ... and ${changes.length - 10} more changes`);
    }

    // Get full data for sync
    const [fullRows] = await connection.execute(CARRIER_QUERY);
    const carrierData = processCarrierData(fullRows);

    // Compute DS&G eligibility
    const dsgEligibility = computeDsgEligibility(fullRows);
    const dsgEnabledStates = Object.entries(dsgEligibility).filter(([_, v]) => v === "Y").map(([k]) => k);
    console.log(`DS&G enabled in ${dsgEnabledStates.length} states: ${dsgEnabledStates.join(', ')}`);

    // Compute Admitted AL eligibility from carrier data
    const admittedALEligibility = computeAdmittedALEligibility(fullRows);
    const admittedALStates = Object.entries(admittedALEligibility)
      .filter(([_, v]) => v["Admitted AL"] === "Y").map(([k]) => k);
    console.log(`Admitted AL in ${admittedALStates.length} states: ${admittedALStates.join(', ')}`);

    // Update index.html
    let html = await fs.readFile('index.html', 'utf-8');
    let updated = false;

    // Update carrierData
    const carrierPattern = /const carrierData = ({[^;]+});/s;
    const carrierMatch = html.match(carrierPattern);

    if (!carrierMatch) {
      console.log('::error::Could not find carrierData in index.html');
      process.exit(1);
    }

    html = html.replace(
      `const carrierData = ${carrierMatch[1]};`,
      `const carrierData = ${JSON.stringify(carrierData)};`
    );
    updated = true;
    console.log('Updated carrierData');

    // Update lobOpsData for DS&G eligibility and Admitted AL
    const lobPattern = /const lobOpsData = ({[^;]+});/s;
    const lobMatch = html.match(lobPattern);

    if (lobMatch) {
      try {
        const lobData = JSON.parse(lobMatch[1]);
        let lobUpdated = false;

        // Update DS&G fields
        for (const [stateCode, dsgStatus] of Object.entries(dsgEligibility)) {
          if (lobData[stateCode]) {
            const currentDsg = lobData[stateCode]["Non-Admitted AL DS&G"];
            if (currentDsg !== dsgStatus) {
              console.log(`  DS&G: ${stateCode} ${currentDsg} → ${dsgStatus}`);
              lobData[stateCode]["Non-Admitted AL DS&G"] = dsgStatus;
              lobUpdated = true;
            }
          }
        }

        // Update Admitted AL fields based on admitted carrier (6156) activity
        for (const [stateCode, admittedStatus] of Object.entries(admittedALEligibility)) {
          if (lobData[stateCode]) {
            for (const [field, value] of Object.entries(admittedStatus)) {
              if (lobData[stateCode][field] !== value) {
                console.log(`  ${field}: ${stateCode} ${lobData[stateCode][field]} → ${value}`);
                lobData[stateCode][field] = value;
                lobUpdated = true;
              }
            }
          }
        }

        if (lobUpdated) {
          html = html.replace(
            `const lobOpsData = ${lobMatch[1]};`,
            `const lobOpsData = ${JSON.stringify(lobData)};`
          );
          console.log('Updated lobOpsData (DS&G + Admitted AL eligibility)');
        }
      } catch (e) {
        console.log(`WARNING: Could not parse lobOpsData: ${e.message}`);
      }
    }

    await fs.writeFile('index.html', html);

    // Save new state with data for future change detection
    await fs.writeFile('monitor_state.json', JSON.stringify({
      hash: currentHash,
      timestamp: new Date().toISOString(),
      rowCount: stateRows.length,
      data: stateRows
    }, null, 2));

    console.log('Files updated successfully');

    // Send Slack notification with carrier eligibility changes
    await sendSlackNotification(changes, dsgEligibility, admittedALEligibility);

  } finally {
    await connection.end();
  }
}

main().catch(err => {
  console.log('::warning::' + err.message);
  process.exit(0);  // Exit gracefully - network issues are transient
});
