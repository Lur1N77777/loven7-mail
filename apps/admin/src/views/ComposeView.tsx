import { useEffect, useMemo, useRef, useState } from 'react';
import { Eye, Loader2, Send } from 'lucide-react';
import type { Requester } from '../lib/api';
import { buildMailHtmlDocument } from '../lib/mailParser';
import { safeJsonParse } from '../lib/format';
import { getRuntimeLocale, localeText } from '../lib/locale';
import { createOutboundIdempotencyTracker } from '../lib/outboundIdempotency';
import type { BindingSendPayload, ComposePayload } from '../types/api';
import type { Notify } from '../components/Common';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isEmail(value: string): boolean { return EMAIL_PATTERN.test(value.trim()); }
function isEmailList(value: string): boolean {
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  return items.length > 0 && items.every(isEmail);
}

type BindingDraft = {
  from: string;
  to: string;
  cc: string;
  bcc: string;
  replyTo: string;
  subject: string;
  html: string;
  text: string;
  headersJson: string;
};

const emptyModel: ComposePayload = { from_name: '', from_mail: '', to_name: '', to_mail: '', subject: '', is_html: false, content: '' };
const emptyBinding: BindingDraft = { from: '', to: '', cc: '', bcc: '', replyTo: '', subject: '', html: '', text: '', headersJson: '{}' };
const splitList = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);

