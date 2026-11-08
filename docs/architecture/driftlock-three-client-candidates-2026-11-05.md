# Driftlock: three first-client conversations
Checked November 5, 2026. Potential customers based on public signals, not confirmed buyers. No outreach sent.

## Verdict
Two priority discovery candidates show recurring code-maintenance work. A third is a historical discovery reserve, not current unmet demand. No purchasing intent was verified. Start with the enterprise owner at GitLab if enterprise fit is the priority; Chris Oliver offers a potentially simpler founder-led commercial conversation. Scores prioritize research, not purchase probability.

## ICP
Primary: engineering manager responsible for multiple important vendor integrations and recurring upstream-change assessment. Adjacent: founder of commercial integration-dependent developer products. Job: map a vendor change to consumer code and tests, then review a fix. Disqualify outages without actionable code change, resolved one-off incidents without recurring work, unsupported languages/hosts, seller anecdotes and inaccessible decision-makers.

Driftlock is intended to detect vendor API drift, identify affected consumer code and prepare verified reviewable fix PRs. End-to-end proof, supported languages, traffic capture, CLI/GitHub App availability and preventive guarantees are not established by this research. Do not claim them in outreach.

## Top enterprise prospect: P2 — Thiago Figueiró, GitLab
Observed engineering manager for Import. Identity/contact: https://gitlab.com/thiagocsf

Official recurring workflow: https://handbook.gitlab.com/handbook/engineering/devops/create/import/ describes per-milestone vendor changelog/deprecation reviews, Duo-assisted impact analysis, checking implementation and filing required changes. Providers include GitHub, Bitbucket, Gitea, Jira and FogBugz. This is evidence of work performed, not a declared tool budget. Publication date unknown; page last-modification date is not the section's publication date.

His December 12, 2025 follow-up describes GitHub metadata changes causing importer errors and a critical customer escalation: https://gitlab.com/gitlab-org/gitlab/-/issues/583852 . Public metadata https://gitlab.com/api/v4/projects/278964/issues/583852 shows closure March 5, 2026. Do not pitch rescuing an open incident or claim no monitoring exists now.

Contact: professional profile lists a business contact; use it for a concise inquiry, not a promotional issue. Purchasing authority is unverified. GitLab-native delivery, Ruby support, security/procurement and value beyond Duo must be qualified.

Score 80: pain5 fit4 timing2 reach4 evidence5; weights25/25/20/15/15.

Draft, not sent:
> Thiago — your Import handbook describes milestone-by-milestone vendor reviews, Duo impact assessment and checking importer implementations. I also read the now-closed GitHub metadata follow-up; I'm not assuming that gap remains. I'm building Driftlock to connect vendor changes with affected consumer code and a tested reviewable patch. Would you take 15 minutes to assess whether a paid pilot on one importer could reduce that work? Ruby and GitLab delivery would need confirming first.

Next step: ask which upcoming change still requires manual work, how much effort it takes, and who can sponsor a paid evaluation.

## Shortlist: P1 — Chris Oliver, GoRails / Jumpstart Pro
Observed founder: https://excid3.com/ and https://jumpstartrails.com/about

October 6, 2026 firsthand migration: https://github.com/pay-rails/pay/pull/1284 updates Stripe request shapes and re-records VCR fixtures. Prior release https://github.com/pay-rails/pay/releases/tag/v11.8.0 repairs removed Invoice payment_intent usage via payments relationship. These demonstrate recurring consumer-code/test maintenance; both fixes already shipped. No cost, dissatisfaction or buying intent verified.

Business route: official Email us link at https://gorails.com/about . Do not guess an email or promote in a maintenance issue. Ruby and fixture support are delivery gates.

Score86: pain4 fit4 timing4 reach5 evidence5. Recent work is a conversation trigger, not an unresolved incident.

Draft, not sent:
> Chris — your Stripe 20 PR changed request shapes and re-recorded VCR fixtures; Pay's earlier invoice-payment lookup fix caught my attention too. I'm building Driftlock around tracing vendor contract changes into consumer code and testing a reviewable patch. It's early, not a proven automatic fix service. Would you take 15 minutes to assess whether a paid pilot on one future payment-provider migration could save you review work?

