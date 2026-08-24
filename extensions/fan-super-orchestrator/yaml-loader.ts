// F-B Refactor: Generic YAML loader — extracted from role-loader.ts.
//
// Карточка: docs/features/super-orchestrator-v2/roadmap.md §F-B (refactor-цели)
//
// Контракт:
//   readYamlFile(path) — прочитать один YAML-файл, вернуть parsed content (unknown).
//   readYamlDir(dir) — прочитать директорию YAML-файлов, вернуть Map<id,data>:
//     — имя файла (без расширения) используется как ключ Map и как expected id;
//     — если в распарсенном объекте есть поле `id`, оно должно совпадать с expected id
//       (несовпадение → throw);
//     — пустая/несуществующая директория → пустой Map (не throw);
//     — не-.yaml/.yml файлы пропускаются.
//
// F-7 fix: убрана зависимость от npm-пакета `yaml`. В FAN extensions
// node_modules/ не bundled (DEPLOY.toml exclude). Inline mini-parser
// покрывает subset, используемый в role-профилях и role-config:
//   - key: value (string / number / boolean / null)
//   - key: [a, b, c]            (inline list)
//   - key:
//       - item                   (block list, same-indent children)
//   - вложенные maps через 2-space indent
//   - комментарии: `# ...` в начале строки или после значения (с учётом кавычек)
//   - quoted strings: 'single' / "double"
//   - inline maps `{a: 1, b: 2}` (flat)
// Не поддерживается (нет в наших yaml): multiline strings, anchors,
// tags, сложные типы. Если понадобится — расширить.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ─── YAML value types ──────────────────────────────────────────────────────

type YamlScalar = string | number | boolean | null;
type YamlValue = YamlScalar | YamlValue[] | { [key: string]: YamlValue };

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Strip `# comment` from a line, respecting quoted strings. */
function stripComment(line: string): string {
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "'" && !inDouble) inSingle = !inSingle;
		else if (c === '"' && !inSingle) inDouble = !inDouble;
		else if (c === "#" && !inSingle && !inDouble) {
			return line.slice(0, i);
		}
	}
	return line;
}

/** Parse a scalar string into string / number / boolean / null. */
function parseScalar(raw: string): YamlScalar {
	if (raw === "" || raw === "~" || raw === "null" || raw === "Null" || raw === "NULL") {
		return null;
	}
	if (raw === "true" || raw === "True" || raw === "TRUE" || raw === "yes" || raw === "Yes" || raw === "YES") {
		return true;
	}
	if (raw === "false" || raw === "False" || raw === "FALSE" || raw === "no" || raw === "No" || raw === "NO") {
		return false;
	}
	// Quoted string — return contents verbatim.
	if (
		raw.length >= 2 &&
		((raw[0] === '"' && raw[raw.length - 1] === '"') || (raw[0] === "'" && raw[raw.length - 1] === "'"))
	) {
		return raw.slice(1, -1);
	}
	// Number.
	if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(raw)) {
		const n = Number(raw);
		if (!Number.isNaN(n)) return n;
	}
	return raw;
}

/** Parse inline list `[a, b, c]`. Supports nested brackets. */
function parseInlineList(raw: string): YamlValue[] {
	const inner = raw.slice(1, -1).trim();
	if (inner === "") return [];
	const parts: string[] = [];
	let depth = 0;
	let inSingle = false;
	let inDouble = false;
	let buf = "";
	for (let i = 0; i < inner.length; i++) {
		const c = inner[i];
		if (c === "'" && !inDouble) inSingle = !inSingle;
		else if (c === '"' && !inSingle) inDouble = !inDouble;
		else if (!inSingle && !inDouble) {
			if (c === "[" || c === "{") depth++;
			else if (c === "]" || c === "}") depth--;
			else if (c === "," && depth === 0) {
				parts.push(buf.trim());
				buf = "";
				continue;
			}
		}
		buf += c;
	}
	if (buf.trim() !== "") parts.push(buf.trim());
	return parts.map(parseScalar);
}

/** Parse inline map `{a: 1, b: 2}` (flat). */
function parseInlineMap(raw: string): { [key: string]: YamlScalar } {
	const inner = raw.slice(1, -1).trim();
	const obj: { [key: string]: YamlScalar } = {};
	if (inner === "") return obj;
	const parts: string[] = [];
	let depth = 0;
	let inDouble = false;
	let inSingle = false;
	let buf = "";
	for (let i = 0; i < inner.length; i++) {
		const c = inner[i];
		if (c === "'" && !inDouble) inSingle = !inSingle;
		else if (c === '"' && !inSingle) inDouble = !inDouble;
		else if (!inSingle && !inDouble) {
			if (c === "{" || c === "[") depth++;
			else if (c === "}" || c === "]") depth--;
			else if (c === "," && depth === 0) {
				parts.push(buf.trim());
				buf = "";
				continue;
			}
		}
		buf += c;
	}
	if (buf.trim() !== "") parts.push(buf.trim());
	for (const part of parts) {
		const colonIdx = part.indexOf(":");
		if (colonIdx < 0) continue;
		const k = part.slice(0, colonIdx).trim();
		const v = part.slice(colonIdx + 1).trim();
		obj[k] = parseScalar(v);
	}
	return obj;
}

// ─── Pre-processed lines ───────────────────────────────────────────────────

interface Line {
	indent: number;
	/** Для map lines: `key:`, `key: value`, `key: [..]`. Для list lines: `- value`. */
	raw: string;
	kind: "map" | "list";
}

