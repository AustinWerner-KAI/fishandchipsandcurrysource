# Austin Werner LinkedIn Outreach Strategy

## Crypto & Digital Asset Nurture Campaign (New Business approaches ONLY)

### The Core Idea
This isn't a hard sell. These are nurture targets, not immediate placements. The whole point is to open a door and keep it open, not to pitch and hope for a reply. Every message should feel like it came from someone who actually works in the space and is genuinely curious about their business, not a recruiter running a script.

Softly, softly. If a message could be closed down with a one word reply, rewrite it.

### The Funnel

**Touch point 1: Connection Request**
Keep it short. No pitch, no ask. Just a reason to connect that feels natural.

> Hey [Name], it would be great to connect as I work in the digital asset space as well.

Don't customise this too much. It's a handshake, not a conversation.

**Touch point 2: They accept**
No message here. This is the connect landing. Move to touch point 3 once you've done your research.

**Touch point 3: First Message After Connecting**
This is the fork. Once someone accepts, the first real message does one of two jobs. Pick one, never both in the same message.

Route A: Credibility. Plant the Austin Werner flag. Best when you want them to know who you are before anything else, or when you don't yet have a candidate that fits them.

> Thanks for connecting [Name]. Not sure if you've come across Austin Werner before, but we're one of the few genuinely crypto native recruiting firms out there. We placed around 80 people on the Mantle project.

Route B: Candidate tease. Lead with a profile that would actually work FOR them. This is the stronger play when you know their seniority and function and can match a real candidate to it.

> Random one, but I've got someone on our books who might be up your street. [One line on what they do that's relevant]. Not pitching, just thought it was worth flagging given where you sit. Happy to send the profile over if useful, no pressure.

Softest option: Market pulse. Lowest risk, no flag and no candidate. Use it when you don't yet have an angle, or the person feels cold. It buys you a reply and a reason to come back.

> Hey [Name], thanks for connecting. How are you finding the market at the moment?

**Picking the candidate for the tease (Route B)**
The candidate has to fit the person you're messaging, not just the company. Two rules:

1. Match seniority and function. A founder gets a market or strategy candidate. A Head of Function gets someone who slots under them, a strong lead or number two, never a peer and never a rival. A Head of Talent or internal recruiter gets a direct, role-specific candidate. Sending a Head of Finance a Head of Finance reads like you're lining up their replacement.
2. Position as a report, not a threat. The framing should make it obvious the candidate would work for them. "Would slot straight under someone like you" beats "runs the whole finance function".

Always anonymise the candidate in the message. It's public facing. No names, no current employer, just enough shape to make them want the full profile.

**Touch point 4 onward: Nurture (ongoing, no fixed timeline)**
This is the long game. No hard CTA, just keep the thread breathing.

* Ask about market conditions, specifically things tied to their niche (L2 activity, stablecoin flows, whatever's relevant to what they build)
* Ask about their runway or hiring plans, framed as curiosity not sales ("Are you guys still in build mode or scaling the team out?")
* Softly mention a candidate profile that's relevant to them, without asking for anything ("Random one, but I've got someone on our books who's spent the last three years doing exactly this. Happy to send the profile over if useful, no pressure either way.")
* React to their posts or company news before messaging again. Warm context beats cold follow-up every time.

### Message Variations

**Connection requests**
* "Hey [Name], would be great to connect, I work in the digital asset recruitment space too."
* "Hi [Name], came across your profile, would be good to connect given we're both in the crypto/Web3 world."
* "Hey [Name], noticed we're both plugged into the digital asset space, would love to connect."

**Route A: Credibility**
* "Not sure if Austin Werner's crossed your radar, we're one of the few recruiters that only works in crypto and digital assets. We've placed close to 80 people on the Mantle project alone."
* "We focus purely on Web3 and digital assets at Austin Werner, so we tend to have a decent read on who's moving where. Happy to share market colour if useful."

**Route B: Candidate tease**
* "Random one, are you hiring for anything on the [function] side at the moment? Have someone strong we're placing right now who'd fit under you well."
* "Quick one, any gaps on your team? Got a candidate with a pretty rare skillset we're representing, happy to send the profile over."
* "Not sure if it's relevant, but I've got a really strong [role] on our books who'd slot in below you nicely. Zero pressure, just useful to know about."

**Softest: Market pulse**
* "How's the market treating you at the moment, [Name]? Feels like a lot's shifted in the last quarter."
* "Curious how things look from your side of the market right now, especially with everything going on in [specific niche]."
* "How's [specific segment, e.g. L2s / RWAs / stablecoins] looking from where you're sitting?"

**Deepening the nurture**
* "How's the hiring runway looking for you guys, still building out the team or fairly lean for now?"
* "What's the biggest bottleneck for you at the moment, talent, funding, or just market noise?"
* "Happy to send over a profile if it's ever useful, zero pressure, just thought it might be relevant given what you're building."
* "Saw your post on [topic], curious what you're seeing on the ground with that."

### Researching a Prospect Before You Message
Five minutes of research is the difference between a message that gets ignored and one that gets a reply. Before messaging anyone:

1. Check their LinkedIn "About" and recent posts. What are they actually working on right now? A generic "digital asset space" line falls flat if they've just announced a funding round or a product launch, reference it instead.
2. Look up their company. One line on their website or Twitter/X telling you what they build (L1, custody, market maker, exchange, RWA platform, etc). Never send a generic message to someone building something specific.
3. Check for recent funding, launches, or hiring signals. A funding round or new product usually means hiring is coming. That's your opening for the runway question.
4. See who they're connected to or which projects they've worked on. Mutual connections or shared project history (like Mantle) are a natural, non-salesy way to establish credibility.
5. Note their seniority and function. This decides the touch point 3 route. Founders respond better to market commentary and credibility. Function heads respond to a candidate who'd slot under them. Internal recruiters respond to direct, role-specific talent conversations.
6. Keep a short note per prospect (one line: what they build, any recent news, the route you used) so the next follow-up builds on the last one instead of repeating it.

### Tone Rules
* No dashes, no corporate language, no "I hope this finds you well"
* Short sentences, conversational, like a text to someone you vaguely know
* Never ask for something in the first message after connecting
* Every message should be easy to reply to with more than "no thanks"
* If in doubt, cut it down further

### How Sourcer applies this
* Campaign `mode: "newbusiness"`: connection note is picked at random from `connectionNotes`. No template follow-ups. When someone accepts, the lead sits at `accepted` until a per-person message is queued (research first, pick Route A / B / pulse, write it, `npm run queue`).
* Any reply stops the queue for that person. Kai or Claude writes the next message by hand.
* Every message sent is logged against the lead with a note field, so the next follow-up builds on the last one.
