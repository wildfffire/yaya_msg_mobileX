import { useSettingsStore } from '../store';
import { requestJson } from '../utils/network';

const BASE = 'https://pocketapi.48.cn';

const DESKTOP_APP_INFO = JSON.stringify({
  vendor: 'google',
  deviceId: '123',
  appVersion: '6.0.0',
  appBuild: '123',
  osType: 'android',
  osVersion: '10.0.0',
  deviceName: 'pixel',
});

function responseMessage(res: any, fallback: string): string {
  return res?.message || res?.msg || res?.error || fallback;
}

function assertOk(res: any, fallback: string) {
  if (res?.status === 200 || res?.success) return res;
  throw new Error(responseMessage(res, fallback));
}

/**
 * 桌面端接口 POST。
 *
 * 改用统一请求层 `utils/network.requestJson`：它已内置超时（AbortController）、
 * 宽松 JSON 解析（超大整数补引号）、错误消息提取与并发去重。
 * 原先这里手写了一份 XHR 版本，把同样的超时/解析/错误处理又实现了一遍，
 * 且不享受任何请求层优化（无去重、无统一超时语义）。
 */
async function desktopPost(path: string, payload: Record<string, any>, fallback: string): Promise<any> {
  const res = await requestJson<any>(`${BASE}${path}`, {
    method: 'POST',
    body: payload,
    headers: { 'app-info': DESKTOP_APP_INFO },
    timeout: 15000,
  });
  return assertOk(res, fallback);
}

export const officialMediaApi = {
  getTalkList(params: { ctime?: number; groupId?: number; limit?: number } = {}) {
    return desktopPost('/media/api/media/v1/talk/list', {
      ctime: params.ctime || 0,
      groupId: params.groupId ?? 0,
      limit: params.limit || 20,
    }, '获取电台列表失败');
  },

  getTalk(talkId: string) {
    return desktopPost('/media/api/media/v1/talk', {
      resId: String(talkId),
    }, '获取电台音频失败');
  },

  getMusicList(params: { ctime?: number; limit?: number } = {}) {
    return desktopPost('/media/api/media/v1/music/list', {
      ctime: params.ctime || 0,
      limit: params.limit || 20,
    }, '获取音乐列表失败');
  },

  getMusic(musicId: string) {
    return desktopPost('/media/api/media/v1/music', {
      resId: String(musicId),
    }, '获取音乐地址失败');
  },

  getVideoList(params: { ctime?: number; typeId?: number; groupId?: number; limit?: number } = {}) {
    return desktopPost('/media/api/media/v1/video/list', {
      ctime: params.ctime || 0,
      typeId: params.typeId ?? 0,
      groupId: params.groupId ?? 0,
      limit: params.limit || 20,
    }, '获取视频列表失败');
  },

  getVideo(videoId: string) {
    return desktopPost('/media/api/media/v1/video', {
      resId: String(videoId),
    }, '获取视频地址失败');
  },
};

export default officialMediaApi;