/** Strip comments and blank lines, compute indent and kind. */
function preprocess(rawLines: string[]): Line[] {
	const out: Line[] = [];
	for (const raw of rawLines) {
		const stripped = stripComment(raw);
		if (stripped.trim() === "") continue;
		let indent = 0;
		while (indent < stripped.length && stripped[indent] === " ") indent++;
		const body = stripped.slice(indent);
		if (body.startsWith("- ")) {
			out.push({ indent, raw: body.slice(2).trim(), kind: "list" });
		} else if (body === "-") {
			out.push({ indent, raw: "", kind: "list" });
		} else {
			out.push({ indent, raw: body, kind: "map" });
		}
	}
	return out;
}

/** Count leading whitespace (spaces). */
function countIndent(line: string): number {
	let i = 0;
	while (i < line.length && line[i] === " ") i++;
	return i;
}

// ─── Recursive descent parser ──────────────────────────────────────────────

/** Parse a sequence of `map` and `list` lines into a structure.
 *  All lines must have indent >= minIndent; stops when indent < minIndent. */
function parseBlock(lines: Line[], minIndent: number): { value: YamlValue; consumed: number } {
	if (lines.length === 0) {
		throw new Error("yaml-loader: unexpected end of input");
	}
	const first = lines[0];
	if (first.indent !== minIndent) {
		throw new Error(`yaml-loader: expected indent ${minIndent}, got ${first.indent} at "${first.raw}"`);
	}
	// Decide: is this a map (starts with `key:`) or a list (starts with `-`)?
	if (first.kind === "list") {
		// Sequence of scalars (no nested structures in our subset).
		const arr: YamlValue[] = [];
		let i = 0;
		while (i < lines.length && lines[i].indent === minIndent && lines[i].kind === "list") {
			arr.push(parseScalar(lines[i].raw));
			i++;
		}
		return { value: arr, consumed: i };
	}
	// Map: each line `key: value` or `key:` (nested).
	const obj: { [key: string]: YamlValue } = {};
	let i = 0;
	while (i < lines.length && lines[i].indent === minIndent && lines[i].kind === "map") {
		const line = lines[i];
		const colonIdx = line.raw.indexOf(":");
		if (colonIdx < 0) {
			throw new Error(`yaml-loader: expected ':' at "${line.raw}"`);
		}
		const key = line.raw.slice(0, colonIdx).trim();
		const rest = line.raw.slice(colonIdx + 1).trim();
		if (rest === "") {
			// Nested structure: look ahead at next line.
			const nextIdx = i + 1;
			if (nextIdx >= lines.length) {
				obj[key] = null;
				i++;
				continue;
			}
			const next = lines[nextIdx];
			if (next.indent <= minIndent) {
				obj[key] = null;
				i++;
				continue;
			}
			const nested = parseBlock(lines.slice(nextIdx), next.indent);
			obj[key] = nested.value;
			i = nextIdx + nested.consumed;
		} else if (rest.startsWith("[") && rest.endsWith("]")) {
			obj[key] = parseInlineList(rest);
			i++;
		} else if (rest.startsWith("{") && rest.endsWith("}")) {
			obj[key] = parseInlineMap(rest);
			i++;
		} else {
			obj[key] = parseScalar(rest);
			i++;
		}
	}
	return { value: obj, consumed: i };
}

/** Public parser — entry point. */
export function parseYaml(content: string): YamlValue {
	const rawLines = content.split(/\r?\n/);
	// Удаляем trailing пустые строки.
	while (rawLines.length > 0 && rawLines[rawLines.length - 1].trim() === "") {
		rawLines.pop();
	}
	if (rawLines.length === 0) {
		return {};
	}
	const lines = preprocess(rawLines);
	if (lines.length === 0) {
		return {};
	}
	// Find minimum indent across all non-empty lines.
	let minIndent = Infinity;
	for (const l of lines) {
		if (l.indent < minIndent) minIndent = l.indent;
	}
	const result = parseBlock(lines, minIndent);
	return result.value;
}

// ─── Public API ────────────────────────────────────────────────────────────

/** Read a single YAML file and parse it. Returns the parsed content typed as `T`. */
export function readYamlFile<T = unknown>(path: string): T {
	const content = readFileSync(path, "utf8");
	return parseYaml(content) as T;
}

/**
 * Read a directory of YAML files and return a Map keyed by filename-derived id.
 *
 * Convention: the file basename (without `.yaml`/`.yml`) is the expected id. If a
 * parsed object declares an `id` field, it must match the filename (id validation
 * for any YAML file that follows the `filename = id` convention).
 *
 * - Missing `dir` → empty Map.
 * - Non-YAML files → skipped.
 * - id mismatch → throw (so role-loader can rely on declared ids being consistent
 *   with filenames, while duplicate-detection across files still happens in the
 *   layer-level loader).
 */
export function readYamlDir(dir: string): Map<string, unknown> {
	const result = new Map<string, unknown>();
	if (!existsSync(dir)) return result;

	for (const file of readdirSync(dir)) {
		if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
		const id = file.replace(/\.(yaml|yml)$/, "");
		const data = readYamlFile(join(dir, file));
		if (data && typeof data === "object" && "id" in data) {
			const declaredId = (data as { id: unknown }).id;
			if (declaredId !== id) {
				// Throws "duplicate role id conflict" wording so it remains compatible with
				// existing layer-level duplicate-detection tests (regex /duplicate|conflict/i).
				throw new Error(`Duplicate role id conflict in ${file}: declared=${String(declaredId)} expected=${id}`);
			}
		}
		result.set(id, data);
	}
	return result;
}
