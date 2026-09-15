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
 * THE carrier list is DERIVED from production on every run — nothing here decides
 * whether a carrier exists, is admitted, or is live. What this file keeps is
 * presentation only:
 *
 *   CURATED_CARRIERS — a friendly key/display name (and an optional note) per known
 *                      company id, in the order the UI shows the cards. A carrier the
 *                      map does not know still appears, named from companies.name;
 *                      add an entry here to name it nicely. Nothing else changes.
 *   LEGACY_CARRIERS  — carriers with no database presence at all, kept for the
 *                      historical cards ("N/A" / "turned off permanently").
 *
 * Everything else comes from CARRIER_FACTS_QUERY, per carrier:
 *   admitted   — companies.regulation = 'Admitted' (6156, 6881 today). 'Non-Admited'
 *                and 'Undefined' are both non-admitted paper.
 *   status     — deriveCarrierStatus():
 *     live       new business written in the last LAUNCH_WINDOW_DAYS, or active in
 *                some state with any history of new business. Quotable, rendered.
 *     pre-launch active in company_state but has NEVER written new business — the
 *                deploy-dark shape: Accredited 2025 Admitted (6881) sat active=1 with a
 *                100% FL weight from 2026-07-30 behind ACCREDITED_2025_ADMITTED_ENABLED
 *                until 2026-09-14, and company_state alone would have advertised it six
 *                weeks early. Synced (so a weight change is visible), never rendered as
 *                available. Flips to live by itself the day submissions carry its id.
 *     retired    active nowhere and not writing. Fixed presentational status.
 *
 * "New business" is a transportation_submissions row with transaction_id = 0 and
 * carrier_al = the carrier — endorsements on old policies (Knight still has them)
 * do not count, or a carrier turned off years ago would read as live.
 */
const CURATED_CARRIERS = [
  { id: 6156, key: "Everspan Admitted MunichRe",      display: "Everspan Admitted (MunichRe)" },
  { id: 6155, key: "Everspan Non-Admitted MunichRe",  display: "Everspan Non-Admitted (MunichRe)" },
  { id: 5245, key: "Accredited Non-Admitted 1st",     display: "Accredited Non-Admitted (1st)" },
  { id: 6607, key: "Accredited Non-Admitted New",     display: "Accredited Non-Admitted (New)" },
  { id: 61,   key: "Knight Non-Admitted",             display: "Knight Non-Admitted",
    retiredStatus: "turned off permanently",
    note: "Permanently turned off for new business; continues to endorse existing policies." },
  { id: 5696, key: "Ascot Non-Admitted",              display: "Ascot Non-Admitted" },
  { id: 6881, key: "Accredited 2025 Admitted",        display: "Accredited Admitted (2025 Program)",
    note: "Florida-only admitted program. Launched 2026-09-14." }
];

const LEGACY_CARRIERS = [
  { id: null, key: "Everspan Admitted GenRe",     display: "Everspan Admitted (GenRe)",     status: "retired", admitted: true,  defaultStatus: "N/A",                    curated: true },
  { id: null, key: "Everspan Non-Admitted GenRe", display: "Everspan Non-Admitted (GenRe)", status: "retired", admitted: false, defaultStatus: "turned off permanently", curated: true }
];

// A carrier is "writing business" if it has new-business submissions this recent.
const LAUNCH_WINDOW_DAYS = parseInt(process.env.LAUNCH_WINDOW_DAYS) || 30;

// One row per carrier the database knows: every company with a company_state row,
// plus the curated ids (a retired carrier such as Knight has no state rows left).
const CARRIER_FACTS_QUERY = `
  SELECT c.id, c.name, c.regulation,
         (SELECT COUNT(*) FROM company_state cs WHERE cs.company_id = c.id AND cs.active = 1) AS active_states,
         (SELECT COUNT(*) FROM transportation_submissions t
           WHERE t.carrier_al = c.id AND t.transaction_id = 0
             AND t.created_at >= NOW() - INTERVAL ${LAUNCH_WINDOW_DAYS} DAY) AS new_business_30d,
         (SELECT MIN(t.created_at) FROM transportation_submissions t
           WHERE t.carrier_al = c.id AND t.transaction_id = 0) AS first_new_business
  FROM companies c
  WHERE c.company_type_id = 1
    AND (EXISTS (SELECT 1 FROM company_state cs WHERE cs.company_id = c.id)
         OR c.id IN (${CURATED_CARRIERS.map(c => c.id).join(', ')}))
  ORDER BY c.id
`;

