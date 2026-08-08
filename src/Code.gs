/**
 * eff-off — inbox unsubscribe agent (Google Apps Script, plain V8 JavaScript).
 *
 * ONE codebase pasted into one or two Apps Script projects (one per Gmail
 * account). The Script Property ACCOUNT_ROLE ('personal' | 'work') switches
 * behavior:
 *
 *   personal — scans its own inbox, sends the single combined digest every
 *     2 days, hosts the review web app (doGet), executes its own unsubscribes
 *     immediately on Apply, runs verification. A one-account setup uses only
 *     this role.
 *   work — optional second account. Scans its own inbox, and an hourly worker
 *     executes any not-yet-executed work-account unsubscribe decisions from
 *     the shared Sheet, plus verification for its own actions.
 *
 * Coordination happens through ONE shared Google Sheet ("the notebook"),
 * owned by the personal account and (in a two-account setup) shared as editor
 * with the work account.
 *
 * REQUIRED SCRIPT PROPERTIES (Project Settings → Script Properties):
 *   ACCOUNT_ROLE  'personal' or 'work'          (required)
 *   SHEET_ID      ID of the shared Google Sheet (required)
 *   DIGEST_TO     digest recipient              (optional; defaults to the
 *                                                account's own address)
 *
 * Run setup() ONCE per account after setting the properties. It validates the
 * configuration, creates the Sheet tabs, and installs the time triggers for
 * that role.
 *
 * Uses only: GmailApp, SpreadsheetApp, UrlFetchApp, PropertiesService,
 * ScriptApp, HtmlService, Session, LockService, Utilities, Logger.
 * No external libraries. No gmail.modify (never hides/labels/deletes mail).
 */

/* ======================================================================
 * CONFIG
 * ==================================================================== */

/** Role constants. */
var ROLE_PERSONAL = 'personal';
var ROLE_WORK = 'work';

/** Tunable constants — quotas-friendly caps and cadences. */
var CFG = {
  FIRST_RUN_LOOKBACK_DAYS: 3,   // first scan ever looks back this far
  VOLUME_PEEK_DAYS: 14,         // volume window for new senders
  GRACE_DAYS: 14,               // verify unsubscribes after this many days
  DIGEST_MIN_HOURS_BETWEEN: 44, // "every 2 days" with trigger-jitter slack
  DIGEST_HOUR: 7,               // daily trigger hour (script timezone = ET)
  SCAN_EVERY_HOURS: 4,          // inbox scan cadence (both roles)
  VERIFY_MIN_HOURS_BETWEEN: 12, // work-role verification gating
  MAX_THREAD_PAGES_PER_SCAN: 10,// safety valve: pages of 100 threads per scan
  THREAD_PAGE_SIZE: 100,
  MAX_MESSAGES_PER_SCAN: 500,   // hard cap on messages examined per run
  MAX_NEW_SENDERS_PER_RUN: 50,  // per-run cap on new Pending rows
  MAX_SUBJECT_BACKFILLS_PER_RUN: 20, // old pending rows upgraded per scan
  MAX_PROTECTION_BACKFILLS_PER_RUN: 20, // old pending safety checks/run
  PROTECTION_LOOKBACK_DAYS: 180,// Gmail engagement/category signal window
  MAX_EXECUTIONS_PER_RUN: 25,   // per-run cap on unsubscribe executions
  MAX_VERIFICATIONS_PER_RUN: 30,// per-run cap on verification searches
  SKIP_RESURFACE_DAYS: 30,      // skipped senders may resurface after this
  SKIP_RESURFACE_VOLUME: 5,     // ...only if 14d volume exceeds this
  ESCALATED_QUIET_BUFFER_DAYS: 4 // ignore mail already in flight when the
                                 // escalation digest went out (see verify)
};

/** Script Property key names. */
var PROP = {
  ROLE: 'ACCOUNT_ROLE',
  SHEET_ID: 'SHEET_ID',
  DIGEST_TO: 'DIGEST_TO',
  CHECKPOINT_MS: 'SCAN_CHECKPOINT_MS', // per-account forward-only checkpoint
  LAST_VERIFY_MS: 'LAST_VERIFY_MS'     // work-role verification gate
};

/** Sheet tab names and their exact header rows (created if missing). */
var SHEET_HEADERS = {
  Pending: ['account', 'senderKey', 'senderName', 'senderEmail', 'firstSeen',
    'count14d', 'unsubMethod', 'unsubData', 'carefulFlag', 'digestBatchId',
    'status', 'recentSubjectsJson', 'protectionCheckedAt', 'protectReason'],
  Decisions: ['senderKey', 'account', 'decision', 'decidedAt', 'executedAt',
    'executedBy'],
  Actions: ['senderKey', 'account', 'method', 'target', 'attemptedAt',
    'result', 'verifyAfter', 'verifyStatus'],
  SenderHistory: ['senderKey', 'account', 'senderEmail', 'senderName',
    'firstSeen', 'lastSeen', 'state', 'stateChangedAt', 'count14d',
    'unsubMethod', 'unsubData', 'bodyLink', 'carefulFlag',
    'recentSubjectsJson', 'protectionCheckedAt', 'protectReason'],
  Config: ['key', 'value', 'updatedAt']
};

/** Freemail domain roots — mail "from" these is treated as sketchy/careful. */
var FREEMAIL_ROOTS = ['gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk',
  'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'gmx.net', 'mail.com', 'yandex.com', 'zoho.com'];

/* ======================================================================
 * SETUP (run once per account)
 * ==================================================================== */

/**
 * One-time setup for THIS account. Validates Script Properties, verifies
 * Sheet access, creates missing tabs/headers, replaces this script's time
 * triggers with the right set for the configured role, and emails the
 * account owner a confirmation. Safe to re-run (idempotent).
 * @return {string} A human-readable summary of what was set up.
 */
function setup() {
  var role = getRole_();
  if (role !== ROLE_PERSONAL && role !== ROLE_WORK) {
    throw new Error('Script Property ACCOUNT_ROLE must be exactly "personal" ' +
      'or "work" (currently: "' + role + '"). Add it under Project Settings ' +
      '→ Script Properties, then run setup() again.');
  }
  var sheetId = PropertiesService.getScriptProperties()
    .getProperty(PROP.SHEET_ID);
  if (!sheetId) {
    throw new Error('Script Property SHEET_ID is missing. Paste the ID of ' +
      'the shared Google Sheet, then run setup() again.');
  }
  // Throws with a clear message if this account cannot open the Sheet.
  var ss = SpreadsheetApp.openById(sheetId);
  ensureAllSheets_();

  clearOwnTriggers_();
  ScriptApp.newTrigger('scanJob').timeBased()
    .everyHours(CFG.SCAN_EVERY_HOURS).create();
  var triggerList = ['scanJob every ' + CFG.SCAN_EVERY_HOURS + ' hours'];
  if (role === ROLE_PERSONAL) {
    ScriptApp.newTrigger('digestJob').timeBased()
      .everyDays(1).atHour(CFG.DIGEST_HOUR).create();
    triggerList.push('digestJob daily near ' + CFG.DIGEST_HOUR +
      ':00 (script timezone; sends only every 2 days)');
  } else {
    ScriptApp.newTrigger('workerJob').timeBased().everyHours(1).create();
    triggerList.push('workerJob every hour');
  }

  // The 7am-ET digest schedule assumes the project timezone is Eastern.
  // Enforce the assumption instead of silently firing at the wrong hour.
  var tz = Session.getScriptTimeZone();
  var tzWarning = '';
  if (tz !== 'America/New_York') {
    tzWarning = 'WARNING: this project\'s timezone is "' + tz + '", not ' +
      'Eastern (America/New_York), so timed jobs will fire at the wrong ' +
      'hour. Fix it under Project Settings → General settings → Time zone, ' +
      'then run setup() again.\n';
  }

  var me = getAccountEmail_();
  var summary = 'Unsubscribe agent setup complete.\n' +
    tzWarning +
    'Role: ' + role + '\n' +
    'Account: ' + me + '\n' +
    'Sheet: ' + ss.getName() + '\n' +
    'Triggers: ' + triggerList.join('; ') + '\n' +
    (role === ROLE_PERSONAL ?
      'Next: deploy the web app and paste its URL into the Config tab ' +
      '(webAppUrl row).' :
      'Nothing else to do on this account.');
  try {
    GmailApp.sendEmail(me, 'Unsubscribe agent: setup complete (' + role + ')',
      summary);
  } catch (e) {
    // Non-fatal: setup still succeeded even if the confirmation email failed.
    Logger.log('Setup confirmation email failed: ' + e);
  }
  Logger.log(summary);
  return summary;
}

/**
 * Deletes any existing triggers owned by this script that point at this
 * agent's handler functions, so setup() can be re-run without duplicates.
 */
function clearOwnTriggers_() {
  var mine = { scanJob: true, digestJob: true, workerJob: true };
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (mine[triggers[i].getHandlerFunction()]) {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
}

/* ======================================================================
 * SMALL HELPERS (properties, time, parsing)
 * ==================================================================== */

/**
 * Reads the account role from Script Properties.
 * @return {string} 'personal', 'work', or '' if unset.
 */
function getRole_() {
  var v = PropertiesService.getScriptProperties().getProperty(PROP.ROLE);
  return v ? String(v).trim().toLowerCase() : '';
}

/**
 * The email address of the account this script runs as.
 * @return {string} The owner's email address.
 */
function getAccountEmail_() {
  return String(Session.getActiveUser().getEmail() ||
    Session.getEffectiveUser().getEmail() || '').toLowerCase();
}

/**
 * Digest recipient: DIGEST_TO Script Property, else this account's address.
 * @return {string} Email address to send the digest to.
 */
function getDigestTo_() {
  var v = PropertiesService.getScriptProperties()
    .getProperty(PROP.DIGEST_TO);
  return (v && v.trim()) ? v.trim() : getAccountEmail_();
}

/**
 * Current time in milliseconds since epoch.
 * @return {number} Now, in ms.
 */
function nowMs_() {
  return new Date().getTime();
}

/**
 * Converts whole days to milliseconds.
 * @param {number} d Number of days.
 * @return {number} Milliseconds.
 */
function daysMs_(d) {
  return d * 24 * 60 * 60 * 1000;
}

/**
 * Coerces a Sheet cell value (Date object, ISO string, or number) to ms.
 * @param {*} v Cell value.
 * @return {number} Milliseconds since epoch, or 0 if unparseable/empty.
 */
function toMs_(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  var n = Date.parse(String(v));
  return isNaN(n) ? 0 : n;
}

/**
 * Formats a ms timestamp as an ISO-8601 string for storage in the Sheet.
 * @param {number} ms Milliseconds since epoch.
 * @return {string} ISO string.
 */
function iso_(ms) {
  return new Date(ms).toISOString();
}

/**
 * Escapes text for safe inclusion in HTML (digest email + web app payload).
 * @param {*} s Value to escape.
 * @return {string} HTML-escaped string.
 */
function escapeHtml_(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Parses a Gmail "From" string like '"Acme News" <news@acme.com>'.
 * @param {string} fromStr Raw From value from GmailMessage.getFrom().
 * @return {{name: string, email: string}} Display name and lowercase address
 *     ('' email if unparseable).
 */
function parseFrom_(fromStr) {
  var s = String(fromStr || '').trim();
  var m = s.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/);
  if (m) {
    return { name: m[1].trim(), email: validEmail_(m[2].trim().toLowerCase()) };
  }
  if (s.indexOf('@') > 0 && s.indexOf(' ') === -1) {
    return { name: '', email: validEmail_(s.toLowerCase()) };
  }
  return { name: s, email: '' };
}

/**
 * Validates that a string is a plain email address. This matters for safety:
 * sender addresses are interpolated into Gmail search queries (volume peek,
 * verification), so a crafted From header containing spaces or Gmail search
 * operators (e.g. '<x@evil.com after:9999999999>') could otherwise sabotage
 * the verify searches into always returning "quiet".
 * @param {string} email Candidate address (already lowercased/trimmed).
 * @return {string} The address if valid, else '' (message is then ignored).
 */
function validEmail_(email) {
  return /^[^\s@"<>,;()]+@[^\s@"<>,;()]+\.[^\s@"<>,;()]+$/.test(email) ?
    email : '';
}

/**
 * Builds the idempotency key for a sender on a given account.
 * @param {string} account 'personal' or 'work'.
 * @param {string} email Normalized (lowercase) sender address.
 * @return {string} senderKey, e.g. 'personal:news@acme.com'.
 */
function senderKey_(account, email) {
  return account + ':' + String(email).toLowerCase().trim();
}

/**
 * Recovers the sender email address from a senderKey.
 * @param {string} key senderKey ('account:email').
 * @return {string} The email address portion.
 */
function emailFromSenderKey_(key) {
  var s = String(key || '');
  return s.substring(s.indexOf(':') + 1);
}

/**
 * Returns the registrable-ish root of a domain (last two labels; naive on
 * multi-part TLDs like .co.uk, which is acceptable for a heuristic).
 * @param {string} domain A hostname like 'mail.acme.com'.
 * @return {string} e.g. 'acme.com'.
 */
function domainRoot_(domain) {
  var parts = String(domain || '').toLowerCase().split('.');
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}

/* ======================================================================
 * SHEET ACCESS
 * ==================================================================== */

/** Per-execution spreadsheet cache (globals persist within one run). */
var SS_CACHE_ = null;

/**
 * Opens the shared coordination Sheet (Script Property SHEET_ID), cached
 * for the duration of the current execution.
 * @return {GoogleAppsScript.Spreadsheet.Spreadsheet} The spreadsheet.
 */
function ss_() {
  if (SS_CACHE_) return SS_CACHE_;
  var id = PropertiesService.getScriptProperties()
    .getProperty(PROP.SHEET_ID);
  if (!id) throw new Error('Script Property SHEET_ID is not set.');
  SS_CACHE_ = SpreadsheetApp.openById(id);
  return SS_CACHE_;
}

/**
 * Gets a tab by name, creating it with its header row if missing.
 * @param {string} name Tab name (must exist in SHEET_HEADERS).
 * @return {GoogleAppsScript.Spreadsheet.Sheet} The sheet tab.
 */
function sheet_(name) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  var headers = SHEET_HEADERS[name];
  if (!headers) throw new Error('Unknown sheet tab: ' + name);
  if (!sh) {
    sh = ss.insertSheet(name);
  }
  // Compare the FULL header row (not just the first cell) so schema upgrades
  // that append columns (e.g. SenderHistory.carefulFlag) are applied too.
  var current = sh.getRange(1, 1, 1, headers.length).getValues()[0];
  var matches = true;
  for (var j = 0; j < headers.length; j++) {
    if (String(current[j] || '') !== headers[j]) { matches = false; break; }
  }
  if (!matches) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/**
 * Ensures all five tabs exist with correct headers and seeds Config keys.
 */
function ensureAllSheets_() {
  var names = ['Pending', 'Decisions', 'Actions', 'SenderHistory', 'Config'];
  for (var i = 0; i < names.length; i++) sheet_(names[i]);
  if (getConfigValue_('schemaVersion') !== '3') {
    setConfigValue_('schemaVersion', '3');
  }
  // Seed placeholders so the user can see where to paste the web app URL.
  if (findConfigRow_('webAppUrl') === -1) setConfigValue_('webAppUrl', '');
  if (findConfigRow_('lastDigestAt') === -1) setConfigValue_('lastDigestAt', '');
}

/**
 * Reads a whole tab into an array of row objects keyed by header name.
 * Each object also carries `_row` (its 1-based sheet row) for updates.
 * @param {string} name Tab name.
 * @return {!Array<!Object>} Row objects (excluding the header row).
 */
function readTable_(name) {
  var sh = sheet_(name);
  var values = sh.getDataRange().getValues();
  var headers = SHEET_HEADERS[name];
  var out = [];
  for (var i = 1; i < values.length; i++) {
    var o = { _row: i + 1 };
    for (var j = 0; j < headers.length; j++) o[headers[j]] = values[i][j];
    out.push(o);
  }
  return out;
}

/**
 * Appends one row to a tab, values ordered by that tab's headers.
 * @param {string} name Tab name.
 * @param {!Object} obj Field values keyed by header name.
 */
function appendRowObj_(name, obj) {
  var sh = sheet_(name);
  var headers = SHEET_HEADERS[name];
  var row = [];
  for (var j = 0; j < headers.length; j++) {
    row.push(obj[headers[j]] == null ? '' : obj[headers[j]]);
  }
  sh.appendRow(row);
}

/**
 * Writes a single cell identified by tab, row number, and column name.
 * @param {string} name Tab name.
 * @param {number} row 1-based sheet row number.
 * @param {string} field Header/column name.
 * @param {*} value New value.
 */
function writeCell_(name, row, field, value) {
  var headers = SHEET_HEADERS[name];
  var col = headers.indexOf(field) + 1;
  if (col < 1) throw new Error('Unknown column ' + field + ' on ' + name);
  sheet_(name).getRange(row, col).setValue(value);
}

/**
 * Finds the first Config row with the given key.
 * @param {string} key Config key.
 * @return {number} 1-based row number, or -1 if not found.
 */
function findConfigRow_(key) {
  var rows = readTable_('Config');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].key) === key) return rows[i]._row;
  }
  return -1;
}

