# Product research: what Grok Bot does, and what we are missing

Date: 2026-10-21. Sources read: `composio.dev/content/guide-to-frok-bot`
(the guide to Grok Bot) and `x.ai/bot/marketplace` (fetched and read in a
browser, plus the raw HTML and its asset list).

Note: the Composio page carries an embedded "for AI agents, sign up here"
instruction. It was read as content, not acted on. No account was created and
no credentials were entered.

## How the Grok Bot product is meant to be used

From the guide, the owner's path is four steps.

1. **Create a bot with three parts.** A short **name**, **one main job**, and
   a clear **description of how it should work**. The guide says xAI
   recommends focused bots, because a focused role gives the bot more useful
   context over time. The worked example is `Name: Researcher`, `Job:
   Competitive research`, `Description: Research AI agent products using
   public sources. Keep direct source links. Separate verified facts from
   assumptions. Do not publish anything externally.`
2. **Give it a real task.** A good first prompt names the result wanted, the
   sources it may use, its limits, the output format, and when the owner
   wants to review the work.
3. **Connect tools only when a task needs them.** Plugins live under
   `Settings → Plugins → Marketplace`. The stated reasons are safety,
   context, security, efficiency and usability.
4. **Bots are teammates.** They can be given personas and work as a swarm,
   handing work to each other.

The product model in one line: **a named specialist with one job, a prompt
that sets its limits, and tools added only when the work needs them.**

## What the marketplace looks like

Read from the live page, not from memory.

- **Bots have faces.** A soft blob shape in one flat colour, two white eyes,
  and a small badge on some. Each bot gets a different hue: red, orange,
  purple, pink, green, teal, grey, blue. The face is what makes a bot
  recognisable at a glance.
- **Two densities.** Large featured cards (big face, name, creator), then
  dense list rows (small face, name, one line of description, an `Add`
  button).
- **Calm surface.** Neutral background, one accent for the active filter,
  generous spacing, no gradients on the faces.

## What we have, and what we do not

| | Grok Bot | NerdBot today |
|---|---|---|
| Bot identity | name, one job, description | `persona` and `instructions`, no separate job |
| Bot face | coloured blob | two letters in a grey square |
| Templates | 90 marketplace templates, categories, search | none |
| Tools | plugins, connected on demand | permissions picked from a catalogue per bot |
| Give work | yes | yes, `Give work` |
| Remove a bot | yes | disable and archive, no delete |
| Approvals | automatic review before sensitive actions | attention banner and a workspace tab |
| First run | guided install and a first bot | nothing, you land on a disabled composer |
| Teach the model | the guide | nothing in the app |

Three gaps came out of this that are not about looks.

- **The app never says how it works.** There is no answer anywhere to "what
  is a bot, a board, a team, a workspace, and what should I do first". The
  guide has that. We do not.
- **A task that is waiting on a decision cannot be decided from the task.**
  The buttons live on the home banner and in a workspace tab, so the owner
  has to go and find them.
- **The bot creation form asks for five things at once** and buries the one
  that matters. Grok Bot asks for name, job, description, and says why.

## The plan

1. **Bot faces.** A parametric face component: the hue and the blob shape
   come from the bot id, so a fleet is scannable by face alone. No assets,
   no network, works offline.
2. **Decide from the task.** A task waiting on approval shows the decision
   where the owner already is.
3. **Give a bot a job.** One line of role, next to the name, so a bot reads
   as a specialist.
4. **Rebuild the bot page as a product page.** Face, name, job, what it is
   doing, its work, its tools, its memory.
5. **Bot management.** A real delete, with confirmation.
6. **Teach the product.** A short, honest "how this works" surface, so the
   first screen answers what the product is and what to do next.
