import React, { useCallback, useEffect, useState } from 'react';
import { Image, ImageProps, Platform, StyleSheet, View } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { thumbUrl } from '../utils/imageThumb';
import { POCKET_IMAGE_HEADERS, isPocketImageUrl } from '../utils/imageHeaders';
import { logInfo, logWarn } from '../utils/runtimeLog';

type NetworkImageProps = ImageProps & {
  /** 加载失败时是否显示回退占位（浅灰底 + 可选图标），默认开启（D4 修复：source.48.cn 偶发拒绝不再留白块） */
  fallback?: boolean;
  /** 回退占位图标（MaterialCommunityIcons 名）；不传则不显示图标只显示浅灰底 */
  fallbackIcon?: string;
  /**
   * 缩略图盒子的边长（px）。列表/头像类小图传它可显著省流量、加快加载。
   * 走 48 图床的 `source1.48.cn/resize_NxN/<path>`（等比 contain），
   * 实测封面 783KB → 13KB 量级；非 48 图床 / gif / 音视频自动原样返回。
   * 不传则用原图 URL（详情页/大图场景）。
   */
  thumbnail?: number;
  /**
   * 本地兜底（用户 2026-11-02：「有的照片在房间里显示不出来，但是可以保存」）。
   *
   * 缩略图 + 原图都被 Image 判失败时，用 expo-file-system 把同一 URL 下载到缓存再渲染
   * `file://` —— 下载链路和「保存图片」完全一致（带官方 UA / Referer / token），
   * 所以它能成的事（CDN 拒绝 Image 的 UA、返回奇怪 content-type、URL 被 Fresco 解析失败…）
   * 这里也能成。每个 URL 只尝试一次，成功后进程内复用本地文件。
   */
  localFallback?: boolean;
};

/** 本地兜底缓存（URL → file://；同一张图在列表/大图里只下载一次） */
const localUriCache = new Map<string, string>();
const localInflight = new Map<string, Promise<string>>();
const localFailed = new Set<string>();