/**
 * Reads a Config value by key.
 * @param {string} key Config key.
 * @return {string} The value, or '' if the key is absent.
 */
function getConfigValue_(key) {
  var rows = readTable_('Config');
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].key) === key) return String(rows[i].value || '');
  }
  return '';
}

/**
 * Sets (or creates) a Config key/value row.
 * @param {string} key Config key.
 * @param {string} value New value.
 */
function setConfigValue_(key, value) {
  var row = findConfigRow_(key);
  if (row === -1) {
    appendRowObj_('Config', { key: key, value: value, updatedAt: iso_(nowMs_()) });
  } else {
    writeCell_('Config', row, 'value', value);
    writeCell_('Config', row, 'updatedAt', iso_(nowMs_()));
  }
}

/**
 * Appends a transient message row ('error' or 'note') to the Config tab.
 * These rows are collected into the next digest and then removed.
 * @param {string} kind 'error' or 'note'.
 * @param {string} text Plain-English message for the digest.
 */
function appendTransient_(kind, text) {
  appendRowObj_('Config', {
    key: kind,
    value: '[' + getRole_() + '] ' + text,
    updatedAt: iso_(nowMs_())
  });
}

/**
 * Logs an error: to the Apps Script log AND as a Config 'error' row so it
 * surfaces in the next digest's Errors section instead of being swallowed.
 * @param {string} where Function/stage name.
 * @param {*} err The caught error.
 */
function logError_(where, err) {
  var msg = where + ': ' + (err && err.message ? err.message : String(err));
  Logger.log('ERROR ' + msg);
  try {
    appendTransient_('error', msg);
  } catch (e2) {
    Logger.log('ERROR (could not write to Sheet) ' + e2);
  }
}

/**
 * Collects all transient Config rows of a kind ('error'/'note') WITHOUT
 * deleting them — deletion happens via deleteConfigRows_ only after the
 * digest email has actually been sent, so a failed send never destroys
 * undelivered error reports.
 * @param {string} kind Row kind to collect.
 * @return {{texts: !Array<string>, rows: !Array<number>}} Message texts and
 *     their 1-based sheet row numbers.
 */
function collectTransient_(kind) {
  var rows = readTable_('Config');
  var out = { texts: [], rows: [] };
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].key) === kind) {
      out.texts.push(String(rows[i].value || ''));
      out.rows.push(rows[i]._row);
    }
  }
  return out;
}

/**
 * Deletes the given Config rows (bottom-up so row numbers stay valid).
 * @param {!Array<number>} rowNumbers 1-based sheet row numbers.
 */
function deleteConfigRows_(rowNumbers) {
  var sh = sheet_('Config');
  var sorted = rowNumbers.slice().sort(function (a, b) { return a - b; });
  for (var d = sorted.length - 1; d >= 0; d--) {
    sh.deleteRow(sorted[d]);
  }
}

/* ======================================================================
 * SCAN (both roles, on a timer)
 * ==================================================================== */

/**
 * Time-triggered inbox scan for THIS account. Forward-only: a checkpoint
 * (last processed message time in ms) lives in Script Properties; the first
 * run ever looks back 3 days. Detects subscription mail, peeks 14-day volume
 * for new senders, applies the important-sender PROTECT gate and careful
 * heuristic, and writes eligible senders to Pending + all recognized senders
 * to SenderHistory. Idempotent via senderKey. Errors land in the digest.
 */