Next step: quantify the last three migrations, current automation and review effort; establish whether a founder-led paid pilot is interesting.

## Historical reserve: P3 — Josh Pollara, Stategraph
Observed co-founder via https://stategraph.com/about ; professional identity https://github.com/joshpollara . Current company framing is Stategraph, incorporating Terrateam's engine.

Firsthand December 19–22, 2025 discussion: https://github.com/orgs/community/discussions/9752 describes GitHub workflow-dispatch response changes breaking infrastructure integrations and typed contracts. Provider subsequently documented compatible opt-in behavior February 19, 2026: https://github.blog/changelog/2026-02-19-workflow-dispatch-api-now-returns-run-ids/ . Not a current incident. No fresh recurring cost or buying demand verified.

General business form: https://stategraph.com/contact . Routing to Josh and supplier-outreach suitability unconfirmed; do not book a sales demo pretending to be a buyer. OCaml support is a substantial gate.

Score67: pain4 fit3 timing2 reach3 evidence5. Outside the strict current-demand primary shortlist.

Draft, not sent:
> Josh — your GitHub dispatch-contract discussion made the infrastructure impact concrete. I saw the later opt-in fix, so I'm not treating that incident as open. I'm building Driftlock around vendor-change impact analysis and tested consumer-code patches. Are similar changes still taking meaningful engineering time? Would you take 15 minutes to determine whether a paid pilot on one integration is worth evaluating? OCaml support would need checking first.

Next step: establish present recurrence before proposing commercial scope; stop if historical or incompatible.

## Patterns
The strongest wedge is maintenance already performed, not hypothetical future breakage. Existing internal processes and coding agents are competitors: measure incremental time saved and patch quality. A proposed pilot should cover one authorized repository, one vendor change, affected-call-site reasoning, explicit regression tests and human approval. Agree price and acceptance only after confirming fit; no fabricated ROI.

## Seven-day manual plan: November 6–12
- Nov6: capability-check Ruby, GitLab delivery and OCaml. Founder may contact P1/P2 manually; no sending authorized by this report.
- Nov7: P3 only for historical discovery, clearly labeled.
- Nov8–10: ask responders about their last three changes, effort, interruption costs, existing tools, security and budget owner.
- Nov11: one substantive manual follow-up where appropriate; respect opt-outs.
- Nov12: propose a bounded paid experiment only where sponsor, pain and technical fit are confirmed. Otherwise keep discovery status.

## Pasted playbook: claims checked
Harsha Vardhan's April18,2026 post is a seller's audit anecdote about acknowledging payment-failure events without action, not proof of schema drift or named buyer demand: https://www.indiehackers.com/post/i-found-2-300-leaking-silently-from-a-founders-stripe-account-he-had-no-idea-for-11-months-d54003963d . Dollar figures were not independently corroborated; do not use the $340 average or $2300 anecdote as Driftlock outcomes.

Karan Palukuri's October6,2026 firsthand report concerns invoice.payment_intent removal, but reports his fix tested and later added guards. His own RevGuard workflow is not an identified paying Driftlock customer: https://dev.to/karan_palukuri/stripe-removed-invoicepaymentintent-in-the-basil-api-and-it-quietly-broke-my-failed-payment-2aa8 . Do not conflate the two authors or unnamed customer accounts.

Do not claim a free CLI, completed Loom, real-traffic baseline, automatic prevention or testimonials without verification.

## Limits and continuity
Three named conversations are provided, not three ready buyers. Two recurring opportunities and one historical reserve; all budgets and consent unverified. Sources inspected November5; historical dates are not current urgency. Private GitLab notes/root-cause material was unavailable and not accessed. No complete platform coverage or local history exists; prior exclusions supplied in conversation were applied. Guidance from nalindalal/skillset and first-customer-finder was consulted. Artifacts are manual, not bundled-generator validated. Manual P1–P3 IDs apply to this run only; canonical person URLs distinguish them from earlier IDs. No outreach/CRM changes. Feedback can use ID plus keep/maybe/reject and reason.
