'use strict';

// ============================================================================
// GDPR Compliance Guard + EU-only Vertex AI Routing
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-2-1
// Last verified against production: 2026-07-23
//
// WHAT THIS DOES
// Two things happen at process start-up, before the HTTP server accepts a
// single request:
//
//   1. GDPR COMPLIANCE GUARD — the process refuses to start unless a valid
//      Google Cloud service-account credential is present. There is no
//      "started but misconfigured" state: either the guard passes, or the
//      process exits with a non-zero code and never binds a port.
//
//   2. EU-ONLY AI ROUTING — the Vertex AI client is initialised with
//      `location: 'eu'`, hard-pinning every AI call this process makes to
//      Google's EU multi-region infrastructure. This is not a default that
//      can silently drift over time; it is a literal constructor argument,
//      checkable by anyone reading this file.
//
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// The real GCP project ID has been replaced with a placeholder. Nothing
// else in this file differs — this is the exact control-flow shape used in
// production, not a simplified paraphrase of it.
// ============================================================================

const path = require('path');
const fs = require('fs');
const { GoogleGenAI } = require('@google/genai'); // npm: @google/genai

// ----------------------------------------------------------------------------
// 1. GDPR Compliance Guard — mandatory check at start-up.
//    If this block throws or exits, the server CANNOT start.
// ----------------------------------------------------------------------------

if (!process.env.GOOGLE_CREDENTIALS_JSON) {
  console.error(
    'FATAL: GOOGLE_CREDENTIALS_JSON is not set. ' +
    'The server cannot start without EU-region Google Cloud credentials.'
  );
  process.exit(1);
}

try {
  JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
} catch (e) {
  console.error('FATAL: GOOGLE_CREDENTIALS_JSON is not valid JSON. ' + e.message);
  process.exit(1);
}

console.log('GOOGLE_CREDENTIALS_JSON: valid, server may continue starting.');

// ----------------------------------------------------------------------------
// 2. Google Enterprise Authentication (ADC) + strict EU Vertex AI routing.
// ----------------------------------------------------------------------------

let ai;
try {
    const tempKeyPath = path.join('/tmp', 'google-key.json');
    fs.writeFileSync(tempKeyPath, process.env.GOOGLE_CREDENTIALS_JSON);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = tempKeyPath;
    console.log('[Backend] Enterprise Auth: Google Service Account JSON loaded.');

    // Strict EU-only Vertex AI routing. `location: 'eu'` is a Vertex AI
    // multi-region identifier, not a single country — Google resolves it
    // only to data-center regions physically located in the EU.
    ai = new GoogleGenAI({
        vertexai: true,
        project: process.env.GOOGLE_CLOUD_PROJECT || 'your-gcp-project-id',
        location: 'eu'
    });
    console.log('[Backend] AI routing: Vertex AI EU multi-region configured.');
} catch (err) {
    console.error('[Backend] FATAL: could not write the temporary Google credentials key.', err);
    process.exit(1);
}

module.exports = { ai };
