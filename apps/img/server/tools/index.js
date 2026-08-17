'use strict';

// ═══════════════════════════════════════════════════════════════
// Img.OpenVibe — Tool Registry
// Central registry of all image processing tools.
// Each tool exports: { label, description, accepts, handler }
// ═══════════════════════════════════════════════════════════════

const convert  = require('./convert');
const compress = require('./compress');
const resize   = require('./resize');
const crop     = require('./crop');

const TOOLS = {
    convert: {
        id: 'convert',
        label: 'Convert',
        description: 'Convert images between formats',
        faIcon: 'fa-arrows-rotate',
        accepts: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'heic', 'heif', 'svg', 'ico'],
        outputs: ['png', 'jpg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'ico'],
        handler: convert,
    },
    compress: {
        id: 'compress',
        label: 'Compress',
        description: 'Reduce image file size',
        faIcon: 'fa-compress',
        accepts: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'tiff', 'gif'],
        outputs: null, // same as input
        handler: compress,
    },
    resize: {
        id: 'resize',
        label: 'Resize',
        description: 'Resize images to new dimensions',
        faIcon: 'fa-up-right-and-down-left-from-center',
        accepts: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'heic', 'heif', 'svg'],
        outputs: null, // same as input
        handler: resize,
    },
    crop: {
        id: 'crop',
        label: 'Crop',
        description: 'Crop images to specific areas or aspect ratios',
        faIcon: 'fa-crop-simple',
        accepts: ['png', 'jpg', 'jpeg', 'webp', 'avif', 'tiff', 'bmp', 'gif', 'heic', 'heif', 'svg'],
        outputs: null, // same as input
        handler: crop,
    },
};

function getTool(id) {
    return TOOLS[id] || null;
}

function listTools() {
    return Object.values(TOOLS).map(t => ({
        id: t.id, label: t.label, description: t.description,
        faIcon: t.faIcon, accepts: t.accepts, outputs: t.outputs,
    }));
}

module.exports = { TOOLS, getTool, listTools };
