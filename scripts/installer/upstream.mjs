import { readFileSync } from 'node:fs';
import { msg } from './i18n.mjs';

function loadUpstreamLock() {
  const path = new URL('../../deployment/upstream-lock.json', import.meta.url);
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(msg(
      `无法读取上游锁定文件 deployment/upstream-lock.json：${error instanceof Error ? error.message : error}`,
      `Could not read the upstream lock file deployment/upstream-lock.json: ${error instanceof Error ? error.message : error}`,
    ));
  }

  for (const key of ['repository', 'release', 'commit', 'workerPnpm', 'workerWrangler']) {
    if (!value?.[key] || typeof value[key] !== 'string') {
      throw new Error(msg(`上游锁定文件缺少有效字段：${key}`, `The upstream lock file is missing a valid field: ${key}`));
    }
  }
  if (!/^[0-9a-f]{40}$/i.test(value.commit)) {
    throw new Error(msg('上游锁定文件中的 commit 必须是完整的 40 位 Git 提交。', 'The commit in the upstream lock file must be a full 40-character Git commit.'));
  }
  if (!/^\d+\.\d+\.\d+$/.test(value.workerPnpm)) {
    throw new Error(msg('上游锁定文件中的 workerPnpm 必须是固定版本号。', 'workerPnpm in the upstream lock file must be a pinned version.'));
  }
  if (!/^\d+\.\d+\.\d+$/.test(value.workerWrangler)) {
    throw new Error(msg('上游锁定文件中的 workerWrangler 必须是固定版本号。', 'workerWrangler in the upstream lock file must be a pinned version.'));
  }

  const repositoryUrl = value.repository.startsWith('https://')
    ? value.repository
    : `https://github.com/${value.repository.replace(/^\/+|\/+$/g, '')}.git`;
  const parsedRepository = new URL(repositoryUrl);
  if (parsedRepository.protocol !== 'https:' || parsedRepository.hostname !== 'github.com') {
    throw new Error(msg('上游锁定文件只允许使用 GitHub HTTPS 仓库。', 'The upstream lock file only permits GitHub HTTPS repositories.'));
  }

  return Object.freeze({ ...value, repositoryUrl });
}

export const UPSTREAM_LOCK = loadUpstreamLock();
