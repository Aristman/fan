/**
 * Ask-Answer Extension for FAN
 *
 * Интерактивный диалог с пользователем через custom tools.
 * LLM вызывает tool question/questionnaire → TUI рендерит UI
 * с навигацией стрелками, Enter для выбора, Esc для отмены.
 * Поддерживает свободный ввод ("Type something...").
 *
 * Tools:
 *   - question: один вопрос с вариантами ответов
 *   - questionnaire: серия вопросов с таб-навигацией
 *
 * Supports both TUI mode (via ctx.ui.custom) and RPC mode
 * (via ctx.ui.select/input/confirm). Auto-detects the mode.
 *
 * Adapted from pi-ask-answer v1.0.1
 */

import type { Component, ExtensionAPI, KeybindingsManager, Theme, TUI } from "@itone/fan-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth } from "@itone/fan-tui";
import { Type } from "@sinclair/typebox";

// ─── Shared Types ────────────────────────────────────────────

interface OptionDef {
	label: string;
	description?: string;
}

type DisplayOption = OptionDef & { isOther?: boolean };

interface QuestionDef {
	id: string;
	label?: string;
	prompt: string;
	options: Array<{ value: string; label: string; description?: string }>;
	allowOther?: boolean;
}

interface AnswerRecord {
	id: string;
	value: string;
	label: string;
	wasCustom: boolean;
	index?: number;
}

interface QuestionDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
}

interface QuestionnaireDetails {
	questions: QuestionDef[];
	answers: AnswerRecord[];
	cancelled: boolean;
	error?: string;
}

// ─── Schemas ─────────────────────────────────────────────────

const OptionSchema = Type.Object({
	label: Type.String({ description: "Отображаемый текст варианта" }),
	description: Type.Optional(Type.String({ description: "Описание варианта (необязательно)" })),
});

const QuestionParams = Type.Object({
	question: Type.String({ description: "Вопрос пользователю" }),
	options: Type.Array(OptionSchema, {
		description: "Варианты ответа (минимум 1)",
		minItems: 1,
	}),
});

const QOptionSchema = Type.Object({
	value: Type.String({ description: "Значение, возвращаемое при выборе" }),
	label: Type.String({ description: "Отображаемый текст" }),
	description: Type.Optional(Type.String({ description: "Описание (необязательно)" })),
});

const QuestionSchema = Type.Object({
	id: Type.String({ description: "Уникальный ID вопроса" }),
	label: Type.Optional(
		Type.String({ description: "Короткий ярлык для таба (например 'Scope', 'Priority'). По умолчанию: Q1, Q2..." }),
	),
	prompt: Type.String({ description: "Полный текст вопроса" }),
	options: Type.Array(QOptionSchema, { description: "Варианты ответа", minItems: 1 }),
	allowOther: Type.Optional(Type.Boolean({ description: "Показывать 'Ввести свой вариант' (по умолчанию: true)" })),
});

const QuestionnaireParams = Type.Object({
	questions: Type.Array(QuestionSchema, { description: "Список вопросов", minItems: 1 }),
	mode: Type.Optional(Type.Union([
		Type.Literal("sequential"),
		Type.Literal("all-at-once"),
	], {
		description: "Режим опроса: sequential — по одному вопросу; all-at-once — все вопросы сразу (JSON-редактор в RPC, табы в TUI)",
	})),
});

// ─── Helpers ─────────────────────────────────────────────────

function makeEditorTheme(theme: { fg: (color: string, s: string) => string }): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

/**
 * Detect if custom UI is available (TUI mode) or not (RPC mode).
 * In RPC mode, ctx.ui.custom always returns undefined immediately.
 * In TUI mode, factory is called synchronously and done() triggers cleanup.
 * We probe with a factory that calls done(true) synchronously — in TUI mode
 * this resolves to true without flashing UI (component is discarded before rendering).
 */
async function detectTuiMode(ctx: { ui: { custom: Function } }): Promise<boolean> {
	try {
		const probeResult = await ctx.ui.custom(
			(_tui: TUI, _theme: Theme, _kb: KeybindingsManager, done: (result: boolean) => void) => {
				done(true);
				return {} as Component;
			},
		);
		return probeResult === true;
	} catch {
		return false;
	}
}

