'use strict';

// ============================================================================
// Client-Side Pixel Destruction + Audit Payload ZIP
// ============================================================================
// Substantiates: https://secureacademic.com/gdpr-architectural-background/#sec-4-1
//                https://secureacademic.com/gdpr-architectural-background/#sec-4-2
// Last verified against production: 2026-07-23
//
// WHAT THIS DOES
// Runs entirely in the browser. The user draws boxes over sensitive fields
// on a PDF rendered onto a <canvas>; this code burns those boxes directly
// into the canvas's pixels with `ctx.fillRect()`. This is not a CSS overlay
// or a separate visual layer — once flattened via `toDataURL()`, the
// original pixels underneath are gone from the resulting image. The
// original PDF (with its text layer and metadata) is never uploaded.
//
// The same flattening routine is also used to build a downloadable "Audit
// Payload" ZIP *before* extraction begins, containing exactly the images
// the AI will receive — so the user can verify what will be sent before
// anything is transmitted.
//
// WHAT'S DELIBERATELY DIFFERENT FROM PRODUCTION
// DOM/UI wiring (progress bars, button states, localized strings) has been
// removed; only the redaction-burning and ZIP-building logic remains. The
// WebP quality argument (0.85) matches production exactly.
// ============================================================================

/**
 * Renders one PDF page to a canvas and burns the given redaction masks
 * directly into its pixels. Masks are expressed as percentages of the
 * page's own width/height, so they scale correctly with the render
 * resolution.
 *
 * @param {object} pdfPage - a pdf.js page object.
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 * @param {{ pctX: number, pctY: number, pctW: number, pctH: number }[]} masks
 * @param {number} scale - render scale (production uses 1.6).
 * @returns {Promise<string>} base64 WebP data (without the data-URL prefix).
 */
async function renderAndRedactPage(pdfPage, canvas, ctx, masks, scale = 1.6) {
    const viewport = pdfPage.getViewport({ scale });
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    // Render the original page — this is the last point at which the
    // unredacted pixels exist anywhere.
    await pdfPage.render({ canvasContext: ctx, viewport }).promise;

    // Burn every mask into the canvas as solid black rectangles. There is
    // no code path anywhere that reattaches the pixels underneath — once
    // this runs, they are gone from this canvas.
    ctx.fillStyle = 'black';
    masks.forEach(mask => {
        ctx.fillRect(
            (mask.pctX / 100) * canvas.width,
            (mask.pctY / 100) * canvas.height,
            (mask.pctW / 100) * canvas.width,
            (mask.pctH / 100) * canvas.height
        );
    });

    // Flatten to a raster image. This is what leaves the browser — never
    // the original PDF, never a vector/text layer.
    return canvas.toDataURL('image/webp', 0.85).split(',')[1];
}

/**
 * Builds the downloadable "Audit Payload" ZIP: exactly the redacted, WebP
 * images that would be sent to the AI for extraction, so the user can
 * inspect them before anything is transmitted. Requires JSZip
 * (window.JSZip) to be loaded.
 *
 * @param {object} pdfDoc - a pdf.js document object.
 * @param {(pageNumber: number) => Array} getMasksForPage - returns the
 *        combined global + per-page masks for a given page number.
 * @param {HTMLCanvasElement} canvas
 * @param {CanvasRenderingContext2D} ctx
 */
async function buildAuditPayloadZip(pdfDoc, getMasksForPage, canvas, ctx) {
    const zip = new JSZip();
    for (let p = 1; p <= pdfDoc.numPages; p++) {
        const page = await pdfDoc.getPage(p);
        const base64Data = await renderAndRedactPage(page, canvas, ctx, getMasksForPage(p));
        zip.file(`redacted_page_${p}.webp`, base64Data, { base64: true });
    }
    return zip.generateAsync({ type: 'blob' });
}

/**
 * Rasterizes and redacts every page, ready for submission to the backend.
 * Mirrors buildAuditPayloadZip exactly — the images the user can preview
 * in the Audit ZIP are pixel-identical to what is actually submitted.
 */
async function buildRedactedImageBatch(pdfDoc, getMasksForPage, canvas, ctx) {
    const images = [];
    for (let p = 1; p <= pdfDoc.numPages; p++) {
        const page = await pdfDoc.getPage(p);
        const base64Data = await renderAndRedactPage(page, canvas, ctx, getMasksForPage(p));
        images.push(`data:image/webp;base64,${base64Data}`);
    }
    return images;
}

// Exported for reference/testing. In production, none of this ever leaves
// the browser as a module — it runs inline in the page's own script.
if (typeof module !== 'undefined') {
    module.exports = { renderAndRedactPage, buildAuditPayloadZip, buildRedactedImageBatch };
}
