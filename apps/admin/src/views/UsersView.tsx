import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, Fragment } from 'react';
import { ChevronUp, Filter, Link2, Lock, Plus, RefreshCw, Save, Shield, Trash2, UserRoundCog } from 'lucide-react';
import { buildQuery, type Requester } from '../lib/api';
import { CACHE_TTL, DEFAULT_PAGE_SIZE, STORAGE_KEYS } from '../lib/constants';
import { cls, formatDateTime } from '../lib/format';
import { sha256Hex } from '../lib/crypto';
import { getRuntimeLocale, localeText } from '../lib/locale';
import { readJsonStorage, writeJsonStorage } from '../lib/storage';
import type { AddressUserFilter, BoundAddressRecord, ListResponse, RoleRecord, UserRecord } from '../types/api';
import { EmptyState, LoadingState, Modal, Pagination, type Notify, useConfirm } from '../components/Common';

type CachedUserList = { version: number; count: number; savedAt: number; users: UserRecord[]; roles: RoleRecord[] };
const USER_LIST_CACHE_VERSION = 1;

export function UsersView({ request, notify, ask, globalQuery, onFilterUserAddresses }: { request: Requester; notify: Notify; ask: ReturnType<typeof useConfirm>['ask']; globalQuery: string; onFilterUserAddresses?: (filter: AddressUserFilter) => void }) {
  const locale = getRuntimeLocale();
  const t = (zh: string, en: string) => localeText(zh, en, locale);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newUser, setNewUser] = useState({ email: '', password: '' });
  const [roleTarget, setRoleTarget] = useState<UserRecord | null>(null);
  const [resetTarget, setResetTarget] = useState<UserRecord | null>(null);
  const [expandedUser, setExpandedUser] = useState<UserRecord | null>(null);
  const [closingUserId, setClosingUserId] = useState<number | null>(null);
  const [password, setPassword] = useState('');
  const deferredQuery = useDeferredValue(query || globalQuery);
  const requestSeqRef = useRef(0);
  const closeTimerRef = useRef<number | null>(null);
  const listCacheKey = useMemo(() => `${STORAGE_KEYS.userListCachePrefix}${page}:${pageSize}:${encodeURIComponent(deferredQuery)}`, [deferredQuery, page, pageSize]);

  const fetchData = useCallback(async (forceRefresh = false) => {
    const seq = ++requestSeqRef.current;
    setLoading(true);
    try {
      const [userRes, roleRes] = await Promise.all([
        request<ListResponse<UserRecord>>(`/admin/users${buildQuery({ limit: pageSize, offset: (page - 1) * pageSize, query: deferredQuery })}`, { forceRefresh, cacheTtlMs: CACHE_TTL.shortList }),
        request<RoleRecord[]>('/admin/user_roles', { forceRefresh, cacheTtlMs: CACHE_TTL.role }).catch(() => []),
      ]);
      if (seq !== requestSeqRef.current) return;
      const results = userRes.results || [];
      const nextRoles = Array.isArray(roleRes) ? roleRes : [];
      const nextCount = typeof userRes.count === 'number' ? userRes.count : results.length;
      setUsers(results);
      setCount(nextCount);
      setRoles(nextRoles);
      writeJsonStorage(listCacheKey, { version: USER_LIST_CACHE_VERSION, count: nextCount, savedAt: Date.now(), users: results, roles: nextRoles });
    } catch (error) {
      if (seq === requestSeqRef.current) notify('error', error instanceof Error ? error.message : t('用户列表加载失败', 'Failed to load users'));
    } finally {
      if (seq === requestSeqRef.current) setLoading(false);
    }
  }, [deferredQuery, listCacheKey, notify, page, pageSize, request, t]);

  useEffect(() => {
    const cached = readJsonStorage<CachedUserList | null>(listCacheKey, null);
    if (!cached || cached.version !== USER_LIST_CACHE_VERSION || !Array.isArray(cached.users)) return;
    setUsers(cached.users);
    setCount(cached.count || cached.users.length);
    setRoles(Array.isArray(cached.roles) ? cached.roles : []);
  }, [listCacheKey]);
  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => {
    const onGlobalRefresh = (event: Event) => {
      const targetMenu = (event as CustomEvent<{ menu?: string }>).detail?.menu;
      if (!targetMenu || targetMenu === 'users') fetchData(true);
    };
    window.addEventListener('loven7-global-refresh', onGlobalRefresh);
    return () => window.removeEventListener('loven7-global-refresh', onGlobalRefresh);
  }, [fetchData]);

  const totalPages = Math.max(1, Math.ceil(count / pageSize));
  const createUser = async () => {
    const email = newUser.email.trim();
    const password = newUser.password.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { notify('error', t('请填写有效的用户邮箱', 'Enter a valid user email')); return; }
    if (password.length < 6) { notify('error', t('请填写至少 6 位密码', 'Enter at least 6 password characters')); return; }
    try {
      await request('/admin/users', { method: 'POST', body: { email, password: await sha256Hex(password) } });
      notify('success', t('用户已创建', 'User created'));
      setCreateOpen(false);
      setNewUser({ email: '', password: '' });
      await fetchData();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('创建用户失败', 'Failed to create user'));
    }
  };
  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  const closeExpandedUser = useCallback(() => {
    const target = expandedUser;
    if (!target) return;
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    setClosingUserId(target.id);
    closeTimerRef.current = window.setTimeout(() => {
      setExpandedUser((current) => (current?.id === target.id ? null : current));
      setClosingUserId((current) => (current === target.id ? null : current));
      closeTimerRef.current = null;
    }, 220);
  }, [expandedUser]);

  const deleteUser = (user: UserRecord) => ask({ title: t(`删除用户 ${user.user_email}`, `Delete user ${user.user_email}`), body: t('将删除用户和地址绑定关系。', 'This deletes the user and address bindings.'), actionLabel: t('删除', 'Delete'), onConfirm: async () => { await request(`/admin/users/${user.id}`, { method: 'DELETE' }); notify('success', t('用户已删除', 'User deleted')); setExpandedUser((current) => (current?.id === user.id ? null : current)); setClosingUserId((current) => (current === user.id ? null : current)); await fetchData(); } });
  const toggleUser = (user: UserRecord) => {
    if (expandedUser?.id === user.id) {
      closeExpandedUser();
      return;
    }
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
    setClosingUserId(null);
    setExpandedUser(user);
  };
  const jumpToAddressManagement = (user: UserRecord) => {
    setExpandedUser(null);
    setClosingUserId(null);
    onFilterUserAddresses?.({ userId: user.id, userEmail: user.user_email, requestId: Date.now() });
  };

  const renderMobileUser = (user: UserRecord) => {
    const expanded = expandedUser?.id === user.id;
    return <div key={user.id} className="user-inline-wrapper">
      <article className={cls('user-mobile-card', expanded && 'expanded')} onClick={() => toggleUser(user)}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-800">{user.user_email}</p>
            <p className="mt-1 text-[11px] text-slate-400">#{user.id} · {user.role_text || t('默认', 'Default')}</p>
          </div>
          <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-500">{locale === 'en-US' ? `${user.address_count ?? 0} addresses` : `${user.address_count ?? 0} 个地址`}</span>
        </div>
        <div className="mt-2 text-[11px] text-slate-400">{formatDateTime(user.updated_at || user.created_at)}</div>
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          <button className="btn-secondary compact" onClick={(event) => { event.stopPropagation(); toggleUser(user); }}><Link2 size={14} /> {t('地址', 'Addresses')}</button>
          <button className="btn-secondary compact" onClick={(event) => { event.stopPropagation(); jumpToAddressManagement(user); }}><Filter size={14} /> {t('筛选', 'Filter')}</button>
          <button className="btn-secondary compact" onClick={(event) => { event.stopPropagation(); setRoleTarget(user); }}><Shield size={14} /> {t('角色', 'Role')}</button>
          <button className="btn-secondary compact" onClick={(event) => { event.stopPropagation(); setResetTarget(user); setPassword(''); }}><Lock size={14} /> {t('密码', 'Password')}</button>
          <button className="btn-danger compact col-span-2" onClick={(event) => { event.stopPropagation(); deleteUser(user); }}><Trash2 size={14} /> {t('删除', 'Delete')}</button>
        </div>
      </article>
      {expanded && <div className={cls('user-inline-mobile-motion', closingUserId === user.id && 'is-closing')}><UserAddressInline user={user} request={request} notify={notify} onManage={() => jumpToAddressManagement(user)} onClose={closeExpandedUser} /></div>}
    </div>;
  };

  return <div className="h-full space-y-4 overflow-y-auto p-3 md:p-4 xl:p-6">
    <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center"><div><h2 className="text-2xl font-bold text-slate-800">{t('用户管理', 'User management')}</h2><p className="mt-1 text-sm text-slate-400">{t('点击用户可直接展开其地址，也可跳转到地址管理批量筛选。', 'Click a user to expand their addresses, or jump to address management with that user filtered.')}</p></div><button className="btn-primary" onClick={() => setCreateOpen(true)}><Plus size={16} /> {t('新建用户', 'New user')}</button></div>
    <div className="panel overflow-hidden"><div className="flex flex-col gap-3 border-b border-slate-100 p-3 md:flex-row"><input className="form-input compact-control" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder={t('搜索用户邮箱', 'Search user email')} /><button className="btn-secondary compact" onClick={() => fetchData(true)}><RefreshCw size={15} className={cls(loading && users.length > 0 && 'animate-spin')} /> {t('刷新', 'Refresh')}</button></div>{loading && users.length === 0 ? <LoadingState /> : users.length === 0 ? <div className="p-4 md:p-6"><EmptyState icon={UserRoundCog} title={t('暂无用户', 'No users')} /></div> : <>
      <div className="space-y-2 p-3 md:hidden">{users.map(renderMobileUser)}</div>
      <div className="hidden overflow-auto md:block"><table className="data-table action-table"><thead><tr><th>ID</th><th>{t('邮箱', 'Email')}</th><th>{t('角色', 'Role')}</th><th>{t('地址数', 'Addresses')}</th><th>{t('更新时间', 'Updated')}</th><th className="text-right">{t('操作', 'Actions')}</th></tr></thead><tbody>{users.map((user) => {
        const expanded = expandedUser?.id === user.id;
        return <Fragment key={user.id}><tr className={cls('cursor-pointer', expanded && 'user-row-expanded')} onClick={() => toggleUser(user)}><td className="font-mono text-xs text-slate-400">#{user.id}</td><td><span className="address-strong">{user.user_email}</span></td><td>{user.role_text || t('默认', 'Default')}</td><td>{user.address_count ?? 0}</td><td>{formatDateTime(user.updated_at || user.created_at)}</td><td><div className="flex justify-end gap-2"><button className="table-action" onClick={(event) => { event.stopPropagation(); toggleUser(user); }} title={t('查看地址', 'View addresses')}>{expanded ? <ChevronUp size={15} /> : <Link2 size={15} />}</button><button className="table-action" onClick={(event) => { event.stopPropagation(); jumpToAddressManagement(user); }} title={t('在地址管理筛选', 'Filter in address management')}><Filter size={15} /></button><button className="table-action" onClick={(event) => { event.stopPropagation(); setRoleTarget(user); }} title={t('角色', 'Role')}><Shield size={15} /></button><button className="table-action" onClick={(event) => { event.stopPropagation(); setResetTarget(user); setPassword(''); }} title={t('重置密码', 'Reset password')}><Lock size={15} /></button><button className="table-action danger" onClick={(event) => { event.stopPropagation(); deleteUser(user); }} title={t('删除', 'Delete')}><Trash2 size={15} /></button></div></td></tr>{expanded && <tr className={cls('user-inline-tr', closingUserId === user.id && 'is-closing')}><td className="user-address-inline-cell" colSpan={6}><UserAddressInline user={user} request={request} notify={notify} onManage={() => jumpToAddressManagement(user)} onClose={closeExpandedUser} /></td></tr>}</Fragment>;
      })}</tbody></table></div>
    </>}<Pagination page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} count={count} /></div>
    {createOpen && <Modal title={t('新建用户', 'New user')} onClose={() => setCreateOpen(false)}><div className="space-y-4"><input className="form-input" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} placeholder={t('用户邮箱', 'User email')} /><input className="form-input" type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} placeholder={t('用户密码', 'User password')} /><button className="btn-primary w-full" onClick={createUser}><Plus size={16} /> {t('创建', 'Create')}</button></div></Modal>}
    {roleTarget && <Modal title={t(`修改角色：${roleTarget.user_email}`, `Change role: ${roleTarget.user_email}`)} onClose={() => setRoleTarget(null)}><div className="space-y-3"><button className="btn-secondary w-full justify-start" onClick={async () => { await request('/admin/user_roles', { method: 'POST', body: { user_id: roleTarget.id, role_text: '' } }); notify('success', t('已恢复默认角色', 'Default role restored')); setRoleTarget(null); await fetchData(); }}>{t('默认角色', 'Default role')}</button>{roles.map((role) => <button key={role.role} className="btn-secondary w-full justify-start" onClick={async () => { await request('/admin/user_roles', { method: 'POST', body: { user_id: roleTarget.id, role_text: role.role } }); notify('success', t('角色已更新', 'Role updated')); setRoleTarget(null); await fetchData(); }}>{role.label || role.role}</button>)}</div></Modal>}
    {resetTarget && <Modal title={t(`重置密码：${resetTarget.user_email}`, `Reset password: ${resetTarget.user_email}`)} onClose={() => setResetTarget(null)}><div className="space-y-4"><input className="form-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('新密码', 'New password')} /><button className="btn-primary w-full" onClick={async () => {
      const trimmed = password.trim();
      if (trimmed.length < 6) { notify('error', t('请填写至少 6 位新密码', 'Enter at least 6 characters for the new password')); return; }
      try { await request(`/admin/users/${resetTarget.id}/reset_password`, { method: 'POST', body: { password: await sha256Hex(trimmed) } }); notify('success', t('密码已重置', 'Password reset')); setResetTarget(null); }
      catch (error) { notify('error', error instanceof Error ? error.message : t('重置失败', 'Reset failed')); }
    }}><Save size={16} /> {t('保存', 'Save')}</button></div></Modal>}
  </div>;
}

