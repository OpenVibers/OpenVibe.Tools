'use strict';

// ═══════════════════════════════════════════════════════════════
// SEO catalog — one record per tool subdomain.
//
// Every dev.* and net.* tool used to share a single SPA file, which meant ~65 subdomains
// all served the same <title>, the same description and a canonical pointing at the hub.
// Search engines saw one page, not sixty-five. This catalog gives each tool its own
// search-friendly identity, and seo/render.js stamps it into the HTML per request.
//
//   name     what the tool is called everywhere (no "OpenVibe" prefix — people search
//            for "json formatter", not for our brand)
//   title    <title> — primary keyword first, qualifier second, brand last
//   desc     <meta name="description"> — one sentence, ~150 chars, says what you get
//   kw       comma-separated keywords (also used to pick related tools)
//   about    visible intro paragraph under the tool (real content, not hidden text)
//   bullets  visible feature list
//   faq      visible Q&A + FAQPage structured data
// ═══════════════════════════════════════════════════════════════

const BRAND = 'OpenVibe';

// ── Dev & SEO tools (dev.openvibe.tools) ─────────────────────
const DEV = {
    dev: {
        name: 'Developer Tools', title: 'Online Developer Tools — Formatters, Encoders & Validators',
        desc: 'A fast developer toolbox: JSON, YAML and XML formatters, Base64 and JWT decoders, regex tester, diff checker, hash generator and more. No signup, nothing leaves your browser.',
        kw: 'developer tools, online tools, dev tools, formatter, encoder, decoder, validator',
        about: 'A collection of small, fast developer utilities that run entirely in your browser. Nothing is uploaded, nothing is logged, and there is no account to create — open a tool, paste your data, get your answer.',
        bullets: ['Every tool works client-side: your data never leaves the browser', 'No signup and no rate limits on the offline tools', 'Open source and part of the wider OpenVibe network'],
        faq: [['Do I need an account?', 'No. Every tool here works with no account, no trial and no usage cap. The project is community-run and open source.'], ['Is my data sent to a server?', 'The formatting, encoding and generation tools run entirely in your browser, so your data never leaves your machine. Only tools that must reach the network (like the Open Graph preview and webhook inspector) send a request, and they say so on the page.']],
    },
    jsonfmt: {
        name: 'JSON Formatter', title: 'JSON Formatter & Validator — Online JSON Beautifier',
        desc: 'Format, validate and minify JSON online. Pretty-print messy JSON, catch syntax errors with line numbers, and compact it back down. Instant, runs in your browser.',
        kw: 'json formatter, json validator, json beautifier, json minifier, pretty print json, json parser online',
        about: 'Paste any JSON to pretty-print it with consistent indentation, validate it against the JSON spec, or minify it for production. Errors are reported with the exact position so you can find the stray comma fast.',
        bullets: ['Beautify with clean indentation, or minify to the smallest valid output', 'Validation errors point at the line and character that broke the parse', 'Handles large documents without uploading them anywhere'],
        faq: [['How do I fix "Unexpected token" errors in JSON?', 'Paste the JSON here and press Validate. The error message names the exact character position, which is almost always a trailing comma, a single quote instead of a double quote, or an unquoted key.'], ['Does this JSON formatter upload my data?', 'No. Parsing and formatting happen in your browser, so the JSON never reaches our servers.']],
    },
    yaml: {
        name: 'YAML to JSON Converter', title: 'YAML to JSON Converter & YAML Validator — Online Tool',
        desc: 'Convert YAML to JSON and JSON to YAML online, and validate YAML syntax instantly. Ideal for Kubernetes manifests, CI pipelines and config files. No signup.',
        kw: 'yaml to json, json to yaml, yaml converter, yaml validator, yaml parser online, kubernetes yaml',
        about: 'Convert between YAML and JSON in either direction and check that your YAML actually parses. Useful whenever you are moving between a config file and an API payload, or debugging an indentation mistake in a CI or Kubernetes file.',
        bullets: ['YAML → JSON and JSON → YAML with one click', 'Catches the indentation and tab errors that break YAML parsers', 'Keeps nested structures, lists and multi-line strings intact'],
        faq: [['Why does my YAML fail to parse?', 'YAML forbids tab characters for indentation and is strict about consistent spacing. Paste it here and the parser reports the line where the structure breaks.'], ['Can I convert Kubernetes manifests to JSON?', 'Yes. Kubernetes accepts both formats, and converting to JSON is a quick way to verify exactly what a manifest resolves to.']],
    },
    xml: {
        name: 'XML Formatter', title: 'XML Formatter & Validator — Online XML Beautifier',
        desc: 'Format, validate and minify XML online. Pretty-print nested XML, check that tags are well-formed, and compact documents. Instant in your browser.',
        kw: 'xml formatter, xml validator, xml beautifier, pretty print xml, xml parser online, format xml',
        about: 'Pretty-print XML with proper nesting, confirm a document is well-formed, or strip whitespace to minify it. Handy for SOAP payloads, RSS feeds, sitemaps and configuration files.',
        bullets: ['Readable indentation for deeply nested documents', 'Well-formedness checks with the position of the offending tag', 'Minify mode strips insignificant whitespace'],
        faq: [['What does "not well-formed" mean?', 'It means the document breaks a structural rule: an unclosed tag, mismatched case, or a stray angle bracket. The validator names the position so you can fix it.'], ['Can I format an RSS feed or sitemap with this?', 'Yes. Both are XML, so paste the feed or sitemap and it formats like any other document.']],
    },
    csv: {
        name: 'CSV to JSON Converter', title: 'CSV to JSON Converter & CSV Viewer — Online Tool',
        desc: 'Convert CSV to JSON and view CSV as a sortable table online. Handles quoted fields, commas inside values and custom headers. Instant, no upload.',
        kw: 'csv to json, csv viewer, csv converter, csv parser online, convert csv, csv table viewer',
        about: 'Paste CSV to see it as a clean table or convert it straight to a JSON array of objects using the first row as keys. Quoted fields and embedded commas are parsed correctly.',
        bullets: ['Table view for scanning a file quickly', 'CSV → JSON using the header row as object keys', 'Correctly handles quoted values containing commas and newlines'],
        faq: [['How does the converter handle commas inside a field?', 'Fields wrapped in double quotes are parsed as single values, so embedded commas and line breaks survive the conversion.'], ['Can I convert a spreadsheet export?', 'Yes. Export the sheet as CSV, paste it here, and convert to JSON or read it as a table.']],
    },
    sql: {
        name: 'SQL Formatter', title: 'SQL Formatter & Beautifier — Online Query Formatter',
        desc: 'Format and beautify SQL queries online. Turn one-line queries into readable, indented SQL with keyword highlighting. Works with any SQL dialect.',
        kw: 'sql formatter, sql beautifier, format sql online, sql pretty print, query formatter',
        about: 'Turn a long single-line query into properly indented SQL with keywords aligned, so joins and nested conditions are readable in a code review or a bug report.',
        bullets: ['Readable indentation for joins, subqueries and CTEs', 'Uppercase keyword mode for a consistent house style', 'Compact mode to put a query back on one line'],
        faq: [['Which SQL dialects are supported?', 'The formatter works on standard SQL syntax, which covers the vast majority of PostgreSQL, MySQL, SQLite and SQL Server queries.'], ['Is my query sent anywhere?', 'No. Formatting happens in your browser, so queries containing table or column names never leave your machine.']],
    },
    md: {
        name: 'Markdown Editor', title: 'Markdown Editor with Live Preview — Online Markdown to HTML',
        desc: 'Write Markdown and see the rendered HTML live. Convert Markdown to HTML, preview README files and copy the output. No signup, runs in your browser.',
        kw: 'markdown editor, markdown to html, markdown preview, online markdown, readme preview',
        about: 'Type Markdown on one side and watch the rendered result on the other. Useful for drafting a README, checking how a comment will render, or converting Markdown into HTML you can paste elsewhere.',
        bullets: ['Live side-by-side preview as you type', 'Headings, lists, tables, code blocks and links', 'Copy the generated HTML in one click'],
        faq: [['Does it support GitHub-flavoured Markdown?', 'The common extensions are covered: tables, fenced code blocks, task lists and strikethrough.'], ['Can I use this to preview a README before pushing?', 'Yes. Paste the file contents and the preview shows how the structure will render.']],
    },
    html: {
        name: 'HTML Formatter', title: 'HTML Formatter, Minifier & Entity Encoder — Online Tool',
        desc: 'Format, minify and escape HTML online. Beautify messy markup, compress it for production, or encode HTML entities safely. Instant.',
        kw: 'html formatter, html minifier, html beautifier, html entity encoder, format html online',
        about: 'Clean up unreadable markup, shrink it for production, or convert characters to HTML entities so user content can be displayed without breaking the page.',
        bullets: ['Beautify with consistent tag indentation', 'Minify by stripping comments and redundant whitespace', 'Entity encoding for safely displaying markup as text'],
        faq: [['When should I encode HTML entities?', 'Any time you display text that a user supplied. Encoding turns characters like < and > into entities so the browser renders them as text instead of executing them as markup.'], ['Does minifying HTML break my page?', 'The minifier only removes whitespace and comments that do not affect rendering. Content inside pre and textarea elements is preserved.']],
    },
    base64: {
        name: 'Base64 Encoder & Decoder', title: 'Base64 Encode & Decode Online — Base64 Converter',
        desc: 'Encode text to Base64 and decode Base64 back to text online. UTF-8 safe, handles data URIs, and runs entirely in your browser. No signup.',
        kw: 'base64 encode, base64 decode, base64 converter, base64 online, decode base64 string',
        about: 'Convert text to Base64 and back. Useful for reading an encoded token, building a data URI, or inspecting a value copied out of a config file or HTTP header.',
        bullets: ['Encode and decode with full UTF-8 support', 'Decodes padded and unpadded input', 'Everything runs locally — safe for tokens and credentials'],
        faq: [['Is Base64 encryption?', 'No. Base64 is an encoding, not encryption — anyone can decode it. It exists to move binary data safely through text-only channels.'], ['Is it safe to decode a token here?', 'Yes. Decoding happens in your browser and nothing is transmitted or stored.']],
    },
    url: {
        name: 'URL Encoder & Decoder', title: 'URL Encode & Decode Online — Percent-Encoding Tool',
        desc: 'Encode and decode URLs online, and break any URL into its parts. Handles percent-encoding, query strings and parameters. Instant.',
        kw: 'url encode, url decode, percent encoding, url parser, query string parser, urlencode online',
        about: 'Percent-encode a string for safe use in a URL, decode one you have been handed, or split a full URL into protocol, host, path, query parameters and fragment.',
        bullets: ['Encode and decode with correct percent-encoding rules', 'Parse a URL into its components and query parameters', 'Useful for debugging redirects, callbacks and tracking links'],
        faq: [['What is the difference between encodeURI and encodeURIComponent?', 'encodeURI leaves characters that have meaning in a URL (like / and ?) alone, while encodeURIComponent encodes them too. Use the component version for individual query values.'], ['Why does my query parameter break?', 'Usually an unencoded ampersand or equals sign inside a value. Encoding the value fixes it.']],
    },
    jwt: {
        name: 'JWT Decoder', title: 'JWT Decoder — Decode JSON Web Tokens Online',
        desc: 'Decode a JWT to inspect its header, payload and expiry. See claims, issued-at and expiration times in readable form. Runs in your browser — tokens are never sent.',
        kw: 'jwt decoder, decode jwt, json web token decoder, jwt parser, jwt payload viewer',
        about: 'Paste a JSON Web Token to read its header and payload, with timestamps rendered as dates and the expiry checked against the current time. Decoding happens locally, so tokens stay on your machine.',
        bullets: ['Header, payload and signature split out clearly', 'Expiry and issued-at shown as human-readable dates', 'Nothing is transmitted — safe for real access tokens'],
        faq: [['Does decoding a JWT verify its signature?', 'No. Decoding only reads the token contents. Verifying the signature needs the issuer\'s secret or public key, which should only ever happen on your server.'], ['Is it safe to paste a live token here?', 'Yes. The token is parsed in your browser and never sent over the network.']],
    },
    uuid: {
        name: 'UUID Generator', title: 'UUID Generator — Online UUID v4 Generator & Validator',
        desc: 'Generate random UUID v4 identifiers, create them in bulk, and validate existing UUIDs. Cryptographically random, instant, no signup.',
        kw: 'uuid generator, guid generator, uuid v4, random uuid, uuid validator, generate uuid online',
        about: 'Generate version 4 UUIDs using your browser\'s cryptographic random source, produce a batch for seeding a database, or check whether a string is a valid UUID.',
        bullets: ['Cryptographically random UUID v4 values', 'Bulk generation for test data and migrations', 'Validation for UUIDs of any version'],
        faq: [['Are these UUIDs safe to use in production?', 'Yes. They come from the browser\'s crypto random generator, the same source server-side libraries use.'], ['What is the difference between a UUID and a GUID?', 'They are the same thing. GUID is Microsoft\'s name for the same 128-bit identifier format.']],
    },
    hash: {
        name: 'Hash Generator', title: 'SHA-256 Hash Generator — Online SHA-1, SHA-256 & SHA-512',
        desc: 'Generate SHA-1, SHA-256 and SHA-512 hashes from any text online. Useful for checksums, fingerprints and integrity checks. Computed in your browser.',
        kw: 'sha256 generator, hash generator, sha1 hash, sha512, checksum generator, hash text online',
        about: 'Produce a cryptographic hash of any text using SHA-1, SHA-256 or SHA-512. Handy for verifying a checksum, generating a fingerprint, or comparing two values without storing the originals.',
        bullets: ['SHA-1, SHA-256 and SHA-512 from the same input', 'Uses the browser\'s native Web Crypto implementation', 'Nothing is uploaded — safe for sensitive strings'],
        faq: [['Can a hash be reversed?', 'No. Hashes are one-way. Identical input always produces identical output, but you cannot recover the input from the hash.'], ['Which algorithm should I use?', 'SHA-256 for almost everything. SHA-1 is only useful for compatibility with older systems, as it is no longer considered collision-resistant.']],
    },
    hex: {
        name: 'Hex Converter', title: 'Hex to Text Converter — Online Hex, Binary & ASCII Tool',
        desc: 'Convert text to hexadecimal, decode hex back to text, and switch between hex, binary and decimal. Instant, runs in your browser.',
        kw: 'hex to text, text to hex, hex converter, hex decoder, binary converter, ascii to hex',
        about: 'Convert between text, hexadecimal and binary. Useful when reading a memory dump, decoding a protocol payload, or converting a byte sequence you found in a log.',
        bullets: ['Text ⇄ hex with UTF-8 handling', 'Hex ⇄ binary and decimal conversion', 'Accepts spaced, prefixed or continuous hex input'],
        faq: [['What do the 0x prefixes mean?', 'They mark a number as hexadecimal in most programming languages. The converter accepts input with or without them.'], ['Why do some characters become several hex bytes?', 'Non-ASCII characters take more than one byte in UTF-8, so an emoji or accented letter maps to several hex pairs.']],
    },
    entities: {
        name: 'String Escape Tool', title: 'HTML, JavaScript & URL Escape Tool — Online Escaper',
        desc: 'Escape and unescape strings for HTML, JavaScript and URLs. Prevent injection bugs and safely embed text in code. Instant.',
        kw: 'escape html, unescape string, javascript escape, escape characters online, string escaper',
        about: 'Escape a string so it can be safely embedded in HTML, in a JavaScript literal, or in a URL — and reverse the process when you need the original text back.',
        bullets: ['HTML entity escaping for safe display of user content', 'JavaScript string escaping including quotes and newlines', 'URL escaping for query values and path segments'],
        faq: [['Why does escaping matter for security?', 'Unescaped user input is how cross-site scripting happens. Escaping ensures text is displayed as text rather than executed as markup or code.'], ['Which mode should I use?', 'Match the destination: HTML escaping for page content, JavaScript escaping for code literals, URL escaping for anything going into a link.']],
    },
    timestamp: {
        name: 'Unix Timestamp Converter', title: 'Unix Timestamp Converter — Epoch to Date',
        desc: 'Convert Unix timestamps to human-readable dates and back, with timezone support. Handles seconds and milliseconds. Instant, no signup.',
        kw: 'unix timestamp converter, epoch converter, timestamp to date, date to timestamp, epoch time',
        about: 'Turn an epoch timestamp into a readable date in any timezone, or convert a date back into a timestamp. Both seconds and milliseconds are detected automatically.',
        bullets: ['Epoch ⇄ date in both directions', 'Automatic detection of seconds vs milliseconds', 'Timezone-aware output including UTC and local time'],
        faq: [['Is my timestamp in seconds or milliseconds?', 'Ten digits is seconds, thirteen is milliseconds. The converter detects which you pasted and labels the result.'], ['What is the Unix epoch?', 'Midnight UTC on 1 January 1970. A Unix timestamp counts the seconds elapsed since that moment.']],
    },
    cron: {
        name: 'Cron Expression Parser', title: 'Cron Expression Parser — Explain Cron Schedules Online',
        desc: 'Decode any cron expression into plain English and see the next run times. Validate crontab syntax before you deploy it. Instant.',
        kw: 'cron expression parser, crontab generator, cron schedule explained, next run time, cron validator',
        about: 'Paste a cron expression to read it in plain English and see exactly when it will fire next. Saves guessing whether a schedule means every five minutes or five past the hour.',
        bullets: ['Plain-English description of any cron expression', 'A list of upcoming run times so you can sanity-check the schedule', 'Validates the syntax before you commit it to a crontab'],
        faq: [['What does */5 * * * * mean?', 'Every five minutes, on every hour, day and month. Paste any expression here for a written explanation and the next run times.'], ['Why did my cron job not run?', 'Most often the field order is wrong (minute, hour, day of month, month, day of week) or the day-of-week and day-of-month fields conflict. The parser shows the interpreted schedule so you can spot it.']],
    },
    beautify: {
        name: 'Code Beautifier', title: 'Code Beautifier — Online JS, CSS, HTML, JSON & SQL Formatter',
        desc: 'Beautify JavaScript, CSS, HTML, JSON and SQL online. Turn minified or messy code into clean, indented, readable source. Instant, no signup.',
        kw: 'code beautifier, javascript formatter, css formatter, unminify, code formatter online, prettify code',
        about: 'Paste minified or badly formatted code and get readable, consistently indented source back. Works across JavaScript, CSS, HTML, JSON and SQL, which makes it useful for reading third-party bundles.',
        bullets: ['One tool for JS, CSS, HTML, JSON and SQL', 'Consistent indentation and line breaks', 'Great for reading minified production code'],
        faq: [['Can this recover minified code?', 'It restores structure and indentation so the code is readable, but names that a minifier shortened cannot be recovered.'], ['Does beautifying change what the code does?', 'No. Only whitespace and line breaks change; the code is functionally identical.']],
    },
    minify: {
        name: 'Code Minifier', title: 'Code Minifier — Online JS, CSS, HTML & JSON Minifier',
        desc: 'Minify JavaScript, CSS, HTML and JSON online to cut file size and speed up your site. Instant, runs entirely in your browser.',
        kw: 'minify javascript, css minifier, html minifier, json minifier, compress code online',
        about: 'Strip comments and unnecessary whitespace to shrink files before shipping them. Smaller payloads mean faster page loads, which is one of the ranking signals search engines actually measure.',
        bullets: ['JavaScript, CSS, HTML and JSON in one place', 'Shows the size saved by the minification', 'Runs locally — no upload, no build step required'],
        faq: [['How much smaller will my file get?', 'Typically 20–60% before compression, depending on how much whitespace and commenting the source contains. The tool reports the exact saving.'], ['Should I minify if my server uses gzip?', 'Yes. Minification and gzip compound: minifying first removes content gzip would otherwise have to encode.']],
    },
    codediff: {
        name: 'Diff Checker', title: 'Diff Checker — Compare Text & Code Online',
        desc: 'Compare two blocks of text or code side by side and see every addition, deletion and change highlighted. Instant, private to your browser.',
        kw: 'diff checker, compare text, text comparison, code diff, file compare online, difference checker',
        about: 'Paste two versions of a file, a config or a paragraph and see exactly what changed, line by line, with additions and removals highlighted.',
        bullets: ['Side-by-side comparison with highlighted changes', 'Works on prose, code, config files and logs', 'Nothing is uploaded, so it is safe for private files'],
        faq: [['Can I compare two config files?', 'Yes. Paste each version into one side; the differences are highlighted line by line.'], ['Is there a size limit?', 'The comparison runs in your browser, so the practical limit is your machine\'s memory rather than an upload cap.']],
    },
    regex: {
        name: 'Regex Tester', title: 'Regex Tester — Test Regular Expressions Online',
        desc: 'Test regular expressions against sample text with live match highlighting and capture groups. Debug patterns before shipping them. Instant.',
        kw: 'regex tester, regular expression tester, regex online, test regex, regex match, regex debugger',
        about: 'Write a pattern, paste sample text, and watch matches highlight as you type. Capture groups are listed separately so you can confirm a pattern extracts what you expect before it reaches production.',
        bullets: ['Live highlighting of every match as you type', 'Named and numbered capture groups listed per match', 'Flag toggles for global, case-insensitive and multiline'],
        faq: [['Which regex flavour does this use?', 'JavaScript regular expressions, which are close to PCRE for everyday patterns. Lookbehind and named groups are supported in modern browsers.'], ['Why does my pattern match nothing?', 'Common causes are an unescaped special character, a missing global flag when you expect several matches, or anchors that assume single-line input.']],
    },
    slugify: {
        name: 'Slug Generator', title: 'URL Slug Generator — SEO-Friendly Slug Maker',
        desc: 'Turn any title into a clean, SEO-friendly URL slug. Removes accents and punctuation, lowercases and hyphenates. Instant.',
        kw: 'slug generator, url slug, seo friendly url, permalink generator, slugify text online',
        about: 'Convert a headline into a tidy URL slug: lowercase, hyphen-separated, accents folded and punctuation removed. Readable slugs help both people and search engines understand a page before they open it.',
        bullets: ['Accent folding so international titles produce clean ASCII slugs', 'Punctuation and stop-character stripping', 'Consistent hyphenation with no double separators'],
        faq: [['Do slugs affect SEO?', 'A short, descriptive slug containing your main keyword helps search engines and gives people a readable link, which improves click-through from search results.'], ['Should slugs contain dates or IDs?', 'Usually not. Keep them short and descriptive; dates age the URL and IDs mean nothing to a reader.']],
    },
    lorem: {
        name: 'Lorem Ipsum Generator', title: 'Lorem Ipsum Generator — Placeholder Text Generator',
        desc: 'Generate lorem ipsum placeholder text by words, sentences or paragraphs. Perfect for mockups, layouts and design drafts. Instant, no signup.',
        kw: 'lorem ipsum generator, placeholder text, dummy text generator, filler text, lipsum',
        about: 'Produce as much placeholder copy as your mockup needs, measured in words, sentences or paragraphs, so a layout can be reviewed without waiting on the real content.',
        bullets: ['Generate by word, sentence or paragraph count', 'Classic lorem ipsum text for familiar typographic colour', 'Copy straight into a design tool or HTML'],
        faq: [['Why use lorem ipsum instead of real text?', 'It has roughly the same letter distribution as natural prose, so a layout reads realistically without reviewers getting distracted by the wording.'], ['Can I generate a specific number of words?', 'Yes. Choose the unit and the amount, and the generator produces exactly that much text.']],
    },
    curlconvert: {
        name: 'curl Converter', title: 'curl Converter — Convert curl to fetch, Python & Node.js',
        desc: 'Paste a curl command and convert it to JavaScript fetch, Python requests or Node.js code. Great for turning browser "Copy as cURL" into working code.',
        kw: 'curl to fetch, curl converter, curl to python, curl to javascript, convert curl command',
        about: 'Take a curl command — including one copied straight from your browser\'s network tab — and turn it into equivalent code, with headers, method and body carried across.',
        bullets: ['Converts to fetch, Python requests and Node.js', 'Preserves headers, method, body and authentication', 'Works with "Copy as cURL" output from browser devtools'],
        faq: [['Where do I get a curl command to convert?', 'In any browser\'s devtools, right-click a request in the Network tab and choose "Copy as cURL". Paste it here to get code.'], ['Are my headers sent anywhere?', 'No. The conversion is pure text processing in your browser, so authorization headers stay local.']],
    },
    webhook: {
        name: 'Webhook Tester', title: 'Webhook Tester — Online Request Bin & Inspector',
        desc: 'Get a temporary webhook URL and inspect every request it receives: headers, body, method and query. Debug integrations without deploying anything.',
        kw: 'webhook tester, request bin, webhook debugger, http request inspector, test webhook online',
        about: 'Create a throwaway endpoint, point your integration at it, and read exactly what arrives — method, headers, query string and body — so you can confirm a provider is sending what its docs claim.',
        bullets: ['Instant URL with no account required', 'Full request detail: headers, body, method and query', 'Bins expire automatically so nothing lingers'],
        faq: [['How long does a webhook bin last?', 'Bins expire after about an hour and hold a capped number of recent requests, which is plenty for debugging an integration.'], ['Can I use this for production traffic?', 'No. It is a debugging aid — bins are temporary and publicly addressable by anyone with the URL.']],
    },
    color: {
        name: 'Color Converter', title: 'Color Picker & HEX to RGB Converter — Online Color Tool',
        desc: 'Pick colors and convert between HEX, RGB and HSL, then generate matching palettes. Instant, perfect for CSS and design work.',
        kw: 'hex to rgb, color converter, color picker, rgb to hex, hsl converter, color palette generator',
        about: 'Convert a color between HEX, RGB and HSL notation, pick one visually, and generate a palette of related shades for a design system or a CSS variable set.',
        bullets: ['HEX, RGB and HSL conversion in every direction', 'Visual picker with live preview', 'Palette generation for tints, shades and complements'],
        faq: [['What is the difference between HEX and RGB?', 'They describe the same color in different notation — HEX is a compact hexadecimal form of the same red, green and blue values. HSL instead describes hue, saturation and lightness, which is easier to adjust by hand.'], ['How do I make a lighter version of a brand color?', 'Convert it to HSL and raise the lightness value. The palette generator does this for you.']],
    },
    opengraph: {
        name: 'Open Graph Preview', title: 'Open Graph Preview & Meta Tag Checker — Social Card Tester',
        desc: 'Preview how any URL appears when shared on social media and validate its Open Graph and Twitter Card tags. Spot missing images and titles before you post.',
        kw: 'open graph preview, og tag checker, twitter card validator, social media preview, meta tag checker',
        about: 'Enter a URL to fetch its Open Graph and Twitter Card tags and see the link preview a social platform would build from them, along with a list of any tags that are missing or truncated.',
        bullets: ['Live preview of the social card for any public URL', 'Lists Open Graph, Twitter Card and standard meta tags', 'Flags missing titles, descriptions and images'],
        faq: [['Why does my link preview show no image?', 'Usually a missing og:image tag, or an image URL that is relative rather than absolute. Social platforms need a full https URL.'], ['Why has my preview not updated after I fixed the tags?', 'Platforms cache previews aggressively. Most offer a debugger that forces a re-scrape; this tool always fetches live so you can confirm the tags themselves are correct.']],
    },
    read: {
        name: 'Web Page Reader', title: 'Website to Text & URL to Markdown Converter — Web Page Reader',
        desc: 'Read any web page as clean text or Markdown: title, description, main text and links. A reader mode for any URL, and an API for scripts and AI agents.',
        kw: 'website to text, url to markdown, reader mode, extract text from webpage, web page to markdown, webpage reader, scrape article text',
        about: 'Enter a URL and the reader fetches the page and returns what a person would read: its title and description, the main text as light Markdown (headings, lists and links kept) and the page\'s outgoing links. Navigation, headers, footers, scripts and styles are left out. The same result is available as JSON from the tools API, which is how scripts and AI agents read pages.',
        bullets: ['Title, description, main text and up to 50 outgoing links', 'Markdown with headings, lists and links, or plain text', 'Only public web addresses: private and internal targets are refused'],
        faq: [['Does it run JavaScript?', 'No. It reads the HTML the server sends, which covers articles, documentation and most blogs. A page that builds its content in the browser will come back mostly empty.'], ['Is there a size limit?', 'The page is read up to about 2 MB and the text is cut at max_chars (20,000 by default, up to 50,000); the result says when it was truncated.'], ['Can I call it from code?', 'Yes: POST /api/v1/tools/read/run with {"input":{"url":"https://example.com"}}. No account is needed within the free limits.']],
    },
    jsminify: {
        name: "JavaScript Minifier", title: "JavaScript Minifier \u2014 Minify JS Online",
        desc: "Shrink JavaScript with a real parser, not regex. Paste JavaScript and get a smaller file that behaves the same.",
        kw: "js minifier, minify javascript, javascript minifier online, js compressor, uglify js, terser online, minify js code",
        about: "Paste JavaScript and get a smaller file that behaves the same. The minifier parses your code properly (it uses Terser), so it can remove dead code, shorten expressions and rename local variables safely, which regex-based minifiers cannot do. Everything runs in your browser; your code is not uploaded.",
        bullets: ["Three levels: whitespace only, full minify, or minify with variable mangling", "Understands modern syntax: modules, classes, async, optional chaining", "Runs locally in your browser, so private code stays private"],
        faq: [["Will minified code still work?", "Yes. Minifying removes whitespace and comments and rewrites expressions into shorter equivalents. Mangling renames local variables only, never globals or property names, so the behaviour stays the same."], ["Is my code uploaded?", "No. The minifier is loaded into your browser and runs there."]],
    },
    jsformat: {
        name: "JavaScript Beautifier", title: "JavaScript Beautifier \u2014 Format & Unminify JS",
        desc: "Turn minified or messy JavaScript into readable code. Paste minified, bundled or badly indented JavaScript and get it back with consistent indentation and line breaks, so you can read a production bundle or clean up a snippet before sharing it.",
        kw: "js beautifier, javascript formatter, unminify js, format javascript online, pretty print js, js prettifier",
        about: "Paste minified, bundled or badly indented JavaScript and get it back with consistent indentation and line breaks, so you can read a production bundle or clean up a snippet before sharing it. It parses the code rather than guessing, and runs in your browser.",
        bullets: ["Re-indents and re-breaks code from a real syntax tree", "Good for reading minified bundles and third-party scripts", "Nothing is uploaded"],
        faq: [["Can it restore original variable names?", "No. Names shortened by a minifier are gone unless you have a source map. Beautifying restores layout, not names."]],
    },
    cssminify: {
        name: "CSS Minifier", title: "CSS Minifier \u2014 Minify CSS Online",
        desc: "Strip comments and whitespace from stylesheets. Paste a stylesheet and get a compact version for production: comments and whitespace removed, trailing semicolons dropped, zero units and long hex colours shortened.",
        kw: "css minifier, minify css, css compressor online, compress css, minify stylesheet",
        about: "Paste a stylesheet and get a compact version for production: comments and whitespace removed, trailing semicolons dropped, zero units and long hex colours shortened. Strings and url() values are left untouched.",
        bullets: ["Removes comments, whitespace and redundant semicolons", "Shortens #ffffff to #fff and 0px to 0", "Leaves strings and url() values alone"],
        faq: [["Does it change how my CSS works?", "No. It only removes characters the browser ignores and rewrites values into shorter forms that mean the same thing."]],
    },
    cssformat: {
        name: "CSS Beautifier", title: "CSS Beautifier \u2014 Format & Unminify CSS",
        desc: "Re-indent minified or messy CSS. Turn a one-line or inconsistently formatted stylesheet into readable CSS with one declaration per line and nested indentation for media queries and other at-rules..",
        kw: "css beautifier, css formatter, unminify css, format css online, pretty print css",
        about: "Turn a one-line or inconsistently formatted stylesheet into readable CSS with one declaration per line and nested indentation for media queries and other at-rules.",
        bullets: ["One declaration per line, two-space indentation", "Handles nested at-rules such as @media and @supports", "Runs in your browser"],
        faq: [["Does it reorder my rules?", "No. Order matters in CSS, so rules and declarations stay exactly where they were."]],
    },
    htmlminify: {
        name: "HTML Minifier", title: "HTML Minifier \u2014 Minify HTML Online",
        desc: "Remove comments and whitespace from HTML. Make an HTML document smaller by removing comments and the whitespace between tags.",
        kw: "html minifier, minify html, html compressor online, compress html, minify web page",
        about: "Make an HTML document smaller by removing comments and the whitespace between tags. Useful for email templates, embedded snippets and static pages where every kilobyte is sent on each request.",
        bullets: ["Removes comments and inter-tag whitespace", "Keeps the content of pre, textarea, script and style intact", "Runs in your browser"],
        faq: [["Can minifying break my layout?", "Whitespace between inline elements can be meaningful. The minifier collapses it to a single space rather than removing it, which keeps inline text spacing correct."]],
    },
    xmlminify: {
        name: "XML Minifier", title: "XML Minifier \u2014 Minify XML Online",
        desc: "Collapse XML to a single compact line. Strip comments and the whitespace between elements from XML, SVG, RSS and sitemap files.",
        kw: "xml minifier, minify xml, compress xml online, xml compressor, minify svg",
        about: "Strip comments and the whitespace between elements from XML, SVG, RSS and sitemap files. Text inside elements and CDATA sections is preserved.",
        bullets: ["Removes comments and whitespace between tags", "Keeps text content and CDATA untouched", "Works for SVG, RSS, Atom and sitemaps"],
        faq: [["Is the result still valid XML?", "Yes. Only insignificant whitespace and comments are removed, and the document is checked for well-formedness first."]],
    },
    jsonminify: {
        name: "JSON Minifier", title: "JSON Minifier \u2014 Minify & Compact JSON Online",
        desc: "Compact JSON to the smallest valid form. Remove every unnecessary space and line break from a JSON document.",
        kw: "json minifier, minify json, compact json, json compressor online, json minify",
        about: "Remove every unnecessary space and line break from a JSON document. The input is parsed first, so you also find out if it is invalid, and the output is guaranteed to be valid JSON.",
        bullets: ["Validates while it minifies", "Reports how many bytes were saved", "Runs in your browser; the data is not uploaded"],
        faq: [["Does minifying change the data?", "No. Only whitespace outside strings is removed. Keys, values and their order stay the same."]],
    },
    jsonparse: {
        name: "JSON Parser", title: "JSON Parser & Viewer \u2014 Explore JSON Online",
        desc: "Explore JSON as a tree, a list of paths or a type map. Paste JSON and see what is actually in it: an indented tree, a flat list of every path with its value (handy for writing jq filters or accessing nested fields in code), or a map of the types at each path..",
        kw: "json parser, json viewer, json tree viewer, parse json online, json path finder, json explorer",
        about: "Paste JSON and see what is actually in it: an indented tree, a flat list of every path with its value (handy for writing jq filters or accessing nested fields in code), or a map of the types at each path.",
        bullets: ["Tree, flat path list and type map views", "Paths are written the way you would access them in code", "Pinpoints the position of a syntax error"],
        faq: [["What is the path list for?", "It shows every leaf as a path such as user.roles[0], which is what you need when writing a jq filter, a JSONPath query or plain property access."]],
    },
    jsonvalidate: {
        name: "JSON Validator", title: "JSON Validator \u2014 JSON Lint Online",
        desc: "Check JSON and find the exact error. Find out whether a document is valid JSON and, if it is not, where it breaks: the line and column of the first error, with the common causes (trailing commas, single quotes, unquoted keys, comments) called out..",
        kw: "json validator, json lint, validate json online, json checker, json syntax error, jsonlint",
        about: "Find out whether a document is valid JSON and, if it is not, where it breaks: the line and column of the first error, with the common causes (trailing commas, single quotes, unquoted keys, comments) called out.",
        bullets: ["Line and column of the first syntax error", "Names the usual culprits: trailing commas, single quotes, comments", "Summarises the structure when the document is valid"],
        faq: [["Why is a trailing comma an error?", "JSON is stricter than JavaScript. A comma after the last item in an object or array is not allowed by the JSON specification, even though most JavaScript engines accept it in code."]],
    },
    jsonstringify: {
        name: "JSON Stringify", title: "JSON Stringify & Unescape Online",
        desc: "Turn JSON into an escaped string literal, and back. Convert a JSON document into a single escaped string, the form you need when embedding JSON inside another JSON value, an environment variable or a source file.",
        kw: "json stringify online, json escape, json unescape, escape json string, json to string, string to json",
        about: "Convert a JSON document into a single escaped string, the form you need when embedding JSON inside another JSON value, an environment variable or a source file. The reverse mode takes an escaped string and gives the JSON back.",
        bullets: ["Escapes quotes, backslashes and newlines correctly", "Reverse mode parses a quoted, escaped string back into JSON", "Runs in your browser"],
        faq: [["When do I need this?", "Whenever JSON has to travel inside a string: a JSON field that holds JSON, a config value, a test fixture or a shell variable."]],
    },
    html2md: {
        name: "HTML to Markdown", title: "HTML to Markdown Converter Online",
        desc: "Convert HTML into clean Markdown. Paste HTML from a web page, an email or a CMS and get Markdown you can put in a README, a wiki or a static site.",
        kw: "html to markdown, convert html to markdown, html2md, html to md converter, web page to markdown",
        about: "Paste HTML from a web page, an email or a CMS and get Markdown you can put in a README, a wiki or a static site. Headings, emphasis, links, images, lists, quotes, code blocks and tables are converted; scripts and styling are dropped.",
        bullets: ["Headings, lists, links, images, quotes, code and tables", "Drops scripts, styles and presentational markup", "Parsed by your browser; nothing is uploaded"],
        faq: [["What happens to things Markdown cannot express?", "Layout markup such as div and span is unwrapped so its text is kept. Scripts, styles and form controls are removed."]],
    },
    md2html: {
        name: "Markdown to HTML", title: "Markdown to HTML Converter Online",
        desc: "Convert Markdown into HTML you can paste anywhere. Write or paste Markdown and copy the HTML it produces, ready for a CMS, an email template or a page that does not render Markdown itself.",
        kw: "markdown to html, convert markdown to html, md to html, markdown converter online, markdown html generator",
        about: "Write or paste Markdown and copy the HTML it produces, ready for a CMS, an email template or a page that does not render Markdown itself. A preview mode shows the rendered result.",
        bullets: ["Copy-ready HTML output, or a rendered preview", "Headings, emphasis, lists, links, quotes and code", "Runs in your browser"],
        faq: [["Is this the same as the Markdown editor?", "The editor is for writing with a live preview. This tool is for one job: getting the HTML out."]],
    },
};

