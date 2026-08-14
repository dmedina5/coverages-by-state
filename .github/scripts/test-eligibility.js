/**
 * Self-tests for the pure logic in check-eligibility.js.
 *
 * No dependencies, no database — run with:  node .github/scripts/test-eligibility.js
 * The carrier-monitor workflow runs this before touching the database, so a
 * regression in the sync logic fails loudly instead of silently rewriting index.html.
 */
const assert = require('assert');
const {
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
  detectChanges,
  formatLotteryValue,
  dataBlockPattern
} = require('./check-eligibility');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    process.exitCode = 1;
  }
}

// Row shape from CARRIER_QUERY (id/code/active/lottery_al)
const carrierRow = (id, code, active, lottery) => ({ id, code, active, lottery_al: lottery, dsg_allowed: 0 });
// Row shape from STATE_QUERY (company_id/state_code/active/lottery_al)
const stateRow = (company_id, state_code, active, lottery, dsg_allowed = 0) =>
  ({ company_id, state_code, active, lottery_al: lottery, dsg_allowed, company_name: 'X' });

console.log('normalizeLottery');
test('null and undefined collapse to null', () => {
  assert.strictEqual(normalizeLottery(null), null);
  assert.strictEqual(normalizeLottery(undefined), null);
  assert.strictEqual(normalizeLottery(''), null);
});
test('0 stays 0 and is not confused with null', () => {
  assert.strictEqual(normalizeLottery(0), 0);
  assert.strictEqual(normalizeLottery('0'), 0);
});
test('numeric strings are coerced', () => {
  assert.strictEqual(normalizeLottery('35'), 35);
});

console.log('computeLotteryData');
test('records the effective weight for active tracked carriers', () => {
  const data = computeLotteryData([
    carrierRow(5245, 'TX', 1, 35),
    carrierRow(6155, 'TX', 1, 0)
  ]);
  assert.deepStrictEqual(data, {
    TX: { 'Accredited Non-Admitted 1st': 35, 'Everspan Non-Admitted MunichRe': 0 }
  });
});
test('skips inactive carriers so 0% never means "turned off"', () => {
  const data = computeLotteryData([
    carrierRow(6155, 'NY', 0, null),
    carrierRow(6155, 'TX', 1, 0)
  ]);
  assert.deepStrictEqual(data, { TX: { 'Everspan Non-Admitted MunichRe': 0 } });
});
test('skips carriers outside the tracked mapping', () => {
  assert.deepStrictEqual(computeLotteryData([carrierRow(999, 'TX', 1, 50)]), {});
});
test('skips rows with no state code', () => {
  assert.deepStrictEqual(computeLotteryData([carrierRow(6155, null, 1, 0)]), {});
});

console.log('findZeroLotteryCarriers');
test('returns only the 0% carriers, per state, sorted', () => {
  const zero = findZeroLotteryCarriers({
    TX: { 'Accredited Non-Admitted 1st': 35, 'Everspan Non-Admitted MunichRe': 0 },
    MI: { 'Everspan Non-Admitted MunichRe': 0, 'Accredited Non-Admitted 1st': 0 },
    FL: { 'Everspan Admitted MunichRe': 100 }
  });
  assert.deepStrictEqual(zero, {
    MI: ['Accredited Non-Admitted 1st', 'Everspan Non-Admitted MunichRe'],
    TX: ['Everspan Non-Admitted MunichRe']
  });
  assert.ok(!('FL' in zero), 'states with no 0% carrier are omitted');
});

console.log('computeHash');
test('a lottery-only change moves the hash', () => {
  const before = computeHash([stateRow(6155, 'TX', 1, 35)]);
  const after = computeHash([stateRow(6155, 'TX', 1, 0)]);
  assert.notStrictEqual(before, after, 'lottery must be part of the change signal');
});
test('identical rows in a different order hash the same', () => {
  const a = computeHash([stateRow(6155, 'TX', 1, 0), stateRow(5245, 'TX', 1, 35)]);
  const b = computeHash([stateRow(5245, 'TX', 1, 35), stateRow(6155, 'TX', 1, 0)]);
  assert.strictEqual(a, b);
});

