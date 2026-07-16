import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('gold intelligence systemd unit isolates code, state, and network surface', () => {
  const unit = read('./calcpro-gold-intelligence.service');
  assert.match(unit, /^User=fundingpips-deploy$/m);
  assert.match(unit, /^WorkingDirectory=\/opt\/fundingpips-calc-intelligence$/m);
  assert.match(unit, /intelligence\/index\.js/);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ProtectHome=true$/m);
  assert.match(unit, /^NoNewPrivileges=true$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/calcpro-intelligence$/m);
  assert.match(unit, /^RestrictAddressFamilies=AF_INET AF_INET6$/m);
  assert.doesNotMatch(unit, /EnvironmentFile|PrivateKey|proxy/i);
});

test('Caddy and Vite route aggregate intelligence before generic API traffic', () => {
  const caddy = read('./farmcalc.caddy');
  const vite = read('../vite.config.js');
  assert.match(caddy, /@intelligence path \/api\/intelligence\/\*/);
  assert.match(caddy, /reverse_proxy @intelligence 127\.0\.0\.1:8788/);
  assert.ok(caddy.indexOf('@intelligence') < caddy.indexOf('@quoteRelay'));
  assert.match(vite, /'\/api\/intelligence': 'http:\/\/127\.0\.0\.1:8788'/);
  assert.ok(vite.indexOf("'/api/intelligence'") < vite.indexOf("'/api'"));
});

test('restricted deploy and CI publish, restart, and verify intelligence explicitly', () => {
  const deploy = read('./fundingpips-calc-deploy');
  const workflow = read('../.github/workflows/deploy.yml');
  assert.match(deploy, /calcpro-intelligence-restart/);
  assert.match(deploy, /calcpro-intelligence-status/);
  assert.match(deploy, /\/opt\/fundingpips-calc-intelligence\//);
  assert.match(workflow, /release\/intelligence/);
  assert.match(workflow, /calcpro-intelligence-restart/);
  assert.match(workflow, /api\/intelligence\/health/);
  assert.match(workflow, /"schemaVersion":1/);
});
