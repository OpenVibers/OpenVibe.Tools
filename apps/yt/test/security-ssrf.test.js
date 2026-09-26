'use strict';
/**
 * yt-dlp is handed only YouTube video links (roadmap WS-R task 5, the SSRF class). The downloader
 * runs yt-dlp on the link a visitor pastes, so the link decides where yt-dlp connects: a YouTube
 * host was the only check, and file:, ftp:, gopher: or a YouTube host on another port passed it.
 * Now only http(s) on YouTube's hosts and default ports, with no credentials, are accepted; every
 * look-alike, internal address and scheme trick is refused before yt-dlp starts.
 */
const assert = require('assert');
const { isValidUrl } = require('../server/downloader');

for (const good of ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/dQw4w9WgXcQ', 'https://m.youtube.com/shorts/abcdefghijk', 'http://youtube.com/watch?v=dQw4w9WgXcQ', 'https://music.youtube.com/watch?v=dQw4w9WgXcQ']) {
    assert.strictEqual(isValidUrl(good), true, good);
}
for (const bad of [
    'file://www.youtube.com/etc/passwd', 'ftp://www.youtube.com/x', 'gopher://youtube.com/_x', 'data:text/plain,youtube.com', 'javascript://youtube.com/%0aalert(1)',
    'https://www.youtube.com:8443/watch?v=x', 'http://youtube.com:6379/', 'https://user:pw@www.youtube.com/watch?v=x',
    'https://www.youtube.com@127.0.0.1/watch?v=x', 'https://youtube.com.evil.example/watch?v=x', 'https://evil.example/www.youtube.com/watch?v=x',
    'https://evil.example/?u=https://www.youtube.com/watch', 'https://notyoutube.com/watch?v=x', 'http://127.0.0.1/watch?v=x', 'http://2130706433/watch?v=x',
    'http://[::1]/watch?v=x', 'http://169.254.169.254/latest/meta-data/', 'not a url', '',
]) {
    assert.strictEqual(isValidUrl(bad), false, bad);
}
console.log('yt security-ssrf: only YouTube video links reach yt-dlp');
process.exit(0);