function UserAddressInline({ user, request, notify, onManage, onClose }: { user: UserRecord; request: Requester; notify: Notify; onManage: () => void; onClose: () => void }) {
  const locale = getRuntimeLocale();
  const t = (zh: string, en: string) => localeText(zh, en, locale);
  const [data, setData] = useState<BoundAddressRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [address, setAddress] = useState('');

  const fetchData = useCallback(async (forceRefresh = false) => {
    setLoading(true);
    try {
      const res = await request<{ results: BoundAddressRecord[] }>(`/admin/users/bind_address/${user.id}`, { forceRefresh, cacheTtlMs: CACHE_TTL.list });
      setData(res.results || []);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('绑定地址加载失败', 'Failed to load bound addresses'));
    } finally {
      setLoading(false);
    }
  }, [notify, request, t, user.id]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const bind = async () => {
    try {
      await request('/admin/users/bind_address', { method: 'POST', body: { user_id: user.id, user_email: user.user_email, address: address.trim() } });
      notify('success', t('地址已绑定', 'Address bound'));
      setAddress('');
      await fetchData(true);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('绑定失败', 'Bind failed'));
    }
  };

  return <div className="user-address-inline">
    <div className="user-address-inline-head">
      <div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{locale === 'en-US' ? `${user.user_email} addresses` : `${user.user_email} 的地址`}</p><p className="text-xs text-slate-400">{locale === 'en-US' ? `${data.length} total · from user bound-address API.` : `共 ${data.length} 个，数据来自用户绑定地址接口。`}</p></div>
      <div className="flex shrink-0 gap-2"><button className="btn-secondary compact" onClick={onManage}><Filter size={14} /> {t('地址管理筛选', 'Filter in addresses')}</button><button className="btn-secondary compact" onClick={onClose}><ChevronUp size={14} /> {t('收起', 'Collapse')}</button></div>
    </div>
    <div className="mt-3 flex flex-col gap-2 sm:flex-row"><input className="form-input compact-control" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t('绑定完整邮箱地址，例如 test@example.com', 'Bind full mailbox address, e.g. test@example.com')} /><button className="btn-primary compact" onClick={bind}><Link2 size={14} /> {t('绑定', 'Bind')}</button></div>
    {loading ? <LoadingState label={t('正在加载用户地址...', 'Loading user addresses...')} /> : data.length === 0 ? <div className="mt-3"><EmptyState icon={Link2} title={t('暂无绑定地址', 'No bound addresses')} /></div> : <div className="user-address-inline-list">{data.map((row) => <div key={row.id} className="user-address-inline-item"><div className="min-w-0"><p className="truncate font-semibold text-slate-800">{row.name}</p><p className="text-[11px] text-slate-400">#{row.id} · {formatDateTime(row.updated_at || row.created_at)}</p></div><div className="user-address-inline-stats"><span>{t('收', 'In')} {row.mail_count ?? 0}</span><span>{t('发', 'Out')} {row.send_count ?? 0}</span></div></div>)}</div>}
  </div>;
}
