'use strict';

// ═══════════════════════════════════════════════════════════════
// The tool frame for the image pages (openvibe-shared ≥ 4.57.1, owner ask 11, part 2).
//
// Every image host — png, jpg, compress, resize, crop and the rest — is a tool page in the shared
// frame: the head (the family crumb, the tool's name, one sentence, the terms), the box (a drop zone
// and the tool's own options), the answer (the file it made, its size before and after, and Download),
// the family, the folds and "People also use".
//
// The terms come from the app's real configuration: the file's lifetime from config.js's retention,
// its size from config.js's upload limits, and the anonymous rate from the guard's quota table and the
// tool's own cost in it (server/descriptors.js).
// ═══════════════════════════════════════════════════════════════

const kit = require('openvibe-shared/kit');
const serve = require('openvibe-shared/serve');
const frame = require('../../_shared/frame')({ kit, serve });
const config = require('./config');
const { DOMAIN_MAP } = require('./domain-map');
const { SPECS } = require('./descriptors');

const HUB = 'https://img.openvibe.tools/';
const esc = kit.esc;

// The tools, in the order the family row shows them. `op` is the operation the host runs
// (domain-map.js); `format` the one it writes by default.
const TOOLS = [
    {
        id: 'convert', host: 'convert.openvibe.tools', name: 'Image Converter', short: 'Convert', icon: 'swap', hue: 190, op: 'convert',
        task: 'Convert an image to PNG, JPG, WebP, AVIF, GIF, TIFF, BMP or ICO.',
        about: 'The image converter writes the format you pick and nothing else: the picture is decoded, re-encoded and sent back as a file you can download.',
        bullets: ['PNG keeps every pixel, JPG is small and universal, WebP and AVIF are smaller still.', 'A quality slider is there for the formats that lose a little to save bytes.'],
        faq: [['Which format should I pick?', 'PNG for a picture with text or flat colours, JPG for a photograph you want small, WebP or AVIF when the file travels far.'],
            ['Is my picture uploaded?', 'Yes, to our server, and it is deleted an hour later. Nothing is kept.'],
            ['Can I convert a HEIC photo?', 'Yes, on a server with the HEIC decoder installed. The page says so when it is not.']],
    },
    {
        id: 'compress', host: 'compress.openvibe.tools', name: 'Image Compressor', short: 'Compress', icon: 'zap', hue: 190, op: 'compress',
        task: 'Make an image smaller without changing how it looks.',
        about: 'The compressor re-encodes your picture at the quality you choose and shows the size before and after, so you can see what it saved.',
        bullets: ['A lower level means a smaller file and a softer picture.', 'The original is never touched; you get a new file.'],
        faq: [['How much smaller can it get?', 'A photograph often loses half its size; a flat picture with sharp edges loses less.'],
            ['Does it change the resolution?', 'No. The picture keeps its dimensions; only the way it is encoded changes.']],
    },
    {
        id: 'resize', host: 'resize.openvibe.tools', name: 'Image Resizer', short: 'Resize', icon: 'grid', hue: 190, op: 'resize',
        task: 'Make an image a new size, in pixels or by a percentage.',
        about: 'The resizer scales a picture to the width and height you give it, or to a percentage of what it is now.',
        bullets: ['Five ways to fit: inside, cover, contain, fill or outside.', 'A picture is never enlarged past its own size unless you ask for it.'],
        faq: [['What does "inside" mean?', 'The picture fits inside the box you typed; the other side keeps its ratio.'],
            ['Can I make it bigger?', 'Yes, but a picture scaled up is softer than the original.']],
    },
    {
        id: 'crop', host: 'crop.openvibe.tools', name: 'Image Cropper', short: 'Crop', icon: 'grid', hue: 190, op: 'crop',
        task: 'Cut an image down to the part you want to keep.',
        about: 'The cropper keeps a rectangle of your picture, or the largest centred piece with the ratio you choose.',
        bullets: ['Nine ratios, from 1:1 to 21:9.', 'Type the rectangle yourself when the ratio is not the one you want.'],
        faq: [['Which part is kept when I pick a ratio?', 'The largest centred piece with that ratio.'],
            ['Can I crop to an exact rectangle?', 'Yes. Leave the ratio on "Custom" and type the four numbers.']],
    },
    {
        id: 'favicon', host: 'favicon.openvibe.tools', name: 'Favicon Generator', short: 'Favicon', icon: 'star', hue: 190, op: 'convert', format: 'ico',
        task: 'Turn a picture into the .ico file a website asks for.',
        about: 'The favicon generator writes a multi-size ICO file from your picture, the file a browser tab and a bookmark ask a site for.',
        bullets: ['One .ico file with the sizes browsers look for.', 'A PNG of the same picture comes with it for social cards.'],
        faq: [['Where do I put the file?', 'In your site\'s root folder, next to your index.html, and you link it in the head.'],
            ['What size should the picture be?', 'A square of at least 512 pixels; the generator resizes it for you.']],
    },
    {
        id: 'png', host: 'png.openvibe.tools', name: 'PNG Converter', short: 'PNG', icon: 'image', hue: 190, op: 'convert', format: 'png',
        task: 'Convert an image to PNG, the format that keeps every pixel.',
        about: 'The PNG converter writes a lossless PNG from any picture you drop: JPG, WebP, AVIF, HEIC, GIF, BMP, TIFF or SVG.',
        bullets: ['Lossless: the pixels that come out are the pixels that went in.', 'The background is filled with white when the picture had none.'],
        faq: [['Is a PNG bigger than a JPG?', 'Usually. PNG keeps every pixel, so it is bigger for a photograph and smaller for a logo.'],
            ['Does it keep the transparency?', 'Yes, when the format you drop it in has transparency.']],
    },
    {
        id: 'jpg', host: 'jpg.openvibe.tools', name: 'JPG Converter', short: 'JPG', icon: 'image', hue: 190, op: 'convert', format: 'jpg',
        task: 'Convert an image to JPG, the format every program reads.',
        about: 'The JPG converter writes a JPEG from any picture you drop, at the quality you pick.',
        bullets: ['The format for photographs and for anything that has to be small.', 'Transparency is filled with white.'],
        faq: [['What quality should I use?', '80 to 85 is invisible to the eye and small enough for the web.'],
            ['Can it write a progressive JPG?', 'Yes, the file loads line by line while it downloads.']],
    },
    {
        id: 'webp', host: 'webp.openvibe.tools', name: 'WebP Converter', short: 'WebP', icon: 'image', hue: 190, op: 'convert', format: 'webp',
        task: 'Convert an image to WebP, the web format that is smaller than JPG.',
        about: 'The WebP converter writes a modern web image format: smaller than JPG at the same look, and it keeps transparency.',
        bullets: ['Every current browser reads WebP.', 'Usually a third smaller than the same picture as a JPG.'],
        faq: [['Does every browser read WebP?', 'Every browser released since 2020 does.'],
            ['Is WebP lossy?', 'You choose: a quality slider, like the JPG converter.']],
    },
    {
        id: 'avif', host: 'avif.openvibe.tools', name: 'AVIF Converter', short: 'AVIF', icon: 'image', hue: 190, op: 'convert', format: 'avif',
        task: 'Convert an image to AVIF, the smallest format the web has.',
        about: 'The AVIF converter writes the modern image format browsers support: smaller than WebP at the same quality.',
        bullets: ['The smallest files of the lot, and the slowest to write.', 'Transparency, like PNG.'],
        faq: [['Is AVIF slow?', 'Yes. A big picture takes a while to encode, and the page says so while it works.'],
            ['Which browsers read AVIF?', 'Chrome, Firefox, Safari 16 and every browser since.']],
    },
    {
        id: 'heic', host: 'heic.openvibe.tools', name: 'HEIC Converter', short: 'HEIC', icon: 'image', hue: 190, op: 'convert', format: 'png',
        task: 'Convert an iPhone HEIC photo to a picture every program can open.',
        about: 'The HEIC converter reads the photos an iPhone saves and writes them as PNG or JPG.',
        bullets: ['HEIC and HEIF, the formats iPhones and some cameras use.', 'Needs a HEIC decoder on the server; the page says so when there is none.'],
        faq: [['Why can I not convert my photo?', 'The server needs the HEIC decoder. The page says so when it is missing.'],
            ['What does it write?', 'PNG by default; the format grid is there if you want JPG instead.']],
    },
    {
        id: 'svg', host: 'svg.openvibe.tools', name: 'SVG Converter', short: 'SVG', icon: 'image', hue: 190, op: 'convert', format: 'png',
        task: 'Convert an SVG drawing to a picture you can use anywhere.',
        about: 'The SVG converter rasterises a vector drawing, so you can use it as a PNG or a JPG in a program that cannot read vectors.',
        bullets: ['Vector in, picture out.', 'The width and height of the drawing decide the size of the picture.'],
        faq: [['Will the picture be sharp?', 'It is drawn at the size you ask for, so ask for the size you need.'],
            ['Can I go the other way?', 'Not here: a picture turned into a vector is a different tool.']],
    },
    {
        id: 'gif', host: 'gif.openvibe.tools', name: 'GIF Converter', short: 'GIF', icon: 'image', hue: 190, op: 'convert', format: 'gif',
        task: 'Convert an image to GIF, the format every program still reads.',
        about: 'The GIF converter writes an animated or still GIF from any picture you drop.',
        bullets: ['Good for pictures with few colours and for short animations.', 'A picture of many colours becomes bigger, not smaller.'],
        faq: [['Does it keep the animation?', 'Yes, when the file you drop is an animated picture.'],
            ['Why is my GIF so big?', 'GIF has no compression for photographs. Use JPG or WebP for those.']],
    },
    {
        id: 'ico', host: 'ico.openvibe.tools', name: 'ICO Converter', short: 'ICO', icon: 'image', hue: 190, op: 'convert', format: 'ico',
        task: 'Convert an image to ICO, the icon file a website and a program use.',
        about: 'The ICO converter writes a multi-size icon file from your picture.',
        bullets: ['The sizes Windows and browsers look for, in one file.', 'A PNG of the same picture comes with it.'],
        faq: [['What size should the picture be?', 'A square of 512 pixels or more; the sizes below it are made for you.'],
            ['Can I make a favicon from a photo?', 'Yes, but a picture with one shape in it reads better as an icon.']],
    },
    {
        id: 'tiff', host: 'tiff.openvibe.tools', name: 'TIFF Converter', short: 'TIFF', icon: 'image', hue: 190, op: 'convert', format: 'tiff',
        task: 'Convert an image to TIFF, the format printers and scanners use.',
        about: 'The TIFF converter writes an uncompressed, lossless picture that a printer or a scanner program reads.',
        bullets: ['Lossless and unshrunk.', 'Big files: a picture is not compressed here.'],
        faq: [['Why is the file so big?', 'TIFF stores the picture as it is, without compression.'],
            ['Who needs TIFF?', 'Printers, scanners and publishers.']],
    },
    {
        id: 'bmp', host: 'bmp.openvibe.tools', name: 'BMP Converter', short: 'BMP', icon: 'image', hue: 190, op: 'convert', format: 'bmp',
        task: 'Convert an image to BMP, the oldest picture format there is.',
        about: 'The BMP converter writes the uncompressed bitmap format that old programs and some tools still ask for.',
        bullets: ['No compression: the file is as big as the picture.', 'Nothing is lost on the way.'],
        faq: [['Why would I want a BMP?', 'Some old programs and device tools only read BMP.'],
            ['Is the file big?', 'Yes. It is the picture in its own bytes, with no compression.']],
    },
];

