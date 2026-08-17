// ═══════════════════════════════════════════════════════════════
// Logo.OpenVibe — Canvas-based Logo / Title / Badge Generation
// Text rendering with effects, transparent PNG/WebP export,
// Google Fonts loading, preset templates. 100% client-side.
// ═══════════════════════════════════════════════════════════════

(function (root) {
'use strict';

// ── Preset templates ─────────────────────────────────────────
const PRESETS = {
    neon: {
        name: 'Neon Glow',
        bg: 'transparent',
        color: '#00ffff',
        font: 'Orbitron',
        shadowColor: '#00ffff',
        shadowBlur: 20,
        strokeColor: '#00aaff',
        strokeWidth: 2,
    },
    retro: {
        name: 'Retro Wave',
        bg: 'transparent',
        color: '#ff6ec7',
        font: 'Press Start 2P',
        shadowColor: '#ff00ff',
        shadowBlur: 15,
        strokeColor: '#ffcc00',
        strokeWidth: 3,
    },
    gold: {
        name: 'Gold Luxury',
        bg: 'transparent',
        font: 'Playfair Display',
        gradient: ['#c0965c', '#e1b77d', '#c0965c'],
        shadowColor: 'rgba(192, 150, 92, 0.5)',
        shadowBlur: 10,
        strokeColor: '#9f7337',
        strokeWidth: 1,
    },
    minimal: {
        name: 'Clean Minimal',
        bg: 'transparent',
        color: '#ffffff',
        font: 'Inter',
        shadowColor: 'transparent',
        shadowBlur: 0,
    },
    hacker: {
        name: 'Hacker',
        bg: 'transparent',
        color: '#00ff41',
        font: 'Courier New',
        shadowColor: '#00ff41',
        shadowBlur: 12,
    },
    fire: {
        name: 'Fire',
        bg: 'transparent',
        font: 'Impact',
        gradient: ['#ff0000', '#ff6600', '#ffcc00'],
        shadowColor: '#ff3300',
        shadowBlur: 15,
        strokeColor: '#660000',
        strokeWidth: 3,
    },
    ice: {
        name: 'Ice',
        bg: 'transparent',
        font: 'Georgia',
        gradient: ['#a8d8ea', '#ffffff', '#a8d8ea'],
        shadowColor: '#66ccff',
        shadowBlur: 12,
        strokeColor: '#3399cc',
        strokeWidth: 1,
    },
    shadow: {
        name: 'Long Shadow',
        bg: 'transparent',
        color: '#ffffff',
        font: 'Arial Black',
        longShadow: true,
        longShadowColor: 'rgba(0,0,0,0.3)',
        longShadowLength: 15,
    },
    outline: {
        name: 'Outline Only',
        bg: 'transparent',
        color: 'transparent',
        font: 'Montserrat',
        strokeColor: '#ffffff',
        strokeWidth: 3,
    },
    glitch: {
        name: 'Glitch',
        bg: 'transparent',
        color: '#ffffff',
        font: 'Courier New',
        glitch: true,
        glitchColors: ['#ff0000', '#00ffff', '#ffff00'],
    },
    gradient: {
        name: 'Rainbow Gradient',
        bg: 'transparent',
        font: 'Arial Black',
        gradient: ['#ff0000', '#ff7700', '#ffff00', '#00ff00', '#0000ff', '#8b00ff'],
        strokeColor: 'rgba(0,0,0,0.3)',
        strokeWidth: 2,
    },
    streamer: {
        name: 'Streamer',
        bg: 'transparent',
        font: 'Bangers',
        gradient: ['#c0965c', '#fff'],
        shadowColor: '#000',
        shadowBlur: 8,
        strokeColor: '#000',
        strokeWidth: 4,
    },
    pixel: {
        name: 'Pixel Art',
        bg: 'transparent',
        color: '#ffffff',
        font: 'Press Start 2P',
        shadowColor: '#333333',
        shadowOffsetX: 4,
        shadowOffsetY: 4,
        shadowBlur: 0,
    },
    badge: {
        name: 'Badge',
        bg: '#c0965c',
        bgShape: 'roundedRect',
        bgPadding: 30,
        bgRadius: 16,
        color: '#0b0c12',
        font: 'Inter',
        fontWeight: '700',
    },
    sticker: {
        name: 'Sticker',
        bg: '#ffffff',
        bgShape: 'roundedRect',
        bgPadding: 24,
        bgRadius: 50,
        color: '#0b0c12',
        font: 'Inter',
        fontWeight: '700',
        strokeColor: '#0b0c12',
        strokeWidth: 3,
    },
};

// ── Google Fonts loader ──────────────────────────────────────
const loadedFonts = new Set(['Arial', 'Arial Black', 'Courier New', 'Georgia', 'Impact', 'Times New Roman', 'Verdana']);

async function loadFont(fontName) {
    if (loadedFonts.has(fontName)) return;
    try {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontName)}:wght@400;700;900&display=swap`;
        document.head.appendChild(link);
        await document.fonts.load(`48px "${fontName}"`);
        loadedFonts.add(fontName);
    } catch (e) {
        console.warn(`Failed to load font: ${fontName}`, e);
    }
}

// ── Core render function ─────────────────────────────────────
async function render(canvas, text, options = {}) {
    const ctx = canvas.getContext('2d');
    const opts = { ...PRESETS.minimal, ...options };

    const fontSize = opts.fontSize || 72;
    const fontWeight = opts.fontWeight || '700';
    const fontFamily = opts.font || 'Inter';
    const padding = opts.padding || 40;
    const lineHeight = opts.lineHeight || 1.3;

    // Load font
    await loadFont(fontFamily);

    // Set up font
    ctx.font = `${fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
    ctx.textBaseline = 'top';

    // Measure text (handle multi-line)
    const lines = text.split('\n');
    const measurements = lines.map(line => ctx.measureText(line));
    const maxWidth = Math.max(...measurements.map(m => m.width));
    const totalHeight = lines.length * fontSize * lineHeight;

    // Resize canvas
    const extraPad = opts.bgPadding || 0;
    canvas.width = Math.ceil(maxWidth + padding * 2 + extraPad * 2);
    canvas.height = Math.ceil(totalHeight + padding * 2 + extraPad * 2);

    // Re-set font after resize (canvas reset clears context)
    ctx.font = `${fontWeight} ${fontSize}px "${fontFamily}", sans-serif`;
    ctx.textBaseline = 'top';

    // Clear
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    if (opts.bg && opts.bg !== 'transparent') {
        if (opts.bgShape === 'roundedRect') {
            roundedRect(ctx, 0, 0, canvas.width, canvas.height, opts.bgRadius || 16, opts.bg);
        } else if (opts.bgShape === 'circle') {
            ctx.fillStyle = opts.bg;
            ctx.beginPath();
            ctx.arc(canvas.width / 2, canvas.height / 2, Math.max(canvas.width, canvas.height) / 2, 0, Math.PI * 2);
            ctx.fill();
        } else {
            ctx.fillStyle = opts.bg;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
    }

    const offsetX = padding + extraPad;
    const offsetY = padding + extraPad;

    // Long shadow effect
    if (opts.longShadow) {
        const len = opts.longShadowLength || 10;
        ctx.fillStyle = opts.longShadowColor || 'rgba(0,0,0,0.2)';
        for (let i = len; i > 0; i--) {
            lines.forEach((line, idx) => {
                const y = offsetY + idx * fontSize * lineHeight;
                ctx.fillText(line, offsetX + i, y + i);
            });
        }
    }

    // Glitch effect layers
    if (opts.glitch && opts.glitchColors) {
        opts.glitchColors.forEach((color, gi) => {
            ctx.fillStyle = color;
            ctx.globalAlpha = 0.6;
            const gx = (gi - 1) * 4;
            const gy = (gi - 1) * 2;
            lines.forEach((line, idx) => {
                const y = offsetY + idx * fontSize * lineHeight;
                ctx.fillText(line, offsetX + gx, y + gy);
            });
        });
        ctx.globalAlpha = 1;
    }

    // Shadow
    if (opts.shadowColor && opts.shadowColor !== 'transparent') {
        ctx.shadowColor = opts.shadowColor;
        ctx.shadowBlur = opts.shadowBlur || 0;
        ctx.shadowOffsetX = opts.shadowOffsetX || 0;
        ctx.shadowOffsetY = opts.shadowOffsetY || 0;
    }

    // Text fill (color or gradient)
    if (opts.gradient && opts.gradient.length >= 2) {
        const grad = ctx.createLinearGradient(offsetX, offsetY, offsetX, offsetY + totalHeight);
        opts.gradient.forEach((color, i) => grad.addColorStop(i / (opts.gradient.length - 1), color));
        ctx.fillStyle = grad;
    } else {
        ctx.fillStyle = opts.color || '#ffffff';
    }

    // Draw text
    if (opts.color !== 'transparent') {
        lines.forEach((line, idx) => {
            const y = offsetY + idx * fontSize * lineHeight;
            // Center each line
            const lw = ctx.measureText(line).width;
            const lx = offsetX + (maxWidth - lw) / 2;
            ctx.fillText(line, opts.textAlign === 'left' ? offsetX : lx, y);
        });
    }

    // Reset shadow before stroke
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;

    // Stroke
    if (opts.strokeColor && opts.strokeWidth) {
        ctx.strokeStyle = opts.strokeColor;
        ctx.lineWidth = opts.strokeWidth;
        ctx.lineJoin = 'round';
        lines.forEach((line, idx) => {
            const y = offsetY + idx * fontSize * lineHeight;
            const lw = ctx.measureText(line).width;
            const lx = offsetX + (maxWidth - lw) / 2;
            ctx.strokeText(line, opts.textAlign === 'left' ? offsetX : lx, y);
        });
    }
}

function roundedRect(ctx, x, y, w, h, r, fill) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
}

// ── Watermark rendering ──────────────────────────────────────
async function renderWatermark(canvas, image, text, options = {}) {
    const ctx = canvas.getContext('2d');
    const opts = {
        font: 'Inter',
        fontSize: 24,
        color: 'rgba(255,255,255,0.3)',
        position: 'bottom-right', // top-left, top-right, bottom-left, bottom-right, center, tile
        padding: 20,
        rotation: 0,
        ...options,
    };

    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    ctx.drawImage(image, 0, 0);

    await loadFont(opts.font);
    ctx.font = `${opts.fontSize}px "${opts.font}"`;
    ctx.fillStyle = opts.color;
    ctx.textBaseline = 'bottom';

    if (opts.position === 'tile') {
        // Tile watermarks across image
        ctx.globalAlpha = 0.15;
        ctx.save();
        ctx.rotate((opts.rotation || -30) * Math.PI / 180);
        const tw = ctx.measureText(text).width + 100;
        const th = opts.fontSize * 3;
        for (let y = -canvas.height; y < canvas.height * 2; y += th) {
            for (let x = -canvas.width; x < canvas.width * 2; x += tw) {
                ctx.fillText(text, x, y);
            }
        }
        ctx.restore();
        ctx.globalAlpha = 1;
    } else {
        const tw = ctx.measureText(text).width;
        let x, y;
        switch (opts.position) {
            case 'top-left':     x = opts.padding; y = opts.padding + opts.fontSize; break;
            case 'top-right':    x = canvas.width - tw - opts.padding; y = opts.padding + opts.fontSize; break;
            case 'bottom-left':  x = opts.padding; y = canvas.height - opts.padding; break;
            case 'center':       x = (canvas.width - tw) / 2; y = canvas.height / 2; break;
            default:             x = canvas.width - tw - opts.padding; y = canvas.height - opts.padding;
        }
        ctx.fillText(text, x, y);
    }
}

// ── Export functions ──────────────────────────────────────────
function exportPNG(canvas) {
    return canvas.toDataURL('image/png');
}

function exportWebP(canvas, quality = 0.92) {
    return canvas.toDataURL('image/webp', quality);
}

function download(canvas, filename = 'openvibe-logo.png', format = 'png') {
    const mimeTypes = { png: 'image/png', webp: 'image/webp', jpeg: 'image/jpeg' };
    const url = canvas.toDataURL(mimeTypes[format] || 'image/png', 0.92);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    link.click();
}

// ── Popular Google Fonts for logos ────────────────────────────
const POPULAR_FONTS = [
    'Inter', 'Montserrat', 'Playfair Display', 'Oswald', 'Roboto', 'Lato',
    'Raleway', 'Poppins', 'Merriweather', 'Source Sans 3', 'Nunito',
    'Ubuntu', 'Rubik', 'Work Sans', 'Fira Sans', 'Quicksand',
    'Bangers', 'Permanent Marker', 'Bebas Neue', 'Righteous',
    'Orbitron', 'Press Start 2P', 'Silkscreen', 'Audiowide',
    'Pacifico', 'Dancing Script', 'Lobster', 'Satisfy', 'Caveat',
    'Abril Fatface', 'Alfa Slab One', 'Anton', 'Black Ops One',
    'Bungee', 'Bungee Shade', 'Comfortaa', 'Concert One',
    'Creepster', 'Fredoka One', 'Graduate', 'Luckiest Guy',
    'Special Elite', 'Staatliches', 'VT323', 'Zilla Slab',
];

// ── Public API ───────────────────────────────────────────────
const LogoOpenVibeEngine = {
    presets: PRESETS,
    fonts: POPULAR_FONTS,
    render,
    renderWatermark,
    loadFont,
    exportPNG,
    exportWebP,
    download,
};

if (typeof module !== 'undefined' && module.exports) {
    module.exports = LogoOpenVibeEngine;
} else {
    root.LogoOpenVibeEngine = LogoOpenVibeEngine;
}

})(typeof window !== 'undefined' ? window : this);
