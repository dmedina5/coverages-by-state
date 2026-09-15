/**
 * Self-tests for the pure logic in check-eligibility.js.
 *
 * No dependencies, no database — run with:  node .github/scripts/test-eligibility.js
 * The carrier-monitor workflow runs this before touching the database, so a
 * regression in the sync logic fails loudly instead of silently rewriting index.html.
 */
const assert = require('assert');
const {
  CURATED_CARRIERS,
  LEGACY_CARRIERS,
  LAUNCH_WINDOW_DAYS,
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

// Row shape from CARRIER_FACTS_QUERY. Mirrors prod on 2026-09-15.
const fact = (id, name, regulation, active_states, new_business_30d, first_new_business) =>
  ({ id, name, regulation, active_states, new_business_30d, first_new_business });
const FACTS = [
  fact(61,   'Knight Specialty Insurance Company',        'Non-Admited', 0,  0,    '2020-09-23 01:40:46'),
  fact(5245, 'Accredited Specialty Insurance Company',    'Undefined',   33, 3407, '2022-07-18 22:48:54'),
  fact(5696, 'Ascot Specialty Insurance Company',         'Undefined',   11, 1407, '2022-03-01 00:08:52'),
  fact(6155, 'MUNICH RE - 100% Reinsurance Provider | x', 'Non-Admited', 31, 7405, '2022-07-10 04:00:25'),
  fact(6156, 'MUNICH RE - 100% Reinsurance Provider | y', 'Admitted',    7,  4652, '2022-10-17 22:18:57'),
  fact(6607, 'Accredited Specialty Insurance Company',    'Undefined',   34, 7156, '2023-09-17 04:09:34'),
  fact(6881, 'Accredited Surety and Casualty Company, Inc.', 'Admitted', 1,  52,   '2026-09-14 20:39:13')
];
const REG = buildRegistry(FACTS);
const R = registryIndex(REG);

// Row shape from CARRIER_QUERY (id/code/active/lottery_al)
const carrierRow = (id, code, active, lottery) => ({ id, code, active, lottery_al: lottery, dsg_allowed: 0 });
// Row shape from STATE_QUERY (company_id/state_code/active/lottery_al)
const stateRow = (company_id, state_code, active, lottery, dsg_allowed = 0) =>
  ({ company_id, state_code, active, lottery_al: lottery, dsg_allowed, company_name: 'X' });

console.log('deriveCarrierStatus — status comes from production evidence, not a hand-set flag');
test('writing new business in the launch window is live', () => {
  assert.strictEqual(deriveCarrierStatus(fact(6881, 'x', 'Admitted', 1, 52, '2026-09-14')), 'live');
});
test('active somewhere with no new business ever is pre-launch (the 6881 shape before 2026-09-14)', () => {
  assert.strictEqual(deriveCarrierStatus(fact(6881, 'x', 'Admitted', 1, 0, null)), 'pre-launch');
});
test('active somewhere, quiet this window, but with history is still live', () => {
  assert.strictEqual(deriveCarrierStatus(fact(5696, 'x', 'Undefined', 11, 0, '2022-03-01')), 'live');
});
test('active nowhere and not writing is retired', () => {
  assert.strictEqual(deriveCarrierStatus(fact(61, 'x', 'Non-Admited', 0, 0, '2020-09-23')), 'retired');
  assert.strictEqual(deriveCarrierStatus(fact(9, 'x', 'Undefined', 0, 0, null)), 'retired');
});
test('counts arrive as strings from MySQL and still work', () => {
  assert.strictEqual(deriveCarrierStatus(fact(6881, 'x', 'Admitted', '1', '52', '2026-09-14')), 'live');
  assert.strictEqual(deriveCarrierStatus(fact(6881, 'x', 'Admitted', '1', '0', null)), 'pre-launch');
});

console.log('buildRegistry');
test('legacy carriers come first, then curated carriers in curated order', () => {
  const keys = REG.map(c => c.key);
  assert.deepStrictEqual(keys.slice(0, 2), LEGACY_CARRIERS.map(c => c.key));
  assert.deepStrictEqual(keys.slice(2), CURATED_CARRIERS.map(c => c.key));
});
test('admitted comes from companies.regulation', () => {
  assert.deepStrictEqual(REG.filter(c => c.admitted && c.id !== null).map(c => c.id).sort(), [6156, 6881]);
  assert.strictEqual(REG.find(c => c.id === 6155).admitted, false, 'Non-Admited is not admitted');
  assert.strictEqual(REG.find(c => c.id === 5245).admitted, false, 'Undefined is not admitted');
});
test('the launched carrier is live, named, and quotable', () => {
  const e = REG.find(c => c.id === 6881);
  assert.strictEqual(e.status, 'live');
  assert.strictEqual(e.display, 'Accredited Admitted (2025 Program)');
  assert.strictEqual(e.curated, true);
  assert.ok(!R.nonQuotableKeys.has(e.key));
});
test('a retired curated carrier keeps its curated default status and note', () => {
  const e = REG.find(c => c.id === 61);
  assert.strictEqual(e.status, 'retired');
  assert.strictEqual(e.defaultStatus, 'turned off permanently');
  assert.ok(e.note);
});
test('a carrier the curated map does not know is still included, named from production', () => {
  const reg = buildRegistry([...FACTS, fact(9999, 'Brand New Carrier Co', 'Admitted', 2, 40, '2026-10-01')]);
  const e = reg.find(c => c.id === 9999);
  assert.ok(e, 'unknown carriers are not dropped');
  assert.strictEqual(e.status, 'live');
  assert.strictEqual(e.admitted, true);
  assert.strictEqual(e.curated, false);
  assert.strictEqual(e.display, 'Brand New Carrier Co (Admitted) #9999');
  assert.strictEqual(reg[reg.length - 1].id, 9999, 'unknown carriers render after the curated ones');
});
test('a fallback name uses the part before the pipe and stays unique by id', () => {
  const reg = buildRegistry([
    fact(9001, 'Accredited Specialty Insurance Company', 'Undefined', 1, 1, '2026-01-01'),
    fact(9002, 'Accredited Specialty Insurance Company', 'Undefined', 1, 1, '2026-01-01'),
    fact(9003, 'MUNICH RE - 100% Reinsurance Provider | A.M. Best A+ • Everspan', 'Non-Admited', 1, 1, '2026-01-01')
  ]);
  const keys = reg.map(c => c.key);
  assert.strictEqual(new Set(keys).size, keys.length, 'duplicate carrier key');
  assert.strictEqual(reg.find(c => c.id === 9003).display, 'MUNICH RE - 100% Reinsurance Provider (Non-Admitted) #9003');
});
test('a retired unknown carrier reads as turned off, never permanently', () => {
  const reg = buildRegistry([fact(9999, 'Gone Co', 'Undefined', 0, 0, '2024-01-01')]);
  assert.strictEqual(reg.find(c => c.id === 9999).defaultStatus, 'turned off');
});
test('every entry has a unique key and display name and a recognised status', () => {
  const keys = REG.map(c => c.key);
  assert.strictEqual(new Set(keys).size, keys.length);
  const displays = REG.map(c => c.display);
  assert.strictEqual(new Set(displays).size, displays.length);
  for (const c of REG) assert.ok(['live', 'pre-launch', 'retired'].includes(c.status), `${c.key}: ${c.status}`);
});
test('the registry is deterministic for the same facts', () => {
  assert.deepStrictEqual(buildRegistry(FACTS), REG);
});

console.log('registryIndex');
test('tracked ids are the live + pre-launch carriers with a company id', () => {
  assert.deepStrictEqual([...R.trackedIds].sort(), [5245, 5696, 6155, 6156, 6607, 6881]);
  assert.ok(!R.trackedIds.includes(61), 'retired carriers are not queried');
});
test('retired carriers supply a default status and no id mapping', () => {
  for (const c of REG.filter(c => c.status === 'retired')) {
    assert.ok(c.defaultStatus, `${c.key} needs a defaultStatus`);
    assert.ok(!(c.id in R.keyById), `${c.key} must not map a company id`);
    assert.ok(c.key in R.defaults);
  }
});
test('admitted ids and keys are the live admitted carriers', () => {
  assert.deepStrictEqual(R.admittedIds.slice().sort(), [6156, 6881]);
  assert.deepStrictEqual([...R.admittedKeys].sort(), ['Accredited 2025 Admitted', 'Everspan Admitted MunichRe']);
});
test('a pre-launch admitted carrier is not an admitted-line carrier', () => {
  const r = registryIndex(buildRegistry(FACTS.map(f => f.id === 6881 ? fact(6881, f.name, 'Admitted', 1, 0, null) : f)));
  assert.deepStrictEqual(r.admittedIds, [6156]);
  assert.ok(r.nonQuotableKeys.has('Accredited 2025 Admitted'));
});

console.log('unnamedCarriers');
test('lists the carriers rendered with a fallback name', () => {
  const reg = buildRegistry([...FACTS, fact(9999, 'Brand New Carrier Co', 'Admitted', 2, 40, '2026-10-01')]);
  assert.deepStrictEqual(unnamedCarriers(reg).map(c => c.id), [9999]);
  assert.deepStrictEqual(unnamedCarriers(REG), []);
});

console.log('detectCarrierChanges');
test('a carrier going from pre-launch to live is a CARRIER change', () => {
  const before = buildRegistry(FACTS.map(f => f.id === 6881 ? fact(6881, f.name, 'Admitted', 1, 0, null) : f));
  const changes = detectCarrierChanges(before, REG);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].type, 'CARRIER');
  assert.strictEqual(changes[0].carrier, 'Accredited 2025 Admitted');
  assert.strictEqual(changes[0].oldValue, 'pre-launch');
  assert.strictEqual(changes[0].newValue, 'live');
});
test('a carrier appearing for the first time is a CARRIER change from nothing', () => {
  const after = buildRegistry([...FACTS, fact(9999, 'Brand New Carrier Co', 'Admitted', 2, 40, '2026-10-01')]);
  const changes = detectCarrierChanges(REG, after);
  assert.strictEqual(changes.length, 1);
  assert.strictEqual(changes[0].oldValue, null);
  assert.strictEqual(changes[0].newValue, 'live');
});
test('no previous registry (state saved before registries were derived) reports nothing', () => {
  assert.deepStrictEqual(detectCarrierChanges(undefined, REG), []);
  assert.deepStrictEqual(detectCarrierChanges(null, REG), []);
});
test('an unchanged registry reports nothing', () => {
  assert.deepStrictEqual(detectCarrierChanges(REG, buildRegistry(FACTS)), []);
});

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
  ], R);
  assert.deepStrictEqual(data, {
    TX: { 'Accredited Non-Admitted 1st': 35, 'Everspan Non-Admitted MunichRe': 0 }
  });
});
test('skips inactive carriers so 0% never means "turned off"', () => {
  const data = computeLotteryData([
    carrierRow(6155, 'NY', 0, null),
    carrierRow(6155, 'TX', 1, 0)
  ], R);
  assert.deepStrictEqual(data, { TX: { 'Everspan Non-Admitted MunichRe': 0 } });
});
test('skips carriers outside the tracked mapping', () => {
  assert.deepStrictEqual(computeLotteryData([carrierRow(999, 'TX', 1, 50)], R), {});
});
test('skips rows with no state code', () => {
  assert.deepStrictEqual(computeLotteryData([carrierRow(6155, null, 1, 0)], R), {});
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
  const before = computeHash([stateRow(6155, 'TX', 1, 35)], REG);
  const after = computeHash([stateRow(6155, 'TX', 1, 0)], REG);
  assert.notStrictEqual(before, after, 'lottery must be part of the change signal');
});
test('identical rows in a different order hash the same', () => {
  const a = computeHash([stateRow(6155, 'TX', 1, 0), stateRow(5245, 'TX', 1, 35)], REG);
  const b = computeHash([stateRow(5245, 'TX', 1, 35), stateRow(6155, 'TX', 1, 0)], REG);
  assert.strictEqual(a, b);
});
test('a carrier status change moves the hash even when no state row changed', () => {
  const rows = [stateRow(6881, 'FL', 1, 100)];
  const before = buildRegistry(FACTS.map(f => f.id === 6881 ? fact(6881, f.name, 'Admitted', 1, 0, null) : f));
  assert.notStrictEqual(computeHash(rows, before), computeHash(rows, REG), 'a launch must trigger a sync');
});
test('registry fields that are not status do not move the hash', () => {
  const rows = [stateRow(6881, 'FL', 1, 100)];
  const noisier = buildRegistry(FACTS.map(f => f.id === 6881 ? fact(6881, f.name, 'Admitted', 1, 500, f.first_new_business) : f));
  assert.strictEqual(computeHash(rows, noisier), computeHash(rows, REG), 'a submission count is not a change');
});

