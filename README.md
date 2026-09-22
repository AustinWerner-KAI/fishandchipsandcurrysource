# Sourcer

LinkedIn sourcing and outreach that runs as you, in a real browser on your Mac, with daily caps and working hours.

**Read this first.** This automates your own LinkedIn account. That is against LinkedIn's terms. If LinkedIn spots it they can restrict or close the account. Keep the caps low, keep it inside working hours, and stop the moment you see a security check.

## First run

1. Double-click `Sourcer.command`. It installs what it needs and opens a menu. If macOS says it can't open it, right-click the file, choose Open, then Open again. Once is enough.
2. Pick **1 Log in**. A browser opens. Log in to LinkedIn by hand. The window closes on its own.
3. Copy `campaigns/example.json` to `campaigns/<name>.json` and edit it. Paste in a LinkedIn people search URL.
4. Pick **2 Search** to collect people into the campaign.
5. Open the dashboard (**3**) and tick **approved** on the people you want to contact. Or send the CSV to Claude for scoring and approve from that.
6. Pick **4 Run campaign**. It works through the day inside the hours in the campaign file. Leave the window open.

## How a new business campaign flows

- Connection request goes out with a note picked at random from `connectionNotes`.
- When they accept, nothing is sent. They show up on the dashboard under **Accepted, waiting for a first message**.
- Research them, pick the route (credibility, candidate tease, or market pulse), write the message, and queue it:

```json
[
  { "url": "https://www.linkedin.com/in/someone/", "text": "Thanks for connecting Sara. How are you finding the market at the moment?", "note": "L2, raised in Aug, route: pulse" }
]
```

`npm run queue <campaign> messages.json`

- Queued messages go out on the next pass. Any reply stops everything for that person and shows on the dashboard.
- Ongoing nurture is the same: queue the next message when there is a reason to send one. `notBefore` (ISO date) holds a message until a date.
- Someone who has replied is frozen. After you have answered them by hand, add `"resume": true` to the next queued item to let it send.

## How a candidate campaign flows

Set `"mode": "candidates"` and give `followUps` with `afterDays`. Templates take `{firstName}`, `{name}`, `{company}`, `{headline}`. See `campaigns/candidates-example.json`. Queued messages still take priority over templates, so you can hand-write for anyone.

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
npm run dashboard            http://localhost:4747
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
- Never sends InMails. If LinkedIn opens the InMail composer instead of a normal thread, it backs out.
- Once LinkedIn's weekly invitation limit is hit, no connection requests go out for 7 days.
- Daily caps per campaign, validated to sane maximums (25 connects, 40 messages).
- Working hours and days, Dubai time by default.
- Random pauses between actions and between passes.
- Nothing is sent to a lead that is not approved (unless `autoApprove` is on).
- A reply from anyone freezes that thread. No automated message ever follows a human reply.
- Messages and notes containing dashes are rejected.

## Tests

`npm test` runs the unit tests. `npm run test:browser` drives the real browser flow against a fake LinkedIn page.
