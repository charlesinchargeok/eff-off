# eff-off

**Tell mailing lists to eff off — and actually check that they did.**

An inbox-cleanup agent that runs entirely inside your own Google account.

Every couple of days it emails you one digest of the mailing lists that have
started showing up in your inbox. You tap **Keep / Unsub / Skip** on your
phone. It then sends the real unsubscribe requests for you — and two weeks
later, checks whether they actually worked.

No servers. No third-party service. No AI reading your mail. Your data never
leaves your Google account.

> **Status: working, but early — and built in public.**
>
> The engine is the finished part: detection, the safety gates, execution, and
> the 14-day verification loop all run daily on real mail.
>
> The surfaces are not. The digest email and the review app are **functional
> but visually unpolished** — plain HTML, no design system, no icon, no
> onboarding. Setup is still copy-paste into Google Apps Script rather than an
> install. Expect something that works and looks like it was built by one
> person on evenings, because it was.
>
> Fixing that is the near-term roadmap, not an afterthought — see
> [Where this is going](#where-this-is-going).

---

## Why this exists

Most "unsubscribe" tools do one of two things, and both are worse than they look:

- **They hide the mail.** A filter that archives a newsletter leaves you just
  as subscribed as before. Your address stays on the list, gets re-sold, and
  the underlying problem grows quietly.
- **They read your mailbox on their servers.** You solve a junk-mail problem by
  handing a company full access to everything you've ever received.

This does neither. It sends a genuine removal request to the sender, using the
standard mechanisms mail providers already support — and it never touches the
`gmail.modify` scope, so it *cannot* hide, label, archive, or delete a single
message even if it wanted to.

Then it does the part almost nothing else does: **it checks.**

## The honesty loop

An unsubscribe endpoint returning `200 OK` does not mean you were
unsubscribed. It means a web server said "OK."

So every unsubscribe gets a 14-day timer. When it expires, the agent searches
your own mailbox for new mail from that sender:

- **Nothing arrived** → recorded as genuinely unsubscribed.
- **Mail still arriving** → the next digest flags it and hands you the sender's
  own unsubscribe page for a one-tap manual finish.
- **Still arriving after that** → it suggests blocking them, which is two taps
  in the Gmail app. It never blocks for you.

Success is measured, never assumed. That principle runs through the whole
codebase — including a refusal to report an unsubscribe as "failed" for senders
who never offered an unsubscribe mechanism in the first place, since no request
was ever sent.

## Two guardrails worth knowing about

**The PROTECT gate.** The worst possible failure for this kind of tool is
unsubscribing you from something that mattered. So important senders never
reach the review list at all: security and 2FA codes, receipts, order and
shipping updates, statements, healthcare and appointments, government mail,
anyone in your own organization, anyone you've ever replied to, anything you
starred or Gmail marked important, and real people in your Primary tab. Each
protected sender is logged with a plain-English reason you can read in the
audit sheet.

**The careful gate.** Some "unsubscribe" links are bait — clicking one, or
replying to one, confirms to a spammer that your address is real and actively
read. So senders that look sketchy (freemail origin, display-name/domain
mismatch, no standard unsubscribe header and no unsubscribe link on their own
domain) are **never contacted automatically, and their links are never shown to
you at all.** You get Block/Report guidance instead. The agent will not hand
you a tap target it doesn't trust.

## The review app

You don't manage this from a spreadsheet. Setup deploys a **private mobile web
app** — a real page you open on your phone, add to your home screen, and use in
about 60 seconds:

- One card per sender, showing **the last three subject lines** they sent you,
  so you can tell a newsletter you forgot about from one you actually read.
- **Keep / Unsub / Skip** per sender. Skip is the default; nothing is
  pre-selected for you.
- One **Apply** button, then a confirmation screen listing exactly what is
  about to happen, and how many. Nothing executes without that second tap.
- Suspected-spam senders are grouped separately behind a warning, and their
  buttons say **Handle safely** — the agent won't hand you their link at all.

It's deployed as "execute as me / only myself," so it is reachable by exactly
one Google account: yours. It is not on the public internet.

## How it works

One file of plain JavaScript (`src/Code.gs`) pasted into Google Apps Script,
plus the mobile review page (`src/ReviewApp.html`). A Google Sheet acts as its
notebook and your audit trail — you can open it any time and see every sender
it has seen and every action it has taken.

```
Gmail  ──scan──▶  Google Sheet  ──digest──▶  your inbox
                       ▲                          │
                       │                       tap Review
                  audit trail                     ▼
                       │                   mobile review page
                       └──────decisions───────────┘
                                  │
                         unsubscribe + verify
```

Optionally runs on a second mailbox (a work account, say) that feeds the same
single digest.

**Setup takes about 15 minutes and requires no coding** — see **[SETUP.md](SETUP.md)**.
It's written for a non-technical reader, including the alarming "Google hasn't
verified this app" screen, which is expected and explained.

For the architecture and the reasoning behind each decision, see
**[docs/DESIGN.md](docs/DESIGN.md)**.

## Requirements

- A Google account (consumer Gmail or Workspace)
- No installs, no command line, no hosting, no cost

## Tests

```bash
node --test tests/*.test.js
```

32 tests covering the protection gate, the careful gate, the schema
migrations, and the subject-line capture. They stub the Apps Script globals, so
they run in plain Node with no Google dependency.

## Where this is going

The long-term goal is a **self-serve app anyone can use to clean up their
inbox** — no copy-pasting code into Apps Script, no reading a 25-step guide.

Getting there means, roughly in order:

- [ ] A history view — what has actually happened, and what actually worked
- [ ] Delivery preference (digest / app-only / both)
- [ ] Real visual identity and a home-screen icon
- [ ] A genuine one-click install instead of the paste-and-configure flow

And two bigger pieces:

**Work with any mail provider, not just Gmail.** Today this is built on Google
Apps Script, which is what makes it free, serverless, and private — but it also
locks it to Gmail. The detection, protection, and verification logic is not
Gmail-specific; only the mailbox access is. Outlook/Microsoft 365, Fastmail, and
plain IMAP are the targets. Doing this without giving up "runs in your own
account, not on my server" is the hard part, and the interesting one.

**Finish the unsubscribes that don't finish themselves.** The honest gap in the
current design: when a sender offers only an unsubscribe *web page* — a form,
a preference centre, a "click here then confirm" wizard — the agent hands the
link back to you and you tap through it yourself. That is the single biggest
source of remaining manual work, and it's exactly what a computer-use agent
could drive end to end: open the page, find the right control, confirm, and
report what it saw. v1 deliberately ruled this out as "inherently human." That
assumption is now worth revisiting.

It would need real guardrails to stay consistent with the rest of this project:
never on a sender flagged careful, never entering anything beyond the address
already being unsubscribed, and the same verify-don't-assume loop afterwards —
a wizard that *looks* completed still has to prove it by going quiet.

Building it in public. Issues and ideas welcome — particularly from anyone
who's fought the same problem.

## What it deliberately does not do

- **No `gmail.modify` scope.** It cannot hide, label, archive, or delete mail.
- **No AI on your messages.** Subject lines and Gmail signals stay inside your
  Google account. Nothing is sent to a model or any third party.
- **No browser automation** of unsubscribe wizards — those need a human.
- **No dark patterns.** It won't claim a success it hasn't verified.

## License

MIT — see [LICENSE](LICENSE).