console.log('detectChanges');
test('flags a carrier dropped to 0% while still enabled', () => {
  const changes = detectChanges(
    [stateRow(6155, 'TX', 1, 35)],
    [stateRow(6155, 'TX', 1, 0)], R
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
    [stateRow(6155, 'TX', 0, null)], R
  );
  const lottery = changes.filter(c => c.type === 'LOTTERY');
  assert.strictEqual(lottery.length, 1);
  assert.strictEqual(lottery[0].zeroed, false, 'a disabled carrier is an ACTIVE change, not a 0% one');
  assert.ok(changes.some(c => c.type === 'ACTIVE'));
});
test('flags a carrier restored off 0%', () => {
  const changes = detectChanges(
    [stateRow(6155, 'TX', 1, 0)],
    [stateRow(6155, 'TX', 1, 20)], R
  );
  const lottery = changes.filter(c => c.type === 'LOTTERY');
  assert.strictEqual(lottery[0].restored, true);
  assert.strictEqual(lottery[0].zeroed, false);
});
test('state saved before lottery tracking does not report the whole book as changed', () => {
  // Legacy monitor_state.json rows carry no lottery_al key at all.
  const legacy = [{ company_id: 6155, state_code: 'TX', active: 1, dsg_allowed: 0 }];
  const changes = detectChanges(legacy, [stateRow(6155, 'TX', 1, 0)], R);
  assert.deepStrictEqual(changes.filter(c => c.type === 'LOTTERY'), []);
});
test('an unchanged lottery produces no change', () => {
  const changes = detectChanges([stateRow(6155, 'TX', 1, 0)], [stateRow(6155, 'TX', 1, 0)], R);
  assert.deepStrictEqual(changes, []);
});
test('changes name the carrier by registry key', () => {
  const changes = detectChanges([stateRow(6881, 'FL', 0, 0)], [stateRow(6881, 'FL', 1, 100)], R);
  assert.strictEqual(changes.find(c => c.type === 'ACTIVE').carrier, 'Accredited 2025 Admitted');
});