const BY_ID = new Map(TOOLS.map((t) => [t.id, t]));
const BY_HOST = new Map(TOOLS.map((t) => [t.host, t]));
const SPEC = new Map(SPECS.map((s) => [s.id, s]));

// The hub is a tool page too: the converter, with the whole family under it.
const HUB_TOOL = {
    id: 'hub', name: 'Img.OpenVibe', short: 'All tools', icon: 'image', hue: 190, op: 'convert', format: 'png',
    task: 'Convert an image to PNG, JPG, WebP, AVIF, GIF, TIFF, BMP or ICO — the other image tools are below.',
    about: 'Every image tool in one place: convert a picture to another format, make it smaller, change its size or cut it down.',
    faq: [['Which formats do you read?', 'PNG, JPG, WebP, AVIF, HEIC, HEIF, SVG, GIF, ICO, TIFF and BMP.'],
        ['How long are my files kept?', 'An hour for a visitor, a day for a signed-in person. Then they are gone.'],
        ['Is it free?', 'Yes. Every image tool here is free, with a fair-use limit per address so the server stays fast.']],
};

/** The tool a host is for (the aliases jpeg and heif point at jpg and heic). */
function toolFor(host) {
    const t = BY_HOST.get(host);
    if (t) return t;
    const ctx = DOMAIN_MAP[host];
    if (!ctx) return null;
    if (ctx.toolId === 'hub') return HUB_TOOL;
    return BY_ID.get(ctx.toolId) || null;
}

