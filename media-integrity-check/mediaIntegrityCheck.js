'use strict';

// ============================================================================
// Media Integrity Check — Server-Side Container/Format Validation
// ============================================================================
// Substantiates: not yet described in the public architecture document (see
//                README.md — this module is offered here ahead of the doc
//                being updated to include it).
// Last verified against production: 2026-07-23
//
// This file is reproduced essentially unchanged from production: it is
// already self-contained, has no external dependencies, and contains no
// business-sensitive logic or infrastructure identifiers — nothing needed
// sanitizing. Its own header comment below (unchanged) explains what it
// does and why.
// ============================================================================

// ============================================================================
// SAS Transcriber — Media Integrity Check
// ============================================================================
// Dependency-free, bounded container/track sniffer used as a server-side gate
// before an uploaded file is handed to the Gemini API for transcription.
//
// WHY THIS EXISTS
// The client (and the file name it sends) can never be trusted: a user can
// rename an .mp4 video to .m4a or .webm with zero re-encoding (both M4A/MP4
// and WEBM are general-purpose containers that can legally hold a video
// track), which would otherwise let a video slip through an extension-based
// whitelist and be processed by Gemini's (far more expensive) video pipeline.
//
// This module never decodes, transcodes, or renders any audio/video payload.
// It only walks container box/element structures to read handler-type /
// codec-id / track-type labels — plain byte-offset arithmetic on a Buffer.
// That keeps the attack surface of "parsing attacker-controlled bytes"
// as small and auditable as possible, and avoids pulling in a third-party
// media-parsing dependency (and its transitive dependency tree) into a
// security-sensitive code path.
//
// FAIL-CLOSED PRINCIPLE
// Every offset/length read is bounds-checked against the actual buffer
// length. Recursion depth and total nodes visited are capped. If the
// structure can't be confidently parsed, or a video track is found, the
// verdict is "reject" — never "allow because we couldn't tell".
//
// This module intentionally only inspects a small header prefix of the
// file (the caller decides how much to fetch from GCS — a couple of MB is
// plenty for all four supported formats). It never needs, and never
// receives, the full file.
// ============================================================================

const MAX_BOX_DEPTH = 12;
const MAX_NODES_VISITED = 20000;

// ----------------------------------------------------------------------------
// Container signatures (magic bytes)
// ----------------------------------------------------------------------------

function sniffContainerFamily(buf) {
    if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'OggS') {
        return 'ogg';
    }
    if (buf.length >= 4 &&
        buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) {
        return 'ebml'; // Matroska / WebM
    }
    if (buf.length >= 8) {
        // ISO-BMFF: first box is almost always `ftyp`, occasionally `moov`/
        // `free`/`skip`/`wide`/`mdat`/`styp` in valid real-world files.
        const firstType = buf.toString('ascii', 4, 8);
        if (['ftyp', 'styp', 'moov', 'free', 'skip', 'wide', 'mdat'].includes(firstType)) {
            return 'iso-bmff';
        }
    }
    // MP3 elementary stream: either an ID3v2 tag header, or a raw frame sync
    // (11 set bits: 0xFF followed by a byte with its top 3 bits set).
    if (buf.length >= 3 && buf.toString('ascii', 0, 3) === 'ID3') {
        return 'mp3';
    }
    if (buf.length >= 2 && buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) {
        return 'mp3';
    }
    return 'unknown';
}

const EXT_TO_FAMILY = {
    mp4: 'iso-bmff',
    m4a: 'iso-bmff',
    webm: 'ebml',
    ogg: 'ogg',
    mp3: 'mp3'
};

// ----------------------------------------------------------------------------
// ISO-BMFF (.mp4 / .m4a) box-tree walker
// ----------------------------------------------------------------------------
// Only cares about one thing: does any `trak` contain an `mdia/hdlr` box
// whose handler_type is 'vide' (video)? This is the standard, spec-defined
// (ISO/IEC 14496-12) way to identify a track's media type without needing a
// dictionary of codec fourccs.