console.log('formatLotteryValue');
test('formats numbers as percentages and null as n/a', () => {
  assert.strictEqual(formatLotteryValue(35), '35%');
  assert.strictEqual(formatLotteryValue(0), '0%');
  assert.strictEqual(formatLotteryValue(null), 'n/a (not enabled)');
});

console.log('processCarrierData');
test('an active tracked row reads as available, an inactive one as turned off', () => {
  const data = processCarrierData([carrierRow(6881, 'FL', 1, 100), carrierRow(6155, 'FL', 0, 0)], R);
  assert.strictEqual(data.FL['Accredited 2025 Admitted'], 'Y');
  assert.strictEqual(data.FL['Everspan Non-Admitted MunichRe'], 'turned off');
});
test('retired carriers get their default status; unknown carriers get N/A', () => {
  const data = processCarrierData([carrierRow(6156, 'FL', 1, 100)], R);
  assert.strictEqual(data.FL['Knight Non-Admitted'], 'turned off permanently');
  assert.strictEqual(data.FL['Everspan Admitted GenRe'], 'N/A');
  assert.strictEqual(data.FL['Ascot Non-Admitted'], 'N/A');
});
test('an active pre-launch row is never reported as "Y"', () => {
  const r = registryIndex(buildRegistry(FACTS.map(f => f.id === 6881 ? fact(6881, f.name, 'Admitted', 1, 0, null) : f)));
  const data = processCarrierData([carrierRow(6881, 'FL', 1, 100), carrierRow(6156, 'FL', 1, 100)], r);
  assert.strictEqual(data.FL['Accredited 2025 Admitted'], 'pre-launch',
    'active=1 in the DB must not mean quotable for a launch-gated carrier');
  assert.strictEqual(data.FL['Everspan Admitted MunichRe'], 'Y');
});

