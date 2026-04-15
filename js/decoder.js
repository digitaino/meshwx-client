/**
 * MeshWX Protocol Decoder — JavaScript port of MeshWXDecoder.swift.
 * Decodes COBS-encoded binary weather messages from MeshCore channel data.
 */

import { cobsDecode } from './cobs.js';

// ============================================================================
// Lookup Tables
// ============================================================================

const VTEC_PHENOMENA = [
    ["AF","Ashfall"],["AS","Air Stagnation"],["BH","Beach Hazard"],["BS","Blowing Snow"],
    ["BW","Brisk Wind"],["BZ","Blizzard"],["CF","Coastal Flood"],["DF","Debris Flow"],
    ["DS","Dust Storm"],["DU","Blowing Dust"],["EC","Extreme Cold"],["EH","Excessive Heat"],
    ["EW","Extreme Wind"],["FA","Areal Flood"],["FF","Flash Flood"],["FG","Dense Fog"],
    ["FL","Flood"],["FR","Frost"],["FW","Fire Weather"],["FZ","Freeze"],
    ["GL","Gale"],["HF","Hurricane Force Wind"],["HT","Heat"],["HU","Hurricane"],
    ["HW","High Wind"],["HY","Hydrologic"],["HZ","Hard Freeze"],["IP","Sleet"],
    ["IS","Ice Storm"],["LE","Lake Effect Snow"],["LO","Low Water"],["LS","Lakeshore Flood"],
    ["LW","Lake Wind"],["MA","Marine"],["MF","Marine Dense Fog"],["MH","Marine Dense Smoke"],
    ["MS","Marine Dense Smoke"],["RB","Small Craft Rough Bar"],["RH","Radiological Hazard"],
    ["RP","Rip Current"],["SC","Small Craft"],["SE","Hazardous Seas"],["SI","Small Craft Winds"],
    ["SM","Dense Smoke"],["SQ","Snow Squall"],["SR","Storm"],["SS","Storm Surge"],
    ["SU","High Surf"],["SV","Severe Thunderstorm"],["SW","Hazardous Seas"],
    ["TI","Inland Tropical Storm Wind"],["TO","Tornado"],["TR","Tropical Storm"],
    ["TS","Tsunami"],["TY","Typhoon"],["UP","Heavy Freezing Spray"],["VO","Volcano"],
    ["WC","Wind Chill"],["WI","Wind"],["WS","Winter Storm"],["WW","Winter Weather"],
    ["XH","Extreme Heat"],["ZF","Freezing Fog"],["ZR","Freezing Rain"],["ZY","Freezing Spray"],
];

const V2_TYPE_TO_PHENOM = {
    0x1: 0x33, 0x2: 0x30, 0x3: 0x0E, 0x4: 0x10,
    0x5: 0x3B, 0x6: 0x18, 0x7: 0x12, 0x8: 0x21, 0x9: 0x00,
};

const V2_SEV_TO_SIGNIFICANCE = {
    0x1: 0x2, 0x2: 0x1, 0x3: 0x0, 0x4: 0x0,
};

const SIGNIFICANCE_NAMES = {
    0x0: "Warning", 0x1: "Watch", 0x2: "Advisory", 0x3: "Statement",
    0x4: "Forecast", 0x5: "Outlook", 0x6: "Synopsis",
};

const WIND_DIRS = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];

const SKY_CONDITIONS = [
    "Clear","Mostly Clear","Partly Cloudy","Mostly Cloudy","Overcast",
    "Fair","Few Clouds","Scattered Clouds","Broken Clouds",
    "Fog","Haze","Smoke","Dust","Thunderstorms","Rain","Snow",
];

// Reflectivity color palette (index 0-14)
export const RADAR_COLORS = [
    [0,0,0,0],           // 0x0: transparent
    [0,236,224,255],     // 0x1
    [1,160,246,255],     // 0x2
    [0,0,246,255],       // 0x3
    [0,255,0,255],       // 0x4
    [0,200,0,255],       // 0x5
    [0,144,0,255],       // 0x6
    [255,255,0,255],     // 0x7
    [231,192,0,255],     // 0x8
    [255,144,0,255],     // 0x9
    [255,0,0,255],       // 0xA
    [214,0,0,255],       // 0xB
    [192,0,0,255],       // 0xC
    [255,0,255,255],     // 0xD
    [153,85,201,255],    // 0xE
];

// Hardcoded radar regions (matches regions.json)
export const REGIONS = {
    0x0: { id: 0x0, name: "Northeast",     north: 48,   south: 37, west: -82,  east: -67,  scaleKm: 55 },
    0x1: { id: 0x1, name: "Southeast",     north: 37,   south: 24, west: -92,  east: -75,  scaleKm: 55 },
    0x2: { id: 0x2, name: "Upper Midwest", north: 50,   south: 40, west: -98,  east: -82,  scaleKm: 55 },
    0x3: { id: 0x3, name: "Southern",      north: 37,   south: 25, west: -105, east: -88,  scaleKm: 55 },
    0x4: { id: 0x4, name: "Central",       north: 44,   south: 34, west: -105, east: -90,  scaleKm: 55 },
    0x5: { id: 0x5, name: "Mountain",      north: 49,   south: 31, west: -117, east: -102, scaleKm: 55 },
    0x6: { id: 0x6, name: "Pacific",       north: 49,   south: 32, west: -125, east: -114, scaleKm: 40 },
    0x7: { id: 0x7, name: "Alaska",        north: 72,   south: 51, west: -180, east: -130, scaleKm: 175 },
    0x8: { id: 0x8, name: "Hawaii",        north: 23,   south: 18, west: -161, east: -154, scaleKm: 28 },
    0x9: { id: 0x9, name: "Puerto Rico",   north: 19.5, south: 17, west: -68,  east: -65,  scaleKm: 12 },
};

// ============================================================================
// Internal State
// ============================================================================

// Multi-chunk radar buffer: key = (regionID << 32 | timestamp)
const radarChunkBuffer = new Map();

// FEC group buffer: key = (msgType << 8 | groupID)
// Each entry has a createdAt timestamp for stale eviction.
const fecGroups = new Map();
const FEC_GROUP_TTL_MS = 120_000; // 2 minutes

// ============================================================================
// Public API
// ============================================================================

/**
 * Decode a COBS-encoded MeshWX message.
 * @param {Uint8Array} data - Raw COBS-encoded bytes from channel
 * @returns {object|null} Decoded message object with `type` field, or null
 */
export function decode(data) {
    if (!data || data.length === 0) return null;
    const decoded = cobsDecode(data);
    if (!decoded) return null;
    return decodeRaw(decoded);
}

/**
 * Get phenomena name from index.
 */
export function phenomenaName(index) {
    if (index < VTEC_PHENOMENA.length) return VTEC_PHENOMENA[index][1];
    return "Weather";
}

/**
 * Get significance name.
 */
