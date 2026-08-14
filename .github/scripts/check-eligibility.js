const mysql = require('mysql2/promise');
const fs = require('fs').promises;
const crypto = require('crypto');
const https = require('https');

// Configuration from environment
// Password is base64 encoded to preserve special characters.
// Decoded lazily so this file stays requireable (test harness) without DB secrets.
function buildDbConfig() {
  return {
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: Buffer.from(process.env.DB_PASSWORD || '', 'base64').toString('utf-8'),
    database: process.env.DB_NAME,
    connectTimeout: 30000,
    ssl: { rejectUnauthorized: false }
  };
}

// Slack configuration
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;  // General channel
const SLACK_APPROVAL_WEBHOOK_URL = process.env.SLACK_APPROVAL_WEBHOOK_URL;  // Daniel's DM for approval
const TOOL_URL = 'https://dmedina5.github.io/coverages-by-state/';
const APPROVED_MODE = process.env.APPROVED === 'true';  // Set via workflow_dispatch to send to general channel

// Monitor health. The workflow is scheduled every 5 minutes but the self-hosted runner
// defers it heavily — observed real cadence is roughly hourly — so thresholds are set
// against actual behaviour, not the cron expression.
const HEARTBEAT_FILE = 'monitor_heartbeat.json';
const HEARTBEAT_MIN_INTERVAL_MINUTES = parseInt(process.env.HEARTBEAT_MIN_INTERVAL_MINUTES) || 180;
const STALENESS_WARN_HOURS = parseFloat(process.env.STALENESS_WARN_HOURS) || 6;
const STALENESS_ERROR_HOURS = parseFloat(process.env.STALENESS_ERROR_HOURS) || 12;

/**
 * THE carrier list. Single source of truth for the DB query, the sync, and the UI —
 * index.html renders its carrier cards and filter buttons from the copy of this that
 * gets written into it, so adding a carrier is one entry here and nothing else.
 *
 * `status`:
 *   live       — quotable today. Synced from company_state and rendered normally.
 *   pre-launch — the company_state row exists but the carrier is gated OFF above the
 *                database, so it is NOT quotable and must not be shown as available.
 *                Still synced (so a weight change is visible in Slack), never rendered.
 *   retired    — no company_state row at all; a fixed presentational status.
 *
 * Why `pre-launch` exists: Accredited 2025 Admitted (6881) has active=1 and a 100%
 * lottery weight in prod, seeded deploy-dark by T2CP-832 ahead of its program launch.
 * The real gate is ACCREDITED_2025_ADMITTED_ENABLED (config/carriers.php, defaults
 * false, absent from prod secrets) — an application flag this tool cannot read. Zero
 * submissions have ever bound on it. Trusting company_state.active alone would tell
 * agents a carrier is available months before it is. Flip to `live` at launch.
 */
const CARRIER_REGISTRY = [
  { id: null, key: "Everspan Admitted GenRe",         display: "Everspan Admitted (GenRe)",           status: "retired",    defaultStatus: "N/A" },
  { id: null, key: "Everspan Non-Admitted GenRe",     display: "Everspan Non-Admitted (GenRe)",       status: "retired",    defaultStatus: "turned off permanently" },
  { id: 6156, key: "Everspan Admitted MunichRe",      display: "Everspan Admitted (MunichRe)",        status: "live" },
  { id: 6155, key: "Everspan Non-Admitted MunichRe",  display: "Everspan Non-Admitted (MunichRe)",    status: "live" },
  { id: 5245, key: "Accredited Non-Admitted 1st",     display: "Accredited Non-Admitted (1st)",       status: "live" },
  { id: 6607, key: "Accredited Non-Admitted New",     display: "Accredited Non-Admitted (New)",       status: "live" },
  { id: 61,   key: "Knight Non-Admitted",             display: "Knight Non-Admitted",                 status: "retired",    defaultStatus: "turned off permanently",
    note: "Permanently turned off for new business; continues to endorse existing policies." },
  { id: 5696, key: "Ascot Non-Admitted",              display: "Ascot Non-Admitted",                  status: "live" },
  { id: 6881, key: "Accredited 2025 Admitted",        display: "Accredited Admitted (2025 Program)",  status: "pre-launch",
    note: "Provisioned in the database ahead of launch. Not quotable until ACCREDITED_2025_ADMITTED_ENABLED is turned on." }
];

