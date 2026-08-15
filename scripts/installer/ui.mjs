import { createInterface } from 'node:readline/promises';

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
  success(message) { this.output.write(`  完成：${message}\n`); }
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
      const answer = Number(await this.readline.question('请输入序号: '));
      if (Number.isInteger(answer) && answer >= 1 && answer <= items.length) return items[answer - 1];
      this.output.write('请输入列表中的有效序号。\n');
    }
  }

  async mode() {
    return (await this.confirm('是否已经有兼容的邮件 Worker？选择“否”将自动部署锁定的兼容 Worker v1.10.0。', true)) ? 'existing-worker' : 'new-worker';
  }

  async secret(label, { optional = false } = {}) {
    if (!this.input.isTTY || typeof this.input.setRawMode !== 'function') {
      throw new Error(`${label} 需要在交互式终端中安全输入。`);
    }
    this.readline.pause();
    this.output.write(`${label}${optional ? '（可留空）' : ''}: `);
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
          if (char === '\u0003') return finish(new Error('安装已取消。'));
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