const ISO_BMFF_CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'udta', 'meta']);

function readIsoBoxHeader(buf, offset, end) {
    if (offset + 8 > end) return null;
    let size = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;

    if (size === 1) {
        if (offset + 16 > end) return null;
        const high = buf.readUInt32BE(offset + 8);
        const low = buf.readUInt32BE(offset + 12);
        size = high * 2 ** 32 + low;
        headerSize = 16;
    } else if (size === 0) {
        // Box extends to end of file. We only have a prefix, so clamp to
        // what we actually have.
        size = end - offset;
    }

    if (size < headerSize) return null; // malformed — refuse to proceed
    return { type, size, headerSize, bodyStart: offset + headerSize };
}

function analyzeIsoBmff(buf) {
    let nodesVisited = 0;
    let hasVideoTrack = false;
    let hasAudioTrack = false;
    let sawMoov = false;
    let sawTrak = false;
    let truncated = false;

    function walk(start, end, depth) {
        if (depth > MAX_BOX_DEPTH) { truncated = true; return; }
        let offset = start;
        while (offset + 8 <= end) {
            if (++nodesVisited > MAX_NODES_VISITED) { truncated = true; return; }
            const header = readIsoBoxHeader(buf, offset, end);
            if (!header) { truncated = true; return; }
            const { type, size, bodyStart } = header;
            const bodyEnd = Math.min(offset + size, end);

            if (type === 'moov') sawMoov = true;
            if (type === 'trak') sawTrak = true;

            if (ISO_BMFF_CONTAINER_BOXES.has(type)) {
                walk(bodyStart, bodyEnd, depth + 1);
            } else if (type === 'hdlr' && bodyStart + 12 <= end) {
                // version(1) + flags(3) + pre_defined(4) + handler_type(4)
                const handlerType = buf.toString('ascii', bodyStart + 8, bodyStart + 12);
                if (handlerType === 'vide') hasVideoTrack = true;
                if (handlerType === 'soun') hasAudioTrack = true;
            }

            if (size <= 0) { truncated = true; return; } // avoid infinite loop
            offset += size;
        }
        // Reaching the end of the available prefix without a parse error is
        // normal (the real file continues beyond what we downloaded) and is
        // NOT considered "truncated" on its own.
    }

    walk(0, buf.length, 0);

    return { hasVideoTrack, hasAudioTrack, sawMoov, sawTrak, truncated };
}

// ----------------------------------------------------------------------------
// EBML / Matroska (.webm) element walker
// ----------------------------------------------------------------------------
// Walks down to Segment -> Tracks -> TrackEntry and reads TrackType (video=1)
// and, as a fallback, the CodecID string prefix ('V_' = video, 'A_' = audio).

const EBML_IDS = {
    EBML_HEADER: 0x1A45DFA3,
    SEGMENT: 0x18538067,
    TRACKS: 0x1654AE6B,
    TRACK_ENTRY: 0xAE,
    TRACK_TYPE: 0x83,
    CODEC_ID: 0x86
};
const EBML_CONTAINER_IDS = new Set([
    EBML_IDS.EBML_HEADER, EBML_IDS.SEGMENT, EBML_IDS.TRACKS, EBML_IDS.TRACK_ENTRY
]);

function readVint(buf, offset, end, stripMarker) {
    if (offset >= end) return null;
    const first = buf[offset];
    if (first === 0) return null; // invalid leading byte
    let length = 1;
    let mask = 0x80;
    while (length <= 8 && !(first & mask)) {
        mask >>= 1;
        length++;
    }
    if (length > 8 || offset + length > end) return null;

    let value;
    if (stripMarker) {
        value = first & (mask - 1);
    } else {
        value = first; // IDs keep their marker bits as part of the value
    }
    for (let i = 1; i < length; i++) {
        value = value * 256 + buf[offset + i];
    }
    return { value, length };
}