function deriveCarrierStatus(fact) {
  const activeStates = Number(fact.active_states) || 0;
  const recent = Number(fact.new_business_30d) || 0;
  if (recent > 0) return 'live';
  if (activeStates > 0) return fact.first_new_business ? 'live' : 'pre-launch';
  return 'retired';
}

// Name for a carrier the curated map does not know: the part of companies.name
// before any " | " tail, the paper, and the id — two carriers can share a name
// (5245 and 6607 are both "Accredited Specialty Insurance Company").
function fallbackName(fact) {
  const base = String(fact.name || `Carrier ${fact.id}`).split('|')[0].trim();
  const paper = fact.regulation === 'Admitted' ? 'Admitted' : 'Non-Admitted';
  return `${base} (${paper}) #${fact.id}`;
}

/**
 * Build the registry for this run from CARRIER_FACTS_QUERY rows. Deterministic:
 * legacy cards first, curated carriers in curated order, then anything the curated
 * map does not know, by id. Written into index.html as `carrierRegistry` on every
 * sync, so the UI's cards and filters follow production without a code change.
 */
function buildRegistry(facts) {
  const byId = new Map(facts.map(f => [Number(f.id), f]));
  const curatedIds = new Set(CURATED_CARRIERS.map(c => c.id));
  const entryFor = (fact, names) => {
    const status = deriveCarrierStatus(fact);
    const entry = {
      id: Number(fact.id),
      key: names ? names.key : fallbackName(fact),
      display: names ? names.display : fallbackName(fact),
      status,
      admitted: fact.regulation === 'Admitted',
      curated: !!names,
      activeStates: Number(fact.active_states) || 0,
      newBusiness30d: Number(fact.new_business_30d) || 0
    };
    if (status === 'retired') entry.defaultStatus = (names && names.retiredStatus) || 'turned off';
    if (names && names.note) entry.note = names.note;
    return entry;
  };
  const curated = CURATED_CARRIERS.filter(c => byId.has(c.id)).map(c => entryFor(byId.get(c.id), c));
  const unnamed = [...byId.values()]
    .filter(f => !curatedIds.has(Number(f.id)))
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map(f => entryFor(f, null));
  return [...LEGACY_CARRIERS, ...curated, ...unnamed];
}

/**
 * Everything the sync needs to look up about a registry, computed once per run
 * (and once per Slack replay from the registry saved in the payload).
 */
function registryIndex(registry) {
  const entries = registry || [];
  const tracked = entries.filter(c => c.id !== null && c.id !== undefined && c.status !== 'retired');
  const admitted = entries.filter(c => c.admitted && c.status === 'live');
  return {
    entries,
    trackedIds: tracked.map(c => c.id),
    keyById: Object.fromEntries(tracked.map(c => [c.id, c.key])),
    defaults: Object.fromEntries(entries.filter(c => c.defaultStatus).map(c => [c.key, c.defaultStatus])),
    nonQuotableKeys: new Set(entries.filter(c => c.status === 'pre-launch').map(c => c.key)),
    admittedIds: admitted.map(c => c.id),
    admittedKeys: new Set(admitted.map(c => c.key)),
    displayByKey: Object.fromEntries(entries.map(c => [c.key, c.display]))
  };
}

// Carriers rendered with a fallback name — worth a note to the operator, not a
// blocker: the site already shows them.
function unnamedCarriers(registry) {
  return (registry || []).filter(c => c.id !== null && !c.curated);
}

/**
 * Carrier-level transitions between two runs' registries: a launch (pre-launch →
 * live), a retirement, a carrier appearing for the first time. No previous registry
 * (state saved before registries were derived) reports nothing rather than
 * announcing every carrier as new.
 */