/** The format the host writes by default. */
const formatOf = (rec) => rec.format || (DOMAIN_MAP[`${rec.id}.openvibe.tools`] || {}).defaultFormat || 'png';

/** The terms of a tool, from the app's real configuration and the tool's own descriptor. */
function termsOf(rec) {
    const spec = SPEC.get(rec.id === 'hub' ? 'convert' : rec.id);
    // The size is the app's own upload limit (config.js); the count is the tool's own descriptor.
    const maxBytes = config.upload.maxFileSize;
    const maxFiles = (spec && spec.files && spec.files.max) || 1;
    return frame.terms({
        work: 'server',
        ttlMs: config.retention.anonTTL,
        maxBytes, maxFiles,
        quotaClass: (spec && spec.quotaClass) || 'tools-job',
        cost: (spec && spec.cost) || 1,
        unit: rec.op === 'convert' ? 'conversions' : 'runs',
        needsAccount: !!(spec && spec.auth && spec.auth.anonymous === false),
    });
}

/** The format buttons of the convert box. */
function formatChips(current) {
    const formats = [['png', 'PNG'], ['jpg', 'JPG'], ['webp', 'WebP'], ['avif', 'AVIF'], ['gif', 'GIF'], ['tiff', 'TIFF'], ['bmp', 'BMP'], ['ico', 'ICO']];
    return kit.chips({
        name: 'format', single: true, label: 'Output format',
        options: formats.map(([v, l]) => [v, l, v === current]),
    });
}

