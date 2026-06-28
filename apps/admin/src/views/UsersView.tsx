import { memo, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode, TransitionEvent } from 'react';
import { ChevronUp, Filter, Link2, Loader2, Lock, Plus, RefreshCw, Save, Shield, Trash2, UserRoundCog } from 'lucide-react';
import { buildQuery, type Requester } from '../lib/api';
import { CACHE_TTL, DEFAULT_PAGE_SIZE, STORAGE_KEYS } from '../lib/constants';
import { cls, formatDateTime } from '../lib/format';
import { sha256Hex } from '../lib/crypto';
import { getRuntimeLocale, localeText } from '../lib/locale';
import { readJsonStorage, writeJsonStorage } from '../lib/storage';
import type { AddressUserFilter, BoundAddressRecord, ListResponse, RoleRecord, UserRecord } from '../types/api';
import { EmptyState, LoadingState, Modal, Pagination, type Notify, useConfirm } from '../components/Common';

type CachedUserList = { version: number; count: number; savedAt: number; users: UserRecord[]; roles: RoleRecord[] };
type InlineAddressCacheEntry = { data: BoundAddressRecord[]; loading: boolean; savedAt: number; requestId?: number };
const USER_LIST_CACHE_VERSION = 1;
const USER_INLINE_ANIMATION_MS = 190;
const DESKTOP_USERS_QUERY = '(min-width: 768px)';

function useMediaQuery(query: string) {
  const getMatches = useCallback(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return window.matchMedia(query).matches;
  }, [query]);
  const [matches, setMatches] = useState(getMatches);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(query);
    const onChange = () => setMatches(media.matches);
    onChange();
    if (typeof media.addEventListener === 'function') media.addEventListener('change', onChange);
    else media.addListener(onChange);
    return () => {
      if (typeof media.removeEventListener === 'function') media.removeEventListener('change', onChange);
      else media.removeListener(onChange);
    };
  }, [query]);

  return matches;
}