export function significanceName(sig) {
    return SIGNIFICANCE_NAMES[sig] || "Alert";
}

/**
 * Get warning display title.
 */
export function warningTitle(warning) {
    return `${phenomenaName(warning.phenomenaIndex)} ${significanceName(warning.vtecSignificance)}`;
}

/**
 * Get wind direction name from 4-bit code.
 */
export function windDirName(code) {
    return WIND_DIRS[code & 0x0F] || "VAR";
}

/**
 * Get sky condition name from code.
 */
export function skyConditionName(code) {
    return SKY_CONDITIONS[code] || "Unknown";
}

/**
 * Format pressure from raw byte: (inHg - 29.00) * 100
 */
export function formatPressure(raw) {
    return (29.00 + raw / 100).toFixed(2);
}

// ============================================================================
// Dispatch
// ============================================================================

function decodeRaw(data) {
    if (data.length === 0) return null;
    switch (data[0]) {
        case 0x04: return decodeV4Frame(data);
        case 0x03: return decodeNotAvailable(data);
        case 0x11: return decode0x11RadarGrid(data);
        case 0x12: return decode0x11RadarGrid(data); // QPF uses same format
        case 0x20: return decodeWarning(data);
        case 0x21: return decodeWarningZones(data);
        case 0x30: return decodeObservation(data);
        case 0x31: return decodeForecast(data);
        case 0x32: return decodeOutlook(data);
        case 0x33: return decodeStormReports(data);
        case 0x34: return decodeRainObservations(data);
        case 0x36: return decodeTAF(data);
        case 0x37: return decodeWarningsNear(data);
        case 0x38: return decodeFireWeather(data);
        case 0x3A: return decodeDailyClimate(data);
        case 0x3C: return decodeNowcast(data);
        case 0x40: return decodeTextChunk(data);
        case 0xF0: return decodeBeacon(data);
        default:   return null;
    }
}

// ============================================================================
// Helpers
// ============================================================================

function readInt24(data, offset) {
    const raw = (data[offset] << 16) | (data[offset + 1] << 8) | data[offset + 2];
    return raw & 0x800000 ? raw | 0xFF000000 : raw;
}

function readUint32BE(data, offset) {
    return ((data[offset] << 24) | (data[offset+1] << 16) | (data[offset+2] << 8) | data[offset+3]) >>> 0;
}

function readUint16BE(data, offset) {
    return (data[offset] << 8) | data[offset + 1];
}

function readUint16LE(data, offset) {
    return data[offset] | (data[offset + 1] << 8);
}

function readInt8(data, offset) {
    const v = data[offset];
    return v > 127 ? v - 256 : v;
}

function readInt16BE(data, offset) {
    const v = (data[offset] << 8) | data[offset + 1];
    return v > 32767 ? v - 65536 : v;
}

function utf8Decode(data, start, end) {
    if (start >= end) return "";
    try {
        return new TextDecoder().decode(data.slice(start, end)).replace(/\0/g, "").trim();
    } catch { return ""; }
}

function locationIDLength(locationType) {
    switch (locationType) {
        case 1: return 3;   // zone: state_idx(1) + zone_num(2)
        case 2: return 4;   // station: ICAO 4 ASCII
        case 3: return 3;   // place: uint24 index
        case 4: return 8;   // latlon: int32 lat + int32 lon
        case 5: return 2;   // wfo: 2-byte index
        case 6: return 3;   // pfm_point: uint24 index
        default: return 3;
    }
}

function parseLocationID(locationType, data, offset, length) {
    if (locationType === 2) {
        // ICAO station code
        return utf8Decode(data, offset, offset + length);
    }
    if (locationType === 6 || locationType === 3) {
        // uint24 index
        return (data[offset] << 16) | (data[offset+1] << 8) | data[offset+2];
    }
    if (locationType === 1) {
        // zone: state_idx + zone_num
        return { stateIdx: data[offset], zoneNum: readUint16BE(data, offset + 1) };
    }
    // Raw bytes
    return Array.from(data.slice(offset, offset + length));
}

// ============================================================================
// 0x30 Observation
// ============================================================================

function decodeObservation(data) {
    if (data.length < 2 || data[0] !== 0x30) return null;
    const locType = data[1];
    const idLen = locationIDLength(locType);
    const obsStart = 2 + idLen;
    if (data.length < obsStart + 10) return null;

    const locationID = parseLocationID(locType, data, 2, idLen);
    const timestamp = readUint16LE(data, obsStart);
    const tempF = readInt8(data, obsStart + 2);
    const dewpointF = readInt8(data, obsStart + 3);
    const windSky = data[obsStart + 4];
    const windDir = (windSky >> 4) & 0x0F;
    const skyCode = windSky & 0x0F;
    const windSpeedKts = data[obsStart + 5];
    const windGustKts = data[obsStart + 6];
    const visibilityMi = data[obsStart + 7];
    const pressureRaw = data[obsStart + 8];
    const feelsLikeDelta = readInt8(data, obsStart + 9);

    return {
        type: "observation",
        locationType: locType,
        locationID,
        timestampMinutes: timestamp,
        tempF, dewpointF,
        windDir, skyCode,
        windSpeedKts, windGustKts,
        visibilityMi, pressureRaw,
        feelsLikeDelta,
        receivedAt: Date.now(),
    };
}

// ============================================================================
// 0x31 Forecast
// ============================================================================

function decodeForecast(data) {
    if (data.length < 5 || data[0] !== 0x31) return null;
    const locType = data[1];
    const idLen = locationIDLength(locType);
    const headerEnd = 2 + idLen;
    if (data.length < headerEnd + 2) return null;

    const locationID = parseLocationID(locType, data, 2, idLen);
    const issuedHoursAgo = data[headerEnd];
    const periodCount = data[headerEnd + 1];
    const periodsStart = headerEnd + 2;
    if (data.length < periodsStart + periodCount * 7) return null;

    const periods = [];
    for (let i = 0; i < periodCount; i++) {
        const off = periodsStart + i * 7;
        const highByte = readInt8(data, off + 1);
        const lowByte = readInt8(data, off + 2);
        const windByte = data[off + 5];
        periods.push({
            periodID: data[off],
            highF: highByte === 127 ? null : highByte,
            lowF: lowByte === 127 ? null : lowByte,
            skyCode: data[off + 3],
            precipPct: data[off + 4],
            windDir: (windByte >> 4) & 0x0F,
            windSpeedMph: (windByte & 0x0F) * 5,
            conditionFlags: data[off + 6],
        });
    }

    return {
        type: "forecast",
        locationType: locType,
        locationID,
        issuedHoursAgo,
        periods,
        receivedAt: Date.now(),
    };
}

// ============================================================================
// 0x36 TAF
// ============================================================================