export function ComposeView({ request, notify, seed, clearSeed }: { request: Requester; notify: Notify; seed: Partial<ComposePayload>; clearSeed: () => void }) {
  const locale = getRuntimeLocale();
  const t = (zh: string, en: string) => localeText(zh, en, locale);
  const [mode, setMode] = useState<'standard' | 'binding'>('standard');
  const [model, setModel] = useState<ComposePayload>(emptyModel);
  const [binding, setBinding] = useState<BindingDraft>(emptyBinding);
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState(false);
  const outboundRequests = useRef(createOutboundIdempotencyTracker()).current;

  useEffect(() => {
    if (Object.keys(seed).length) {
      setModel((current) => ({ ...current, ...seed }));
      setBinding((current) => ({ ...current, from: seed.from_mail || current.from, to: seed.to_mail || current.to, subject: seed.subject || current.subject, text: seed.is_html ? current.text : seed.content || current.text, html: seed.is_html ? seed.content || current.html : current.html }));
    }
  }, [seed]);

  const bindingPayload = useMemo<BindingSendPayload>(() => {
    const cc = splitList(binding.cc);
    const bcc = splitList(binding.bcc);
    const headers = safeJsonParse<Record<string, string>>(binding.headersJson, {});
    return {
      from: binding.from.trim(),
      to: splitList(binding.to),
      subject: binding.subject.trim(),
      ...(binding.html.trim() ? { html: binding.html } : {}),
      ...(binding.text.trim() ? { text: binding.text } : {}),
      ...(cc.length ? { cc } : {}),
      ...(bcc.length ? { bcc } : {}),
      ...(binding.replyTo.trim() ? { replyTo: binding.replyTo.trim() } : {}),
      ...(Object.keys(headers).length ? { headers } : {}),
    };
  }, [binding]);

  const sendStandard = async () => {
    if (!model.from_mail.trim() || !model.to_mail.trim() || !model.subject.trim() || !model.content.trim()) { notify('error', t('请填写发件地址、收件地址、主题和正文', 'Fill sender, recipient, subject, and body')); return; }
    if (!isEmail(model.from_mail)) { notify('error', t('发件地址格式不正确', 'Sender address is invalid')); return; }
    if (!isEmail(model.to_mail)) { notify('error', t('收件地址格式不正确', 'Recipient address is invalid')); return; }
    const attempt = outboundRequests.begin('/admin/send_mail', model);
    try {
      await request('/admin/send_mail', {
        method: 'POST',
        body: model,
        headers: { 'Idempotency-Key': attempt.key },
      });
    } catch (error) {
      outboundRequests.failed(attempt, error);
      throw error;
    }
    outboundRequests.succeeded(attempt);
    notify('success', t('邮件已发送', 'Mail sent'));
    setModel(emptyModel);
    clearSeed();
  };

  const sendBinding = async () => {
    if (!binding.from.trim() || !binding.to.trim() || !binding.subject.trim() || (!binding.html.trim() && !binding.text.trim())) { notify('error', t('请填写 from、to、subject，并至少填写 HTML 或纯文本正文', 'Fill from, to, subject, and at least HTML or text body')); return; }
    if (!isEmail(binding.from)) { notify('error', t('From 邮箱格式不正确', 'From address is invalid')); return; }
    if (!isEmailList(binding.to)) { notify('error', t('To 字段必须是有效邮箱（多个用逗号分隔）', 'To must contain valid email addresses separated by commas')); return; }
    if (binding.cc.trim() && !isEmailList(binding.cc)) { notify('error', t('Cc 字段含无效邮箱', 'Cc contains invalid email addresses')); return; }
    if (binding.bcc.trim() && !isEmailList(binding.bcc)) { notify('error', t('Bcc 字段含无效邮箱', 'Bcc contains invalid email addresses')); return; }
    if (binding.replyTo.trim() && !isEmail(binding.replyTo)) { notify('error', t('Reply-To 格式不正确', 'Reply-To is invalid')); return; }
    const headers = safeJsonParse<Record<string, string> | null>(binding.headersJson, null);
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) { notify('error', t('Headers 必须是 JSON 对象', 'Headers must be a JSON object')); return; }
    const attempt = outboundRequests.begin('/admin/send_mail_by_binding', bindingPayload);
    try {
      await request('/admin/send_mail_by_binding', {
        method: 'POST',
        body: bindingPayload,
        headers: { 'Idempotency-Key': attempt.key },
      });
    } catch (error) {
      outboundRequests.failed(attempt, error);
      throw error;
    }
    outboundRequests.succeeded(attempt);
    notify('success', t('Binding 邮件已发送', 'Binding mail sent'));
    setBinding(emptyBinding);
  };

  const send = async () => {
    setSending(true);
    try {
      if (mode === 'standard') await sendStandard();
      else await sendBinding();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('发送失败', 'Send failed'));
    } finally {
      setSending(false);
    }
  };

  const clearDraft = () => {
    outboundRequests.clear();
    if (mode === 'standard') setModel(emptyModel);
    else setBinding(emptyBinding);
  };

  return (
    <div className="compose-view-shell compose-workspace h-full overflow-y-auto">
      <div className="compose-canvas">
        <header className="page-head compose-head">
          <div className="page-head-copy">
            <span className="product-kicker">{t('邮件工作台', 'Mail desk')}</span>
            <h1 className="page-title">{t('写邮件', 'Compose')}</h1>
          </div>
          <div className="page-head-actions">
            <div className="compose-mode-switch" role="tablist" aria-label={t('发送方式', 'Send mode')}>
              <button type="button" role="tab" aria-selected={mode === 'standard'} className={mode === 'standard' ? 'compose-mode-option is-active' : 'compose-mode-option'} onClick={() => setMode('standard')}>{t('标准发送', 'Standard')}</button>
              <button type="button" role="tab" aria-selected={mode === 'binding'} className={mode === 'binding' ? 'compose-mode-option is-active' : 'compose-mode-option'} onClick={() => setMode('binding')}>Binding</button>
            </div>
            <button type="button" className="product-button product-button-quiet" onClick={() => setPreview(!preview)}><Eye size={16} /> {preview ? t('编辑', 'Edit') : t('预览', 'Preview')}</button>
          </div>
        </header>
        <div className="compose-sheet">
          <div className="compose-sheet-body">
            {mode === 'standard' ? <StandardComposer model={model} setModel={setModel} preview={preview} /> : <BindingComposer binding={binding} setBinding={setBinding} preview={preview} payload={bindingPayload} />}
          </div>
          <footer className="compose-sheet-foot">
            <span className="compose-foot-hint">{mode === 'standard' ? t('以站内地址向单个收件人发送', 'Send from a site address to one recipient') : t('通过 Resend Binding 通道发送', 'Send through the Resend binding channel')}</span>
            <div className="compose-foot-actions">
              <button type="button" className="btn-secondary" onClick={clearDraft}>{t('清空', 'Clear')}</button>
              <button type="button" className="btn-primary compose-send-btn" disabled={sending} onClick={send}>{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send size={16} />} {t('发送', 'Send')}</button>
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}

