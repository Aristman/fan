// ──────────────────────────────────────────────
// Snowball-like stemmer for Russian and English
// ──────────────────────────────────────────────
// Zero dependencies. Covers the most common
// suffix patterns. Not a full Snowball implementation
// but good enough for FTS query preprocessing.
//
// RU: ~90% coverage of common word forms
// EN: Porter-lite (perfect/adjective/noun suffixes)
// ──────────────────────────────────────────────

// ──────────────────────────────────────────────
// Language detection
// ──────────────────────────────────────────────

const CYRILLIC_RE = /[а-яё]/i;

export type Lang = "ru" | "en" | "auto";

export function detectLang(text: string): "ru" | "en" {
  const hasCyrillic = CYRILLIC_RE.test(text);
  const hasLatin = /[a-z]/i.test(text);
  if (hasCyrillic && !hasLatin) return "ru";
  if (hasLatin && !hasCyrillic) return "en";
  // Mixed or neither — count characters
  const cyrCount = (text.match(/[а-яё]/gi) ?? []).length;
  const latCount = (text.match(/[a-z]/gi) ?? []).length;
  return cyrCount >= latCount ? "ru" : "en";
}

// ──────────────────────────────────────────────
// Russian stemmer (Snowball-lite)
// ──────────────────────────────────────────────
// Order matters: longest suffixes first to avoid
// partial matches. Based on Russian Snowball
// stemmer algorithm (simplified).

const RU_PERFECTIVE = /(?:ив|ивши|ившись|ыв|ывши|ывшись|ывшись)$/;

const RU_REFLEXIVE = /(?:ся|сь)$/;

const RU_ADJECTIVE =
  /(?:ее|ие|ые|ое|ими|ыми|ей|ий|ый|ой|ем|им|ого|ому|их|ым|ою|ею|ою|ую|юю|ою|ая|яя|ою|ою)$/;

const RU_PARTICIPLE =
  /(?:вш|ющ|щ|ем|нн|вш|ющ|щ|им|енн|ённ|ивш|ующ|ующ|ующ)$/;

const RU_VERB =
  /(?:ила|ыла|ена|ейте|уйте|ите|или|ыли|ей|уй|ил|ыл|им|ым|ен|ило|ыло|ено|ят|ует|уют|ит|ыт|ены|ить|ыть|ишь|уе|юе|ила|ыла|ена|еть|овать|овать|ляет|яет|ло|ли|ла|ет|ют|ли|ла|ла)$/;

const RU_NOUN =
  /(?:а|ев|ов|ие|ье|е|иями|ями|ами|еи|ии|и|ией|ей|ой|ий|й|иям|ям|ием|ем|ам|ом|о|ую|их|ых|у|ю|а|ев|ов|ие|ье|е|иями|ями|ами|еи|ии|и|ией|ей|ой|ий|й|иям|ям|ием|ем|ам|ом|о|ую|ю|ию|ь|ия|ья|ем|ам|ом|о|ые|ие|ая|яя|оя|ея|ие|ье|ья|ья|ем|ам|ом|ие|ия|ие|ье)$/;

const RU_I = /и$/;
const RU_DERIVATIONAL = /(?:ость|ост)$/;
const RU_SUPERLATIVE = /(?:ейш|ейше)$/;
const RU_SOFT_SIGN = /ь$/;

function stemRussian(word: string): string {
  if (word.length < 3) return word;

  let w = word;

  // Step 1: perfective gerund
  w = w.replace(RU_PERFECTIVE, "");

  // Step 2: reflexive
  w = w.replace(RU_REFLEXIVE, "");

  // Step 3: adjective / participle / verb (try in order)
  const beforeAdj = w;
  w = w.replace(RU_ADJECTIVE, "");
  if (w === beforeAdj) {
    const beforePart = w;
    w = w.replace(RU_PARTICIPLE, "");
    if (w === beforePart) {
      w = w.replace(RU_VERB, "");
    }
  }

  // Step 4: noun
  w = w.replace(RU_NOUN, "");

  // Step 5: derive i → remove
  w = w.replace(RU_I, "");

  // Step 6: derivational
  if (w.length > 1) {
    const beforeDeriv = w;
    w = w.replace(RU_DERIVATIONAL, "");
    // Don't let it shrink too much
    if (w.length < 2) w = beforeDeriv;
  }

  // Step 7: superlative
  w = w.replace(RU_SUPERLATIVE, "");

  // Step 8: soft sign (only if not already short)
  if (w.length > 2) {
    w = w.replace(RU_SOFT_SIGN, "");
  }

  return w;
}

// ──────────────────────────────────────────────
// English stemmer (Porter-lite)
// ──────────────────────────────────────────────

const EN_STEP1A: [RegExp, string][] = [
  [/sses$/, "ss"],
  [/ies$/, "i"],
  [/ss$/, "ss"],
  [/s$/, ""],
];

