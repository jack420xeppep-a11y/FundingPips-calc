import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

test('iOS home-screen metadata points to the branded touch icon', async () => {
  const html = await readFile(projectFile('index.html'), 'utf8');

  assert.match(html, /rel="apple-touch-icon"[^>]+apple-touch-icon\.png/);
  assert.match(html, /apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /apple-mobile-web-app-title" content="CalcPro"/);
  await access(projectFile('public/apple-touch-icon.png'));
});

test('web app manifest provides standalone install icons', async () => {
  const manifest = JSON.parse(await readFile(projectFile('public/site.webmanifest'), 'utf8'));

  assert.equal(manifest.short_name, 'CalcPro');
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(manifest.icons.map((icon) => icon.sizes), ['192x192', '512x512', '1024x1024']);

  await Promise.all(manifest.icons.map((icon) => access(projectFile(`public${icon.src}`))));
});
