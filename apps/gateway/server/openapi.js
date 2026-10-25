'use strict';
/**
 * OpenAPI 3.1 for the Tools platform API (ADR-027), generated from the tool descriptors (tools.tool@1),
 * so it can never drift from what the gateway serves: GET /api/v1/openapi.json.
 *
 *   /api/v1/tools, /api/v1/tools/{id}, /api/v1/tools/{id}/schema    the registry (public, CORS *)
 *   /api/v1/tools/<id>/run                                            one path per tool with an API, its input
 *                                                                     schema and an example inline
 *   /api/v1/jobs/{id}, /events, /files/{n}, /retry                    the jobs facade
 *
 * Shared shapes point at the openvibe-contracts schemas by their $id (tools.run@1, tools.job@1, …).
 */
const C = 'https://openvibe.network/contracts/tools';
const ref = (name) => ({ $ref: `${C}/${name}.v1.json` });
const problem = { description: 'RFC 9457 problem (application/problem+json)', content: { 'application/problem+json': { schema: { type: 'object', required: ['type', 'title', 'status'], properties: { type: { type: 'string' }, title: { type: 'string' }, status: { type: 'integer' }, code: { type: 'string' }, detail: { type: 'string' } } } } } };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,39}$' } };
const jobParam = { name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^job_[0-9A-HJKMNP-TV-Z]{26}$' } };

function runPath(t) {
    const withFiles = !!(t.files && t.files.max > 0);
    const input = t.input && typeof t.input === 'object' && !t.input.$ref ? t.input : { type: 'object' };
    const json = { type: 'object', required: ['input'], additionalProperties: false, properties: { input, wait_ms: { type: 'integer', minimum: 0, maximum: 60000 }, idempotency_key: { type: 'string', maxLength: 200 } } };
    const body = withFiles
        ? { 'multipart/form-data': { schema: { type: 'object', required: ['file'], properties: { file: { type: 'array', items: { type: 'string', format: 'binary' }, minItems: t.files.min || 0, maxItems: t.files.max }, input: { type: 'string', description: 'JSON of the input object' }, wait_ms: { type: 'integer' }, idempotency_key: { type: 'string' } } } } }
        : { 'application/json': { schema: json, ...(t.examples && t.examples[0] ? { example: { input: t.examples[0].input } } : {}) } };
    const security = t.auth && t.auth.anonymous ? [{}, { bearer: [] }] : [{ bearer: [] }];
    return {
        post: {
            operationId: `run_${t.id.replace(/-/g, '_')}`,
            summary: `${t.name}: ${t.summary}`.slice(0, 200),
            tags: [t.family],
            description: [`Capability ${t.auth ? t.auth.capability : 'tools.tool.run'}${t.auth && t.auth.anonymous ? ' (anonymous callers allowed, on the lowest quota tier)' : ' (a token or browser session is required)'}.`,
                `Runs as a ${t.execution === 'job' ? `job (${t.run && t.run.job ? t.run.job.type : 'job'}): 202 with the job unless it finishes within wait_ms` : 'direct call'}; timeout ${t.limits.timeoutMs} ms.`,
                t.egress ? 'Reaches out to the host you name; throttled per target.' : null].filter(Boolean).join(' '),
            security,
            parameters: [{ name: 'Idempotency-Key', in: 'header', required: false, schema: { type: 'string', maxLength: 200 } }],
            requestBody: { required: true, content: body },
            responses: {
                200: { description: 'Finished (tools.run@1: state succeeded)', content: { 'application/json': { schema: ref('run') } } },
                202: { description: 'Still running: follow the job (tools.run@1: state queued|running, job, location)', headers: { Location: { schema: { type: 'string' } } }, content: { 'application/json': { schema: ref('run') } } },
                400: problem, 401: problem, 403: problem, 404: problem, 413: problem, 415: problem, 422: problem, 429: { ...problem, headers: { 'Retry-After': { schema: { type: 'integer' } } } }, 503: problem, 504: problem,
            },
        },
    };
}

function openapi(snapshot, site) {
    const tools = (snapshot.tools || []).filter((t) => t.api && t.run && t.status !== 'unavailable');
    const paths = {
        '/api/v1/tools': { get: { operationId: 'listTools', summary: 'The tool registry (tools.tool-list@1)', tags: ['registry'], parameters: ['family', 'q', 'execution', 'api'].map((n) => ({ name: n, in: 'query', required: false, schema: { type: 'string' } })), responses: { 200: { description: 'Every tool', content: { 'application/json': { schema: ref('tool-list') } } } } } },
        '/api/v1/tools/{id}': { get: { operationId: 'getTool', summary: 'One tool\'s descriptor (tools.tool@1)', tags: ['registry'], parameters: [idParam], responses: { 200: { description: 'The descriptor', content: { 'application/json': { schema: ref('tool') } } }, 404: problem } } },
        '/api/v1/tools/{id}/schema': { get: { operationId: 'getToolSchema', summary: 'A tool\'s input and output JSON Schemas', tags: ['registry'], parameters: [idParam], responses: { 200: { description: '{ $schema, $id, $defs: { input, output } }' }, 404: problem } } },
        '/api/v1/jobs/{id}': { get: { operationId: 'getJob', summary: 'A job (tools.job@1)', tags: ['jobs'], security: [{ bearer: [] }, {}], parameters: [jobParam], responses: { 200: { description: 'The job', content: { 'application/json': { schema: ref('job') } } }, 404: problem } },
            delete: { operationId: 'cancelJob', summary: 'Cancel a job', tags: ['jobs'], security: [{ bearer: [] }, {}], parameters: [jobParam], responses: { 200: { description: 'Cancelled (or already finished)' }, 404: problem } } },
        '/api/v1/jobs/{id}/events': { get: { operationId: 'jobEvents', summary: 'Job progress as server-sent events (Last-Event-ID resumes)', tags: ['jobs'], security: [{ bearer: [] }, {}], parameters: [jobParam], responses: { 200: { description: 'text/event-stream' } } } },
        '/api/v1/jobs/{id}/files/{n}': { get: { operationId: 'jobFile', summary: 'Download result file n', tags: ['jobs'], security: [{ bearer: [] }, {}], parameters: [jobParam, { name: 'n', in: 'path', required: true, schema: { type: 'integer', minimum: 0 } }], responses: { 200: { description: 'The file' }, 404: problem } } },
        '/api/v1/jobs/{id}/retry': { post: { operationId: 'retryJob', summary: 'Retry a failed job', tags: ['jobs'], security: [{ bearer: [] }, {}], parameters: [jobParam], responses: { 200: { description: 'The new job', content: { 'application/json': { schema: ref('job') } } }, 409: problem } } },
    };
    // Every code as an image URL (server/codes/image.js): no account, the same URL always draws the same image.
    const q = (name, description, schema = { type: 'string' }) => ({ name, in: 'query', required: false, description, schema });
    paths['/api/codes'] = { get: { operationId: 'listCodeSymbologies', summary: 'Every barcode and QR symbology the image URLs draw, with an example each', tags: ['codes'], responses: { 200: { description: '{ usage, aliases, symbologies: [{ id, name, example }] }' } } } };
    paths['/api/codes/{symbology}.{format}'] = { get: {
        operationId: 'codeImage', summary: 'A barcode or QR code as an SVG or PNG image (embed it in <img>, Markdown or a label)', tags: ['codes'],
        description: 'symbology: any id from /api/codes (qrcode, ean13, code128, datamatrix, pdf417, azteccode…), or qr, auto (the symbology that fits the text), wifi (ssid, password, security, hidden) or vcard (first, last, phone, email, org, title, url, address). Cached for a year; 300 requests a minute per address.',
        parameters: [
            { name: 'symbology', in: 'path', required: true, schema: { type: 'string', pattern: '^[a-z0-9-]{2,40}$' } },
            { name: 'format', in: 'path', required: true, schema: { enum: ['svg', 'png'] } },
            q('text', 'What to encode (up to 2000 characters); not for wifi or vcard'), q('scale', 'PNG pixels per module, 1-12 (default 4)', { type: 'integer', minimum: 1, maximum: 12 }),
            q('height', 'Bar height in mm (barcodes)', { type: 'number' }), q('hrt', '0 hides the human-readable line'), q('color', 'rrggbb'), q('background', 'rrggbb or transparent'),
            q('quiet', 'Quiet zone in modules', { type: 'integer' }), q('rotate', 'N, R, I or L'), q('ecc', 'QR error correction: L, M, Q or H'), q('eclevel', 'Error correction as other symbologies name it'), q('addon', 'EAN-2 or EAN-5 add-on'),
        ],
        responses: { 200: { description: 'The image', content: { 'image/svg+xml': {}, 'image/png': {} } }, 422: { description: 'Why the text cannot be drawn (text/plain)' }, 429: { description: 'Too many requests (Retry-After)' } },
    } };
    for (const t of tools) paths[t.run.path] = runPath(t);
    return {
        openapi: '3.1.0',
        info: {
            title: 'OpenVibe.Tools API', version: String(snapshot.version || '1'),
            description: `Every tool on ${site} with an API, generated from the tool descriptors (tools.tool@1). Anonymous calls run on the lowest quota tier; a Network service or app token (audience openvibe.tools) raises it. The SDK is openvibe-sdk/tools (createToolsClient). Errors are RFC 9457 problems; 429 carries Retry-After.`,
            license: { name: 'MIT' }, contact: { name: 'OpenVibers', url: 'https://github.com/OpenVibers/OpenVibe.Tools', email: 'contact@openvibe.network' },
        },
        servers: [{ url: site }],
        tags: [{ name: 'registry' }, { name: 'jobs' }, ...[...new Set([...tools.map((t) => t.family), 'codes'])].sort().map((f) => ({ name: f }))],
        components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'A Network service or app token for audience openvibe.tools (tools.tool.run; tools.net.probe for probes)' } } },
        paths,
    };
}

module.exports = { openapi };
