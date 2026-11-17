// Tests for scripts/reviewer-facts.mjs: a rebuild that only renames, reorders
// or requotes must compare equal, and each change the relay would feel must not.
//
//   npm ci --prefix tests && node --test tests/reviewer-facts.test.mjs

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MODULE_GAP, differences, mergeFacts, objectKeys, reviewerFacts, unescapedClosingTags } from '../scripts/reviewer-facts.mjs'

const NAME = 'cc-plugin-you-should-know'
const SCAN = {
  hooks: ['prompt.submit', 'turn.step', 'ui.render', 'session.end'],
  calls: ['state.get', 'state.set', 'store.get', 'store.set', 'session.id'],
  reads: ['aboutOpen'],
  writes: ['aboutOpen'],
}

// The reviewer's module as Claude Code 2.1.325 minifies it: its scan record,
// the turn.step hook that stores the offer, and the band that reads it.
const build = ({
  q = '"',
  s = 's',
  ev = 'a',
  line = 'y',
  clear = 'void 0',
  view,
  seen,
  entry,
  scan = SCAN,
  skip,
  band,
  extra = '',
} = {}) => {
  const k = key => `${q}${key}${q}`
  const list = names => `[${names.map(k).join(',')}]`
  const refs = keys => `[${keys.map(key => `{plugin:${k(NAME)},key:${k(key)}}`).join(',')}]`
  const offerView = view ?? `{kind:${k('offer')},line:${line}.line,explanation:${line}.explanation,shownAt:Date.now()}`
  const offerEntry = entry ?? `{offeredTurn:${ev}.turnId,tag:w,view:${offerView}}`
  const stepSkip = skip ?? `if(${ev}.agentId!==void 0)return yield*b(${ev});`
  const bandBody = band ?? `let F=await ${s}.store.get(${k('sessions')}),c=L(F,m);`
  return [
    `var gs=D(function(JO,hs){hs.exports={scan:{hooks:${list(scan.hooks)},calls:${list(scan.calls)},`,
    `state:{reads:${refs(scan.reads)},writes:${refs(scan.writes)}}},files:{}}});`,
    `e(${k('turn.step')},async function*(${s},${ev},b){${stepSkip}`,
    `let C=await ${s}.store.get(${k('known')});await ${s}.store.set(${k('known')},C);`,
    `let A=await ${s}.store.get(${k('sessions')}),B=await ${s}.store.get(${k(seen ?? 'seen')});`,
    `await ${s}.store.get(${k('typedPastInARow')});await ${s}.store.set(${k('typedPastInARow')},0);`,
    `await ${s}.store.set(${k('looksToSkip')},[]);`,
    `await ${s}.store.set(${k(seen ?? 'seen')},[...B,${line}.line].slice(-no)),await E(${offerEntry}),Fo(i,c);`,
    `await ${s}.store.set(${k('sessions')},oe(A,{...C??{id:c},view:${clear}}));`,
    `return yield*b(${ev})}),e(${k('ui.render')},{component:${k('AbovePrompt')}},async(${s},${ev},b)=>{${bandBody}return b(${ev})});`,
    extra,
  ].join('')
}

const BASE = reviewerFacts(build())

test('the 2.1.325 shape reads as every fact the relay needs', () => {
  assert.deepEqual(BASE, {
    reviewerName: true,
    offerCount: 1,
    entryKeys: ['offeredTurn', 'tag', 'view'],
    viewKeys: ['explanation', 'kind', 'line', 'shownAt'],
    offeredTurnIsStepTurn: true,
    offerInMainLoopStep: true,
    storeKeys: ['known', 'looksToSkip', 'seen', 'sessions', 'typedPastInARow'],
    seenWrittenBeforeOffer: true,
    seenWritesOfLines: 1,
    sessionsWritesWithId: 1,
    sessionsWritesClearingView: 1,
    bandReadsSessions: true,
    scanHooks: ['prompt.submit', 'session.end', 'turn.step', 'ui.render'],
    scanCalls: ['session.id', 'state.get', 'state.set', 'store.get', 'store.set'],
    scanStateReads: [`${NAME}/aboutOpen`],
    scanStateWrites: [`${NAME}/aboutOpen`],
    unescapedClosingTags: [],
  })
})