function scanJob() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return; // another run of this script is active
  try {
    var role = getRole_();
    if (role !== ROLE_PERSONAL && role !== ROLE_WORK) return;
    ensureAllSheets_();
    var ownEmail = getAccountEmail_();

    // Schema v2 added recent subject lines. Each Apps Script copy can read
    // only its own Gmail account, so upgrade a bounded number of that
    // account's existing pending rows before scanning for new mail.
    backfillRecentSubjects_(role);
    // Schema v3 added the important-sender gate. Re-check existing pending
    // rows before collecting anything new so protected mail disappears from
    // review as soon as each account runs the upgraded code.
    backfillProtection_(role, ownEmail);

    var props = PropertiesService.getScriptProperties();
    var cpMs = Number(props.getProperty(PROP.CHECKPOINT_MS) || 0);
    if (!cpMs) cpMs = nowMs_() - daysMs_(CFG.FIRST_RUN_LOOKBACK_DAYS);

    var collected = collectCandidates_(cpMs);
    var candidates = collected.list;
    if (collected.truncated) {
      // The thread-page safety valve was hit, so threads OLDER than anything
      // collected may exist beyond the last page. Advancing the checkpoint
      // would skip them forever; we process what we have but keep the
      // checkpoint put (idempotency makes reprocessing harmless) and say so.
      logError_('scanJob', new Error('More than ' +
        (CFG.MAX_THREAD_PAGES_PER_SCAN * CFG.THREAD_PAGE_SIZE) +
        ' threads arrived since the last scan checkpoint; the checkpoint ' +
        'was not advanced so nothing gets skipped. If this repeats, the ' +
        'inbox is far busier than expected.'));
    }
    if (candidates.length === 0) return; // leave checkpoint; nothing new

    // Build in-memory lookups once (cheap; avoids per-message Sheet reads).
    var historyByKey = {};
    var historyRows = readTable_('SenderHistory');
    for (var h = 0; h < historyRows.length; h++) {
      if (historyRows[h].account === role) {
        historyByKey[historyRows[h].senderKey] = historyRows[h];
      }
    }
    var pendingKeys = {};
    var pendingRows = readTable_('Pending');
    for (var p = 0; p < pendingRows.length; p++) {
      if (pendingRows[p].status === 'pending' ||
          pendingRows[p].status === 'protection_pending') {
        pendingKeys[pendingRows[p].senderKey] = true;
      }
    }

    var newSenders = 0;
    var newCheckpoint = cpMs;
    for (var i = 0; i < candidates.length; i++) {
      if (newSenders >= CFG.MAX_NEW_SENDERS_PER_RUN) break;
      try {
        if (processMessage_(candidates[i].msg, role, ownEmail,
            historyByKey, pendingKeys)) {
          newSenders++;
        }
      } catch (eMsg) {
        logError_('scanJob(message)', eMsg);
      }
      // Advance strictly forward only past fully processed messages, so a
      // capped run resumes exactly where it stopped. Candidates are the
      // OLDEST messages first, so nothing newer is ever left behind the
      // checkpoint.
      newCheckpoint = Math.max(newCheckpoint, candidates[i].ms);
    }
    if (!collected.truncated) {
      props.setProperty(PROP.CHECKPOINT_MS, String(newCheckpoint));
    }
  } catch (e) {
    logError_('scanJob', e);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Searches Gmail for messages newer than the checkpoint and returns them
 * sorted oldest-first. Scope: inbox + archive (Gmail search default),
 * explicitly excluding chats/sent/drafts/spam/trash.
 *
 * Truncation is checkpoint-safe: Gmail returns threads newest-first, so we
 * page until the search is exhausted (up to a generous safety valve), THEN
 * apply the message cap keeping the OLDEST messages. That way the messages
 * left for the next run are always NEWER than the advanced checkpoint. Only
 * if the page safety valve itself is hit (an extreme backlog) do we report
 * truncated=true, and the caller then refuses to advance the checkpoint.
 * @param {number} cpMs Checkpoint (ms); only messages strictly newer count.
 * @return {{list: !Array<{msg: GoogleAppsScript.Gmail.GmailMessage,
 *     ms: number}>, truncated: boolean}} Candidates ascending by date, plus
 *     whether older threads may exist beyond the last fetched page.
 */
function collectCandidates_(cpMs) {
  // 'after:' takes whole seconds and may exclude a message in the same
  // second as the checkpoint; query one second early — the strict ms > cpMs
  // filter below deduplicates the overlap (process-at-most-once holds).
  var query = '-in:chats -in:sent -in:drafts -in:spam -in:trash after:' +
    (Math.floor(cpMs / 1000) - 1);
  var out = [];
  var start = 0;
  var truncated = false;
  for (var page = 0; page < CFG.MAX_THREAD_PAGES_PER_SCAN; page++) {
    var threads = GmailApp.search(query, start, CFG.THREAD_PAGE_SIZE);
    for (var t = 0; t < threads.length; t++) {
      var msgs = threads[t].getMessages();
      for (var m = 0; m < msgs.length; m++) {
        var ms = msgs[m].getDate().getTime();
        if (ms > cpMs) out.push({ msg: msgs[m], ms: ms });
      }
    }
    if (threads.length < CFG.THREAD_PAGE_SIZE) break; // search exhausted
    start += CFG.THREAD_PAGE_SIZE;
    if (page === CFG.MAX_THREAD_PAGES_PER_SCAN - 1) truncated = true;
  }
  out.sort(function (a, b) { return a.ms - b.ms; });
  // Keep the OLDEST messages: everything dropped here is newer than the
  // checkpoint the caller will set, so the next run picks it up.
  return { list: out.slice(0, CFG.MAX_MESSAGES_PER_SCAN),
    truncated: truncated };
}

/**
 * Examines one message. If it is subscription mail from a sender not yet in
 * SenderHistory (for this account), does the 14-day volume peek and writes
 * Pending + SenderHistory rows. Also resurfaces long-skipped senders whose
 * volume jumped. Never duplicates rows (senderKey idempotency).
 * @param {GoogleAppsScript.Gmail.GmailMessage} msg The message.
 * @param {string} role This account's role ('personal'|'work').
 * @param {string} ownEmail This account's own address (self-mail ignored).
 * @param {!Object<string, !Object>} historyByKey SenderHistory rows by key
 *     (mutated when a new sender is added).
 * @param {!Object<string, boolean>} pendingKeys Pending senderKeys
 *     (mutated when a new Pending row is added).
 * @return {boolean} True if a NEW sender was added to Pending.
 */
function processMessage_(msg, role, ownEmail, historyByKey, pendingKeys) {
  var from = parseFrom_(msg.getFrom());
  if (!from.email || from.email === ownEmail) return false;
  var key = senderKey_(role, from.email);

  var hist = historyByKey[key];
  if (hist) {
    // Known sender. Only skipped senders can resurface, and only if it has
    // been >30 days AND their 14-day volume jumped above the threshold.
    if (hist.state === 'skipped' &&
        nowMs_() - toMs_(hist.stateChangedAt) > daysMs_(CFG.SKIP_RESURFACE_DAYS) &&
        !pendingKeys[key]) {
      var resurfaced = senderSnapshot_(from.email, msg.getSubject());
      if (resurfaced.count14d > CFG.SKIP_RESURFACE_VOLUME) {
        var resurfaceBodyLink = String(hist.bodyLink ||
          (String(hist.unsubMethod) === 'link' ? hist.unsubData : '') || '');
        var resurfaceCareful = recheckedCarefulFlag_(
          String(hist.carefulFlag || ''), from.email, resurfaceBodyLink);
        var recheck = protectionDecision_(from.email,
          String(hist.senderName || from.name), resurfaced.subjects, ownEmail);
        var resurfaceState = recheck.reason ? 'protected' :
          (recheck.lookupOk ? 'pending' : 'protection_pending');
        var recheckAt = recheck.lookupOk ? iso_(nowMs_()) : '';
        if (resurfaceState !== 'protected') {
          appendRowObj_('Pending', {
            account: role, senderKey: key, senderName: hist.senderName,
            senderEmail: from.email, firstSeen: hist.firstSeen,
            count14d: resurfaced.count14d,
            unsubMethod: hist.unsubMethod, unsubData: hist.unsubData,
            // Carry the careful guard forward: a resurfaced sketchy sender
            // must keep its warning badge / separate grouping in review.
            carefulFlag: resurfaceCareful,
            digestBatchId: '', status: resurfaceState,
            recentSubjectsJson: JSON.stringify(resurfaced.subjects),
            protectionCheckedAt: recheckAt, protectReason: ''
          });
          pendingKeys[key] = true;
        }
        writeCell_('SenderHistory', hist._row, 'state', resurfaceState);
        writeCell_('SenderHistory', hist._row, 'stateChangedAt', iso_(nowMs_()));
        writeCell_('SenderHistory', hist._row, 'count14d',
          resurfaced.count14d);
        writeCell_('SenderHistory', hist._row, 'recentSubjectsJson',
          JSON.stringify(resurfaced.subjects));
        if (resurfaceCareful !== String(hist.carefulFlag || '')) {
          writeCell_('SenderHistory', hist._row, 'carefulFlag',
            resurfaceCareful);
        }
        writeCell_('SenderHistory', hist._row, 'protectionCheckedAt', recheckAt);
        writeCell_('SenderHistory', hist._row, 'protectReason', recheck.reason);
        hist.state = resurfaceState;
      }
    }
    return false;
  }

  // Unknown sender: is this subscription mail at all?
  var bodyLink = findBodyUnsubLink_(msg);
  var lu = getListUnsubscribe_(msg, !!bodyLink);
  if (!lu.value && !bodyLink) return false; // ordinary mail; not recorded

  var targets = extractUnsubTargets_(lu.value);
  var method = 'none';
  var data = '';
  if (targets.url && /one-click/i.test(lu.post)) {
    method = 'oneclick'; data = targets.url;       // RFC 8058
  } else if (targets.mailto) {
    method = 'mailto'; data = targets.mailto;
  } else if (targets.url) {
    // https header URL without the One-Click POST contract: treat as a
    // manual link (POSTing blind to it is not RFC 8058 compliant).
    method = 'link'; data = targets.url;
  } else if (bodyLink) {
    method = 'link'; data = bodyLink;
  }

  var snapshot = senderSnapshot_(from.email, msg.getSubject());
  var nowIso = iso_(nowMs_());
  var careful = carefulReason_(!!lu.value, from.email, from.name, bodyLink);
  var protection = protectionDecision_(from.email, from.name,
    snapshot.subjects, ownEmail);
  var state = protection.reason ? 'protected' :
    (protection.lookupOk ? 'pending' : 'protection_pending');
  var checkedAt = protection.lookupOk ? nowIso : '';

  // Protected senders never enter Pending. If Gmail's safety-signal lookup
  // failed, keep the sender in a hidden retry state instead of surfacing it
  // or dropping it behind the forward-only scan checkpoint.
  if (state !== 'protected' && !pendingKeys[key]) {
    appendRowObj_('Pending', {
      account: role, senderKey: key, senderName: from.name,
      senderEmail: from.email, firstSeen: nowIso,
      count14d: snapshot.count14d,
      unsubMethod: method, unsubData: data, carefulFlag: careful,
      digestBatchId: '', status: state,
      recentSubjectsJson: JSON.stringify(snapshot.subjects),
      protectionCheckedAt: checkedAt, protectReason: ''
    });
    pendingKeys[key] = true;
  }
  appendRowObj_('SenderHistory', {
    senderKey: key, account: role, senderEmail: from.email,
    senderName: from.name, firstSeen: nowIso, lastSeen: nowIso,
    state: state, stateChangedAt: nowIso,
    count14d: snapshot.count14d,
    unsubMethod: method, unsubData: data, bodyLink: bodyLink || '',
    carefulFlag: careful,
    recentSubjectsJson: JSON.stringify(snapshot.subjects),
    protectionCheckedAt: checkedAt, protectReason: protection.reason
  });
  historyByKey[key] = { state: state }; // enough for in-run dedupe
  return state === 'pending';
}

/**
 * Reads the List-Unsubscribe and List-Unsubscribe-Post headers.
 * Prefers GmailMessage.getHeader(); if the header comes back empty but the
 * body clearly has an unsubscribe link, falls back to parsing the raw RFC
 * 2822 header block (with unfolding) as a belt-and-braces check. The raw
 * fallback is gated on likelyListMail so ordinary mail never pays the cost
 * of getRawContent().
 * @param {GoogleAppsScript.Gmail.GmailMessage} msg The message.
 * @param {boolean} likelyListMail True when the body already shows an
 *     unsubscribe link (justifies the raw-content fallback).
 * @return {{value: string, post: string}} Header values ('' when absent).
 */
function getListUnsubscribe_(msg, likelyListMail) {
  var value = '';
  var post = '';
  try {
    value = msg.getHeader('List-Unsubscribe') || '';
    post = msg.getHeader('List-Unsubscribe-Post') || '';
  } catch (e) { /* fall through to raw parse */ }
  if (!value && !likelyListMail) {
    // Widen the fallback trigger with other cheap list signals, so a list
    // message whose header getHeader() missed AND whose body has no textual
    // unsubscribe link (image-only footer) still gets the raw parse.
    try {
      likelyListMail = !!(msg.getHeader('List-Id') ||
        /bulk|list/i.test(msg.getHeader('Precedence') || ''));
    } catch (e1) { /* treat as no extra signal */ }
  }
  if (!value && likelyListMail) {
    try {
      var raw = msg.getRawContent();
      var headerBlock = raw.split(/\r?\n\r?\n/)[0]
        .replace(/\r?\n[ \t]+/g, ' '); // unfold continuation lines
      var mv = headerBlock.match(/^list-unsubscribe:\s*(.+)$/im);
      var mp = headerBlock.match(/^list-unsubscribe-post:\s*(.+)$/im);
      if (mv) value = mv[1].trim();
      if (mp) post = mp[1].trim();
    } catch (e2) { /* raw unavailable; body-link detection still applies */ }
  }
  return { value: value, post: post };
}

/**
 * Pulls the https URL and mailto URI out of a List-Unsubscribe header value,
 * e.g. '<mailto:u@x.com>, <https://x.com/u?id=1>'.
 * @param {string} headerValue Raw header value ('' allowed).
 * @return {{url: string, mailto: string}} Extracted targets ('' if absent).
 */
function extractUnsubTargets_(headerValue) {
  var out = { url: '', mailto: '' };
  if (!headerValue) return out;
  var tokens = headerValue.match(/<([^>]+)>/g) || [headerValue];
  for (var i = 0; i < tokens.length; i++) {
    var t = tokens[i].replace(/^</, '').replace(/>$/, '').trim();
    if (!out.url && /^https:\/\//i.test(t)) out.url = t;
    if (!out.mailto && /^mailto:/i.test(t)) out.mailto = t;
  }
  return out;
}

/**
 * Looks for an unsubscribe link in the message body. Checks HTML anchors
 * whose href or link text mentions unsubscribe/opt-out/manage preferences,
 * then bare unsubscribe-ish URLs in the plain body. Bounded work.
 * @param {GoogleAppsScript.Gmail.GmailMessage} msg The message.
 * @return {string} An http(s) URL, or '' if none found.
 */
function findBodyUnsubLink_(msg) {
  var WORDS = /unsubscribe|opt[ -]?out|manage (your )?(email )?preferences/i;
  try {
    var body = String(msg.getBody() || '').slice(0, 300000);
    var anchorRe = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,300}?)<\/a>/gi;
    var m;
    while ((m = anchorRe.exec(body)) !== null) {
      var href = m[1];
      var text = m[2].replace(/<[^>]+>/g, ' ');
      if (/^https?:\/\//i.test(href) && (WORDS.test(href) || WORDS.test(text))) {
        return href;
      }
    }
    var plain = String(msg.getPlainBody() || '').slice(0, 100000);
    var bare = plain.match(/https?:\/\/\S*(?:unsubscribe|optout|opt-out)\S*/i);
    if (bare) return bare[0].replace(/[)>\].,;'"]+$/, '');
  } catch (e) { /* treat as no link */ }
  return '';
}

/**
 * True when two hostnames are equal or one is a real dot-delimited subdomain
 * of the other. Avoids the naive domainRoot_ shortcut (e.g. unrelated .co.uk
 * domains must never be treated as the same organization).
 * @param {string} a First hostname.
 * @param {string} b Second hostname.
 * @return {boolean} Whether both are in the same exact domain tree.
 */
function sameDomainTree_(a, b) {
  var left = String(a || '').toLowerCase().replace(/\.$/, '');
  var right = String(b || '').toLowerCase().replace(/\.$/, '');
  return !!left && !!right && (left === right ||
    left.slice(-(right.length + 1)) === '.' + right ||
    right.slice(-(left.length + 1)) === '.' + left);
}

/**
 * True when an http(s) body-unsubscribe link stays on the sender's
 * exact domain tree. This is a useful legitimacy signal for real bulk
 * mail (including USPS and Reddit) that omits List-Unsubscribe headers.
 * @param {string} email Valid sender address.
 * @param {string} bodyLink Candidate unsubscribe URL.
 * @return {boolean} Whether the host is equal to, above, or below the sender
 *     domain. Sibling domains deliberately remain careful.
 */