function detectCarrierChanges(oldRegistry, newRegistry) {
  if (!Array.isArray(oldRegistry)) return [];
  const before = new Map(oldRegistry.filter(c => c.id !== null).map(c => [c.id, c]));
  const changes = [];
  for (const c of newRegistry.filter(c => c.id !== null)) {
    const prev = before.get(c.id);
    const oldStatus = prev ? prev.status : null;
    if (oldStatus === c.status) continue;
    changes.push({
      type: 'CARRIER',
      carrier: c.key,
      oldValue: oldStatus,
      newValue: c.status,
      message: `${c.display}: ${oldStatus || 'new'} → ${c.status}`
    });
  }
  return changes;
}

// The effective AL lottery weight for a carrier in a state: states flagged
// specific_lottery use the per-state override (company_state.lottery_al), all
// others fall back to the carrier-wide weight (companies.lottery_al).
const EFFECTIVE_LOTTERY_SQL = `
  CASE WHEN cs.active = TRUE AND s.specific_lottery = FALSE THEN c.lottery_al
       WHEN cs.active = TRUE AND s.specific_lottery = TRUE THEN cs.lottery_al
       ELSE NULL END
`;

// Every company_state row. company_state is carrier-only; rows for carriers the
// registry does not track (retired) are skipped by the registry index downstream.
const STATE_QUERY = `
  SELECT c.id AS company_id, c.name AS company_name, s.code AS state_code,
         cs.active, cs.dsg_allowed,
         ${EFFECTIVE_LOTTERY_SQL} AS lottery_al
  FROM companies c
  INNER JOIN company_state cs ON c.id = cs.company_id
  INNER JOIN states s ON cs.state_id = s.id
  ORDER BY s.code, c.id
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
// Carrier STATUS is part of it too, so a launch (pre-launch → live) with no state
// row changing still syncs and announces. Submission counts deliberately are not.
function computeHash(rows, registry = []) {
  const str = rows
    .map(r => `${r.state_code}:${r.company_id}:${r.active}:${r.dsg_allowed}:${normalizeLottery(r.lottery_al)}`)
    .concat(registry.filter(c => c.id !== null).map(c => `carrier:${c.id}:${c.status}`))
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

function processCarrierData(rows, R) {
  const stateCarriers = {};
  const allStates = new Set();
  for (const row of rows) {
    if (!row.code) continue;
    allStates.add(row.code);
    const key = R.keyById[row.id];
    if (!key) continue;
    if (!stateCarriers[row.code]) stateCarriers[row.code] = {};
    // A pre-launch carrier is active in the database but gated off above it, so it
    // can never be reported as available no matter what company_state says.
    if (R.nonQuotableKeys.has(key)) {
      stateCarriers[row.code][key] = "pre-launch";
      continue;
    }
    stateCarriers[row.code][key] = row.active ? "Y" : "turned off";
  }
  const result = {};
  for (const state of allStates) {
    result[state] = { ...R.defaults, ...stateCarriers[state] };
    for (const key of Object.values(R.keyById)) {
      if (!(key in result[state])) result[state][key] = "N/A";
    }
  }
  return result;
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
function computeLotteryData(dbResults, R) {
  const result = {};
  for (const row of dbResults) {
    if (!row.code) continue;
    const key = R.keyById[row.id];
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
 * Compute DS&G (Dirt, Sand & Gravel) eligibility per state, split by paper.
 * A carrier with dsg_allowed = 1 grants the state DS&G on that carrier's paper:
 * "Admitted AL DS&G" when the carrier is a live admitted carrier (R.admittedIds),
 * "Non-Admitted AL DS&G" otherwise. Florida writes DS&G through Accredited 2025
 * Admitted only, so it is Admitted DS&G and NOT non-admitted (2026-09-15).
 * A state with no DS&G carrier reads "N/A" on both.
 */
const DSG_FIELDS = ["Admitted AL DS&G", "Non-Admitted AL DS&G"];
function computeDsgEligibility(dbResults, R) {
  const stateDsgStatus = {};
  for (const row of dbResults) {
    const stateCode = row.code;
    if (!stateCode) continue;
    if (!(stateCode in stateDsgStatus)) {
      stateDsgStatus[stateCode] = { "Admitted AL DS&G": "N/A", "Non-Admitted AL DS&G": "N/A" };
    }
    if (row.dsg_allowed === 1 || row.dsg_allowed === true) {
      const field = R.admittedIds.includes(row.id) ? "Admitted AL DS&G" : "Non-Admitted AL DS&G";
      stateDsgStatus[stateCode][field] = "Y";
    }
  }
  return stateDsgStatus;
}

// True when a state's DS&G entry says DS&G is written there on any paper. Accepts
// the split object above and the plain "Y"/"N/A" string older pending files carry.
function dsgEnabled(entry) {
  if (entry === "Y") return true;
  return !!entry && typeof entry === "object" && DSG_FIELDS.some(f => entry[f] === "Y");
}

/**
 * Compute Admitted AL eligibility per state from the live admitted carriers
 * (R.admittedIds — Everspan Admitted MunichRe and, since 2026-09-14, Accredited 2025
 * Admitted). Any of them active in a state gives that state Admitted AL, Hotshots,
 * and UIIA. Exception: FL has Admitted AL UIIA as N/A.
 */
function computeAdmittedALEligibility(dbResults, R) {
  const stateAdmittedStatus = {};
  for (const row of dbResults) {
    const stateCode = row.code;
    if (!stateCode) continue;
    if (R.admittedIds.includes(row.id) && (row.active === 1 || row.active === true)) {
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
function detectChanges(oldRows, newRows, R) {
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
    const carrierName = R.keyById[newRow.company_id] || newRow.company_name;

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
      const carrierName = R.keyById[oldRow.company_id] || oldRow.company_name;
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
 * Build the general-channel message body (Block Kit blocks) for a detection payload.
 * Pure — no I/O — so the content is under test; sendSlackNotification wraps it.
 *
 * The channel gets exactly three kinds of content (2026-09-15), each its own section
 * and each omitted when empty:
 *   1. Carrier eligibility changes  — a carrier going live/retired, and a non-admitted
 *                                     carrier enabled or disabled in a state
 *   2. Permitted AL Operations changes — an admitted carrier enabled or disabled in a
 *                                     state (the Admitted AL line), DS&G by paper
 *   3. Carriers set to 0% on the lottery — drops to 0% only
 * Deliberately NOT posted: other lottery weight movements, the standing 0% list,
 * monitor health, unnamed carriers. The site shows the standing state; the channel
 * is told what changed.
 */
const SECTION_LINE_CAP = 15;

function section(title, lines, tail) {
  const shown = lines.slice(0, SECTION_LINE_CAP);
  if (lines.length > SECTION_LINE_CAP) shown.push(`• ... and ${lines.length - SECTION_LINE_CAP} more`);
  const text = `*${title}:*\n${shown.join('\n')}${tail ? `\n${tail}` : ''}`;
  return { type: "section", text: { type: "mrkdwn", text } };
}

function buildSlackBlocks(payload) {
  const { changes = [], admittedALEligibility, registry } = payload || {};
  const R = registryIndex(registry);
  // A legacy pending file carries no registry; fall back to the raw key.
  const displayOf = key => R.displayByKey[key] || key;
  const paperOf = key => (R.admittedKeys.has(key) ? 'Admitted' : 'Non-Admitted');

  const blocks = [{
    type: "header",
    text: { type: "plain_text", text: "🔔 Carrier Eligibility Update", emoji: true }
  }];

  // 1. Carrier eligibility changes
  const eligibilityLines = [];
  for (const c of changes.filter(c => c.type === 'CARRIER')) {
    if (c.newValue === 'live') eligibilityLines.push(`🆕 ${displayOf(c.carrier)} is now live${c.oldValue === 'pre-launch' ? ' (launched)' : ''}`);
    else if (c.newValue === 'retired') eligibilityLines.push(`⊗ ${displayOf(c.carrier)} is no longer writing business`);
    else eligibilityLines.push(`• ${displayOf(c.carrier)}: ${c.oldValue || 'new'} → ${c.newValue}`);
  }
  const activeChanges = changes.filter(c => c.type === 'ACTIVE');
  for (const c of activeChanges.filter(c => !R.admittedKeys.has(c.carrier))) {
    eligibilityLines.push(`• ${c.state} - ${displayOf(c.carrier)}: ${c.newValue ? 'enabled ✅' : 'disabled ❌'}`);
  }
  if (eligibilityLines.length > 0) blocks.push(section('Carrier eligibility changes', eligibilityLines));

  // 2. Permitted AL Operations changes
  const opsLines = [];
  for (const c of activeChanges.filter(c => R.admittedKeys.has(c.carrier))) {
    opsLines.push(`• ${c.state}: Admitted AL ${c.newValue ? 'now available ✅' : 'no longer available ❌'} (${displayOf(c.carrier)})`);
  }
  for (const c of changes.filter(c => c.type === 'DSG')) {
    opsLines.push(`• ${c.state}: ${paperOf(c.carrier)} DS&G ${c.newValue ? 'enabled ✅' : 'disabled ❌'} (${displayOf(c.carrier)})`);
  }
  if (opsLines.length > 0) {
    let tail = '';
    if (admittedALEligibility) {
      const count = Object.values(admittedALEligibility).filter(v => v && v["Admitted AL"] === "Y").length;
      tail = `Admitted AL is now permitted in ${count} states`;
    }
    blocks.push(section('Permitted AL Operations changes', opsLines, tail));
  }

  // 3. Drops to 0% — a carrier can stay enabled to quote while its weight drops to
  // 0%, which no active/DSG signal above would surface. Other weight movements are
  // routine rebalancing and are not posted; they still sync the site.
  const zeroLines = changes
    .filter(c => c.type === 'LOTTERY' && c.zeroed)
    .map(c => `• ${c.state} - ${displayOf(c.carrier)}: ${formatLotteryValue(c.oldValue)} → *0%* ⚖️`);
  if (zeroLines.length > 0) blocks.push(section('Carriers set to 0% on the lottery (still enabled to quote)', zeroLines));

  blocks.push({
    type: "section",
    text: { type: "mrkdwn", text: `<${TOOL_URL}|View Coverages by State Tool>` }
  });
  return blocks;
}

/**
 * Operator-only sections: monitor health and carriers shown under a fallback name.
 * These go to the approval DM and never to the general channel — the channel is
 * told what carriers can do, not how this tool is doing. Empty when nothing to say.
 */
function buildMonitorBlocks(payload) {
  const { registry, staleness } = payload || {};
  const blocks = [];

  const unnamed = unnamedCarriers(registry);
  if (unnamed.length > 0) {
    const lines = unnamed.map(c =>
      `• \`${c.id}\` shown as "${c.display}" — ${c.status}, active in ${c.activeStates} state${c.activeStates === 1 ? '' : 's'}`
    );
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        text: `:label: *Carrier shown with a fallback name:*\n${lines.join('\n')}\n_Already on the site and in the channel post. Add it to CURATED_CARRIERS in check-eligibility.js to give it a proper name._`
      }
    });
  }

  // Monitor health — a gap means the tool was showing stale data for that window
  if (staleness && (staleness.level === 'warn' || staleness.level === 'error')) {
    const icon = staleness.level === 'error' ? ':rotating_light:' : ':warning:';
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `${icon} *Monitor health:* ${staleness.message}` }
    });
  }

  return blocks;
}