console.log('computeAdmittedALEligibility');
test('Everspan Admitted active in a state grants Admitted AL, Hotshots and UIIA', () => {
  const data = computeAdmittedALEligibility([carrierRow(6156, 'IL', 1, 100)], R);
  assert.deepStrictEqual(data.IL, { 'Admitted AL': 'Y', 'Admitted AL Hotshots': 'Y', 'Admitted AL UIIA': 'Y' });
});
test('Accredited 2025 Admitted active in FL grants Admitted AL on its own', () => {
  const data = computeAdmittedALEligibility([carrierRow(6881, 'FL', 1, 100), carrierRow(6156, 'FL', 0, 0)], R);
  assert.deepStrictEqual(data.FL, { 'Admitted AL': 'Y', 'Admitted AL Hotshots': 'Y', 'Admitted AL UIIA': 'N/A' });
});
test('an inactive admitted carrier does not grant Admitted AL', () => {
  const data = computeAdmittedALEligibility([carrierRow(6881, 'FL', 0, 0), carrierRow(6156, 'FL', 0, 0)], R);
  assert.deepStrictEqual(data.FL, { 'Admitted AL': 'N/A', 'Admitted AL Hotshots': 'N/A', 'Admitted AL UIIA': 'N/A' });
});
test('a non-admitted carrier never grants Admitted AL', () => {
  const data = computeAdmittedALEligibility([carrierRow(6607, 'TX', 1, 65), carrierRow(5245, 'TX', 1, 35)], R);
  assert.deepStrictEqual(data.TX, { 'Admitted AL': 'N/A', 'Admitted AL Hotshots': 'N/A', 'Admitted AL UIIA': 'N/A' });
});
test('an admitted grant is not undone by a later inactive row for the same state', () => {
  const data = computeAdmittedALEligibility([carrierRow(6156, 'FL', 1, 100), carrierRow(6881, 'FL', 0, 0)], R);
  assert.strictEqual(data.FL['Admitted AL'], 'Y');
});

