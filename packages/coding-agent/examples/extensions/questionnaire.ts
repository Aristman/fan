/**
 * Questionnaire Tool - Unified tool for asking single or multiple questions
 *
 * Supports both TUI mode (via ctx.ui.custom) and RPC mode (via ctx.ui.select/input/confirm).
 * In RPC mode, the tool falls back to sequential select/input/confirm calls.
 */

import type { Component, ExtensionAPI, KeybindingsManager, Theme, TUI } from "@itone/fan-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@itone/fan-tui";
import { Type } from "@sinclair/typebox";

// Types
interface QuestionOption {
	value: string;
	label: string;
	description?: string;
}

type RenderOption = QuestionOption & { isOther?: boolean };

interface Question {
	id: string;
	label: string;
	prompt: string;
	options: QuestionOption[];
	allowOther: boolean;
}

interface Answer {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface QuestionnaireResult {
	questions: Question[];
	answers: Answer[];
	cancelled: boolean;
}

// Schema
const QuestionOptionSchema = Type.Object({
	value: Type.String({ description: "The value returned when selected" }),
	label: Type.String({ description: "Display label for the option" }),
	description: Type.Optional(Type.String({ description: "Optional description shown below label" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Unique identifier for this question" }),
	label: Type.Optional(
		Type.String({
			description: "Short contextual label for tab bar, e.g. 'Scope', 'Priority' (defaults to Q1, Q2)",
		}),
	),
	prompt: Type.String({ description: "The full question text to display" }),
	options: Type.Array(QuestionOptionSchema, { description: "Available options to choose from" }),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow 'Type something' option (default: true)" })),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Questions to ask the user" }),
});

function errorResult(
	message: string,
	questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: QuestionnaireResult } {
	return {
		content: [{ type: "text", text: message }],
		details: { questions, answers: [], cancelled: true },
	};
}

// ========================================================================
// RPC mode implementation: uses ctx.ui.select / ctx.ui.input / ctx.ui.editor
// ========================================================================

async function handleRpcMode(
	ctx: { ui: { select: Function; input: Function; confirm: Function; editor: Function } },
	questions: Question[],
): Promise<QuestionnaireResult> {
	const answers: Answer[] = [];
	const isMulti = questions.length > 1;

	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];
		const label = q.label || `Q${i + 1}`;

		// Build option labels for select
		const optionLabels = q.options.map((o) => o.label);
		const hasOptions = q.options.length > 0;

		let selectedValue: string | undefined;
		let selectedLabel: string | undefined;
		let wasCustom = false;
		let selectedIndex: number | undefined;
		let cancelled = false;

		if (hasOptions) {
			// Build the list: options + optional "Type something..."
			const selectOptions = [...optionLabels];
			if (q.allowOther) {
				selectOptions.push("Type something...");
			}

			// Use select for option choice
			const choice = await ctx.ui.select(
				isMulti ? `${q.prompt} (${i + 1}/${questions.length})` : q.prompt,
				selectOptions,
			);

			if (choice === undefined) {
				// Cancelled
				cancelled = true;
				break;
			}

			const chosenIndex = selectOptions.indexOf(choice);

			if (q.allowOther && chosenIndex === optionLabels.length) {
				// User chose "Type something..." — prompt for custom input
				const customValue = await ctx.ui.input(q.prompt);
				if (customValue === undefined) {
					cancelled = true;
					break;
				}
				const trimmed = customValue.trim() || "(no response)";
				selectedValue = trimmed;
				selectedLabel = trimmed;
				wasCustom = true;
			} else if (chosenIndex >= 0 && chosenIndex < q.options.length) {
				const opt = q.options[chosenIndex];
				selectedValue = opt.value;
				selectedLabel = opt.label;
				wasCustom = false;
				selectedIndex = chosenIndex + 1;
			} else {
				// Should not happen — treat as custom input fallback
				selectedValue = choice;
				selectedLabel = choice;
				wasCustom = true;
			}
		} else {
			// No options — use input/editor
			const customValue = await ctx.ui.input(q.prompt);
			if (customValue === undefined) {
				cancelled = true;
				break;
			}
			const trimmed = customValue.trim() || "(no response)";
			selectedValue = trimmed;
			selectedLabel = trimmed;
			wasCustom = true;
		}

		if (cancelled) {
			return { questions, answers: [], cancelled: true };
		}

		answers.push({
			id: q.id,
			value: selectedValue!,
			label: selectedLabel!,
			wasCustom,
			index: selectedIndex,
		});
	}

