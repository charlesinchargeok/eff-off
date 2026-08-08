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

test('no-method outcome uses a dedicated non-unsubscribe verification state', () => {
  const ctx = loadCode();
  const result = ctx.executeUnsub_(
    'none', '', 'personal:sender@example.com',
  );
  assert.equal(result.result, 'watch');
  assert.equal(result.target, '');
  assert.equal(result.verifyStatus, 'watching_no_method');
});

for (const method of ['link', 'none']) {
  test(`careful ${method} decision is held without exposing a target`, () => {
    const ctx = loadCode();
    const actions = [];
    ctx.getRole_ = () => 'personal';
    ctx.getAccountEmail_ = () => 'me@gmail.com';
    ctx.nowMs_ = () => Date.parse('2026-08-06T12:00:00Z');
    ctx.readTable_ = (name) => ({
      Decisions: [{
        _row: 2,
        senderKey: 'personal:sender@example.com',
        account: 'personal',
        decision: 'unsub',
        executedAt: '',
      }],
      Actions: [],
      Pending: [{
        _row: 3,
        senderKey: 'personal:sender@example.com',
        senderEmail: 'sender@example.com',
        senderName: 'Sender',
        status: 'decided',
        unsubMethod: method,
        unsubData: method === 'link' ? 'https://evil.test/unsubscribe' : '',
        carefulFlag: 'missing the standard unsubscribe info',
        protectionCheckedAt: '2026-08-06T11:00:00Z',
        protectReason: '',
      }],
      SenderHistory: [{
        _row: 4,
        senderKey: 'personal:sender@example.com',
        bodyLink: '',
        carefulFlag: 'missing the standard unsubscribe info',
        state: 'unsub_pending',
      }],
    }[name]);
    ctx.appendRowObj_ = (name, value) => {
      if (name === 'Actions') actions.push(value);
    };
    ctx.writeCell_ = () => {};
    ctx.executeUnsub_ = () => { throw new Error('must not execute'); };

    const stats = ctx.executeDecisionsForAccount_('personal', 25);
    assert.equal(stats.held, 1);
    assert.equal(stats.attempted, 0);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].verifyStatus, 'held_careful');
    assert.equal(actions[0].target, '');
  });
}

test('no-method verification reports active mail without claiming an unsubscribe', () => {
  const ctx = loadCode();
  const writes = [];
  ctx.getRole_ = () => 'personal';
  ctx.nowMs_ = () => Date.parse('2026-08-20T12:00:00Z');
  ctx.readTable_ = (name) => name === 'Actions' ? [{
    _row: 2,
    senderKey: 'personal:sender@example.com',
    account: 'personal',
    method: 'none',
    attemptedAt: '2026-08-01T12:00:00Z',
    verifyAfter: '2026-08-15T12:00:00Z',
    verifyStatus: 'watching_no_method',
  }] : [{
    _row: 3,
    senderKey: 'personal:sender@example.com',
    state: 'unsub_watch',
  }];
  ctx.GmailApp = { search: () => [{}] };
  ctx.writeCell_ = (...args) => writes.push(args);

  ctx.verifySweep_('personal');
  assert.ok(writes.some((w) => w[0] === 'Actions' &&
    w[2] === 'verifyStatus' && w[3] === 'no_method_active'));
  assert.ok(writes.some((w) => w[0] === 'SenderHistory' &&
    w[2] === 'state' && w[3] === 'no_method_active'));
  assert.equal(writes.some((w) => w[3] === 'unsubscribed'), false);
});

test('quiet no-method verification remains explicitly non-unsubscribed', () => {
  const ctx = loadCode();
  const writes = [];
  ctx.getRole_ = () => 'personal';
  ctx.nowMs_ = () => Date.parse('2026-08-20T12:00:00Z');
  ctx.readTable_ = (name) => name === 'Actions' ? [{
    _row: 2,
    senderKey: 'personal:sender@example.com',
    account: 'personal',
    method: 'none',
    attemptedAt: '2026-08-01T12:00:00Z',
    verifyAfter: '2026-08-15T12:00:00Z',
    verifyStatus: 'watching_no_method',
  }] : [{
    _row: 3,
    senderKey: 'personal:sender@example.com',
    state: 'unsub_watch',
  }];
  ctx.GmailApp = { search: () => [] };
  ctx.writeCell_ = (...args) => writes.push(args);

  ctx.verifySweep_('personal');
  assert.ok(writes.some((w) => w[0] === 'Actions' &&
    w[2] === 'verifyStatus' && w[3] === 'no_method_quiet'));
  assert.ok(writes.some((w) => w[0] === 'SenderHistory' &&
    w[2] === 'state' && w[3] === 'no_method_quiet'));
  assert.equal(writes.some((w) => w[3] === 'unsubscribed'), false);
});

