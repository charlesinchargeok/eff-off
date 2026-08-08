'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const codePath = path.join(__dirname, '..', 'src', 'Code.gs');
const source = fs.readFileSync(codePath, 'utf8');

function loadCode() {
  const context = vm.createContext({ console });
  vm.runInContext(source, context, { filename: codePath });
  return context;
}

test('protects security and transactional subject lines without a Gmail lookup', () => {
  const ctx = loadCode();
  ctx.GmailApp = { search: () => { throw new Error('should not search'); } };

  const security = ctx.protectionDecision_(
    'alerts@example.com', 'Example', ['Your verification code is 123456'],
    'me@gmail.com',
  );
  const receipt = ctx.protectionDecision_(
    'hello@example.com', 'Example', ['Receipt for order confirmed'],
    'me@gmail.com',
  );
  assert.match(security.reason, /security|account-access/);
  assert.match(receipt.reason, /receipt|order/);
  assert.equal(security.lookupOk, true);
  assert.equal(receipt.lookupOk, true);
});

test('protects government and same-organization senders', () => {
  const ctx = loadCode();
  assert.match(ctx.protectionDecision_(
    'notices@agency.gov', 'Agency', ['News'], 'me@gmail.com',
  ).reason, /government/);
  assert.match(ctx.protectionDecision_(
    'alex@example.com', 'Alex Smith', ['Hello'], 'me@example.com',
  ).reason, /same organization/);
  ctx.GmailApp = { search: () => [] };
  assert.equal(ctx.protectionDecision_(
    'alex@evil.co.uk', 'Alex Smith', ['Hello'], 'me@company.co.uk',
  ).reason, '');
});

test('uses Gmail updates, importance, replies, and Primary-person signals', () => {
  const cases = [
    ['category:updates', 'Acme', 'offers@example.com', /updates|purchases/],
    ['is:important', 'Acme', 'offers@example.com', /starred|important/],
    ['in:sent', 'Acme', 'offers@example.com', /replied/],
    ['category:primary', 'Alex Smith', 'alex@example.com', /real person/],
  ];
  for (const [needle, name, email, reasonPattern] of cases) {
    const ctx = loadCode();
    ctx.GmailApp = {
      search: (query) => query.includes(needle) ? [{}] : [],
    };
    const result = ctx.protectionDecision_(email, name, ['A quick hello'],
      'me@gmail.com');
    assert.match(result.reason, reasonPattern);
    assert.equal(result.lookupOk, true);
  }
});

test('allows ordinary promotion senders when no protection signal matches', () => {
  const ctx = loadCode();
  ctx.GmailApp = { search: () => [] };
  const result = ctx.protectionDecision_(
    'offers@example.com', 'Acme Deals', ['Summer sale: 20% off'],
    'me@gmail.com',
  );
  assert.equal(result.reason, '');
  assert.equal(result.lookupOk, true);
});

test('fails closed into retry when a Gmail signal lookup fails', () => {
  const ctx = loadCode();
  ctx.GmailApp = { search: () => { throw new Error('temporary quota'); } };
  const result = ctx.protectionDecision_(
    'offers@example.com', 'Acme Deals', ['Summer sale'], 'me@gmail.com',
  );
  assert.equal(result.reason, '');
  assert.equal(result.lookupOk, false);
});

test('same-domain body links fix USPS and Reddit missing-header false positives', () => {
  const ctx = loadCode();
  assert.equal(ctx.carefulReason_(
    false,
    'updates@informeddelivery.usps.com',
    'USPS Informed Delivery',
    'https://click.email.informeddelivery.usps.com/unsubscribe?id=1',
  ), '');
  assert.equal(ctx.carefulReason_(
    false,
    'noreply@redditmail.com',
    'Reddit',
    'https://click.redditmail.com/unsubscribe?id=1',
  ), '');
});

