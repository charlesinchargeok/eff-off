# eff-off — Design

## Goal
Every other day, surface new mailing-list senders from your Gmail account(s) in
ONE digest email; let you decide Keep/Unsub/Skip from your phone in ~60
seconds; then actually execute real unsubscribes and verify they took.

**North star:** genuinely unsubscribe (a real removal request to the sender).
Never hide mail. The unsubscribe attempt itself is the backstop.

## Accounts
- **personal** — your main Gmail. PRIMARY, and the only role a one-account
  setup needs. Runs the "spokesperson" script: sends the digest, hosts the
  review web app.
- **work** — OPTIONAL second mailbox (e.g. a Google Workspace account). Runs a
  worker script that executes actions for its own account only. Its senders
  appear in the same single digest.

## Non-goals (deliberate)
- NO `gmail.modify`: no filtering, archiving, deleting, labeling, spam-marking.
- NO browser automation of unsubscribe web pages/wizards. **v1 scoping call,
  now worth revisiting:** this was ruled out as "inherently human," but a
  computer-use agent could plausibly drive these flows end to end. It is the
  largest remaining source of manual work. Any such feature would have to
  inherit the existing guardrails — never on a careful-flagged sender, never
  entering data beyond the address being unsubscribed, and still subject to the
  verify-don't-assume loop afterwards.