// ── Network & diagnostics tools (net.openvibe.tools) ─────────
const NET = {
    net: {
        name: 'Network Tools', title: 'Online Network Tools — Ping, DNS, Whois & SSL Diagnostics',
        desc: 'Run DNS lookups, Whois, SSL checks, TCP ping, port checks, blacklist and SMTP tests and HTTP header checks from the browser. Network diagnostics with no signup.',
        kw: 'network tools, online network diagnostics, ping test, dns lookup, whois, ssl checker',
        about: 'A set of network diagnostics that run from our servers so you can test a host from outside your own connection — useful when you need to know whether a problem is yours or theirs.',
        bullets: ['Tests run from our server, not your browser', 'Covers DNS, email deliverability, HTTP and TLS', 'No account required'],
        faq: [['Why test from a server instead of my machine?', 'Testing from outside your network rules out your own DNS cache, firewall or ISP, which is exactly what you need when a site works for you but not for someone else.'], ['Do I need an account?', 'No. There are reasonable rate limits to keep them available for everyone.']],
    },
    lookup: { name: 'Domain & IP Lookup', title: 'Domain & IP Lookup — All-in-One Online Lookup Tool', desc: 'Look up everything about a domain or IP in one go: DNS records, Whois, geolocation, SSL and HTTP headers. Instant, no signup.', kw: 'domain lookup, ip lookup, whois lookup, dns lookup, all in one lookup tool', about: 'Enter a domain or IP address and get a complete report in one pass: registration details, DNS records, hosting location, certificate status and HTTP response headers.', bullets: ['One query returns DNS, Whois, geolocation and TLS detail', 'Works with domains, IPv4 and IPv6 addresses', 'A fast first step when diagnosing any site problem'], faq: [['What can I learn from a domain lookup?', 'Who registered the domain and when it expires, which nameservers and mail servers it uses, where it is hosted, and whether its certificate is valid.'], ['Does this work for IP addresses too?', 'Yes. Enter an IP to see its owner, network range, geolocation and reverse DNS name.']] },
    myip: { name: 'What Is My IP', title: 'What Is My IP Address — IP, ISP & Location Checker', desc: 'See your public IP address, ISP, approximate location and reverse DNS instantly. Works for both IPv4 and IPv6. No signup.', kw: 'what is my ip, my ip address, public ip, ip location, my isp', about: 'Shows the public IP address the internet sees for your connection, along with the network operator, approximate location and reverse DNS name.', bullets: ['Detects both your IPv4 and IPv6 address', 'ISP, autonomous system and approximate location', 'Confirms at a glance whether a VPN is actually active'], faq: [['Why does my IP differ from the one in my router?', 'Your router shows a private address used inside your network. The public address shown here is what websites actually see.'], ['How do I check whether my VPN is working?', 'Load this page with the VPN off, then on. If the address and location change, traffic is going through the VPN.']] },
    ip: { name: 'IP Address Lookup', title: 'IP Address Lookup — IPv4 & IPv6 Information Tool', desc: 'Look up any IP address to see its owner, network, geolocation, reverse DNS and abuse contact. Supports IPv4 and IPv6. Instant.', kw: 'ip address lookup, ip checker, ip information, ip details, ip owner lookup', about: 'Enter any IP address to find out which organisation announces it, which network block it belongs to, roughly where it is, and what its reverse DNS name says.', bullets: ['Owner, network range and autonomous system', 'Geolocation with country, region and city', 'Reverse DNS and abuse contact where published'], faq: [['Can an IP address identify a person?', 'No. It identifies a network connection and usually resolves only to a city-level area and an internet provider.'], ['Why is the location wrong?', 'Geolocation is inferred from registry and routing data. Mobile networks and VPNs often report the location of a gateway hundreds of miles away.']] },
    ipv4: { name: 'IPv4 Lookup & CIDR Calculator', title: 'IPv4 Lookup & CIDR Subnet Calculator — Online Tool', desc: 'Look up IPv4 addresses and calculate CIDR subnets: network range, broadcast address, usable hosts and mask. Instant.', kw: 'ipv4 lookup, cidr calculator, subnet calculator, ip range calculator, netmask calculator', about: 'Inspect an IPv4 address or work out a subnet: given a CIDR block you get the network address, broadcast address, usable host range and the total address count.', bullets: ['CIDR to range, mask and host count', 'Address class and reserved-range detection', 'Useful for firewall rules and allowlists'], faq: [['How many hosts are in a /24?', '256 addresses, of which 254 are usable — the first is the network address and the last is the broadcast address.'], ['What does the /number in CIDR mean?', 'It is the count of leading bits that identify the network. A larger number means a smaller subnet.']] },
    ipv6: { name: 'IPv6 Lookup', title: 'IPv6 Address Lookup & Expander — Online IPv6 Tool', desc: 'Look up IPv6 addresses, expand or compress notation, and identify address type and scope. Instant, no signup.', kw: 'ipv6 lookup, ipv6 expander, ipv6 address checker, expand ipv6, ipv6 notation', about: 'Expand a shortened IPv6 address to its full form, compress it back, and see what kind of address it is — global unicast, link-local, unique local or multicast.', bullets: ['Expand and compress IPv6 notation', 'Address type, scope and prefix detection', 'Owner and routing information for global addresses'], faq: [['What does the :: in an IPv6 address mean?', 'It replaces one run of consecutive zero groups. It can appear only once in an address, which is why expansion is unambiguous.'], ['Why do I have several IPv6 addresses?', 'Devices normally hold a link-local address plus one or more global addresses, often including a rotating privacy address.']] },
    geoip: { name: 'IP Geolocation', title: 'IP Geolocation Lookup — Find the Location of Any IP', desc: 'Find the country, region, city, timezone and coordinates behind any IP address, shown on a map. IP geolocation with no signup.', kw: 'ip geolocation, ip location lookup, find ip location, geoip, ip to location', about: 'Resolve an IP address to its most likely physical location, including country, region, city, timezone and approximate coordinates plotted on a map.', bullets: ['Country, region, city and timezone', 'Coordinates plotted on a map', 'Network operator shown alongside the location'], faq: [['How accurate is IP geolocation?', 'Country level is highly reliable; city level is a good guess and often off for mobile and satellite connections. It should never be treated as a precise location.'], ['Why does my own IP show the wrong city?', 'Your provider may route traffic through a regional hub, so the registered location of the gateway is what gets reported.']] },
    hostname: { name: 'Hostname Lookup', title: 'Hostname Lookup — Resolve Hostnames to IP Addresses', desc: 'Resolve a hostname to its IP addresses or find the hostname behind an IP. Forward and reverse lookups in one tool. Instant.', kw: 'hostname lookup, resolve hostname, host to ip, ip to hostname, dns resolve', about: 'Resolve a hostname to every address it answers with, or go the other way and find the name registered for an IP.', bullets: ['Forward resolution to IPv4 and IPv6 addresses', 'Reverse resolution from an address to a name', 'Shows every record when a host is load balanced'], faq: [['Why does one hostname return several IPs?', 'Large sites publish multiple addresses for load balancing and redundancy; your resolver picks one.'], ['What if the reverse lookup returns nothing?', 'Reverse records are optional and set by whoever controls the IP block, so many addresses simply have none.']] },
    isp: { name: 'ISP Lookup', title: 'ISP Lookup — Find the Internet Provider Behind Any IP', desc: 'Identify the ISP, hosting company or organisation that owns any IP address, plus its network range. Instant.', kw: 'isp lookup, ip owner, who owns this ip, hosting provider lookup, organization lookup', about: 'Find out which company is responsible for an address — a residential ISP, a mobile carrier, a cloud provider or a hosting company — along with the network block it sits in.', bullets: ['Provider and organisation name', 'Network block and autonomous system', 'Distinguishes residential, mobile and datacentre addresses'], faq: [['How can I tell if traffic came from a datacentre?', 'The owner name is the giveaway: cloud and hosting providers appear instead of a consumer ISP, which usually means automated traffic or a VPN.'], ['Is the ISP always accurate?', 'It reflects registry data, which is reliable for the owning organisation but may lag when address blocks are transferred or leased.']] },
    asn: { name: 'ASN Lookup', title: 'ASN Lookup — Autonomous System Number Info', desc: 'Look up any autonomous system number to see its operator, announced prefixes and peers. BGP and routing information.', kw: 'asn lookup, autonomous system number, bgp lookup, as number, network prefix lookup', about: 'Inspect an autonomous system: who operates it, which address prefixes it announces to the internet, and how it connects to the wider routing table.', bullets: ['Operator name, country and registry', 'Announced IPv4 and IPv6 prefixes', 'Useful for routing investigations and abuse reports'], faq: [['What is an autonomous system?', 'A group of IP networks under one operator with a single routing policy. Every ISP and large hosting provider has at least one, identified by an AS number.'], ['How do I find the ASN for a website?', 'Look up the site\'s IP address first — the result includes the AS number announcing it.']] },
    rdns: { name: 'Reverse DNS Lookup', title: 'Reverse DNS Lookup — Find the Hostname of an IP (PTR)', desc: 'Run a reverse DNS lookup to find the PTR hostname for any IPv4 or IPv6 address. Essential for mail server checks. Instant.', kw: 'reverse dns lookup, ptr record lookup, rdns, ip to hostname, reverse ip lookup', about: 'Query the PTR record for an address to find the hostname its operator has registered. Mail servers check this, which makes it a required step when diagnosing delivery problems.', bullets: ['PTR lookups for both IPv4 and IPv6', 'Shows whether forward and reverse records agree', 'Key check for mail server configuration'], faq: [['Why does my mail get rejected for missing reverse DNS?', 'Receiving mail servers treat a missing or mismatched PTR record as a spam signal. Your hosting provider sets this record for you.'], ['What is forward-confirmed reverse DNS?', 'It means the PTR name resolves back to the same IP. Mail servers prefer it, and this tool shows whether it matches.']] },
    whois: { name: 'Whois Lookup', title: 'Whois Lookup — Domain Registration & Ownership Checker', desc: 'Look up domain registration details: registrar, creation and expiry dates, nameservers and status codes. Whois lookup, no signup.', kw: 'whois lookup, domain whois, domain registration lookup, check domain owner, domain expiry', about: 'Query registration records for a domain to see who registered it, when it was created, when it expires, which registrar holds it and what status codes are applied.', bullets: ['Registrar, creation, update and expiry dates', 'Nameservers and domain status codes', 'Works for domains and IP address blocks'], faq: [['Why is the registrant hidden?', 'Privacy rules mean most registrars replace personal details with a privacy service. Registrar, dates and nameservers remain public.'], ['How do I tell when a domain expires?', 'The expiry date is in the record here, though domains usually stay in redemption for weeks afterwards before becoming available again.']] },
    rdap: { name: 'RDAP Lookup', title: 'RDAP Lookup — Modern Domain & IP Registration Data', desc: 'Query RDAP for structured domain and IP registration data — the modern replacement for Whois. Instant, standards-compliant.', kw: 'rdap lookup, rdap query, domain registration data, whois alternative, registration data access', about: 'RDAP is the structured successor to Whois: the same registration data delivered as predictable JSON, with consistent fields across registries.', bullets: ['Structured, machine-readable registration data', 'Consistent field names across every registry', 'Covers both domains and IP allocations'], faq: [['How is RDAP different from Whois?', 'Whois returns free-form text that differs by registry. RDAP returns structured data with standard field names, so it is far easier to parse reliably.'], ['Is RDAP replacing Whois?', 'Yes, gradually. Registries are required to run RDAP, and Whois is being retired over time.']] },
    dns: { name: 'DNS Lookup', title: 'DNS Lookup — Online DNS Record Checker (A, MX, TXT)', desc: 'Look up DNS records for any domain: A, AAAA, MX, TXT, CNAME, NS, SOA and more. DNS lookup with instant results.', kw: 'dns lookup, dns record checker, check dns records, a record lookup, mx lookup, txt record', about: 'Query any DNS record type for a domain and see the answers exactly as a resolver receives them, including TTL values so you know how long a change will take to spread.', bullets: ['All common record types: A, AAAA, MX, TXT, CNAME, NS, SOA', 'TTL values shown so you can predict propagation', 'Queried from our resolvers, bypassing your local cache'], faq: [['Why do I still see the old DNS record?', 'Resolvers cache answers for the length of the TTL. This tool queries directly, so it usually shows the new value before your machine does.'], ['Which record do I need for a website?', 'An A record (or AAAA for IPv6) pointing at your server\'s IP, or a CNAME pointing at another hostname.']] },
    dig: { name: 'Online dig', title: 'Online dig Command — Web-Based DNS Query Tool', desc: 'Run dig from your browser to query any DNS record type and read the full answer, authority and additional sections. No install.', kw: 'online dig, dig command online, dns query tool, dig web interface, dns debugging', about: 'The dig command without a terminal: choose a record type, query any domain, and read the complete response including the authority and additional sections.', bullets: ['Full response sections, not just the answer', 'Any record type, including less common ones', 'No local install — useful from a locked-down machine'], faq: [['What is the difference between dig and nslookup?', 'dig shows the complete DNS response including flags and section detail, which makes it the better tool for debugging. nslookup is simpler and shows just the answer.'], ['Can I query a specific nameserver?', 'Yes — that is the usual way to confirm an authoritative server has your change before caches expire.']] },
    nslookup: { name: 'NSLookup', title: 'NSLookup Online — Web-Based DNS Lookup Tool', desc: 'Run nslookup from your browser to resolve domains and check DNS records. Simple, fast and no install required.', kw: 'nslookup online, nslookup tool, dns lookup command, resolve domain online', about: 'A simple DNS query in the familiar nslookup style: enter a domain, get the addresses and records it resolves to.', bullets: ['Straightforward answers without protocol noise', 'Common record types covered', 'Runs from our resolvers, so it ignores your local cache'], faq: [['Why does nslookup show a different answer than my browser?', 'Your browser and operating system cache DNS answers. A direct query shows the current published record.'], ['Is nslookup still worth using?', 'For a quick "what does this resolve to" check, yes. For debugging, dig gives far more detail.']] },
    dnspropagation: { name: 'DNS Propagation Checker', title: 'DNS Propagation Checker — Compare Public DNS Resolvers', desc: 'Check whether a DNS change has propagated by asking ten public resolvers (Google, Cloudflare, Quad9, OpenDNS and more) and comparing their answers. Instant.', kw: 'dns propagation checker, dns propagation test, global dns check, dns worldwide, check dns update', about: 'Ask the same question of ten large public DNS resolvers run by different operators and see their answers side by side, so you can tell which ones have picked up your change and which still serve a cached value. These resolvers are anycast networks: each answer comes from the operator\'s node nearest to our server.', bullets: ['Answers from ten public resolvers side by side', 'Highlights resolvers that disagree with the majority', 'A, AAAA, CNAME, MX, NS and TXT records'], faq: [['How long does DNS propagation take?', 'Up to the record\'s previous TTL — commonly an hour, sometimes 24 or 48 hours if the TTL was set high. Lowering the TTL before a planned change makes the next one faster.'], ['Why do some resolvers still show the old IP?', 'Those resolvers cached the previous answer and will keep serving it until that cache entry expires.']] },
    mx: { name: 'MX Record Lookup', title: 'MX Record Lookup — Find Mail Servers for Any Domain', desc: 'Look up the MX records for a domain to see which mail servers handle its email and in what priority order. Instant.', kw: 'mx record lookup, mail server lookup, mx check, email dns records, find mail server', about: 'See which servers accept mail for a domain and their priority order — the first thing to check when email is bouncing or arriving somewhere unexpected.', bullets: ['All MX records with priority values', 'Resolves each mail server to its address', 'Flags domains with no MX record at all'], faq: [['What does the MX priority number mean?', 'Lower numbers are tried first. Equal values are used in rotation, which spreads load across servers.'], ['Why is my email bouncing?', 'Start here: a missing MX record, or one pointing at a host that no longer exists, stops delivery outright.']] },
    txt: { name: 'TXT Record Lookup', title: 'TXT Record Lookup — Check SPF, DKIM & Verification Records', desc: 'Look up TXT records for any domain, including SPF, DKIM, DMARC and site verification strings. Instant DNS TXT checker.', kw: 'txt record lookup, spf record check, dns txt records, domain verification record, check txt record', about: 'Read every TXT record published for a domain — the place where SPF policies, domain verification tokens and assorted service strings all live.', bullets: ['Every TXT record, shown in full', 'Highlights SPF, DKIM and verification entries', 'Useful for confirming a verification token is live'], faq: [['Why is my domain verification failing?', 'Usually the record was added to the wrong host name, or the provider wrapped it in extra quotes. This shows exactly what is published.'], ['Can a domain have more than one TXT record?', 'Yes, and most do. The exception is SPF: exactly one SPF record is allowed, and multiple ones cause failures.']] },
    ns: { name: 'Nameserver Lookup', title: 'NS Record Lookup — Find the Nameservers for Any Domain', desc: 'Look up the NS records for a domain to see which nameservers are authoritative for it. Instant nameserver checker.', kw: 'ns record lookup, nameserver lookup, find nameservers, authoritative dns, dns delegation check', about: 'Find which nameservers a domain is delegated to, and confirm the delegation at the registry matches what the nameservers themselves claim.', bullets: ['Authoritative nameservers for the domain', 'Reveals mismatches between registry and zone', 'First check when a DNS change has no effect'], faq: [['Why do my DNS changes have no effect?', 'Often the domain is delegated to different nameservers than the ones you edited. This shows which servers are actually authoritative.'], ['How many nameservers should a domain have?', 'At least two, on separate networks, so the domain still resolves if one goes down.']] },
    spf: { name: 'SPF Record Checker', title: 'SPF Record Checker — Validate Your Email SPF Policy', desc: 'Check and validate a domain\'s SPF record. See which servers may send mail, catch syntax errors and count DNS lookups. Instant.', kw: 'spf record checker, spf validator, check spf, email authentication, spf lookup limit', about: 'Read a domain\'s SPF policy, expand every include, and confirm it stays inside the ten-lookup limit that causes silent failures when exceeded.', bullets: ['Full expansion of includes and redirects', 'Counts DNS lookups against the limit of ten', 'Flags syntax errors and multiple SPF records'], faq: [['What happens if SPF exceeds ten DNS lookups?', 'Receiving servers return a permanent error and may treat your mail as unauthenticated, so legitimate messages can land in spam.'], ['Can I have two SPF records?', 'No. A domain must publish exactly one; two records cause validation to fail entirely.']] },
    dkim: { name: 'DKIM Record Lookup', title: 'DKIM Record Lookup & Validator — Email Auth Checker', desc: 'Look up and validate DKIM records by selector. Confirm your signing key is published correctly for email authentication. Instant.', kw: 'dkim record lookup, dkim checker, dkim validator, dkim selector, email authentication', about: 'Fetch the DKIM public key for a given selector and confirm it is published and well-formed, so signed mail can be verified by receiving servers.', bullets: ['Selector-based lookup for any domain', 'Validates key format and flags', 'Confirms the record is reachable before you go live'], faq: [['What is a DKIM selector?', 'A label that identifies which key to use, published at selector._domainkey.yourdomain.com. Your mail provider tells you which selector it signs with.'], ['Why is DKIM failing after a provider change?', 'The new provider signs with a different selector and key, so the old record no longer matches. Publish the new one they supply.']] },
    dmarc: { name: 'DMARC Checker', title: 'DMARC Record Checker — Validate Your DMARC Policy', desc: 'Check a domain\'s DMARC record and policy. See enforcement level, reporting addresses and alignment settings. Instant.', kw: 'dmarc checker, dmarc record lookup, dmarc validator, dmarc policy, email security check', about: 'Read a domain\'s DMARC policy: whether failures are monitored, quarantined or rejected, where reports are sent, and how strictly alignment is enforced.', bullets: ['Policy level, percentage and alignment settings', 'Reporting addresses for aggregate and forensic reports', 'Syntax validation with clear explanations'], faq: [['What DMARC policy should I start with?', 'Start at p=none with a reporting address. That monitors without affecting delivery, so you can find legitimate senders before moving to quarantine and then reject.'], ['Do I need SPF and DKIM for DMARC to work?', 'Yes. DMARC builds on both, and requires that at least one passes and aligns with the visible From domain.']] },
    ping: { name: 'Ping Test', title: 'Online Ping Test (TCP) — Check if a Host Is Up', desc: 'Check whether a host answers and how fast, by timing TCP connections to port 443 from our server. Min, average, max and loss. No install.', kw: 'ping test, online ping, ping ip, check if server is up, latency test, ping tool, tcp ping', about: 'This test times TCP connections: it opens a connection to the host on port 443 (HTTPS) several times from the OpenVibe server and reports how long each took and how many failed. A web server answers it even when a firewall drops ICMP; for ICMP hop by hop, use the MTR report.', bullets: ['Connect time for each attempt, with min, average and max', 'Loss: attempts that were refused or timed out', 'Runs from the OpenVibe server (one location)'], faq: [['Why a TCP ping instead of ICMP?', 'A timed TCP connection answers the same question — is the host up, how far away is it — and passes firewalls that drop ICMP. The traceroute and MTR tools use ICMP echo when you want the path.'], ['What is a good ping time?', 'Under 50 ms feels instant, under 100 ms is fine for most uses, and over 200 ms is noticeable in calls and games.']] },
    traceroute: { name: 'Traceroute', title: 'Online Traceroute — See the Network Path to Any Host', desc: 'Trace the route from our server to any host: every hop with its name, network (AS number) and best, average and worst time. IPv4 and IPv6. No install.', kw: 'traceroute online, trace route, network path, tracert online, hop by hop latency, visual traceroute', about: 'A traceroute shows the routers between our server and the host, one hop at a time. Each hop is probed three times with ICMP echo (mtr), named by reverse DNS where it has a name, and tagged with the network (AS number) that runs it, so you can see where the path leaves one provider for the next and where the time goes.', bullets: ['Every hop with its name, address and network (AS number)', 'Best, average and worst time per hop, from three probes', 'IPv4, or IPv6 when the host has only an IPv6 address'], faq: [['How do I read a traceroute?', 'Look for the point where latency jumps sharply and stays high, or where replies stop for good. The hop before it usually names the network where the trouble starts.'], ['Why do some hops show no reply?', 'Many routers do not answer probes addressed to them, or answer only a few a second. A silent hop in the middle of a path that carries on is normal; replies that stop for good mean the path ends there or a firewall drops the probes.'], ['Where does the trace start?', 'At the OpenVibe server, outside your network. To see the path from your own connection, run traceroute (Windows: tracert) on your machine.']] },
    mtr: { name: 'MTR Report', title: 'Online MTR Report — Packet Loss and Latency per Hop', desc: 'Run an MTR report from our server to any host: ten probes per hop with loss, last, best, average and worst time and jitter (StDev), plus each hop\'s network. IPv4 and IPv6.', kw: 'mtr online, mtr report, my traceroute, packet loss test, network path analysis, jitter test', about: 'MTR combines traceroute and ping: it sends ten ICMP echo probes to every hop on the path and reports, per hop, how many were lost and how the round-trip time varied. That separates a router that is merely slow to answer from a path that really loses traffic, which is the evidence a network operator asks for.', bullets: ['Loss, last, best, average and worst time and StDev for every hop', 'Each hop\'s name and network (AS number)', 'Ten probes a hop in about fifteen seconds, from the OpenVibe server'], faq: [['Why is MTR better than traceroute for support tickets?', 'It samples repeatedly, so it distinguishes a genuinely lossy hop from a single dropped probe. That is the evidence a network operator needs.'], ['A middle hop shows loss but the destination shows none. Is something wrong?', 'Usually not. Routers limit how often they answer probes addressed to themselves while forwarding traffic normally. Loss that starts at a hop and carries on to every hop after it, including the destination, is real loss.']] },
    port: { name: 'Port Checker', title: 'Open Port Checker — Test if a Port Is Open', desc: 'Check whether a TCP port is open on any host, from outside your network. Test common services or any custom port. Instant.', kw: 'port checker, open port test, port scanner online, check port open, tcp port test', about: 'Test whether a port accepts connections from the public internet — the definitive check on whether a port forward, firewall rule or service binding actually works.', bullets: ['Tests from outside your network, as a real client would', 'Common service ports or any custom port', 'Distinguishes closed ports from filtered ones'], faq: [['My service runs but the port shows closed — why?', 'Either a firewall is dropping the traffic, the port forward is missing, or the service is bound to localhost instead of all interfaces.'], ['What is the difference between closed and filtered?', 'Closed means the host actively refused the connection. Filtered means nothing answered at all, which usually indicates a firewall dropping packets silently.']] },
    headers: { name: 'HTTP Header Checker', title: 'HTTP Header Checker — Inspect Response Headers Online', desc: 'Check the HTTP response headers of any URL, including security, caching and compression headers. Header analysis tool.', kw: 'http header checker, response headers, security headers check, cache headers, view http headers', about: 'Fetch any URL and read the full response headers, with the security and caching headers called out so you can see what a browser is being told to do.', bullets: ['Complete response headers exactly as sent', 'Security header review including HSTS and CSP', 'Cache and compression headers explained'], faq: [['Which security headers should I have?', 'At minimum Strict-Transport-Security, X-Content-Type-Options and a Content-Security-Policy. The report lists what is present and what is missing.'], ['Why is my page not being cached?', 'Look at Cache-Control. A no-store or no-cache directive, or a missing max-age, prevents browsers and CDNs from reusing the response.']] },
    redirects: { name: 'Redirect Checker', title: 'Redirect Checker — Trace Redirect Chains Online', desc: 'Follow every hop in a redirect chain and see each status code and destination. Find redirect loops and SEO-damaging chains. Instant.', kw: 'redirect checker, redirect chain, 301 checker, url redirect tracer, redirect loop finder', about: 'Follow a URL through every redirect to its final destination, with the status code at each step, so you can spot long chains and loops that waste crawl budget and lose link value.', bullets: ['Every hop with its status code and target', 'Detects loops and unnecessarily long chains', 'Flags temporary redirects used where permanent ones belong'], faq: [['Do redirect chains hurt SEO?', 'Yes. Each extra hop slows the page and search engines limit how many they follow. Point the first URL straight at the final destination.'], ['301 or 302 — which should I use?', 'Use 301 for permanent moves so ranking signals transfer. Use 302 only when the original URL will genuinely return.']] },
    ssl: { name: 'SSL Certificate Checker', title: 'SSL Certificate Checker — Online TLS & Expiry Test', desc: 'Check any site\'s SSL certificate: expiry date, issuer, chain completeness and supported TLS versions. SSL checker, instant results.', kw: 'ssl checker, ssl certificate checker, tls check, certificate expiry, ssl chain test', about: 'Inspect a site\'s TLS certificate — who issued it, when it expires, whether the chain is complete and which protocol versions the server negotiates.', bullets: ['Expiry date with days remaining', 'Chain validation that catches missing intermediates', 'Issuer, subject and alternative names'], faq: [['My certificate works in Chrome but fails elsewhere — why?', 'Almost always a missing intermediate certificate. Browsers often cache intermediates from other sites; other clients do not. This check shows whether the chain your server sends is complete.'], ['How early should I renew?', 'Automate renewal at around 30 days remaining. Most issuers allow renewal well before expiry.']] },
    curl: { name: 'Online curl', title: 'Online curl — Check What a URL Answers, From Our Server', desc: 'Request a URL from our server and read the status line and every response header (a HEAD request, like curl -I). Test an endpoint from outside your network.', kw: 'online curl, curl -I online, http request tester, check response headers, send http request', about: 'Sends a HEAD request to the URL from the OpenVibe server and shows the status line and every response header, like curl -I. Useful for testing an endpoint from outside your network or from a machine where you cannot install tools. Custom methods, request headers and bodies are not supported.', bullets: ['Status line and every response header', 'Requests come from our server, not your IP', 'HEAD only: the body is not downloaded'], faq: [['How is this different from the curl converter?', 'This sends a real request and shows the response. The converter turns a curl command into code without sending anything.'], ['Can I test an internal service?', 'No. Requests come from our servers, so the target must be reachable from the public internet.']] },
    httpstatus: { name: 'HTTP Status Codes', title: 'HTTP Status Code Checker — What Does a URL Return?', desc: 'Check the HTTP status code any URL returns from our server, with its redirect target and response headers. Instant.', kw: 'http status codes, status code checker, check status code, 404 meaning, 301 vs 302, http response codes', about: 'Requests a URL from the OpenVibe server and shows the status code it returns, where a redirect points and the response headers — the quickest way to confirm a 301, a 404 or a 5xx.', bullets: ['The status code and reason a URL returns', 'Where a 3xx redirect points', 'The response headers alongside'], faq: [['What is the difference between 301 and 302?', '301 is permanent and transfers ranking signals to the new URL. 302 is temporary and tells search engines to keep indexing the original.'], ['Should a missing page return 404 or 410?', '404 means not found and may be retried. 410 means permanently gone and gets pages dropped from an index faster.']] },
    latency: { name: 'TCP Latency Test', title: 'TCP Latency Test — Connect Time to Any Host', desc: 'Measure TCP connect latency to any host from our server: how long a connection to port 443 takes, repeated ten times to show the spread. No install.', kw: 'latency test, response time test, tcp latency, connect time test, network latency check', about: 'Opens a TCP connection to the host on port 443 ten times from the OpenVibe server (one location) and reports each connect time with the minimum, average, maximum and loss. It measures the network path only, not how long the web server takes to answer.', bullets: ['Ten timed TCP connections to port 443', 'Minimum, average, maximum and loss', 'Runs from the OpenVibe server (one location)'], faq: [['Is this the same as time to first byte?', 'No. It times only the TCP connection. For how long the server takes to answer a request, use the website uptime check.'], ['Why is latency high?', 'Usually distance: the host is far from our server with no edge node in between. A CDN fixes exactly this for visitors near its nodes.']] },
    blacklist: { name: 'Blacklist Checker', title: 'IP & Domain Blacklist Checker — RBL Lookup', desc: 'Check whether an IPv4 address or a domain is listed on major email blacklists and RBLs, with the reason and a delisting link. Find out why mail is rejected.', kw: 'blacklist check, rbl lookup, ip blacklist checker, email blacklist, spam list check', about: 'Queries well-known DNS blacklists to see whether an IPv4 address or a domain is listed — the usual explanation when mail is being rejected or silently dropped. A domain is checked on the domain lists and its address on the IP lists.', bullets: ['Seven IP blacklists and three domain lists in one query', 'Shows which list flagged you and the reason it gives', 'Delisting links for every list'], faq: [['How do I get removed from a blacklist?', 'Fix the cause first — an open relay, a compromised account or a bad sending pattern — then use the operator\'s delisting form. Requesting removal without fixing the cause gets you relisted.'], ['What does "refused the query" mean?', 'Some lists do not answer queries that come through large DNS resolvers. That is not a listing; check that list on its own website.']] },
    reputation: { name: 'Domain Reputation Checker', title: 'Domain & IP Reputation Checker — Blacklists, SPF, DMARC, Age', desc: 'One reputation report for a domain or IP: blacklist listings, SPF, DMARC and MX, the HTTPS certificate, domain age, and reverse DNS for an address. Every point explained.', kw: 'domain reputation, ip reputation checker, email reputation, sender score, domain trust check, is my domain blacklisted', about: 'The report gathers the public signals mail filters and browsers weigh: whether the domain or address is on the public blacklists, how the domain protects its mail (SPF, DMARC, MX), whether its HTTPS certificate is valid, how long it has been registered, and for an address whether it has a reverse DNS name that points back. Each finding says what was seen and what it costs; the score is 100 minus those costs.', bullets: ['Blacklist listings from the same lists as the blacklist checker', 'SPF, DMARC and MX read and explained', 'HTTPS certificate, domain age (RDAP) and reverse DNS'], faq: [['Is this the score mail providers use?', 'No. Gmail, Microsoft and others keep private scores built from how people react to your mail. This report checks the public signals those scores start from, and every point it takes off is explained.'], ['What hurts domain reputation most?', 'Sending mail without SPF, DKIM and DMARC, appearing on blacklists, and hosting alongside abusive neighbours on a shared IP.'], ['Why is DKIM not in the score?', 'DKIM keys live under a selector only the sender knows. Check yours with the DKIM lookup and the selector your mail service gave you.']] },
    smtp: { name: 'SMTP Server Test', title: 'SMTP Server Test — Banner, STARTTLS & Certificate Check', desc: 'Test a mail server from our server: connection, greeting banner, EHLO extensions, STARTTLS with its TLS version and certificate, and the login methods offered. Ports 25 and 587.', kw: 'smtp test, smtp server check, mail server test, starttls check, smtp connectivity', about: 'Connects to a mail server — or to the main MX host of a domain — reads its greeting, sends EHLO and, when STARTTLS is offered, upgrades the connection to report the TLS version and certificate. It never sends a message.', bullets: ['The greeting banner and every EHLO extension', 'STARTTLS support, TLS version and certificate', 'Port 25 (server to server) or 587 (submission)'], faq: [['Which SMTP port should I use?', 'Port 587 with STARTTLS for sending mail from a client, or 465 for implicit TLS. Port 25 is for server-to-server delivery and is blocked by most consumer ISPs.'], ['Does this test send an email?', 'No. It stops after the greeting, EHLO and (when offered) STARTTLS, then says QUIT.']] },
    uptime: { name: 'Website Uptime Checker', title: 'Website Uptime Checker — Is a Site Down? Online Test', desc: 'Check whether a website is up right now from our server: the HTTP status, where redirects lead and how long the server took to answer. "Is it down" checker.', kw: 'uptime checker, is this site down, website down checker, site availability test, server status check', about: 'Requests the page from the OpenVibe server (one location, outside your network) and reports whether it answered, the status code, every redirect and the time until the server replied — enough to settle "is it down for everyone or just me".', bullets: ['Up or down, with the HTTP status', 'Every redirect hop and the final address', 'Time until the server answered'], faq: [['The site works for me but not for a friend — what now?', 'If it is up here, the server is fine and the trouble is between your friend and the site: their DNS, their network or a regional block.'], ['Does this monitor continuously?', 'No, this is an on-demand check. It tells you the state right now.']] },
    robots: { name: 'Robots.txt Tester', title: 'Robots.txt Tester & Analyzer — Online Checker', desc: 'Fetch and analyse any site\'s robots.txt, check which URLs are blocked, and catch rules that hide your site from search engines.', kw: 'robots.txt tester, robots txt checker, crawl rules, disallow checker, seo crawl test', about: 'Read a site\'s robots.txt, see the rules that apply to each crawler, and test whether a specific URL would be allowed or blocked — the file where an accidental line can remove a whole site from search.', bullets: ['Rules grouped by user-agent', 'Test any URL against the live rules', 'Flags the accidental site-wide disallow'], faq: [['Does robots.txt remove a page from Google?', 'No. It stops crawling, not indexing — a blocked URL can still appear without a description. Use a noindex meta tag to remove a page properly.'], ['Should robots.txt list my sitemap?', 'Yes. A Sitemap line is the simplest way to point every crawler at your sitemap without registering anywhere.']] },
    sitemap: { name: 'Sitemap Validator', title: 'Sitemap.xml Validator — Online XML Sitemap Checker', desc: 'Check an XML sitemap: its structure, URL count, loc and lastmod values, and sitemap index files, so search engines can read it. Instant.', kw: 'sitemap validator, sitemap.xml checker, xml sitemap test, sitemap errors, seo sitemap check', about: 'Fetches a sitemap (gzipped too) and checks it against the sitemaps.org protocol: the root element and namespace, the URL count, that every loc is an absolute URL on the same site and that lastmod dates are in W3C format. A sitemap index is followed to its first child sitemaps.', bullets: ['Structure, namespace, loc and lastmod checks', 'URL count against the 50,000 entry limit', 'Follows a sitemap index to its first three sitemaps'], faq: [['How many URLs can one sitemap hold?', '50,000 URLs or 50 MB uncompressed. Beyond that, split it and reference the parts from a sitemap index.'], ['Does lastmod matter?', 'Yes, when it is accurate. Crawlers use it to prioritise re-crawling, but they learn to ignore it if every URL claims to have changed today.']] },
};