test('missing-header relaxation does not trust cross-domain, freemail, or lookalike senders', () => {
  const ctx = loadCode();
  assert.match(ctx.carefulReason_(
    false, 'offers@example.com', 'Example', 'https://evil.test/unsubscribe',
  ), /missing the standard/);
  assert.match(ctx.carefulReason_(
    false, 'promo@gmail.com', 'Promo', 'https://gmail.com/unsubscribe',
  ), /personal-style/);
  assert.match(ctx.carefulReason_(
    false, 'notice@paypa1.net', 'paypal.com',
    'https://notice.paypa1.net/unsubscribe',
  ), /name mentions/);
  assert.match(ctx.carefulReason_(
    false, 'offers@shop.co.uk', 'Shop',
    'https://unsubscribe.evil.co.uk/unsubscribe',
  ), /missing the standard/);
  assert.match(ctx.carefulReason_(
    false, 'offers@evil.co.uk', 'shop.co.uk',
    'https://offers.evil.co.uk/unsubscribe',
  ), /name mentions/);
});

test('backfill removes protected existing rows from review and updates history', () => {
  const ctx = loadCode();
  const writes = [];
  ctx.readTable_ = (name) => name === 'SenderHistory' ? [{
    _row: 8,
    account: 'personal',
    senderKey: 'personal:security@example.com',
    state: 'pending',
  }] : [{
    _row: 4,
    account: 'personal',
    senderKey: 'personal:security@example.com',
    senderName: 'Example Security',
    senderEmail: 'security@example.com',
    status: 'pending',
    recentSubjectsJson: '["New sign-in security alert"]',
    protectionCheckedAt: '',
  }];
  ctx.nowMs_ = () => Date.parse('2026-08-06T12:00:00Z');
  ctx.writeCell_ = (...args) => writes.push(args);

  ctx.backfillProtection_('personal', 'me@gmail.com');
  assert.ok(writes.some((w) => w[0] === 'Pending' &&
    w[2] === 'status' && w[3] === 'protected'));
  assert.ok(writes.some((w) => w[0] === 'SenderHistory' &&
    w[2] === 'state' && w[3] === 'protected'));
  assert.ok(writes.some((w) => w[2] === 'protectReason' &&
    /security|account-access/.test(w[3])));
});

test('backfill releases a retry row only after a successful clean lookup', () => {
  const ctx = loadCode();
  const writes = [];
  ctx.GmailApp = { search: () => [] };
  ctx.readTable_ = (name) => name === 'SenderHistory' ? [{
    _row: 8,
    account: 'personal',
    senderKey: 'personal:offers@example.com',
    state: 'protection_pending',
    bodyLink: 'https://click.offers.example.com/unsubscribe',
    carefulFlag: 'missing the standard unsubscribe info real mailing lists include — could be a spammer',
  }] : [{
    _row: 4,
    account: 'personal',
    senderKey: 'personal:offers@example.com',
    senderName: 'Example Deals',
    senderEmail: 'offers@example.com',
    status: 'protection_pending',
    unsubMethod: 'link',
    unsubData: 'https://click.offers.example.com/unsubscribe',
    carefulFlag: 'missing the standard unsubscribe info real mailing lists include — could be a spammer',
    recentSubjectsJson: '["Summer sale"]',
    protectionCheckedAt: '',
  }];
  ctx.nowMs_ = () => Date.parse('2026-08-06T12:00:00Z');
  ctx.writeCell_ = (...args) => writes.push(args);

  ctx.backfillProtection_('personal', 'me@gmail.com');
  assert.ok(writes.some((w) => w[0] === 'Pending' &&
    w[2] === 'status' && w[3] === 'pending'));
  assert.ok(writes.some((w) => w[0] === 'SenderHistory' &&
    w[2] === 'state' && w[3] === 'pending'));
  assert.ok(writes.some((w) => w[0] === 'Pending' &&
    w[2] === 'carefulFlag' && w[3] === ''));
  assert.ok(writes.some((w) => w[0] === 'SenderHistory' &&
    w[2] === 'carefulFlag' && w[3] === ''));
});

