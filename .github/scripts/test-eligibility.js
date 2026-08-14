/**
 * Self-tests for the pure logic in check-eligibility.js.
 *
 * No dependencies, no database — run with:  node .github/scripts/test-eligibility.js
 * The carrier-monitor workflow runs this before touching the database, so a
 * regression in the sync logic fails loudly instead of silently rewriting index.html.
 */
const assert = require('assert');
const {
  computeHash,
  normalizeLottery,
  computeLotteryData,
  findZeroLotteryCarriers,
  detectChanges,
  formatLotteryValue
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

console.log(`\n${passed} passed${process.exitCode ? ' — FAILURES ABOVE' : ''}`);
