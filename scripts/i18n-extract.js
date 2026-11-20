// Lists the English text the app can show, so translations can be checked against it. Run after a build.
const fs = require('node:fs');
const path = require('node:path');
const acorn = require('acorn');

const walk = { full(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((v) => walk.full(v, visit));
    else if (value && typeof value.type === 'string') walk.full(value, visit);
  }
} };

const root = path.join(__dirname, '..');
const sources = [...fs.readdirSync(path.join(root, 'dist/renderer')).filter((f) => f.endsWith('.js') && !/^(i18n|locales|jsQR)\.js$|worker/.test(f)).map((f) => `dist/renderer/${f}`), ...fs.readdirSync(path.join(root, 'dist/main')).filter((f) => f.endsWith('.js') && !/tornado-worker|solpool-worker|swap-keys|preload|^main\.js$/.test(f) && fs.statSync(path.join(root, 'dist/main', f)).size < 500_000).map((f) => `dist/main/${f}`)];
const NOT_TEXT_KEYS = new Set(['class', 'id', 'type', 'for', 'role', 'file', 'src', 'href', 'name', 'autocomplete', 'inputmode', 'spellcheck', 'method', 'asset', 'status', 'direction', 'phase', 'providerId', 'encoding', 'commitment', 'chain', 'abbr', 'coin', 'ticker', 'network', 'fallback', 'kind', 'stage']);
const looksLikeText = (s) => /[a-z]/.test(s) && /[A-Za-z]{2}/.test(s) && !/^https?:|^[a-z-]+:\/\/|^[./]|\.(js|png|json|html|css|exe|so)$|^0x|^m\/44|^[a-z0-9_-]+$|^[a-z]+(\.[a-z]+)+$|^[a-z-]+( [a-z-]+)*$|^#|^\w+:\w+$|^[A-Z_]+$|^[a-z]+[A-Z]/.test(s) && /[A-Z ]/.test(s);
const found = new Set();
function add(text) {
  if (text.length > 700) return;
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length >= 2 && looksLikeText(clean) && /^[A-Z"'(0-9{]|^[a-z]+ /.test(clean)) found.add(clean);
}
for (const file of sources) {
  const code = require('esbuild').transformSync(fs.readFileSync(path.join(root, file), 'utf8'), { target: 'es2018', loader: 'js', format: 'cjs' }).code;
  const main = file.startsWith('dist/main/');
  const ast = acorn.parse(code, { ecmaVersion: 2020, sourceType: 'script', allowHashBang: true, allowReturnOutsideFunction: true });
  const skip = new Set();
  walk.full(ast, (n) => {
    if (n.type === 'Property' && !n.computed && NOT_TEXT_KEYS.has(n.key.name ?? n.key.value)) skip.add(n.value);
    if (n.type === 'CallExpression' && n.callee.type === 'Identifier' && ['require', 'getElementById', 'querySelector'].includes(n.callee.name)) n.arguments.forEach((a) => skip.add(a));
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && ['require', 'on', 'emit', 'call', 'getElementById', 'querySelector', 'setAttribute', 'addEventListener', 'createElement', 'startsWith', 'includes', 'getItem', 'setItem'].includes(n.callee.property.name)) n.arguments.forEach((a) => skip.add(a));
    if (n.type === 'BinaryExpression' && /[=!]==?/.test(n.operator)) { skip.add(n.left); skip.add(n.right); }
  });
  walk.full(ast, (n) => {
    if (skip.has(n)) return;
    // The wallet's own code only shows people the text of errors and of fields made for the screen.
    if (n.type === 'Literal' && typeof n.value === 'string') add(n.value);
    if (n.type === 'TemplateLiteral') add(n.quasis.map((q, i) => q.value.cooked + (i < n.expressions.length ? `{${i}}` : '')).join(''));
  });
}
fs.mkdirSync(path.join(root, 'locales'), { recursive: true });
const list = [...found].sort();
fs.writeFileSync(process.argv[2] ?? path.join(root, 'locales/source.txt'), list.join('\n') + '\n');
console.log(list.length, 'strings', list.join(' ').length, 'characters');
