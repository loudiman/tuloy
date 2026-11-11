# Dashboard screenshots (ticket 7, 11 Nov 2026)

All were made in headless Chrome against `node tests/harness/fake-run-server.ts` (the scripted model; no real model call).

- `done-run.png`, `done-run-whole-trail.png`, `escalated-run.png`, `empty-state.png`, `narrow-layout.png`: real runs of the conductor with the scripted model.
- `recovering-preview-hand-written-data.png`: NOT a run. The API answers were written by hand to check the fields of the shared contracts
  (`shownStatus`, `stuckReason`, `forPeer`, injections, event actions that the page does not know). Replace it with a real recovering run after ticket 3.