export function UsersView({ request, notify, ask, globalQuery, onFilterUserAddresses }: { request: Requester; notify: Notify; ask: ReturnType<typeof useConfirm>['ask']; globalQuery: string; onFilterUserAddresses?: (filter: AddressUserFilter) => void }) {
  const locale = getRuntimeLocale();
  const t = useCallback((zh: string, en: string) => localeText(zh, en, locale), [locale]);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [roles, setRoles] = useState<RoleRecord[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newUser, setNewUser] = useState({ email: '', password: '' });
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [roleTarget, setRoleTarget] = useState<UserRecord | null>(null);
  const [resetTarget, setResetTarget] = useState<UserRecord | null>(null);
  const [expandedUser, setExpandedUser] = useState<UserRecord | null>(null);
  const [closingUserIds, setClosingUserIds] = useState<number[]>([]);
  const [inlineAddressCache, setInlineAddressCache] = useState<Record<number, InlineAddressCacheEntry>>({});
  const [password, setPassword] = useState('');
  const deferredQuery = useDeferredValue(query || globalQuery);
  const isDesktopUsers = useMediaQuery(DESKTOP_USERS_QUERY);
  const requestSeqRef = useRef(0);
  const closeTimerRef = useRef<Record<number, number>>({});
  const inlineAddressCacheRef = useRef<Record<number, InlineAddressCacheEntry>>({});
  const inlineAddressRequestSeqRef = useRef(0);
  const inlineAddressAbortRef = useRef<AbortController | null>(null);
  const listCacheKey = useMemo(() => `${STORAGE_KEYS.userListCachePrefix}${page}:${pageSize}:${encodeURIComponent(deferredQuery)}`, [deferredQuery, page, pageSize]);

  const updateInlineAddressCache = useCallback((updater: (current: Record<number, InlineAddressCacheEntry>) => Record<number, InlineAddressCacheEntry>) => {
    setInlineAddressCache((current) => {
      const next = updater(current);
      inlineAddressCacheRef.current = next;
      return next;
    });
  }, []);

  const isUserClosing = useCallback((userId: number) => closingUserIds.includes(userId), [closingUserIds]);

  const clearCloseTimer = useCallback((userId?: number) => {
    if (typeof userId === 'number') {
      const timer = closeTimerRef.current[userId];
      if (timer) window.clearTimeout(timer);
      delete closeTimerRef.current[userId];
      return;
    }
    Object.values(closeTimerRef.current).forEach((timer) => window.clearTimeout(timer as number));
    closeTimerRef.current = {};
  }, []);

  const finishClosingUser = useCallback((userId: number) => {
    clearCloseTimer(userId);
    setClosingUserIds((current) => current.filter((id) => id !== userId));
    setExpandedUser((current) => (current?.id === userId ? null : current));
  }, [clearCloseTimer]);

  const scheduleClosingCleanup = useCallback((userId: number) => {
    clearCloseTimer(userId);
    closeTimerRef.current[userId] = window.setTimeout(() => finishClosingUser(userId), USER_INLINE_ANIMATION_MS + 80);
  }, [clearCloseTimer, finishClosingUser]);

  const beginClosingUser = useCallback((userId: number) => {
    setClosingUserIds((current) => (current.includes(userId) ? current : [...current, userId]));
    scheduleClosingCleanup(userId);
  }, [scheduleClosingCleanup]);

  const finishInlineAddressRequest = useCallback((userId: number, requestId: number) => {
    updateInlineAddressCache((current) => {
      const entry = current[userId];
      if (!entry || entry.requestId !== requestId) return current;
      return {
        ...current,
        [userId]: { ...entry, loading: false },
      };
    });
  }, [updateInlineAddressCache]);

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
    if (!cached.savedAt || Date.now() - cached.savedAt > CACHE_TTL.shortList) return;
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
    if (actionBusy) return;
    const email = newUser.email.trim();
    const password = newUser.password.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { notify('error', t('请填写有效的用户邮箱', 'Enter a valid user email')); return; }
    if (password.length < 6) { notify('error', t('请填写至少 6 位密码', 'Enter at least 6 password characters')); return; }
    setActionBusy('create');
    try {
      await request('/admin/users', { method: 'POST', body: { email, password: await sha256Hex(password) } });
      notify('success', t('用户已创建', 'User created'));
      setCreateOpen(false);
      setNewUser({ email: '', password: '' });
      await fetchData();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('创建用户失败', 'Failed to create user'));
    } finally {
      setActionBusy(null);
    }
  };
  const loadUserAddresses = useCallback(async (user: UserRecord, forceRefresh = false) => {
    const cached = inlineAddressCacheRef.current[user.id];
    if (!forceRefresh && cached?.loading) return;
    if (!forceRefresh && cached && cached.savedAt > 0 && Date.now() - cached.savedAt < CACHE_TTL.list) return;
    const seq = ++inlineAddressRequestSeqRef.current;
    inlineAddressAbortRef.current?.abort();
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    inlineAddressAbortRef.current = controller;
    updateInlineAddressCache((current) => ({
      ...current,
      [user.id]: { data: current[user.id]?.data || [], loading: true, savedAt: current[user.id]?.savedAt || 0, requestId: seq },
    }));
    try {
      const res = await request<{ results: BoundAddressRecord[] }>(`/admin/users/bind_address/${user.id}`, {
        forceRefresh,
        signal: controller?.signal,
        skipCache: true,
      });
      if (controller?.signal.aborted || seq !== inlineAddressRequestSeqRef.current) {
        finishInlineAddressRequest(user.id, seq);
        return;
      }
      updateInlineAddressCache((current) => ({
        ...current,
        [user.id]: { data: res.results || [], loading: false, savedAt: Date.now(), requestId: seq },
      }));
    } catch (error) {
      if (controller?.signal.aborted || seq !== inlineAddressRequestSeqRef.current) {
        finishInlineAddressRequest(user.id, seq);
        return;
      }
      updateInlineAddressCache((current) => ({
        ...current,
        [user.id]: { data: current[user.id]?.data || [], loading: false, savedAt: current[user.id]?.savedAt || 0, requestId: seq },
      }));
      notify('error', error instanceof Error ? error.message : t('绑定地址加载失败', 'Failed to load bound addresses'));
    } finally {
      if (inlineAddressAbortRef.current === controller) inlineAddressAbortRef.current = null;
    }
  }, [finishInlineAddressRequest, notify, request, t, updateInlineAddressCache]);

  const bindUserAddress = useCallback(async (user: UserRecord, address: string) => {
    const busyKey = `bind:${user.id}`;
    if (actionBusy) return false;
    const trimmed = address.trim();
    if (!trimmed) { notify('error', t('请填写邮箱地址', 'Enter an email address')); return false; }
    setActionBusy(busyKey);
    try {
      await request('/admin/users/bind_address', { method: 'POST', body: { user_id: user.id, user_email: user.user_email, address: trimmed } });
      notify('success', t('地址已绑定', 'Address bound'));
      await loadUserAddresses(user, true);
      return true;
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('绑定失败', 'Bind failed'));
      return false;
    } finally {
      setActionBusy(null);
    }
  }, [actionBusy, loadUserAddresses, notify, request, t]);

  const updateUserRole = async (user: UserRecord, roleText: string) => {
    if (actionBusy) return;
    setActionBusy(`role:${user.id}:${roleText || 'default'}`);
    try {
      await request('/admin/user_roles', { method: 'POST', body: { user_id: user.id, role_text: roleText } });
      notify('success', roleText ? t('角色已更新', 'Role updated') : t('已恢复默认角色', 'Default role restored'));
      setRoleTarget(null);
      await fetchData();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('角色更新失败', 'Failed to update role'));
    } finally {
      setActionBusy(null);
    }
  };

  const resetUserPassword = async () => {
    if (!resetTarget || actionBusy) return;
    const trimmed = password.trim();
    if (trimmed.length < 6) { notify('error', t('请填写至少 6 位新密码', 'Enter at least 6 characters for the new password')); return; }
    setActionBusy(`reset:${resetTarget.id}`);
    try {
      await request(`/admin/users/${resetTarget.id}/reset_password`, { method: 'POST', body: { password: await sha256Hex(trimmed) } });
      notify('success', t('密码已重置', 'Password reset'));
      setResetTarget(null);
      setPassword('');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : t('重置失败', 'Reset failed'));
    } finally {
      setActionBusy(null);
    }
  };

  useEffect(() => {
    const target = expandedUser;
    if (!target || isUserClosing(target.id)) return;
    void loadUserAddresses(target);
  }, [expandedUser, isUserClosing, loadUserAddresses]);

  useEffect(() => () => {
    clearCloseTimer();
    inlineAddressAbortRef.current?.abort();
  }, [clearCloseTimer]);

  const closeExpandedUser = useCallback(() => {
    const target = expandedUser;
    if (!target) return;
    if (isUserClosing(target.id)) return;
    beginClosingUser(target.id);
  }, [beginClosingUser, expandedUser, isUserClosing]);

  const deleteUser = (user: UserRecord) => ask({ title: t(`删除用户 ${user.user_email}`, `Delete user ${user.user_email}`), body: t('将删除用户和地址绑定关系。', 'This deletes the user and address bindings.'), actionLabel: t('删除', 'Delete'), onConfirm: async () => { await request(`/admin/users/${user.id}`, { method: 'DELETE' }); notify('success', t('用户已删除', 'User deleted')); clearCloseTimer(user.id); setExpandedUser((current) => (current?.id === user.id ? null : current)); setClosingUserIds((current) => current.filter((id) => id !== user.id)); await fetchData(); } });
  const toggleUser = (user: UserRecord) => {
    if (isUserClosing(user.id)) {
      clearCloseTimer(user.id);
      setClosingUserIds((current) => current.filter((id) => id !== user.id));
      setExpandedUser(user);
      return;
    }
    if (expandedUser?.id === user.id) {
      closeExpandedUser();
      return;
    }
    if (expandedUser) beginClosingUser(expandedUser.id);
    setExpandedUser(user);
  };
  const jumpToAddressManagement = (user: UserRecord) => {
    clearCloseTimer();
    setExpandedUser(null);
    setClosingUserIds([]);
    onFilterUserAddresses?.({ userId: user.id, userEmail: user.user_email, requestId: Date.now() });
  };

  const renderMobileUser = (user: UserRecord) => {
    const expanded = expandedUser?.id === user.id;
    const closing = isUserClosing(user.id);
    const renderInline = expanded || closing;
    const addressEntry = inlineAddressCache[user.id] || { data: [], loading: false, savedAt: 0 };
    const contentKey = `${addressEntry.loading ? 'loading' : 'ready'}:${addressEntry.data.length}:${addressEntry.savedAt}`;
    return <div key={user.id} className="user-inline-wrapper">
      <article className={cls('user-mobile-card', (expanded || closing) && 'expanded', closing && 'is-collapsing')} onClick={() => toggleUser(user)}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-800">{user.user_email}</p>
            <p className="mt-1 text-[11px] text-slate-400">#{user.id} · {user.role_text || t('默认', 'Default')}</p>
          </div>
          <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-500">{locale === 'en-US' ? `${user.address_count ?? 0} addresses` : `${user.address_count ?? 0} 个地址`}</span>
        </div>
        <div className="mt-2 text-[11px] text-slate-400">{formatDateTime(user.updated_at || user.created_at)}</div>
        <div className="mt-3 grid grid-cols-3 gap-1.5">
          <button type="button" className="btn-secondary compact" onClick={(event) => { event.stopPropagation(); toggleUser(user); }}><Link2 size={14} /> {t('地址', 'Addresses')}</button>
          <button type="button" className="btn-secondary compact" onClick={(event) => { event.stopPropagation(); jumpToAddressManagement(user); }}><Filter size={14} /> {t('筛选', 'Filter')}</button>
          <button type="button" className="btn-secondary compact" onClick={(event) => { event.stopPropagation(); setRoleTarget(user); }}><Shield size={14} /> {t('角色', 'Role')}</button>
          <button type="button" className="btn-secondary compact" onClick={(event) => { event.stopPropagation(); setResetTarget(user); setPassword(''); }}><Lock size={14} /> {t('密码', 'Password')}</button>
          <button type="button" className="btn-danger compact col-span-2" onClick={(event) => { event.stopPropagation(); deleteUser(user); }}><Trash2 size={14} /> {t('删除', 'Delete')}</button>
        </div>
      </article>
      {renderInline && <UserInlineMotion className="user-inline-mobile-motion" open={expanded && !closing} closing={closing} contentKey={contentKey} onClosed={() => finishClosingUser(user.id)}><MemoUserAddressInline user={user} data={addressEntry.data} loading={addressEntry.loading} onBind={(value) => bindUserAddress(user, value)} onManage={() => jumpToAddressManagement(user)} onClose={closeExpandedUser} /></UserInlineMotion>}
    </div>;
  };

  const renderDesktopUser = (user: UserRecord) => {
    const expanded = expandedUser?.id === user.id;
    const closing = isUserClosing(user.id);
    const renderInline = expanded || closing;
    const addressEntry = inlineAddressCache[user.id] || { data: [], loading: false, savedAt: 0 };
    const contentKey = `${addressEntry.loading ? 'loading' : 'ready'}:${addressEntry.data.length}:${addressEntry.savedAt}`;
    return <div key={user.id} className={cls('user-grid-item', (expanded || closing) && 'is-expanded', closing && 'is-collapsing')}>
      <div className="user-grid-row user-grid-body-row" role="button" tabIndex={0} onClick={() => toggleUser(user)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggleUser(user); } }}>
        <div className="font-mono text-xs text-slate-400">#{user.id}</div>
        <div className="min-w-0"><span className="address-strong">{user.user_email}</span></div>
        <div>{user.role_text || t('默认', 'Default')}</div>
        <div>{user.address_count ?? 0}</div>
        <div>{formatDateTime(user.updated_at || user.created_at)}</div>
        <div className="flex justify-end gap-2">
          <button type="button" className="table-action" onClick={(event) => { event.stopPropagation(); toggleUser(user); }} title={t('查看地址', 'View addresses')}>{expanded || closing ? <ChevronUp size={15} /> : <Link2 size={15} />}</button>
          <button type="button" className="table-action" onClick={(event) => { event.stopPropagation(); jumpToAddressManagement(user); }} title={t('在地址管理筛选', 'Filter in address management')}><Filter size={15} /></button>
          <button type="button" className="table-action" onClick={(event) => { event.stopPropagation(); setRoleTarget(user); }} title={t('角色', 'Role')}><Shield size={15} /></button>
          <button type="button" className="table-action" onClick={(event) => { event.stopPropagation(); setResetTarget(user); setPassword(''); }} title={t('重置密码', 'Reset password')}><Lock size={15} /></button>
          <button type="button" className="table-action danger" onClick={(event) => { event.stopPropagation(); deleteUser(user); }} title={t('删除', 'Delete')}><Trash2 size={15} /></button>
        </div>
      </div>
      {renderInline && <UserInlineMotion className="user-inline-motion" open={expanded && !closing} closing={closing} contentKey={contentKey} onClosed={() => finishClosingUser(user.id)}><MemoUserAddressInline user={user} data={addressEntry.data} loading={addressEntry.loading} onBind={(value) => bindUserAddress(user, value)} onManage={() => jumpToAddressManagement(user)} onClose={closeExpandedUser} /></UserInlineMotion>}
    </div>;
  };

  return <div className="users-view-shell h-full space-y-4 overflow-y-auto p-3 md:p-4 xl:p-6">
    <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center"><div><h2 className="text-2xl font-bold text-slate-800">{t('用户管理', 'User management')}</h2></div><button type="button" className="btn-primary" onClick={() => setCreateOpen(true)}><Plus size={16} /> {t('新建用户', 'New user')}</button></div>
    <div className="panel overflow-hidden"><div className="flex flex-col gap-3 border-b border-slate-100 p-3 md:flex-row"><input className="form-input compact-control" value={query} onChange={(e) => { setQuery(e.target.value); setPage(1); }} placeholder={t('搜索用户邮箱', 'Search user email')} /><button type="button" className="btn-secondary compact" onClick={() => fetchData(true)}><RefreshCw size={15} className={cls(loading && users.length > 0 && 'animate-spin')} /> {t('刷新', 'Refresh')}</button></div>{loading && users.length === 0 ? <LoadingState /> : users.length === 0 ? <div className="p-4 md:p-6"><EmptyState icon={UserRoundCog} title={t('暂无用户', 'No users')} /></div> : <>
      {isDesktopUsers ? <div className="user-grid-scroll"><div className="user-grid-list" role="table" aria-label={t('用户列表', 'User list')}><div className="user-grid-row user-grid-header" role="row"><div>ID</div><div>{t('邮箱', 'Email')}</div><div>{t('角色', 'Role')}</div><div>{t('地址数', 'Addresses')}</div><div>{t('更新时间', 'Updated')}</div><div className="text-right">{t('操作', 'Actions')}</div></div>{users.map(renderDesktopUser)}</div></div> : <div className="space-y-2 p-3">{users.map(renderMobileUser)}</div>}
    </>}<Pagination page={page} setPage={setPage} pageSize={pageSize} setPageSize={setPageSize} totalPages={totalPages} count={count} /></div>
    {createOpen && <Modal title={t('新建用户', 'New user')} onClose={() => setCreateOpen(false)}><div className="space-y-4"><input className="form-input" value={newUser.email} onChange={(e) => setNewUser({ ...newUser, email: e.target.value })} placeholder={t('用户邮箱', 'User email')} /><input className="form-input" type="password" value={newUser.password} onChange={(e) => setNewUser({ ...newUser, password: e.target.value })} placeholder={t('用户密码', 'User password')} /><button type="button" className="btn-primary w-full" disabled={actionBusy === 'create'} onClick={createUser}>{actionBusy === 'create' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus size={16} />} {actionBusy === 'create' ? t('创建中...', 'Creating...') : t('创建', 'Create')}</button></div></Modal>}
    {roleTarget && <Modal title={t(`修改角色：${roleTarget.user_email}`, `Change role: ${roleTarget.user_email}`)} onClose={() => setRoleTarget(null)}><div className="space-y-3"><button type="button" className="btn-secondary w-full justify-start" disabled={Boolean(actionBusy)} onClick={() => void updateUserRole(roleTarget, '')}>{actionBusy === `role:${roleTarget.id}:default` ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{t('默认角色', 'Default role')}</button>{roles.map((role) => <button type="button" key={role.role} className="btn-secondary w-full justify-start" disabled={Boolean(actionBusy)} onClick={() => void updateUserRole(roleTarget, role.role)}>{actionBusy === `role:${roleTarget.id}:${role.role}` ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{role.label || role.role}</button>)}</div></Modal>}
    {resetTarget && <Modal title={t(`重置密码：${resetTarget.user_email}`, `Reset password: ${resetTarget.user_email}`)} onClose={() => setResetTarget(null)}><div className="space-y-4"><input className="form-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder={t('新密码', 'New password')} /><button type="button" className="btn-primary w-full" disabled={actionBusy === `reset:${resetTarget.id}`} onClick={() => void resetUserPassword()}>{actionBusy === `reset:${resetTarget.id}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save size={16} />} {actionBusy === `reset:${resetTarget.id}` ? t('保存中...', 'Saving...') : t('保存', 'Save')}</button></div></Modal>}
  </div>;
}

function UserInlineMotion({ className, open, closing, contentKey, onClosed, children }: { className: string; open: boolean; closing: boolean; contentKey: string; onClosed: () => void; children: ReactNode }) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const prevStateRef = useRef({ open: false, closing: false });
  const closeNotifiedRef = useRef(false);
  const [height, setHeight] = useState(0);

  const clearFrame = useCallback(() => {
    if (rafRef.current !== null) window.cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  }, []);

  const measureHeight = useCallback(() => innerRef.current?.scrollHeight ?? 0, []);

  useLayoutEffect(() => {
    const previous = prevStateRef.current;
    prevStateRef.current = { open, closing };
    closeNotifiedRef.current = false;
    clearFrame();

    if (closing) {
      const visibleHeight = shellRef.current?.getBoundingClientRect().height ?? 0;
      setHeight(Math.max(visibleHeight, measureHeight()));
      rafRef.current = window.requestAnimationFrame(() => {
        rafRef.current = window.requestAnimationFrame(() => {
          setHeight(0);
          rafRef.current = null;
        });
      });
      return clearFrame;
    }

    if (open) {
      if (!previous.open || previous.closing) {
        setHeight(0);
        rafRef.current = window.requestAnimationFrame(() => {
          setHeight(measureHeight());
          rafRef.current = null;
        });
      } else {
        setHeight(measureHeight());
      }
      return clearFrame;
    }

    setHeight(0);
    return clearFrame;
  }, [clearFrame, closing, contentKey, measureHeight, open]);

  useEffect(() => {
    if (!open || closing || typeof ResizeObserver === 'undefined' || !innerRef.current) return undefined;
    const resizeObserver = new ResizeObserver(() => setHeight(measureHeight()));
    resizeObserver.observe(innerRef.current);
    return () => resizeObserver.disconnect();
  }, [closing, measureHeight, open]);

  const handleTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (event.currentTarget !== event.target || event.propertyName !== 'height') return;
    if (!closing || closeNotifiedRef.current) return;
    closeNotifiedRef.current = true;
    onClosed();
  };

  const style = {
    '--user-inline-height': `${height}px`,
    '--user-inline-duration': `${USER_INLINE_ANIMATION_MS}ms`,
  } as CSSProperties;

  return <div ref={shellRef} className={cls(className, open && 'is-open', closing && 'is-closing')} style={style} onTransitionEnd={handleTransitionEnd}>
    <div ref={innerRef} className="user-inline-motion-inner">{children}</div>
  </div>;
}