test('new protected sender goes to history but never enters Pending', () => {
  const ctx = loadCode();
  const appends = [];
  ctx.findBodyUnsubLink_ = () => '';
  ctx.getListUnsubscribe_ = () => ({
    value: '<https://example.com/unsubscribe>',
    post: 'List-Unsubscribe=One-Click',
  });
  ctx.senderSnapshot_ = () => ({
    count14d: 2,
    subjects: ['Your verification code'],
    lookupOk: true,
  });
  ctx.appendRowObj_ = (name, value) => appends.push([name, value]);
  ctx.nowMs_ = () => Date.parse('2026-08-06T12:00:00Z');
  const msg = {
    getFrom: () => 'Example Security <security@example.com>',
    getSubject: () => 'Your verification code',
  };

  const added = ctx.processMessage_(msg, 'personal', 'me@gmail.com', {}, {});
  assert.equal(added, false);
  assert.equal(appends.some(([name]) => name === 'Pending'), false);
  const history = appends.find(([name]) => name === 'SenderHistory')[1];
  assert.equal(history.state, 'protected');
  assert.match(history.protectReason, /security|account-access/);
});

test('new sender stays hidden in protection_pending after lookup failure', () => {
  const ctx = loadCode();
  const appends = [];
  ctx.findBodyUnsubLink_ = () => '';
  ctx.getListUnsubscribe_ = () => ({
    value: '<https://example.com/unsubscribe>',
    post: 'List-Unsubscribe=One-Click',
  });
  ctx.senderSnapshot_ = () => ({
    count14d: 2,
    subjects: ['Summer sale'],
    lookupOk: true,
  });
  ctx.protectionDecision_ = () => ({ reason: '', lookupOk: false });
  ctx.appendRowObj_ = (name, value) => appends.push([name, value]);
  ctx.nowMs_ = () => Date.parse('2026-08-06T12:00:00Z');
  const msg = {
    getFrom: () => 'Example <offers@example.com>',
    getSubject: () => 'Summer sale',
  };

  ctx.processMessage_(msg, 'personal', 'me@gmail.com', {}, {});
  const pending = appends.find(([name]) => name === 'Pending')[1];
  const history = appends.find(([name]) => name === 'SenderHistory')[1];
  assert.equal(pending.status, 'protection_pending');
  assert.equal(history.state, 'protection_pending');
});

test('review payload excludes protected and protection-pending rows', () => {
  const ctx = loadCode();
  const base = {
    account: 'personal',
    senderName: 'Example',
    senderEmail: 'example@example.com',
    count14d: 1,
    unsubMethod: 'oneclick',
    carefulFlag: '',
    recentSubjectsJson: '["Subject"]',
  };
  ctx.readTable_ = () => [
    { ...base, senderKey: 'personal:one@example.com', status: 'pending' },
    { ...base, senderKey: 'personal:two@example.com', status: 'protected' },
    { ...base, senderKey: 'personal:three@example.com', status: 'protection_pending' },
  ];
  const payload = ctx.getReviewPayload_();
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].senderKey, 'personal:one@example.com');
});