// Carriers whose company_state rows the monitor reads (live + pre-launch).
const TRACKED_CARRIERS = CARRIER_REGISTRY.filter(c => c.id !== null && c.status !== 'retired');
const TRACKED_COMPANY_IDS = TRACKED_CARRIERS.map(c => c.id);

// id -> data key, for turning DB rows into the keys index.html indexes by
const COMPANY_ID_MAPPING = Object.fromEntries(TRACKED_CARRIERS.map(c => [c.id, c.key]));

// Fixed statuses for carriers with no company_state row to read
const DEFAULT_CARRIER_STATUS = Object.fromEntries(
  CARRIER_REGISTRY.filter(c => c.defaultStatus).map(c => [c.key, c.defaultStatus])
);

// Carriers that must never render as available, whatever the database says
const NON_QUOTABLE_KEYS = new Set(
  CARRIER_REGISTRY.filter(c => c.status === 'pre-launch').map(c => c.key)
);

// The effective AL lottery weight for a carrier in a state: states flagged
// specific_lottery use the per-state override (company_state.lottery_al), all
// others fall back to the carrier-wide weight (companies.lottery_al).
const EFFECTIVE_LOTTERY_SQL = `
  CASE WHEN cs.active = TRUE AND s.specific_lottery = FALSE THEN c.lottery_al
       WHEN cs.active = TRUE AND s.specific_lottery = TRUE THEN cs.lottery_al
       ELSE NULL END
`;

const STATE_QUERY = `
  SELECT c.id AS company_id, c.name AS company_name, s.code AS state_code,
         cs.active, cs.dsg_allowed,
         ${EFFECTIVE_LOTTERY_SQL} AS lottery_al
  FROM companies c
  INNER JOIN company_state cs ON c.id = cs.company_id
  INNER JOIN states s ON cs.state_id = s.id
  WHERE c.id IN (${TRACKED_COMPANY_IDS.join(', ')})
  ORDER BY s.code, c.id
`;

/**
 * Every company with a company_state row. company_state is carrier-only (6 companies
 * across 173 rows as of 2026-08-14), so anything here that the registry does not know
 * about is a carrier this tool is blind to — surfaced rather than silently included,
 * because active=1 does not prove quotable (see CARRIER_REGISTRY).
 */
const CARRIER_DISCOVERY_QUERY = `
  SELECT c.id, c.name,
         COUNT(*) AS state_rows,
         SUM(cs.active) AS active_states,
         GROUP_CONCAT(DISTINCT CASE WHEN cs.active = TRUE THEN s.code END ORDER BY s.code) AS active_state_codes
  FROM companies c
  INNER JOIN company_state cs ON c.id = cs.company_id
  INNER JOIN states s ON cs.state_id = s.id
  GROUP BY c.id, c.name
  HAVING active_states > 0
  ORDER BY c.id
`;

const CARRIER_QUERY = `
  SELECT DISTINCT c.id, c.name, s.code, cs.active,
         ${EFFECTIVE_LOTTERY_SQL} AS lottery_al,
         cs.dsg_allowed
  FROM companies c
  INNER JOIN company_state cs ON c.id = cs.company_id
  INNER JOIN states s ON cs.state_id = s.id
  ORDER BY s.code, c.id
`;

// lottery_al is part of the hash so a weight change (e.g. a carrier dropped to 0%
// while staying enabled) triggers a sync — active/dsg_allowed alone would miss it.
function computeHash(rows) {
  const str = rows
    .map(r => `${r.state_code}:${r.company_id}:${r.active}:${r.dsg_allowed}:${normalizeLottery(r.lottery_al)}`)
    .sort()
    .join('|');
  return crypto.createHash('md5').update(str).digest('hex');
}

// null/undefined lottery (inactive carrier) collapses to a single sentinel so an
// inactive row never looks like a 0% row.
function normalizeLottery(value) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  return Number.isNaN(num) ? null : num;
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
    // A pre-launch carrier is active in the database but gated off above it, so it
    // can never be reported as available no matter what company_state says.
    if (NON_QUOTABLE_KEYS.has(key)) {
      stateCarriers[row.code][key] = "pre-launch";
      continue;
    }
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
 * Carriers active in the database that the registry does not cover.
 *
 * Deliberately reports rather than auto-includes: a carrier can be provisioned in
 * company_state months before it is quotable (see CARRIER_REGISTRY), so silently
 * showing it as available would be worse than not showing it at all. Someone adds a
 * registry line once they know its launch status.
 */
