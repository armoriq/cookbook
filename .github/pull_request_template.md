<!--
Read CONTRIBUTING.md first. A recipe PR that has no demo video or no
scenario table is marked "needs demo" and is not reviewed until both are added.
-->

## What this PR does

<!-- The recipe or the change, in two or three sentences. -->

Recipe ID: `recipes/<framework>/<language>/<slug>`

## Demo video

<!--
A live run against the real ArmorIQ platform, on a commit from this PR.
Drag the .mp4 or .mov in here, or link an unlisted YouTube video or a public Loom.
See CONTRIBUTING.md#demo-video for what to record. Write "not needed" only
for README only, typo, taxonomy, or schema fixture changes.
-->

Video:
Recorded on commit:
ArmorIQ SDK version:

## Scenarios

<!-- One row per scenario in the video. Cover every outcome in `demonstrates`. -->

| Scenario | What you typed or ran | Expected outcome | Timestamp |
|---|---|---|---|
|  |  |  |  |

## Notes for the reviewer

<!-- Known limits, a split README, a new taxonomy value, anything you could not record live. -->

## Checklist

- [ ] `npm run index`, `npm run check`, and `npm run check:recipes <id>` pass locally
- [ ] The video shows every scenario in the table, live, with the matching decisions in the ArmorIQ dashboard
- [ ] The video ends with the offline run (`npm run demo:offline` or `python offline/demo.py`)
- [ ] No keys, tokens, or private data are visible in the video, and the keys used for it are revoked
- [ ] Re-recorded if review changed the agent code, the prompts, or the policy
