// Tests for scripts/reviewer-facts.mjs: a rebuild that only renames, reorders
// or requotes must compare equal, and each change the relay would feel must not.
//
//   npm ci --prefix tests && node --test tests/reviewer-facts.test.mjs

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { MODULE_GAP, differences, objectKeys, reviewerFacts } from '../scripts/reviewer-facts.mjs'

// The reviewer's store calls and offer as Claude Code 2.1.325 minifies them.
const build = ({ q = '"', s = 's', line = 'y', clear = 'void 0', view, seen, entry, extra = '' } = {}) => {
  const k = key => `${q}${key}${q}`
  const offerView = view ?? `{kind:${k('offer')},line:${line}.line,explanation:${line}.explanation,shownAt:Date.now()}`
  const offerEntry = entry ?? `{offeredTurn:a.turnId,tag:w,view:${offerView}}`
  return [
    `name:${k('cc-plugin-you-should-know')};`,
    `let C=await ${s}.store.get(${k('known')});await ${s}.store.set(${k('known')},C);`,
    `let A=await ${s}.store.get(${k('sessions')}),B=await ${s}.store.get(${k(seen ?? 'seen')});`,
    `await ${s}.store.get(${k('typedPastInARow')});await ${s}.store.set(${k('typedPastInARow')},0);`,
    `await ${s}.store.set(${k('looksToSkip')},[]);`,
    `await ${s}.store.set(${k(seen ?? 'seen')},[...B,${line}.line].slice(-no)),await E(${offerEntry}),Fo(i,c);`,
    `await ${s}.store.set(${k('sessions')},oe(A,{...C??{id:c},view:${clear}}));`,
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
    storeKeys: ['known', 'looksToSkip', 'seen', 'sessions', 'typedPastInARow'],
    seenWrittenBeforeOffer: true,
    seenWritesOfLines: 1,
    sessionsWritesWithId: 1,
    sessionsWritesClearingView: 1,
  })
})

test('renamed variables, reordered keys and other quotes compare equal', () => {
  const variants = [
    build({ s: 'e', line: 'Z' }),
    build({ q: "'" }),
    build({ q: '`' }),
    build({ clear: 'undefined' }),
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

test('each change the relay would feel is reported', () => {
  const cases = {
    'a renamed note field': [build({ view: '{kind:"offer",text:y.line,explanation:y.explanation,shownAt:Date.now()}' }), 'viewKeys'],
    'a dropped timestamp': [build({ view: '{kind:"offer",line:y.line,explanation:y.explanation}' }), 'viewKeys'],
    'a renamed turn field': [build({ entry: '{turnId:a.turnId,tag:w,view:{kind:"offer",line:y.line,explanation:y.explanation,shownAt:Date.now()}}' }), 'entryKeys'],
    'a renamed store key': [build({ seen: 'shown' }), 'storeKeys'],
    'a new store key': [build({ extra: 's.store.set("offerHistory",[]);' }), 'storeKeys'],
    'another offer kind': [build({ view: '{kind:"note",line:y.line,explanation:y.explanation,shownAt:Date.now()}' }), 'offerCount'],
    'a second offer': [build({ extra: 'q={view:{kind:"offer",line:1}};' }), 'offerCount'],
    'answers that no longer clear the view': [build({ clear: 'null' }), 'sessionsWritesClearingView'],
    'another write that clears the view': [build({ extra: 's.store.set("sessions",oe(A,{...C,view:void 0}));' }), 'sessionsWritesClearingView'],
    'a sessions entry without its id': [build().replace('{id:c}', '{key:c}'), 'sessionsWritesWithId'],
    'no reviewer at all': ['nothing here', 'reviewerName'],
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

test('object keys are read at the object own level only', () => {
  assert.deepEqual(objectKeys('{a:1,"b":{c:2,d:[3,{e:4}]},f,...g,h:"x,}{",i:(j,k)=>({l:1})}'), ['...', 'a', 'b', 'f', 'h', 'i'])
})
