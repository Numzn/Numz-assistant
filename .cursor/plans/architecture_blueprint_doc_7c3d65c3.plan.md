---
name: Architecture blueprint doc
overview: Add [docs/architecture.md](c:\Users\NUMERI\ai-assistant\docs\architecture.md) as the durable engineering specification you provided, formatted as clean Markdown, plus a short "Repository alignment" section that separates what already exists from planned phases (event bus, interfaces/, state-driven animation).
todos:
  - id: add-docs-dir
    content: Create docs/ and write architecture.md from the blueprint + alignment + mermaid + Cursor rules
    status: completed
  - id: verify-links
    content: Proofread paths and terminology against existing src/ and server/ layout
    status: completed
isProject: false
---

# Save AI Assistant engineering blueprint

## Goal

Create **[docs/architecture.md](c:\Users\NUMERI\ai-assistant\docs\architecture.md)** as the persistent **source of truth** for Cursor and humans: mission, layer responsibilities, state machine rules, target event model, controller/API/AI/tool/voice design, anti-patterns, roadmap, and Cursor usage rules.

## Content strategy

1. **Port your specification** into structured Markdown: clear `##` / `###` headings, bullet lists, and Markdown tables where you used tables (e.g. layer responsibilities, state-to-visual mapping, voice/state mapping).

2. **Preserve non-negotiables** verbatim in spirit: separation of concerns, **state as truth**, **event-driven** target architecture, reference flow (IDLE → LISTENING → …), transition rules, and the “do not break” list.

3. **Add one short section: “Repository alignment (today)”** so the doc does not mislead implementers:
   - **Implemented:** [src/engine/](c:\Users\NUMERI\ai-assistant\src\engine), [src/core/](c:\Users\NUMERI\ai-assistant\src\core), [src/animation/](c:\Users\NUMERI\ai-assistant\src\animation) (motion is **time-based from config**, not yet driven by assistant state), [src/assistant/](c:\Users\NUMERI\ai-assistant\src\assistant) (state machine + HTTP client + controller), [server/](c:\Users\NUMERI\ai-assistant\server) layout per blueprint, `POST /api/v1/assistant/chat` + mock [server/services/aiService.js](c:\Users\NUMERI\ai-assistant\server\services\aiService.js), [server/tools/tools.js](c:\Users\NUMERI\ai-assistant\server\tools\tools.js).
   - **Not implemented yet (blueprint target):** `src/interfaces/`, global **event bus** (named events like `state:change`, `ai:request`), **lifecycle hooks** (`onEnter` / `onExit`), **state-only animation mapping** (animator currently has no assistant dependency by design—good boundary, but wiring will be a future change), voice pipeline.

4. **Optional diagram:** a small **mermaid** `flowchart` for the reference user→controller→state→backend→response flow (syntax per plan tool rules: no spaces in node IDs).

5. **Cursor guidance block** at the end: explicit lines to paste (“respect module boundaries”, “extend one layer at a time”, “do not mix API logic into `engine/` or `core/`”).

## Files to add

| Path | Action |
|------|--------|
| [docs/architecture.md](c:\Users\NUMERI\ai-assistant\docs\architecture.md) | **Create** (new folder `docs/`) |

## Out of scope for this task

- No refactors of [src/animation/animator.js](c:\Users\NUMERI\ai-assistant\src\animation\animator.js), [src/assistant/](c:\Users\NUMERI\ai-assistant\src\assistant), or [server/](c:\Users\NUMERI\ai-assistant\server) beyond adding the doc (per your instruction: blueprint only in this step).
- No voice, no new UI panels, no event-bus implementation until a follow-up task.

## Follow-up (after you approve and the doc exists)

You already listed next implementation tracks; pick one when ready:

- Event bus + wire controller/state/animation via events only  
- Tool execution design (server + client contracts)  
- Voice + `src/interfaces/` with state hooks  
