/**
 * /voice-init wizard — полный цикл настройки расширения voice-ollama-tui.
 *
 * Пошаговый wizard:
 *   0. Приветствие + проверка зависимостей
 *   1. Проверка аудиоустройства
 *   2. Выбор языка распознавания
 *   3. Настройка максимальной длительности записи
 *   4. Включение Ollama (опционально)
 *   5. Настройка шортката
 *   6. Проверка/скачивание whisper модели
 *   7. Сохранение .env
 *   8. Предложение /reload
 */

import fs from "node:fs";
import path from "node:path";
import type { ExtensionCommandContext } from "@itone/fan-coding-agent";
import { getExtensionDir } from "./config.js";
import { checkDependencies, checkAudioDevice } from "./dependencies.js";
import { listOllamaModels } from "./ollama-service.js";
import { ensureWhisperModel } from "./model-downloader.js";
import {
  downloadWhisperBinary,
  getBinaryDownloadInfo,
  getCurrentPlatform,
  getLocalBinaryPath,
  hasLocalBinary,
  isWhisperCliInPath,
} from "./bin-manager.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WizardState {
	/** Язык распознавания (код или "auto") */
	language: string;
	/** Максимальная длительность записи (сек) */
	recordDurationMax: number;
	/** Включить Ollama */
	ollamaEnabled: boolean;
	/** Базовый URL Ollama */
	ollamaBaseUrl: string;
	/** Модель Ollama */
	ollamaModel: string;
	/** System prompt Ollama */
	ollamaSystemPrompt: string;
	/** Шорткат */
	shortcut: string;
	/** Имя аудиоустройства (опционально) */
	audioDevice: string;
}

// ---------------------------------------------------------------------------
// Defaults (mirrors config.ts)
// ---------------------------------------------------------------------------

const LANGUAGE_OPTIONS = [
	{ label: "Автоопределение (auto)", value: "auto" },
	{ label: "Русский (ru)", value: "ru" },
	{ label: "Английский (en)", value: "en" },
	{ label: "Немецкий (de)", value: "de" },
	{ label: "Французский (fr)", value: "fr" },
	{ label: "Испанский (es)", value: "es" },
	{ label: "Китайский (zh)", value: "zh" },
	{ label: "Японский (ja)", value: "ja" },
	{ label: "Другой", value: "other" },
];

const DEFAULT_RECORD_DURATION_MAX = 60;
const DEFAULT_LANGUAGE = "auto";
const DEFAULT_OLLAMA_ENABLED = false;
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";
const DEFAULT_OLLAMA_MODEL = "llama3.2";
const DEFAULT_OLLAMA_SYSTEM_PROMPT =
	"You are a helpful assistant. Fix punctuation and obvious typos in the user's dictated text. Preserve the original meaning and language. Return ONLY the corrected text, nothing else.";
const DEFAULT_SHORTCUT = "ctrl+shift+space";
const DEFAULT_AUDIO_DEVICE = "default";

