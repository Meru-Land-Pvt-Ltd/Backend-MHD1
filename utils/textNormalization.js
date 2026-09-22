const crypto = require('crypto');

/**
 * Canonical form used only for duplicate comment/reply detection.
 *
 * Goals:
 * - case-insensitive
 * - ignore repeated whitespace
 * - ignore punctuation/symbol-only differences ("Nice video!" == "nice video")
 * - preserve non-Latin letters/numbers/marks (Hindi, etc.)
 * - keep emoji-only comments distinguishable instead of normalizing to empty text
 */
function normalizeDuplicateText(value) {
  const basic = String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/gu, ' ')
    .trim();

  if (!basic) return '';

  const loose = basic
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  return loose || basic;
}

/**
 * Fixed-size key safe for MongoDB unique indexes. The normalized source text is
 * never used as an index key, so very long YouTube comments remain safe.
 */
function buildDuplicateTextKey(value) {
  const normalized = normalizeDuplicateText(value);
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

module.exports = { normalizeDuplicateText, buildDuplicateTextKey };