function findUntrackedCarriers(discoveryRows) {
  const known = new Set(CARRIER_REGISTRY.filter(c => c.id !== null).map(c => c.id));
  return discoveryRows
    .filter(row => !known.has(row.id))
    .map(row => ({
      id: row.id,
      name: row.name,
      activeStates: Number(row.active_states) || 0,
      stateCodes: (row.active_state_codes || '').split(',').filter(Boolean)
    }));
}

/**
 * Health of the monitor itself, from the heartbeat written on every successful check.
 *
 * `now` is injected rather than read from the clock so this is deterministically
 * testable. Thresholds must stay above HEARTBEAT_MIN_INTERVAL_MINUTES, otherwise a
 * perfectly healthy monitor would alarm on its own rate-limited heartbeat.
 */
function evaluateStaleness(lastCheckedAt, now, opts = {}) {
  const warnHours = opts.warnHours ?? STALENESS_WARN_HOURS;
  const errorHours = opts.errorHours ?? STALENESS_ERROR_HOURS;

  if (!lastCheckedAt) {
    return { level: 'unknown', hours: null, message: 'No previous heartbeat recorded (first run since staleness tracking was added)' };
  }
  const then = new Date(lastCheckedAt).getTime();
  if (Number.isNaN(then)) {
    return { level: 'unknown', hours: null, message: `Unreadable heartbeat timestamp: ${lastCheckedAt}` };
  }
  const hours = (now - then) / 3600000;
  const rounded = Math.round(hours * 10) / 10;
  if (hours >= errorHours) {
    return { level: 'error', hours: rounded, message: `Monitor has not completed a successful check in ${rounded}h (threshold ${errorHours}h) — carrier data may be stale` };
  }
  if (hours >= warnHours) {
    return { level: 'warn', hours: rounded, message: `Last successful check was ${rounded}h ago (threshold ${warnHours}h)` };
  }
  return { level: 'ok', hours: rounded, message: `Last successful check was ${rounded}h ago` };
}

/**
 * Heartbeat writes are rate limited so a monitor that runs hourly does not produce a
 * commit every hour. Interval stays well under the staleness thresholds.
 */
function shouldPersistHeartbeat(lastPersistedAt, now, minIntervalMinutes = HEARTBEAT_MIN_INTERVAL_MINUTES) {
  if (!lastPersistedAt) return true;
  const then = new Date(lastPersistedAt).getTime();
  if (Number.isNaN(then)) return true;
  return (now - then) >= minIntervalMinutes * 60000;
}

/**
 * Compute the effective AL lottery weight per state, per tracked carrier.
 *
 * Only ACTIVE carriers are recorded — an inactive carrier has no lottery standing,
 * and recording it as 0 would be indistinguishable from the case this exists to
 * surface: a carrier that is still enabled to quote but sits at 0% on the lottery
 * (Everspan Non-Admitted MunichRe today), so the lottery never selects it.
 *
 * Shape: { "TX": { "Everspan Non-Admitted MunichRe": 0, "Ascot Non-Admitted": 1 } }
 */
function computeLotteryData(dbResults) {
  const result = {};
  for (const row of dbResults) {
    if (!row.code) continue;
    const key = COMPANY_ID_MAPPING[row.id];
    if (!key) continue;
    if (!(row.active === 1 || row.active === true)) continue;
    const lottery = normalizeLottery(row.lottery_al);
    if (lottery === null) continue;
    if (!result[row.code]) result[row.code] = {};
    result[row.code][key] = lottery;
  }
  return result;
}

/**
 * Carriers that are enabled to quote but set to 0% on the lottery, keyed by state.
 * Sorted so the output is stable across runs (stable diffs, stable Slack copy).
 */