/** A number field of the box, in the app's own field style. */
function numberField(name, label, { min = 0, max = null, placeholder = '' } = {}) {
    return `<label class="ovk-set-row"><span class="ovk-set-text">${esc(label)}</span>`
        + `<input type="number" class="num-input num-input-sm" name="${esc(name)}" value="" placeholder="${esc(placeholder)}"${min != null ? ` min="${min}"` : ''}${max != null ? ` max="${max}"` : ''}></label>`;
}

/** The options of the box, per operation. */
function optionsFor(rec) {
    if (rec.op === 'compress') return kit.rangeRow({ name: 'quality', label: 'Compression level', value: 75, min: 1, max: 100, step: 1 });
    if (rec.op === 'resize') {
        return numberField('width', 'Width (px)', { min: 1, max: 16384, placeholder: 'auto' })
            + numberField('height', 'Height (px)', { min: 1, max: 16384, placeholder: 'auto' })
            + numberField('percentage', 'Or scale by percentage', { min: 1, max: 1000, placeholder: 'e.g. 50' })
            + kit.selectRow({ name: 'fit', label: 'Fit mode', value: 'inside', options: [['inside', 'Inside (fit within bounds)'], ['cover', 'Cover (fill and crop)'], ['contain', 'Contain (fit with padding)'], ['fill', 'Fill (stretch)'], ['outside', 'Outside (cover minimum)']] });
    }
    if (rec.op === 'crop') {
        const ratios = [['1:1', '1:1'], ['16:9', '16:9'], ['4:3', '4:3'], ['3:2', '3:2'], ['21:9', '21:9'], ['9:16', '9:16'], ['3:4', '3:4'], ['', 'Custom']];
        return kit.chips({ name: 'aspect', single: true, label: 'Aspect ratio', options: ratios.map(([v, l]) => [v, l, v === '']) })
            + numberField('left', 'Left (px)', { min: 0, placeholder: '0' })
            + numberField('top', 'Top (px)', { min: 0, placeholder: '0' })
            + numberField('width', 'Width (px)', { min: 1, placeholder: 'auto' })
            + numberField('height', 'Height (px)', { min: 1, placeholder: 'auto' });
    }
    return formatChips(formatOf(rec)) + kit.rangeRow({ name: 'quality', label: 'Quality', value: 80, min: 1, max: 100, step: 1 });
}