test('execution performs a final protection check before any network action', () => {
  const ctx = loadCode();
  const actions = [];
  const writes = [];
  ctx.getRole_ = () => 'personal';
  ctx.getAccountEmail_ = () => 'me@gmail.com';
  ctx.nowMs_ = () => Date.parse('2026-08-06T12:00:00Z');
  ctx.readTable_ = (name) => ({
    Decisions: [{
      _row: 2,
      senderKey: 'personal:security@example.com',
      account: 'personal',
      decision: 'unsub',
      executedAt: '',
    }],
    Actions: [],
    Pending: [{
      _row: 3,
      senderKey: 'personal:security@example.com',
      senderEmail: 'security@example.com',
      senderName: 'Example Security',
      status: 'decided',
      unsubMethod: 'oneclick',
      unsubData: 'https://example.com/unsubscribe',
      recentSubjectsJson: '["Your verification code"]',
      protectionCheckedAt: '',
      protectReason: '',
    }],
    SenderHistory: [{
      _row: 4,
      senderKey: 'personal:security@example.com',
      senderEmail: 'security@example.com',
      senderName: 'Example Security',
      state: 'unsub_pending',
      recentSubjectsJson: '["Your verification code"]',
      protectionCheckedAt: '',
      protectReason: '',
    }],
  }[name]);
  ctx.appendRowObj_ = (name, value) => {
    if (name === 'Actions') actions.push(value);
  };
  ctx.writeCell_ = (...args) => writes.push(args);
  ctx.executeUnsub_ = () => { throw new Error('must not execute'); };

  const stats = ctx.executeDecisionsForAccount_('personal', 25);
  assert.equal(stats.protected, 1);
  assert.equal(stats.attempted, 0);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].verifyStatus, 'held_protected');
  assert.equal(actions[0].target, '');
  assert.ok(writes.some((w) => w[0] === 'Decisions' &&
    w[2] === 'executedAt'));
});

test('execution defers safely when its final Gmail protection lookup fails', () => {
  const ctx = loadCode();
  const actions = [];
  const writes = [];
  ctx.getRole_ = () => 'personal';
  ctx.getAccountEmail_ = () => 'me@gmail.com';
  ctx.nowMs_ = () => Date.parse('2026-08-06T12:00:00Z');
  ctx.protectionDecision_ = () => ({ reason: '', lookupOk: false });
  ctx.readTable_ = (name) => ({
    Decisions: [{
      _row: 2,
      senderKey: 'personal:offers@example.com',
      account: 'personal',
      decision: 'unsub',
      executedAt: '',
    }],
    Actions: [],
    Pending: [{
      _row: 3,
      senderKey: 'personal:offers@example.com',
      senderEmail: 'offers@example.com',
      senderName: 'Example',
      unsubMethod: 'oneclick',
      recentSubjectsJson: '["Summer sale"]',
      protectionCheckedAt: '',
      protectReason: '',
    }],
    SenderHistory: [],
  }[name]);
  ctx.appendRowObj_ = (name, value) => actions.push([name, value]);
  ctx.writeCell_ = (...args) => writes.push(args);

  const stats = ctx.executeDecisionsForAccount_('personal', 25);
  assert.equal(stats.deferred, 1);
  assert.equal(stats.attempted, 0);
  assert.equal(actions.length, 0);
  assert.equal(writes.some((w) => w[0] === 'Decisions' &&
    w[2] === 'executedAt'), false);
});

test('protected execution hold is explained without spammer advice', () => {
  const ctx = loadCode();
  ctx.readTable_ = () => [{
    senderKey: 'personal:security@example.com',
    protectReason: 'security or account-access message',
    carefulFlag: '',
  }];
  const plain = ctx.renderDigestPlain_([], [], [], [], [], [], [{
    senderKey: 'personal:security@example.com',
    account: 'personal',
    verifyStatus: 'held_protected',
  }], [], [], '');
  assert.match(plain, /kept protected: security or account-access message/);
  assert.doesNotMatch(plain, /security@example\.com.*Block sender/);
});

test('schema v3 appends protection columns after all existing fields', () => {
  const ctx = loadCode();
  assert.equal(ctx.SHEET_HEADERS.Pending[11], 'recentSubjectsJson');
  assert.equal(ctx.SHEET_HEADERS.Pending[12], 'protectionCheckedAt');
  assert.equal(ctx.SHEET_HEADERS.Pending[13], 'protectReason');
  assert.equal(ctx.SHEET_HEADERS.SenderHistory[13], 'recentSubjectsJson');
  assert.equal(ctx.SHEET_HEADERS.SenderHistory[14], 'protectionCheckedAt');
  assert.equal(ctx.SHEET_HEADERS.SenderHistory[15], 'protectReason');
});