console.log('computeDsgEligibility — DS&G is split by paper');
const dsgRow = (id, code, active, dsg) => ({ id, code, active, lottery_al: 0, dsg_allowed: dsg });
const NONE = { 'Admitted AL DS&G': 'N/A', 'Non-Admitted AL DS&G': 'N/A' };
test('DS&G through an admitted carrier is Admitted DS&G, not Non-Admitted', () => {
  const data = computeDsgEligibility([dsgRow(6881, 'FL', 1, 1), dsgRow(6156, 'FL', 1, 0)], R);
  assert.deepStrictEqual(data.FL, { 'Admitted AL DS&G': 'Y', 'Non-Admitted AL DS&G': 'N/A' },
    'Florida writes DS&G through Accredited Admitted — the Non-Admitted banner is wrong there');
});
test('DS&G through a non-admitted carrier is Non-Admitted DS&G', () => {
  const data = computeDsgEligibility([dsgRow(5245, 'GA', 1, 1), dsgRow(5696, 'GA', 1, 1)], R);
  assert.deepStrictEqual(data.GA, { 'Admitted AL DS&G': 'N/A', 'Non-Admitted AL DS&G': 'Y' });
});
test('a state with no DS&G carrier reads N/A on both papers', () => {
  assert.deepStrictEqual(computeDsgEligibility([dsgRow(6155, 'CT', 0, 0)], R).CT, NONE);
});
test('a state with DS&G on both papers reads Y on both', () => {
  const data = computeDsgEligibility([dsgRow(6881, 'XX', 1, 1), dsgRow(6607, 'XX', 1, 1)], R);
  assert.deepStrictEqual(data.XX, { 'Admitted AL DS&G': 'Y', 'Non-Admitted AL DS&G': 'Y' });
});
test('DSG_FIELDS names both papers', () => {
  assert.deepStrictEqual(DSG_FIELDS, ['Admitted AL DS&G', 'Non-Admitted AL DS&G']);
});

console.log('Slack: the general-channel post has exactly three content sections');
const blockTexts = blocks => blocks.map(b => (b.text && b.text.text) || '').join('\n');
const lotteryChange = (state, carrier, oldValue, newValue) => ({
  type: 'LOTTERY', state, carrier, oldValue, newValue,
  zeroed: newValue === 0, restored: oldValue === 0 && newValue > 0,
  message: `${state} - ${carrier}: lottery ${oldValue}% → ${newValue}%`
});
const activeChange = (state, carrier, newValue) => ({ type: 'ACTIVE', state, carrier, oldValue: newValue ? 0 : 1, newValue,
  message: `${state} - ${carrier}: ${newValue ? 'disabled → enabled' : 'enabled → disabled'}` });
const dsgChange = (state, carrier, newValue) => ({ type: 'DSG', state, carrier, oldValue: newValue ? 0 : 1, newValue,
  message: `${state} - ${carrier}: DSG ${newValue ? 'not allowed → allowed' : 'allowed → not allowed'}` });
const carrierChange = (carrier, oldValue, newValue) => ({ type: 'CARRIER', carrier, oldValue, newValue,
  message: `${carrier}: ${oldValue || 'new'} → ${newValue}` });
const FORBIDDEN = ['Lottery weight changes', 'Currently at 0% on the lottery', 'Monitor health', 'NOT tracked', 'more lottery changes', 'DS&G is now enabled in'];
const withReg = payload => ({ registry: REG, ...payload });