function StandardComposer({ model, setModel, preview }: { model: ComposePayload; setModel: (model: ComposePayload) => void; preview: boolean }) {
  const t = (zh: string, en: string) => localeText(zh, en);
  return <><div className="grid gap-3 md:grid-cols-2"><div><label className="form-label">{t('发件人名称', 'Sender name')}</label><input className="form-input" value={model.from_name} onChange={(e) => setModel({ ...model, from_name: e.target.value })} /></div><div><label className="form-label">{t('发件地址', 'Sender address')}</label><input className="form-input" value={model.from_mail} onChange={(e) => setModel({ ...model, from_mail: e.target.value })} placeholder="address@example.com" /></div><div><label className="form-label">{t('收件人名称', 'Recipient name')}</label><input className="form-input" value={model.to_name} onChange={(e) => setModel({ ...model, to_name: e.target.value })} /></div><div><label className="form-label">{t('收件地址', 'Recipient address')}</label><input className="form-input" value={model.to_mail} onChange={(e) => setModel({ ...model, to_mail: e.target.value })} placeholder="target@example.com" /></div></div><div className="mt-3"><label className="form-label">{t('主题', 'Subject')}</label><input className="form-input" value={model.subject} onChange={(e) => setModel({ ...model, subject: e.target.value })} /></div><div className="mt-3 flex items-center gap-3"><label className="check-row"><input type="checkbox" checked={model.is_html} onChange={(e) => setModel({ ...model, is_html: e.target.checked })} />{t('HTML 正文', 'HTML body')}</label></div><div className="mt-3"><label className="form-label">{t('正文', 'Body')}</label>{preview && model.is_html ? <iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" className="mail-frame" srcDoc={buildMailHtmlDocument(model.content)} /> : <textarea className="form-textarea min-h-72" value={model.content} onChange={(e) => setModel({ ...model, content: e.target.value })} />}</div></>;
}

function BindingComposer({ binding, setBinding, preview, payload }: { binding: BindingDraft; setBinding: (model: BindingDraft) => void; preview: boolean; payload: BindingSendPayload }) {
  const t = (zh: string, en: string) => localeText(zh, en);
  return <div className="space-y-3"><div className="grid gap-3 md:grid-cols-2"><div><label className="form-label">From</label><input className="form-input" value={binding.from} onChange={(e) => setBinding({ ...binding, from: e.target.value })} placeholder="sender@example.com" /></div><div><label className="form-label">{t('To（多个用逗号分隔）', 'To (comma separated)')}</label><input className="form-input" value={binding.to} onChange={(e) => setBinding({ ...binding, to: e.target.value })} placeholder="a@example.com,b@example.com" /></div><div><label className="form-label">Cc</label><input className="form-input" value={binding.cc} onChange={(e) => setBinding({ ...binding, cc: e.target.value })} /></div><div><label className="form-label">Bcc</label><input className="form-input" value={binding.bcc} onChange={(e) => setBinding({ ...binding, bcc: e.target.value })} /></div><div><label className="form-label">Reply-To</label><input className="form-input" value={binding.replyTo} onChange={(e) => setBinding({ ...binding, replyTo: e.target.value })} /></div><div><label className="form-label">Subject</label><input className="form-input" value={binding.subject} onChange={(e) => setBinding({ ...binding, subject: e.target.value })} /></div></div><div className="grid gap-3 xl:grid-cols-2"><div><label className="form-label">{t('HTML 正文', 'HTML body')}</label>{preview && binding.html ? <iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" className="mail-frame" srcDoc={buildMailHtmlDocument(binding.html)} /> : <textarea className="form-textarea min-h-52" value={binding.html} onChange={(e) => setBinding({ ...binding, html: e.target.value })} />}</div><div><label className="form-label">{t('纯文本正文', 'Plain text body')}</label><textarea className="form-textarea min-h-52" value={binding.text} onChange={(e) => setBinding({ ...binding, text: e.target.value })} /></div></div><div><label className="form-label">Headers JSON</label><textarea className="code-area h-28" value={binding.headersJson} onChange={(e) => setBinding({ ...binding, headersJson: e.target.value })} /></div><details className="compose-data-preview"><summary>{t('数据预览', 'Data preview')}</summary><pre>{JSON.stringify(payload, null, 2)}</pre></details></div>;
}

