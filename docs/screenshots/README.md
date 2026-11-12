# Dashboard screenshots (ticket 7, 11 Nov 2026)

All are real runs of the conductor, made in headless Chrome against `node tests/harness/fake-run-server.ts`
(the scripted model answers; no real model call). The owner name on the page says so.

- `empty-state.png`: no run yet.
- `recovering-run.png`: the presenter injected an invalid output at the script agent (demo mode); the task is stalled and waits for retry 1 of 2.
- `done-run.png`, `done-run-whole-trail.png`: the same run after the retry; one handoff is open in the trail.
- `escalated-run.png`, `narrow-layout.png`: the reviewer rejected a script and the run ended as escalated.

## Follow-up (11 Nov 2026)

Made against `node tests/harness/two-fake-tuloys.ts` (Lou and Sam, both with the scripted model; no real model call).

- `peers-screen.png`: Sam's peers screen in the dashboard's look, after Sam accepted an invite that Lou's peers screen made.
- `run-for-a-peer.png`: Sam's dashboard with the run "for Lou": Lou sent one task for the script agent over A2A.
- `typed-goal.png`: a goal that the owner typed; it has no SAMPLE label. The scripts are the scripted model's fixed answer, so they do not fit the typed goal.
- `invalid-output-plain-sentence.png`: the cause of an invalid output is "The output has no list of scripts."; the raw detail is under "Content".

## The 3D street (12 Nov 2026)

One real run of the sample goal on Lou's Tuloy, with Sam's Tuloy (the sample owner) as its peer. The two used the real model
`anthropic/claude-sonnet-5.5` through OpenRouter. The presenter injected an outage of all own models at the script agent (demo mode);
the rest is real. The run ended as done in 56 seconds. The pictures are from headless Chrome that watched the page during the run.

- `3d-1-blocked.png`: the script agent failed and the backup model has the task.
- `3d-2-reroute-to-peer.png`: Sam's script agent wrote the scripts.
- `3d-3-rejected-second-attempt.png`: Lou's reviewer rejected the scripts; the task is with Sam's script agent again, with the hints.
- `3d-4-done.png`: the reviewer passed the scripts, the scheduler made the schedule, the run ended as done.
- `3d-5-full-window.png`, `3d-6-full-window-dark.png`: the same run after the layout change: the street fills the window and the panels lie on top of it (light theme and dark theme, window 1440 by 860).
- `3d-7-three-roads.png`: three Tuloys with the scripted model (no real model): Lou, and the sample owners Mika and Sam. Injected: an outage of all own models, and a refusal by the first peer. Mika refused the script task, Sam did it.
- `3d-8-jeepney.png`: a close view of the jeepney with the conductor at the wheel. `3d-5` and `3d-6` show the look after 12 Nov 2026 16:15: the sky, the light of the hour, the surfaces and the scenery.
- `demo-video-poster.png`, `demo-1-inject.png`, `demo-2-second-attempt.png`: frames of the demo video `docs/video/tuloy-demo.mp4` (run 5 of Lou, 12 Nov 2026, real models, an injected outage of all own models).
- `3d-9-web-search-sources.png`: run 4 of Lou, with the web search of the trend scout on: the result lists 7 sources.
