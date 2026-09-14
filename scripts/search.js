/**
 * Text normalisation, tokenisation and matching for the browser's single search box.
 * Case-, diacritic- and ё-insensitive; space-separated tokens are combined with AND.
 */

/** @param {string} text */
export function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")   // strip combining marks (accents; also decomposes é, ü, …)
    .replace(/ё/g, "е")      // ё → е (after NFD ё keeps its own code point in Cyrillic)
    .trim();
}

/** @param {string} query → array of normalized non-empty tokens */
export function tokenize(query) {
  return normalize(query).split(/\s+/).filter(Boolean);
}

/**
 * Does the haystack contain every token?
 * @param {string} haystack   Already normalized
 * @param {string[]} tokens
 */
export function matchesTokens(haystack, tokens) {
  for ( const t of tokens ) if ( !haystack.includes(t) ) return false;
  return true;
}
