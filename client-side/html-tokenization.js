'use strict';

// ============================================================================
// HTML Tokenisation — Separating Structure from Content
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-5-2
// Last verified against production: 2026-07-23
//
// WHAT THIS DOES
// After a .docx is converted to HTML in the browser (via mammoth.js), this
// runs before any content is uploaded. It replaces every HTML tag except a
// small whitelist of inline emphasis tags with an opaque token
// (`[__T_0__]`, `[__T_1__]`, ...), keeping the original tag in a map that
// never leaves the browser. This serves two purposes at once: the AI model
// analyses prose without being confused by markup, and — from a privacy
// standpoint — only the tokenised plain text is uploaded, without whatever
// structural HTML metadata (e.g. tracked-changes author names embedded in
// tags by some converters) the original markup might have carried.
//
// Detokenisation (reassembling the corrected HTML for export) also happens
// entirely client-side, using the same map.
//
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// The matching, replacement, and whitelist logic is unchanged. Production
// keeps `tagMap` and the token counter as variables in the surrounding
// module's closure; here they are passed in and mutated explicitly, so
// this file has no hidden shared state and can be read (and tested) on
// its own.
// ============================================================================

/**
 * Replaces HTML tags with opaque tokens, except a small whitelist of inline
 * emphasis tags that are left untouched (harmless to an AI model and cheap
 * to keep human-readable).
 *
 * @param {string} htmlStr
 * @param {object} tagMap - mutated in place: token -> original tag string.
 * @param {{ count: number }} counter - mutated in place across calls.
 * @returns {string} the tokenised string.
 */
function tokenizeHtml(htmlStr, tagMap, counter) {
    return htmlStr.replace(/<[^>]+>/g, (match) => {
        // Emphasis tags are preserved as-is.
        if (/^<\/?(em|i|b|strong|sup|sub)\b[^>]*>$/i.test(match)) {
            return match;
        }
        const token = `[__T_${counter.count}__]`;
        tagMap[token] = match;
        counter.count++;
        return token;
    });
}

/**
 * Reassembles the original HTML from a tokenised string and its tag map.
 * Runs entirely client-side, typically just before export.
 */
function detokenizeHtml(tokenizedStr, tagMap) {
    let html = tokenizedStr;
    for (const [token, tag] of Object.entries(tagMap)) {
        html = html.split(token).join(tag);
    }
    return html;
}

/**
 * Strips any remaining tokens from a string — used when rendering plain,
 * human-readable previews that don't need the original markup at all.
 */
function stripTokens(str) {
    return String(str || '').replace(/\[__T_\d+__\]/g, '');
}

if (typeof module !== 'undefined') {
    module.exports = { tokenizeHtml, detokenizeHtml, stripTokens };
}
