// Shared browser launch helper. Prefers a Playwright-managed chromium;
// falls back to the @sparticuz/chromium npm binary (with its bundled
// Amazon-Linux libs, extracted on demand) when the Playwright download
// CDN is unreachable from this sandbox.
import {chromium} from 'playwright-core';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {brotliDecompressSync} from 'node:zlib';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function sparticuzLibs() {
    const dir = join(tmpdir(), 'sparticuz-libs');
    const marker = join(dir, 'lib', 'libnss3.so');
    if (!existsSync(marker)) {
        const br = join(tmpdir(), 'chromium.br-al2023');
        const pkg = join(tmpdir(), '..', 'home', 'user', 'mathslate', 'tests', 'node_modules', '@sparticuz', 'chromium', 'bin', 'al2023.tar.br');
        const tar = join(tmpdir(), 'al2023.tar');
        writeFileSync(tar, brotliDecompressSync(readFileSync(pkg)));
        mkdirSync(dir, {recursive: true});
        execFileSync('tar', ['xf', tar, '-C', dir]);
    }
    return join(dir, 'lib');
}

export async function launch() {
    try {
        return await chromium.launch();
    } catch (e) {
        const sparticuz = (await import('@sparticuz/chromium')).default;
        const executablePath = await sparticuz.executablePath();
        if (!existsSync(executablePath)) { throw e; }
        const libdir = sparticuzLibs();
        return await chromium.launch({
            executablePath,
            args: [...sparticuz.args, '--no-sandbox'],
            env: {...process.env, LD_LIBRARY_PATH: libdir + ':' + (process.env.LD_LIBRARY_PATH || '')}
        });
    }
}