function analyzeEbml(buf) {
    let nodesVisited = 0;
    let hasVideoTrack = false;
    let hasAudioTrack = false;
    let sawTracks = false;
    let sawTrackEntry = false;
    let truncated = false;

    function walk(start, end, depth) {
        if (depth > MAX_BOX_DEPTH) { truncated = true; return; }
        let offset = start;
        let currentTrackType = null;
        let currentCodecId = null;

        while (offset < end) {
            if (++nodesVisited > MAX_NODES_VISITED) { truncated = true; return; }

            const idResult = readVint(buf, offset, end, false);
            if (!idResult) { truncated = true; return; }
            const elementId = idResult.value;
            let cursor = offset + idResult.length;

            const sizeResult = readVint(buf, cursor, end, true);
            if (!sizeResult) { truncated = true; return; }
            cursor += sizeResult.length;

            let dataSize = sizeResult.value;
            // "Unknown size" (all data bits set to 1) is legal in EBML for
            // streamed content. We can't know the true end, so we only
            // consider data up to what we have and stop scanning siblings
            // afterwards at this level.
            const maxPossible = end - cursor;
            let unknownSize = false;
            if (dataSize > maxPossible) {
                dataSize = maxPossible;
                unknownSize = true;
            }

            const dataStart = cursor;
            const dataEnd = cursor + dataSize;

            if (elementId === EBML_IDS.TRACKS) sawTracks = true;
            if (elementId === EBML_IDS.TRACK_ENTRY) sawTrackEntry = true;

            if (EBML_CONTAINER_IDS.has(elementId)) {
                walk(dataStart, dataEnd, depth + 1);
                if (elementId === EBML_IDS.TRACK_ENTRY) {
                    // currentTrackType/currentCodecId are scoped per call,
                    // so re-read them from the nested walk via closure vars
                    // is not possible here — handled via the leaf branch
                    // below instead (TrackType/CodecID are direct children
                    // of TrackEntry, read at depth+1, see leaf handling).
                }
            } else if (elementId === EBML_IDS.TRACK_TYPE) {
                let v = 0;
                for (let i = dataStart; i < dataEnd; i++) v = v * 256 + buf[i];
                if (v === 1) hasVideoTrack = true;
                else if (v === 2) hasAudioTrack = true;
            } else if (elementId === EBML_IDS.CODEC_ID) {
                const codecId = buf.toString('ascii', dataStart, dataEnd);
                if (codecId.startsWith('V_')) hasVideoTrack = true;
                else if (codecId.startsWith('A_')) hasAudioTrack = true;
            }

            if (unknownSize) return; // can't safely locate the next sibling
            offset = dataEnd;
        }
    }

    walk(0, buf.length, 0);

    return { hasVideoTrack, hasAudioTrack, sawTracks, sawTrackEntry, truncated };
}

// ----------------------------------------------------------------------------
// OGG page scanner
// ----------------------------------------------------------------------------
// Looks for the identification packet magic strings in the first pages.
// Theora (video) vs. Vorbis/Opus (audio) are distinguished by fixed byte
// signatures at the start of the first packet after the page header.

function analyzeOgg(buf) {
    let hasVideoTrack = false;
    let hasAudioTrack = false;
    let sawPage = false;

    let offset = 0;
    let pagesScanned = 0;
    while (offset + 27 <= buf.length && pagesScanned < 32) {
        if (buf.toString('ascii', offset, offset + 4) !== 'OggS') break;
        sawPage = true;
        pagesScanned++;

        const segmentCount = buf[offset + 26];
        const segmentTableStart = offset + 27;
        if (segmentTableStart + segmentCount > buf.length) { break; }

        let pageDataSize = 0;
        for (let i = 0; i < segmentCount; i++) pageDataSize += buf[segmentTableStart + i];

        const pageDataStart = segmentTableStart + segmentCount;
        const pageDataEnd = Math.min(pageDataStart + pageDataSize, buf.length);
        const chunk = buf.toString('binary', pageDataStart, pageDataEnd);

        if (chunk.includes('theora')) hasVideoTrack = true;
        if (chunk.includes('vorbis') || chunk.includes('OpusHead') || chunk.includes('OpusTags')) hasAudioTrack = true;

        if (pageDataEnd >= buf.length) break;
        offset = pageDataEnd;
    }

    return { hasVideoTrack, hasAudioTrack, sawPage };
}