// ── Barcode & QR tools (hub: barcodes.openvibe.tools, the family 'codes'; public/codes.html, all in the browser) ─────────
const API_FAQ = ['Can I make codes from a script, a spreadsheet or an AI agent?', 'Yes, with no account. https://openvibe.tools/api/codes/qrcode.svg?text=Hello is the image itself (any symbology, .svg or .png; /api/codes lists them), so it works in an <img> tag or Markdown. POST /api/v1/tools/<tool>/run answers JSON, and the OpenAPI document is at https://openvibe.tools/api/v1/openapi.json.'];
const PRIVATE = ['Is anything I type or scan uploaded?', 'No. Codes are drawn and read inside your browser (bwip-js and the ZXing reader, compiled to WebAssembly); nothing you type, upload or point the camera at reaches our servers.'];
const CODES = {
    codes: {
        name: 'Barcode & QR Tools', title: 'Barcode & QR Code Tools — Generate, Scan and Check Every Kind of Code',
        desc: 'Make QR codes, barcodes, Data Matrix and 100+ other symbologies, scan them with your camera or a picture, and check GTIN, ISBN and GS1 numbers. Free, in your browser.',
        kw: 'barcode generator, qr code generator, barcode scanner, qr scanner, data matrix, gtin, gs1, ean-13, upc, code 128',
        about: 'Everything for codes in one place: a QR studio with styles and logos, a generator for every barcode in common use (retail, logistics, postal, pharma and 2D), a scanner for your camera or pictures, and a checker that fixes GTIN, ISBN and SSCC check digits and reads GS1 labels. Each tool works out what you typed and picks the right code for it.',
        bullets: ['Over 100 symbologies, from EAN-13 and Code 128 to PDF417, Aztec, MaxiCode and DotCode', 'Every code is test-scanned as you make it, so you know it reads', 'PNG at print resolution or vector SVG, sized in pixels or millimetres', 'Nothing leaves your browser'],
        faq: [PRIVATE, ['Do the codes expire?', 'No. The codes are static: what you encode is in the pattern itself, with no redirect service in between, so they work for as long as the printout lasts.']],
    },
    qr: {
        name: 'QR Code Generator', title: 'QR Code Generator — Free, No Sign-Up, With Logo, Colours and SVG',
        desc: 'Make a QR code for a link, Wi-Fi, a contact card, an email, a text or an event. Rounded or dotted styles, colours, a logo, PNG or SVG, test-scanned before you download.',
        kw: 'qr code generator, free qr code, qr code with logo, custom qr code, qr code svg, wifi qr code, vcard qr code, dynamic qr alternative',
        about: 'Pick what the code should do (open a link, join a Wi-Fi network, save a contact, start an email or a text, add an event, show a place) and fill in the fields. Style it with rounded or dotted modules, your colours and a logo in the middle; the error correction rises on its own so the logo never breaks the code. Every change is test-scanned, and the preview tells you if a colour or a logo makes it hard to read.',
        bullets: ['Nine content types, each written in the format phone cameras understand', 'Square, rounded, dot and fluid styles; eye shapes; colours, gradients and a logo', 'Automatic error correction and a live scan check', 'PNG up to 4000 px or vector SVG; print size in millimetres'],
        faq: [['Will this QR code stop working?', 'No. It is a static QR code: the link or text is encoded directly, with no short-link service in between that could expire or be switched off.'], ['Can I put my logo in a QR code?', 'Yes. Add a picture and the generator raises the error correction to level H and clears the space behind it, then checks the result still scans.'], ['What size should I print it?', 'A good rule is one tenth of the scanning distance: about 2 cm across for a business card read at 20 cm, 30 cm for a poster read from 3 metres. The size box converts pixels to millimetres for you.'], PRIVATE],
    },
    barcode: {
        name: 'Barcode Generator', title: 'Barcode Generator — EAN, UPC, Code 128, GS1 and 100+ Types, Free',
        desc: 'Generate any barcode: EAN-13, UPC-A, Code 128, Code 39, ITF-14, GS1-128, PDF417, Data Matrix and more. Smart type detection, check digits fixed, PNG or SVG at print size.',
        kw: 'barcode generator, free barcode generator, online barcode maker, code 128, ean-13, upc-a, code 39, itf-14, gs1-128, barcode svg',
        about: 'Type what you want to encode and the generator suggests the right symbology: a product number goes in EAN-13 or UPC-A with its check digit verified, a shipping container in GS1-128, digits in Interleaved 2 of 5, anything longer in a 2D code. Or choose from more than a hundred symbologies yourself. Set the bar height, the text, colours, rotation and quiet zone, and size it exactly for print at the resolution of your printer.',
        bullets: ['More than 100 symbologies: retail, industrial, GS1, postal, pharmaceutical and 2D', 'Detects GTIN, ISBN, ISSN, SSCC and UPC-E numbers and corrects their check digits', 'Width in millimetres at your printer\'s DPI, so bars land on whole dots', 'PNG, SVG or a copy to the clipboard'],
        faq: [['Which barcode should I use?', 'For products sold in shops, EAN-13 (or UPC-A in North America) with a GTIN from GS1. For your own labels, inventory and tickets, Code 128 is the dense, universal choice. If you need more than about 40 characters, use a 2D code such as QR or Data Matrix.'], ['Can I make a barcode for a product I sell?', 'You can draw any number, but a retail barcode only means something if the GTIN is registered to you by GS1. The generator checks the check digit; it cannot check who owns the number.'], PRIVATE],
    },
    scan: {
        name: 'Barcode & QR Scanner', title: 'QR Code & Barcode Scanner Online — Camera or Picture, Free',
        desc: 'Scan QR codes, barcodes, Data Matrix, PDF417 and more with your camera or from a picture or screenshot. Reads several codes at once and explains what each one contains.',
        kw: 'qr code scanner, barcode scanner online, scan qr code from image, qr reader, barcode reader, scan barcode with camera, data matrix reader',
        about: 'Point your camera at a code, or drop, paste or upload a picture or screenshot. The scanner reads every code it finds (QR, Micro QR, Data Matrix, Aztec, PDF417, MaxiCode, EAN, UPC, Code 128, Code 39, ITF, Codabar, GS1 DataBar and more), outlines each one, and says what it holds: a Wi-Fi network with its password, a contact card, a link and where it goes, a product number with its check digit, or GS1 data split into fields.',
        bullets: ['Camera scanning with torch and camera switching on phones', 'Pictures, screenshots and pasted images, several codes at once', 'Explains Wi-Fi, contacts, events, links, GTINs and GS1 data', 'Links are shown in full before you open them'],
        faq: [['Is it safe to scan an unknown QR code?', 'The scanner never opens anything by itself. A link is shown with its full address first, and only links starting with http or https get an Open button.'], ['Why does my code not scan?', 'Try more light and hold the code flat, filling about half the frame. For a picture, crop closer to the code; very small or blurry codes may need a sharper photo.'], PRIVATE],
    },
    datamatrix: {
        name: 'Data Matrix Generator', title: 'Data Matrix Code Generator — GS1 DataMatrix, Square or Rectangular',
        desc: 'Make Data Matrix codes for parts marking, healthcare and GS1 labels. Square or rectangular, GS1 DataMatrix with Application Identifiers, PNG or SVG.',
        kw: 'data matrix generator, datamatrix code, gs1 datamatrix, 2d barcode generator, data matrix ecc200, dpm code, udi barcode',
        about: 'Data Matrix packs a lot into a small square: up to 2,335 characters, and still readable when part of it is damaged. It is the code on electronic parts, medical devices (UDI) and pharmaceutical packs. Type text or switch to GS1 mode and add Application Identifiers (GTIN, batch, expiry, serial); the generator checks each field before it draws the code.',
        bullets: ['ECC 200 Data Matrix, square or rectangular', 'GS1 DataMatrix with checked Application Identifiers', 'Module size in millimetres for laser and inkjet marking', 'PNG or SVG'],
        faq: [['What is the difference between Data Matrix and QR?', 'Both are 2D codes. Data Matrix is smaller for the same data and is the standard for industrial and healthcare marking; QR is what phone cameras open by default.'], PRIVATE],
    },
    gs1: {
        name: 'GTIN Check Digit & GS1 Parser', title: 'GTIN Check Digit Calculator — EAN, UPC, ISBN, SSCC and GS1 Parser',
        desc: 'Calculate and verify check digits for GTIN-8, UPC-A, EAN-13, GTIN-14, SSCC, GLN and ISBN. Convert ISBN-10 to ISBN-13 and UPC-E to UPC-A, and read GS1 element strings.',
        kw: 'gtin check digit calculator, ean check digit, upc check digit, isbn converter, isbn-10 to isbn-13, sscc check digit, gs1 parser, gs1 application identifiers, upc-e to upc-a',
        about: 'Type a product, book or shipping number and the checker names it (GTIN-8, UPC-A, EAN-13, GTIN-14, SSCC, ISBN, ISSN, UPC-E), says whether its check digit is right and what it should be. It converts between ISBN-10 and ISBN-13 and expands UPC-E. Paste a GS1 element string, bracketed or raw from a scanner, and it splits it into Application Identifiers with dates, weights and check digits verified.',
        bullets: ['Check digits for every GS1 key, and ISBN-10\'s mod 11', 'ISBN-10 ↔ ISBN-13, UPC-E → UPC-A, GTIN-13 → GTIN-14', 'GS1 element strings split into labelled, validated fields', 'One click to the matching barcode'],
        faq: [['How is a GTIN check digit calculated?', 'From the right, digits are multiplied alternately by 3 and 1 and added up; the check digit is what brings the total to the next multiple of 10.'], ['What is a GS1 Application Identifier?', 'A number in brackets that says what the data after it is: (01) a GTIN, (17) an expiry date, (10) a batch, (21) a serial number. Labels on cartons, pallets and medicines use them.'], PRIVATE],
    },
    wifiqr: {
        name: 'Wi-Fi QR Code Generator', title: 'Wi-Fi QR Code Generator — Guests Join Without Typing the Password',
        desc: 'Make a QR code that joins your Wi-Fi network: phone cameras on iPhone and Android connect when they scan it. WPA, WPA3, WEP or open; print it as a card.',
        kw: 'wifi qr code, wifi qr code generator, qr code for wifi password, share wifi qr, guest wifi qr code',
        about: 'Enter the network name and password and print the code for guests, a café table or a rental. Scanning it with the phone camera offers to join the network; nobody has to read out or type a long password. The password never leaves your browser.',
        bullets: ['WPA/WPA2/WPA3, WEP, open and hidden networks', 'Special characters escaped the way phones expect', 'A printable card with the network name under the code', 'Made entirely in your browser'],
        faq: [['Does the Wi-Fi QR code work on iPhone?', 'Yes. The iPhone camera (iOS 11 and later) and Android cameras both recognise Wi-Fi codes and offer to join.'], PRIVATE],
    },
    vcardqr: {
        name: 'Contact QR Code (vCard)', title: 'vCard QR Code Generator — Contact Details as a QR Code',
        desc: 'Turn your name, phone, email, company and website into a QR code that saves as a contact when scanned. For business cards, badges and email signatures.',
        kw: 'vcard qr code, contact qr code, business card qr code, qr code contact card, vcard generator',
        about: 'Fill in the details you want to share and the generator writes a vCard 3.0 that every phone can save in one tap. Keep it short (name, phone, email) for a small, easy-to-scan code on a business card, or add the company, title, address and website.',
        bullets: ['vCard 3.0, read by iPhone and Android cameras', 'Size warning when the card grows too dense to print small', 'PNG or SVG for print', 'Made in your browser'],
        faq: [['Why is my contact QR code so dense?', 'Every field adds characters. A name, phone and email make a small code; add an address and a long title and it grows. Leave out what people do not need.'], PRIVATE],
    },
    bulkbarcodes: {
        name: 'Bulk Barcode & Label Generator', title: 'Bulk Barcode Generator — Hundreds of Barcodes or QR Codes From a List',
        desc: 'Paste a list or a CSV and get a barcode or QR code for every line: a ZIP of PNG or SVG files, or a printable sheet of labels sized in millimetres.',
        kw: 'bulk barcode generator, batch barcode generator, barcode labels, qr code bulk, barcode from csv, print barcode labels, sequential barcodes',
        about: 'Paste one value per line, or a CSV with a value and a caption, or generate a numbered sequence. Choose the symbology and style once, then download every code as a ZIP, or print a sheet of labels with your label size, columns and gaps. Lines that cannot be encoded are listed with the reason.',
        bullets: ['Values from a list, a CSV or a numbered sequence with a prefix', 'Any symbology the barcode generator supports', 'ZIP of PNG or SVG files, named after each value', 'Print-ready label sheets in millimetres'],
        faq: [['How many codes can I make at once?', 'Up to 2,000 per batch. Everything is drawn in your browser, so large batches depend on your device; a few hundred take seconds.'], PRIVATE],
    },
    code128: {
        name: 'Code 128 Barcode Generator', title: 'Code 128 Barcode Generator — Free, Online, PNG and SVG',
        desc: 'Make Code 128 barcodes for labels, inventory, shipping and tickets. Full ASCII, automatic code set switching for the shortest barcode, bar height and text options.',
        kw: 'code 128 generator, code 128 barcode, code128, barcode for labels, inventory barcode, shipping label barcode',
        about: 'Code 128 encodes letters, digits and punctuation densely, and every scanner reads it. The generator switches between code sets A, B and C automatically for the shortest result; digits pack two to a symbol.',
        bullets: ['All 128 ASCII characters', 'Automatic code set optimisation', 'Bar height, human-readable text and quiet zone', 'PNG or SVG at print size'],
        faq: [['How long can a Code 128 barcode be?', 'There is no fixed limit, but past about 20 characters a 1D barcode gets wide; for more data a 2D code such as Data Matrix or QR is easier to scan.'], PRIVATE],
    },
    ean13: {
        name: 'EAN-13 Barcode Generator', title: 'EAN-13 Barcode Generator — With Check Digit and Add-On',
        desc: 'Make EAN-13 retail barcodes with the check digit calculated and verified. Optional EAN-2 or EAN-5 add-on for magazines and books. PNG or SVG at print size.',
        kw: 'ean-13 generator, ean13 barcode, ean barcode generator, gtin-13 barcode, ean check digit, retail barcode',
        about: 'Type twelve digits and the check digit is added, or thirteen and it is verified. EAN-13 is the retail barcode outside North America; print it at 80 to 200 percent of its nominal 37.29 × 25.93 mm.',
        bullets: ['Check digit added or verified', 'EAN-2 and EAN-5 add-ons', 'Nominal size presets (80% to 200%)', 'PNG or SVG'],
        faq: [['What size should an EAN-13 be?', 'The nominal size is 37.29 mm wide by 25.93 mm high; GS1 allows 80% to 200% of it. Smaller codes need a better printer.'], PRIVATE],
    },
    upc: {
        name: 'UPC Barcode Generator', title: 'UPC-A Barcode Generator — UPC Barcodes With Check Digit',
        desc: 'Make UPC-A and UPC-E barcodes for products sold in North America. Check digit calculated and verified, UPC-E expanded, add-ons, PNG or SVG.',
        kw: 'upc generator, upc-a barcode, upc barcode generator, upc-e, upc check digit, gtin-12',
        about: 'Type eleven digits and the check digit is added, or twelve and it is verified. UPC-E, the short form for small packs, is accepted too and shown with the UPC-A it stands for.',
        bullets: ['UPC-A and UPC-E', 'Check digit added or verified', 'Add-ons for periodicals', 'PNG or SVG'],
        faq: [['Is a UPC the same as an EAN?', 'A UPC-A is a GTIN-12; put a 0 in front and it is the same number as an EAN-13. Scanners worldwide read both.'], PRIVATE],
    },
    pdf417: {
        name: 'PDF417 Barcode Generator', title: 'PDF417 Barcode Generator — Stacked 2D Codes for IDs and Tickets',
        desc: 'Make PDF417 and MicroPDF417 codes, the stacked barcode on driving licences, boarding passes and shipping labels. Columns, error correction level, PNG or SVG.',
        kw: 'pdf417 generator, pdf417 barcode, micropdf417, boarding pass barcode, driver license barcode, 2d barcode',
        about: 'PDF417 stacks rows of codewords into a wide rectangle that a laser scanner can read line by line. Choose the number of columns and the error correction level; MicroPDF417 makes a smaller code for short data.',
        bullets: ['PDF417 and MicroPDF417', 'Columns and error correction level', 'Row height control', 'PNG or SVG'],
        faq: [PRIVATE],
    },
    aztec: {
        name: 'Aztec Code Generator', title: 'Aztec Code Generator — Compact 2D Codes for Tickets',
        desc: 'Make Aztec codes, the compact 2D code on train and plane tickets. No quiet zone needed, adjustable error correction, PNG or SVG.',
        kw: 'aztec code generator, aztec barcode, ticket barcode, 2d code generator, compact aztec',
        about: 'An Aztec code grows from a bullseye in its centre and needs no blank margin around it, which is why rail and airline tickets use it. Set the error correction percentage and the generator picks the smallest size that fits.',
        bullets: ['Compact and full-range Aztec', 'Error correction from 5% to 95%', 'No quiet zone required', 'PNG or SVG'],
        faq: [PRIVATE],
    },
    isbn: {
        name: 'ISBN Barcode Generator', title: 'ISBN Barcode Generator — Book Barcodes With Price Add-On',
        desc: 'Make the barcode for a book\'s back cover from its ISBN-10 or ISBN-13, with the ISBN printed above and an optional EAN-5 price add-on.',
        kw: 'isbn barcode generator, book barcode, isbn to barcode, isbn-13 barcode, bookland ean, price add-on',
        about: 'Type the ISBN, with or without hyphens; an ISBN-10 is converted to its ISBN-13. The barcode is an EAN-13 with the ISBN printed above it, and the five-digit add-on can carry the price (for example 51995 for US $19.95).',
        bullets: ['ISBN-10 or ISBN-13 in, check digit verified', 'ISBN text above the bars', 'EAN-5 price add-on', 'Print-ready PNG or SVG'],
        faq: [['What goes in the price add-on?', 'The first digit is the currency (5 for US dollars, 6 for Canadian dollars) and the other four the price: 51995 is $19.95. Use 90000 when there is no price.'], PRIVATE],
    },
};