function UserAddressInline({ user, data, loading, onBind, onManage, onClose }: { user: UserRecord; data: BoundAddressRecord[]; loading: boolean; onBind: (address: string) => Promise<boolean>; onManage: () => void; onClose: () => void }) {
  const locale = getRuntimeLocale();
  const t = useCallback((zh: string, en: string) => localeText(zh, en, locale), [locale]);
  const [address, setAddress] = useState('');
  const [binding, setBinding] = useState(false);

  const bind = async () => {
    if (binding || loading) return;
    setBinding(true);
    try {
      const ok = await onBind(address);
      if (ok) setAddress('');
    } finally {
      setBinding(false);
    }
  };

  return <div className="user-address-inline">
    <div className="user-address-inline-head">
      <div className="min-w-0"><p className="truncate text-sm font-semibold text-slate-800">{locale === 'en-US' ? `${user.user_email} addresses` : `${user.user_email} 的地址`}</p><p className="text-xs text-slate-400">{locale === 'en-US' ? `${data.length} total` : `共 ${data.length} 个`}</p></div>
      <div className="flex shrink-0 gap-2"><button type="button" className="btn-secondary compact" onClick={onManage}><Filter size={14} /> {t('地址管理筛选', 'Filter in addresses')}</button><button type="button" className="btn-secondary compact" onClick={onClose}><ChevronUp size={14} /> {t('收起', 'Collapse')}</button></div>
    </div>
    <div className="mt-3 flex flex-col gap-2 sm:flex-row"><input className="form-input compact-control" value={address} onChange={(e) => setAddress(e.target.value)} placeholder={t('绑定完整邮箱地址，例如 test@example.com', 'Bind full mailbox address, e.g. test@example.com')} /><button type="button" className="btn-primary compact" disabled={binding || loading} onClick={bind}>{binding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 size={14} />} {binding ? t('绑定中', 'Binding') : t('绑定', 'Bind')}</button></div>
    {loading ? <LoadingState label={t('正在加载用户地址...', 'Loading user addresses...')} /> : data.length === 0 ? <div className="mt-3"><EmptyState icon={Link2} title={t('暂无绑定地址', 'No bound addresses')} /></div> : <div className="user-address-inline-list">{data.map((row) => <div key={row.id} className="user-address-inline-item"><div className="min-w-0"><p className="truncate font-semibold text-slate-800">{row.name}</p><p className="text-[11px] text-slate-400">#{row.id} · {formatDateTime(row.updated_at || row.created_at)}</p></div><div className="user-address-inline-stats"><span>{t('收', 'In')} {row.mail_count ?? 0}</span><span>{t('发', 'Out')} {row.send_count ?? 0}</span></div></div>)}</div>}
  </div>;
}

const MemoUserAddressInline = memo(UserAddressInline, (prev, next) => (
  prev.user.id === next.user.id
  && prev.user.user_email === next.user.user_email
  && prev.loading === next.loading
  && prev.data === next.data
));