test('a carrier dropping to 0% is announced under the 0% section', () => {
  const text = blockTexts(buildSlackBlocks(withReg({ changes: [lotteryChange('MI', 'Accredited Non-Admitted 1st', 35, 0)] })));
  assert.ok(text.includes('*Carriers set to 0% on the lottery (still enabled to quote):*'), text);
  assert.ok(text.includes('MI - Accredited Non-Admitted (1st): 35% → *0%*'), text);
});
test('a non-zero lottery weight change is never announced', () => {
  const text = blockTexts(buildSlackBlocks(withReg({ changes: [
    lotteryChange('AZ', 'Accredited Non-Admitted 1st', 35, 25),
    lotteryChange('AZ', 'Ascot Non-Admitted', 1, 25),
    lotteryChange('MN', 'Accredited Non-Admitted New', 0, 100)
  ] })));
  for (const f of FORBIDDEN) assert.ok(!text.includes(f), `must not contain "${f}": ${text}`);
  assert.ok(!text.includes('35% → 25%'), text);
  assert.ok(!text.includes('0% → 100%'), 'a restore is a weight change too');
});
test('a per-state enable or disable is a carrier eligibility change', () => {
  const text = blockTexts(buildSlackBlocks(withReg({ changes: [activeChange('NY', 'Everspan Non-Admitted MunichRe', 0), activeChange('TX', 'Ascot Non-Admitted', 1)] })));
  assert.ok(text.includes('*Carrier eligibility changes:*'), text);
  assert.ok(text.includes('• NY - Everspan Non-Admitted (MunichRe): disabled ❌'), text);
  assert.ok(text.includes('• TX - Ascot Non-Admitted: enabled ✅'), text);
});
test('a carrier going live is a carrier eligibility change', () => {
  const text = blockTexts(buildSlackBlocks(withReg({ changes: [carrierChange('Accredited 2025 Admitted', 'pre-launch', 'live')] })));
  assert.ok(text.includes('*Carrier eligibility changes:*'), text);
  assert.ok(text.includes('🆕 Accredited Admitted (2025 Program) is now live'), text);
});
test('admitted-carrier and DS&G toggles are Permitted AL Operations changes', () => {
  const text = blockTexts(buildSlackBlocks(withReg({
    changes: [activeChange('FL', 'Accredited 2025 Admitted', 1), dsgChange('FL', 'Accredited 2025 Admitted', 1), dsgChange('NJ', 'Accredited Non-Admitted 1st', 1)],
    admittedALEligibility: { FL: { 'Admitted AL': 'Y' }, IL: { 'Admitted AL': 'Y' }, TX: { 'Admitted AL': 'N/A' } }
  })));
  assert.ok(text.includes('*Permitted AL Operations changes:*'), text);
  assert.ok(text.includes('• FL: Admitted AL now available ✅ (Accredited Admitted (2025 Program))'), text);
  assert.ok(text.includes('• FL: Admitted DS&G enabled ✅ (Accredited Admitted (2025 Program))'), text);
  assert.ok(text.includes('• NJ: Non-Admitted DS&G enabled ✅ (Accredited Non-Admitted (1st))'), text);
  assert.ok(text.includes('Admitted AL is now permitted in 2 states'), text);
  assert.ok(!text.includes('*Carrier eligibility changes:*'), 'an admitted-carrier state toggle is an operations change, not listed twice');
});
test('the standing 0% list is gone even when the payload still carries it', () => {
  const text = blockTexts(buildSlackBlocks(withReg({ changes: [], zeroLotteryCarriers: { MI: ['Accredited Non-Admitted 1st'] } })));
  assert.ok(!text.includes('Currently at 0%'), text);
  assert.ok(!text.includes('MI'), text);
});
test('the message is header, sections in order, then the tool link', () => {
  const blocks = buildSlackBlocks(withReg({ changes: [
    lotteryChange('MI', 'Accredited Non-Admitted 1st', 35, 0),
    dsgChange('FL', 'Accredited 2025 Admitted', 1),
    activeChange('TX', 'Ascot Non-Admitted', 1)
  ] }));
  const titles = blocks.map(b => (b.text && b.text.text) || '').map(t => t.split('\n')[0]);
  assert.strictEqual(titles[0], '🔔 Carrier Eligibility Update');
  assert.deepStrictEqual(titles.slice(1, 4), [
    '*Carrier eligibility changes:*',
    '*Permitted AL Operations changes:*',
    '*Carriers set to 0% on the lottery (still enabled to quote):*'
  ]);
  assert.ok(titles[titles.length - 1].includes('Coverages by State Tool'));
  assert.strictEqual(blocks.length, 5);
});
test('a legacy pending file with no registry still renders using the raw carrier keys', () => {
  const text = blockTexts(buildSlackBlocks({ changes: [lotteryChange('MI', 'Accredited Non-Admitted 1st', 35, 0)] }));
  assert.ok(text.includes('MI - Accredited Non-Admitted 1st: 35% → *0%*'), text);
});