function decodeTAF(data) {
    if (data.length < 15 || data[0] !== 0x36) return null;
    const icao = utf8Decode(data, 2, 6);
    const issuedHoursAgo = data[6];
    const validFromHour = data[7];
    const validToHour = data[8];
    const dirSpd = data[9];
    const windDirNibble = (dirSpd >> 4) & 0x0F;
    const windSpeed5kt = dirSpd & 0x0F;
    const windGustKt = data[10];
    const visibilityQSM = data[11];
    const ceiling100ft = data[12];
    const skyCode = data[13] & 0x0F;
    const weatherFlags = data[14];

    const DIR_NAMES = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
                       "S","SSW","SW","WSW","W","WNW","NW","NNW"];
    const SKY_NAMES = {0:"Clear",1:"Few",2:"Scattered",3:"Broken",4:"Overcast",
                       5:"Fog",8:"Rain",9:"Snow",0xA:"Thunderstorm"};

    const windSpeedKts = windSpeed5kt * 5;
    const visSM = visibilityQSM >= 64 ? "P6" : (visibilityQSM / 4).toFixed(visibilityQSM % 4 ? 2 : 0);
    const ceilingFt = ceiling100ft * 100;

    // Flight category
    const visNum = visibilityQSM / 4;
    let flightCat = "VFR";
    if (visNum < 1 || (ceiling100ft > 0 && ceilingFt < 500)) flightCat = "LIFR";
    else if (visNum < 3 || (ceiling100ft > 0 && ceilingFt < 1000)) flightCat = "IFR";
    else if (visNum <= 5 || (ceiling100ft > 0 && ceilingFt <= 3000)) flightCat = "MVFR";

    // Weather phenomena from flags
    const wx = [];
    if (weatherFlags & 0x04) wx.push("TS");
    if (weatherFlags & 0x01) wx.push((weatherFlags & 0x40 ? "+" : weatherFlags & 0x80 ? "-" : "") + "RA");
    if (weatherFlags & 0x02) wx.push("SN");
    if (weatherFlags & 0x08) wx.push("FZ");
    if (weatherFlags & 0x10) wx.push("BR/FG");
    if (weatherFlags & 0x20) wx.push("SH");

    return {
        type: "taf",
        icao,
        issuedHoursAgo,
        validFromHour, validToHour,
        windDirNibble, windSpeed5kt, windSpeedKts, windGustKt,
        windDirName: DIR_NAMES[windDirNibble % 16],
        windDirDeg: windDirNibble * 22.5,
        visibilityQSM, visibilitySM: visSM,
        ceiling100ft, ceilingFt,
        skyCode, skyName: SKY_NAMES[skyCode] || "Mixed",
        weatherFlags, weatherPhenomena: wx,
        flightCategory: flightCat,
        validPeriod: `${String(validFromHour).padStart(2,'0')}00Z–${String(validToHour).padStart(2,'0')}00Z`,
        receivedAt: Date.now(),
    };
}

// ============================================================================
// 0x11 Radar Grid (sparse + RLE)
// ============================================================================

function decode0x11RadarGrid(data) {
    if (data.length < 9) return null;
    const msgType = data[0]; // 0x11 or 0x12
    const regionID = (data[1] >> 4) & 0x0F;
    const chunkSeq = data[1] & 0x0F;
    const gridSize = data[2];
    const timestamp = readUint32BE(data, 3);
    const scaleKm = data[7];
    const encoding = (data[8] >> 4) & 0x0F;
    const totalChunks = Math.max(1, data[8] & 0x0F);

    if (gridSize !== 32 && gridSize !== 64) return null;
    const payload = data.slice(9);

    const hdr = Array.from(data.slice(0, Math.min(12, data.length))).map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log(`[Radar] regionID=${regionID} chunk=${chunkSeq}/${totalChunks} grid=${gridSize} enc=${encoding} payload=${payload.length}b | hdr: ${hdr}`);

    if (totalChunks === 1) {
        return decodeRadarPayload(msgType, regionID, chunkSeq, timestamp, scaleKm, gridSize, encoding, payload);
    }

    // Multi-chunk: buffer and try to decode with whatever we have.
    // The companion radio often drops messages during broadcast bursts,
    // so we may never receive all chunks. For sparse encoding (enc=0),
    // each 2-byte pair has an absolute grid position, so ANY subset of
    // chunks produces a valid (partial) grid. For RLE (enc=1), only
    // consecutive chunks starting from 0 can be decoded.
    const bufferKey = `${regionID}-${timestamp}`;
    let acc = radarChunkBuffer.get(bufferKey);
    if (!acc) {
        acc = { msgType, gridSize, timestamp, scaleKm, totalChunks, chunks: {} };
    }
    acc.chunks[chunkSeq] = { payload, encoding };
    radarChunkBuffer.set(bufferKey, acc);

    const have = Object.keys(acc.chunks).map(Number).sort();
    const haveCount = have.length;
    console.log(`[Radar] Buffer ${bufferKey}: have chunks [${have}] (${haveCount}) / need ${acc.totalChunks}`);

    if (haveCount >= acc.totalChunks) {
        // All chunks present — assemble and decode normally
        console.log(`[Radar] Buffer ${bufferKey}: COMPLETE`);
        radarChunkBuffer.delete(bufferKey);
        const parts = [];
        let assembleEnc = acc.chunks[0]?.encoding ?? encoding;
        for (let i = 0; i < acc.totalChunks; i++) {
            if (acc.chunks[i]) parts.push(acc.chunks[i].payload);
        }
        const assembled = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
        let off = 0;
        for (const part of parts) { assembled.set(part, off); off += part.length; }
        return decodeRadarPayload(msgType, regionID, 0, acc.timestamp, acc.scaleKm, acc.gridSize, assembleEnc, assembled);
    }

    // Not complete yet — partial decode from available chunks.
    // Sparse encoding is independently decodable (absolute positions).
    // RLE only from chunk 0. A later complete frame replaces any partial.
    const totalCells = gridSize * gridSize;
    const grid = new Uint8Array(totalCells);
    let decoded = false;
    for (const idx of have) {
        const chunk = acc.chunks[idx];
        if (chunk.encoding === 0) {
            let i = 0;
            while (i + 1 < chunk.payload.length) {
                const b0 = chunk.payload[i];
                const b1 = chunk.payload[i + 1];
                const pos = (b0 << 4) | (b1 >> 4);
                const val = b1 & 0x0F;
                if (pos < totalCells) grid[pos] = val;
                i += 2;
            }
            decoded = true;
        } else if (chunk.encoding === 1 && idx === 0) {
            let cellIndex = 0;
            for (let i = 0; i < chunk.payload.length; i++) {
                const run = ((chunk.payload[i] >> 4) & 0x0F) + 1;
                const value = chunk.payload[i] & 0x0F;
                for (let j = 0; j < run && cellIndex < totalCells; j++) {
                    grid[cellIndex++] = value;
                }
            }
            decoded = true;
        }
    }
    if (!decoded) return null;
    console.log(`[Radar] Buffer ${bufferKey}: partial decode from chunks [${have}]`);
    return {
        type: msgType === 0x12 ? "qpf" : "radar",
        regionID, frameSeq: 0, timestamp, scaleKm, gridSize, grid,
        region: REGIONS[regionID] || null,
        receivedAt: Date.now(),
    };
}