// ========================================================================
// RPC mode: uses ctx.ui.select / ctx.ui.input / ctx.ui.confirm
// ========================================================================

interface RpcContext {
	ui: {
		select: (title: string, options: string[]) => Promise<string | undefined>;
		input: (title: string, placeholder?: string) => Promise<string | undefined>;
		confirm: (title: string, message?: string) => Promise<boolean>;
		editor?: (title: string, prefill?: string) => Promise<string | undefined>;
	};
}

/** Handle question tool in RPC mode */
async function handleQuestionRpc(
	ctx: RpcContext,
	question: string,
	options: OptionDef[],
): Promise<{
	answer: string | null;
	wasCustom: boolean;
	index?: number;
}> {
	const optionLabels = options.map((o) => o.label);
	// Always add "Type something..." for question tool
	const selectOptions = [...optionLabels, "Type something..."];

	const choice = await ctx.ui.select(question, selectOptions);
	if (choice === undefined) {
		// Cancelled
		return { answer: null, wasCustom: false };
	}

	const chosenIndex = selectOptions.indexOf(choice);
	if (chosenIndex === optionLabels.length) {
		// User chose "Type something..." — prompt for custom input
		const customValue = await ctx.ui.input(question);
		if (customValue === undefined) {
			return { answer: null, wasCustom: false };
		}
		const trimmed = customValue.trim() || "(no response)";
		return { answer: trimmed, wasCustom: true };
	}

	if (chosenIndex >= 0 && chosenIndex < options.length) {
		return {
			answer: options[chosenIndex].label,
			wasCustom: false,
			index: chosenIndex + 1,
		};
	}

	// Fallback
	return { answer: choice, wasCustom: true };
}

/** Parse JSON response from all-at-once editor mode */
function parseAllAtOnceResponse(jsonStr: string, questions: QuestionDef[]): AnswerRecord[] | { error: string } {
	try {
		const parsed = JSON.parse(jsonStr);
		const answers: AnswerRecord[] = [];

		// Support both { questions: [...] } and direct array
		const items = Array.isArray(parsed) ? parsed : parsed.questions;
		if (!Array.isArray(items)) {
			return { error: "Expected JSON array or object with 'questions' array" };
		}

		for (const item of items) {
			const q = questions.find(q => q.id === item.id);
			if (!q) continue; // unknown question, skip

			if (item.answer === null || item.answer === undefined || item.answer === "") {
				// User skipped — don't add
				continue;
			}

			const answerValue = String(item.answer);
			const matchedOption = q.options.find(o => o.value === answerValue || o.label === answerValue);

			if (matchedOption) {
				const optIndex = q.options.indexOf(matchedOption);
				answers.push({
					id: q.id,
					value: matchedOption.value,
					label: matchedOption.label,
					wasCustom: false,
					index: optIndex + 1,
				});
			} else {
				// Custom/free-text answer
				answers.push({
					id: q.id,
					value: answerValue,
					label: answerValue,
					wasCustom: true,
				});
			}
		}

		return answers;
	} catch (e) {
		return { error: `Invalid JSON: ${(e as Error).message}` };
	}
}

async function handleQuestionnaireRpcAllAtOnce(
	ctx: RpcContext & { editor: (title: string, prefill?: string) => Promise<string | undefined> },
	questions: QuestionDef[],
): Promise<QuestionnaireDetails> {
	// Build template JSON
	const template = {
		questions: questions.map(q => ({
			id: q.id,
			label: q.label || q.id,
			prompt: q.prompt,
			options: q.options.map(o => ({ value: o.value, label: o.label })),
			allowOther: q.allowOther !== false,
			answer: null as string | null,
		})),
	};

	const jsonStr = JSON.stringify(template, null, 2);
	const editorTitle = `Answer all questions (fill "answer" field for each, Esc to cancel)`;

	const result = await ctx.ui.editor(editorTitle, jsonStr);
	if (!result) {
		return { questions, answers: [], cancelled: true };
	}

	const parsed = parseAllAtOnceResponse(result, questions);
	if ("error" in parsed) {
		// Could return error — but protocol doesn't support re-prompt.
		// Return empty answers with cancelled behavior.
		return { questions, answers: [], cancelled: true, error: parsed.error };
	}

	return { questions, answers: parsed, cancelled: false };
}

