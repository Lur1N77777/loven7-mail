import { createInterface } from 'node:readline/promises';
import { msg } from './i18n.mjs';

export class ConsoleUi {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.input = input;
    this.output = output;
    this.readline = createInterface({ input, output });
  }

  close() {
    this.readline.close();
  }

  info(message) { this.output.write(`  ${message}\n`); }
  success(message) { this.output.write(`  ${msg('完成', 'Done')}: ${message}\n`); }
  step(message) { this.output.write(`\n[${message}]\n`); }

  async text(label, defaultValue = '') {
    const suffix = defaultValue ? ` (${defaultValue})` : '';
    const answer = (await this.readline.question(`${label}${suffix}: `)).trim();
    return answer || defaultValue;
  }

  async confirm(label, defaultValue = true) {
    const hint = defaultValue ? 'Y/n' : 'y/N';
    const answer = (await this.readline.question(`${label} [${hint}]: `)).trim().toLowerCase();
    if (!answer) return defaultValue;
    return answer === 'y' || answer === 'yes' || answer === '是';
  }

  async select(label, items, describe = String) {
    this.output.write(`${label}:\n`);
    items.forEach((item, index) => this.output.write(`  ${index + 1}. ${describe(item)}\n`));
    while (true) {
      const answer = Number(await this.readline.question(msg('请输入序号: ', 'Enter a number: ')));
      if (Number.isInteger(answer) && answer >= 1 && answer <= items.length) return items[answer - 1];
      this.output.write(msg('请输入列表中的有效序号。\n', 'Enter a valid number from the list.\n'));
    }
  }

  async language(defaultLanguage = 'zh-CN') {
    this.output.write('\n请选择安装器语言 / Select installer language:\n');
    this.output.write('  1. 中文\n');
    this.output.write('  2. English\n');
    while (true) {
      const answer = (await this.readline.question(`选择 / Select [${defaultLanguage === 'en' ? '2' : '1'}]: `)).trim().toLowerCase();
      if (!answer) return defaultLanguage;
      if (['1', 'zh', 'zh-cn', '中文'].includes(answer)) return 'zh-CN';
      if (['2', 'en', 'english'].includes(answer)) return 'en';
      this.output.write('请输入 1 或 2。 / Enter 1 or 2.\n');
    }
  }

  async mode() {
    return (await this.confirm(msg(
      '是否从零部署完整邮箱系统？已有兼容邮件 Worker 的高级用户请选择“否”。',
      'Deploy a complete mail system from scratch? Advanced users with a compatible existing mail Worker should choose No.',
    ), true)) ? 'new-worker' : 'existing-worker';
  }

  async secret(label, { optional = false } = {}) {
    if (!this.input.isTTY || typeof this.input.setRawMode !== 'function') {
      throw new Error(msg(
        `${label} 需要在交互式终端中安全输入。`,
        `${label} requires secure input from an interactive terminal.`,
      ));
    }
    this.readline.pause();
    this.output.write(`${label}${optional ? msg('（可留空）', ' (optional)') : ''}: `);
    this.input.setRawMode(true);
    this.input.resume();
    this.input.setEncoding('utf8');
    return new Promise((resolve, reject) => {
      let value = '';
      const finish = (error) => {
        this.input.off('data', onData);
        this.input.setRawMode(false);
        this.input.pause();
        this.output.write('\n');
        this.readline.resume();
        if (error) reject(error); else resolve(value);
      };
      const onData = (chunk) => {
        for (const char of chunk) {
          if (char === '\u0003') return finish(new Error(msg('安装已取消。', 'Installation cancelled.')));
          if (char === '\r' || char === '\n') return finish();
          if (char === '\u007f' || char === '\b') {
            if (value) {
              value = value.slice(0, -1);
              this.output.write('\b \b');
            }
          } else if (char >= ' ') {
            value += char;
            this.output.write('*');
          }
        }
      };
      this.input.on('data', onData);
    });
  }
}
