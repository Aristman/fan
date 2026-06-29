# fan-ask-answer

Interactive dialog with the user via TUI selection UI for FAN.

## Tools

### `question`
Ask the user a single question with selectable options.

- Arrow keys (↑↓) to navigate
- Enter to select
- Esc to cancel
- "Type something..." option for free-text input

**Parameters:**
- `question` (string) — Question text
- `options` (array) — Array of `{label, description?}`

**Returns:** `{question, options, answer, wasCustom?}`

### `questionnaire`
Ask multiple questions in a tabbed interface.

- Tab / ←→ to switch between questions
- ↑↓ to navigate options
- Enter to confirm
- Esc to cancel
- Submit tab shows summary of all answers

**Parameters:**
- `questions` (array) — Array of `{id, label?, prompt, options: {value, label, description?}[], allowOther?}`

**Returns:** `{questions, answers: [{id, value, label, wasCustom, index?}], cancelled}`

## Non-interactive Mode

- `question`: Auto-answers with the first option
- `questionnaire`: Returns cancelled with empty answers

## Installation

Via FAN Store:
```
/store install fan-ask-answer
```

Or manually:
```
cp -r fan-ask-answer ~/.fan/agent/extensions/
```

## Version

1.0.0 — Adapted from pi-ask-answer v1.0.1