test('historical none + quiet false-success rows are repaired in place', () => {
  const ctx = loadCode();
  const writes = [];
  ctx.getRole_ = () => 'personal';
  ctx.nowMs_ = () => Date.parse('2026-08-20T12:00:00Z');
  ctx.readTable_ = (name) => name === 'Actions' ? [{
    _row: 2,
    senderKey: 'personal:sender@example.com',
    account: 'personal',
    method: 'none',
    attemptedAt: '2026-07-01T12:00:00Z',
    verifyAfter: '2026-07-15T12:00:00Z',
    verifyStatus: 'quiet',
  }] : [{
    _row: 3,
    senderKey: 'personal:sender@example.com',
    state: 'unsubscribed',
  }];
  ctx.GmailApp = { search: () => { throw new Error('must not search'); } };
  ctx.writeCell_ = (...args) => writes.push(args);

  ctx.verifySweep_('personal');
  assert.ok(writes.some((w) => w[0] === 'Actions' &&
    w[3] === 'no_method_quiet'));
  assert.ok(writes.some((w) => w[0] === 'SenderHistory' &&
    w[3] === 'no_method_quiet'));
});

test('historical none + escalated rows become active without another search', () => {
  const ctx = loadCode();
  const writes = [];
  ctx.getRole_ = () => 'personal';
  ctx.nowMs_ = () => Date.parse('2026-08-20T12:00:00Z');
  ctx.readTable_ = (name) => name === 'Actions' ? [{
    _row: 2,
    senderKey: 'personal:sender@example.com',
    account: 'personal',
    method: 'none',
    attemptedAt: '2026-07-01T12:00:00Z',
    verifyAfter: '2026-07-15T12:00:00Z',
    verifyStatus: 'escalated',
  }] : [{
    _row: 3,
    senderKey: 'personal:sender@example.com',
    state: 'escalated',
  }];
  ctx.GmailApp = { search: () => { throw new Error('must not search'); } };
  ctx.writeCell_ = (...args) => writes.push(args);

  ctx.verifySweep_('personal');
  assert.ok(writes.some((w) => w[0] === 'Actions' &&
    w[3] === 'no_method_active'));
  assert.ok(writes.some((w) => w[0] === 'SenderHistory' &&
    w[3] === 'no_method_active'));
});

test('digest migration suppresses old careful links and explains active no-method mail', () => {
  const ctx = loadCode();
  const writes = [];
  let rendered;
  ctx.nowMs_ = () => Date.parse('2026-08-20T12:00:00Z');
  ctx.Utilities = { formatDate: () => '20260820-1200' };
  const carefulKey = 'personal:careful@example.com';
  const noneKey = 'personal:none@example.com';
  ctx.readTable_ = (name) => ({
    Pending: [],
    SenderHistory: [
      { _row: 7, senderKey: carefulKey, carefulFlag: 'cross-domain link' },
      { _row: 8, senderKey: noneKey, carefulFlag: '' },
    ],
    Actions: [
      {
        _row: 4,
        senderKey: carefulKey,
        account: 'personal',
        method: 'link',
        target: 'https://evil.test/unsubscribe',
        verifyStatus: 'manual_pending',
      },
      {
        _row: 5,
        senderKey: noneKey,
        account: 'personal',
        method: 'none',
        target: '',
        verifyStatus: 'escalated',
      },
    ],
  }[name]);
  ctx.collectTransient_ = () => ({ rows: [], texts: [] });
  ctx.getConfigValue_ = () => 'https://review.example.test';
  ctx.getDigestTo_ = () => 'me@example.com';
  ctx.renderDigestHtml_ = (...args) => {
    rendered = args;
    return '<p>digest</p>';
  };
  ctx.renderDigestPlain_ = () => 'digest';
  ctx.GmailApp = { sendEmail: () => {} };
  ctx.writeCell_ = (...args) => writes.push(args);
  ctx.deleteConfigRows_ = () => {};
  ctx.setConfigValue_ = () => {};

  ctx.buildAndSendDigest_();
  const manuals = rendered[1];
  const noMethods = rendered[5];
  const held = rendered[6];
  assert.equal(manuals.length, 0);
  assert.equal(held.length, 1);
  assert.equal(held[0].target, '');
  assert.equal(noMethods.length, 1);
  assert.ok(writes.some((w) => w[0] === 'Actions' && w[1] === 4 &&
    w[3] === 'held_surfaced'));
  assert.ok(writes.some((w) => w[0] === 'Actions' && w[1] === 5 &&
    w[3] === 'no_method_active_surfaced'));
});

test('review page treats every careful method as a link-free hold', () => {
  const scriptMatch = reviewSource.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch);
  const item = {
    senderKey: 'personal:careful@example.com',
    account: 'personal',
    senderName: 'Careful Sender',
    senderEmail: 'careful@example.com',
    count14d: 2,
    unsubMethod: 'link',
    careful: 'cross-domain link',
    recentSubjects: ['A subject'],
  };
  const script = scriptMatch[1].replace(
    'var DATA = <?!= payload ?>;',
    `var DATA = ${JSON.stringify({ items: [item] })};`,
  );
  const elements = {};
  const document = {
    getElementById: (id) => {
      if (!elements[id]) elements[id] = { style: {}, textContent: '', innerHTML: '' };
      return elements[id];
    },
  };
  const context = vm.createContext({ document });
  vm.runInContext(script, context, { filename: reviewPath });
  assert.match(elements.list.innerHTML, /Handle safely/);
  context.CHOICE[item.senderKey] = 'unsub';
  context.openSummary();
  assert.match(elements.summaryBody.innerHTML,
    /Won’t touch — I’ll show you the safe next step/);
  assert.doesNotMatch(elements.summaryBody.innerHTML,
    /Not automatic — I’ll follow up in your digest/);
});