function decodeRadarPayload(msgType, regionID, frameSeq, timestamp, scaleKm, gridSize, encoding, payload) {
    const totalCells = gridSize * gridSize;
    const grid = new Uint8Array(totalCells);

    if (encoding === 0) {
        // Sparse: 2 bytes -> 12-bit position + 4-bit value
        let i = 0;
        while (i + 1 < payload.length) {
            const b0 = payload[i];
            const b1 = payload[i + 1];
            const pos = (b0 << 4) | (b1 >> 4);
            const val = b1 & 0x0F;
            if (pos < totalCells) grid[pos] = val;
            i += 2;
        }
    } else if (encoding === 1) {
        // RLE: high nibble = run-1, low nibble = value
        let cellIndex = 0;
        for (let i = 0; i < payload.length; i++) {
            const run = ((payload[i] >> 4) & 0x0F) + 1;
            const value = payload[i] & 0x0F;
            for (let j = 0; j < run && cellIndex < totalCells; j++) {
                grid[cellIndex++] = value;
            }
        }
    } else {
        return null;
    }

    return {
        type: msgType === 0x12 ? "qpf" : "radar",
        regionID, frameSeq, timestamp, scaleKm, gridSize, grid,
        region: REGIONS[regionID] || null,
        receivedAt: Date.now(),
    };
}

// ============================================================================
// 0x20 Warning Polygon
// ============================================================================

function decodeWarning(data) {
    if (data.length < 11 || data[0] !== 0x20) return null;
    if (isFullVTECFormat(data)) return decodeWarningFullVTEC(data);
    if (isMVPFormat(data)) return decodeWarningMVP(data);
    return decodeWarningV2(data);
}

function isFullVTECFormat(data) {
    return data.length >= 21 &&
        data[6] >= 0x41 && data[6] <= 0x5A &&
        data[7] >= 0x41 && data[7] <= 0x5A &&
        data[8] >= 0x41 && data[8] <= 0x5A;
}

function isMVPFormat(data) {
    if (data.length < 13) return false;
    const expiry = readUint32BE(data, 2);
    return expiry > 1_000_000;
}

function decodeWarningMVP(data) {
    if (data.length < 17) return null;
    const v2Type = (data[1] >> 4) & 0x0F;
    const v2Sev = data[1] & 0x0F;
    const expiry = readUint32BE(data, 2);
    const onset = readUint32BE(data, 6);
    const vertexCount = data[10];
    if (vertexCount < 1) return null;

    const lat0 = readInt24(data, 11) / 10000.0;
    const lng0 = readInt24(data, 14) / 10000.0;
    const vertices = [{ lat: lat0, lng: lng0 }];

    const deltaStart = 17;
    const available = Math.min(vertexCount - 1, Math.floor((data.length - deltaStart) / 4));
    for (let i = 0; i < available; i++) {
        const off = deltaStart + i * 4;
        const dLat = readInt16BE(data, off);
        const dLng = readInt16BE(data, off + 2);
        vertices.push({ lat: lat0 + dLat / 1000.0, lng: lng0 + dLng / 1000.0 });
    }

    const headlineStart = deltaStart + (vertexCount - 1) * 4;
    const headline = utf8Decode(data, headlineStart, data.length);

    return makeWarning(v2Type, v2Sev, expiry, onset, vertices, [], headline);
}

function decodeWarningV2(data) {
    if (data.length < 11) return null;
    const v2Type = (data[1] >> 4) & 0x0F;
    const v2Sev = data[1] & 0x0F;
    const relExpiry = readUint16BE(data, 2);
    const vertexCount = data[4];
    if (vertexCount < 1) return null;

    const lat0 = readInt24(data, 5) / 10000.0;
    const lng0 = readInt24(data, 8) / 10000.0;
    const vertices = [{ lat: lat0, lng: lng0 }];

    const deltaStart = 11;
    const available = Math.min(vertexCount - 1, Math.floor((data.length - deltaStart) / 2));
    for (let i = 0; i < available; i++) {
        const dLat = readInt8(data, deltaStart + i * 2);
        const dLng = readInt8(data, deltaStart + i * 2 + 1);
        vertices.push({ lat: lat0 + dLat * 0.01, lng: lng0 + dLng * 0.01 });
    }

    const headlineStart = deltaStart + (vertexCount - 1) * 2;
    const headline = utf8Decode(data, headlineStart, data.length);

    const nowMinutes = Math.floor(Date.now() / 60000);
    return makeWarning(v2Type, v2Sev, nowMinutes + relExpiry, 0, vertices, [], headline);
}

function decodeWarningFullVTEC(data) {
    if (data.length < 21) return null;
    const phenomenaIndex = data[1];
    const sevByte = data[2];
    const vtecSig = (sevByte >> 4) & 0x0F;
    const capSev = sevByte & 0x0F;
    const action = data[3];
    const etn = readUint16BE(data, 4);
    const office = utf8Decode(data, 6, 9);
    const urgCert = data[9];
    const urgency = (urgCert >> 4) & 0x0F;
    const certainty = urgCert & 0x0F;
    const expiry = readUint32BE(data, 10);
    const vertexCount = data[14];
    if (vertexCount < 1) return null;

    const lat0 = readInt24(data, 15) / 10000.0;
    const lng0 = readInt24(data, 18) / 10000.0;
    const vertices = [{ lat: lat0, lng: lng0 }];

    const deltaStart = 21;
    const available = Math.min(vertexCount - 1, Math.floor((data.length - deltaStart) / 4));
    for (let i = 0; i < available; i++) {
        const off = deltaStart + i * 4;
        const dLat = readInt16BE(data, off);
        const dLng = readInt16BE(data, off + 2);
        vertices.push({ lat: lat0 + dLat / 1000.0, lng: lng0 + dLng / 1000.0 });
    }

    const headlineStart = deltaStart + (vertexCount - 1) * 4;
    const headline = utf8Decode(data, headlineStart, data.length);

    return {
        type: "warning",
        phenomenaIndex, vtecSignificance: vtecSig, capSeverity: capSev,
        action, etn, office, urgency, certainty,
        expiryUnixMinutes: expiry, onsetUnixMinutes: 0,
        vertices, zones: [], headline,
        receivedAt: Date.now(),
    };
}

function makeWarning(v2Type, v2Sev, expiryUnixMinutes, onsetUnixMinutes, vertices, zones, headline) {
    const phenomenaIndex = V2_TYPE_TO_PHENOM[v2Type] ?? 0x00;
    const vtecSignificance = V2_SEV_TO_SIGNIFICANCE[v2Sev] ?? 0x02;
    const capSeverity = v2Sev >= 4 ? 4 : (v2Sev >= 3 ? 3 : (v2Sev >= 2 ? 2 : 1));

    return {
        type: "warning",
        phenomenaIndex, vtecSignificance, capSeverity,
        action: 0, etn: 0, office: "", urgency: 0, certainty: 0,
        expiryUnixMinutes, onsetUnixMinutes: onsetUnixMinutes || 0,
        vertices, zones, headline,
        receivedAt: Date.now(),
    };
}

