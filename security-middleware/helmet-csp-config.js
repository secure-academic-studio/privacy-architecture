'use strict';

// ============================================================================
// Defence Middleware: Helmet, CSP, and Attack-Pattern Filtering
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-2-3
// Last verified against production: 2026-07-23
//
// WHAT THIS DOES
// A whitelist-based Content Security Policy (defaultSrc: 'none' — everything
// is blocked unless explicitly allowed), plus three small, dependency-free
// middlewares: a scraper block-list, a minimal URL-level attack-pattern
// filter, and a Permissions-Policy header (which Helmet v7 does not set
// natively). CORS is origin-restricted via an environment variable rather
// than hardcoded.
//
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// Nothing of substance. This is the real directive set, the real bot list,
// and the real attack-pattern regexes.
// ============================================================================

const helmet = require('helmet');   // npm: helmet
const cors = require('cors');       // npm: cors

function applySecurityMiddleware(app) {

    // --------------------------------------------------------------------
    // 1. Helmet: strict, whitelist-based Content Security Policy.
    // --------------------------------------------------------------------
    app.use(helmet({
        xssFilter: false,
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'none'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'"],
                imgSrc: ["'self'", "data:", "blob:"],
                mediaSrc: ["'self'"],
                connectSrc: ["'self'", "blob:", "https://storage.googleapis.com"], // required for the Signed URL flow
                workerSrc: ["'self'", "blob:"],
                fontSrc: ["'self'"],
                manifestSrc: ["'self'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
                objectSrc: ["'none'"],
                frameAncestors: ["'none'"],
                upgradeInsecureRequests: [],
            }
        },
        hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
        referrerPolicy: { policy: 'no-referrer' },
        frameguard: { action: 'deny' }
    }));

    // --------------------------------------------------------------------
    // 2. Block AI scrapers that ignore robots.txt.
    // --------------------------------------------------------------------
    const blockedBots = [
        'Bytespider',         // ByteDance / Doubao
        'Meta-ExternalAgent', // Meta AI
        'DeepSeekBot',        // DeepSeek
        'Amazonbot'           // Amazon AI
    ];

    app.use((req, res, next) => {
        const userAgent = req.headers['user-agent'] || '';
        const isBlocked = blockedBots.some(bot =>
            userAgent.toLowerCase().includes(bot.toLowerCase())
        );
        if (isBlocked) return res.status(403).end();
        next();
    });

    // --------------------------------------------------------------------
    // 3. Minimal URL-level attack-pattern filter (does not inspect the
    //    request body — this is a cheap first line of defence, not a WAF).
    // --------------------------------------------------------------------
    const attackPatterns = [
        /(\.\.\/|\.\.%2f|%2e%2e%2f)/i,                    // path traversal
        /(union[\s+]+select|select[\s+]+.*[\s+]+from)/i,  // SQL injection
        /(<script|%3cscript|javascript:)/i,               // XSS in the URL
        /(\/etc\/passwd|\/bin\/bash|cmd\.exe)/i,          // system file access
        /(\bexec\b.*\bxp_|\bsp_password\b)/i              // MSSQL patterns
    ];

    app.use((req, res, next) => {
        let target;
        try {
            target = decodeURIComponent(req.originalUrl || '').toLowerCase();
        } catch (e) {
            return res.status(403).end(); // malformed URL encoding = treat as suspicious
        }
        const isAttack = attackPatterns.some(pattern => pattern.test(target));
        if (isAttack) return res.status(403).end();
        next();
    });

    // --------------------------------------------------------------------
    // 4. Permissions-Policy header (not natively supported by Helmet v7).
    // --------------------------------------------------------------------
    app.use((req, res, next) => {
        res.setHeader('Permissions-Policy',
            'camera=(), microphone=(), geolocation=(), payment=(), usb=(), fullscreen=(self)');
        next();
    });

    // --------------------------------------------------------------------
    // 5. CORS — origin comes from the environment, never hardcoded.
    // --------------------------------------------------------------------
    const corsOptions = {
        origin: process.env.ALLOWED_ORIGIN || false,
        methods: ['GET', 'POST'],
        allowedHeaders: ['Content-Type', 'Authorization', 'Creem-Signature']
    };
    app.use(cors(corsOptions));
}

module.exports = { applySecurityMiddleware };