console.log('hasChannelContent');
test('header plus link alone is not a post', () => {
  assert.strictEqual(hasChannelContent(buildSlackBlocks(withReg({ changes: [] }))), false);
  assert.strictEqual(hasChannelContent(buildSlackBlocks(withReg({ changes: [lotteryChange('AZ', 'Ascot Non-Admitted', 1, 25)] }))), false,
    'a payload whose only change is not announced has nothing for the channel');
  assert.strictEqual(hasChannelContent(buildSlackBlocks(withReg({ changes: [lotteryChange('MI', 'Accredited Non-Admitted 1st', 35, 0)] }))), true);
});

console.log('monitor details never reach the general channel');
const staleError = { level: 'error', hours: 657.4, message: 'Monitor has not completed a successful check in 657.4h (threshold 12h) — carrier data may be stale' };
const zeroDrop = lotteryChange('MI', 'Accredited Non-Admitted 1st', 35, 0);
const REG_UNNAMED = buildRegistry([...FACTS, fact(9999, 'Brand New Carrier Co', 'Admitted', 2, 40, '2026-10-01')]);
test('the channel message carries no monitor health or unnamed-carrier section', () => {
  const text = blockTexts(buildSlackBlocks({ registry: REG_UNNAMED, changes: [zeroDrop], staleness: staleError }));
  assert.ok(!text.includes('Monitor health'), text);
  assert.ok(!text.includes('657.4h'), text);
  assert.ok(!text.includes('fallback name'), text);
  assert.ok(text.includes('set to 0% on the lottery'), 'the carrier content is still there');
});
test('monitor blocks carry exactly the operator-only sections', () => {
  const text = blockTexts(buildMonitorBlocks({ registry: REG_UNNAMED, staleness: staleError }));
  assert.ok(text.includes('Monitor health'), text);
  assert.ok(text.includes('657.4h'), text);
  assert.ok(text.includes('9999'), text);
  assert.ok(text.includes('CURATED_CARRIERS'), 'the note says where to name it');
  assert.deepStrictEqual(buildMonitorBlocks({ registry: REG, changes: [zeroDrop] }), []);
  assert.deepStrictEqual(buildMonitorBlocks({ registry: REG, staleness: { level: 'ok', hours: 0.1, message: 'fresh' } }), []);
});
test('the approved (general channel) message is the channel blocks and nothing else', () => {
  const payload = { registry: REG_UNNAMED, changes: [zeroDrop, lotteryChange('AZ', 'Ascot Non-Admitted', 1, 25)], staleness: staleError };
  const sent = composeSlackMessage(payload, true);
  assert.deepStrictEqual(sent, buildSlackBlocks(payload));
  const text = blockTexts(sent);
  assert.ok(!text.includes('Monitor'), text);
  assert.ok(!text.includes('PENDING APPROVAL'), text);
  assert.ok(!text.includes('1% → 25%'), text);
});
test('the approval DM previews the channel post and appends the monitor notes separately', () => {
  const text = blockTexts(composeSlackMessage({ registry: REG, changes: [zeroDrop], staleness: staleError }, false));
  assert.ok(text.includes('PENDING APPROVAL'), text);
  assert.ok(text.includes('set to 0% on the lottery'), text);
  assert.ok(text.includes('approved=true'), text);
  assert.ok(text.includes('Monitor notes'), text);
  assert.ok(text.includes('657.4h'), text);
  assert.ok(text.indexOf('approved=true') < text.indexOf('Monitor notes'), 'monitor notes come after the approval instructions, outside the preview');
});
test('an outage-only alert to the operator carries no approval framing', () => {
  const text = blockTexts(composeSlackMessage({ registry: REG, changes: [], staleness: staleError }, false));
  assert.ok(!text.includes('PENDING APPROVAL'), text);
  assert.ok(!text.includes('approved=true'), text);
  assert.ok(text.includes('657.4h'), text);
});