test('renamed variables, reordered keys and other quotes compare equal', () => {
  const variants = [
    build({ s: 'e', line: 'Z' }),
    build({ ev: 'r' }),
    build({ q: "'" }),
    build({ q: '`' }),
    build({ clear: 'undefined' }),
    build({ scan: { ...SCAN, hooks: [...SCAN.hooks].reverse(), calls: [...SCAN.calls].reverse() } }),
    build({ view: '{shownAt:Date.now(),line:y.line,kind:"offer",explanation:y.explanation}' }),
    build({ entry: '{view:{kind:"offer",line:y.line,explanation:y.explanation,shownAt:Date.now()},tag:w,offeredTurn:a.turnId}' }),
    build({ view: '{kind:"offer",line:y.line,explanation:f(y,{a:1,b:"x,}"}),shownAt:Date.now()}' }),
  ]
  for (const text of variants) assert.deepEqual(differences(BASE, reviewerFacts(text)), [])
})

test('store calls of unrelated code beyond the module gap are left out', () => {
  const far = 'x'.repeat(MODULE_GAP * 3)
  const text = build({ extra: `${far};s.store.set("usage-rows-queued",[]);` })
  assert.deepEqual(differences(BASE, reviewerFacts(`s.store.get("other-plugin");${far}${text}`)), [])
})

test('unrelated code growing inside the reviewer leaves its facts alone', () => {
  const text = build().replace('await s.store.set("sessions",oe(', `${'x'.repeat(MODULE_GAP - 1000)};await s.store.set("sessions",oe(`)
  assert.deepEqual(differences(BASE, reviewerFacts(text)), [])
})

test('another module’s scan record beyond the module gap is not read as the reviewer’s', () => {
  const other = 'm.exports={scan:{hooks:["tool.call"],calls:["tool.register"]},files:{}};'
  const own = build().indexOf('e("turn.step"')
  const facts = reviewerFacts(`${other}${'x'.repeat(MODULE_GAP)};${build().slice(own)}`)
  assert.equal(facts.scanHooks, null)
  assert.equal(facts.reviewerName, false)
})

test('each change the relay would feel is reported', () => {
  const cases = {
    'a renamed note field': [build({ view: '{kind:"offer",text:y.line,explanation:y.explanation,shownAt:Date.now()}' }), 'viewKeys'],
    'a dropped timestamp': [build({ view: '{kind:"offer",line:y.line,explanation:y.explanation}' }), 'viewKeys'],
    'a renamed turn field': [build({ entry: '{turnId:a.turnId,tag:w,view:{kind:"offer",line:y.line,explanation:y.explanation,shownAt:Date.now()}}' }), 'entryKeys'],
    'a reviewed turn that is not the step’s': [build({ entry: '{offeredTurn:a.askedTurn,tag:w,view:{kind:"offer",line:y.line,explanation:y.explanation,shownAt:Date.now()}}' }), 'offeredTurnIsStepTurn'],
    'subagent steps reviewed too': [build({ skip: '' }), 'offerInMainLoopStep'],
    'a renamed store key': [build({ seen: 'shown' }), 'storeKeys'],
    'a new store key': [build({ extra: 's.store.set("offerHistory",[]);' }), 'storeKeys'],
    'another offer kind': [build({ view: '{kind:"note",line:y.line,explanation:y.explanation,shownAt:Date.now()}' }), 'offerCount'],
    'a second offer': [build({ extra: 'q={view:{kind:"offer",line:1}};' }), 'offerCount'],
    'answers that no longer clear the view': [build({ clear: 'null' }), 'sessionsWritesClearingView'],
    'another write that clears the view': [build({ extra: 's.store.set("sessions",oe(A,{...C,view:void 0}));' }), 'sessionsWritesClearingView'],
    'a sessions entry without its id': [build().replace('{id:c}', '{key:c}'), 'sessionsWritesWithId'],
    'a band that reads the view elsewhere': [build({ band: 'let F=await s.state.get(V),c=L(F,m);' }), 'bandReadsSessions'],
    'a new hook': [build({ scan: { ...SCAN, hooks: [...SCAN.hooks, 'store.set'] } }), 'scanHooks'],
    'a new call': [build({ scan: { ...SCAN, calls: [...SCAN.calls, 'session.append'] } }), 'scanCalls'],
    'a new state value read': [build({ scan: { ...SCAN, reads: ['aboutOpen', 'offers'] } }), 'scanStateReads'],
    'a new state value written': [build({ scan: { ...SCAN, writes: ['aboutOpen', 'offers'] } }), 'scanStateWrites'],
    'a module that never names the reviewer': [build({ scan: { ...SCAN, reads: [], writes: [] } }), 'reviewerName'],
    'no reviewer at all': ['nothing here', 'offerCount'],
  }
  for (const [name, [text, field]] of Object.entries(cases)) {
    const changed = differences(BASE, reviewerFacts(text))
    assert.ok(changed.some(line => line.startsWith(`${field}:`)), `${name} was not reported: ${JSON.stringify(changed)}`)
  }
})