// ============================================================================
// 0x21 Warning Zones
// ============================================================================

function decodeWarningZones(data) {
    if (data.length < 12 || data[0] !== 0x21) return null;
    const typeSev = data[1];
    const v2Type = (typeSev >> 4) & 0x0F;
    const v2Sev = typeSev & 0x0F;
    const expiresMin = readUint32BE(data, 2);
    const onsetMin = readUint32BE(data, 6);
    const zoneCount = data[10];
    const headlineOffset = 11 + zoneCount * 3;
    if (data.length < headlineOffset) return null;

    // Drop expired
    if (expiresMin * 60 < Date.now() / 1000) return null;

    const zones = [];
    for (let i = 0; i < zoneCount; i++) {
        const base = 11 + i * 3;
        if (base + 2 >= headlineOffset) break;
        zones.push({
            stateIdx: data[base],
            zoneNum: readUint16BE(data, base + 1),
        });
    }

    const headline = utf8Decode(data, headlineOffset, data.length);
    const phenomenaIndex = V2_TYPE_TO_PHENOM[v2Type] ?? 0x00;
    const vtecSignificance = V2_SEV_TO_SIGNIFICANCE[v2Sev] ?? 0x02;

    return {
        type: "warning",
        phenomenaIndex, vtecSignificance, capSeverity: v2Sev,
        action: 0, etn: 0, office: "", urgency: 0, certainty: 0,
        expiryUnixMinutes: expiresMin, onsetUnixMinutes: onsetMin,
        vertices: [], zones, headline,
        receivedAt: Date.now(),
    };
}

// ============================================================================
// 0x03 Not Available
// ============================================================================

function decodeNotAvailable(data) {
    if (data.length < 3 || data[0] !== 0x03) return null;
    const dataType = (data[1] >> 4) & 0x0F;
    const reason = data[1] & 0x0F;
    const locationType = data[2];
    const idLen = locationIDLength(locationType);
    if (data.length < 3 + idLen) return null;
    const locationID = parseLocationID(locationType, data, 3, idLen);

    const DATA_TYPE_NAMES = {
        0: "Unknown", 1: "Forecast", 2: "Outlook", 3: "Storm Reports",
        4: "Precipitation", 5: "Observation", 6: "TAF", 7: "Warnings Near",
    };
    const REASON_NAMES = {
        0: "Unknown", 1: "No data available", 2: "Location not found",
        3: "Temporarily unavailable",
    };

    return {
        type: "notAvailable",
        dataType,
        dataTypeName: DATA_TYPE_NAMES[dataType] || "Unknown",
        reason,
        reasonName: REASON_NAMES[reason] || "Unknown",
        locationType,
        locationID,
        receivedAt: Date.now(),
    };
}

// ============================================================================
// 0xF0 Beacon
// ============================================================================

function decodeBeacon(data) {
    if (data.length < 13 || data[0] !== 0xF0) return null;
    const protocolVersion = data[1];
    const botID = (data[2] << 16) | (data[3] << 8) | data[4];
    const flags = data[5];
    const coverageLat = readInt16BE(data, 6) / 100.0;
    const coverageLon = readInt16BE(data, 8) / 100.0;
    const coverageRadiusKm = data[10];
    const activeWarningsCount = data[11];
    const nameLen = data[12];
    if (data.length < 13 + nameLen || nameLen === 0) return null;
    const channelName = utf8Decode(data, 13, 13 + nameLen);
    if (!channelName) return null;

    // Derive display name: "aus-meshwx-v4" -> "AUS Weather Bot"
    let displayName = channelName;
    const match = channelName.match(/^([a-z]+)-meshwx/i);
    if (match) displayName = `${match[1].toUpperCase()} Weather Bot`;

    return {
        type: "beacon",
        botID, protocolVersion, flags,
        coverageLat, coverageLon, coverageRadiusKm,
        activeWarningsCount, channelName, displayName,
        isAcceptingRequests: (flags & 0x01) !== 0,
        hasRadar: (flags & 0x02) !== 0,
        hasWarnings: (flags & 0x04) !== 0,
        hasForecasts: (flags & 0x08) !== 0,
        hasFireWeather: (flags & 0x10) !== 0,
        hasNowcast: (flags & 0x20) !== 0,
        hasQPF: (flags & 0x40) !== 0,
        receivedAt: Date.now(),
    };
}

// ============================================================================
// 0x04 v4 Frame + FEC
// ============================================================================

function decodeV4Frame(data) {
    if (data.length <= 6) return null;
    const msgType = data[1];
    const msgFlags = data[2];
    const groupTotal = data[3];

    const isFECUnit = (msgFlags & 0x01) !== 0;
    const isParity = (msgFlags & 0x02) !== 0;
    const isBaseLayer = (msgFlags & 0x04) !== 0;
    const groupID = (msgFlags >> 3) & 0x03;
    const unitIndex = (msgFlags >> 5) & 0x07;

    const rawPayload = data.slice(6);

    // Debug: show region from payload for radar types
    let debugRegion = '';
    if ((msgType === 0x11 || msgType === 0x12) && rawPayload.length > 0) {
        debugRegion = ` region=${(rawPayload[0] >> 4) & 0x0F}`;
    }
    console.log(`[v4] type=0x${msgType.toString(16)} flags=0x${msgFlags.toString(16)} FEC=${isFECUnit} parity=${isParity} base=${isBaseLayer} group=${groupID} unit=${unitIndex}${debugRegion} payload=${rawPayload.length}b`);

    if (!isFECUnit) {
        // Non-FEC: reconstruct v3 and decode
        const v3 = new Uint8Array(1 + rawPayload.length);
        v3[0] = msgType;
        v3.set(rawPayload, 1);
        return decodeRaw(v3);
    }

    // FEC: buffer this unit
    const groupKey = (msgType << 8) | groupID;
    const existing = fecGroups.get(groupKey);
    const now = Date.now();

    // Base layer always arrives first — reset the group to avoid
    // mixing stale quadrants from a previous broadcast cycle.
    // Also evict groups older than 2 minutes as a safety net.
    let group;
    if (isBaseLayer || !existing || (now - existing.createdAt) > FEC_GROUP_TTL_MS) {
        group = { msgType, groupTotal, units: {}, parityPayload: null, createdAt: now };
    } else {
        group = existing;
    }

    if (isParity) {
        group.parityPayload = rawPayload;
    } else {
        group.units[unitIndex] = rawPayload;
    }
    fecGroups.set(groupKey, group);

    // Evict any other stale groups
    for (const [k, g] of fecGroups) {
        if (k !== groupKey && (now - g.createdAt) > FEC_GROUP_TTL_MS) {
            fecGroups.delete(k);
        }
    }

    // Try to complete
    const quadrantsComplete = group.units[1] && group.units[2] && group.units[3] && group.units[4];
    let completedGroup = null;

    if (quadrantsComplete) {
        fecGroups.delete(groupKey);
        completedGroup = group;
    } else if (canRecoverFEC(group)) {
        const recovered = recoverFECGroup(group);
        if (recovered) {
            fecGroups.delete(groupKey);
            completedGroup = recovered;
        }
    }

    if (completedGroup) {
        const composite = compositeRadarFECGroup(completedGroup);
        if (composite) return composite;
    }

    // Return base layer immediately for quick display
    if (isBaseLayer) {
        const v3 = new Uint8Array(1 + rawPayload.length);
        v3[0] = msgType;
        v3.set(rawPayload, 1);
        return decodeRaw(v3);
    }

    return null;
}