console.log('evaluateStaleness');
const H = 3600000;
const t0 = Date.parse('2026-08-14T12:00:00Z');
test('no heartbeat at all is unknown, not an error', () => {
  assert.strictEqual(evaluateStaleness(undefined, t0).level, 'unknown');
  assert.strictEqual(evaluateStaleness(null, t0).level, 'unknown');
});
test('an unreadable timestamp is unknown', () => {
  assert.strictEqual(evaluateStaleness('not a date', t0).level, 'unknown');
});
test('fresh is ok', () => {
  const s = evaluateStaleness(new Date(t0 - 1 * H).toISOString(), t0);
  assert.strictEqual(s.level, 'ok');
  assert.strictEqual(s.hours, 1);
});
test('past the warn threshold warns', () => {
  const s = evaluateStaleness(new Date(t0 - 7 * H).toISOString(), t0);
  assert.strictEqual(s.level, 'warn');
});
test('past the error threshold errors', () => {
  const s = evaluateStaleness(new Date(t0 - 13 * H).toISOString(), t0);
  assert.strictEqual(s.level, 'error');
  assert.match(s.message, /13h/);
});
test('thresholds are overridable', () => {
  const s = evaluateStaleness(new Date(t0 - 2 * H).toISOString(), t0, { warnHours: 1, errorHours: 3 });
  assert.strictEqual(s.level, 'warn');
});
test('the rate-limited heartbeat can never trip its own warning', () => {
  const s = evaluateStaleness(new Date(t0 - 3 * H).toISOString(), t0);
  assert.strictEqual(s.level, 'ok', 'HEARTBEAT_MIN_INTERVAL (180m) must sit below STALENESS_WARN_HOURS');
});

console.log('shouldPersistHeartbeat');
test('writes when there is no previous heartbeat', () => {
  assert.strictEqual(shouldPersistHeartbeat(undefined, t0), true);
});
test('does not rewrite inside the interval', () => {
  assert.strictEqual(shouldPersistHeartbeat(new Date(t0 - 1 * H).toISOString(), t0), false);
});
test('rewrites once the window has passed', () => {
  assert.strictEqual(shouldPersistHeartbeat(new Date(t0 - 4 * H).toISOString(), t0), true);
});
test('an unreadable previous heartbeat forces a rewrite', () => {
  assert.strictEqual(shouldPersistHeartbeat('garbage', t0, 180), true);
});

console.log('dataBlockPattern');
test('matches a plain object block', () => {
  const html = 'x\n    const carrierData = {"AK":{"a":"N/A"}};\n    const other = 1;';
  assert.strictEqual(html.match(dataBlockPattern('carrierData'))[1], '{"AK":{"a":"N/A"}}');
});
test('matches a block whose values contain semicolons', () => {
  const html = '    const carrierRegistry = [{"note":"a; b"}];\n';
  assert.strictEqual(html.match(dataBlockPattern('carrierRegistry'))[1], '[{"note":"a; b"}]');
});
test('does not run past the end of its own line', () => {
  const html = '    const a = {"x":1};\n    const b = {"y":2};\n';
  assert.strictEqual(html.match(dataBlockPattern('a'))[1], '{"x":1}');
});
test('a similarly-named block does not match', () => {
  const html = '    const carrierDataExtra = {"x":1};\n';
  assert.strictEqual(html.match(dataBlockPattern('carrierData')), null);
});
test('every block the sync rewrites is findable in the real index.html', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '../../index.html'), 'utf-8');
  for (const name of ['carrierData', 'carrierLotteryData', 'carrierRegistry', 'lobOpsData']) {
    const m = html.match(dataBlockPattern(name));
    assert.ok(m, `${name} block not found`);
    JSON.parse(m[1]);
  }
});
test('the registry mirrored in index.html is a derived registry with the fields the page reads', () => {
  const html = require('fs').readFileSync(require('path').join(__dirname, '../../index.html'), 'utf-8');
  const inPage = JSON.parse(html.match(dataBlockPattern('carrierRegistry'))[1]);
  assert.ok(Array.isArray(inPage) && inPage.length >= LEGACY_CARRIERS.length + CURATED_CARRIERS.length);
  for (const c of inPage) {
    assert.ok(c.key && c.display && ['live', 'pre-launch', 'retired'].includes(c.status), JSON.stringify(c));
    assert.strictEqual(typeof c.admitted, 'boolean', `${c.key} needs a derived admitted flag`);
  }
  assert.ok(inPage.some(c => c.id === 6881 && c.status === 'live'));
});

console.log(`\n${passed} passed${process.exitCode ? ' — FAILURES ABOVE' : ''}`);