/** Handle questionnaire tool in RPC mode */
async function handleQuestionnaireRpc(
	ctx: RpcContext,
	questions: QuestionDef[],
	mode: "sequential" | "all-at-once" = "sequential",
): Promise<QuestionnaireDetails> {
	if (mode === "all-at-once") {
		return handleQuestionnaireRpcAllAtOnce(ctx as any, questions);
	}
	const answers: AnswerRecord[] = [];
	const isMulti = questions.length > 1;

	for (let i = 0; i < questions.length; i++) {
		const q = questions[i];

		const optionLabels = q.options.map((o) => o.label);
		const hasOptions = q.options.length > 0;

		let selectedValue: string | undefined;
		let selectedLabel: string | undefined;
		let wasCustom = false;
		let selectedIndex: number | undefined;

		if (hasOptions) {
			const selectOptions = [...optionLabels];
			if (q.allowOther) {
				selectOptions.push("Type something...");
			}

			const choice = await ctx.ui.select(
				isMulti ? `${q.prompt} (${i + 1}/${questions.length})` : q.prompt,
				selectOptions,
			);

			if (choice === undefined) {
				// Cancelled
				return { questions, answers: [], cancelled: true };
			}

			const chosenIndex = selectOptions.indexOf(choice);

			if (q.allowOther && chosenIndex === optionLabels.length) {
				const customValue = await ctx.ui.input(q.prompt);
				if (customValue === undefined) {
					return { questions, answers: [], cancelled: true };
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
				selectedValue = choice;
				selectedLabel = choice;
				wasCustom = true;
			}
		} else {
			// No options — use input
			const customValue = await ctx.ui.input(q.prompt);
			if (customValue === undefined) {
				return { questions, answers: [], cancelled: true };
			}
			const trimmed = customValue.trim() || "(no response)";
			selectedValue = trimmed;
			selectedLabel = trimmed;
			wasCustom = true;
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

// ─── Extension ───────────────────────────────────────────────

export default function askAnswerExtension(pi: ExtensionAPI) {
	// ─── Tool: question ────────────────────────────────────────

	pi.registerTool({
		name: "question",
		label: "Question",
		description:
			"Задать пользователю вопрос с вариантами ответа. TUI покажет интерактивный список со стрелками. Используй когда нужно принять решение совместно с пользователем. Работает в TUI и RPC режимах.",
		promptSnippet:
			"Ask the user a question with options for interactive selection (arrows + enter in TUI)",
		promptGuidelines: [
			"Используй tool question когда тебе нужен ответ от пользователя в формате выбора из вариантов.",
			"Добавляй опцию 'Type something...' как последний вариант если возможен свободный ответ.",
			"Не задавай вопрос, если можешь решить сам. Используй только для действительно важных решений.",
		],
		parameters: QuestionParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "UI not available (non-interactive mode). Auto-answering with first option." }],
					details: {
						question: params.question,
						options: params.options.map((o) => o.label),
						answer: params.options[0]?.label ?? null,
					} satisfies QuestionDetails,
				};
			}

			// Detect mode
			const isTui = await detectTuiMode(ctx as any);

			if (!isTui) {
				// RPC mode
				const result = await handleQuestionRpc(ctx as any, params.question, params.options);
				const simpleOptions = params.options.map((o) => o.label);
				if (result.answer === null) {
					return {
						content: [{ type: "text", text: "Пользователь отменил выбор." }],
						details: { question: params.question, options: simpleOptions, answer: null } satisfies QuestionDetails,
					};
				}
				if (result.wasCustom) {
					return {
						content: [{ type: "text", text: `Пользователь написал: ${result.answer}` }],
						details: { question: params.question, options: simpleOptions, answer: result.answer, wasCustom: true } satisfies QuestionDetails,
					};
				}
				return {
					content: [{ type: "text", text: `Пользователь выбрал: ${result.index}. ${result.answer}` }],
					details: { question: params.question, options: simpleOptions, answer: result.answer, wasCustom: false } satisfies QuestionDetails,
				};
			}

			// TUI mode
			const allOptions: DisplayOption[] = [...params.options, { label: "Type something...", isOther: true }];

			const result = await ctx.ui.custom<{
				answer: string;
				wasCustom: boolean;
				index?: number;
			} | null>((tui, theme, _kb, done) => {
				let optionIndex = 0;
				let editMode = false;
				let cachedLines: string[] | undefined;

				const editor = new Editor(tui, makeEditorTheme(theme));
				editor.onSubmit = (value) => {
					const trimmed = value.trim();
					if (trimmed) {
						done({ answer: trimmed, wasCustom: true });
					} else {
						editMode = false;
						editor.setText("");
						refresh();
					}
				};

				const refresh = () => {
					cachedLines = undefined;
					tui.requestRender();
				};

				const handleInput = (data: string) => {
					if (editMode) {
						if (matchesKey(data, Key.escape)) {
							editMode = false;
							editor.setText("");
							refresh();
							return;
						}
						editor.handleInput(data);
						refresh();
						return;
					}

					if (matchesKey(data, Key.up)) {
						optionIndex = Math.max(0, optionIndex - 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.down)) {
						optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
						refresh();
						return;
					}
					if (matchesKey(data, Key.enter)) {
						const selected = allOptions[optionIndex];
						if (selected.isOther) {
							editMode = true;
							refresh();
						} else {
							done({ answer: selected.label, wasCustom: false, index: optionIndex + 1 });
						}
						return;
					}
					if (matchesKey(data, Key.escape)) {
						done(null);
					}
				};

				const render = (width: number): string[] => {
					if (cachedLines) return cachedLines;
					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, width));

					add(theme.fg("accent", "─".repeat(width)));
					add(theme.fg("text", ` ${params.question}`));
					lines.push("");

					for (let i = 0; i < allOptions.length; i++) {
						const opt = allOptions[i];
						const selected = i === optionIndex;
						const prefix = selected ? theme.fg("accent", "❯ ") : "  ";

						if (opt.isOther && editMode) {
							add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
						} else if (selected) {
							add(prefix + theme.fg("accent", `${i + 1}. ${opt.label}`));
						} else {
							add(`  ${theme.fg("text", `${i + 1}. ${opt.label}`)}`);
						}
						if (opt.description) {
							add(`    ${theme.fg("muted", opt.description)}`);
						}
					}

					if (editMode) {
						lines.push("");
						add(theme.fg("muted", " Your answer:"));
						for (const line of editor.render(width - 2)) {
							add(` ${line}`);
						}
						lines.push("");
						add(theme.fg("dim", " Enter to submit · Esc to go back"));
					} else {
						lines.push("");
						add(theme.fg("dim", " ↑↓ navigate · Enter select · Esc cancel"));
					}
					add(theme.fg("accent", "─".repeat(width)));

					cachedLines = lines;
					return lines;
				};

				return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
			});

			const simpleOptions = params.options.map((o) => o.label);

			if (!result) {
				return {
					content: [{ type: "text", text: "Пользователь отменил выбор." }],
					details: { question: params.question, options: simpleOptions, answer: null } satisfies QuestionDetails,
				};
			}

			if (result.wasCustom) {
				return {
					content: [{ type: "text", text: `Пользователь написал: ${result.answer}` }],
					details: { question: params.question, options: simpleOptions, answer: result.answer, wasCustom: true } satisfies QuestionDetails,
				};
			}

			return {
				content: [{ type: "text", text: `Пользователь выбрал: ${result.index}. ${result.answer}` }],
				details: { question: params.question, options: simpleOptions, answer: result.answer, wasCustom: false } satisfies QuestionDetails,
			};
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("question ")) + theme.fg("muted", args.question);
			const opts = Array.isArray(args.options) ? args.options : [];
			if (opts.length) {
				const labels = opts.map((o: OptionDef) => o.label);
				const numbered = [...labels, "Type something..."].map((o, i) => `${i + 1}. ${o}`);
				text += `\n${theme.fg("dim", `  ${numbered.join(", ")}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme, _context) {
			const details = result.details as QuestionDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.answer === null) {
				return new Text(theme.fg("warning", "✗ Cancelled"), 0, 0);
			}
			if (details.wasCustom) {
				return new Text(
					theme.fg("success", "✓ ") + theme.fg("muted", "(wrote) ") + theme.fg("accent", details.answer),
					0,
					0,
				);
			}
			const idx = details.options.indexOf(details.answer) + 1;
			const display = idx > 0 ? `${idx}. ${details.answer}` : details.answer;
			return new Text(theme.fg("success", "✓ ") + theme.fg("accent", display), 0, 0);
		},
	});

	// ─── Tool: questionnaire ──────────────────────────────────

	pi.registerTool({
		name: "questionnaire",
		label: "Questionnaire",
		description:
			"Задать серию вопросов с таб-навигацией. Один вопрос — простой список. Несколько — интерфейс с вкладками. Используй для сбора нескольких решений за раз. Работает в TUI и RPC режимах. mode:'all-at-once' — все вопросы разом через JSON-редактор (RPC) или табы (TUI).",
		promptSnippet:
			"Ask the user multiple questions in a tabbed interface",
		promptGuidelines: [
			"Используй questionnaire когда нужно собрать несколько ответов за один вызов.",
			"Каждому вопросу давай уникальный id и короткий label для таба.",
			"Для одного вопроса проще использовать tool question.",
			"Используй mode: 'all-at-once' когда нужно собрать ответы на все вопросы за один шаг — в RPC режиме откроется JSON-редактор со всеми вопросами сразу.",
		],
		parameters: QuestionnaireParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "UI not available (non-interactive mode)." }],
					details: { questions: params.questions, answers: [], cancelled: true } satisfies QuestionnaireDetails,
				};
			}

			// Normalize questions
			const questions: QuestionDef[] = params.questions.map((q, i) => ({
				...q,
				label: q.label || `Q${i + 1}`,
				allowOther: q.allowOther !== false,
			}));

			// Detect mode
			const isTui = await detectTuiMode(ctx as any);

			// Извлечь mode
			const mode = (params as any).mode || "sequential";

			if (!isTui) {
				// RPC mode
				const result = await handleQuestionnaireRpc(ctx as any, questions, mode);
				if (result.cancelled) {
					if (result.error) {
						return {
							content: [{ type: "text", text: `Ошибка обработки JSON: ${result.error}. Опрос отменён.` }],
							details: result,
						};
					}
					return {
						content: [{ type: "text", text: "Пользователь отменил опрос." }],
						details: result,
					};
				}
				const answerLines = result.answers.map((a) => {
					const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
					if (a.wasCustom) {
						return `${qLabel}: пользователь написал: ${a.label}`;
					}
					return `${qLabel}: выбрано: ${a.index}. ${a.label}`;
				});
				return {
					content: [{ type: "text", text: answerLines.join("\n") }],
					details: result,
				};
			}

			// TUI mode
			const isMulti = questions.length > 1;
			const totalTabs = questions.length + 1;

			const result = await ctx.ui.custom<QuestionnaireDetails>((tui, theme, _kb, done) => {
				let currentTab = 0;
				let optionIndex = 0;
				let inputMode = false;
				let inputQuestionId: string | null = null;
				let cachedLines: string[] | undefined;
				const answers = new Map<string, AnswerRecord>();

				const editor = new Editor(tui, makeEditorTheme(theme));
				editor.onSubmit = (value) => {
					if (!inputQuestionId) return;
					const trimmed = value.trim() || "(no response)";
					answers.set(inputQuestionId, { id: inputQuestionId, value: trimmed, label: trimmed, wasCustom: true });
					inputMode = false;
					inputQuestionId = null;
					editor.setText("");
					advanceAfterAnswer();
				};

				const refresh = () => {
					cachedLines = undefined;
					tui.requestRender();
				};

				const submit = (cancelled: boolean) => {
					done({ questions, answers: Array.from(answers.values()), cancelled });
				};

				const currentQuestion = (): QuestionDef | undefined => questions[currentTab];

				const currentOptions = (): DisplayOption[] => {
					const q = currentQuestion();
					if (!q) return [];
					const opts: DisplayOption[] = [...q.options];
					if (q.allowOther) {
						opts.push({ value: "__other__", label: "Type something...", isOther: true });
					}
					return opts;
				};

				const allAnswered = (): boolean => questions.every((q) => answers.has(q.id));

				const advanceAfterAnswer = () => {
					if (!isMulti) {
						submit(false);
						return;
					}
					if (currentTab < questions.length - 1) {
						currentTab++;
					} else {
						currentTab = questions.length;
					}
					optionIndex = 0;
					refresh();
				};

				const saveAnswer = (id: string, value: string, label: string, wasCustom: boolean, index?: number) => {
					answers.set(id, { id, value, label, wasCustom, index });
				};

				const handleInput = (data: string) => {
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

					if (currentTab === questions.length) {
						if (matchesKey(data, Key.enter) && allAnswered()) {
							submit(false);
						} else if (matchesKey(data, Key.escape)) {
							submit(true);
						}
						return;
					}

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

					if (matchesKey(data, Key.escape)) {
						submit(true);
					}
				};

				const render = (width: number): string[] => {
					if (cachedLines) return cachedLines;
					const lines: string[] = [];
					const add = (s: string) => lines.push(truncateToWidth(s, width));
					const q = currentQuestion();
					const opts = currentOptions();

					add(theme.fg("accent", "─".repeat(width)));

					// Tab bar
					if (isMulti) {
						const tabs: string[] = [];
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
						tabs.push(submitStyled);
						add(` ${tabs.join("")}`);
						lines.push("");
					}

					const renderOptions = () => {
						for (let i = 0; i < opts.length; i++) {
							const opt = opts[i];
							const selected = i === optionIndex;
							const prefix = selected ? theme.fg("accent", "❯ ") : "  ";
							const color = selected ? "accent" : "text";
							if (opt.isOther && inputMode) {
								add(prefix + theme.fg("accent", `${i + 1}. ${opt.label} ✎`));
							} else {
								add(prefix + theme.fg(color, `${i + 1}. ${opt.label}`));
							}
							if (opt.description) {
								add(`    ${theme.fg("muted", opt.description)}`);
							}
						}
					};

					if (inputMode && q) {
						add(theme.fg("text", ` ${q.prompt}`));
						lines.push("");
						renderOptions();
						lines.push("");
						add(theme.fg("muted", " Your answer:"));
						for (const line of editor.render(width - 2)) {
							add(` ${line}`);
						}
						lines.push("");
						add(theme.fg("dim", " Enter to submit · Esc to go back"));
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
							const missing = questions.filter((q) => !answers.has(q.id)).map((q) => q.label).join(", ");
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
							? " Tab/←→ navigate · ↑↓ select · Enter confirm · Esc cancel"
							: " ↑↓ navigate · Enter select · Esc cancel";
						add(theme.fg("dim", help));
					}
					add(theme.fg("accent", "─".repeat(width)));

					cachedLines = lines;
					return lines;
				};

				return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
			});

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "Пользователь отменил опрос." }],
					details: result,
				};
			}

			const answerLines = result.answers.map((a) => {
				const qLabel = questions.find((q) => q.id === a.id)?.label || a.id;
				if (a.wasCustom) {
					return `${qLabel}: пользователь написал: ${a.label}`;
				}
				return `${qLabel}: выбрано: ${a.index}. ${a.label}`;
			});

			return {
				content: [{ type: "text", text: answerLines.join("\n") }],
				details: result,
			};
		},

		renderCall(args, theme, _context) {
			const qs = (args.questions as QuestionDef[]) || [];
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
			const details = result.details as QuestionnaireDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) {
				return new Text(theme.fg("warning", "✗ Cancelled"), 0, 0);
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