// Header + tool link are always present; anything more is real content.
function hasChannelContent(channelBlocks) {
  return channelBlocks.length > 2;
}

/**
 * The blocks actually posted, by audience. Approved → the general channel gets the
 * channel blocks and nothing else. Otherwise the operator gets a preview of exactly
 * that post plus the approval instructions, with the monitor notes appended OUTSIDE
 * the preview; an alert with nothing for the channel (a database outage) is just the
 * monitor notes, with no approval framing to approve.
 */
function composeSlackMessage(payload, approved) {
  const channelBlocks = buildSlackBlocks(payload);
  if (approved) return channelBlocks;

  const monitorBlocks = buildMonitorBlocks(payload);
  const blocks = [];

  if (hasChannelContent(channelBlocks) || monitorBlocks.length === 0) {
    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "⏳ *PENDING APPROVAL* - Review the message below before sending to the general channel:"
        }
      },
      { type: "divider" },
      ...channelBlocks,
      { type: "divider" },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "✅ To approve and send to general channel, run:\n`gh workflow run carrier-monitor.yml -f approved=true`\n\n❌ To modify, edit the message in the script and re-run."
        }
      }
    );
  }

  if (monitorBlocks.length > 0) {
    if (blocks.length > 0) blocks.push({ type: "divider" });
    blocks.push(
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: "🛠 *Monitor notes* — for you only, not part of the channel post:"
        }
      },
      ...monitorBlocks
    );
  }

  return blocks;
}