	// For single question, auto-submit. For multi, confirm first.
	if (isMulti) {
		const confirmed = await ctx.ui.confirm("Submit answers?", "Ready to submit?");
		if (!confirmed) {
			return { questions, answers: [], cancelled: true };
		}
	}

	return { questions, answers, cancelled: false };
}

// ========================================================================
// TUI mode implementation: uses ctx.ui.custom (existing behavior)
// ========================================================================

async function handleTuiMode(
	ctx: { ui: { custom: Function } },
	questions: Question[],
): Promise<QuestionnaireResult> {
	const isMulti = questions.length > 1;
	const totalTabs = questions.length + 1; // questions + Submit

	const result = await (ctx.ui.custom as any)<QuestionnaireResult>((tui, theme, _kb, done) => {
		// State
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = false;
		let inputQuestionId: string | null = null;
		let cachedLines: string[] | undefined;
		const answers = new Map<string, Answer>();

		// Editor for "Type something" option
		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		// Helpers
		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function submit(cancelled: boolean) {
			done({ questions, answers: Array.from(answers.values()), cancelled });
		}

		function currentQuestion(): Question | undefined {
			return questions[currentTab];
		}

		function currentOptions(): RenderOption[] {
			const q = currentQuestion();
			if (!q) return [];
			const opts: RenderOption[] = [...q.options];
			if (q.allowOther) {
				opts.push({ value: "__other__", label: "Type something.", isOther: true });
			}
			return opts;
		}

		function allAnswered(): boolean {
			return questions.every((q) => answers.has(q.id));
		}

		function advanceAfterAnswer() {
			if (!isMulti) {
				submit(false);
				return;
			}
			if (currentTab < questions.length - 1) {
				currentTab++;
			} else {
				currentTab = questions.length; // Submit tab
			}
			optionIndex = 0;
			refresh();
		}

		function saveAnswer(questionId: string, value: string, label: string, wasCustom: boolean, index?: number) {
			answers.set(questionId, { id: questionId, value, label, wasCustom, index });
		}

		// Editor submit callback
		editor.onSubmit = (value) => {
			if (!inputQuestionId) return;
			const trimmed = value.trim() || "(no response)";
			saveAnswer(inputQuestionId, trimmed, trimmed, true);
			inputMode = false;
			inputQuestionId = null;
			editor.setText("");
			advanceAfterAnswer();
		};

		function handleInput(data: string) {
			// Input mode: route to editor
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			const q = currentQuestion();
			const opts = currentOptions();

			// Tab navigation (multi-question only)
			if (isMulti) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					currentTab = (currentTab + 1) % totalTabs;
					optionIndex = 0;
					refresh();
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					currentTab = (currentTab - 1 + totalTabs) % totalTabs;
					optionIndex = 0;
					refresh();
					return;
				}
			}

			// Submit tab
			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) {
					submit(false);
				} else if (matchesKey(data, Key.escape)) {
					submit(true);
				}
				return;
			}

			// Option navigation
			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(opts.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			// Select option
			if (matchesKey(data, Key.enter) && q) {
				const opt = opts[optionIndex];
				if (opt.isOther) {
					inputMode = true;
					inputQuestionId = q.id;
					editor.setText("");
					refresh();
					return;
				}
				saveAnswer(q.id, opt.value, opt.label, false, optionIndex + 1);
				advanceAfterAnswer();
				return;
			}

			// Cancel
			if (matchesKey(data, Key.escape)) {
				submit(true);
			}
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;

			const lines: string[] = [];
			const q = currentQuestion();
			const opts = currentOptions();

			// Helper to add truncated line
			const add = (s: string) => lines.push(truncateToWidth(s, width));

			add(theme.fg("accent", "─".repeat(width)));

			// Tab bar (multi-question only)
			if (isMulti) {
				const tabs: string[] = ["← "];
				for (let i = 0; i < questions.length; i++) {
					const isActive = i === currentTab;
					const isAnswered = answers.has(questions[i].id);
					const lbl = questions[i].label;
					const box = isAnswered ? "■" : "□";
					const color = isAnswered ? "success" : "muted";
					const text = ` ${box} ${lbl} `;
					const styled = isActive ? theme.bg("selectedBg", theme.fg("text", text)) : theme.fg(color, text);
					tabs.push(`${styled} `);
				}
				const canSubmit = allAnswered();
				const isSubmitTab = currentTab === questions.length;
				const submitText = " ✓ Submit ";
				const submitStyled = isSubmitTab
					? theme.bg("selectedBg", theme.fg("text", submitText))
					: theme.fg(canSubmit ? "success" : "dim", submitText);
				tabs.push(`${submitStyled} →`);
				add(` ${tabs.join("")}`);
				lines.push("");
			}

			// Helper to render options list
			function renderOptions() {
				for (let i = 0; i < opts.length; i++) {
					const opt = opts[i];
					const selected = i === optionIndex;
					const isOther = opt.isOther === true;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const color = selected ? "accent" : "text";
					// Mark "Type something" differently when in input mode
					if (isOther && inputMode) {
						add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
					} else {
						add(prefix + theme.fg(color, `${i + 1}. ${opt.label}`));
					}
					if (opt.description) {
						add(`     ${theme.fg("muted", opt.description)}`);
					}
				}
			}

			// Content
			if (inputMode && q) {
				add(theme.fg("text", ` ${q.prompt}`));
				lines.push("");
				// Show options for reference
				renderOptions();
				lines.push("");
				add(theme.fg("muted", " Your answer:"));
				for (const line of editor.render(width - 2)) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter to submit • Esc to cancel"));
			} else if (currentTab === questions.length) {
				add(theme.fg("accent", theme.bold(" Ready to submit")));
				lines.push("");
				for (const question of questions) {
					const answer = answers.get(question.id);
					if (answer) {
						const prefix = answer.wasCustom ? "(wrote) " : "";
						add(`${theme.fg("muted", ` ${question.label}: `)}${theme.fg("text", prefix + answer.label)}`);
					}
				}
				lines.push("");
				if (allAnswered()) {
					add(theme.fg("success", " Press Enter to submit"));
				} else {
					const missing = questions
						.filter((q) => !answers.has(q.id))
						.map((q) => q.label)
						.join(", ");
					add(theme.fg("warning", ` Unanswered: ${missing}`));
				}
			} else if (q) {
				add(theme.fg("text", ` ${q.prompt}`));
				lines.push("");
				renderOptions();
			}

			lines.push("");
			if (!inputMode) {
				const help = isMulti
					? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel"
					: " ↑↓ navigate • Enter select • Esc cancel";
				add(theme.fg("dim", help));
			}
			add(theme.fg("accent", "─".repeat(width)));

			cachedLines = lines;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
		};
	});

	return result;
}

