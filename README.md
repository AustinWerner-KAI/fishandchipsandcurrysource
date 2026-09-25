# Sourcer

LinkedIn sourcing and outreach that runs as you, in a real browser on your Mac, with daily caps and working hours.

**Read this first.** This automates your own LinkedIn account. That is against LinkedIn's terms. If LinkedIn spots it they can restrict or close the account. Keep the caps low, keep it inside working hours, and stop the moment you see a security check.

## First run

1. Double-click `Sourcer.command`. It installs what it needs, then opens the app in your browser at http://localhost:4747. Keep the terminal window it opens; closing it stops everything. If macOS says it can't open the file, right-click it, choose Open, then Open again. Once is enough.
2. Press **Log in to LinkedIn**. Chrome opens. Log in by hand. The window closes on its own.
3. Set up the role (below). Press **Search**. People appear in the table as `new`.
4. Tick **approved** next to the people you want to contact, or use **Approve all shown** on a filter. Or export the CSV, have Claude shortlist it, and paste the approved links back into Add people with "approve them straight away" ticked.
5. Press **Run one pass** to watch it work once, then **Run all day**. It works inside the hours in settings. Keep the window open and the Mac awake. **Stop** ends it.

## Setting up a role

One role is one campaign. Press **+ new role** for the next one.

1. **Paste the job spec** (or pick the .pdf / .docx / .txt) and press Read spec.
2. **Check what it read**: title, office location, on site / hybrid / remote. For a remote role, say which countries candidates can be in. Countries work best.
3. **Build the search.** It lists the job titles to look for, the industry words, optional must-have skills, and words that rule someone out (recruiters, by default). The boolean is built from those and kept simple: `(titles) AND (industry) [AND skills] NOT (recruiters)`. Edit it by hand if you like, then **Save and search LinkedIn**.

Locations become LinkedIn's location filter. Common countries and cities are known already; anything else is looked up on LinkedIn the first time you press Search and remembered. If a place can't be found, the search runs without that filter and the log says so. Open the search on LinkedIn, set the location by hand, and paste the URL into the campaign settings to override.

The first follow-up message names the role and location. Edit the templates in settings. Templates take `{firstName}`, `{name}`, `{company}`, `{headline}`.

## What happens after Search

- Connection request goes out to each approved person, with a note picked at random from the notes in settings.
- When they accept, the follow-ups in settings go out on their timers (`days` counted from the previous message).
- Any reply stops everything for that person and shows on the dashboard. No automated message ever follows a reply.
- To send a specific message to a specific person, write it under **Hand-written messages** as JSON. Those go before the templates. From the terminal: `npm run queue <campaign> messages.json`.

```json
[
  { "url": "https://www.linkedin.com/in/someone/", "text": "Hi Sara, the brief is attached. Happy to talk it through this week.", "note": "sent brief" }
]
```

`notBefore` (ISO date) holds a message until a date. Someone who has replied is frozen; after you have answered them by hand, add `"resume": true` to the next queued item to let it send.

Everything the app does is also available from the terminal (`npm run ...`, below), and `npm run menu` gives the old text menu. The new-business (per-person) mode still exists for campaign files with `"mode": "newbusiness"`; see `campaigns/examples/`.

## Commands

```
npm run login
npm run search <campaign> [url] [--pages 5]
npm run import <campaign> <file.txt|file.csv> [--approve]
npm run export <campaign> [--status new] > leads.csv
npm run approve <campaign> <urls.txt | --all>
npm run queue <campaign> <messages.json>
npm run connect <campaign> [--max 5]
npm run followup <campaign>
npm run run <campaign> [--once]
npm run app                  the web app, http://localhost:4747
npm run dashboard            read-only view of the same data
npm run status
```

## Where things live

- `~/.sourcer/db.json` all leads, messages, actions
- `~/.sourcer/browser-profile` the logged-in browser
- `~/.sourcer/sourcer.log` what it did
- `~/.sourcer/screenshots` a screenshot every time something unexpected happened

## When LinkedIn changes its page

All page selectors live in `src/selectors.js`. If connects or messages start failing, look at the newest screenshot in `~/.sourcer/screenshots`, then fix the selector there. Claude can do this from the screenshot and the log.

## Safety rails built in

- Hard stop on any LinkedIn security check. It never tries to click through one.
- Connect and Message buttons are matched by the person's name inside their own profile card, so a "People you may know" card is never clicked.
- A message is only recorded as sent when LinkedIn confirms it, and a thread that already ends with our text is never sent to again.
- Recruiter InMail is only available after an invitation has gone unanswered for the configured delay. The first eligible InMail is rehearsed without sending and requires wording approval before automation continues.
- Once LinkedIn's weekly invitation limit is hit, no connection requests go out for 7 days.
- Daily caps per campaign, validated to sane maximums (25 connects, 40 messages).
- Working hours and days, in the timezone set on the campaign (Dubai by default).
- Random pauses between actions and between passes.
- Nothing is sent to a lead that is not approved (unless `autoApprove` is on).
- A reply from anyone freezes that thread. No automated message ever follows a human reply.
- Messages and notes containing dashes are rejected.

## Tests

`npm test` runs the unit tests. `npm run test:browser` drives the real browser flow against a fake LinkedIn page.
