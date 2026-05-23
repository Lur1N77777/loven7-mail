import { useEffect, useMemo, useState } from 'react';
import { Eye, Loader2, Send, Sparkles } from 'lucide-react';
import type { Requester } from '../lib/api';
import { buildMailHtmlDocument } from '../lib/mailParser';
import { safeJsonParse } from '../lib/format';
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
  const [mode, setMode] = useState<'standard' | 'binding'>('standard');
  const [model, setModel] = useState<ComposePayload>(emptyModel);
  const [binding, setBinding] = useState<BindingDraft>(emptyBinding);
  const [sending, setSending] = useState(false);
  const [preview, setPreview] = useState(false);

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
    if (!model.from_mail.trim() || !model.to_mail.trim() || !model.subject.trim() || !model.content.trim()) { notify('error', '请填写发件地址、收件地址、主题和正文'); return; }
    if (!isEmail(model.from_mail)) { notify('error', '发件地址格式不正确'); return; }
    if (!isEmail(model.to_mail)) { notify('error', '收件地址格式不正确'); return; }
    await request('/admin/send_mail', { method: 'POST', body: model });
    notify('success', '邮件已发送');
    setModel(emptyModel);
    clearSeed();
  };

  const sendBinding = async () => {
    if (!binding.from.trim() || !binding.to.trim() || !binding.subject.trim() || (!binding.html.trim() && !binding.text.trim())) { notify('error', '请填写 from、to、subject，并至少填写 HTML 或纯文本正文'); return; }
    if (!isEmail(binding.from)) { notify('error', 'From 邮箱格式不正确'); return; }
    if (!isEmailList(binding.to)) { notify('error', 'To 字段必须是有效邮箱（多个用逗号分隔）'); return; }
    if (binding.cc.trim() && !isEmailList(binding.cc)) { notify('error', 'Cc 字段含无效邮箱'); return; }
    if (binding.bcc.trim() && !isEmailList(binding.bcc)) { notify('error', 'Bcc 字段含无效邮箱'); return; }
    if (binding.replyTo.trim() && !isEmail(binding.replyTo)) { notify('error', 'Reply-To 格式不正确'); return; }
    const headers = safeJsonParse<Record<string, string> | null>(binding.headersJson, null);
    if (headers === null || typeof headers !== 'object' || Array.isArray(headers)) { notify('error', 'Headers 必须是 JSON 对象'); return; }
    await request('/admin/send_mail_by_binding', { method: 'POST', body: bindingPayload });
    notify('success', 'Binding 邮件已发送');
    setBinding(emptyBinding);
  };

  const send = async () => {
    setSending(true);
    try {
      if (mode === 'standard') await sendStandard();
      else await sendBinding();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  return <div className="h-full overflow-y-auto p-3 md:p-5"><div className="mx-auto max-w-5xl panel p-4 md:p-6"><div className="mb-4 flex flex-col justify-between gap-4 md:flex-row md:items-center"><div><h2 className="text-2xl font-bold text-slate-800">写邮件</h2><p className="mt-1 text-sm text-slate-400">覆盖官方 <code>/admin/send_mail</code> 与 <code>/admin/send_mail_by_binding</code> 两条发信链路。</p></div><div className="flex gap-2"><button className="btn-secondary" onClick={() => setPreview(!preview)}><Eye size={16} /> {preview ? '编辑' : '预览'}</button></div></div><div className="mb-4 grid rounded-2xl bg-slate-50 p-1 sm:grid-cols-2"><button className={mode === 'standard' ? 'rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm' : 'rounded-xl px-4 py-2 text-sm font-medium text-slate-500'} onClick={() => setMode('standard')}>标准管理员发送</button><button className={mode === 'binding' ? 'rounded-xl bg-white px-4 py-2 text-sm font-semibold text-slate-700 shadow-sm' : 'rounded-xl px-4 py-2 text-sm font-medium text-slate-500'} onClick={() => setMode('binding')}><Sparkles className="mr-1 inline h-4 w-4" />SEND_MAIL Binding</button></div>{mode === 'standard' ? <StandardComposer model={model} setModel={setModel} preview={preview} /> : <BindingComposer binding={binding} setBinding={setBinding} preview={preview} payload={bindingPayload} />}<div className="mt-5 flex justify-end gap-3"><button className="btn-secondary" onClick={() => mode === 'standard' ? setModel(emptyModel) : setBinding(emptyBinding)}>清空</button><button className="btn-primary" disabled={sending} onClick={send}>{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send size={16} />} 发送</button></div></div></div>;
}

function StandardComposer({ model, setModel, preview }: { model: ComposePayload; setModel: (model: ComposePayload) => void; preview: boolean }) {
  return <><div className="grid gap-3 md:grid-cols-2"><div><label className="form-label">发件人名称</label><input className="form-input" value={model.from_name} onChange={(e) => setModel({ ...model, from_name: e.target.value })} /></div><div><label className="form-label">发件地址</label><input className="form-input" value={model.from_mail} onChange={(e) => setModel({ ...model, from_mail: e.target.value })} placeholder="address@example.com" /></div><div><label className="form-label">收件人名称</label><input className="form-input" value={model.to_name} onChange={(e) => setModel({ ...model, to_name: e.target.value })} /></div><div><label className="form-label">收件地址</label><input className="form-input" value={model.to_mail} onChange={(e) => setModel({ ...model, to_mail: e.target.value })} placeholder="target@example.com" /></div></div><div className="mt-3"><label className="form-label">主题</label><input className="form-input" value={model.subject} onChange={(e) => setModel({ ...model, subject: e.target.value })} /></div><div className="mt-3 flex items-center gap-3"><label className="check-row"><input type="checkbox" checked={model.is_html} onChange={(e) => setModel({ ...model, is_html: e.target.checked })} />HTML 正文</label></div><div className="mt-3"><label className="form-label">正文</label>{preview && model.is_html ? <iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" className="mail-frame" srcDoc={buildMailHtmlDocument(model.content)} /> : <textarea className="form-textarea min-h-72" value={model.content} onChange={(e) => setModel({ ...model, content: e.target.value })} />}</div></>;
}

function BindingComposer({ binding, setBinding, preview, payload }: { binding: BindingDraft; setBinding: (model: BindingDraft) => void; preview: boolean; payload: BindingSendPayload }) {
  return <div className="space-y-3"><div className="rounded-2xl bg-slate-50 p-3 text-sm leading-6 text-slate-600">Binding 发送会调用 Worker 的 <code>SEND_MAIL.send</code>，发件域名必须已在 Worker 中启用绑定发送。</div><div className="grid gap-3 md:grid-cols-2"><div><label className="form-label">From</label><input className="form-input" value={binding.from} onChange={(e) => setBinding({ ...binding, from: e.target.value })} placeholder="sender@example.com" /></div><div><label className="form-label">To（多个用逗号分隔）</label><input className="form-input" value={binding.to} onChange={(e) => setBinding({ ...binding, to: e.target.value })} placeholder="a@example.com,b@example.com" /></div><div><label className="form-label">Cc</label><input className="form-input" value={binding.cc} onChange={(e) => setBinding({ ...binding, cc: e.target.value })} /></div><div><label className="form-label">Bcc</label><input className="form-input" value={binding.bcc} onChange={(e) => setBinding({ ...binding, bcc: e.target.value })} /></div><div><label className="form-label">Reply-To</label><input className="form-input" value={binding.replyTo} onChange={(e) => setBinding({ ...binding, replyTo: e.target.value })} /></div><div><label className="form-label">Subject</label><input className="form-input" value={binding.subject} onChange={(e) => setBinding({ ...binding, subject: e.target.value })} /></div></div><div className="grid gap-3 xl:grid-cols-2"><div><label className="form-label">HTML 正文</label>{preview && binding.html ? <iframe sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox" referrerPolicy="no-referrer" className="mail-frame" srcDoc={buildMailHtmlDocument(binding.html)} /> : <textarea className="form-textarea min-h-52" value={binding.html} onChange={(e) => setBinding({ ...binding, html: e.target.value })} />}</div><div><label className="form-label">纯文本正文</label><textarea className="form-textarea min-h-52" value={binding.text} onChange={(e) => setBinding({ ...binding, text: e.target.value })} /></div></div><div><label className="form-label">Headers JSON</label><textarea className="code-area h-28" value={binding.headersJson} onChange={(e) => setBinding({ ...binding, headersJson: e.target.value })} /></div><details className="rounded-2xl border border-slate-100 bg-slate-50 p-3"><summary className="cursor-pointer text-sm font-semibold text-slate-600">即将提交的 payload</summary><pre className="mt-3 max-h-64 overflow-auto text-xs text-slate-500">{JSON.stringify(payload, null, 2)}</pre></details></div>;
}