/**
 * Send a notification to Slack focusing on carrier eligibility changes
 */
function sendSlackNotification(payload) {
  return new Promise((resolve) => {
    if (!SLACK_WEBHOOK_URL) {
      console.log('No Slack webhook URL configured, skipping notification');
      resolve(false);
      return;
    }

    // Audience decides both the webhook and the content — see composeSlackMessage.
    const webhookUrl = APPROVED_MODE ? SLACK_WEBHOOK_URL : (SLACK_APPROVAL_WEBHOOK_URL || SLACK_WEBHOOK_URL);
    const messageBlocks = composeSlackMessage(payload, APPROVED_MODE);
    console.log(APPROVED_MODE ? 'Sending APPROVED message to general channel' : 'Sending message to Daniel for approval');

    if (!webhookUrl) {
      console.log('No webhook URL configured');
      resolve(false);
      return;
    }

    const message = { blocks: messageBlocks };
    const body = JSON.stringify(message);
    const url = new URL(webhookUrl);

    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
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

    req.write(body);
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
    if (!hasChannelContent(buildSlackBlocks(pending))) {
      console.log('Pending notification has nothing for the general channel under the current rules — not sending');
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

    // The carrier registry, derived from production: which carriers exist, which
    // paper they write, and whether they are live, pre-launch or retired.
    const [facts] = await connection.execute(CARRIER_FACTS_QUERY);
    const registry = buildRegistry(facts);
    const R = registryIndex(registry);
    for (const c of registry.filter(c => c.id !== null)) {
      console.log(`  carrier ${c.id} ${c.display}: ${c.status}${c.admitted ? ', admitted' : ''}, active in ${c.activeStates}, ${c.newBusiness30d} new-business submissions in ${LAUNCH_WINDOW_DAYS}d`);
    }
    const unnamed = unnamedCarriers(registry);
    for (const c of unnamed) {
      console.log(`::warning::Carrier ${c.id} is shown under a fallback name "${c.display}" — add it to CURATED_CARRIERS to name it`);
    }

    // Get current state
    const [stateRows] = await connection.execute(STATE_QUERY);
    const currentHash = computeHash(stateRows, registry);
    console.log(`Current state hash: ${currentHash}`);
    console.log(`Records: ${stateRows.length}`);

    // Heartbeat: rate limited so an hourly monitor does not commit hourly
    const heartbeatDue = shouldPersistHeartbeat(previousHeartbeat?.lastCheckedAt, now);
    if (heartbeatDue) {
      await fs.writeFile(HEARTBEAT_FILE, JSON.stringify({
        lastCheckedAt: new Date(now).toISOString(),
        trackedCarriers: R.trackedIds.length,
        unnamedCarriers: unnamed.map(c => ({ id: c.id, name: c.display })),
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
      if (unnamed.length > 0 || staleness.level === 'error') {
        await sendSlackNotification({ changes: [], registry, staleness });
      }
      await connection.end();
      if (exitCode !== 0) process.exitCode = exitCode;
      return;
    }

    console.log('Changes detected! Updating...');

    // Detect specific changes for reporting: per-state rows, then carrier-level
    // transitions (a launch) against the registry saved with the previous state.
    const changes = [
      ...detectCarrierChanges(savedState?.registry, registry),
      ...detectChanges(savedState?.data || [], stateRows, R)
    ];
    console.log(`Detected ${changes.length} specific change(s)`);
    for (const change of changes.slice(0, 10)) {
      console.log(`  - ${change.message}`);
    }
    if (changes.length > 10) {
      console.log(`  ... and ${changes.length - 10} more changes`);
    }

    // Get full data for sync
    const [fullRows] = await connection.execute(CARRIER_QUERY);
    const carrierData = processCarrierData(fullRows, R);

    // Compute DS&G eligibility
    const dsgEligibility = computeDsgEligibility(fullRows, R);
    const dsgEnabledStates = Object.entries(dsgEligibility).filter(([_, v]) => dsgEnabled(v)).map(([k]) => k);
    const admittedDsgStates = Object.entries(dsgEligibility).filter(([_, v]) => v["Admitted AL DS&G"] === "Y").map(([k]) => k);
    console.log(`DS&G enabled in ${dsgEnabledStates.length} states: ${dsgEnabledStates.join(', ')}`);
    console.log(`  on admitted paper in ${admittedDsgStates.length}: ${admittedDsgStates.join(', ') || 'none'}`);

    // Compute Admitted AL eligibility from carrier data
    const admittedALEligibility = computeAdmittedALEligibility(fullRows, R);
    const admittedALStates = Object.entries(admittedALEligibility)
      .filter(([_, v]) => v["Admitted AL"] === "Y").map(([k]) => k);
    console.log(`Admitted AL in ${admittedALStates.length} states: ${admittedALStates.join(', ')}`);

    // Compute effective AL lottery weights and the 0%-but-still-quotable set
    const lotteryData = computeLotteryData(fullRows, R);
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

    // Push the derived registry into the page so the UI's carrier cards and filter
    // buttons follow production — a new carrier needs no edit anywhere.
    html = replaceDataBlock(html, 'carrierRegistry', registry);
    console.log('Updated carrierRegistry');

    // Update lobOpsData for DS&G eligibility and Admitted AL
    const lobPattern = dataBlockPattern('lobOpsData');
    const lobMatch = html.match(lobPattern);

    if (lobMatch) {
      try {
        const lobData = JSON.parse(lobMatch[1]);
        let lobUpdated = false;

        // Update DS&G fields, one per paper
        for (const [stateCode, dsgStatus] of Object.entries(dsgEligibility)) {
          if (lobData[stateCode]) {
            for (const field of DSG_FIELDS) {
              const current = lobData[stateCode][field];
              if (current !== dsgStatus[field]) {
                console.log(`  ${field}: ${stateCode} ${current} → ${dsgStatus[field]}`);
                lobData[stateCode][field] = dsgStatus[field];
                lobUpdated = true;
              }
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
      registry,
      data: stateRows
    }, null, 2));

    console.log('Files updated successfully');

    const notification = {
      detectedAt: new Date().toISOString(),
      changes,
      registry,
      dsgEligibility,
      admittedALEligibility,
      zeroLotteryCarriers,
      staleness
    };

    // A hash change with no reportable change (the first run after the change signal
    // gains a field) must not post an empty update — nor overwrite a pending
    // notification that is still waiting for approval. A staleness gap or an unnamed
    // carrier is worth telling the operator on its own.
    const channelHasContent = hasChannelContent(buildSlackBlocks(notification));
    const hasSomethingToSay = channelHasContent || unnamed.length > 0 || staleness.level === 'error';
    if (channelHasContent) {
      // Saved so the approval run can replay it without re-querying the database
      await fs.writeFile('pending_notification.json', JSON.stringify(notification, null, 2));
      console.log('Saved pending_notification.json for approval replay');
    }
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
  CURATED_CARRIERS,
  LEGACY_CARRIERS,
  LAUNCH_WINDOW_DAYS,
  CARRIER_FACTS_QUERY,
  deriveCarrierStatus,
  buildRegistry,
  registryIndex,
  unnamedCarriers,
  detectCarrierChanges,
  computeHash,
  normalizeLottery,
  processCarrierData,
  computeLotteryData,
  findZeroLotteryCarriers,
  evaluateStaleness,
  shouldPersistHeartbeat,
  computeDsgEligibility,
  DSG_FIELDS,
  computeAdmittedALEligibility,
  buildSlackBlocks,
  buildMonitorBlocks,
  composeSlackMessage,
  hasChannelContent,
  sendSlackNotification,
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
