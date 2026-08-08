# Setting up eff-off

This guide walks you through installing the agent on your Gmail account. Total
time: about 15 minutes for one account, 20 for two. You will not need to write
or understand any code — only copy, paste, and click.

**What you're building:** a small helper that lives inside your own Google
account. Every couple of days it emails you one digest of new mailing lists,
you tap Keep / Unsub / Skip on your phone, and it sends the real unsubscribe
requests for you — then checks two weeks later that they actually worked.
Nothing runs on anyone else's servers, and it can never delete or hide your
mail.

**One account or two?** Most people want one. Parts 1–3 set that up. If you
also want a second mailbox covered (a work account, say), Part 4 adds it — it
feeds the same digest, so you still only get one email. Part 4 is entirely
optional; skip it and everything still works.

**Have ready:** the two files in this project's `src` folder — `Code.gs` and
`ReviewApp.html`. You'll paste their contents in Steps 8 and 9.

Throughout this guide, **`you@gmail.com`** means your main Gmail address and
**`you@work.com`** means the optional second account. Substitute your own.

---

## Part 1 — Create the shared notebook (5 minutes)

The agent keeps its records in one Google Sheet — think of it as its notebook.
It's also your audit trail: you can open it anytime to see exactly what the
agent has seen and done.

1. In a browser where you're signed in as **`you@gmail.com`**, go to
   **sheets.google.com** and click the **blank** (+) spreadsheet.
2. Click "Untitled spreadsheet" at the top-left and rename it to
   **Unsubscribe Agent**.
3. **Two-account setup only:** click the green **Share** button (top-right).
   In the "Add people" box type **`you@work.com`**, make sure the dropdown says
   **Editor**, and click **Send**. (Editor means the second account is allowed
   to write in the notebook too.) *One-account setup: skip this step.*
4. Now copy the Sheet's ID. Look at the web address (URL) of the sheet. It
   looks like this:

   `https://docs.google.com/spreadsheets/d/`**`1AbC2dEfG3hIjK4lMnO5pQr6StUvW7xYz`**`/edit`

   The ID is the long jumble of letters and numbers **between `/d/` and
   `/edit`**. Select just that part, copy it, and paste it somewhere handy
   (a note on your phone is fine) — you'll need it once per account.

Don't worry about adding tabs or columns — the agent creates all of that
itself the first time it runs.

---

## Part 2 — Install on your main account (7 minutes)

"Apps Script" is Google's built-in place for personal automations — it runs
Google-approved code inside your own account.

5. Still signed in as **`you@gmail.com`**, go to **script.google.com** and
   click **New project** (top-left).
6. Click "Untitled project" at the top and rename it to
   **Unsubscribe Agent — personal**.
7. You'll see a file called `Code.gs` open in the middle of the screen with a
   few lines of starter text in it. Click in that area, select everything
   (Cmd+A on Mac, Ctrl+A on Windows), and delete it.
8. Open this project's **`src/Code.gs`** file on your computer, select all of
   it, copy, and paste it into that empty editor. Then click the little disk
   icon (or press Cmd+S) to save.
9. Add the review page: in the left sidebar, next to the word **Files**,
   click the **+** and choose **HTML**. Name it exactly **ReviewApp**
   (Google adds the `.html` part itself). Delete the starter text in it,
   paste in the entire contents of this project's **`src/ReviewApp.html`**,
   and save again.
10. Tell the script which account it is and where the notebook lives:
    - Click the **gear icon (⚙️ Project Settings)** in the left sidebar.
    - While you're here: under **General settings**, set **Time zone** to your
      own. That's what makes the digest arrive around 7am your local time.
    - Scroll to the bottom to **Script Properties** and click
      **Add script property**. Add these two (watch the spelling —
      capital letters matter):

      | Property | Value |
      |---|---|
      | `ACCOUNT_ROLE` | `personal` |
      | `SHEET_ID` | *(paste the Sheet ID from step 4)* |

    - Click **Save script properties**.