function canRecoverFEC(group) {
    if (!group.parityPayload) return false;
    let missing = 0;
    for (let idx = 1; idx <= 4; idx++) {
        if (!group.units[idx]) missing++;
    }
    return missing === 1;
}

function recoverFECGroup(group) {
    const parity = group.parityPayload;
    if (!parity || parity.length < 1) return null;
    const unitCount = parity[0];
    if (unitCount < 1 || parity.length < 1 + unitCount * 2) return null;

    const lengths = [];
    for (let i = 0; i < unitCount; i++) {
        lengths.push((parity[1 + i * 2] << 8) | parity[2 + i * 2]);
    }

    const xorStart = 1 + unitCount * 2;
    if (xorStart > parity.length) return null;
    const xorData = parity.slice(xorStart);

    // Find missing quadrant
    let missingIdx = null;
    for (let idx = 1; idx <= 4; idx++) {
        if (!group.units[idx]) { missingIdx = idx; break; }
    }
    if (missingIdx === null) return null;

    const parityIdx = missingIdx - 1;
    if (parityIdx >= lengths.length) return null;
    const targetLen = lengths[parityIdx];

    // Seed with XOR data
    const recovered = new Uint8Array(targetLen);
    for (let i = 0; i < targetLen && i < xorData.length; i++) {
        recovered[i] = xorData[i];
    }

    // XOR with all received quadrants
    for (let idx = 1; idx <= 4; idx++) {
        if (idx === missingIdx) continue;
        const raw = group.units[idx];
        if (!raw) continue;
        for (let i = 0; i < recovered.length; i++) {
            recovered[i] ^= i < raw.length ? raw[i] : 0;
        }
    }

    const updated = { ...group, units: { ...group.units } };
    updated.units[missingIdx] = recovered;
    return updated;
}

function compositeRadarFECGroup(group) {
    if (group.msgType !== 0x11 && group.msgType !== 0x12) return null;
    const nwRaw = group.units[1], neRaw = group.units[2];
    const swRaw = group.units[3], seRaw = group.units[4];
    if (!nwRaw || !neRaw || !swRaw || !seRaw) return null;

    function decodeFECQuadrant(raw) {
        if (raw.length < 8) return null;
        const regionID = (raw[0] >> 4) & 0x0F;
        const chunkSeq = raw[0] & 0x0F;
        const gridSize = raw[1];
        const timestamp = readUint32BE(raw, 2);
        const scaleKm = raw[6];
        const encoding = (raw[7] >> 4) & 0x0F;
        if (gridSize !== 32) return null;
        return decodeRadarPayload(group.msgType, regionID, chunkSeq, timestamp, scaleKm, gridSize, encoding, raw.slice(8));
    }

    const nw = decodeFECQuadrant(nwRaw);
    const ne = decodeFECQuadrant(neRaw);
    const sw = decodeFECQuadrant(swRaw);
    const se = decodeFECQuadrant(seRaw);
    if (!nw || !ne || !sw || !se || nw.gridSize !== 32) return null;

    const grid64 = new Uint8Array(64 * 64);
    function copyQuadrant(frame, rowOff, colOff) {
        for (let r = 0; r < 32; r++) {
            for (let c = 0; c < 32; c++) {
                grid64[(rowOff + r) * 64 + (colOff + c)] = frame.grid[r * 32 + c];
            }
        }
    }
    copyQuadrant(nw, 0, 0);
    copyQuadrant(ne, 0, 32);
    copyQuadrant(sw, 32, 0);
    copyQuadrant(se, 32, 32);

    return {
        type: group.msgType === 0x12 ? "qpf" : "radar",
        regionID: nw.regionID,
        frameSeq: nw.frameSeq,
        timestamp: nw.timestamp,
        scaleKm: nw.scaleKm,
        gridSize: 64,
        grid: grid64,
        region: REGIONS[nw.regionID] || null,
        receivedAt: Date.now(),
    };
}

// ============================================================================
// Request Builders
// ============================================================================

/**
 * Build a 0x02 forecast request for a PFM point index.
 */
export function buildForecastRequest(pfmPointIndex) {
    const data = new Uint8Array(8);
    data[0] = 0x02;
    data[1] = 0x10; // data_type=1 (FORECAST) << 4
    data[4] = 0x06; // LOC_PFM_POINT
    data[5] = (pfmPointIndex >> 16) & 0xFF;
    data[6] = (pfmPointIndex >> 8) & 0xFF;
    data[7] = pfmPointIndex & 0xFF;
    return data;
}

/**
 * Build a 0x02 METAR/observation request for a station ICAO code.
 */
export function buildMetarRequest(icao) {
    const data = new Uint8Array(9);
    data[0] = 0x02;
    data[1] = 0x50; // data_type=5 (METAR)
    data[4] = 0x02; // LOC_STATION
    const bytes = new TextEncoder().encode(icao.substring(0, 4));
    for (let i = 0; i < bytes.length; i++) data[5 + i] = bytes[i];
    return data;
}

/**
 * Build a 0x02 TAF request for a station ICAO code.
 */
export function buildTAFRequest(icao) {
    const data = new Uint8Array(9);
    data[0] = 0x02;
    data[1] = 0x60; // data_type=6 (TAF)
    data[4] = 0x02; // LOC_STATION
    const bytes = new TextEncoder().encode(icao.substring(0, 4));
    for (let i = 0; i < bytes.length; i++) data[5 + i] = bytes[i];
    return data;
}

/**
 * Build a 0x02 outlook request for a PFM point index.
 */
export function buildOutlookRequest(pfmPointIndex) {
    const data = new Uint8Array(8);
    data[0] = 0x02;
    data[1] = 0x20; // data_type=2 (OUTLOOK)
    data[4] = 0x06; // LOC_PFM_POINT
    data[5] = (pfmPointIndex >> 16) & 0xFF;
    data[6] = (pfmPointIndex >> 8) & 0xFF;
    data[7] = pfmPointIndex & 0xFF;
    return data;
}

