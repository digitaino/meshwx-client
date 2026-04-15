/**
 * COBS (Consistent Overhead Byte Stuffing) codec.
 * Ported from MeshWXDecoder.swift lines 2458-2501.
 */

/**
 * Decode a COBS-encoded Uint8Array.
 * @param {Uint8Array} data
 * @returns {Uint8Array|null} decoded data, or null if invalid
 */
export function cobsDecode(data) {
    if (!data || data.length === 0) return null;
    const output = [];
    let i = 0;
    while (i < data.length) {
        const code = data[i++];
        if (code === 0) return null;
        const runLength = code - 1;
        if (i + runLength > data.length) return null;
        for (let j = 0; j < runLength; j++) {
            output.push(data[i++]);
        }
        if (code < 0xFF && i < data.length) {
            output.push(0x00);
        }
    }
    return new Uint8Array(output);
}

/**
 * Encode data using COBS.
 * @param {Uint8Array} data
 * @returns {Uint8Array} encoded data
 */
export function cobsEncode(data) {
    const output = [];
    let blockStart = output.length;
    output.push(0);
    let runLength = 1;
    for (const byte of data) {
        if (byte === 0x00) {
            output[blockStart] = runLength;
            blockStart = output.length;
            output.push(0);
            runLength = 1;
        } else {
            output.push(byte);
            runLength++;
            if (runLength === 0xFF) {
                output[blockStart] = runLength;
                blockStart = output.length;
                output.push(0);
                runLength = 1;
            }
        }
    }
    output[blockStart] = runLength;
    return new Uint8Array(output);
}