console.log('detectChanges');
test('flags a carrier dropped to 0% while still enabled', () => {
  const changes = detectChanges(
    [stateRow(6155, 'TX', 1, 35)],
    [stateRow(6155, 'TX', 1, 0)]
  );
  const lottery = changes.filter(c => c.type === 'LOTTERY');
  assert.strictEqual(lottery.length, 1);
  assert.strictEqual(lottery[0].zeroed, true);
  assert.strictEqual(lottery[0].newValue, 0);
  assert.match(lottery[0].message, /lottery 35% → 0%/);
});
test('a 0% carrier that is also disabled is not reported as zeroed', () => {
  const changes = detectChanges(
    [stateRow(6155, 'TX', 1, 35)],
    [stateRow(6155, 'TX', 0, null)]
  );
  const lottery = changes.filter(c => c.type === 'LOTTERY');
  assert.strictEqual(lottery.length, 1);
  assert.strictEqual(lottery[0].zeroed, false, 'a disabled carrier is an ACTIVE change, not a 0% one');
  assert.ok(changes.some(c => c.type === 'ACTIVE'));
});
test('flags a carrier restored off 0%', () => {
  const changes = detectChanges(
    [stateRow(6155, 'TX', 1, 0)],
    [stateRow(6155, 'TX', 1, 20)]
  );
  const lottery = changes.filter(c => c.type === 'LOTTERY');
  assert.strictEqual(lottery[0].restored, true);
  assert.strictEqual(lottery[0].zeroed, false);
});
test('state saved before lottery tracking does not report the whole book as changed', () => {
  // Legacy monitor_state.json rows carry no lottery_al key at all.
  const legacy = [{ company_id: 6155, state_code: 'TX', active: 1, dsg_allowed: 0 }];
  const changes = detectChanges(legacy, [stateRow(6155, 'TX', 1, 0)]);
  assert.deepStrictEqual(changes.filter(c => c.type === 'LOTTERY'), []);
});
test('an unchanged lottery produces no change', () => {
  const changes = detectChanges([stateRow(6155, 'TX', 1, 0)], [stateRow(6155, 'TX', 1, 0)]);
  assert.deepStrictEqual(changes, []);
});

console.log('formatLotteryValue');
test('null renders as not-enabled rather than 0%', () => {
  assert.strictEqual(formatLotteryValue(null), 'n/a (not enabled)');
  assert.strictEqual(formatLotteryValue(0), '0%');
});

console.log('CARRIER_REGISTRY');
test('every entry has a unique key and display name', () => {
  const keys = CARRIER_REGISTRY.map(c => c.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'duplicate carrier key');
  const displays = CARRIER_REGISTRY.map(c => c.display);
  assert.strictEqual(new Set(displays).size, displays.length, 'duplicate display name');
});
test('every entry has a recognised status', () => {
  for (const c of CARRIER_REGISTRY) {
    assert.ok(['live', 'pre-launch', 'retired'].includes(c.status), `${c.key} has status ${c.status}`);
  }
});
test('tracked ids are exactly the live + pre-launch carriers with a company id', () => {
  const expected = CARRIER_REGISTRY.filter(c => c.id !== null && c.status !== 'retired').map(c => c.id);
  assert.deepStrictEqual(TRACKED_COMPANY_IDS.slice().sort(), expected.slice().sort());
  assert.ok(TRACKED_COMPANY_IDS.includes(6881), 'the pre-launch carrier is still monitored');
});
test('retired carriers supply a default status and are not queried', () => {
  for (const c of CARRIER_REGISTRY.filter(c => c.status === 'retired')) {
    assert.ok(c.defaultStatus, `${c.key} needs a defaultStatus`);
    assert.ok(!TRACKED_COMPANY_IDS.includes(c.id), `${c.key} must not be queried`);
    assert.ok(!(c.id in COMPANY_ID_MAPPING), `${c.key} must not map a company id`);
    assert.ok(c.key in DEFAULT_CARRIER_STATUS);
  }
});

console.log('pre-launch carriers never read as available');
test('an active pre-launch row is not reported as "Y"', () => {
  const data = processCarrierData([
    carrierRow(6881, 'FL', 1, 100),
    carrierRow(6156, 'FL', 1, 100)
  ]);
  assert.strictEqual(data.FL['Accredited 2025 Admitted'], 'pre-launch',
    'active=1 in the DB must not mean quotable for a launch-gated carrier');
  assert.strictEqual(data.FL['Everspan Admitted MunichRe'], 'Y');
});
test('the pre-launch carrier is in the non-quotable set', () => {
  assert.ok(NON_QUOTABLE_KEYS.has('Accredited 2025 Admitted'));
  assert.ok(!NON_QUOTABLE_KEYS.has('Everspan Non-Admitted MunichRe'));
});

console.log('findUntrackedCarriers');
const discoveryRow = (id, name, active_states, codes) =>
  ({ id, name, state_rows: active_states, active_states, active_state_codes: codes });
test('a carrier absent from the registry is reported', () => {
  const found = findUntrackedCarriers([
    discoveryRow(6155, 'Everspan Indemnity Insurance Company', 31, 'AL,AR'),
    discoveryRow(9999, 'Brand New Carrier Co', 2, 'TX,OK')
  ]);
  assert.strictEqual(found.length, 1);
  assert.deepStrictEqual(found[0], { id: 9999, name: 'Brand New Carrier Co', activeStates: 2, stateCodes: ['TX', 'OK'] });
});
test('every registry carrier is considered known, including retired and pre-launch', () => {
  const rows = CARRIER_REGISTRY.filter(c => c.id !== null).map(c => discoveryRow(c.id, c.key, 1, 'TX'));
  assert.deepStrictEqual(findUntrackedCarriers(rows), []);
});
test('a missing state-code list does not crash', () => {
  const found = findUntrackedCarriers([discoveryRow(9999, 'X', 1, null)]);
  assert.deepStrictEqual(found[0].stateCodes, []);
});