/** The one button of the page: it says the verb. */
function verbFor(rec) {
    if (rec.op === 'compress') return 'Compress';
    if (rec.op === 'resize') return 'Resize';
    if (rec.op === 'crop') return 'Crop';
    if (rec.id === 'favicon') return 'Make favicon';
    return `Convert to ${formatOf(rec).toUpperCase()}`;
}

/**
 * The box: a drop zone for the picture, the tool's options and the one button.
 * @param {object} rec the tool record
 */
function boxFor(rec) {
    const accept = 'image/png,image/jpeg,image/webp,image/avif,image/tiff,image/bmp,image/gif,image/heic,image/heif,image/svg+xml,image/x-icon,image/vnd.microsoft.icon';
    const drop = kit.drop({
        name: 'file', accept, id: 'file-input',
        label: 'Drop an image here',
        hint: 'PNG, JPG, WebP, AVIF, HEIC, SVG, GIF, ICO, TIFF, BMP',
    });
    return `<form class="ovk-tool-form" id="ovk-img-form" enctype="multipart/form-data" data-ovk-tool-form>`
        + drop
        + `<p class="ovk-try"><span>Try</span><a href="/sample.png" data-ovk-sample="/sample.png">A sample image</a></p>`
        + `<div id="options-panel" hidden>${optionsFor(rec)}</div>`
        + `<div class="ovk-tool-buttons">${frame.verbButton(verbFor(rec), { id: 'process-btn', icon: 'zap' })}`
        + `<button type="button" class="ovk-btn ovk-btn--quiet ovk-btn--small" id="clear-btn">${kit.icon('close')}<span>Clear</span></button></div>`
        + `</form>`;
}

/** The family: every image tool, with the one on the page marked. */
function familyItems(rec) {
    // The hub is the converter itself, so the converter is the tool the family marks there.
    const current = rec.id === 'hub' ? 'convert' : rec.id;
    return TOOLS.map((t) => ({
        href: `https://${t.host}/`, label: t.name, short: t.short, current: t.id === current,
    }));
}

/** "People also use": the tools next to this one in the family. */
function relatedFor(rec) {
    const at = TOOLS.findIndex((t) => t.id === rec.id);
    const out = [];
    for (let i = 1; out.length < 3 && i < TOOLS.length + 1; i++) {
        const other = TOOLS[(at + i) % TOOLS.length];
        if (other.id !== rec.id) out.push(other);
    }
    return out.map((t) => kit.row({ href: `https://${t.host}/`, title: t.name, sub: t.task }));
}

/**
 * The whole frame for one host.
 * @param {string} host the satellite's own hostname, e.g. 'png.openvibe.tools'
 * @returns {string} HTML
 */
function frameFor(host) {
    const rec = toolFor(host);
    if (!rec) return '';
    const spec = SPEC.get(rec.id === 'hub' ? 'convert' : rec.id);
    const fields = spec && spec.input && spec.input.properties ? Object.keys(spec.input.properties).join(', ') : 'none';
    const apiId = rec.id === 'hub' ? 'convert' : rec.id;
    const input = spec && spec.input && spec.input.properties ? Object.fromEntries(
        Object.entries(spec.input.properties).map(([k, v]) => [k, v.default !== undefined ? v.default : (k === 'format' ? formatOf(rec) : '')]),
    ) : {};
    return frame.page({
        id: rec.id,
        icon: rec.icon, hue: rec.hue, family: 'image',
        crumb: { href: HUB, label: 'Image tools' },
        title: rec.name, task: rec.task, facts: termsOf(rec),
        box: boxFor(rec),
        familyTitle: 'More image tools',
        familyMore: { href: HUB, label: `All ${TOOLS.length}` },
        familyItems: familyItems(rec),
        about: rec.about, bullets: rec.bullets, faq: rec.faq,
        api: {
            id: apiId, path: `/api/v1/tools/${apiId}/run`, fields, payload: { input },
            needsAccount: !!(spec && spec.auth && spec.auth.anonymous === false),
        },
        related: relatedFor(rec),
    });
}

module.exports = { frameFor, toolFor, termsOf, boxFor, verbFor, TOOLS, HUB_TOOL, optionsFor, formatChips };