const DURATION_OPTIONS = [
	{ label: "5 секунд", value: "5" },
	{ label: "15 секунд", value: "15" },
	{ label: "30 секунд", value: "30" },
	{ label: "60 секунд (по умолчанию)", value: "60" },
	{ label: "120 секунд", value: "120" },
	{ label: "300 секунд", value: "300" },
	{ label: "Свой вариант", value: "custom" },
];

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runVoiceInitWizard(ctx: ExtensionCommandContext): Promise<void> {
	ctx.ui.setStatus("voice-ollama-tui", "🎙 Настройка...");

	// ── Шаг 0: Приветствие + проверка зависимостей ─────────────────────
	let depStatus = checkDependencies();

	// Если whisper-cli отсутствует, предлагаем скачать готовый бинарник.
	if (!depStatus.ok && depStatus.missing.includes("whisper-cli")) {
		const platform = getCurrentPlatform();
		if (platform && !hasLocalBinary()) {
			const info = await getBinaryDownloadInfo(platform);
			const sizeText = info?.sizeBytes
				? `размер ~${formatBytes(info.sizeBytes)}`
				: "размер будет определён при скачивании";

			ctx.ui.notify(
				`whisper-cli не найден. Для ${platform} доступен готовый бинарник (${sizeText}).`,
				"info",
			);

			const message = [
				"whisper.cpp (whisper-cli) не найден в PATH.",
				"",
				`Для вашей платформы — ${platform} — можно автоматически скачать готовый бинарник whisper-cli (${sizeText}).`,
				"",
				"Бинарник будет загружен из FAN Store и сохранён локально в директории расширения.",
				"",
				"Скачать и установить whisper-cli?",
			].join("\n");

			const download = await ctx.ui.confirm("Скачать whisper-cli?", message);
			if (download) {
				try {
					ctx.ui.setStatus("voice-ollama-tui", "🎙 Скачивание whisper-cli...");
					ctx.ui.notify("Скачиваю whisper-cli из FAN Store...", "info");
					const binPath = await downloadWhisperBinary(platform, {
						onProgress: ({ downloaded, total }) => {
							const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
							ctx.ui.setStatus(
								"voice-ollama-tui",
								`🎙 Загрузка whisper-cli: ${pct}% (${formatBytes(downloaded)} / ${total > 0 ? formatBytes(total) : "?"})`,
							);
						},
					});
					ctx.ui.notify(`✅ whisper-cli установлен: ${binPath}`, "info");
					ctx.ui.setStatus("voice-ollama-tui", "🎙 whisper-cli готов");
				} catch (err) {
					ctx.ui.notify(
						`❌ Не удалось скачать whisper-cli: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
					ctx.ui.setStatus("voice-ollama-tui", "🎙 Ошибка whisper-cli");
				}
			}
		} else if (!platform) {
			ctx.ui.notify(
				`Для платформы ${process.platform} ${process.arch} нет готового бинарника. Установите whisper.cpp вручную.`,
				"warning",
			);
		}
		// Refresh dependency status after attempted download.
		depStatus = checkDependencies();
	}

	if (!depStatus.ok) {
		const missingList = depStatus.missing.join(", ");
		const instructionsPreview = depStatus.instructions.slice(0, 6).join("\n");
		ctx.ui.notify(`Отсутствуют зависимости: ${missingList}.`, "warning");
		const proceed = await ctx.ui.confirm(
			"Настройка voice-ollama-tui",
			`Не все зависимости установлены: ${missingList}.\n\n${instructionsPreview}\n\nПродолжить настройку?`,
		);
		if (!proceed) {
			ctx.ui.setStatus("voice-ollama-tui", "🎙 Настройка отменена");
			return;
		}
	} else {
		const proceed = await ctx.ui.confirm(
			"Настройка voice-ollama-tui",
			"📋 **Мастер настройки голосового ввода**\n\nЗависимости в порядке. Начать настройку?",
		);
		if (!proceed) {
			ctx.ui.setStatus("voice-ollama-tui", "🎙 Настройка отменена");
			return;
		}
	}

	// ── Шаг 1: Проверка аудиоустройства ────────────────────────────────
	const deviceOk = checkAudioDevice();
	if (!deviceOk) {
		ctx.ui.notify(
			"Аудиоустройство не найдено. Проверьте подключение микрофона.",
			"warning",
		);
		const proceed = await ctx.ui.confirm(
			"Аудиоустройство",
			"⚠️ Не удалось найти аудиоустройство ввода.\n\nПроверьте, что микрофон подключён и настроен.\n\nПродолжить настройку?",
		);
		if (!proceed) {
			ctx.ui.setStatus("voice-ollama-tui", "🎙 Настройка отменена");
			return;
		}
	} else {
		ctx.ui.notify("✅ Аудиоустройство найдено.", "info");
	}

	// ── Шаг 2: Выбор языка распознавания ───────────────────────────────
	const state = await stepLanguage(ctx);

	// ── Шаг 3: Длительность записи ─────────────────────────────────────
	await stepDuration(ctx, state);

	// ── Шаг 4: Настройка Ollama ────────────────────────────────────────
	await stepOllama(ctx, state);

	// ── Шаг 5: Настройка шортката ──────────────────────────────────────
	await stepShortcut(ctx, state);

	// ── Шаг 6: Проверка/скачивание whisper модели ──────────────────────
	await stepWhisperModel(ctx, state);

	// ── Шаг 7: Сохранение .env ─────────────────────────────────────────
	await stepSaveConfig(ctx, state);

	// ── Шаг 8: Предложение /reload ─────────────────────────────────────
	ctx.ui.notify(
		`✅ Настройка завершена! Шорткат: ${state.shortcut}. Выполните /reload для применения.`,
		"info",
	);
	ctx.ui.setStatus("voice-ollama-tui", "🎙 Настроено");
}

// ---------------------------------------------------------------------------
// Step 2: Language
// ---------------------------------------------------------------------------

async function stepLanguage(ctx: ExtensionCommandContext): Promise<WizardState> {
	const langLabels = LANGUAGE_OPTIONS.map((o) => o.label);
	const defaultLangLabel = LANGUAGE_OPTIONS[0].label;
	const chosen = await ctx.ui.select(
		"Выберите язык распознавания",
		langLabels,
	);
	const selected = LANGUAGE_OPTIONS.find((o) => o.label === chosen) ?? LANGUAGE_OPTIONS[0];

	let language = selected.value;
	if (language === "other") {
		const custom = await ctx.ui.input("Введите код языка", "например: pt, ko, ar");
		language = custom?.trim() || "auto";
	}

	return {
		language,
		recordDurationMax: DEFAULT_RECORD_DURATION_MAX,
		ollamaEnabled: DEFAULT_OLLAMA_ENABLED,
		ollamaBaseUrl: DEFAULT_OLLAMA_BASE_URL,
		ollamaModel: DEFAULT_OLLAMA_MODEL,
		ollamaSystemPrompt: DEFAULT_OLLAMA_SYSTEM_PROMPT,
		shortcut: DEFAULT_SHORTCUT,
		audioDevice: DEFAULT_AUDIO_DEVICE,
	};
}

// ---------------------------------------------------------------------------
// Step 3: Duration
// ---------------------------------------------------------------------------

async function stepDuration(ctx: ExtensionCommandContext, state: WizardState): Promise<void> {
	const durLabels = DURATION_OPTIONS.map((o) => o.label);
	const defaultLabel = DURATION_OPTIONS.find((o) => o.value === String(DEFAULT_RECORD_DURATION_MAX))?.label ??
		DURATION_OPTIONS[3].label;
	const chosen = await ctx.ui.select(
		`Максимальная длительность записи (сек). По умолчанию: ${DEFAULT_RECORD_DURATION_MAX}`,
		durLabels,
	);
	const selected = DURATION_OPTIONS.find((o) => o.label === chosen);

	if (selected?.value === "custom") {
		const custom = await ctx.ui.input(
			"Длительность (5–300 секунд)",
			String(DEFAULT_RECORD_DURATION_MAX),
		);
		const parsed = Number.parseInt(custom?.trim() || String(DEFAULT_RECORD_DURATION_MAX), 10);
		state.recordDurationMax = Number.isNaN(parsed) ? DEFAULT_RECORD_DURATION_MAX : Math.max(5, Math.min(300, parsed));
	} else if (selected) {
		state.recordDurationMax = Number.parseInt(selected.value, 10);
	}
}

// ---------------------------------------------------------------------------
// Step 4: Ollama
// ---------------------------------------------------------------------------

async function stepOllama(ctx: ExtensionCommandContext, state: WizardState): Promise<void> {
	const enableOllama = await ctx.ui.confirm(
		"Подключить Ollama?",
		`Ollama может улучшать распознанный текст: исправлять пунктуацию и очевидные опечатки.\n\nПо умолчанию: ${DEFAULT_OLLAMA_ENABLED ? "включено" : "отключено"}.\n\nВключить постобработку через Ollama?`,
	);
	if (!enableOllama) {
		state.ollamaEnabled = false;
		return;
	}

	state.ollamaEnabled = true;

	// Ввод baseUrl
	let baseUrl = await ctx.ui.input(
		`Адрес Ollama сервера. По умолчанию: ${DEFAULT_OLLAMA_BASE_URL}`,
		DEFAULT_OLLAMA_BASE_URL,
	);
	if (!baseUrl?.trim()) {
		baseUrl = "http://localhost:11434";
	}
	state.ollamaBaseUrl = baseUrl.replace(/\/+$/, "");

	// Проверка доступности
	ctx.ui.setStatus("voice-ollama-tui", "🎙 Проверка Ollama...");
	const modelsResult = await listOllamaModels({ ollamaBaseUrl: state.ollamaBaseUrl });

	if (!modelsResult.reachable) {
		ctx.ui.notify(
			"⚠️ Ollama недоступна. Вы сможете настроить её позже в .env.",
			"warning",
		);
		state.ollamaEnabled = false;
		return;
	}

	ctx.ui.setStatus("voice-ollama-tui", "🎙 Ollama доступна");

	// Выбор модели
	if (modelsResult.models.length > 0) {
		const chosen = await ctx.ui.select("Выберите модель Ollama", modelsResult.models);
		state.ollamaModel = chosen || modelsResult.models[0];
	} else {
		const modelName = await ctx.ui.input(
			`Название модели Ollama. По умолчанию: ${DEFAULT_OLLAMA_MODEL}`,
			DEFAULT_OLLAMA_MODEL,
		);
		state.ollamaModel = modelName?.trim() || DEFAULT_OLLAMA_MODEL;
	}

	// System prompt
	const prompt = await ctx.ui.input(
		`System prompt для Ollama (оставьте пустым для умолчания: ${DEFAULT_OLLAMA_MODEL})`,
		"",
	);
	if (prompt?.trim()) {
		state.ollamaSystemPrompt = prompt.trim();
	}
}

// ---------------------------------------------------------------------------
// Step 5: Shortcut
// ---------------------------------------------------------------------------

async function stepShortcut(ctx: ExtensionCommandContext, state: WizardState): Promise<void> {
	const shortcut = await ctx.ui.input(
		`Горячая клавиша для голосового ввода. По умолчанию: ${DEFAULT_SHORTCUT}`,
		DEFAULT_SHORTCUT,
	);
	state.shortcut = shortcut?.trim() || DEFAULT_SHORTCUT;
}

// ---------------------------------------------------------------------------
// Step 6: Whisper model
// ---------------------------------------------------------------------------

async function stepWhisperModel(ctx: ExtensionCommandContext, state: WizardState): Promise<void> {
	const download = await ctx.ui.confirm(
		"Модель Whisper",
		"Скачать модель ggml-base.bin для распознавания речи (~142 МБ)?\n\nЕсли модель уже есть — она не будет скачана повторно.",
	);

	if (!download) {
		ctx.ui.notify(
			"Модель не скачана. Вы можете скачать её позже вручную или через повторный /voice-init.",
			"info",
		);
		return;
	}

	ctx.ui.setStatus("voice-ollama-tui", "🎙 Скачивание модели...");
	ctx.ui.notify("Скачиваю модель ggml-base.bin...", "info");

	try {
		await ensureWhisperModel({
			onProgress: (downloaded: number, total: number) => {
				const pct = total > 0 ? Math.round((downloaded / total) * 100) : 0;
				ctx.ui.setStatus(
					"voice-ollama-tui",
					`🎙 Загрузка модели: ${pct}% (${formatBytes(downloaded)} / ${total > 0 ? formatBytes(total) : "?"})`,
				);
			},
		});
		ctx.ui.notify("✅ Модель ggml-base.bin успешно скачана.", "info");
		ctx.ui.setStatus("voice-ollama-tui", "🎙 Модель готова");
	} catch (err) {
		ctx.ui.notify(
			`❌ Ошибка скачивания модели: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
		ctx.ui.setStatus("voice-ollama-tui", "🎙 Ошибка модели");
	}
}

// ---------------------------------------------------------------------------
// Step 7: Save .env
// ---------------------------------------------------------------------------

async function stepSaveConfig(ctx: ExtensionCommandContext, state: WizardState): Promise<void> {
	const extDir = getExtensionDir();
	const envPath = path.join(extDir, ".env");

	// Определяем путь к модели по умолчанию (как в config.ts)
	const home = (process.platform === "win32" ? process.env.USERPROFILE : process.env.HOME) ?? "/tmp";
	const defaultModelPath = path.join(home, ".fan", "models", "speech", "ggml-base.bin");

	// Prefer locally downloaded binary if available.
	let whisperBinPath = "whisper-cli";
	try {
		if (hasLocalBinary()) {
			whisperBinPath = getLocalBinaryPath();
		}
	} catch {
		// Fallback to PATH lookup.
	}

	const lines: string[] = [
		"# Voice Input for TUI (Ollama) — configuration",
		"# Generated by /voice-init wizard",
		"",
		"# Audio",
		`AUDIO_DEVICE=${state.audioDevice || DEFAULT_AUDIO_DEVICE}`,
		`RECORD_DURATION_MAX=${state.recordDurationMax}`,
		"",
		"# Whisper",
		`WHISPER_BIN_PATH=${whisperBinPath}`,
		`WHISPER_MODEL_PATH=${defaultModelPath}`,
		`WHISPER_LANGUAGE=${state.language}`,
		"",
		"# Ollama",
		`OLLAMA_ENABLED=${state.ollamaEnabled}`,
		`OLLAMA_BASE_URL=${state.ollamaBaseUrl}`,
		`OLLAMA_MODEL=${state.ollamaModel}`,
		`OLLAMA_SYSTEM_PROMPT=${state.ollamaSystemPrompt}`,
		"",
		"# UI",
		`SHORTCUT=${state.shortcut}`,
		"",
	];

	fs.writeFileSync(envPath, lines.join("\n"), "utf-8");
	ctx.ui.notify(`✅ Конфигурация сохранена в ${envPath}`, "info");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} Б`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}
