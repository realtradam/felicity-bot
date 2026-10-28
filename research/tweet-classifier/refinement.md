# Refinement log

- Before inference: fixed label policy, 47/55 chronological split and 36-case synthetic challenge set.
- v1 short generic prompt: 41/47 correct including one network failure; reset recall 0/3; feature recall 4/5; billing correction false-positive.
- v2 general rules: provided monitored-author product context, accepted terse quota announcements and grounded follow-ups, accepted endorsed quoted releases, excluded billing restitution and existing-plan reminders. No examples added.
- v2 development: 46/47, macro-F1 0.9654. Remaining error: undated regional rollout roadmap counted as feature rather than neither. Label not changed.
- v2 meets predefined development target; selected and hash-frozen before holdout or synthetic challenge inference. No further phase-1 revision.

## Phase 2, after the phase-1 failure

- v2 chronological holdout: 45/55 correct, reset recall 1/11; not production-ready despite strong development accuracy.
- v2 synthetic challenge: 36/36. This does not supersede poor real-tweet results.
- The consumed holdout explicitly becomes phase-2 development. Additional earlier tweets were collected independently from the main timeline, and every third new chronological item selected for 52-case retrospective validation, labels fixed before v3 calls.
- v3 is a shorter generic choice question emphasizing the meaning of reset and priority within its option description, rather than lengthy conservative exclusions. No actual tweet examples or answer lists added.
- v3 frozen before all phase-2 calls. No v4; report new validation as retrospective, not future chronological evidence.
