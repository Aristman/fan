---
name: lavish
description: >
  Turn complex or visual agent responses into rich, reviewable HTML artifacts
  the user can annotate and send feedback on, using the lavish tool.
  Use when about to give a plan, comparison, diagram, table, code diff, report,
  or anything easier to grasp visually than as prose.
argument-hint: <what the artifact should show>
---

# Lavish Editor

## When to Use
- User asks for a visual plan, diagram, comparison, report, or explainer
- The result is easier to grasp visually than as prose
- You need human-in-the-loop feedback on a visual artifact
- You are about to create HTML content for review

## When NOT to Use
- Simple text responses that don't benefit from visual formatting
- Code-only outputs (use standard code blocks)
- Quick answers that don't need annotation

## Workflow
1. Call `lavish({ command: "playbook", playbook_id: "<matching_id>" })` for EACH relevant playbook BEFORE writing HTML
2. Write the HTML artifact file (.html), following the playbook guidance for structure, design rules, and patterns
3. Call `lavish({ command: "open", file: "<path_to_html>" })` to open in Lavish Editor browser
4. Call `lavish({ command: "poll", file: "<path_to_html>" })` to wait for user feedback
5. If the poll response contains `layout_warnings` (proven severe failures) → fix the HTML, then repeat poll
6. If the poll response contains `prompts` (user annotations/messages) → apply changes to the HTML, then call poll again with `agent_reply` describing what you changed
7. If the poll response contains `status: "ended"` → stop polling, deliver final summary in chat

## Playbook Router

MUST call `lavish({ command: "playbook", playbook_id: "<id>" })` for each matching playbook before writing HTML. One artifact often combines several playbooks.

| Playbook ID | Use When |
|------------|----------|
| **diagram** | Map relationships, flows, state machines, architecture. Mermaid diagrams become editable Excalidraw whiteboards |
| **plan** | Explain a product or technical plan before implementation. Goal → approach → risks → comparison |
| **comparison** | Show options, tradeoffs, current vs target state. Before/after, option cards, scorecards |

## Visual Guidance
- Use semantic HTML: `<table>` for data, `<details>` for collapsible sections, `<ol>`/`<ul>` for lists
- High contrast colors, sufficient whitespace (min 16px padding), clear visual hierarchy
- Interactive elements (`<input>`, `<select>`, `<button>`, checkboxes, radios) are automatically interactive in Lavish — no special attributes needed
- Local assets (images, CSS, fonts): copy next to the HTML file and reference with relative paths
- Mermaid diagrams: wrap in `<div class="mermaid">` for automatic whiteboard conversion
- Prefer inline CSS or `<style>` blocks over external stylesheets for portability

## Commands Reference

| Command | Parameters | Description |
|---------|-----------|-------------|
| `lavish({ command: "open", file: "<path>" })` | file (required), reopen?, no_gate? | Open HTML artifact in Lavish Editor browser |
| `lavish({ command: "poll", file: "<path>" })` | file (required), agent_reply? | Long-poll for user feedback. Blocks until action |
| `lavish({ command: "end", file: "<path>" })` | file (required) | End session as agent |
| `lavish({ command: "playbook" })` | playbook_id? | List playbooks or get specific playbook guidance |
| `lavish({ command: "design" })` | — | Get design guidance and CDN snippets |
| `lavish({ command: "export", file: "<path>" })` | file (required), out? | Export standalone HTML with inlined assets |
| `lavish({ command: "info" })` | — | Show open sessions and usage guidance |

## Important Rules
- ALWAYS call playbook guidance before writing HTML — this ensures correct structure and design patterns
- ALWAYS poll after open — do not return to user without collecting feedback first
- Fix layout_warnings (proven severe layout failures) BEFORE asking user to review
- Stop polling when status is "ended" — do not reopen user-ended sessions without explicit request
- Use relative paths for local assets (absolute file:// paths won't resolve through Lavish server)
- If user ended the session (ended_by: "user"), do not reopen without `reopen: true`
