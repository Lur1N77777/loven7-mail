import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const routeUrl = new URL('../functions/api/share/[token]/mail/[id].ts', import.meta.url);
const source = await readFile(routeUrl, 'utf8');

assert.match(source, /updateShareRecord/, 'shared-mail removal must update only the share record');
assert.match(source, /hiddenMailIds/, 'shared-mail removal must persist the hidden-mail id');
assert.match(source, /fetchWorkerJson[\s\S]*\/api\/mail\/\$\{mailId\}/, 'shared-mail removal validates that the id belongs to the shared mailbox');
assert.doesNotMatch(source, /fetchWorker(?:Text|Json)[\s\S]{0,180}method:\s*["']DELETE["']/, 'shared-mail removal must not delete upstream mail');
assert.doesNotMatch(source, /\/api\/mails\/\$\{mailId\}/, 'shared-mail removal must not contain the upstream deletion endpoint');

console.log(JSON.stringify({
  ok: true,
  checked: [
    'share removal updates encrypted share state',
    'share removal records hidden mail ids',
    'share removal validates ownership without deleting upstream mail',
  ],
}, null, 2));