- NO data-deletion engine (legal requests are manual/low-yield; take a
  "delete my data" option only when trivially present on the path we're on).
- NO per-account digests. Exactly ONE digest.
- NO AI/LLM on message content. Subject text and Gmail signals never leave the
  Google account.

## Architecture
One codebase (`src/Code.gs` + `src/ReviewApp.html`), pasted into one or two
Google Apps Script projects — one per account. The `ACCOUNT_ROLE` script
property (`personal` | `work`) switches behavior. Scripts run AS the account
owner on time triggers. No external servers, no third-party services; data
never leaves your accounts (only outbound unsubscribe POSTs/emails to senders).

### Coordination: shared Google Sheet ("the notebook")
Created under the primary account's Drive; in a two-account setup, shared
(editor) with the second account. Both scripts read/write it; it is also the
human-readable audit trail. Tabs:

- **Pending** — contenders awaiting decision: account, senderKey, senderName,
  senderEmail, firstSeen, count14d, unsubMethod (oneclick|mailto|link|none),
  unsubData, carefulFlag, digestBatchId, status (pending|protection_pending|
  protected|decided), recentSubjectsJson (last three subjects, newest first),
  protectionCheckedAt, protectReason
- **Decisions** — senderKey, account, decision (keep|unsub|skip), decidedAt,
  executedAt, executedBy
- **Actions** — unsubscribe attempts: senderKey, account, method, target,
  attemptedAt, result (ok|manual|watch|held|error), verifyAfter (attemptedAt +
  grace when verification applies), and an explicit verification/hold state.
  A `none` method uses `watching_no_method` → `no_method_quiet` or
  `no_method_active`; those states never imply an unsubscribe request occurred.
- **SenderHistory** — every sender ever seen + current state, recent subject
  snapshot, protection-check timestamp, and plain-English protection reason,
  so digests only show NEW eligible senders and escalations (kept/protected
  senders never appear)
- **Config** — webAppUrl, sheet schema version, lastDigestAt, checkpoints

### Roles
- **personal script:** scan own inbox → write Pending; build+send the combined
  digest every 2 days; host review web app (doGet); on Apply, execute its own
  actions immediately; run verification sweep.
- **work script:** scan own inbox → write Pending; hourly trigger executes any
  undone work-account decisions from the Sheet; run verification sweep for its
  own actions.

## Flows

### 1. Scan (each account, on its timer)
- Forward-only. Checkpoint = last processed message time (ms), stored in
  Script Properties per account. First run ever: 3-day lookback, then strictly
  forward. Process each message at most once.
- Search inbox+archive, exclude sent/draft/spam/trash/chats.
- Subscription detection: `List-Unsubscribe` header present OR an
  "unsubscribe" link in the body. Prefer `GmailMessage.getHeader()`; fall back
  to parsing `getRawContent()` if needed.
- New sender (not in SenderHistory for that account) → one quota-conscious
  Gmail lookup for the 14-day volume and three newest subject lines.
- **PROTECT gate before Pending:** keep security/2FA, receipts/orders/
  statements, healthcare, government, same-organization mail, Gmail
  Updates/Purchases/Reservations, starred/important senders, replied-to
  senders, and person-like Primary senders out of review. Protected senders are
  recorded in SenderHistory with the reason but never become unsubscribe
  candidates. Existing Pending rows are checked in bounded batches; a transient
  Gmail lookup failure stays hidden as `protection_pending` and retries later.
- Subject text and Gmail signals stay inside the Google account and its Sheet;
  no AI or outside service receives them.
- Sketchy heuristic → `carefulFlag`: freemail/lookalike sender, display-name/
  domain mismatch, or no List-Unsubscribe header **and** no body-unsubscribe
  link in the sender's exact domain tree. This last exception prevents real
  bulk mail (USPS- and Reddit-style senders that omit the header) from being
  mislabeled, while cross-domain links, freemail, and lookalikes remain
  careful. Careful senders get a ⚠️ badge, are grouped separately, and are
  NEVER auto-contacted. Their links are never surfaced either; choosing Handle
  safely creates a link-free hold with Block/Report guidance.

### 2. Digest (personal script, every 2 days, ~7am local)
One email from the primary account to itself:
- **New contenders** grouped by account (📧 personal / 💼 work), each with
  sender, 14-day volume ("11 in 14 days"), method available, ⚠️ if careful.
- **Escalations** — unsubscribes that didn't take (see Verify), each with the
  sender's own unsubscribe-page link for manual finish.
- **No unsubscribe option** — senders that offered no removal mechanism and
  remain active get separate, link-free Block/Report guidance. The digest says
  plainly that no request was sent; it never labels these as failed or
  successful unsubscribes.
- **Errors/notes** — anything the agent couldn't do, said plainly.
- One tap-through link to the review web app. Skip sending if nothing to show.

### 3. Review + Apply (web app, access: only the owner)
- Mobile-first page listing pending senders with their three latest subject
  lines: per-sender Keep / Unsub / Skip (default Skip). Careful group visually
  separated.
- One **Apply** button → confirmation summary (exact counts + list) → confirm
  → write Decisions. Nothing executes without this two-step confirm.
- Primary-account unsubs execute immediately; second-account rows are picked up
  by that script within the hour. UI says so honestly.

### 4. Execute (each script for its own account only)
Before any network call, execution independently re-checks protection for old
or pre-migration decisions. Protected senders become a link-free safety hold;
if Gmail is temporarily unavailable, the decision stays unexecuted for a safe
retry. Then the best available method is logged to Actions:

1. **RFC 8058 one-click**: `List-Unsubscribe` https URL +
   `List-Unsubscribe-Post: List-Unsubscribe=One-Click` → UrlFetchApp POST,
   body `List-Unsubscribe=One-Click`, follow redirects, success = 2xx.
2. **mailto:** parse address/subject from header → GmailApp.sendEmail AS the
   account (subject default "unsubscribe").
3. **Body link only** → no auto-action; digest presents the link for manual tap.

- **Careful override:** regardless of detected method, a careful sender becomes
  a link-free safety hold before any network call or link rendering.
- Keep = mark SenderHistory kept (never surfaced again). Skip = resurface only
  if volume jumps (>5 in 14d) after 30 days.

### 5. Verify (the honesty loop)
- Grace period: 14 calendar days (~10 business days, the CAN-SPAM allowance).
- At each digest run: for Actions past `verifyAfter`, search
  `from:<addr> after:<attemptedAt>`; arrivals > 0 → `didnt_take` → escalate in
  next digest with the sender's unsubscribe page link.
- A `none` action uses a separate observation-only state. After the grace
  period it becomes `no_method_active` or `no_method_quiet`, never `quiet` /
  `unsubscribed`, because the agent did not send a removal request.
- Still arriving after manual attempt → `final_ignored` → digest suggests
  Gmail-native Block sender / Report spam (two taps in the Gmail app; the agent
  never does it for you — no modify scope).
- Quiet → `quiet`. Success is measured, never assumed.

## Constraints & care
- Consumer quotas: ~100 GmailApp email sends/day, 20k UrlFetch/day — far above
  need, but batch and cap work per run (e.g. ≤50 new senders/run, ≤20
  migration backfills/run).
- All writes idempotent (senderKey = normalized from-address + account);
  re-runs must not duplicate Pending rows or double-fire unsubscribes.
- Every function try/caught; failures land in the digest's Errors section, not
  silently swallowed.
- Plain V8 JavaScript, no libraries, single Code.gs; JSDoc on every function.
- `SETUP.md` is written for a NON-TECHNICAL user: numbered steps, the
  unverified-app screen explained calmly, web app deployment (execute as me /
  only myself), Sheet share + ID paste, trigger creation via a one-tap
  `setup()` function. Target ≤20 minutes total.