test('the seen write must come just before the offer', () => {
  const text = build().replace(',await E(', `;${'x'.repeat(1000)};await E(`)
  assert.ok(differences(BASE, reviewerFacts(text)).some(line => line.startsWith('seenWrittenBeforeOffer:')))
})

test('a tag the build opens and closes is listed only when a note keeps it', () => {
  const prompt = name => `const p=\`some text <${name}>\${body}</${name}>\`;`
  assert.deepEqual(unescapedClosingTags(prompt('channel') + prompt('system-reminder') + prompt('div') + prompt('claude_md')), [])
  assert.deepEqual(unescapedClosingTags(prompt('commentary') + prompt('reasoning')), ['commentary', 'reasoning'])
})

test('a closing tag in machine code, or one never opened, is not listed', () => {
  const machineCode = String.fromCharCode(0, 0xff, 1, 2, 0xc3)
  assert.deepEqual(unescapedClosingTags(`${machineCode}x<l9 </l9>, plain text </closing>`), [])
})

test('a tag a note keeps that a release adds is reported, one it drops is not', () => {
  const baseline = { unescapedClosingTags: ['commentary', 'reasoning'] }
  assert.deepEqual(differences(baseline, { unescapedClosingTags: ['commentary', 'reasoning', 'wakeup'] }), [
    'unescapedClosingTags: new in this build: wakeup',
  ])
  assert.deepEqual(differences(baseline, { unescapedClosingTags: ['commentary'] }), [])
})

test('builds of one release on several platforms give one baseline that each compares equal to', () => {
  const linux = { ...BASE, unescapedClosingTags: ['commentary', 'testsuite'] }
  const windows = { ...BASE, unescapedClosingTags: ['assembly', 'commentary'] }
  const merged = mergeFacts([linux, windows])
  assert.deepEqual(merged.unescapedClosingTags, ['assembly', 'commentary', 'testsuite'])
  assert.deepEqual(differences(merged, linux), [])
  assert.deepEqual(differences(merged, windows), [])
  assert.throws(() => mergeFacts([linux, { ...windows, scanCalls: ['ui.log'] }]), /disagree on scanCalls/)
})

test('object keys are read at the object own level only', () => {
  assert.deepEqual(objectKeys('{a:1,"b":{c:2,d:[3,{e:4}]},f,...g,h:"x,}{",i:(j,k)=>({l:1})}'), ['...', 'a', 'b', 'f', 'h', 'i'])
})