// ── Try examples (the tool frame, 4.55.0) ─────────────────────
// Two or three public, harmless values per input tool, under the box: a tap fills it and runs the tool. A tool
// with no input (my.ip, the generators, the webhook bin) has none. A two-box tool (diff, regex) gets [a, b] pairs.
const EXAMPLES = {
    // Network & diagnostics
    lookup: ['openvibe.network', 'example.com', '1.1.1.1'],
    ip: ['1.1.1.1', '8.8.8.8', 'openvibe.network'],
    ipv4: ['192.168.1.0/24', '8.8.8.8', '203.0.113.0/24'],
    ipv6: ['2001:db8::1', '2606:4700:4700::1111', 'openvibe.network'],
    geoip: ['1.1.1.1', '8.8.8.8', '193.0.0.1'],
    hostname: ['1.1.1.1', '8.8.8.8', '93.184.216.34'],
    isp: ['1.1.1.1', '8.8.8.8', '193.0.0.1'],
    asn: ['1.1.1.1', '8.8.8.8', '193.0.0.1'],
    rdns: ['1.1.1.1', '8.8.8.8', '93.184.216.34'],
    whois: ['openvibe.network', 'wikipedia.org', 'example.com'],
    rdap: ['openvibe.network', 'wikipedia.org', '1.1.1.1'],
    dns: ['openvibe.network', 'wikipedia.org', 'example.com'],
    dig: ['openvibe.network', 'wikipedia.org', 'example.com'],
    nslookup: ['openvibe.network', 'wikipedia.org', 'example.com'],
    dnspropagation: ['openvibe.network', 'example.com', 'wikipedia.org'],
    mx: ['openvibe.network', 'gmail.com', 'wikipedia.org'],
    txt: ['openvibe.network', 'example.com', 'wikipedia.org'],
    ns: ['openvibe.network', 'wikipedia.org', 'example.com'],
    spf: ['openvibe.network', 'example.com', 'wikipedia.org'],
    dkim: ['openvibe.network', 'example.com', 'wikipedia.org'],
    dmarc: ['openvibe.network', 'example.com', 'wikipedia.org'],
    ping: ['1.1.1.1', 'openvibe.network', 'example.com'],
    traceroute: ['1.1.1.1', 'openvibe.network', 'example.com'],
    mtr: ['1.1.1.1', 'openvibe.network', 'example.com'],
    port: ['openvibe.network', '1.1.1.1', 'example.com'],
    headers: ['https://openvibe.network', 'https://example.com', 'https://wikipedia.org'],
    redirects: ['https://openvibe.network', 'https://example.com', 'http://wikipedia.org'],
    ssl: ['openvibe.network', 'wikipedia.org', 'example.com'],
    curl: ['https://openvibe.network', 'https://example.com', 'https://wikipedia.org'],
    httpstatus: ['https://openvibe.network', 'https://example.com', 'https://wikipedia.org'],
    latency: ['1.1.1.1', 'openvibe.network', 'example.com'],
    blacklist: ['1.1.1.1', '8.8.8.8', 'example.com'],
    reputation: ['openvibe.network', 'example.com', '1.1.1.1'],
    smtp: ['openvibe.network', 'example.com', 'gmail.com'],
    uptime: ['https://openvibe.network', 'https://example.com', 'https://wikipedia.org'],
    robots: ['openvibe.network', 'wikipedia.org', 'example.com'],
    sitemap: ['openvibe.network', 'wikipedia.org', 'example.com'],
    // Developer tools
    jsonfmt: ['{"name":"openvibe","version":1,"active":true}', '{"a":1,"b":[2,3]}', '{"name": }'],
    yaml: ['name: openvibe\nversion: 1\nactive: true', 'services:\n  web:\n    image: nginx', 'a: 1\n b: 2'],
    xml: ['<catalog><item id="1"><name>OpenVibe</name></item></catalog>', '<?xml version="1.0"?><root><a>1</a></root>'],
    csv: ['name,age,city\nAda,36,London\nLinus,55,Portland', 'a,b\n1,2\n3,4'],
    sql: ['select u.id, u.name from users u join orders o on u.id = o.user_id where o.total > 100 order by o.total desc', 'select * from users where active = true'],
    md: ['# Hello\n\nThis is **bold** and *italic*.\n\n- one\n- two', '## Notes\n\nA [link](https://openvibe.network).'],
    html: ['<div><p>Hello <strong>World</strong></p></div>', '<section><h1>OpenVibe</h1></section>'],
    base64: ['Hello, World!', 'openvibe.network', 'The quick brown fox'],
    url: ['https://openvibe.tools/search?q=hello world&lang=en#results', 'a b&c', 'hello/world?x=1'],
    // Public example tokens made for the Try links (no key, no account, not a secret).
    jwt: ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6Ik9wZW5WaWJlIiwiaWF0IjoxNTE2MjM5MDIyfQ.c2lnbmF0dXJl', 'eyJhbGciOiJub25lIn0.eyJzdWIiOiJleGFtcGxlIiwicm9sZSI6InJlYWRlciJ9.', 'not.a.jwt'], // gitleaks:allow (public examples)
    hash: ['Hello, World!', 'openvibe.network', 'The quick brown fox'],
    hex: ['Hello', '4f70656e56696265', 'openvibe'],
    entities: ['<script>alert("hello")</script>', 'Tom & Jerry', 'a "quote" and \'single\''],
    cron: ['*/15 9-17 * * 1-5', '0 3 * * *', '*/5 * * * *'],
    beautify: ['{"a":1,"b":[2,3],"c":{"d":true}}', '<div><p>Hi</p></div>', '.a{color:red}'],
    minify: ['{\n  "name": "openvibe",\n  "version": 1\n}', '<!-- c -->\n<div>\n  <p>Hi</p>\n</div>'],
    codediff: [['Line one\nLine two\nLine three\nLine four', 'Line one\nLine 2 modified\nLine three\nLine five\nLine six'], ['a\nb\nc', 'a\nB\nc']],
    regex: [['\\b[A-Z][a-z]+\\b', 'Hello World from OpenVibe.Tools today'], ['\\d{4}-\\d{2}-\\d{2}', 'Released 2026-10-30 on openvibe.tools']],
    slugify: ['Hello World! This is a Test -- 2024', 'OpenVibe.Tools — every tool', 'Café au lait'],
    curlconvert: ["curl -X POST https://api.example.com/users -H 'Content-Type: application/json' -d '{\"name\":\"openvibe\"}'", 'curl https://openvibe.network', 'curl -I https://example.com'],
    color: ['#a78bfa', '#ff7a1a', 'rgb(255,122,26)'],
    opengraph: ['https://openvibe.network', 'https://wikipedia.org', 'https://example.com'],
    read: ['https://openvibe.network', 'https://wikipedia.org', 'https://example.com'],
    jsminify: ['function greet(name) {\n  // say hello\n  const message = "Hello, " + name + "!";\n  console.log(message);\n  return message;\n}', 'const a = 1;  // comment\nconsole.log(a);'],
    jsformat: ['function greet(n){const m="Hello, "+n+"!";console.log(m);return m}greet("OpenVibe");', 'const add=(a,b)=>a+b;export default add;'],
    cssminify: ['/* card */\n.card {\n  color: #ffffff;\n  margin: 0px;\n  padding: 12px;\n}', '.row { display: flex; gap: 0px; }\n/* end */'],
    cssformat: ['.card{color:#fff;margin:0 0 10px;padding:12px}.card:hover{color:#3b82f6}', '@media (max-width:600px){.card{padding:8px}}'],
    htmlminify: ['<!-- header -->\n<div class="card">\n    <p>Hello <strong>World</strong></p>\n</div>', '<section>\n  <h1>OpenVibe</h1>\n</section>'],
    xmlminify: ['<?xml version="1.0"?>\n<!-- catalog -->\n<catalog>\n  <item id="1">\n    <name>OpenVibe</name>\n  </item>\n</catalog>', '<rss><channel><title>OpenVibe</title></channel></rss>'],
    jsonminify: ['{\n  "name": "openvibe",\n  "version": 1,\n  "tags": ["open", "source"]\n}', '{"a": [1, 2, 3], "b": {"c": true}}'],
    jsonparse: ['{"user":{"id":7,"name":"Ada","roles":["admin","dev"],"active":true},"count":2}', '{"items":[{"id":1},{"id":2}],"next":null}'],
    jsonvalidate: ['{"name":"openvibe","version":1,"active":true}', '{\n  "name": "openvibe",\n  "version": 1,\n}'],
    jsonstringify: ['{"name":"openvibe","note":"line one\\nline two"}', '"{\\"a\\":1}"'],
    html2md: ['<h1>Hello World</h1>\n<p>This is <strong>bold</strong> and <a href="https://openvibe.network">a link</a>.</p>\n<ul><li>One</li><li>Two</li></ul>', '<blockquote>A quote</blockquote><pre><code>openvibe</code></pre>'],
    md2html: ['# Hello World\n\nThis is **bold** and *italic* with a [link](https://openvibe.network).\n\n- one\n- two', '> A quote\n\n`inline code`'],
};

