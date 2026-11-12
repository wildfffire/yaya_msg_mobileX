import { useCallback, useEffect, useRef, useState } from 'react';
import Clipboard from '@react-native-clipboard/clipboard';
import { useI18n } from '../../i18n';
import { useSettingsStore, useUiStore } from '../../store';
import { saveSettings } from '../../services/settings';
import { resetNimSession } from '../../services/pocketNim/session';
import pocketApi from '../../api/pocket48';
import { errorMessage, pickText } from '../../utils/data';
import {
  accountId, accountName, extractPocketToken, parseAccountInfo, type AccountInfo,
} from './accountParse';

export interface VerifyState {
  question: string;
  options: string[];
  phone: string;
  area: string;
}

/**
 * 口袋账号域：登录（短信/Token）、账号信息读取、大小号切换、复制 Token、注销。
 * 只复用既有接口；切号/注销仍走 setSettings → saveSettings → resetNimSession 的唯一链路。
 */
export function usePocketAccount() {
  const { t } = useI18n();
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const showToast = useUiStore((s) => s.showToast);
  const token = settings.p48Token;

  const [accountInfo, setAccountInfo] = useState<AccountInfo>({ current: null, users: [] });
  const [manualToken, setManualToken] = useState(token || '');
  const [phone, setPhone] = useState('');
  const [area, setArea] = useState('86');
  const [code, setCode] = useState('');
  const [verify, setVerify] = useState<VerifyState | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [switchingUserId, setSwitchingUserId] = useState('');
  const autoTokenRef = useRef('');
  const inflightRef = useRef(false);

  const refreshAccountInfo = useCallback(async () => {
    if (inflightRef.current) return { res: null, ok: false };
    inflightRef.current = true;
    try {
      const res = await pocketApi.loginCheckToken();
      const ok = res?.success !== false && (res?.status === 200 || res?.success || res?.content || res?.data);
      setAccountInfo(parseAccountInfo(res));
      return { res, ok };
    } finally {
      inflightRef.current = false;
    }
  }, []);

  const savePocketToken = useCallback(async (next: string, message: string) => {
    const clean = next.trim();
    try {
      setSettings({ p48Token: clean });
      await saveSettings({ p48Token: clean });
      // 账号变了必须重置云信会话（凭证/自身资料/QChat·聊天室登录态 + 原生连接）
      resetNimSession('切换/保存口袋账号');
      setManualToken(clean);
      setStatus(message);
    } catch (error: any) {
      setStatus(t('保存失败：{msg}', { msg: error?.message || String(error) }));
    }
  }, [setSettings, t]);

  const sendSms = useCallback(async (answer?: string) => {
    if (!phone.trim() && !verify) {
      setStatus(t('请输入手机号'));
      return;
    }
    setLoading(true);
    setStatus(t('正在获取验证码'));
    try {
      const areaCode = area.replace(/[^0-9]/g, '') || '86';
      const res: any = await pocketApi.loginSendSms(phone.trim() || verify!.phone, verify?.area || areaCode, answer);
      if (res?.needVerification) {
        setVerify({
          question: res.question || t('安全验证'),
          options: Array.isArray(res.options) ? res.options.map(String) : [],
          phone: phone.trim() || verify!.phone,
          area: verify?.area || areaCode,
        });
        setStatus(t('请完成安全验证后重新获取验证码'));
      } else {
        setStatus(res?.success ? t('验证码已发送') : t(res?.msg || res?.message || '验证码发送失败'));
        if (res?.success) setVerify(null);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [area, phone, t, verify]);

  const loginByCode = useCallback(async () => {
    if (!phone.trim() || !code.trim()) {
      setStatus(t('请输入手机号和短信验证码'));
      return;
    }
    setLoading(true);
    setStatus(t('正在登录'));
    try {
      const res = await pocketApi.loginByCode(phone.trim(), code.trim());
      const nextToken = extractPocketToken(res);
      if (nextToken) {
        await savePocketToken(nextToken, t('登录成功'));
        showToast(t('登录成功'));
      } else {
        const msg = res?.message || res?.msg || res?.content?.message || JSON.stringify(res).slice(0, 180);
        const base = t('登录失败接口未返回token');
        setStatus(msg ? `${base}。${t('返回：{msg}', { msg: t(String(msg)) })}` : base);
      }
    } catch (error) {
      setStatus(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, [code, phone, savePocketToken, showToast, t]);

  const saveManualToken = useCallback(async () => {
    const next = manualToken.trim();
    if (!next) {
      setStatus(t('请先粘贴token'));
      return;
    }
    setLoading(true);
    setStatus(t('正在保存...'));
    try {
      await savePocketToken(next, t('Token已保存'));
    } finally {
      setLoading(false);
    }
  }, [manualToken, savePocketToken, t]);

  /** 「刷新账号列表」/「检查 Token」：先按输入框里的 Token 落盘，再拉账号信息 */
  const checkToken = useCallback(async () => {
    const next = manualToken.trim() || token;
    if (next && next !== token) await savePocketToken(next, t('Token已保存'));
    setLoading(true);
    setStatus(t('正在检查Token'));
    try {
      const { res, ok } = await refreshAccountInfo();
      setStatus(ok ? t('Token有效') : t('Token无效：{msg}', { msg: res?.msg || res?.message || JSON.stringify(res).slice(0, 160) }));
    } catch (error) {
      setStatus(t('Token无效：{msg}', { msg: errorMessage(error) }));
    } finally {
      setLoading(false);
    }
  }, [manualToken, refreshAccountInfo, savePocketToken, t, token]);

  const switchAccount = useCallback(async (user: any) => {
    const targetUserId = accountId(user);
    if (!targetUserId) {
      setStatus(t('切换失败没有拿到目标账号ID'));
      return;
    }
    setLoading(true);
    setSwitchingUserId(targetUserId);
    setStatus(t('正在切换到{name}', { name: accountName(user, t('未命名账号')) }));
    try {
      const res = await pocketApi.switchBigSmall(targetUserId);
      const nextToken = pickText(res, ['content.token', 'data.token', 'token', 'content.accessToken', 'data.accessToken']) || extractPocketToken(res);
      if (!nextToken) throw new Error(t('切换失败没有拿到目标账号ID'));
      const done = t('已切换到{name}', { name: accountName(user, t('未命名账号')) });
      await savePocketToken(nextToken, done);
      autoTokenRef.current = nextToken; // 本处已显式刷新，避免 token 变化的 effect 重复请求
      await refreshAccountInfo();
      showToast(done);
    } catch (error) {
      setStatus(t('切换账号失败：{msg}', { msg: errorMessage(error) }));
    } finally {
      setSwitchingUserId('');
      setLoading(false);
    }
  }, [refreshAccountInfo, savePocketToken, showToast, t]);

  const copyToken = useCallback(() => {
    if (!token) return;
    Clipboard.setString(token);
    showToast(t('Token 已复制'));
  }, [showToast, t, token]);

  const logout = useCallback(async () => {
    setSettings({ p48Token: '' });
    await saveSettings({ p48Token: '' });
    resetNimSession('注销账号');
    setManualToken('');
    setAccountInfo({ current: null, users: [] });
    setStatus('');
    autoTokenRef.current = '';
    showToast(t('已注销'));
  }, [setSettings, showToast, t]);

  // 进入页面 / 换号后自动读一次账号信息（inflight 合并 + token 维度去重，不轮询）
  useEffect(() => {
    setManualToken(token || '');
    if (!token) {
      autoTokenRef.current = '';
      setAccountInfo({ current: null, users: [] });
      return;
    }
    if (autoTokenRef.current === token) return;
    autoTokenRef.current = token;
    void refreshAccountInfo().catch(() => setStatus(t('账号信息读取失败')));
  }, [refreshAccountInfo, t, token]);

  return {
    token, accountInfo, manualToken, phone, area, code, verify, loading, status, switchingUserId,
    setManualToken, setPhone, setArea, setCode,
    refreshAccountInfo, checkToken, sendSms, loginByCode, saveManualToken, switchAccount, copyToken, logout,
  };
}

export type PocketAccountApi = ReturnType<typeof usePocketAccount>;