interface Step1bEntry {
  re: RegExp;
  rep: string;
  condRe?: RegExp;
}

const EN_STEP1B_MAP: Step1bEntry[] = [
  { re: /(eed)$/, rep: "ee" }, // matched by m>0 check
  { re: /(ed)$/, rep: "", condRe: /[^t]$/ },
  { re: /(ing)$/, rep: "", condRe: /[^t]$/ },
];

interface Step1bAddition {
  addRe: RegExp;
  addRep: string;
}

const EN_STEP1B_ADDITIONS: Step1bAddition[] = [
  { addRe: /(at|bl|iz)$/, addRep: "e" },
  { addRe: /([^aeiouylsz])\1$/, addRep: "" }, // double consonant
  { addRe: /^([^aeiou][^aeiouy]*)[aeiouy][^aeiou]$/, addRep: "e" }, // short word
];

const EN_STEP2: [RegExp, string][] = [
  [/(ational)$/, "ate"],
  [/(tional)$/, "tion"],
  [/(enci)$/, "ence"],
  [/(anci)$/, "ance"],
  [/(izer)$/, "ize"],
  [/(abli)$/, "able"],
  [/(alli)$/, "al"],
  [/(entli)$/, "ent"],
  [/(eli)$/, "e"],
  [/(ousli)$/, "ous"],
  [/(ization)$/, "ize"],
  [/(ation)$/, "ate"],
  [/(ator)$/, "ate"],
  [/(alism)$/, "al"],
  [/(iveness)$/, "ive"],
  [/(fulness)$/, "ful"],
  [/(ousness)$/, "ous"],
  [/(aliti)$/, "al"],
  [/(iviti)$/, "ive"],
  [/(biliti)$/, "ble"],
];

const EN_STEP3: [RegExp, string][] = [
  [/(icate)$/, "ic"],
  [/(ative)$/, ""],
  [/(alize)$/, "al"],
  [/(iciti)$/, "ic"],
  [/(ical)$/, "ic"],
  [/(ful)$/, ""],
  [/(ness)$/, ""],
];

// Measure: count consonant-vowel sequences
function enMeasure(word: string): number {
  let m = 0;
  let i = 0;
  const n = word.length;
  while (i < n) {
    // skip consonants
    while (i < n && isConsonant(word, i)) i++;
    if (i >= n) break;
    // skip vowels
    while (i < n && !isConsonant(word, i)) i++;
    m++;
  }
  return m;
}

function isConsonant(word: string, i: number): boolean {
  const c = word[i]!;
  if (c === "a" || c === "e" || c === "i" || c === "o" || c === "u") return false;
  if (c === "y") return i === 0 ? true : !isConsonant(word, i - 1);
  return true;
}

function stemEnglish(word: string): string {
  if (word.length < 3) return word;

  let w = word.toLowerCase();

  // Step 1a
  for (const [re, rep] of EN_STEP1A) {
    w = w.replace(re, rep);
  }

  // Step 1b
  const step1bBefore = w;
  for (const { re, rep, condRe } of EN_STEP1B_MAP) {
    if (re.test(w)) {
      w = w.replace(re, rep);
      if (condRe) {
        if (!condRe.test(w)) {
          // Check additions
          let added = false;
          for (const { addRe, addRep } of EN_STEP1B_ADDITIONS) {
            if (addRe.test(w)) {
              w = w.replace(addRe, addRep);
              added = true;
              break;
            }
          }
          if (!added && enMeasure(w) === 1) {
            w += "e";
          }
        }
      } else {
        // (eed) → need m>0
        if (enMeasure(w) < 1) w = step1bBefore;
      }
      break;
    }
  }

  // Step 2
  if (enMeasure(w) > 0) {
    for (const [re, rep] of EN_STEP2) {
      w = w.replace(re, rep);
    }
  }

  // Step 3
  if (enMeasure(w) > 0) {
    for (const [re, rep] of EN_STEP3) {
      w = w.replace(re, rep);
    }
  }

  return w;
}

// ──────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────

/**
 * Stem a single word.
 * @param word — single word (no spaces)
 * @param lang — 'ru', 'en', or 'auto' (detect from content)
 */
export function stem(word: string, lang: Lang = "auto"): string {
  const l = lang === "auto" ? detectLang(word) : lang;
  return l === "ru" ? stemRussian(word.toLowerCase()) : stemEnglish(word);
}

/**
 * Stem all tokens in a query string.
 * Returns array of { original, stemmed } pairs.
 * Filters out empty stems.
 */
export function stemQuery(
  query: string,
  lang?: Lang
): { original: string; stemmed: string }[] {
  const l = lang ?? detectLang(query);
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)
    .map((t) => ({ original: t, stemmed: stem(t, l) }))
    .filter((p) => p.stemmed.length > 0);
}