console.log('evaluateStaleness');
const HOUR = 3600000;
const T0 = new Date('2026-08-14T12:00:00Z').getTime();
const hoursAgo = h => new Date(T0 - h * HOUR).toISOString();
test('a recent check is ok', () => {
  assert.strictEqual(evaluateStaleness(hoursAgo(1), T0).level, 'ok');
});
test('past the warn threshold it warns', () => {
  assert.strictEqual(evaluateStaleness(hoursAgo(7), T0).level, 'warn');
});
test('past the error threshold it errors', () => {
  const r = evaluateStaleness(hoursAgo(30), T0);
  assert.strictEqual(r.level, 'error');
  assert.strictEqual(r.hours, 30);
  assert.match(r.message, /stale/);
});
test('thresholds sit above the heartbeat interval, so a healthy monitor never alarms', () => {
  // Heartbeat is written at most every 3h; a monitor running normally must stay 'ok'.
  assert.strictEqual(evaluateStaleness(hoursAgo(3), T0).level, 'ok');
});
test('a missing or unreadable heartbeat is unknown, not an error', () => {
  assert.strictEqual(evaluateStaleness(null, T0).level, 'unknown');
  assert.strictEqual(evaluateStaleness('not-a-date', T0).level, 'unknown');
});
test('thresholds are overridable', () => {
  assert.strictEqual(evaluateStaleness(hoursAgo(2), T0, { warnHours: 1, errorHours: 90 }).level, 'warn');
});

console.log('shouldPersistHeartbeat');
test('writes on the first run', () => {
  assert.strictEqual(shouldPersistHeartbeat(null, T0), true);
});
test('does not rewrite inside the rate-limit window', () => {
  assert.strictEqual(shouldPersistHeartbeat(hoursAgo(1), T0, 180), false);
});
test('rewrites once the window has passed', () => {
  assert.strictEqual(shouldPersistHeartbeat(hoursAgo(4), T0, 180), true);
});
test('an unreadable previous heartbeat forces a rewrite', () => {
  assert.strictEqual(shouldPersistHeartbeat('garbage', T0, 180), true);
});

console.log('dataBlockPattern');
test('matches a plain object block', () => {
  const html = `    const carrierData = {"TX":{"a":"Y"}};\n    const other = 1;`;
  assert.deepStrictEqual(JSON.parse(html.match(dataBlockPattern('carrierData'))[1]), { TX: { a: 'Y' } });
});
test('matches a block whose values contain semicolons', () => {
  // Regression: a carrier note contains "; continues to endorse...". The previous
  // [^;]+ pattern could not span it, so the sync aborted on a block it could not find.
  const value = [{ key: 'K', note: 'Turned off; still endorses existing policies.' }];
  const html = `    const carrierRegistry = ${JSON.stringify(value)};\n`;
  const m = html.match(dataBlockPattern('carrierRegistry'));
  assert.ok(m, 'pattern must match a value containing a semicolon');
  assert.deepStrictEqual(JSON.parse(m[1]), value);
});
test('does not run past the end of its own line', () => {
  const html = `    const a = {"x":1};\n    const b = {"y":2};\n`;
  assert.deepStrictEqual(JSON.parse(html.match(dataBlockPattern('a'))[1]), { x: 1 });
  assert.deepStrictEqual(JSON.parse(html.match(dataBlockPattern('b'))[1]), { y: 2 });
});
test('a similarly-named block does not match', () => {
  const html = `    const carrierLotteryData = {"TX":{"a":0}};\n`;
  assert.strictEqual(html.match(dataBlockPattern('carrierData')), null);
});
test('every block the sync rewrites is findable in the real index.html', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '../../index.html'), 'utf-8');
  for (const name of ['carrierData', 'carrierLotteryData', 'carrierRegistry', 'lobOpsData']) {
    const m = html.match(dataBlockPattern(name));
    assert.ok(m, `${name} not found in index.html`);
    assert.doesNotThrow(() => JSON.parse(m[1]), `${name} is not valid JSON`);
  }
});
test('the registry in index.html matches the registry in this script', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '../../index.html'), 'utf-8');
  const inPage = JSON.parse(html.match(dataBlockPattern('carrierRegistry'))[1]);
  assert.deepStrictEqual(inPage, CARRIER_REGISTRY);
});

console.log(`\n${passed} passed${process.exitCode ? ' — FAILURES ABOVE' : ''}`);