// The examples live on the record too, so the catalogue, the page and any future caller read the same values.
for (const [sub, examples] of Object.entries(EXAMPLES)) { const rec = DEV[sub] || NET[sub]; if (rec) rec.examples = examples; }

// ── The tools' modes ─────────────────────────────────────────
// A dev tool's modes are the verbs in its box: one mode is the button itself ("Validate"), several are the kit's
// segmented control with the button saying the active one ("Encode"). Mirrors dev.html's T[...].m; a test keeps them
// equal. Network tools have no modes (their options are record types and ports).
const MODES = {
    jsonfmt: ['Format', 'Validate', 'Minify'],
    yaml: ['YAML→JSON', 'JSON→YAML'],
    xml: ['Format', 'Validate', 'Minify'],
    csv: ['Table', 'To JSON'],
    sql: ['Format', 'Uppercase', 'Compact'],
    md: ['Preview', 'To HTML'],
    html: ['Format', 'Minify', 'Entities', 'Unescape'],
    base64: ['Encode', 'Decode'],
    url: ['Encode', 'Decode', 'Parse'],
    jwt: ['Decode'],
    uuid: ['Generate', 'Bulk 10', 'Bulk 100', 'Validate'],
    hash: ['SHA-256', 'SHA-1', 'SHA-512'],
    hex: ['To Hex', 'From Hex'],
    entities: ['HTML Enc', 'HTML Dec', 'JS Esc', 'JS Unesc', 'URL Enc', 'URL Dec'],
    timestamp: ['Now', 'To Date', 'To Unix'],
    cron: ['Parse'],
    beautify: ['JSON', 'HTML', 'CSS'],
    minify: ['JSON', 'HTML', 'CSS'],
    codediff: ['Compare'],
    regex: ['Test'],
    slugify: ['Generate'],
    lorem: ['1 Para', '3 Para', '5 Para', '10 Sent', '50 Words'],
    curlconvert: ['To fetch', 'To Python', 'To Node', 'Parsed'],
    webhook: ['Create Bin'],
    color: ['Convert'],
    opengraph: ['Preview'],
    read: ['Markdown', 'Text'],
    jsminify: ['Minify', 'Minify + mangle', 'Whitespace only'],
    jsformat: ['Beautify'],
    cssminify: ['Minify'],
    cssformat: ['Beautify'],
    htmlminify: ['Minify'],
    xmlminify: ['Minify'],
    jsonminify: ['Minify'],
    jsonparse: ['Tree', 'Paths', 'Types'],
    jsonvalidate: ['Validate'],
    jsonstringify: ['Stringify', 'Parse string'],
    html2md: ['Convert'],
    md2html: ['To HTML', 'Preview'],
};