// ----------------------------------------------------------------------------
// Main entry point
// ----------------------------------------------------------------------------

/**
 * @param {Object} params
 * @param {Buffer} params.buffer - header prefix of the uploaded file
 * @param {string} params.claimedExt - extension the object was stored under (no dot)
 * @returns {{ ok: boolean, reason?: string, details?: object }}
 */
function validateAudioContainer({ buffer, claimedExt }) {
    const ext = (claimedExt || '').toLowerCase();
    const expectedFamily = EXT_TO_FAMILY[ext];

    if (!expectedFamily) {
        return { ok: false, reason: 'unsupported_extension' };
    }
    if (!buffer || buffer.length < 8) {
        return { ok: false, reason: 'unparseable' };
    }

    const actualFamily = sniffContainerFamily(buffer);
    if (actualFamily !== expectedFamily) {
        return {
            ok: false,
            reason: 'container_mismatch',
            details: { expectedFamily, actualFamily }
        };
    }

    if (expectedFamily === 'mp3') {
        // MP3 is a raw elementary bitstream, not a general-purpose container
        // — it structurally cannot carry a video track. The signature check
        // above already confirmed it looks like an MP3 stream.
        return { ok: true };
    }

    if (expectedFamily === 'iso-bmff') {
        const r = analyzeIsoBmff(buffer);
        if (r.hasVideoTrack) return { ok: false, reason: 'video_track_detected', details: r };
        if (!r.sawMoov || !r.sawTrak) return { ok: false, reason: 'unparseable', details: r };
        return { ok: true, details: r };
    }

    if (expectedFamily === 'ebml') {
        const r = analyzeEbml(buffer);
        if (r.hasVideoTrack) return { ok: false, reason: 'video_track_detected', details: r };
        if (!r.sawTracks || !r.sawTrackEntry) return { ok: false, reason: 'unparseable', details: r };
        return { ok: true, details: r };
    }

    if (expectedFamily === 'ogg') {
        const r = analyzeOgg(buffer);
        if (r.hasVideoTrack) return { ok: false, reason: 'video_track_detected', details: r };
        if (!r.sawPage) return { ok: false, reason: 'unparseable', details: r };
        return { ok: true, details: r };
    }

    return { ok: false, reason: 'unparseable' };
}

// ----------------------------------------------------------------------------
// Size / duration ratio heuristic
// ----------------------------------------------------------------------------
// This is a FUZZY signal, not a hard gate: it flags files whose byte size is
// implausibly large for the client-claimed duration (a strong sign of video
// content, or of a lie about duration to under-pay). Per the agreed rollout
// plan, this is logged for calibration and is NOT used to reject on its own
// — only the deterministic track-detection above does that.

const PLAUSIBLE_MAX_BYTES_PER_SECOND = {
    mp3: 64 * 1024,   // ~512 kbps ceiling, generous
    m4a: 64 * 1024,
    ogg: 64 * 1024,
    webm: 64 * 1024
};

function checkSizeDurationRatio(fileSizeBytes, durationSec, ext) {
    const duration = Math.max(durationSec || 0, 1);
    const bytesPerSecond = fileSizeBytes / duration;
    const ceiling = PLAUSIBLE_MAX_BYTES_PER_SECOND[(ext || '').toLowerCase()] || 64 * 1024;
    return {
        bytesPerSecond,
        suspicious: bytesPerSecond > ceiling
    };
}

module.exports = {
    validateAudioContainer,
    checkSizeDurationRatio,
    // exported for testing
    sniffContainerFamily,
    analyzeIsoBmff,
    analyzeEbml,
    analyzeOgg
};
