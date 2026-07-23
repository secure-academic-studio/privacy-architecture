'use strict';

// ============================================================================
// AES-256-GCM Encrypted .SAU Session File
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-5-1
// Last verified against production: 2026-07-23
//
// WHAT THIS DOES
// The Proofreader's session state (document content, identified issues,
// accepted/rejected corrections) can be saved to a local .sau file,
// optionally protected with AES-256-GCM via the browser's native Web Crypto
// API. The key is derived from a user-supplied password with PBKDF2
// (100,000 iterations, SHA-256) and a random salt. Encryption, decryption,
// and key derivation all happen in the browser — the password and the
// derived key are never transmitted anywhere.
//
// If the user does not supply a password, the file is saved as plain JSON.
// This is a deliberate, user-controlled trade-off between convenience and
// protection — see the architecture document's "Accepted Trade-Off" note
// for §5.
//
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// The session payload's actual shape (document text, issue list, etc.) has
// been reduced to an opaque `payloadObject` parameter — what gets encrypted
// is someone else's concern; this file only demonstrates how.
// ============================================================================

/**
 * Derives an AES-256-GCM key from a password and salt using PBKDF2.
 * @param {string} password
 * @param {Uint8Array} salt
 * @returns {Promise<CryptoKey>}
 */
async function deriveKey(password, salt) {
    const enc = new TextEncoder();
    const keyMaterial = await window.crypto.subtle.importKey(
        'raw', enc.encode(password), { name: 'PBKDF2' }, false, ['deriveKey']
    );
    return window.crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
        keyMaterial, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
    );
}

function bufferToBase64(buffer) {
    return btoa(String.fromCharCode(...new Uint8Array(buffer)));
}

function base64ToBuffer(b64) {
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer;
}

/**
 * Serializes a session payload to a .sau file's contents. If a password is
 * given, the payload is AES-256-GCM encrypted with a fresh random salt and
 * IV on every save; otherwise it is returned as plain JSON.
 *
 * @param {object} payloadObject - the session state to save.
 * @param {string} [password] - optional; if empty, the file is unencrypted.
 * @returns {Promise<string>} the exact string to write to the .sau file.
 */
async function serializeSauFile(payloadObject, password) {
    const payload = JSON.stringify(payloadObject);
    if (!password) return payload;

    const salt = window.crypto.getRandomValues(new Uint8Array(16));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);

    const enc = new TextEncoder();
    const ciphertext = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv }, key, enc.encode(payload)
    );

    return JSON.stringify({
        encrypted: true,
        salt: bufferToBase64(salt),
        iv: bufferToBase64(iv),
        ciphertext: bufferToBase64(ciphertext)
    });
}

/**
 * Parses a .sau file's contents back into the original session payload.
 * Decrypts first if the file is marked `encrypted: true`.
 *
 * @param {string} fileText - the raw contents of the .sau file.
 * @param {string} [password] - required only if the file is encrypted.
 * @returns {Promise<object>} the original payload object.
 */
async function parseSauFile(fileText, password) {
    let data = JSON.parse(fileText);
    if (!data.encrypted) return data;

    if (!password) throw new Error('Password required');

    const salt = base64ToBuffer(data.salt);
    const iv = base64ToBuffer(data.iv);
    const ciphertext = base64ToBuffer(data.ciphertext);
    const key = await deriveKey(password, salt);

    const decryptedBuffer = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv }, key, ciphertext
    );
    const dec = new TextDecoder();
    return JSON.parse(dec.decode(decryptedBuffer));
}

if (typeof module !== 'undefined') {
    module.exports = { deriveKey, serializeSauFile, parseSauFile };
}