for (const [sub, modes] of Object.entries(MODES)) { const rec = DEV[sub]; if (rec) rec.modes = modes; }

const CATALOG = new Map();
for (const [sub, rec] of Object.entries(DEV)) CATALOG.set(sub, { ...rec, sub, family: 'dev', hub: sub === 'dev' });
for (const [sub, rec] of Object.entries(NET)) CATALOG.set(sub, { ...rec, sub, family: 'net', hub: sub === 'net' });
for (const [sub, rec] of Object.entries(CODES)) CATALOG.set(sub, { ...rec, faq: sub === 'scan' ? rec.faq : [...rec.faq, API_FAQ], sub, family: 'codes', hub: sub === 'codes' });

/** SEO record for a subdomain, or null when it is not a catalogued tool. */
function seoFor(sub) { return CATALOG.get(sub) || null; }

/** Sibling tools in the same family, for the "related tools" block and internal linking. */
function relatedTo(sub, limit = 6) {
    const rec = CATALOG.get(sub);
    if (!rec) return [];
    const words = new Set(String(rec.kw || '').toLowerCase().split(/[,\s]+/).filter(w => w.length > 3));
    const scored = [];
    for (const [otherSub, other] of CATALOG) {
        if (otherSub === sub || other.hub || other.family !== rec.family) continue;
        let score = 0;
        for (const w of String(other.kw || '').toLowerCase().split(/[,\s]+/)) if (words.has(w)) score++;
        scored.push({ sub: otherSub, name: other.name, desc: other.desc, score });
    }
    scored.sort((a, b) => b.score - a.score || a.sub.localeCompare(b.sub));
    return scored.slice(0, limit);
}

module.exports = { CATALOG, DEV, NET, CODES, seoFor, relatedTo, BRAND };
