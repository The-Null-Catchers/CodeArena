# CodeArena portfolio roadmap

Baseline reviewed on November 17, 2026. Repository roadmap published on November 18, 2026.

This roadmap applies to this repository and follows the shared Null Catchers portfolio plan. Verify the documented state against the current code and runs before starting work.

**Estimated initial demo effort** 35–55 hours for a developer familiar with the project. The estimate excludes external reviews, store accounts, target environment setup, and later milestones.

## Project priorities

**Documented state** Docker execution covers eight languages, scheduling, quotas, bounded output, judging, and collaboration rooms. Learner submission and server-side reconciliation after partial failure remain incomplete.

**P0 — Demo** Complete the learner flow from attempt reservation through judging and grade display. Reconcile a completed execution if linking fails and retain the original attempt on retry. Validate the demo host before accepting external code.

**P1 — Validation and depth** Demonstrate Accepted, Wrong Answer, Time Limit, protected hidden test inputs, worker recovery, and browser reconnect in a collaboration room. Specify measurement conditions when reporting resource or queue results.

**P2 — Later** Evaluate stronger isolation such as gVisor against host compatibility. Treat SQL judging as a separate feature and describe collaboration according to its actual guarantees.

**Acceptance criteria** Grades match the linked execution, retries preserve the same attempt, hidden tests stay private, and worker interruption follows documented recovery behavior.

**Demo scenario** Publish a challenge → submit as a learner → see a timeout → submit a correct answer → review the gradebook. [ROADMAP](https://github.com/The-Null-Catchers/CodeArena/blob/main/docs/ROADMAP.md), [Verification](https://github.com/The-Null-Catchers/CodeArena/blob/main/docs/VERIFICATION.md).

## Next milestones

The [product roadmap](docs/ROADMAP.md) documents attempt reservation, grades, and browser-side retry. Server-side reconciliation still needs an end-to-end check.

1. [ ] Use a project-owned challenge and test submission. Confirm matching attempt IDs and scores for the learner and instructor.
2. [ ] Simulate a link-save failure after the worker finishes. Retry the same request and verify that the original attempt gets one grade.
3. [ ] Capture Accepted, Wrong Answer, and Time Limit with a SHA and worker log. Check that learner output keeps hidden grading inputs private.

## Portfolio acceptance checklist

- [ ] Another person can reproduce the primary workflow from a clean checkout using the README and test credentials or fixtures.
- [ ] The demo tells one complete story with a defined user, problem, and saved result.
- [ ] Tests cover the main flow, an important failure, and access boundaries when multiple accounts are involved.
- [ ] Demo data is labeled synthetic and reproducible. Review screenshots and recordings for secrets and customer data.
- [ ] Include four to six real screenshots where appropriate, a 60–120 second recording, and working links. Identify the revision used for capture.
- [ ] The README describes implemented capabilities, setup, architecture, limits, tests, and the demo.
- [ ] A short case study explains two engineering decisions, a considered alternative, and how the system handles an actual failure.
- [ ] Release evidence records the commit SHA, CI, prerequisites, and limits. Performance data includes workload, hardware, and method.
- [ ] Licensing and contributor attribution are settled before distribution. Choose the license for each repository individually.

A hosted demo is optional. Code execution, server administration, and secret management can be demonstrated through a recording and a reproducible isolated environment. Keep public demo access scoped to the activities it needs.

## Implementation and follow-up

- Break P0 into tasks with expected behavior, acceptance criteria, and a suitable test.
- Verify existing functionality first. Update this plan when evidence tied to a commit or PR closes a milestone.
- Record the fixture source, the revision used for evidence, and the tested limits.
- Review the final diff and verify required checks for its exact SHA before merging. Follow branch protection.
- For documentation-only changes with no applicable workflow, verify content and links and record the checks actually performed.
- Tie performance, security, and readiness claims to supporting evidence.