/**
 * Build a 0x02 storm reports request for a PFM point index.
 */
export function buildStormReportsRequest(pfmPointIndex) {
    const data = new Uint8Array(8);
    data[0] = 0x02;
    data[1] = 0x30; // data_type=3 (STORM_REPORTS)
    data[4] = 0x06; // LOC_PFM_POINT
    data[5] = (pfmPointIndex >> 16) & 0xFF;
    data[6] = (pfmPointIndex >> 8) & 0xFF;
    data[7] = pfmPointIndex & 0xFF;
    return data;
}

/**
 * Build a 0x02 rain observations request for a PFM point index.
 */
export function buildRainObsRequest(pfmPointIndex) {
    const data = new Uint8Array(8);
    data[0] = 0x02;
    data[1] = 0x40; // data_type=4 (PRECIPITATION)
    data[4] = 0x06; // LOC_PFM_POINT
    data[5] = (pfmPointIndex >> 16) & 0xFF;
    data[6] = (pfmPointIndex >> 8) & 0xFF;
    data[7] = pfmPointIndex & 0xFF;
    return data;
}

/**
 * Build a 0x02 warnings near request for a zone.
 */
export function buildWarningsNearRequest(stateIdx, zoneNum) {
    const data = new Uint8Array(8);
    data[0] = 0x02;
    data[1] = 0x70; // data_type=7 (WARNINGS_NEAR)
    data[4] = 0x01; // LOC_ZONE
    data[5] = stateIdx;
    data[6] = (zoneNum >> 8) & 0xFF;
    data[7] = zoneNum & 0xFF;
    return data;
}

// ============================================================================
// 0x32 Outlook (Hazardous Weather Outlook)
// ============================================================================

const HAZARD_TYPE_NAMES = [
    "Thunderstorm", "Flooding", "Winter Weather", "Fire Weather",
    "Excessive Heat", "Extreme Cold", "High Wind", "Coastal Hazard",
];

const RISK_LEVEL_NAMES = [
    "None", "Marginal", "Slight", "Enhanced", "Moderate", "High", "Extreme",
];

export function hazardTypeName(code) {
    return HAZARD_TYPE_NAMES[code] || "Hazard";
}

export function riskLevelName(code) {
    return RISK_LEVEL_NAMES[code] || "Unknown";
}

function decodeOutlook(data) {
    if (data.length < 2 || data[0] !== 0x32) return null;
    const locType = data[1];
    const idLen = locationIDLength(locType);
    const headerEnd = 2 + idLen;
    if (data.length < headerEnd + 3) return null;

    const locationID = parseLocationID(locType, data, 2, idLen);
    const issuedTimeMinutes = readUint16LE(data, headerEnd);
    const dayCount = data[headerEnd + 2];

    const days = [];
    let off = headerEnd + 3;
    for (let d = 0; d < dayCount; d++) {
        if (off + 1 >= data.length) break;
        const dayOffset = data[off];
        const hazardCount = data[off + 1];
        off += 2;
        const hazards = [];
        for (let h = 0; h < hazardCount; h++) {
            if (off + 1 >= data.length) break;
            hazards.push({ hazardType: data[off], riskLevel: data[off + 1] });
            off += 2;
        }
        days.push({ dayOffset, hazards });
    }

    return {
        type: "outlook",
        locationType: locType,
        locationID,
        issuedTimeMinutes,
        days,
        receivedAt: Date.now(),
    };
}

// ============================================================================
// 0x33 Storm Reports (LSR)
// ============================================================================

const EVENT_TYPE_NAMES = [
    "Tornado", "Funnel Cloud", "Waterspout", "Hail", "Damaging Wind",
    "Flash Flood", "Heavy Rain", "Winter Storm", "Ice Storm", "High Wind",
    "Dense Fog", "Wildfire", "Dust Storm",
];

export function eventTypeName(code) {
    return EVENT_TYPE_NAMES[code] || "Storm Report";
}

export function magnitudeLabel(eventType, magnitude) {
    if (magnitude === 0) return null;
    if (eventType === 3) return (magnitude * 0.25).toFixed(2) + '" dia.';
    if (eventType === 4 || eventType === 9) return magnitude + " mph";
    return null;
}

function decodeStormReports(data) {
    if (data.length < 2 || data[0] !== 0x33) return null;
    const locType = data[1];
    const idLen = locationIDLength(locType);
    const headerEnd = 2 + idLen;
    if (data.length < headerEnd + 1) return null;

    const locationID = parseLocationID(locType, data, 2, idLen);
    const reportCount = data[headerEnd];
    const reports = [];
    let off = headerEnd + 1;
    for (let i = 0; i < reportCount; i++) {
        if (off + 6 >= data.length) break;
        const eventType = data[off];
        const magnitude = data[off + 1];
        const minutesAgo = readUint16LE(data, off + 2);
        const placeID = data[off + 4] | (data[off + 5] << 8) | (data[off + 6] << 16);
        reports.push({ eventType, magnitude, minutesAgo, placeID });
        off += 7;
    }

    return {
        type: "stormReports",
        locationType: locType,
        locationID,
        reports,
        receivedAt: Date.now(),
    };
}

// ============================================================================
// 0x34 Rain Observations
// ============================================================================

const RAIN_TYPE_NAMES = [
    "Light Rain", "Moderate Rain", "Heavy Rain", "Drizzle",
    "Rain Shower", "Snow", "Sleet/Freezing",
];

export function rainTypeName(code) {
    return RAIN_TYPE_NAMES[code] || "Precipitation";
}

function decodeRainObservations(data) {
    if (data.length < 2 || data[0] !== 0x34) return null;
    const locType = data[1];
    const idLen = locationIDLength(locType);
    const headerEnd = 2 + idLen;
    if (data.length < headerEnd + 3) return null;

    const locationID = parseLocationID(locType, data, 2, idLen);
    const timestampMinutes = readUint16LE(data, headerEnd);
    const cityCount = data[headerEnd + 2];
    const cities = [];
    let off = headerEnd + 3;
    for (let i = 0; i < cityCount; i++) {
        if (off + 4 >= data.length) break;
        const placeID = data[off] | (data[off + 1] << 8) | (data[off + 2] << 16);
        const rainType = data[off + 3];
        const tempF = readInt8(data, off + 4);
        cities.push({ placeID, rainType, tempF });
        off += 5;
    }

    return {
        type: "rainObservations",
        locationType: locType,
        locationID,
        timestampMinutes,
        cities,
        receivedAt: Date.now(),
    };
}

// ============================================================================
// 0x37 Warnings Near
// ============================================================================

const WARN_NEAR_TYPE_NAMES = {
    1: "Tornado", 2: "Severe Thunderstorm", 3: "Flash Flood", 4: "Flood",
    5: "Winter Storm", 6: "High Wind", 7: "Fire Weather", 8: "Marine",
    9: "Special Weather Statement",
};