function findZeroLotteryCarriers(lotteryData) {
  const result = {};
  for (const state of Object.keys(lotteryData).sort()) {
    const zeroed = Object.keys(lotteryData[state]).filter(c => lotteryData[state][c] === 0).sort();
    if (zeroed.length > 0) result[state] = zeroed;
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

function formatLotteryValue(value) {
  return value === null ? 'n/a (not enabled)' : `${value}%`;
}

/**
 * Matches one `const <name> = <json>;` data block in index.html.
 *
 * Anchored to the end of the line rather than "everything up to the next semicolon":
 * the blocks are emitted by JSON.stringify as a single line, and their values can
 * legitimately contain semicolons (a carrier note does today). A `[^;]+` pattern
 * silently fails to match those, and the sync then aborts on a block it cannot find.
 */
function dataBlockPattern(name) {
  return new RegExp('const ' + name + ' = ([\\[{].*[\\]}]);$', 'm');
}

/**
 * Replace a data block in index.html, failing loudly if it is not found — a missed
 * block means the published tool silently keeps serving the old values.
 */
function replaceDataBlock(html, name, value) {
  const match = html.match(dataBlockPattern(name));
  if (!match) {
    console.log(`::error::Could not find ${name} in index.html`);
    process.exit(1);
  }
  return html.replace(`const ${name} = ${match[1]};`, `const ${name} = ${JSON.stringify(value)};`);
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
      // Lottery weight. Rows saved before lottery tracking existed have no
      // lottery_al key at all — skip those rather than reporting the whole book
      // as changed on the first run after this field was added.
      const oldTrackedLottery = Object.prototype.hasOwnProperty.call(oldRow, 'lottery_al');
      const oldLottery = normalizeLottery(oldRow.lottery_al);
      const newLottery = normalizeLottery(newRow.lottery_al);
      if (oldTrackedLottery && oldLottery !== newLottery) {
        changes.push({
          type: 'LOTTERY',
          state: newRow.state_code,
          carrier: carrierName,
          oldValue: oldLottery,
          newValue: newLottery,
          // Only meaningful while the carrier stays enabled — that is the case
          // this exists to catch (quotable, but never selected by the lottery).
          zeroed: newLottery === 0 && Boolean(newRow.active),
          restored: oldLottery === 0 && newLottery !== null && newLottery > 0,
          message: `${newRow.state_code} - ${carrierName}: lottery ${formatLotteryValue(oldLottery)} → ${formatLotteryValue(newLottery)}`
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
function sendSlackNotification(payload) {
  const {
    changes = [],
    dsgEligibility,
    admittedALEligibility,
    zeroLotteryCarriers,
    untrackedCarriers,
    staleness
  } = payload || {};
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

    // Lottery weight changes — a carrier can stay enabled to quote while its
    // lottery weight drops to 0%, which no active/DSG signal above would surface.
    const lotteryChanges = changes.filter(c => c.type === 'LOTTERY');
    if (lotteryChanges.length > 0) {
      const zeroedChanges = lotteryChanges.filter(c => c.zeroed);
      const otherLotteryChanges = lotteryChanges.filter(c => !c.zeroed);

      if (zeroedChanges.length > 0) {
        const zeroLines = zeroedChanges.slice(0, 10).map(c =>
          `• ${c.state} - ${c.carrier}: ${formatLotteryValue(c.oldValue)} → *0%* ⚖️`
        );
        if (zeroedChanges.length > 10) {
          zeroLines.push(`• ... and ${zeroedChanges.length - 10} more set to 0%`);
        }
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Carriers set to 0% on the lottery (still enabled to quote):*\n${zeroLines.join('\n')}`
          }
        });
      }

      if (otherLotteryChanges.length > 0) {
        const otherLines = otherLotteryChanges.slice(0, 10).map(c => {
          const marker = c.restored ? ' ✅' : '';
          return `• ${c.state} - ${c.carrier}: ${formatLotteryValue(c.oldValue)} → ${formatLotteryValue(c.newValue)}${marker}`;
        });
        if (otherLotteryChanges.length > 10) {
          otherLines.push(`• ... and ${otherLotteryChanges.length - 10} more lottery changes`);
        }
        blocks.push({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*Lottery weight changes:*\n${otherLines.join('\n')}`
          }
        });
      }
    }

    // Standing total of carriers sitting at 0% while still quotable
    if (zeroLotteryCarriers && Object.keys(zeroLotteryCarriers).length > 0) {
      const perCarrier = {};
      for (const [state, carriers] of Object.entries(zeroLotteryCarriers)) {
        for (const carrier of carriers) {
          (perCarrier[carrier] = perCarrier[carrier] || []).push(state);
        }
      }
      const summaryLines = Object.keys(perCarrier).sort().map(carrier =>
        `• ${carrier}: ${perCarrier[carrier].length} state${perCarrier[carrier].length === 1 ? '' : 's'} (${perCarrier[carrier].join(', ')})`
      );
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Currently at 0% on the lottery (enabled, not selected):*\n${summaryLines.join('\n')}`
        }
      });
    }

    // Carriers active in prod that this tool does not know about. Needs a human:
    // being active in company_state does not prove a carrier is quotable.
    if (untrackedCarriers && untrackedCarriers.length > 0) {
      const lines = untrackedCarriers.map(c =>
        `• \`${c.id}\` ${c.name} — active in ${c.activeStates} state${c.activeStates === 1 ? '' : 's'}${c.stateCodes.length ? ` (${c.stateCodes.join(', ')})` : ''}`
      );
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `:rotating_light: *Carrier active in the database but NOT tracked by this tool:*\n${lines.join('\n')}\n_Not shown in the tool and not monitored for 0% changes. Confirm whether it has actually launched, then add it to CARRIER_REGISTRY in check-eligibility.js._`
        }
      });
    }

    // Monitor health — a gap means the tool was showing stale data for that window
    if (staleness && (staleness.level === 'warn' || staleness.level === 'error')) {
      const icon = staleness.level === 'error' ? ':rotating_light:' : ':warning:';
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `${icon} *Monitor health:* ${staleness.message}`
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

async function readHeartbeat() {
  try {
    return JSON.parse(await fs.readFile(HEARTBEAT_FILE, 'utf-8'));
  } catch (e) {
    return null;
  }
}

/**
 * A single unreachable-database run is a transient blip and stays green, as before.
 * But once the monitor has been failing long enough that the published data is stale,
 * it escalates to a hard failure so the run goes red and GitHub actually notifies —
 * previously any number of consecutive failures exited 0 and looked healthy.
 */
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
        const heartbeat = await readHeartbeat();
        const staleness = evaluateStaleness(heartbeat?.lastCheckedAt, Date.now());
        if (staleness.level === 'error') {
          console.log(`::error::Database unavailable after ${maxRetries} attempts, and ${staleness.message}`);
          await sendSlackNotification({ staleness, changes: [] });
          process.exit(1);  // Escalate: this is no longer a transient blip
        }
        console.log(`::warning::Database unavailable after retries - will try again next run (${staleness.message})`);
        process.exit(0);
      }
      console.log(`Waiting ${delayMs/1000}s before retry...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

async function main() {
  // APPROVED MODE: replay the pending notification saved during detection run
  if (APPROVED_MODE) {
    let pending = null;
    try {
      const data = await fs.readFile('pending_notification.json', 'utf-8');
      pending = JSON.parse(data);
    } catch (e) {
      console.log('No pending_notification.json found — nothing to send');
      return;
    }
    console.log('Sending APPROVED message to general channel');
    await sendSlackNotification(pending);
    // Clear the pending file after sending
    await fs.writeFile('pending_notification.json', JSON.stringify({ sent: true, sentAt: new Date().toISOString() }, null, 2));
    console.log('Pending notification sent and cleared');
    return;
  }

  const DB_CONFIG = buildDbConfig();

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

  let exitCode = 0;

  try {
    // Monitor health, measured before anything else so a gap is reported even on a
    // run that finds no carrier changes at all.
    const now = Date.now();
    const previousHeartbeat = await readHeartbeat();
    const staleness = evaluateStaleness(previousHeartbeat?.lastCheckedAt, now);
    if (staleness.level === 'error') {
      console.log(`::error::${staleness.message}`);
      exitCode = 1;  // surface as a red run so GitHub notifies
    } else if (staleness.level === 'warn') {
      console.log(`::warning::${staleness.message}`);
    } else {
      console.log(`Monitor health: ${staleness.message}`);
    }

    // Get current state
    const [stateRows] = await connection.execute(STATE_QUERY);
    const currentHash = computeHash(stateRows);
    console.log(`Current state hash: ${currentHash}`);
    console.log(`Records: ${stateRows.length}`);

    // Carriers active in prod that the registry does not cover. Checked on every run,
    // not just on change — a new carrier appears without any tracked row changing.
    const [discoveryRows] = await connection.execute(CARRIER_DISCOVERY_QUERY);
    const untrackedCarriers = findUntrackedCarriers(discoveryRows);
    if (untrackedCarriers.length > 0) {
      for (const c of untrackedCarriers) {
        console.log(`::warning::Untracked carrier active in prod: ${c.id} ${c.name} (${c.stateCodes.join(', ') || c.activeStates + ' states'}) — add to CARRIER_REGISTRY`);
      }
    } else {
      console.log(`Carrier registry covers all ${discoveryRows.length} active carriers`);
    }

    // Heartbeat: rate limited so an hourly monitor does not commit hourly
    const heartbeatDue = shouldPersistHeartbeat(previousHeartbeat?.lastCheckedAt, now);
    if (heartbeatDue) {
      await fs.writeFile(HEARTBEAT_FILE, JSON.stringify({
        lastCheckedAt: new Date(now).toISOString(),
        trackedCarriers: TRACKED_COMPANY_IDS.length,
        untrackedCarriers: untrackedCarriers.map(c => ({ id: c.id, name: c.name })),
        note: 'Written on every successful check (rate limited). Drives the freshness indicator in the tool.'
      }, null, 2));
      console.log('Heartbeat updated');
    }

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
      if (untrackedCarriers.length > 0 || staleness.level === 'error') {
        await sendSlackNotification({ changes: [], untrackedCarriers, staleness });
      }
      await connection.end();
      if (exitCode !== 0) process.exitCode = exitCode;
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

    // Compute effective AL lottery weights and the 0%-but-still-quotable set
    const lotteryData = computeLotteryData(fullRows);
    const zeroLotteryCarriers = findZeroLotteryCarriers(lotteryData);
    const zeroLotteryStates = Object.keys(zeroLotteryCarriers);
    console.log(`Carriers set to 0% on the lottery in ${zeroLotteryStates.length} states`);
    for (const state of zeroLotteryStates) {
      console.log(`  ${state}: ${zeroLotteryCarriers[state].join(', ')}`);
    }

    // Update index.html
    let html = await fs.readFile('index.html', 'utf-8');
    let updated = false;

    html = replaceDataBlock(html, 'carrierData', carrierData);
    updated = true;
    console.log('Updated carrierData');

    // Drives the "Set to 0% in this state" label
    html = replaceDataBlock(html, 'carrierLotteryData', lotteryData);
    console.log('Updated carrierLotteryData');

    // Push the registry itself into the page so the UI's carrier cards and filter
    // buttons come from one list — adding a carrier means editing CARRIER_REGISTRY
    // above and nothing in index.html.
    html = replaceDataBlock(html, 'carrierRegistry', CARRIER_REGISTRY);
    console.log('Updated carrierRegistry');

    // Update lobOpsData for DS&G eligibility and Admitted AL
    const lobPattern = dataBlockPattern('lobOpsData');
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

    // Save pending notification so approval run can replay it without re-querying DB
    const notification = {
      detectedAt: new Date().toISOString(),
      changes,
      dsgEligibility,
      admittedALEligibility,
      zeroLotteryCarriers,
      untrackedCarriers,
      staleness
    };
    await fs.writeFile('pending_notification.json', JSON.stringify(notification, null, 2));
    console.log('Saved pending_notification.json for approval replay');

    // Send Slack notification with carrier eligibility changes.
    // A hash change with no reportable row-level change (e.g. the first run after a
    // new tracked column is introduced) would otherwise post an empty update — but an
    // untracked carrier or a staleness gap is worth saying on its own.
    const hasSomethingToSay = changes.length > 0 || untrackedCarriers.length > 0 || staleness.level === 'error';
    if (!hasSomethingToSay) {
      console.log('Hash changed but nothing reportable — skipping Slack notification');
    } else {
      await sendSlackNotification(notification);
    }

    if (exitCode !== 0) process.exitCode = exitCode;

  } finally {
    await connection.end();
  }
}

module.exports = {
  CARRIER_REGISTRY,
  TRACKED_COMPANY_IDS,
  COMPANY_ID_MAPPING,
  DEFAULT_CARRIER_STATUS,
  NON_QUOTABLE_KEYS,
  computeHash,
  normalizeLottery,
  processCarrierData,
  computeLotteryData,
  findZeroLotteryCarriers,
  findUntrackedCarriers,
  evaluateStaleness,
  shouldPersistHeartbeat,
  computeDsgEligibility,
  computeAdmittedALEligibility,
  detectChanges,
  formatLotteryValue,
  dataBlockPattern
};

if (require.main === module) {
  main().catch(err => {
    console.log('::warning::' + err.message);
    process.exit(0);  // Exit gracefully - network issues are transient
  });
}
