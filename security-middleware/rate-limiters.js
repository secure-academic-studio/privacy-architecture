'use strict';

// ============================================================================
// Rate Limiting — Tuned per Endpoint
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-2-4
// Last verified against production: 2026-07-23
//
// WHAT THIS DOES
// Every sensitive endpoint sits behind its own rate limiter, calibrated to
// the risk profile of that endpoint. The windows and thresholds below are
// the real production values.
//
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// In production each limiter is declared inline where it's used; here they
// are grouped into one exportable module for readability. The configuration
// values themselves are unchanged.
// ============================================================================

const rateLimit = require('express-rate-limit'); // npm: express-rate-limit

// General-purpose API endpoints (deduct-credits, extract-statement, etc.)
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 150,
    message: { error: 'Too many requests, please try again later.' }
});

// Wallet / credit-pack token operations (redeem, balance check, transfer)
const tokenLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30,
    message: { error: 'Too many attempts. Please wait.' }
});

// Anonymous feedback submission — deliberately the strictest, to deter spam.
const feedbackLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 5,
    message: { error: 'Feedback limit reached. Thank you for your input!' }
});

// Interview & Speech Transcriber: upload-URL issuance, job start, deletion.
const transcribeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 30,
    message: { error: 'Too many transcription requests. Please wait.' }
});

// Academic Proofreader: upload-URL issuance, job start, deletion.
const proofreadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 40,
    message: { error: 'Too many proofreading requests. Please wait.' }
});

// Job-status polling — permissive, since it's frequent and low-risk.
const statusLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 120,
    message: { error: 'Too many status requests. Please slow down.' }
});

module.exports = {
    apiLimiter,
    tokenLimiter,
    feedbackLimiter,
    transcribeLimiter,
    proofreadLimiter,
    statusLimiter
};
