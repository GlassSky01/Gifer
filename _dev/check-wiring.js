/* 静态接线检查：index.html 里的 id 与 app.js 里 $('...') 的 id 必须一一对应。
   这类拼写错误是纯手写 DOM 代码最常见的翻车点，用脚本查最可靠。 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

const htmlIds = new Set();
for (const m of html.matchAll(/\bid="([^"]+)"/g)) htmlIds.add(m[1]);

const usedIds = new Set();
for (const m of app.matchAll(/\$\('([^']+)'\)/g)) usedIds.add(m[1]);

const missing = [...usedIds].filter(i => !htmlIds.has(i));
const unused = [...htmlIds].filter(i => !usedIds.has(i));

// 脚本引用是否都存在
const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
const missingScripts = scripts.filter(s => !fs.existsSync(path.join(ROOT, s)));

console.log('HTML 中的 id      :', [...htmlIds].join(', '));
console.log('app.js 引用的 id  :', [...usedIds].join(', '));
console.log('缺失的 id         :', missing.length ? '❌ ' + missing.join(', ') : '✅ 无');
console.log('未被引用的 id     :', unused.length ? '（正常，可能只是容器）' + unused.join(', ') : '无');
console.log('脚本引用          :', scripts.join(', '));
console.log('脚本缺失          :', missingScripts.length ? '❌ ' + missingScripts.join(', ') : '✅ 无');

// 顺带把 app.js 里用到的全局依赖列出来
for (const g of ['GiferGif', 'GiferRender']) {
  const inHtml = scripts.some(s => {
    const src = fs.readFileSync(path.join(ROOT, s), 'utf8');
    return src.includes('root.' + g + ' =');
  });
  console.log(`全局 ${g} 的定义来源:`, inHtml ? '✅ 已由页面脚本提供' : '❌ 找不到');
}

/* ---------- 结构完整性 ---------- */
const idsAll = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
const dups = idsAll.filter((v, i) => idsAll.indexOf(v) !== i);
console.log('id 重复项        :', dups.length ? '❌ ' + dups.join(', ') : '✅ 无');

const body = html.slice(html.indexOf('<body>'), html.indexOf('</body>'));
const pairs = [['div'], ['aside'], ['main'], ['section']];
let unbalanced = [];
for (const [tag] of pairs) {
  const o = (body.match(new RegExp('<' + tag + '\\b', 'g')) || []).length;
  const c = (body.match(new RegExp('</' + tag + '>', 'g')) || []).length;
  if (o !== c) unbalanced.push(`${tag} ${o}/${c}`);
}
console.log('标签配对          :', unbalanced.length ? '❌ ' + unbalanced.join(', ') : '✅ 平衡');

const ob = (html.match(/\{/g) || []).length, cb = (html.match(/\}/g) || []).length;
console.log('CSS 花括号        :', ob === cb ? `✅ ${ob}/${cb}` : `❌ ${ob}/${cb}`);

process.exit(missing.length || missingScripts.length || dups.length || unbalanced.length || ob !== cb ? 1 : 0);