const WARN_NEAR_SEV_NAMES = {
    1: "Advisory", 2: "Watch", 3: "Warning", 4: "Emergency",
};

export function warningsNearTypeName(code) {
    return WARN_NEAR_TYPE_NAMES[code] || "Weather Alert";
}

export function warningsNearSevName(code) {
    return WARN_NEAR_SEV_NAMES[code] || "Alert";
}

function decodeWarningsNear(data) {
    if (data.length < 2 || data[0] !== 0x37) return null;
    const locType = data[1];
    const idLen = locationIDLength(locType);
    const headerEnd = 2 + idLen;
    if (data.length < headerEnd + 1) return null;

    const locationID = parseLocationID(locType, data, 2, idLen);
    const entryCount = data[headerEnd];
    const entries = [];
    let off = headerEnd + 1;
    for (let i = 0; i < entryCount; i++) {
        if (off + 7 >= data.length) break;
        const typeSev = data[off];
        const v2Type = (typeSev >> 4) & 0x0F;
        const severity = typeSev & 0x0F;
        const expiryUnixMinutes = readUint32BE(data, off + 1);
        const stateIdx = data[off + 5];
        const zoneNum = readUint16BE(data, off + 6);
        entries.push({ v2Type, severity, expiryUnixMinutes, stateIdx, zoneNum });
        off += 8;
    }

    return {
        type: "warningsNear",
        locationType: locType,
        locationID,
        entries,
        receivedAt: Date.now(),
    };
}

// ============================================================================
// 0x38 Fire Weather Forecast (FWF)
// ============================================================================

const FW_DIR16 = ["N","NNE","NE","ENE","E","ESE","SE","SSE",
                  "S","SSW","SW","WSW","W","WNW","NW","NNW"];
const FW_CLOUD_NAMES = ["Clear","Few","Scattered","Broken","Overcast","Obscured"];
const FW_LIGHTNING = ["None","Dry lightning","Wet lightning"];

export function fwWindDirName(code) { return FW_DIR16[code & 0x0F] || "VAR"; }
export function fwCloudName(code) { return FW_CLOUD_NAMES[code] || "Variable"; }
export function fwLightningName(code) { return FW_LIGHTNING[code] || "None"; }

function decodeFireWeather(data) {
    if (data.length < 2 || data[0] !== 0x38) return null;
    const locType = data[1];
    const idLen = locationIDLength(locType);
    const headerEnd = 2 + idLen;
    if (data.length < headerEnd + 2) return null;

    const locationID = parseLocationID(locType, data, 2, idLen);
    const issuedHoursAgo = data[headerEnd];
    const periodCount = data[headerEnd + 1];

    const periods = [];
    let off = headerEnd + 2;
    for (let i = 0; i < periodCount; i++) {
        if (off + 7 >= data.length) break;
        const transportByte = data[off + 3];
        const hainesLightn = data[off + 5];
        const weatherByte = data[off + 7];
        periods.push({
            periodID: data[off],
            maxTempF: readInt8(data, off + 1),
            minRHPct: data[off + 2],
            transportWindDir: (transportByte >> 4) & 0x0F,
            transportWindMph: (transportByte & 0x0F) * 5,
            mixingHeight500ft: data[off + 4],
            mixingHeightFt: data[off + 4] * 500,
            hainesIndex: hainesLightn & 0x0F,
            lightningRisk: (hainesLightn >> 4) & 0x0F,
            cloudCover: data[off + 6],
            weatherType: (weatherByte >> 3) & 0x1F,
            intensity: (weatherByte >> 1) & 0x03,
        });
        off += 8;
    }

    return {
        type: "fireWeather",
        locationType: locType,
        locationID,
        issuedHoursAgo,
        periods,
        receivedAt: Date.now(),
    };
}

// ============================================================================
// 0x3A Daily Climate (RTP)
// ============================================================================

function decodeDailyClimate(data) {
    if (data.length < 3 || data[0] !== 0x3A) return null;
    const cityCount = data[1];
    const reportDayOffset = data[2];

    const cities = [];
    let off = 3;
    for (let i = 0; i < cityCount; i++) {
        if (off + 6 >= data.length) break;
        const placeID = data[off] | (data[off + 1] << 8) | (data[off + 2] << 16);
        const maxRaw = readInt8(data, off + 3);
        const minRaw = readInt8(data, off + 4);
        const precipRaw = data[off + 5];
        const snowRaw = data[off + 6];

        const maxTempF = maxRaw === 127 ? null : maxRaw;
        const minTempF = minRaw === 127 ? null : minRaw;
        const precipInches = precipRaw === 0xFE ? null : (precipRaw === 0xFF ? -1.0 : precipRaw / 100.0);
        const snowInches = snowRaw === 0xFE ? null : (snowRaw === 0xFF ? -1.0 : snowRaw / 10.0);

        cities.push({ placeID, maxTempF, minTempF, precipInches, snowInches });
        off += 7;
    }

    const DAY_LABELS = ["Today", "Yesterday", "2 Days Ago"];

    return {
        type: "dailyClimate",
        reportDayOffset,
        dayLabel: DAY_LABELS[reportDayOffset] || `${reportDayOffset} Days Ago`,
        cities,
        receivedAt: Date.now(),
    };
}

// ============================================================================
// 0x3C Nowcast (Short Term Forecast)
// ============================================================================

function decodeNowcast(data) {
    if (data.length < 2 || data[0] !== 0x3C) return null;
    const locType = data[1];
    const idLen = locationIDLength(locType);
    const headerEnd = 2 + idLen;
    if (data.length < headerEnd + 2) return null;

    const locationID = parseLocationID(locType, data, 2, idLen);
    const validHours = data[headerEnd];
    const urgencyFlags = data[headerEnd + 1];
    const textStart = headerEnd + 2;
    const text = utf8Decode(data, textStart, data.length);

    const hasThunder = (urgencyFlags & 0x01) !== 0;
    const hasFlooding = (urgencyFlags & 0x02) !== 0;
    const hasWinter = (urgencyFlags & 0x04) !== 0;
    const hasFire = (urgencyFlags & 0x08) !== 0;
    const hasWind = (urgencyFlags & 0x10) !== 0;
    const isUrgent = hasThunder || hasFlooding || hasWinter || hasFire || hasWind;

    // Lead text: first 2 sentences
    const sentences = text.split('. ');
    const leadText = sentences.slice(0, 2).join('. ').trim();

    return {
        type: "nowcast",
        locationType: locType,
        locationID,
        validHours,
        hasThunder, hasFlooding, hasWinter, hasFire, hasWind,
        isUrgent,
        text,
        leadText,
        receivedAt: Date.now(),
    };
}

// ============================================================================
// 0x40 Text Chunk
// ============================================================================

function decodeTextChunk(data) {
    if (data.length < 2 || data[0] !== 0x40) return null;
    const text = utf8Decode(data, 1, data.length);
    if (!text) return null;
    return { type: "textChunk", text, receivedAt: Date.now() };
}