11. Now switch it on. Go back to the code editor (the `< >` icon in the left
    sidebar). In the toolbar above the code there's a dropdown that probably
    says `doGet` — click it and choose **`setup`**. Then click **Run**.
12. **The scary permission screen — this is normal.** Google now asks if this
    script may access your Gmail and Sheets. Because you pasted it yourself
    rather than installing it from their store, Google shows an intimidating
    warning. Here's exactly what you'll see and what to click:
    - A window titled **"Authorization required"** → click
      **Review permissions**.
    - Choose **`you@gmail.com`**.
    - A screen saying **"Google hasn't verified this app"** → this just means
      *you* installed it rather than a company Google has vetted. It's code you
      can read, running in your own account. Click the small **Advanced** link
      at the bottom-left, then click **Go to Unsubscribe Agent — personal
      (unsafe)**. ("Unsafe" is Google's blanket label for anything
      unverified — it isn't a judgment about this script.)
    - A list of permissions. **Important: Google describes the MAXIMUM each
      permission allows, not what this code actually does** — so expect
      alarming wording like *"Read, compose, send, and permanently delete all
      your email from Gmail"*, *"See, edit, create, and delete all your
      spreadsheets"*, and *"Allow this application to run when you are not
      present"* (that last one is just the timers). The code never deletes,
      hides, or labels anything — every action it takes is written into the
      audit Sheet where you can check it. If the screen shows a checkbox next
      to each permission, tick every one (or tap **Select all**), then press
      **Allow** or **Continue** — whichever button appears.
13. The script now runs `setup` — it takes a few seconds. When it's done,
    check your inbox: you should have an email titled **"Unsubscribe agent:
    setup complete (personal)"**. If you open the Google Sheet, you'll also
    see five new tabs along the bottom (Pending, Decisions, Actions,
    SenderHistory, Config). That's it working.

---

## Part 3 — Publish your review page (3 minutes)

This creates the private web page where you'll tap Keep / Unsub / Skip from
your phone. "Deploying" just means giving the page an address.

14. In the same Apps Script project, click the blue **Deploy** button
    (top-right) → **New deployment**.
15. Click the **gear icon** next to "Select type" and choose **Web app**.
16. Fill in the three fields exactly like this:
    - **Description:** `review page` (or anything you like)
    - **Execute as:** **Me** — the page acts with your permissions.
    - **Who has access:** **Only myself** — nobody but you, signed in as
      `you@gmail.com`, can even load it.
17. Click **Deploy**. Google shows you a **Web app URL** ending in `/exec`.
    Click **Copy**.
18. Open the **Unsubscribe Agent** Google Sheet, go to the **Config** tab
    (bottom of the screen), find the row that says **webAppUrl** in column A,
    and paste the URL into **column B** of that same row. This is how the
    digest email knows where to send you.
19. **Test the page on your phone now — don't wait for the first digest.**
    Send yourself the URL and open it on your phone. It only loads when the
    phone browser is signed in as `you@gmail.com`. If you instead see
    **"You need access"**, a sign-in page, or "Sorry, unable to open the
    file", your phone's browser is using a different Google account first:
    open Safari or Chrome (not the Gmail app's built-in viewer), sign in to
    `you@gmail.com` there — or tap your Google profile picture and make it the
    default account — then reload the link. Sorting this out now means the
    blue Review button in your digests will just work.

**One-account setup: you're done.** Skip to "How you'll know it's working".

---

## Part 4 — Optional: add a second account (5 minutes)

Same recipe, shorter: the second copy has no digest and no web page — it just
scans its own inbox and carries out that account's unsubscribes. Its senders
appear in the same single digest.

20. Open a browser window signed in as **`you@work.com`** (easiest: use a
    different browser profile, or an Incognito window where you sign into only
    that account).
21. Go to **script.google.com** → **New project** → rename it
    **Unsubscribe Agent — work**.
22. Paste in the same two files exactly as in steps 7–9 (`Code.gs` contents
    into Code.gs, and a new HTML file named **ReviewApp** with the
    `ReviewApp.html` contents — it's unused on this account, but keeping the
    two projects identical avoids mistakes later).
23. In **Project Settings**, set the Time zone to match the first account, and
    add these Script Properties:

    | Property | Value |
    |---|---|
    | `ACCOUNT_ROLE` | `work` |
    | `SHEET_ID` | *(paste the same Sheet ID from step 4)* |

24. Back in the editor, pick **`setup`** from the function dropdown and click
    **Run**, and click through the permission screens just like step 12
    (choose **`you@work.com`** this time). If this is a Google Workspace
    account, the wording may differ slightly or the "unverified" warning may
    not appear at all — either way, end by clicking **Allow**.

    If instead you see **"This app is blocked"** or "Verification required —
    request access from your admin" with **no Advanced link** to click
    through, that's a Workspace admin setting. If you're the admin you can
    lift it: **admin.google.com** → **Security** → **Access and data
    control** → **API controls**, set unconfigured third-party apps to
    **"Allow users to access any application"** (or add this script as a
    trusted app), wait a few minutes, then run `setup` again. If you're not
    the admin, you'll need to ask them.
25. Look for the **"setup complete (work)"** confirmation email in that
    inbox. No deployment step here — you're done.

---

## How you'll know it's working

- **Within a few hours:** open the Google Sheet — the **Pending** tab starts
  filling with mailing-list senders it has spotted (it looks back 3 days on
  its very first scan).
- **Within 2 days, around 7am:** your first digest lands in `you@gmail.com`,
  listing new senders with a big blue **Review** button.
- **Impatient?** In the Apps Script editor, choose **`scanJob`** from the
  function dropdown and click **Run** — then check the Pending tab a minute
  later. You can also run **`digestJob`** the same way to force the first
  digest.
- **No digest arrives?** That can be good news — the agent skips the email
  entirely when there's nothing new to show.

## What to expect after that

- Tap **Review** in the digest → pick Keep / Unsub / Skip → **Apply** → the
  page shows you exactly what it's about to do and asks you to confirm.
  Unsubscribes on your main account go out instantly; second-account ones
  within the hour — except senders that only offer an unsubscribe web page (no
  automatic method), which come back to you as a one-tap link in the next
  digest instead.
- 14 days after each unsubscribe, the agent checks whether that sender
  actually went quiet. If they didn't, the next digest flags them with their
  unsubscribe link so you can finish the job with one tap — and if they
  *still* keep mailing, it suggests blocking them (two taps in the Gmail
  app; the agent never blocks or hides mail on its own).
- **Some senders will never appear at all.** Anything the agent judges
  important — security codes, receipts, your bank, appointments, people you've
  replied to — is deliberately kept out of the review list. The
  **SenderHistory** tab records each one with a plain-English `protectReason`
  so you can see why.

## If something goes wrong

- **"Script Property ACCOUNT_ROLE must be..." when running setup** — the
  property is missing or misspelled. Redo step 10/23; values must be exactly
  `personal` or `work`, all lowercase.
- **The Review button shows "You need access", a sign-in page, or "Sorry,
  unable to open the file"** — your phone's browser is signed in to a
  different Google account (or none). The review page only opens for the
  account that deployed it. Open the link in Safari or Chrome rather than the
  Gmail app's built-in viewer, sign in there (or make it your default
  account), then reload. See step 19.
- **"This app is blocked" on a Workspace account, with no Advanced link** —
  an admin setting; see the note under step 24.
- **An error mentioning the spreadsheet or "openById"** — the `SHEET_ID` is
  wrong (recopy just the part between `/d/` and `/edit`), or, on a second
  account, the Sheet wasn't shared as **Editor** (redo step 3).
- **The digest says the review page URL isn't set** — redo step 18: the URL
  goes in column B of the **webAppUrl** row on the **Config** tab.
- **Anything else** — the agent reports its own problems in the "Notes &
  errors" section of your digest instead of failing silently. And you can
  always re-run **`setup`** safely; it cleans up after itself and never
  creates duplicates.