function hashUri(uri: string): string {
  let hash = 5381;
  for (let i = 0; i < uri.length; i += 1) hash = ((hash << 5) + hash + uri.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

function extFromUri(uri: string): string {
  const clean = String(uri).split(/[?#]/)[0];
  const m = /\.([a-z0-9]{2,5})$/i.exec(clean);
  return m ? `.${m[1].toLowerCase()}` : '.img';
}

/** 把网络图下到缓存目录（带 48 防盗链头），返回本地 URI */
function fetchToLocal(uri: string): Promise<string> {
  const cached = localUriCache.get(uri);
  if (cached) return Promise.resolve(cached);
  const inflight = localInflight.get(uri);
  if (inflight) return inflight;
  const dir = `${FileSystem.cacheDirectory || ''}img-fallback/`;
  const target = `${dir}${hashUri(uri)}${extFromUri(uri)}`;
  const task = (async () => {
    try {
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => undefined);
      const res = await FileSystem.downloadAsync(uri, target, {
        headers: isPocketImageUrl(uri) ? POCKET_IMAGE_HEADERS : undefined,
      });
      const file = res?.uri || target;
      localUriCache.set(uri, file);
      logInfo(`[img] 已转本地兜底渲染 ${String(uri).slice(0, 120)}`, 'media');
      return file;
    } catch (error) {
      localFailed.add(uri);
      throw error;
    } finally {
      localInflight.delete(uri);
    }
  })();
  localInflight.set(uri, task);
  return task;
}

/**
 * 网络图片封装。
 * - 统一淡入行为与安卓解码淡入时长；作为集中替换与未来升级到更优缓存组件的单一入口；
 * - D4：内置失败回退——`source.48.cn` 移动端偶发被拒时，显示浅灰底 + 可选图标，杜绝空白块/破图；
 *   外部 onError 仍会被调用（原有调用方逻辑不受影响）；
 * - 缩略图**两段式兜底**：先请求 resize 缩略图；若该路径在缩略图端点不可用，
 *   自动退回**原图**再试一次，只有原图也失败才走占位 —— 保证「省流量」绝不牺牲「能看图」；
 * - **本地兜底**（localFallback）：原图仍失败时下载到缓存再渲染（见上）；
 * - 48 图床统一带官方 UA + Referer（防盗链，见 utils/imageHeaders）。
 */
export function NetworkImage({ fadeDuration, fallback = true, fallbackIcon, onError, style, thumbnail, localFallback, ...rest }: NetworkImageProps) {
  const [errored, setErrored] = useState(false);
  /** 缩略图失败过一次 → 本次改用原图 */
  const [useOriginal, setUseOriginal] = useState(false);
  /** 本地兜底文件（下好之后优先用它渲染） */
  const [localUri, setLocalUri] = useState('');
  // uri 变化时重置失败态（FlatList 复用实例时不串台）
  const uri = rest.source && typeof rest.source === 'object' && 'uri' in rest.source ? (rest.source as any).uri : undefined;
  // 缩略图：仅当显式传 thumbnail 且是 48 图床图片时改写 URL（失败/不支持时 thumbUrl 原样返回）
  const thumbUri = thumbnail && uri ? thumbUrl(uri, thumbnail) : '';
  /** 是否真的换成了另一条 URL（原样返回 / gif / 非 48 图床都为 false） */
  const thumbed = !!thumbUri && thumbUri !== uri;
  /** 当前实际请求的 URL（缩略图阶段 or 原图阶段） */
  const activeUri = thumbed && !useOriginal ? thumbUri : uri;
  /** 最终渲染用的地址：本地兜底优先 */
  const renderUri = localUri || activeUri;
  /**
   * ★ 48 图床必须带官方 UA + Referer（防盗链）：不带就是 403/415 ——
   *   同一张图「下载能存、界面空白」的根因（用户 2026-11-02 反馈）。
   */
  const source = uri
    ? {
      ...(rest.source as any),
      uri: renderUri,
      ...(isPocketImageUrl(renderUri) && !localUri ? { headers: POCKET_IMAGE_HEADERS } : null),
    }
    : rest.source;

  const handleError = useCallback(
    (e: any) => {
      // 缩略图失败：先退回原图（不惊动调用方的失败逻辑 —— 这是可恢复的一步）
      if (thumbed && !useOriginal) {
        setUseOriginal(true);
        return;
      }
      // 原图失败 → 本地兜底（下载同一个 URL 再渲染 file://）
      if (
        localFallback
        && activeUri
        && /^https?:/i.test(activeUri)
        && !localUri
        && !localInflight.has(activeUri)
        && !localFailed.has(activeUri)
      ) {
        fetchToLocal(activeUri)
          .then((file) => setLocalUri(file))
          .catch(() => {
            if (onError) onError(e);
            if (fallback) setErrored(true);
          });
        return;
      }
      // 原图也失败：打一条带 URL 的日志（真机 logcat 搜 `[img]`），避免只能靠猜
      logWarn(`[img] 加载失败 ${String(activeUri || '').slice(0, 160)}`, 'media');
      if (onError) onError(e);
      if (fallback) setErrored(true);
    },
    [thumbed, useOriginal, localFallback, activeUri, localUri, fallback, onError],
  );

  useEffect(() => {
    setErrored(false);
    setUseOriginal(false);
    setLocalUri('');
  }, [uri]);

  if (errored) {
    return (
      <View style={[styles.fallbackBox, style as any]}>
        {fallbackIcon ? (
          <MaterialCommunityIcons name={fallbackIcon as any} size={20} color="rgba(128,128,128,0.4)" />
        ) : null}
      </View>
    );
  }
  return (
    <Image
      {...rest}
      source={source}
      style={style}
      fadeDuration={fadeDuration ?? (Platform.OS === 'android' ? 200 : 0)}
      onError={handleError}
    />
  );
}

const styles = StyleSheet.create({
  fallbackBox: {
    backgroundColor: 'rgba(128,128,128,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
  },
});

export default NetworkImage;
