'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const codePath = path.join(__dirname, '..', 'src', 'Code.gs');
const source = fs.readFileSync(codePath, 'utf8');
const reviewPath = path.join(__dirname, '..', 'src', 'ReviewApp.html');
const reviewSource = fs.readFileSync(reviewPath, 'utf8');

function loadCode() {
  const context = vm.createContext({ console });
  vm.runInContext(source, context, { filename: codePath });
  return context;
}

function message(from, subject, ms) {
  return {
    getFrom: () => from,
    getSubject: () => subject,
    getDate: () => new Date(ms),
  };
}

test('normalizes subject lines for compact display', () => {
  const ctx = loadCode();
  assert.equal(ctx.normalizeSubject_('  A  subject\nwith tabs\t'),
    'A subject with tabs');
  assert.equal(ctx.normalizeSubject_(''), '(No subject)');
  assert.equal(ctx.normalizeSubject_('x'.repeat(260)).length, 240);
});

test('sender snapshot returns the three newest exact-sender subjects', () => {
  const ctx = loadCode();
  const threads = [
    { getMessages: () => [
      message('A Reader <reader@example.com>', 'Re: campaign', 400),
      message('News <news@example.com>', 'Older campaign', 100),
    ] },
    { getMessages: () => [
      message('News <news@example.com>', 'Newest campaign', 350),
    ] },
    { getMessages: () => [
      message('News <news@example.com>', 'Second campaign', 300),
    ] },
    { getMessages: () => [
      message('News <news@example.com>', 'Should not be needed', 200),
    ] },
  ];
  ctx.GmailApp = {
    search: (query, start, limit) => {
      assert.equal(query, 'from:news@example.com newer_than:14d');
      assert.equal(start, 0);
      assert.equal(limit, 100);
      return threads;
    },
  };

  const snapshot = ctx.senderSnapshot_('news@example.com', 'Fallback');
  assert.equal(snapshot.count14d, 4);
  assert.equal(snapshot.lookupOk, true);
  assert.deepEqual(Array.from(snapshot.subjects), [
    'Newest campaign', 'Second campaign', 'Older campaign',
  ]);
});

test('sender snapshot uses the current message as a safe fallback', () => {
  const ctx = loadCode();
  ctx.GmailApp = { search: () => { throw new Error('quota'); } };
  const snapshot = ctx.senderSnapshot_('news@example.com', '  Current\nsubject ');
  assert.equal(snapshot.count14d, 1);
  assert.equal(snapshot.lookupOk, false);
  assert.deepEqual(Array.from(snapshot.subjects), ['Current subject']);
});

test('review payload decodes only bounded valid subject arrays', () => {
  const ctx = loadCode();
  ctx.readTable_ = () => [{
    status: 'pending',
    senderKey: 'personal:news@example.com',
    account: 'personal',
    senderName: 'News',
    senderEmail: 'news@example.com',
    count14d: 5,
    unsubMethod: 'oneclick',
    carefulFlag: '',
    recentSubjectsJson: JSON.stringify([' One ', 'Two', 'Three', 'Four']),
  }];

  const payload = ctx.getReviewPayload_();
  assert.deepEqual(Array.from(payload.items[0].recentSubjects),
    ['One', 'Two', 'Three']);
  assert.deepEqual(Array.from(ctx.decodeRecentSubjects_('not json')), []);
});

test('backfill updates only missing pending rows owned by this account', () => {
  const ctx = loadCode();
  const writes = [];
  ctx.readTable_ = (name) => name === 'SenderHistory' ? [{
    _row: 9,
    account: 'personal',
    senderKey: 'personal:news@example.com',
  }] : [
    {
      _row: 4,
      account: 'personal',
      status: 'pending',
      senderKey: 'personal:news@example.com',
      senderEmail: 'news@example.com',
      recentSubjectsJson: '',
    },
    {
      _row: 5,
      account: 'work',
      status: 'pending',
      senderKey: 'work:other@example.com',
      senderEmail: 'other@example.com',
      recentSubjectsJson: '',
    },
  ];
  ctx.senderSnapshot_ = () => ({
    count14d: 7,
    subjects: ['A', 'B', 'C'],
    lookupOk: true,
  });
  ctx.writeCell_ = (...args) => writes.push(args);

  ctx.backfillRecentSubjects_('personal');
  assert.deepEqual(writes, [
    ['Pending', 4, 'count14d', 7],
    ['Pending', 4, 'recentSubjectsJson', '["A","B","C"]'],
    ['SenderHistory', 9, 'count14d', 7],
    ['SenderHistory', 9, 'recentSubjectsJson', '["A","B","C"]'],
  ]);
});

test('schema upgrade appends subject columns without shifting existing data', () => {
  const ctx = loadCode();
  assert.deepEqual(Array.from(ctx.SHEET_HEADERS.Pending).slice(0, 11), [
    'account', 'senderKey', 'senderName', 'senderEmail', 'firstSeen',
    'count14d', 'unsubMethod', 'unsubData', 'carefulFlag', 'digestBatchId',
    'status',
  ]);
  assert.equal(ctx.SHEET_HEADERS.Pending[11], 'recentSubjectsJson');
  assert.equal(ctx.SHEET_HEADERS.SenderHistory[13], 'recentSubjectsJson');
});

test('review card shows at most three escaped recent subjects', () => {
  const scriptMatch = reviewSource.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'ReviewApp script block should exist');
  const data = { items: [{
    senderKey: 'personal:news@example.com',
    account: 'personal',
    senderName: 'News',
    senderEmail: 'news@example.com',
    count14d: 4,
    unsubMethod: 'oneclick',
    careful: '',
    recentSubjects: ['First <img src=x>', 'Second & next', 'Third', 'Fourth'],
  }] };
  const script = scriptMatch[1].replace(
    'var DATA = <?!= payload ?>;',
    `var DATA = ${JSON.stringify(data)};`,
  );
  const elements = {};
  const document = {
    getElementById: (id) => {
      if (!elements[id]) elements[id] = { style: {}, textContent: '', innerHTML: '' };
      return elements[id];
    },
  };
  vm.runInNewContext(script, { document }, { filename: reviewPath });

  assert.match(elements.list.innerHTML, /Recent subjects/);
  assert.match(elements.list.innerHTML, /First &lt;img src=x&gt;/);
  assert.match(elements.list.innerHTML, /Second &amp; next/);
  assert.match(elements.list.innerHTML, /Third/);
  assert.doesNotMatch(elements.list.innerHTML, /Fourth/);
});
