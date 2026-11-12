import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { useI18n } from '../../i18n';
import { useSettingsStore } from '../../store';
import { saveSettings } from '../../services/settings';
import bilibiliApi from '../../api/bilibili';
import { errorMessage } from '../../utils/data';
import { logWarn } from '../../utils/runtimeLog';
import { buildBilibiliCookieFromUrl, pickBiliCookies } from './accountParse';

/**
 * B站登录管理：扫码登录 / 刷新状态 / 退出登录。
 * 扫码与轮询链路从旧账号页原样迁移（含 2024+ ticket 换 cookie 的原生兜底）。
 */
export function useBiliLogin() {
  const { t } = useI18n();
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const cookie = settings.bilibiliCookie;
  const biliName = String(settings.bilibiliUserInfo?.uname || '');

  const [qrHtml, setQrHtml] = useState<string | null>(null);
  const [biliStatus, setBiliStatus] = useState('');
  const [qrLoading, setQrLoading] = useState(false);
  const pollingRef = useRef(true);
  const activePollKeyRef = useRef('');
  const initialStatusRef = useRef(false);

  useEffect(() => () => { pollingRef.current = false; }, []);

  const pollBiliLogin = useCallback(async (key: string) => {
    if (activePollKeyRef.current && activePollKeyRef.current !== key) return;
    activePollKeyRef.current = key;
    let pollWarned = false;
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      if (!pollingRef.current) return;
      if (activePollKeyRef.current !== key) return;
      try {
        const res: any = await bilibiliApi.pollQrCode(key);
        if (res.data.code === 0) {
          const rawUrl = String(res.data?.url || '');
          let nextCookie = buildBilibiliCookieFromUrl(rawUrl);
          if (!nextCookie.includes('SESSDATA') && /ticket=|crossDomain/i.test(rawUrl)) {
            try {
              const raw = await bilibiliApi.exchangeTicket(rawUrl);
              nextCookie = pickBiliCookies(raw);
              logWarn(
                `[bili-login] ticket 换 cookie ${nextCookie.includes('SESSDATA') ? '成功' : '失败（无 SESSDATA）'} 原生返: ${raw.slice(0, 200)}`,
                'login.pollBili',
              );
            } catch (e) {
              logWarn('[bili-login] ticket 换 cookie 异常: ' + errorMessage(e), 'login.pollBili');
            }
          }
          if (!nextCookie.includes('SESSDATA')) {
            logWarn(
              `[bili-login] 扫码已确认但 url 未解析出 SESSDATA（前 200 字符）: ${rawUrl.slice(0, 200)} code=${res.data?.code}`,
              'login.pollBili',
            );
            setBiliStatus(t('B站已确认但没有拿到Cookie'));
            return;
          }
          const nav: any = await bilibiliApi.checkLoginStatus(nextCookie);
          const userInfo = nav?.code === 0 && nav?.data?.isLogin
            ? { mid: String(nav.data.mid || ''), uname: String(nav.data.uname || ''), face: String(nav.data.face || '') }
            : null;
          setSettings({ bilibiliCookie: nextCookie, bilibiliUserInfo: userInfo });
          await saveSettings({ bilibiliCookie: nextCookie, bilibiliUserInfo: userInfo });
          setBiliStatus(t('B站登录成功'));
          return;
        }
        if (res.data.code === 86038) {
          setBiliStatus(t('二维码已过期请刷新'));
          return;
        }
      } catch (e) {
        if (!pollWarned) {
          pollWarned = true;
          logWarn('B站二维码轮询失败: ' + errorMessage(e), 'login.pollBili');
        }
      }
    }
    setBiliStatus(t('B站登录超时'));
  }, [setSettings, t]);

  const generateQr = useCallback(async () => {
    setQrLoading(true);
    setBiliStatus(t('正在获取B站二维码'));
    try {
      const res: any = await bilibiliApi.generateQrCode();
      if (res.code === 0 && res.data) {
        const key = res.data.qrcode_key;
        const svg = await QRCode.toString(res.data.url, { type: 'svg', margin: 2, width: 220 });
        setQrHtml(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"/></head><body style="margin:0;background:#fff;display:flex;align-items:center;justify-content:center;">${svg}</body></html>`);
        setBiliStatus(t('请用B站App扫码'));
        void pollBiliLogin(key);
      } else {
        setBiliStatus(res?.message || t('B站二维码获取失败'));
      }
    } catch (error) {
      setBiliStatus(errorMessage(error));
    } finally {
      setQrLoading(false);
    }
  }, [pollBiliLogin, t]);

  const refreshStatus = useCallback(async () => {
    if (!cookie) {
      setBiliStatus(t('B站未登录'));
      return;
    }
    setBiliStatus(t('正在检查B站登录状态'));
    try {
      const nav: any = await bilibiliApi.checkLoginStatus(cookie);
      if (nav?.code === 0 && nav?.data?.isLogin) {
        const uname = String(nav.data.uname || '');
        setSettings({ bilibiliUserInfo: { mid: String(nav.data.mid || ''), uname, face: String(nav.data.face || '') } });
        await saveSettings({ bilibiliUserInfo: { mid: String(nav.data.mid || ''), uname, face: String(nav.data.face || '') } });
        setBiliStatus(t('B站登录状态已刷新'));
      } else {
        setBiliStatus(t('B站未登录'));
      }
    } catch (error) {
      setBiliStatus(t('B站登录状态检查失败：{msg}', { msg: errorMessage(error) }));
    }
  }, [cookie, setSettings, t]);

  const logout = useCallback(async () => {
    setSettings({ bilibiliCookie: '', bilibiliUserInfo: null });
    await saveSettings({ bilibiliCookie: '', bilibiliUserInfo: null });
    setQrHtml(null);
    setBiliStatus(t('B站未登录'));
  }, [setSettings, t]);

  useEffect(() => {
    if (initialStatusRef.current) return;
    initialStatusRef.current = true;
    void refreshStatus();
  }, [refreshStatus]);

  return { qrHtml, biliStatus, qrLoading, biliName, loggedIn: !!cookie, generateQr, refreshStatus, logout };
}

export type BiliLoginApi = ReturnType<typeof useBiliLogin>;