// ========================================================================
// Main export
// ========================================================================

export default function questionnaire(pi: ExtensionAPI) {
	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Ask the user one or more questions. Use for clarifying requirements, getting preferences, or confirming decisions. For single questions, shows a simple option list. For multiple questions, shows a tab-based interface. Works in both TUI and RPC modes.",
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return errorResult("Error: UI not available (running in non-interactive mode)");
			}
			if (params.questions.length === 0) {
				return errorResult("Error: No questions provided");
			}

			// Normalize questions with defaults
			const questions: Question[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
			}));

			// Detect if custom UI is available (TUI mode) or not (RPC mode)
			// In RPC mode, ctx.ui.custom always returns undefined immediately.
			// In TUI mode, factory is called synchronously and done() triggers immediate cleanup.
			// We probe with a factory that calls done(true) synchronously — in TUI mode
			// this resolves to true without flashing UI (the component is discarded before rendering).
			let useCustom = false;
			try {
				const probeResult = await ctx.ui.custom(
					(_tui: TUI, _theme: Theme, _kb: KeybindingsManager, done: (result: boolean) => void) => {
						done(true);
						return {} as Component;
					},
				);
				useCustom = probeResult === true;
			} catch {
				useCustom = false;
			}

			let result: QuestionnaireResult;
			if (useCustom) {
				result = await handleTuiMode(ctx as any, questions);
			} else {
				result = await handleRpcMode(ctx as any, questions);
			}

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the questionnaire" }],
					details: result,
				};
			}

			const answerLines = result.answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.wasCustom) {
					return `${qLabel}: user wrote: ${a.label}`;
				}
				return `${qLabel}: user selected: ${a.index}. ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as Question[]) || [];
			const count = qs.length;
			const labels = qs.map((q) => q.label || q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("questionnaire "));
			text += theme.fg("muted", `${count} question${count !== 1 ? "s" : ""}`);
			if (labels) {
				text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "Cancelled"), 0, 0);
			}
			const lines = details.answers.map((a) => {
				if (a.wasCustom) {
					return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${theme.fg("muted", "(wrote) ")}${a.label}`;
				}
				const display = a.index ? `${a.index}. ${a.label}` : a.label;
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", a.id)}: ${display}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
