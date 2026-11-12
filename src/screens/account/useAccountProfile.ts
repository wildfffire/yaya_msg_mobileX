import { useCallback, useEffect, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { useI18n } from '../../i18n';
import { useSettingsStore, useUiStore } from '../../store';
import { saveSettings } from '../../services/settings';
import pocketApi from '../../api/pocket48';
import { errorMessage } from '../../utils/data';

/**
 * 账号资料域：昵称/头像编辑、剩余改名次数、鸡腿余额、立即签到、自动签到开关。
 * 各接口独立容错：一个失败不影响其它分区；只在进页面与用户主动点击时请求，不轮询。
 */
export function useAccountProfile(enabled: boolean) {
  const { t } = useI18n();
  const settings = useSettingsStore((s) => s.settings);
  const setSettings = useSettingsStore((s) => s.setSettings);
  const showToast = useUiStore((s) => s.showToast);
  const token = settings.p48Token;

  const [profileName, setProfileName] = useState('');
  const [profileAvatar, setProfileAvatar] = useState('');
  const [renameCountText, setRenameCountText] = useState('');
  const [balance, setBalance] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [checkinStatus, setCheckinStatus] = useState('');
  const [loading, setLoading] = useState(false);
  const [checkinBusy, setCheckinBusy] = useState(false);
  const inflightRef = useRef(false);
  const loadedTokenRef = useRef('');

  const refreshBalance = useCallback(async () => {
    try {
      const res: any = await pocketApi.getUserMoney();
      const content = res?.content ?? res?.data ?? res;
      const value = content?.moneyTotal ?? content?.total ?? content?.balance ?? content?.money ?? res?.moneyTotal;
      setBalance(value === undefined || value === null ? null : String(value));
      return true;
    } catch (error) {
      setStatus(t('余额刷新失败：{msg}', { msg: errorMessage(error) }));
      return false;
    }
  }, [t]);

  const loadProfile = useCallback(async () => {
    if (!enabled || !token || inflightRef.current) return;
    inflightRef.current = true;
    setLoading(true);
    try {
      try {
        const res: any = await pocketApi.getNimLoginInfo();
        const info = res?.content?.userInfo || res?.content?.user || res?.content || res?.data?.userInfo || res?.data || {};
        const base = info?.baseUserInfo || {};
        const name = String(info.nickName || info.nickname || info.name || base.nickName || base.nickname || '');
        const avatar = String(info.avatar || info.headImg || info.headUrl || base.avatar || '');
        if (name) setProfileName(name);
        if (avatar) setProfileAvatar(avatar);
      } catch (error) {
        setStatus(t('资料读取失败：{msg}', { msg: errorMessage(error) }));
      }
      try {
        const res: any = await pocketApi.getUserRenameCount();
        const content = res?.content ?? res?.data ?? res;
        if (content && typeof content === 'object') {
          const free = content.count ?? content.renameCount ?? content.renameNum ?? content.num ?? content.leftCount ?? content.remainCount;
          const chicken = content.jtcount ?? content.jtCount ?? content.chickenCount ?? content.payCount;
          setRenameCountText(t('免费修改：{free} · 鸡腿修改：{chicken}', { free: free ?? '--', chicken: chicken ?? '--' }));
        }
      } catch {
        /* 改名次数拿不到不阻塞资料卡 */
      }
      await refreshBalance();
    } finally {
      inflightRef.current = false;
      setLoading(false);
    }
  }, [enabled, refreshBalance, t, token]);

  const editNickname = useCallback(async () => {
    const name = profileName.trim();
    if (!name) {
      setStatus(t('请输入新昵称'));
      return;
    }
    setLoading(true);
    setStatus(t('正在修改昵称'));
    try {
      await pocketApi.editUserInfo({ key: 'nickname', value: name });
      setStatus(t('昵称修改成功'));
      showToast(t('昵称修改成功'));
      loadedTokenRef.current = '';
      await loadProfile();
    } catch (error) {
      setStatus(t('资料读取失败：{msg}', { msg: errorMessage(error) }));
    } finally {
      setLoading(false);
    }
  }, [loadProfile, profileName, showToast, t]);

  const pickAvatar = useCallback(async () => {
    setLoading(true);
    setStatus(t('正在选择并上传头像'));
    try {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        setStatus(t('没有相册权限无法选择头像'));
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      });
      if (result.canceled) {
        setStatus(t('已取消选择头像'));
        return;
      }
      const asset = result.assets?.[0];
      if (!asset?.uri) throw new Error(t('图片选择器没有返回文件'));
      setStatus(t('正在上传到口袋服务器'));
      const upload = await pocketApi.uploadUserAvatar({
        uri: asset.uri,
        fileName: asset.fileName || `avatar-${Date.now()}.jpg`,
        mimeType: asset.mimeType || 'image/jpeg',
      });
      if (!upload.path) throw new Error(t('上传成功但没有返回路径'));
      setStatus(t('正在更新头像'));
      await pocketApi.editUserInfo({ key: 'avatar', value: upload.path });
      setProfileAvatar(upload.path);
      setStatus(t('头像已更新'));
      showToast(t('头像已更新'));
    } catch (error) {
      setStatus(t('头像上传失败：{msg}', { msg: errorMessage(error) }));
    } finally {
      setLoading(false);
    }
  }, [showToast, t]);

  const checkinNow = useCallback(async () => {
    setCheckinBusy(true);
    try {
      const res: any = await pocketApi.checkIn();
      setCheckinStatus(res?.alreadyChecked ? t('今日已经签到过了') : (res?.message || t('签到成功')));
    } catch (error) {
      setCheckinStatus(t('签到失败：{msg}', { msg: errorMessage(error) }));
    } finally {
      setCheckinBusy(false);
    }
  }, [t]);

  const setAutoCheckinEnabled = useCallback((value: boolean) => {
    setSettings({ yaya_auto_checkin_enabled: value });
    void saveSettings({ yaya_auto_checkin_enabled: value });
  }, [setSettings]);

  useEffect(() => {
    if (!enabled || !token || loadedTokenRef.current === token) return;
    loadedTokenRef.current = token;
    void loadProfile();
  }, [enabled, loadProfile, token]);

  return {
    profileName, setProfileName, profileAvatar, renameCountText, balance,
    status, checkinStatus, loading, checkinBusy,
    loadProfile, refreshBalance, editNickname, pickAvatar, checkinNow,
    autoCheckinEnabled: !!settings.yaya_auto_checkin_enabled,
    lastCheckinDate: settings.yaya_auto_checkin_last_date || '',
    setAutoCheckinEnabled,
  };
}

export type AccountProfileApi = ReturnType<typeof useAccountProfile>;
