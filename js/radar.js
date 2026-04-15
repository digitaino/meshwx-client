/**
 * Radar canvas renderer for MeshWX grid data.
 * Renders reflectivity grids onto a <canvas> element with bilinear upscaling.
 */

import { RADAR_COLORS, REGIONS } from './decoder.js';

/**
 * Render a radar frame to a canvas element.
 * @param {HTMLCanvasElement} canvas
 * @param {object} frame - Decoded radar frame from decoder.js
 * @param {number} [scale=4] - Pixel scale factor (e.g. 4 = 4px per grid cell)
 */
export function renderRadar(canvas, frame, scale = 4) {
    if (!frame || !frame.grid) return;
    const { gridSize, grid } = frame;
    const size = gridSize * scale;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(size, size);
    const pixels = imageData.data;

    for (let row = 0; row < gridSize; row++) {
        for (let col = 0; col < gridSize; col++) {
            const level = grid[row * gridSize + col];
            const color = RADAR_COLORS[level] || [0, 0, 0, 0];
            // Fill the scaled pixel block
            for (let dy = 0; dy < scale; dy++) {
                for (let dx = 0; dx < scale; dx++) {
                    const px = (row * scale + dy) * size + (col * scale + dx);
                    const idx = px * 4;
                    pixels[idx] = color[0];
                    pixels[idx + 1] = color[1];
                    pixels[idx + 2] = color[2];
                    pixels[idx + 3] = color[3];
                }
            }
        }
    }

    ctx.putImageData(imageData, 0, 0);
}

/**
 * Render a radar frame as a thumbnail (fixed 128×128).
 * @param {HTMLCanvasElement} canvas
 * @param {object} frame
 */
export function renderRadarThumbnail(canvas, frame) {
    if (!frame || !frame.grid) return;
    const scale = Math.max(1, Math.floor(128 / frame.gridSize));
    renderRadar(canvas, frame, scale);
}

/**
 * Render a smooth (bilinear-interpolated) radar frame for map overlay.
 * Draws at 1:1 pixel scale then uses canvas drawImage to upscale with smoothing.
 * @param {HTMLCanvasElement} canvas - Output canvas (will be resized to outputSize)
 * @param {object} frame - Decoded radar frame
 * @param {number} [outputSize=256] - Output pixel dimensions
 */
export function renderRadarSmooth(canvas, frame, outputSize = 256) {
    if (!frame || !frame.grid) return;
    const { gridSize, grid } = frame;

    // Step 1: render at native grid resolution (e.g. 32x32 or 64x64)
    const src = document.createElement('canvas');
    src.width = gridSize;
    src.height = gridSize;
    const sCtx = src.getContext('2d');
    const imageData = sCtx.createImageData(gridSize, gridSize);
    const pixels = imageData.data;

    for (let row = 0; row < gridSize; row++) {
        for (let col = 0; col < gridSize; col++) {
            const level = grid[row * gridSize + col];
            const color = RADAR_COLORS[level] || [0, 0, 0, 0];
            const idx = (row * gridSize + col) * 4;
            pixels[idx] = color[0];
            pixels[idx + 1] = color[1];
            pixels[idx + 2] = color[2];
            pixels[idx + 3] = color[3];
        }
    }
    sCtx.putImageData(imageData, 0, 0);

    // Step 2: upscale with bilinear smoothing
    canvas.width = outputSize;
    canvas.height = outputSize;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, outputSize, outputSize);
}

/**
 * Get a human-readable label for a radar region.
 */
export function regionLabel(regionID) {
    const r = REGIONS[regionID];
    return r ? r.name : `Region ${regionID}`;
}

/**
 * Format a radar timestamp (uint32 BE Unix minutes) to local time string.
 */
export function formatRadarTime(timestamp) {
    // timestamp is in Unix minutes (for v4) or minutes-since-midnight (for some)
    // v4 radar: 4-byte BE, value is Unix time in minutes
    const date = new Date(timestamp * 60000);
    if (date.getFullYear() > 2020) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    // Fallback: raw minutes since midnight
    const h = Math.floor(timestamp / 60);
    const m = timestamp % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} UTC`;
}