function bodyLinkMatchesSender_(email, bodyLink) {
  var m = String(bodyLink || '').match(/^https?:\/\/([^\/:?#]+)/i);
  if (!m) return false;
  var senderDomain = (String(email || '').split('@')[1] || '').toLowerCase();
  var host = m[1].toLowerCase().replace(/\.$/, '');
  return sameDomainTree_(senderDomain, host);
}

/**
 * Migrates the one careful false-positive class we can re-verify safely from
 * stored data: an old "missing header" warning is cleared only when its body
 * unsubscribe link is in the sender's exact domain tree. Other careful
 * reasons are preserved byte-for-byte.
 * @param {string} carefulFlag Existing warning text.
 * @param {string} email Valid sender address.
 * @param {string} bodyLink Stored body-unsubscribe link.
 * @return {string} The original flag, or '' when safely cleared.
 */
function recheckedCarefulFlag_(carefulFlag, email, bodyLink) {
  var flag = String(carefulFlag || '');
  if (/^missing the standard unsubscribe info/i.test(flag) &&
      bodyLinkMatchesSender_(email, bodyLink)) {
    return '';
  }
  return flag;
}

/**
 * Conservative person-like heuristic used only together with Gmail's Primary
 * category. It deliberately rejects list/role addresses and organization-ish
 * display names; starred/important/replied signals protect the remaining
 * people without relying on this guess.
 * @param {string} email Valid sender address.
 * @param {string} displayName Sender display name.
 * @return {boolean} Whether the identity looks like a real person.
 */
function looksLikePerson_(email, displayName) {
  var name = String(displayName || '').trim();
  var local = String(email || '').split('@')[0].toLowerCase();
  if (!name || name.length > 80 || /\d/.test(name)) return false;
  if (/\b(news|newsletter|team|notifications?|alerts?|marketing|support|store|shop|billing|account)\b/i.test(name)) {
    return false;
  }
  if (/(?:^|[._-])(no-?reply|news|info|hello|team|support|alerts?|updates?|marketing|mail)(?:$|[._-])/i.test(local)) {
    return false;
  }
  var words = name.replace(/[^a-z' -]/ig, ' ').trim().split(/\s+/);
  return words.length >= 1 && words.length <= 4;
}

/**
 * Bounded Gmail signal lookup. Throws on a Gmail failure so callers can keep
 * the sender hidden for a later retry instead of failing the safety gate open.
 * @param {string} query Gmail search query built from a validated address.
 * @return {boolean} Whether at least one thread matches.
 */
function gmailSearchHas_(query) {
  return GmailApp.search(query, 0, 1).length > 0;
}

/**
 * Decides whether a sender is important enough to keep completely out of the
 * unsubscribe flow. Strong local signals return immediately; Gmail category
 * and engagement searches handle receipts/updates and real correspondents.
 * No message content leaves Google.
 * @param {string} email Valid sender address.
 * @param {string} displayName Sender display name.
 * @param {!Array<string>} subjects Up to three recent subject lines.
 * @param {string} ownEmail This account's address.
 * @return {{reason: string, lookupOk: boolean}} Empty reason means the sender
 *     may be surfaced; lookupOk=false means keep hidden and retry later.
 */
function protectionDecision_(email, displayName, subjects, ownEmail) {
  var domain = String(email || '').split('@')[1] || '';
  var root = domainRoot_(domain);
  var ownDomain = String(ownEmail || '').split('@')[1] || '';
  var ownRoot = domainRoot_(ownDomain);
  var local = String(email || '').split('@')[0].toLowerCase();
  var identity = (String(displayName || '') + ' ' +
    domain.replace(/[._-]/g, ' ')).toLowerCase();
  var subjectText = (Array.isArray(subjects) ? subjects : [])
    .map(normalizeSubject_).join(' | ').toLowerCase();

  if (sameDomainTree_(domain, ownDomain) &&
      FREEMAIL_ROOTS.indexOf(root) === -1 &&
      FREEMAIL_ROOTS.indexOf(ownRoot) === -1) {
    return { reason: 'same organization as this mailbox', lookupOk: true };
  }
  if (/\.(?:gov|mil)(?:\.[a-z]{2})?$/i.test(domain)) {
    return { reason: 'government or military sender', lookupOk: true };
  }
  if (/\b(bank|credit union|hospital|clinic|medical|patient|pharmacy|payroll|employee benefits|human resources)\b/i.test(identity)) {
    return { reason: 'financial, healthcare, or employer sender',
      lookupOk: true };
  }
  if (/\b(verification code|one[ -]time (?:code|password)|two[ -]factor|2fa|security alert|new sign[ -]in|login attempt|password reset|reset your password)\b/i.test(subjectText)) {
    return { reason: 'security or account-access message', lookupOk: true };
  }
  if (/\b(receipt|invoice|account statement|monthly statement|order (?:confirmation|confirmed|update)|shipped|shipment|delivery update|itinerary|booking confirmation|payment (?:received|confirmation|due)|tax document|pay stub|paystub)\b/i.test(subjectText)) {
    return { reason: 'receipt, statement, order, travel, or payment message',
      lookupOk: true };
  }
  if (/\b(appointment|patient portal|lab results?|test results?|prescription|medical record|doctor|clinic|hospital)\b/i.test(subjectText)) {
    return { reason: 'healthcare or appointment message', lookupOk: true };
  }
  if (/^(security|billing|receipts?|invoices?|statements?|orders?|payments?|payroll|benefits|appointments?)(?:[+._-]|$)/i.test(local)) {
    return { reason: 'transactional or important sending address',
      lookupOk: true };
  }

  var base = 'from:' + email + ' newer_than:' +
    CFG.PROTECTION_LOOKBACK_DAYS + 'd ';
  try {
    if (gmailSearchHas_(base +
        '{category:updates category:purchases category:reservations}')) {
      return { reason: 'Gmail classifies this sender as updates, purchases, ' +
        'or reservations', lookupOk: true };
    }
    if (gmailSearchHas_(base + '{is:starred is:important}')) {
      return { reason: 'you starred this sender or Gmail marks it important',
        lookupOk: true };
    }
    if (gmailSearchHas_('in:sent to:' + email)) {
      return { reason: 'you have replied to this sender', lookupOk: true };
    }
    if (looksLikePerson_(email, displayName) &&
        gmailSearchHas_(base + 'category:primary')) {
      return { reason: 'real person in Gmail Primary', lookupOk: true };
    }
    return { reason: '', lookupOk: true };
  } catch (e) {
    return { reason: '', lookupOk: false };
  }
}

/**
 * Sketchy-sender heuristic. A sender is "careful" (never one-tap-unsubscribed
 * by default; engaging spam confirms a live address) when:
 *  - it has NO List-Unsubscribe header and no same-domain body link, or
 *  - it mails from a freemail domain (gmail/yahoo/outlook/...), or
 *  - the display name contains a domain that does not match the actual
 *    sending domain (lookalike / impersonation signal).
 * @param {boolean} hasHeader Whether List-Unsubscribe was present.
 * @param {string} email Sender address (lowercase).
 * @param {string} displayName Sender display name.
 * @param {string=} bodyLink Body unsubscribe URL, if found.
 * @return {string} Plain-English reason, or '' if not careful.
 */
function carefulReason_(hasHeader, email, displayName, bodyLink) {
  var domain = email.split('@')[1] || '';
  var root = domainRoot_(domain);
  if (FREEMAIL_ROOTS.indexOf(root) !== -1) {
    return 'sent from a personal-style address (' + root + ')';
  }
  var nameDomains = String(displayName || '')
    .match(/[a-z0-9][a-z0-9-]*\.(?:com|net|org|io|co|me|info|email|app|shop)(?:\.[a-z]{2})?\b/ig) || [];
  for (var i = 0; i < nameDomains.length; i++) {
    if (!sameDomainTree_(nameDomains[i], domain)) {
      return 'name mentions ' + nameDomains[i].toLowerCase() +
        ' but mail comes from ' + domain;
    }
  }
  if (!hasHeader && !bodyLinkMatchesSender_(email, bodyLink)) {
    return 'missing the standard unsubscribe info real mailing lists ' +
      'include — could be a spammer';
  }
  return '';
}

/**
 * Normalizes one subject for compact, safe review-card display.
 * @param {*} value Raw Gmail subject.
 * @return {string} One-line subject, capped at 240 characters.
 */
function normalizeSubject_(value) {
  var subject = String(value == null ? '' : value)
    .replace(/\s+/g, ' ').trim();
  if (!subject) return '(No subject)';
  return subject.length > 240 ? subject.slice(0, 239) + '…' : subject;
}

/**
 * One quota-conscious sender lookup that supplies both the existing 14-day
 * volume approximation and the last three subject lines. Gmail search returns
 * threads newest-first; only enough leading threads are opened to find three
 * messages actually sent by this exact address.
 * @param {string} email Sender address.
 * @param {string=} fallbackSubject Subject of the message already being
 *     processed, used only if Gmail returns no readable messages.
 * @return {{count14d: number, subjects: !Array<string>, lookupOk: boolean}}
 *     Sender snapshot; lookupOk is false only when the Gmail search failed.
 */
function senderSnapshot_(email, fallbackSubject) {
  var fallback = normalizeSubject_(fallbackSubject);
  try {
    var threads = GmailApp.search(
      'from:' + email + ' newer_than:' + CFG.VOLUME_PEEK_DAYS + 'd', 0, 100);
    var found = [];
    for (var t = 0; t < threads.length && t < 10 && found.length < 3; t++) {
      try {
        var messages = threads[t].getMessages();
        for (var m = 0; m < messages.length; m++) {
          if (parseFrom_(messages[m].getFrom()).email !== email) continue;
          found.push({
            subject: normalizeSubject_(messages[m].getSubject()),
            ms: messages[m].getDate().getTime()
          });
        }
      } catch (eThread) { /* another recent thread may still be readable */ }
    }
    found.sort(function (a, b) { return b.ms - a.ms; });
    var subjects = found.slice(0, 3).map(function (item) {
      return item.subject;
    });
    if (!subjects.length && fallbackSubject != null) subjects.push(fallback);
    return { count14d: threads.length || 1, subjects: subjects,
      lookupOk: true };
  } catch (e) {
    return { count14d: 1,
      subjects: fallbackSubject == null ? [] : [fallback], lookupOk: false };
  }
}

/**
 * Fills schema-v2 subject data for this account's pre-existing pending rows.
 * Capped per scan to keep Gmail reads predictable. Writing '[]' records a
 * completed lookup so a sender with no readable subjects is not retried on
 * every four-hour scan.
 * @param {string} role This Apps Script copy's account role.
 */
function backfillRecentSubjects_(role) {
  var historyByKey = {};
  var historyRows = readTable_('SenderHistory');
  for (var h = 0; h < historyRows.length; h++) {
    if (historyRows[h].account === role) {
      historyByKey[String(historyRows[h].senderKey)] = historyRows[h];
    }
  }

  var pendingRows = readTable_('Pending');
  var filled = 0;
  for (var p = 0; p < pendingRows.length &&
      filled < CFG.MAX_SUBJECT_BACKFILLS_PER_RUN; p++) {
    var row = pendingRows[p];
    if (row.account !== role || row.status !== 'pending' ||
        String(row.recentSubjectsJson || '')) continue;
    var email = validEmail_(String(row.senderEmail || '').toLowerCase().trim());
    if (!email) continue;
    var snapshot = senderSnapshot_(email);
    // A quota or transient Gmail failure should not permanently backfill an
    // empty list. Stop this run and let the next scheduled scan retry.
    if (!snapshot.lookupOk) break;
    var encoded = JSON.stringify(snapshot.subjects);
    writeCell_('Pending', row._row, 'count14d', snapshot.count14d);
    writeCell_('Pending', row._row, 'recentSubjectsJson', encoded);
    var hist = historyByKey[String(row.senderKey)];
    if (hist) {
      writeCell_('SenderHistory', hist._row, 'count14d', snapshot.count14d);
      writeCell_('SenderHistory', hist._row, 'recentSubjectsJson', encoded);
    }
    filled++;
  }
}

/**
 * Applies the schema-v3 PROTECT gate to pre-existing review rows and retries
 * new senders held in protection_pending after a transient Gmail failure.
 * Subject backfill runs first; blank subject cells wait for a later scan so
 * transactional wording is never skipped merely because migration is capped.
 * @param {string} role This Apps Script copy's account role.
 * @param {string} ownEmail This account's address.
 */
function backfillProtection_(role, ownEmail) {
  var historyByKey = {};
  var historyRows = readTable_('SenderHistory');
  for (var h = 0; h < historyRows.length; h++) {
    if (historyRows[h].account === role) {
      historyByKey[String(historyRows[h].senderKey)] = historyRows[h];
    }
  }

  var pendingRows = readTable_('Pending');
  var checked = 0;
  for (var p = 0; p < pendingRows.length &&
      checked < CFG.MAX_PROTECTION_BACKFILLS_PER_RUN; p++) {
    var row = pendingRows[p];
    var needsCheck = row.status === 'protection_pending' ||
      (row.status === 'pending' && !String(row.protectionCheckedAt || ''));
    if (row.account !== role || !needsCheck ||
        !String(row.recentSubjectsJson || '')) continue;

    var email = validEmail_(String(row.senderEmail || '').toLowerCase().trim());
    if (!email) continue;
    var hist = historyByKey[String(row.senderKey)];
    var storedBodyLink = String((hist || {}).bodyLink ||
      (String(row.unsubMethod) === 'link' ? row.unsubData : '') || '');
    var migratedCareful = recheckedCarefulFlag_(
      String(row.carefulFlag || ''), email, storedBodyLink);
    if (migratedCareful !== String(row.carefulFlag || '')) {
      writeCell_('Pending', row._row, 'carefulFlag', migratedCareful);
      if (hist) {
        writeCell_('SenderHistory', hist._row, 'carefulFlag', migratedCareful);
      }
    }
    var result = protectionDecision_(email, String(row.senderName || ''),
      decodeRecentSubjects_(row.recentSubjectsJson), ownEmail);
    // Do not mark this row checked when Gmail was unavailable. Stop here so a
    // quota failure is not repeated for every remaining sender in this run.
    if (!result.lookupOk) break;

    var nowIso = iso_(nowMs_());
    var nextState = result.reason ? 'protected' : 'pending';
    writeCell_('Pending', row._row, 'protectionCheckedAt', nowIso);
    writeCell_('Pending', row._row, 'protectReason', result.reason);
    if (row.status !== nextState) {
      writeCell_('Pending', row._row, 'status', nextState);
    }

    if (hist) {
      writeCell_('SenderHistory', hist._row, 'protectionCheckedAt', nowIso);
      writeCell_('SenderHistory', hist._row, 'protectReason', result.reason);
      if (String(hist.state) !== nextState) {
        writeCell_('SenderHistory', hist._row, 'state', nextState);
        writeCell_('SenderHistory', hist._row, 'stateChangedAt', nowIso);
      }
    }
    checked++;
  }
}

/* ======================================================================
 * DIGEST (personal role, daily trigger, sends every 2 days)
 * ==================================================================== */

/**
 * Daily-triggered digest job (personal role only). Order of operations:
 *  1. catch-up execute any unexecuted personal unsub decisions (safety net),
 *  2. verification sweep for personal-account actions,
 *  3. if >=2 days since the last digest, build and send ONE combined email
 *     covering both accounts: new contenders, manual links, escalations,
 *     final-ignored suggestions, and errors. Skips sending when empty.
 */
function digestJob() {
  if (getRole_() !== ROLE_PERSONAL) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return;
  try {
    ensureAllSheets_();
    try {
      executeDecisionsForAccount_(ROLE_PERSONAL, CFG.MAX_EXECUTIONS_PER_RUN);
    } catch (e1) {
      logError_('digestJob(catch-up execute)', e1);
    }
    try {
      verifySweep_(ROLE_PERSONAL);
    } catch (e2) {
      logError_('digestJob(verify)', e2);
    }

    var lastMs = toMs_(getConfigValue_('lastDigestAt'));
    if (lastMs &&
        nowMs_() - lastMs < CFG.DIGEST_MIN_HOURS_BETWEEN * 60 * 60 * 1000) {
      return; // not due yet (daily trigger, 2-day cadence)
    }
    buildAndSendDigest_();
  } catch (e) {
    logError_('digestJob', e);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Assembles the combined digest from the Sheet and emails it (HTML + plain
 * text) to DIGEST_TO. Sections: new contenders (grouped by account, careful
 * senders flagged), manual unsubscribe links, failed automatic attempts,
 * escalations (didnt_take), final-ignored block/report-spam suggestions, and
 * errors/notes. If every section is empty, no email is sent AND lastDigestAt
 * is left untouched, so an empty morning never consumes the 2-day window.
 *
 * Order matters: the first pass is READ-ONLY; GmailApp.sendEmail runs next;
 * every state change (verifyStatus transitions, transient-row deletion,
 * lastDigestAt) is committed only AFTER the send succeeded. A failed send
 * (quota, transient error) therefore loses nothing — the same content is
 * retried at the next digestJob run.
 */
function buildAndSendDigest_() {
  var now = nowMs_();
  var batchId = 'B' + Utilities.formatDate(new Date(now), 'Etc/UTC',
    'yyyyMMdd-HHmm');

  // --- READ-ONLY PASS: collect every section's rows. ---
  var pend = readTable_('Pending');
  var contenders = [];
  for (var i = 0; i < pend.length; i++) {
    if (pend[i].status === 'pending') contenders.push(pend[i]);
  }

  var digestHistRows = readTable_('SenderHistory');
  var digestHistByKey = {};
  for (var dh = 0; dh < digestHistRows.length; dh++) {
    digestHistByKey[digestHistRows[dh].senderKey] = digestHistRows[dh];
  }
  var actions = readTable_('Actions');
  var manuals = [];      // link-only unsubs the user chose: need a manual tap
  var failures = [];     // automatic attempts that failed outright
  var escalations = [];  // attempts that didn't take after 14 quiet-check days
  var finals = [];       // still ignoring us after escalation
  var noMethods = [];    // no removal mechanism and mail is still arriving
  var held = [];         // protected/careful senders refused auto-action
  for (var a = 0; a < actions.length; a++) {
    var st = String(actions[a].verifyStatus || '');
    var actionHist = digestHistByKey[actions[a].senderKey] || {};
    var isCarefulManual = st === 'manual_pending' &&
      !!String(actionHist.carefulFlag || '');
    var oldNoMethodActive = String(actions[a].method || '') === 'none' &&
      (st === 'didnt_take' || st === 'escalated' ||
       st === 'final_ignored');
    if (isCarefulManual) {
      // Sanitize the in-memory row before either renderer sees it. The Sheet
      // cell is cleared only in the post-send commit phase below.
      actions[a].target = '';
      held.push(actions[a]);
    }
    else if (st === 'no_method_active' || oldNoMethodActive) {
      noMethods.push(actions[a]);
    } else if (st === 'manual_pending') manuals.push(actions[a]);
    else if (st === 'attempt_failed') failures.push(actions[a]);
    else if (st === 'didnt_take') escalations.push(actions[a]);
    else if (st === 'final_ignored') finals.push(actions[a]);
    else if (st === 'held_careful' || st === 'held_protected') {
      held.push(actions[a]);
    }
  }

  var errRows = collectTransient_('error');
  var noteRows = collectTransient_('note');
  var errors = errRows.texts;
  var notes = noteRows.texts;

  // held counts toward "there is something to say": a cycle whose only content
  // is a safety hold must still send, or the hold would be silent.
  var isEmpty = contenders.length === 0 && manuals.length === 0 &&
    failures.length === 0 && escalations.length === 0 &&
    finals.length === 0 && noMethods.length === 0 && held.length === 0 &&
    errors.length === 0 && notes.length === 0;
  if (isEmpty) return; // nothing to show — skip sending, don't burn the window

  // --- SEND. Throws on failure, leaving all state untouched for a retry. ---
  var webAppUrl = getConfigValue_('webAppUrl');
  var html = renderDigestHtml_(contenders, manuals, failures, escalations,
    finals, noMethods, held, errors, notes, webAppUrl);
  var plain = renderDigestPlain_(contenders, manuals, failures, escalations,
    finals, noMethods, held, errors, notes, webAppUrl);
  var handCount = escalations.length + failures.length + noMethods.length +
    held.length;
  var subject = 'Mail cleanup: ' +
    (contenders.length ? contenders.length + ' sender' +
      (contenders.length === 1 ? '' : 's') + ' to review' : 'status update') +
    (handCount ? ' + ' + handCount + ' needing a hand' : '');
  GmailApp.sendEmail(getDigestTo_(), subject, plain, {
    htmlBody: html,
    name: 'Unsubscribe Agent'
  });

  // --- COMMIT: the digest is definitely in the outbox. ---
  var graceMsVal = daysMs_(CFG.GRACE_DAYS);
  for (var c = 0; c < contenders.length; c++) {
    if (!contenders[c].digestBatchId) {
      writeCell_('Pending', contenders[c]._row, 'digestBatchId', batchId);
    }
  }
  for (var m2 = 0; m2 < manuals.length; m2++) {
    writeCell_('Actions', manuals[m2]._row, 'verifyStatus', 'waiting');
    writeCell_('Actions', manuals[m2]._row, 'verifyAfter',
      iso_(now + graceMsVal));
  }
  for (var f2 = 0; f2 < failures.length; f2++) {
    // The failure was shown with its manual link; treat it like an
    // escalation from here (re-check for quiet in another grace window).
    writeCell_('Actions', failures[f2]._row, 'verifyStatus', 'escalated');
    writeCell_('Actions', failures[f2]._row, 'verifyAfter',
      iso_(now + graceMsVal));
  }
  for (var e2 = 0; e2 < escalations.length; e2++) {
    writeCell_('Actions', escalations[e2]._row, 'verifyStatus', 'escalated');
    // New grace window: after a manual finish, re-check in another 14 days.
    writeCell_('Actions', escalations[e2]._row, 'verifyAfter',
      iso_(now + graceMsVal));
  }
  for (var f3 = 0; f3 < finals.length; f3++) {
    writeCell_('Actions', finals[f3]._row, 'verifyStatus',
      'final_ignored_surfaced');
  }
  for (var nm = 0; nm < noMethods.length; nm++) {
    writeCell_('Actions', noMethods[nm]._row, 'verifyStatus',
      'no_method_active_surfaced');
    setHistState_(digestHistByKey, noMethods[nm].senderKey,
      'no_method_active');
  }
  // Surface-once, then terminal (mirrors final_ignored_surfaced above).
  // 'held_surfaced' matches no digest bucket and no verifySweep_ branch, so
  // either safety hold is reported exactly once and never nags. verifyAfter
  // stays empty — we never contacted the sender, so there is nothing to verify.
  // This runs in the COMMIT phase, so a failed send re-surfaces it next time.
  for (var hd2 = 0; hd2 < held.length; hd2++) {
    writeCell_('Actions', held[hd2]._row, 'target', '');
    writeCell_('Actions', held[hd2]._row, 'verifyStatus',
      'held_surfaced');
  }
  deleteConfigRows_(errRows.rows.concat(noteRows.rows));
  setConfigValue_('lastDigestAt', iso_(now));
}

/**
 * Human-friendly label for an unsubscribe method code.
 * @param {string} method 'oneclick'|'mailto'|'link'|'none'.
 * @return {string} Plain-English label.
 */
function methodLabel_(method) {
  return {
    oneclick: 'one-click unsubscribe available',
    mailto: 'email unsubscribe available',
    link: 'manual link only',
    none: 'no unsubscribe method found'
  }[method] || String(method);
}

/**
 * Escalation link for an Actions row: the https target if there is one, else
 * the sender's body link from SenderHistory, else ''.
 * @param {!Object} action Actions row object.
 * @param {!Object<string, !Object>} histByKey SenderHistory rows by senderKey.
 * @return {string} A URL the user can tap, or ''.
 */
function escalationLink_(action, histByKey) {
  if (/^https?:\/\//i.test(String(action.target || ''))) {
    return String(action.target);
  }
  var h = histByKey[action.senderKey];
  if (h && /^https?:\/\//i.test(String(h.bodyLink || ''))) {
    return String(h.bodyLink);
  }
  if (h && /^https?:\/\//i.test(String(h.unsubData || ''))) {
    return String(h.unsubData);
  }
  return '';
}

/**
 * Renders the digest's HTML body.
 * @param {!Array<!Object>} contenders Pending rows.
 * @param {!Array<!Object>} manuals Actions needing a manual tap.
 * @param {!Array<!Object>} failures Automatic attempts that failed outright.
 * @param {!Array<!Object>} escalations Actions that didn't take.
 * @param {!Array<!Object>} finals Actions still ignored after escalation.
 * @param {!Array<!Object>} noMethods No-method senders still active.
 * @param {!Array<!Object>} held Protected/careful safety holds.
 * @param {!Array<string>} errors Error texts.
 * @param {!Array<string>} notes Note texts.
 * @param {string} webAppUrl Review web app URL ('' if not configured yet).
 * @return {string} HTML.
 */
function renderDigestHtml_(contenders, manuals, failures, escalations, finals,
    noMethods, held, errors, notes, webAppUrl) {
  var histByKey = {};
  var hrows = readTable_('SenderHistory');
  for (var i = 0; i < hrows.length; i++) histByKey[hrows[i].senderKey] = hrows[i];

  var h = '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,' +
    'sans-serif;max-width:560px;margin:0 auto;color:#1a1a1a;">';
  h += '<h2 style="margin:16px 0 4px;">Mail cleanup digest</h2>';

  if (contenders.length) {
    if (webAppUrl) {
      h += '<p style="margin:12px 0;"><a href="' + escapeHtml_(webAppUrl) +
        '" style="display:inline-block;background:#1a73e8;color:#fff;' +
        'padding:14px 22px;border-radius:8px;text-decoration:none;' +
        'font-size:17px;font-weight:600;">Review ' + contenders.length +
        ' sender' + (contenders.length === 1 ? '' : 's') + ' &rarr;</a></p>';
    } else {
      h += '<p style="color:#b00020;">The review page URL is not set yet — ' +
        'paste the web app URL into the Config tab of the sheet ' +
        '(webAppUrl row). See SETUP.md, Part 3.</p>';
    }
    var groups = [
      { account: ROLE_PERSONAL, icon: '📧', label: 'Personal' },
      { account: ROLE_WORK, icon: '💼', label: 'Work' }
    ];
    for (var g = 0; g < groups.length; g++) {
      var items = contenders.filter(function (c) {
        return c.account === groups[g].account;
      });
      if (!items.length) continue;
      h += '<h3 style="margin:18px 0 6px;">' + groups[g].icon + ' ' +
        groups[g].label + '</h3><ul style="padding-left:18px;margin:6px 0;">';
      for (var c = 0; c < items.length; c++) {
        var it = items[c];
        var careful = String(it.carefulFlag || '');
        h += '<li style="margin:8px 0;">' +
          (careful ? '⚠️ ' : '') +
          '<b>' + escapeHtml_(it.senderName || it.senderEmail) + '</b>' +
          (it.senderName ? ' &lt;' + escapeHtml_(it.senderEmail) + '&gt;' : '') +
          ' — ' + escapeHtml_(it.count14d) + ' in 14 days — ' +
          escapeHtml_(methodLabel_(it.unsubMethod)) +
          (careful ? '<br><span style="color:#b26a00;font-size:13px;">' +
            'careful: ' + escapeHtml_(careful) + '</span>' : '') +
          '</li>';
      }
      h += '</ul>';
    }
    var anyCareful = contenders.some(function (c2) {
      return !!String(c2.carefulFlag || '');
    });
    if (anyCareful) {
      h += '<p style="color:#b26a00;font-size:13px;margin:6px 0;">⚠️ = ' +
        'looks sketchy. Unsubscribing from (or replying to) these can ' +
        'confirm your address to a spammer, so <b>even if you tap Unsub I ' +
        'will not click or email them for you</b> — I hold them and bring ' +
        'them back here with a safe next step. Skip is still the safe ' +
        'choice.</p>';
    }
  } else {
    h += '<p>No new senders to review this time.</p>';
  }

  // FIRST among the action sections, and deliberately link-free. Important
  // senders need no action; sketchy senders get Block/Report advice only.
  if (held.length) {
    h += '<h3 style="margin:18px 0 6px;">🛡️ Held back for your safety' +
      '</h3><p style="margin:4px 0;">I did <b>not</b> contact these senders. ' +
      'Important mail stays protected; sketchy mail gets a safe next step ' +
      'without exposing your address.</p><ul style="padding-left:18px;">';
    for (var hd = 0; hd < held.length; hd++) {
      var hKey = held[hd].senderKey;
      var hHist = histByKey[hKey] || {};
      var hProtect = String(hHist.protectReason || '');
      var hCareful = String(hHist.carefulFlag || '');
      h += '<li style="margin:8px 0;">' +
        escapeHtml_(emailFromSenderKey_(hKey)) +
        ' (' + escapeHtml_(held[hd].account) + ')' +
        (hProtect ? '<br><span style="color:#246b35;font-size:13px;">kept ' +
          'protected: ' + escapeHtml_(hProtect) + '. No action needed.</span>' :
          '<br><span style="color:#b26a00;font-size:13px;">looked sketchy' +
          (hCareful ? ': ' + escapeHtml_(hCareful) : '') +
          '. Safest finish: Block sender / Report spam.</span>') +
        '</li>';
    }
    h += '</ul>';
  }

  if (manuals.length) {
    h += '<h3 style="margin:18px 0 6px;">👆 One tap needed from you' +
      '</h3><p style="margin:4px 0;">These only offer a web page, which I ' +
      'can’t press for you:</p><ul style="padding-left:18px;">';
    for (var m = 0; m < manuals.length; m++) {
      var link = escalationLink_(manuals[m], histByKey);
      h += '<li style="margin:8px 0;">' +
        escapeHtml_(emailFromSenderKey_(manuals[m].senderKey)) + ' — ' +
        (link ? '<a href="' + escapeHtml_(link) + '">tap their unsubscribe ' +
          'page</a>' : 'no link found; reply "unsubscribe" to their next email') +
        '</li>';
    }
    h += '</ul>';
  }

  if (failures.length) {
    h += '<h3 style="margin:18px 0 6px;">⛔ Automatic unsubscribe failed' +
      '</h3><p style="margin:4px 0;">My automatic request to these senders ' +
      'failed outright (their unsubscribe system rejected it), so nothing ' +
      'was sent — please use their page instead:</p>' +
      '<ul style="padding-left:18px;">';
    for (var fx = 0; fx < failures.length; fx++) {
      var flink = escalationLink_(failures[fx], histByKey);
      h += '<li style="margin:8px 0;">' +
        escapeHtml_(emailFromSenderKey_(failures[fx].senderKey)) +
        ' (' + escapeHtml_(failures[fx].account) + ') — ' +
        (flink ? '<a href="' + escapeHtml_(flink) + '">their unsubscribe ' +
          'page</a>' : 'no unsubscribe page on file') + '</li>';
    }
    h += '</ul>';
  }

  if (escalations.length) {
    h += '<h3 style="margin:18px 0 6px;">🚩 Didn’t take — ' +
      'please finish these by hand</h3><p style="margin:4px 0;">I asked ' +
      'these senders to stop 14+ days ago and mail is still arriving:</p>' +
      '<ul style="padding-left:18px;">';
    for (var e2 = 0; e2 < escalations.length; e2++) {
      var elink = escalationLink_(escalations[e2], histByKey);
      h += '<li style="margin:8px 0;">' +
        escapeHtml_(emailFromSenderKey_(escalations[e2].senderKey)) +
        ' (' + escapeHtml_(escalations[e2].account) + ') — ' +
        (elink ? '<a href="' + escapeHtml_(elink) + '">their unsubscribe ' +
          'page</a>' : 'no unsubscribe page on file') + '</li>';
    }
    h += '</ul>';
  }

  if (finals.length) {
    h += '<h3 style="margin:18px 0 6px;">🪦 Ignoring us — block ' +
      'them</h3><p style="margin:4px 0;">These kept mailing even after a ' +
      'manual attempt. I never hide mail myself, but two taps in the Gmail ' +
      'app finishes it: open one of their emails &rarr; tap the three dots ' +
      '(⋮) &rarr; <b>Block sender</b> (or <b>Report spam</b>):</p>' +
      '<ul style="padding-left:18px;">';
    for (var f = 0; f < finals.length; f++) {
      h += '<li style="margin:8px 0;">' +
        escapeHtml_(emailFromSenderKey_(finals[f].senderKey)) +
        ' (' + escapeHtml_(finals[f].account) + ')</li>';
    }
    h += '</ul>';
  }

  if (noMethods.length) {
    h += '<h3 style="margin:18px 0 6px;">🚫 No unsubscribe option — ' +
      'consider blocking</h3><p style="margin:4px 0;">These senders offered ' +
      'no unsubscribe mechanism and mail is still arriving. I never sent a ' +
      'removal request, so I will not claim an unsubscribe failed or ' +
      'succeeded. If you want them gone: open an email &rarr; tap the three ' +
      'dots (⋮) &rarr; <b>Block sender</b> (or <b>Report spam</b>):</p>' +
      '<ul style="padding-left:18px;">';
    for (var nmh = 0; nmh < noMethods.length; nmh++) {
      h += '<li style="margin:8px 0;">' +
        escapeHtml_(emailFromSenderKey_(noMethods[nmh].senderKey)) +
        ' (' + escapeHtml_(noMethods[nmh].account) + ')</li>';
    }
    h += '</ul>';
  }

  if (notes.length || errors.length) {
    h += '<h3 style="margin:18px 0 6px;">📝 Notes' +
      (errors.length ? ' &amp; errors' : '') + '</h3>' +
      '<ul style="padding-left:18px;">';
    for (var n = 0; n < notes.length; n++) {
      h += '<li style="margin:6px 0;">' + escapeHtml_(notes[n]) + '</li>';
    }
    for (var er = 0; er < errors.length; er++) {
      h += '<li style="margin:6px 0;color:#b00020;">' +
        escapeHtml_(errors[er]) + '</li>';
    }
    h += '</ul>';
  }

  h += '<p style="color:#888;font-size:12px;margin-top:24px;">Your ' +
    'unsubscribe agent. It never deletes, hides, or labels mail — it only ' +
    'asks senders to stop, then checks they actually did.</p></div>';
  return h;
}

/**
 * Renders the digest's plain-text fallback body.
 * @param {!Array<!Object>} contenders Pending rows.
 * @param {!Array<!Object>} manuals Actions needing a manual tap.
 * @param {!Array<!Object>} failures Automatic attempts that failed outright.
 * @param {!Array<!Object>} escalations Actions that didn't take.
 * @param {!Array<!Object>} finals Actions still ignored after escalation.
 * @param {!Array<!Object>} noMethods No-method senders still active.
 * @param {!Array<!Object>} held Protected/careful safety holds.
 * @param {!Array<string>} errors Error texts.
 * @param {!Array<string>} notes Note texts.
 * @param {string} webAppUrl Review web app URL.
 * @return {string} Plain text.
 */
function renderDigestPlain_(contenders, manuals, failures, escalations,
    finals, noMethods, held, errors, notes, webAppUrl) {
  var lines = ['Mail cleanup digest', ''];
  if (contenders.length) {
    var sawCareful = false;
    lines.push('Review ' + contenders.length + ' sender(s): ' +
      (webAppUrl || '(web app URL not configured yet)'));
    for (var i = 0; i < contenders.length; i++) {
      var c = contenders[i];
      if (String(c.carefulFlag || '')) sawCareful = true;
      lines.push('- [' + c.account + '] ' +
        (String(c.carefulFlag || '') ? '(careful) ' : '') +
        (c.senderName || c.senderEmail) + ' <' + c.senderEmail + '> — ' +
        c.count14d + ' in 14 days — ' + methodLabel_(c.unsubMethod));
    }
    if (sawCareful) {
      lines.push('(careful) = looks sketchy; unsubscribing or replying can ' +
        'confirm your address to a spammer. Even if you tap Unsub, I will ' +
        'NOT click or email these for you — I hold them and show a safe next ' +
        'step in the digest. Skip is still the safe choice.');
    }
    lines.push('');
  }
  // Link-free, same as the HTML section. This renderer prints targets raw, so
  // no held sender may contribute a target.
  if (held.length) {
    var histPlain = {};
    var hpRows = readTable_('SenderHistory');
    for (var hp = 0; hp < hpRows.length; hp++) {
      histPlain[hpRows[hp].senderKey] = hpRows[hp];
    }
    lines.push('Held back for your safety — I did NOT contact these senders. ' +
      'Important mail stays protected; sketchy mail gets a safe next step.');
    for (var hd = 0; hd < held.length; hd++) {
      var hk = held[hd].senderKey;
      var heldHist = histPlain[hk] || {};
      var protectWhyPlain = String(heldHist.protectReason || '');
      var hw = String(heldHist.carefulFlag || '');
      lines.push('- ' + emailFromSenderKey_(hk) +
        ' (' + held[hd].account + ')' +
        (protectWhyPlain ? ' — kept protected: ' + protectWhyPlain +
          '. No action needed.' :
          ' — looked sketchy' + (hw ? ': ' + hw : '') +
          '. Safest finish: Block sender / Report spam.'));
    }
    lines.push('');
  }
  if (failures.length) {
    lines.push('Automatic unsubscribe failed outright — please use their ' +
      'page instead:');
    for (var fx = 0; fx < failures.length; fx++) {
      lines.push('- ' + emailFromSenderKey_(failures[fx].senderKey) +
        ' (' + failures[fx].account + '): ' +
        (failures[fx].target || '(no link on file)'));
    }
    lines.push('');
  }
  if (manuals.length) {
    lines.push('One tap needed (link-only unsubscribes):');
    for (var m = 0; m < manuals.length; m++) {
      lines.push('- ' + emailFromSenderKey_(manuals[m].senderKey) + ': ' +
        (manuals[m].target || '(no link)'));
    }
    lines.push('');
  }
  if (escalations.length) {
    lines.push('Didn’t take — finish by hand:');
    for (var e = 0; e < escalations.length; e++) {
      lines.push('- ' + emailFromSenderKey_(escalations[e].senderKey) +
        ' (' + escalations[e].account + '): ' +
        (escalations[e].target || '(no link on file)'));
    }
    lines.push('');
  }
  if (finals.length) {
    lines.push('Still ignoring us — consider Block sender / Report spam ' +
      'in the Gmail app:');
    for (var f = 0; f < finals.length; f++) {
      lines.push('- ' + emailFromSenderKey_(finals[f].senderKey) +
        ' (' + finals[f].account + ')');
    }
    lines.push('');
  }
  if (noMethods.length) {
    lines.push('No unsubscribe option — consider Block sender / Report spam. ' +
      'I never sent a removal request, so I am not claiming an unsubscribe ' +
      'failed or succeeded:');
    for (var nm = 0; nm < noMethods.length; nm++) {
      lines.push('- ' + emailFromSenderKey_(noMethods[nm].senderKey) +
        ' (' + noMethods[nm].account + ')');
    }
    lines.push('');
  }
  for (var n = 0; n < notes.length; n++) lines.push('Note: ' + notes[n]);
  for (var er = 0; er < errors.length; er++) lines.push('Error: ' + errors[er]);
  return lines.join('\n');
}

/* ======================================================================
 * REVIEW WEB APP (personal role)
 * ==================================================================== */

/**
 * Web app entry point. Serves the mobile-first review page (ReviewApp.html)
 * listing all pending senders. Deploy on the PERSONAL account only, with
 * "Execute as: Me" and "Who has access: Only myself".
 * @param {!Object} e Event parameter (unused).
 * @return {GoogleAppsScript.HTML.HtmlOutput} The review page.
 */
function doGet(e) {
  if (getRole_() !== ROLE_PERSONAL) {
    return HtmlService.createHtmlOutput(
      '<p>This web app should be deployed on the personal account only.</p>');
  }
  if (!isOwnerRequest_()) {
    // Defense in depth: safety normally rests on the "Only myself"
    // deployment setting; this keeps a misdeployment (e.g. accidentally
    // re-deployed as "Anyone") from exposing the sender list.
    return HtmlService.createHtmlOutput('<p>This page is private.</p>');
  }
  var payload;
  try {
    ensureAllSheets_();
    payload = JSON.stringify(getReviewPayload_());
  } catch (err) {
    logError_('doGet', err);
    payload = JSON.stringify({ items: [], error: String(err && err.message ||
      err) });
  }
  var t = HtmlService.createTemplateFromFile('ReviewApp');
  // <-escape so "</script>" can never break out of the script tag.
  t.payload = payload.replace(/</g, '\\u003c');
  return t.evaluate()
    .setTitle('Unsubscribe review')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * True when the current web-app request comes from the account owner.
 * Under "Execute as: Me" + "Who has access: Anyone", Session.getActiveUser()
 * returns '' for anonymous visitors, so this fails CLOSED on a misdeployment
 * while being a no-op for the owner under the correct settings.
 * @return {boolean} Whether the requester is the owner.
 */
function isOwnerRequest_() {
  var active = String(Session.getActiveUser().getEmail() || '').toLowerCase();
  return !!active && active === getAccountEmail_();
}

/**
 * Decodes the bounded JSON array stored in the shared Sheet. Fail closed to
 * no subjects if a cell was manually edited or contains pre-v2 data.
 * @param {*} value Sheet cell value.
 * @return {!Array<string>} Up to three normalized subjects.
 */
function decodeRecentSubjects_(value) {
  if (!value) return [];
  try {
    var parsed = JSON.parse(String(value));
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 3).map(normalizeSubject_);
  } catch (e) {
    return [];
  }
}

/**
 * Builds the data the review page renders: every Pending row with
 * status = 'pending', in a shape safe to serialize.
 * @return {{items: !Array<!Object>}} Review payload.
 */
function getReviewPayload_() {
  var rows = readTable_('Pending');
  var items = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].status !== 'pending') continue;
    items.push({
      senderKey: String(rows[i].senderKey),
      account: String(rows[i].account),
      senderName: String(rows[i].senderName || ''),
      senderEmail: String(rows[i].senderEmail || ''),
      count14d: Number(rows[i].count14d) || 0,
      unsubMethod: String(rows[i].unsubMethod || 'none'),
      careful: String(rows[i].carefulFlag || ''),
      recentSubjects: decodeRecentSubjects_(rows[i].recentSubjectsJson)
    });
  }
  return { items: items };
}

/**
 * Called by the review page (google.script.run) AFTER the user has seen the
 * confirmation summary and confirmed. Writes Decisions rows, marks Pending
 * rows decided, updates SenderHistory (keep/skip), then immediately executes
 * personal-account unsubscribes. Work-account unsubscribes are left for the
 * work script's hourly worker. Idempotent per senderKey.
 * @param {string} decisionsJson JSON array of {senderKey, decision} where
 *     decision is 'keep' | 'unsub' | 'skip'.
 * @return {{ok: boolean, executedNow: number, queuedWork: number,
 *     manual: number, noMethod: number, failed: number, kept: number,
 *     skipped: number, held: number, protected: number, deferred: number}}
 *     Summary for the confirmation screen.
 */
function submitDecisions(decisionsJson) {
  if (!isOwnerRequest_()) {
    // Defense in depth against a misdeployment with wider access.
    throw new Error('Access denied: this page only works for its owner.');
  }
  var lock = LockService.getScriptLock();
  lock.waitLock(30 * 1000);
  try {
    ensureAllSheets_();
    var list = JSON.parse(String(decisionsJson || '[]'));
    if (!Array.isArray(list)) throw new Error('Bad decisions payload.');

    var pendRows = readTable_('Pending');
    var pendByKey = {};
    for (var p = 0; p < pendRows.length; p++) {
      if (pendRows[p].status === 'pending') {
        pendByKey[pendRows[p].senderKey] = pendRows[p];
      }
    }
    var histRows = readTable_('SenderHistory');
    var histByKey = {};
    for (var h = 0; h < histRows.length; h++) {
      histByKey[histRows[h].senderKey] = histRows[h];
    }
    var decisionRowByKey = {};
    var decRows = readTable_('Decisions');
    for (var d = 0; d < decRows.length; d++) {
      decisionRowByKey[decRows[d].senderKey] = decRows[d];
    }

    var nowIso = iso_(nowMs_());
    var stats = { ok: true, executedNow: 0, queuedWork: 0, manual: 0,
      noMethod: 0, failed: 0, kept: 0, skipped: 0, held: 0,
      protected: 0, deferred: 0 };

    for (var i = 0; i < list.length; i++) {
      var item = list[i] || {};
      var key = String(item.senderKey || '');
      var decision = String(item.decision || '').toLowerCase();
      var row = pendByKey[key];
      if (!row) continue; // stale/unknown — ignore quietly
      if (decision !== 'keep' && decision !== 'unsub' && decision !== 'skip') {
        continue;
      }
      var prior = decisionRowByKey[key];
      if (prior && prior._row) {
        // A decision already exists for this sender (e.g. it was Skipped,
        // then resurfaced after a volume jump). The FRESH decision must
        // supersede it — merely skipping the write would leave a stale
        // 'skip' row that executeDecisionsForAccount_ never executes, so a
        // new Unsub would silently never fire. Clearing executedAt makes a
        // new 'unsub' executable; the Actions-row idempotency check still
        // prevents re-firing at senders we already asked once.
        writeCell_('Decisions', prior._row, 'decision', decision);
        writeCell_('Decisions', prior._row, 'decidedAt', nowIso);
        writeCell_('Decisions', prior._row, 'executedAt', '');
        writeCell_('Decisions', prior._row, 'executedBy', '');
        prior.decision = decision;
        prior.executedAt = '';
      } else {
        appendRowObj_('Decisions', {
          senderKey: key, account: row.account, decision: decision,
          decidedAt: nowIso, executedAt: '', executedBy: ''
        });
        decisionRowByKey[key] = { senderKey: key, decision: decision };
      }
      writeCell_('Pending', row._row, 'status', 'decided');

      var hist = histByKey[key];
      var newState = decision === 'keep' ? 'kept' :
        decision === 'skip' ? 'skipped' : 'unsub_pending';
      if (hist) {
        writeCell_('SenderHistory', hist._row, 'state', newState);
        writeCell_('SenderHistory', hist._row, 'stateChangedAt', nowIso);
      }
      if (decision === 'keep') stats.kept++;
      if (decision === 'skip') stats.skipped++;
      if (decision === 'unsub') {
        // Count by what will ACTUALLY happen, so the done screen is honest:
        // only oneclick/mailto can be auto-executed (work ones within the
        // hour); 'link' needs a manual tap from the next digest, whichever
        // account it belongs to; 'none' can only be watched.
        var unsubMethod = String(row.unsubMethod || 'none');
        // Careful senders are HELD by the safety gate in
        // executeDecisionsForAccount_ — on BOTH accounts — so they must be
        // counted first. Otherwise a personal one vanishes from the report
        // (it is not in exec.ok) and a work one would claim it "goes out
        // within the hour" when in fact nothing will ever be sent.
        var isCarefulRow = !!String(row.carefulFlag || '');
        if (isCarefulRow) {
          stats.held++;
        } else if (unsubMethod === 'none') {
          stats.noMethod++;
        } else if (unsubMethod === 'link') {
          stats.manual++;
        } else if (row.account === ROLE_WORK) {
          stats.queuedWork++;
        }
      }
    }

    // Execute personal-account unsubscribes right now.
    var exec = executeDecisionsForAccount_(ROLE_PERSONAL,
      CFG.MAX_EXECUTIONS_PER_RUN);
    stats.executedNow = exec.ok;
    stats.failed = exec.failed;
    stats.protected += exec.protected;
    stats.deferred += exec.deferred;
    return stats;
  } catch (e) {
    logError_('submitDecisions', e);
    throw new Error('Could not save your decisions: ' +
      (e && e.message ? e.message : e));
  } finally {
    lock.releaseLock();
  }
}

/* ======================================================================
 * EXECUTE (each script for its own account only)
 * ==================================================================== */

/**
 * Hourly worker (work role only): executes any not-yet-executed work-account
 * unsubscribe decisions from the shared Sheet, and runs the verification
 * sweep for its own actions at most every 12 hours.
 */
function workerJob() {
  if (getRole_() !== ROLE_WORK) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) return;
  try {
    ensureAllSheets_();
    executeDecisionsForAccount_(ROLE_WORK, CFG.MAX_EXECUTIONS_PER_RUN);
    var props = PropertiesService.getScriptProperties();
    var lastVerify = Number(props.getProperty(PROP.LAST_VERIFY_MS) || 0);
    if (nowMs_() - lastVerify >
        CFG.VERIFY_MIN_HOURS_BETWEEN * 60 * 60 * 1000) {
      verifySweep_(ROLE_WORK);
      props.setProperty(PROP.LAST_VERIFY_MS, String(nowMs_()));
    }
  } catch (e) {
    logError_('workerJob', e);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Executes 'unsub' Decisions for ONE account (must be the account this
 * script runs as — it sends mail/POSTs as the owner). Execution ladder:
 *   1. oneclick — RFC 8058 POST with body 'List-Unsubscribe=One-Click',
 *      redirects followed, success = HTTP 2xx.
 *   2. mailto — GmailApp.sendEmail as the account (default subject
 *      "unsubscribe").
 *   3. link — no auto-action; recorded as manual_pending so the next digest
 *      presents the link for a manual tap.
 *   4. none — recorded as 'watch' (nothing to fire, nothing failed); the
 *      verify loop watches the sender and the digest suggests Block if mail
 *      keeps coming.
 * Every attempt is logged to Actions with verifyAfter = now + 14 days.
 * Idempotent: rows with executedAt set, or with an existing Actions row for
 * the same senderKey, are never re-fired.
 * @param {string} account Account role whose decisions to execute.
 * @param {number} cap Max executions this run.
 * A protected or careful sender is never auto-actioned: see the safety gates
 * below. Missing protection lookups defer without consuming the action cap.
 * @return {{attempted: number, ok: number, manual: number, failed: number,
 *     held: number, protected: number, deferred: number}} Execution stats.
 */
function executeDecisionsForAccount_(account, cap) {
  var stats = { attempted: 0, ok: 0, manual: 0, failed: 0, held: 0,
    protected: 0, deferred: 0 };
  if (getRole_() !== account) return stats; // only act as ourselves

  var decisions = readTable_('Decisions');
  var todo = [];
  for (var i = 0; i < decisions.length; i++) {
    var r = decisions[i];
    if (r.account === account && String(r.decision) === 'unsub' &&
        !String(r.executedAt || '')) {
      todo.push(r);
    }
  }
  if (!todo.length) return stats;

  var attemptedKeys = {};
  var actions = readTable_('Actions');
  for (var a = 0; a < actions.length; a++) {
    attemptedKeys[actions[a].senderKey] = true;
  }
  var infoByKey = {}; // method/data lookup: Pending first, history fallback
  var pendByKey = {};
  var pendRows = readTable_('Pending');
  for (var p = 0; p < pendRows.length; p++) {
    infoByKey[pendRows[p].senderKey] = pendRows[p];
    pendByKey[pendRows[p].senderKey] = pendRows[p];
  }
  var histRows = readTable_('SenderHistory');
  var histByKey = {};
  for (var h = 0; h < histRows.length; h++) {
    histByKey[histRows[h].senderKey] = histRows[h];
    if (!infoByKey[histRows[h].senderKey]) {
      infoByKey[histRows[h].senderKey] = histRows[h];
    }
  }

  var me = getAccountEmail_();
  var nowIso = iso_(nowMs_());
  for (var t = 0; t < todo.length && stats.attempted < cap; t++) {
    var dec = todo[t];
    var key = dec.senderKey;
    try {
      if (attemptedKeys[key]) {
        // Already attempted earlier (e.g. a retried run): just mark executed.
        writeCell_('Decisions', dec._row, 'executedAt', nowIso);
        writeCell_('Decisions', dec._row, 'executedBy', me);
        continue;
      }
      var info = infoByKey[key];
      if (!info) throw new Error('No method info for ' + key);
      var executionEmail = validEmail_(String(info.senderEmail ||
        emailFromSenderKey_(key)).toLowerCase().trim());

      // PROTECT GATE AT THE LAST POSSIBLE MOMENT. This independently guards
      // decisions made before schema v3 or a scan/backfill. Without it, the
      // hourly work executor or digest's personal catch-up could act before
      // scanJob had a chance to remove an important existing candidate.
      var protectReason = String(info.protectReason || '');
      var protectionChecked = String(info.protectionCheckedAt || '');
      if (!protectReason && !protectionChecked) {
        // Unreadable address = a PERMANENT problem with this one row, so skip
        // just this decision. `break` here would stall every decision queued
        // behind a single corrupted cell, on this and every later run. Left
        // unexecuted (and counted in stats.deferred) rather than routed to the
        // catch below, whose Actions row would copy unsubData into `target` —
        // the one thing a careful sender's row must never expose.
        if (!executionEmail) {
          stats.deferred++;
          continue;
        }
        var finalCheck = protectionDecision_(executionEmail,
          String(info.senderName || ''),
          decodeRecentSubjects_(info.recentSubjectsJson), me);
        if (!finalCheck.lookupOk) {
          // Contrast with the skip above: a failed lookup is TRANSIENT, so
          // stop the whole run. Leaves Decision.executedAt blank for a later
          // retry and avoids repeating one Gmail quota failure per decision.
          stats.deferred++;
          break;
        }
        protectReason = finalCheck.reason;
        protectionChecked = nowIso;
        var pendProtect = pendByKey[key];
        if (pendProtect) {
          writeCell_('Pending', pendProtect._row, 'protectionCheckedAt', nowIso);
          writeCell_('Pending', pendProtect._row, 'protectReason',
            protectReason);
          if (protectReason) {
            writeCell_('Pending', pendProtect._row, 'status', 'protected');
          }
        }
        var histProtect = histByKey[key];
        if (histProtect) {
          writeCell_('SenderHistory', histProtect._row,
            'protectionCheckedAt', nowIso);
          writeCell_('SenderHistory', histProtect._row, 'protectReason',
            protectReason);
        }
      }
      if (!protectReason &&
          (String(info.status || '') === 'protected' ||
           String(info.state || '') === 'protected')) {
        protectReason = 'previously classified as important';
      }
      if (protectReason) {
        var protectedMethod = String(info.unsubMethod || 'none');
        appendRowObj_('Actions', {
          senderKey: key, account: account, method: protectedMethod,
          target: '', attemptedAt: nowIso, result: 'held', verifyAfter: '',
          verifyStatus: 'held_protected'
        });
        attemptedKeys[key] = true;
        writeCell_('Decisions', dec._row, 'executedAt', nowIso);
        writeCell_('Decisions', dec._row, 'executedBy', me);
        var histProtected = histByKey[key];
        if (histProtected) {
          writeCell_('SenderHistory', histProtected._row, 'state', 'protected');
          writeCell_('SenderHistory', histProtected._row, 'stateChangedAt',
            nowIso);
          writeCell_('SenderHistory', histProtected._row, 'protectReason',
            protectReason);
        }
        stats.protected++;
        continue;
      }

      // SAFETY GATE. A sender flagged careful (looks like a spammer/phisher)
      // must never trigger an action that CONFIRMS the address is live —
      // that is the whole point of the flag, and until now it only warned.
      // Held here, before UrlFetchApp.fetch (oneclick) and GmailApp.sendEmail
      // (mailto, which mails AS the user = the loudest possible signal).
      // Link-only and none are held too: the owner's locked policy is never
      // to surface a suspected spammer's link, even with a warning.
      //   target ''      — nothing can later render a spammer's URL/URI as a
      //                    tap target (the plain digest prints target raw).
      //   verifyAfter '' — verifySweep_ skips empty-verifyAfter rows, so a
      //                    held sender can never be recorded 'unsubscribed'
      //                    off 14 days of coincidental silence. We never asked
      //                    them to stop, so we must never claim they did.
      //   no attempted++ — a hold does zero network I/O; counting it would let
      //                    held senders eat the per-run cap and starve real
      //                    unsubscribes. The gate therefore sits above it.
      var carefulFlag = String(info.carefulFlag || '');
      var heldMethod = String(info.unsubMethod || 'none');
      var heldHist = histByKey[key];
      var heldBodyLink = String((heldHist || {}).bodyLink ||
        (heldMethod === 'link' ? info.unsubData : '') || '');
      var recheckedCareful = recheckedCarefulFlag_(carefulFlag,
        executionEmail, heldBodyLink);
      if (recheckedCareful !== carefulFlag) {
        carefulFlag = recheckedCareful;
        var heldPending = pendByKey[key];
        if (heldPending) {
          writeCell_('Pending', heldPending._row, 'carefulFlag', carefulFlag);
        }
        if (heldHist) {
          writeCell_('SenderHistory', heldHist._row, 'carefulFlag',
            carefulFlag);
        }
      }
      if (carefulFlag) {
        appendRowObj_('Actions', {
          senderKey: key, account: account, method: heldMethod, target: '',
          attemptedAt: nowIso, result: 'held', verifyAfter: '',
          verifyStatus: 'held_careful'
        });
        attemptedKeys[key] = true;
        writeCell_('Decisions', dec._row, 'executedAt', nowIso);
        writeCell_('Decisions', dec._row, 'executedBy', me);
        var histHeld = histByKey[key];
        if (histHeld) {
          writeCell_('SenderHistory', histHeld._row, 'state', 'unsub_held');
          writeCell_('SenderHistory', histHeld._row, 'stateChangedAt', nowIso);
        }
        stats.held++;
        continue;
      }

      stats.attempted++;

      var outcome = executeUnsub_(String(info.unsubMethod || 'none'),
        String(info.unsubData || ''), key);
      appendRowObj_('Actions', {
        senderKey: key, account: account, method: outcome.method,
        target: outcome.target, attemptedAt: nowIso, result: outcome.result,
        verifyAfter: iso_(nowMs_() + daysMs_(CFG.GRACE_DAYS)),
        verifyStatus: outcome.verifyStatus
      });
      attemptedKeys[key] = true;
      writeCell_('Decisions', dec._row, 'executedAt', nowIso);
      writeCell_('Decisions', dec._row, 'executedBy', me);
      var hist = histByKey[key];
      if (hist) {
        writeCell_('SenderHistory', hist._row, 'state',
          outcome.result === 'ok' ? 'unsub_attempted' :
          outcome.result === 'manual' ? 'unsub_manual' :
          outcome.result === 'watch' ? 'unsub_watch' : 'unsub_error');
        writeCell_('SenderHistory', hist._row, 'stateChangedAt', nowIso);
      }
      if (outcome.result === 'ok') stats.ok++;
      else if (outcome.result === 'manual') stats.manual++;
      else if (outcome.result !== 'watch') stats.failed++;
      if (outcome.note) appendTransient_('note', outcome.note);
      if (outcome.error) appendTransient_('error', outcome.error);
    } catch (e) {
      stats.failed++;
      logError_('executeDecisionsForAccount_(' + key + ')', e);
      // Record the thrown failure so this decision is NOT retried forever:
      // a timed-out fetch may still have reached the sender, so blind
      // hourly retries could hammer their unsubscribe endpoint, and the
      // repeated error rows would spam every digest. The Actions row routes
      // it into the digest's "automatic unsubscribe failed" section for a
      // manual finish instead.
      try {
        var failInfo = infoByKey[key] || {};
        appendRowObj_('Actions', {
          senderKey: key, account: account,
          method: String(failInfo.unsubMethod || 'none'),
          target: String(failInfo.unsubData || ''),
          attemptedAt: nowIso, result: 'error',
          verifyAfter: iso_(nowMs_() + daysMs_(CFG.GRACE_DAYS)),
          verifyStatus: 'attempt_failed'
        });
        attemptedKeys[key] = true;
        writeCell_('Decisions', dec._row, 'executedAt', nowIso);
        writeCell_('Decisions', dec._row, 'executedBy', me);
        setHistState_(histByKey, key, 'unsub_error');
      } catch (e2) {
        Logger.log('Could not record the failed attempt for ' + key +
          ': ' + e2);
      }
    }
  }
  return stats;
}

/**
 * Performs one unsubscribe attempt using the best available method.
 * @param {string} method 'oneclick'|'mailto'|'link'|'none'.
 * @param {string} data Method data (URL or mailto URI).
 * @param {string} key senderKey (for messages).
 * @return {{method: string, target: string, result: string,
 *     verifyStatus: string, note: (string|undefined),
 *     error: (string|undefined)}} Outcome.
 *     result: 'ok'|'manual'|'watch' (no method exists; not a failure)|
 *     'error'; verifyStatus starts as 'waiting', 'manual_pending',
 *     'watching_no_method', or 'attempt_failed' (the attempt itself failed —
 *     the next digest offers the manual link; distinct from 'didnt_take',
 *     which means a 14-day quiet-check actually ran).
 */
function executeUnsub_(method, data, key) {
  var email = emailFromSenderKey_(key);
  if (method === 'oneclick') {
    // Only ever POST to https. extractUnsubTargets_ already guarantees this,
    // but re-checking at the point of transmission means no future code path
    // can make us POST as the user to a plaintext or non-web endpoint.
    // NOT a sender-domain allowlist, deliberately: legitimate senders almost
    // always host unsubscribe on their ESP's domain (kmail-lists.com,
    // iterable.com, convertkit-mail4.com, resend.com...), so requiring the
    // unsubscribe host to match the From domain would break real, working
    // unsubscribes while stopping nothing a determined sender couldn't do.
    if (!/^https:\/\//i.test(String(data || ''))) {
      return { method: method, target: '', result: 'error',
        verifyStatus: 'attempt_failed',
        error: 'The one-click unsubscribe address for ' + email + ' was not ' +
          'a secure https link, so I did not contact it.' };
    }
    var resp = UrlFetchApp.fetch(data, {
      method: 'post',
      contentType: 'application/x-www-form-urlencoded',
      payload: 'List-Unsubscribe=One-Click',
      followRedirects: true,
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    if (code >= 200 && code < 300) {
      return { method: method, target: data, result: 'ok',
        verifyStatus: 'waiting' };
    }
    return { method: method, target: data, result: 'error',
      verifyStatus: 'attempt_failed',
      error: 'One-click unsubscribe for ' + email + ' returned HTTP ' + code +
        ' — this digest includes their page so you can finish it by hand.' };
  }
  if (method === 'mailto') {
    var parsed = parseMailto_(data);
    if (!parsed) {
      // target '' on purpose: the rejected URI is exactly the thing we must
      // not hand back to the user (the plain digest prints target raw, which
      // on a phone becomes a one-tap composer prefilled to the sender).
      return { method: method, target: '', result: 'error',
        verifyStatus: 'attempt_failed',
        error: 'The unsubscribe reply-address for ' + email + ' was not a ' +
          'single valid address (it may hide extra recipients), so I did ' +
          'not email it — nothing was sent.' };
    }
    GmailApp.sendEmail(parsed.to, parsed.subject,
      parsed.body || 'Please unsubscribe this address from your mailing list.');
    return { method: method, target: parsed.to, result: 'ok',
      verifyStatus: 'waiting' };
  }
  if (method === 'link') {
    // Web pages are inherently human — never auto-clicked (v1 non-goal).
    return { method: method, target: data, result: 'manual',
      verifyStatus: 'manual_pending' };
  }
  // No method at all: nothing to fire, and nothing FAILED either — result
  // 'watch' (not 'error') so one tap doesn't produce two contradictory
  // report lines. A dedicated no-method verification state can observe
  // whether mail continues without ever claiming an unsubscribe occurred.
  return { method: 'none', target: '', result: 'watch',
    verifyStatus: 'watching_no_method',
    note: email + ' offers no unsubscribe method at all — the digest will ' +
      'suggest blocking them if mail keeps coming.' };
}

/**
 * Parses a mailto: URI into recipient, subject, and body.
 * @param {string} uri e.g. 'mailto:leave@x.com?subject=unsubscribe'.
 * @return {?{to: string, subject: string, body: string}} Parsed parts, or
 *     null if the URI is malformed. Subject defaults to 'unsubscribe'.
 */
function parseMailto_(uri) {
  var m = String(uri || '').match(/^mailto:([^?]+)(?:\?(.*))?$/i);
  if (!m) return null;
  var out = { to: safeDecodeUri_(m[1]).trim(), subject: 'unsubscribe',
    body: '' };
  // Must be exactly ONE well-formed address. validEmail_ rejects commas,
  // whitespace and angle brackets, which is what stops a crafted header like
  //   List-Unsubscribe: <mailto:unsub@ok.com,victim@example.com?subject=x>
  // from turning this mailbox into a relay that mails attacker-chosen
  // strangers AS the user. (An '@' test alone happily passes that list.)
  if (!validEmail_(out.to)) return null;
  if (m[2]) {
    var params = m[2].split('&');
    for (var i = 0; i < params.length; i++) {
      // Split on the FIRST '=' only: values like 'subject=unsubscribe=ID123'
      // must keep everything after the first '=' (some ESPs match on it).
      var eq = params[i].indexOf('=');
      var k = String(eq === -1 ? params[i] : params[i].slice(0, eq))
        .toLowerCase();
      var v = safeDecodeUri_(
        String(eq === -1 ? '' : params[i].slice(eq + 1)).replace(/\+/g, ' '));
      if (k === 'subject' && v) out.subject = v;
      if (k === 'body') out.body = v;
    }
  }
  return out;
}

/**
 * decodeURIComponent that never throws: malformed %-sequences (which would
 * raise URIError) fall back to the raw string.
 * @param {string} s Possibly percent-encoded string.
 * @return {string} Decoded string, or the input if undecodable.
 */
function safeDecodeUri_(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return String(s);
  }
}

/* ======================================================================
 * VERIFY (the honesty loop)
 * ==================================================================== */

/**
 * Verification sweep for ONE account's Actions (searches that account's own
 * mailbox, so each script verifies only its own actions).
 *  - 'watching_no_method' rows observe whether mail continues but can only
 *    become 'no_method_active' or 'no_method_quiet' — never 'unsubscribed',
 *    because no removal request was sent.
 *  - 'waiting' rows past verifyAfter (14-day grace): if mail from the sender
 *    arrived after the attempt → 'didnt_take' (digest escalates with the
 *    sender's unsubscribe link); if quiet → 'quiet' and the sender is marked
 *    unsubscribed. Success is measured, never assumed.
 *  - 'escalated' rows past their second window: still arriving →
 *    'final_ignored' (digest suggests Gmail-native Block/Report spam);
 *    quiet → 'quiet'.
 * @param {string} account Account role to verify ('personal'|'work').
 */
function verifySweep_(account) {
  if (getRole_() !== account) return;
  var actions = readTable_('Actions');
  var histRows = readTable_('SenderHistory');
  var histByKey = {};
  for (var h = 0; h < histRows.length; h++) {
    histByKey[histRows[h].senderKey] = histRows[h];
  }
  var checked = 0;
  var now = nowMs_();
  for (var i = 0; i < actions.length; i++) {
    if (checked >= CFG.MAX_VERIFICATIONS_PER_RUN) break;
    var a = actions[i];
    if (a.account !== account) continue;
    var st = String(a.verifyStatus || '');
    var actionMethod = String(a.method || '');

    // Repair historical no-method rows before the date gate. Older versions
    // reused unsubscribe states and could therefore claim "unsubscribed" from
    // coincidental silence even though nothing had been sent.
    if (actionMethod === 'none' && st === 'quiet') {
      writeCell_('Actions', a._row, 'verifyStatus', 'no_method_quiet');
      setHistState_(histByKey, a.senderKey, 'no_method_quiet');
      continue;
    }
    if (actionMethod === 'none' &&
        (st === 'didnt_take' || st === 'escalated' ||
         st === 'final_ignored')) {
      writeCell_('Actions', a._row, 'verifyStatus', 'no_method_active');
      setHistState_(histByKey, a.senderKey, 'no_method_active');
      continue;
    }
    if (actionMethod === 'none' && st === 'final_ignored_surfaced') {
      writeCell_('Actions', a._row, 'verifyStatus',
        'no_method_active_surfaced');
      setHistState_(histByKey, a.senderKey, 'no_method_active');
      continue;
    }

    var vAfter = toMs_(a.verifyAfter);
    if (!vAfter || now <= vAfter) continue;
    var email = emailFromSenderKey_(a.senderKey);
    try {
      if (actionMethod === 'none' &&
          (st === 'watching_no_method' || st === 'waiting')) {
        var noMethodSince = Math.floor(toMs_(a.attemptedAt) / 1000);
        var noMethodArrivals = GmailApp.search(
          'from:' + email + ' after:' + noMethodSince, 0, 3);
        checked++;
        var stillActive = noMethodArrivals.length > 0;
        writeCell_('Actions', a._row, 'verifyStatus',
          stillActive ? 'no_method_active' : 'no_method_quiet');
        setHistState_(histByKey, a.senderKey,
          stillActive ? 'no_method_active' : 'no_method_quiet');
      } else if (st === 'waiting') {
        var sinceSec = Math.floor(toMs_(a.attemptedAt) / 1000);
        var arrivals = GmailApp.search('from:' + email + ' after:' + sinceSec,
          0, 3);
        checked++;
        var took = arrivals.length === 0;
        writeCell_('Actions', a._row, 'verifyStatus',
          took ? 'quiet' : 'didnt_take');
        setHistState_(histByKey, a.senderKey,
          took ? 'unsubscribed' : 'didnt_take');
      } else if (st === 'escalated') {
        // The escalation moment was verifyAfter minus one grace window.
        // Skip a buffer after that moment: mail that was already in flight
        // when the user manually finished the unsubscribe must not count as
        // "still arriving" (it would wrongly mark a compliant sender
        // final_ignored).
        var escSec = Math.floor((vAfter - daysMs_(CFG.GRACE_DAYS) +
          daysMs_(CFG.ESCALATED_QUIET_BUFFER_DAYS)) / 1000);
        var arrivals2 = GmailApp.search('from:' + email + ' after:' + escSec,
          0, 3);
        checked++;
        var quietNow = arrivals2.length === 0;
        writeCell_('Actions', a._row, 'verifyStatus',
          quietNow ? 'quiet' : 'final_ignored');
        setHistState_(histByKey, a.senderKey,
          quietNow ? 'unsubscribed' : 'final_ignored');
      }
    } catch (e) {
      logError_('verifySweep_(' + email + ')', e);
    }
  }
}

/**
 * Updates a SenderHistory row's state (+ timestamp) if the row exists.
 * @param {!Object<string, !Object>} histByKey History rows by senderKey.
 * @param {string} key senderKey.
 * @param {string} state New state value.
 */
function setHistState_(histByKey, key, state) {
  var hist = histByKey[key];
  if (!hist) return;
  writeCell_('SenderHistory', hist._row, 'state', state);
  writeCell_('SenderHistory', hist._row, 'stateChangedAt', iso_(nowMs_()));
}
