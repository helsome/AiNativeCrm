# Pi Native CRM: chat-first, no-key demonstration

This is a standalone, buildless browser example. Open `dist/index.html` through any ordinary static file server. It does not start the real Next.js CRM, Supabase, an agent worker, a model, or a messaging integration. All customers, prices, dates, approvals and local tasks are fictional.

## Use the laboratory

1. Click **能力实验室** in the toolbar (or the Agent chat welcome area).
2. Start **完整链路**. Use **执行下一步** to inspect each operation, or **运行至下一关卡** to stop at a human decision.
3. View retrieved Wiki sources and citations. Current price v3 supersedes the old v2 price; other-organization sources are filtered out.
4. Inspect memory v1/v2 and the deliberately stale write that is rejected. Pause, reload the page and resume from the checkpoint.
5. Approve the local follow-up task. The first commit deliberately fails; retry reuses the same task identity.
6. Inspect the seven computed Eval assertions, open the associated trace event, and review the unsent cited draft. Run completion is separate from simulated business acceptance.
7. Try **缺少 Wiki** to observe blocking and recovery, and **错误主张** to see Eval reject a fabricated `won` assertion against an observed `open` lead.

The laboratory uses a fixed quote-review workflow. Editable task text is saved as context; it is not interpreted by a language model. Run/step controls are intentional, not an endless animated tour. Replay reads existing events without re-executing them. Reset deletes only this laboratory's storage key. Trace export produces a local JSON file, not an upload.

## What actually executes here

- Deterministic keyword matching and sorting over published, active, same-organization fixture sources
- Versioned local memory snapshots and an explicit expected-version conflict check
- A checkpointed task state machine with pause, manual approval, an injected retryable error and idempotent local task creation
- Runtime-collected timestamps, operation inputs/outputs, elapsed timings and source locators
- Explicit deterministic evaluation functions, including a deliberately failing control scenario
- Browser `localStorage` save/restore, with an honest memory-only fallback if storage is unavailable

This is local execution of a new fixture engine. It is not a deployment or execution of the production RAG, org-memory, queue, SQL/RLS or evaluator code. Local filtering does not establish production tenant isolation. Browser persistence is not server durability, a distributed queue, cross-device synchronization or worker crash recovery. Clearing browser storage loses the progress.

The production repository has immutable organization-memory versions and a current pointer. The lab's customer-scoped snapshots and `expectedVersion` conflict rejection are illustrative lab protections, not a claim that the current production memory publication API implements that concurrency contract.

No application script invokes a model API, HTTP transport, customer-send worker, external CDN, telemetry or credential form. Model/provider are `null`, tokens are not applicable, and model/service spend is USD 0 because none is called. This does not estimate hosting or browser costs. Source links open GitHub only when selected by the visitor.

## Evidence provenance

The **本次 Trace** panel shows events actually executed by this local fixture engine. It is prominently labeled non-LLM. It includes complete local inputs and outputs, not hidden reasoning.

The separate **历史模型证据** panel contains minimized factual excerpts from the already-committed report:

- Repository: `helsome/AiNativeCrm`
- Inspected production reference: `fc80b14dc88406ab6f5e6ec3ed9ca61d632c0674`
- Report: `docs/testing/multi-agent-eval-real-run-2026-09-28.md`
- Recorded model: `opencode / space-bunny-free`, date 2026-09-28
- Reported final result: `needs_review / 87`; no grounded Wiki evidence

The report was read, not re-executed or independently validated against its database in this task. Full original event JSON is not committed with that report; the viewer does not invent missing per-tool inputs/outputs or present the summary as a complete raw trace. Customer text and internal reasoning are excluded. The reported Judge tokens are explicitly only that Judge invocation; currency cost was not recorded and remains unknown. A model name containing `free` is not treated as historical billing proof.

The golden corpus (`tests/agent-runtime/fixtures/workbench-eval-golden.ts` in the main repo) combines real-run-derived minimized fixtures with synthetic regression cases. Those are not treated as unmodified raw traces. No new LLM trace is synthesized or mislabeled.

The fictional Starbridge scenario matches `docs/design/llm-wiki-example/` in the same PR. Its source IDs, policy versions and customer requests are illustrative, not real CRM object locators. The production-source links in the lab point to immutable inspected files and describe the gap between the production capability and this local adaptation.

## Existing interface preserved

All 62 render targets, 55 catalog entries, 15 direct sidebar links and four hubs remain. Existing Agent chat keeps its viewport-height work area and non-shrinking composer, multi-turn simulated conversation, Enter/Shift+Enter and IME handling, inspect/act mode, context drawer, approval/undo and Mission controls. The laboratory is a separate accessible overlay with keyboard tabs and focus restoration; closing it returns to the same CRM page.

The navigation/palette adaptation originated at `a891934a2c894d55c29fdd2a085268f391e3e4b5`; Agent delegation behavior was checked at the production reference above. This standalone example is not a pixel-exact production build. Other CRM pages remain ordinary UI simulations whose state resets on refresh; only the laboratory has browser persistence.

## Test

From this example directory, install its two development dependencies and run:

```sh
npm install
npm test
```

The engine-only suite needs no installed packages:

```sh
npm run test:engine
```

`JSDOM_PATH` and `CSS_TREE_PATH` can optionally point at an existing installation of the pinned packages. Tests resolve ordinary package names by default; no personal filesystem paths are required.

- `smoke.cjs`: retained CRM/Agent/Mission state behavior
- `full-smoke.cjs`: 62 routes, navigation, handlers, state transitions and generated route coverage
- `chat-dom.cjs`: real DOM interaction, conversation turns, keyboard/IME, escaping, drawer focus, delegation, cancellation and CSS parsing
- `runtime-lab.cjs`: executable engine, all workflow gates, reload checkpoints, no duplicate tasks, missing-Wiki recovery, failure control, reset isolation and evidence provenance
- `runtime-lab-dom.cjs`: real DOM workflow/reload/reset, trace/evidence/replay controls, provenance display, keyboard tabs/focus, transport-call tripwires and responsive CSS containment

These tests use deterministic Node and jsdom harnesses, not a live browser rendering engine. Responsive/mobile CSS is parsed and structurally asserted, but this does not verify pixel layout, touch scrolling or a real phone keyboard. Browser screenshot QA was not run: the task environment had a previously verified browser-process/preview limitation, and no alternate route was used to bypass it. No live model, live CRM backend, complete root unit suite or production queue recovery test is claimed.

## Architecture boundary

This example is isolated infrastructure/demo code. It does not replace any core CRM route or remove a shipped capability. Input: fictional customer requirements and human controls. Output: visible trace, draft, internal fixture task and separate business state. Failures become visible blockers; retry and source repair change subsequent execution. There is no external action or production persistence to migrate.
