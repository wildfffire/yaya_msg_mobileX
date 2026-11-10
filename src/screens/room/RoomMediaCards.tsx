/**
 * 房间内媒体卡片（从 FollowedRoomsScreen 搬出的展示层 · 收尾第 1 步）。
 *
 * 为什么先搬它们：消息行组件（RoomChatMessageRow）要用这三个卡片，
 * 若只把行组件搬出去，就形成「行组件 → 页面文件」的循环依赖。
 * 先把卡片搬到这里，依赖方向就恢复单向：行组件 → RoomMediaCards → 各纯逻辑层。
 *
 * 本次只搬家：样式取共享 roomStyles，逻辑与取值顺序与原实现逐字一致。
 */
import React, { useEffect, useState } from 'react';
import { Image, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import Video from 'react-native-video';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { NetworkImage } from '../../components/NetworkImage';
import { GlassSurface } from '../../components/GlassSurface';
import { t } from '../../i18n';
import { usePalette } from '../../theme';
import { mediaLabel, type RoomMedia } from './mediaRules';
import { playerSource } from './mediaResolve';
import {
  cachedAudioDuration,
  rememberAudioDuration,
  resolveAudioDurationFromUrl,
} from '../../utils/audioDuration';
import { styles } from './roomStyles';

// 自适应宽高比的视频容器：监听 react-native-video onLoad 取 naturalSize，
// 用真实宽高比驱动容器 aspectRatio，避免硬编码高度把竖屏 9:16 / 横屏 16:9 / 方屏 1:1 视频全部压扁或上下拉黑出现"上下两条"。
// - 默认 16:9，避免第一帧 onLoad 之前视觉塌陷
// - maxHeight 防止异常长方形视频挤爆消息气泡
// - borderRadius / backgroundColor 与 inlineVideo 旧样式一致
//     ExoPlayer 解析的真实 duration（秒）回填角标。探测 Video 不显示画面，不受旋转影响。
export function VideoCoverCard({ media, onPress, onLongPress }: { media: RoomMedia; onPress: () => void; onLongPress: () => void }) {
  const palette = usePalette();
  // 时长角标只读不回填（封面走静态首帧，不再加载探测 Video）
  const [resolvedDur] = useState(media.duration || '');
  const [coverError, setCoverError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const hasCover = !!media.cover && !coverError;
  // 封面（fix7y 回退）：放弃自动播放/方向修正实验，恢复原始静止首帧封面（paused <Video> 首帧 + 灰占位过渡态）。
  // 服务端不回独立封面字段这一事实未变，且 Android ExoPlayer 对带方向元数据的视频在暂停首帧下会镜像——
  // 用户确认「修不好」，故回退到「有画面、静止、不播放」的原始行为，不再尝试修正方向。
  return (
    <TouchableOpacity style={styles.videoCoverWrap as any} onPress={onPress} onLongPress={onLongPress} activeOpacity={0.9}>
      {hasCover ? (
        <Image
          source={{ uri: media.cover }}
          style={styles.videoCoverImg as any}
          resizeMode="cover"
          onError={() => setCoverError(true)}
        />
      ) : (
        <View style={styles.videoCoverImg as any}>
          <Video
            source={playerSource(media.url)}
            style={StyleSheet.absoluteFill}
            paused
            controls={false}
            resizeMode="cover"
            muted
            playWhenInactive={false}
            playInBackground={false}
            onLoad={() => setLoaded(true)}
          />
          {!loaded ? (
            <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.fill2, alignItems: 'center', justifyContent: 'center' }]}>
              <MaterialCommunityIcons name="play-circle-outline" size={40} color={palette.labelTertiary} />
            </View>
          ) : null}
        </View>
      )}
      <View style={styles.videoCoverOverlay}>
        <View style={styles.livePlayCircle}>
          <MaterialCommunityIcons name="play" size={22} color="#FFFFFF" style={{ marginLeft: 3 }} />
        </View>
      </View>
      {resolvedDur ? (
        <View style={styles.videoCoverDuration}>
          <Text style={styles.videoCoverDurationText}>{resolvedDur}s</Text>
        </View>
      ) : null}
    </TouchableOpacity>
  );
}

// 直播/录播封面图：加载失败（source.48.cn 移动端偶发被拒）时回退灰底，避免破图/空白块
export function LiveCoverImage({ uri, palette }: { uri: string; palette: any }) {
  const [err, setErr] = useState(false);
  if (err) {
    return (
      <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.fill2, alignItems: 'center', justifyContent: 'center' }]}>
        <MaterialCommunityIcons name="play-circle-outline" size={34} color={palette.labelTertiary} />
      </View>
    );
  }
  return (
    <NetworkImage
      source={{ uri }}
      style={styles.liveCardImg}
      resizeMode="cover"
      onError={() => setErr(true)}
      thumbnail={700}
    />
  );
}

// 音频消息卡片。消息体里没有 duration 字段（实测只有 msgTime 时间戳），时长只能靠播放器解析。
// 内部用隐藏探测 Video（1px 透明、不可见）拿 ExoPlayer 真实 duration 回填角标，与 VideoCoverCard 同机制。
export function AudioMediaCard({
  media, palette, onPlay, onLongPress, playing,
}: {
  media: RoomMedia; palette: any;
  onPlay: () => void; onLongPress: () => void; playing: boolean;
}) {
  const [resolvedDur, setResolvedDur] = useState(media.duration || cachedAudioDuration(media.url));

  // 卡片会被列表复用（换一条消息但组件没卸载）→ url 变化时必须重取，
  // 否则会显示上一条语音的时长（比「没有时长」更糟）。
  useEffect(() => {
    setResolvedDur(media.duration || cachedAudioDuration(media.url));
  }, [media.url, media.duration]);

  /**
   * 时长解析（确定性路径优先）。
   *
   * 真机日志实证（2026-09-28）：语音载荷里**没有任何时长字段**
   * （`[diag:duration:audio] candidates= {"msgTime":...}`），只能从文件量。
   * 这里先走 `resolveAudioDurationFromUrl`：只取文件头 16 字节，
   * 按 AMR 定长帧（每帧 20ms）算出时长 —— 不下载整个文件、不放音、不占音频焦点。
   * 拿不到（非 AMR 格式/网络失败）就留给下面的隐藏 Video 探针兜底，行为不倒退。
   */
  useEffect(() => {
    if (media.duration || cachedAudioDuration(media.url)) return undefined;
    let alive = true;
    resolveAudioDurationFromUrl(media.url).then((secs) => {
      if (!alive || !(secs > 0)) return;
      const text = String(Math.round(secs));
      rememberAudioDuration(media.url, text);
      setResolvedDur(text);
    });
    return () => {
      alive = false;
    };
  }, [media.url, media.duration]);
  const card = (
    <TouchableOpacity
      // 语音播放卡玻璃化（用户要求，2026-09-19）：任何人（含房主/自己）一律 GlassSurface，
      // 与房间文本气泡同语言；此前「idol/mine 粉实底」分支让房主语音卡与深色气泡割裂，已废
      style={[styles.mediaCard, { backgroundColor: 'transparent', borderWidth: 0, marginTop: 0 }]}
      activeOpacity={0.92}
      onLongPress={onLongPress}
    >
      {media.cover ? (
        <NetworkImage source={{ uri: media.cover }} style={styles.liveCover} resizeMode="cover" thumbnail={700} />
      ) : null}
      <View style={styles.mediaMeta}>
        <Text style={[styles.mediaIcon, { color: palette.tint }]}>{t(mediaLabel(media.type))}</Text>
        {media.type !== 'audio' && media.type !== 'video' && media.title ? (
          <Text style={[styles.mediaTitle, { color: palette.label }]} numberOfLines={2}>{media.title}</Text>
        ) : null}
        {resolvedDur ? <Text style={[styles.mediaDuration, { color: palette.labelSecondary }]}>{resolvedDur}s</Text> : null}
      </View>
      <TouchableOpacity
        style={[styles.mediaPlayBtn, { backgroundColor: palette.tint, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }]}
        onPress={onPlay}
        activeOpacity={0.85}
      >
        <MaterialCommunityIcons
          name={playing ? 'pause' : 'play'}
          size={14}
          color={palette.onTint}
        />
        <Text style={[styles.mediaPlayText, { color: palette.onTint }]}>
          {playing ? t('暂停') : resolvedDur ? `${resolvedDur}s` : t('播放')}
        </Text>
      </TouchableOpacity>
      {/* 隐藏探测 Video：仅用于拿真实时长，不渲染可见画面。
          ⚠️ 必须留在卡片可视范围内（1×1 + opacity 极低）：
          以前藏在 `top:-9999` 的屏幕外，列表裁剪（Android 的 removeClippedSubviews）
          会把它当成不可见区域而**根本不加载** → 表现就是「时长时有时无」（本次修的正是它）。
          探测成功即写入模块级缓存，后续所有卡片立刻带时长，不再依赖探针时序。 */}
      <Video
        source={playerSource(media.url)}
        style={{ width: 1, height: 1, opacity: 0.01, position: 'absolute', top: 0, left: 0 }}
        paused
        controls={false}
        resizeMode="cover"
        muted
        onLoad={(data: any) => {
          const d = Number(data?.duration || 0);
          if (d > 0) {
            const secs = String(Math.round(d));
            rememberAudioDuration(media.url, secs);
            setResolvedDur(secs);
          }
        }}
      />
    </TouchableOpacity>
  );
  return (
    <GlassSurface radius={14} role="card" style={{ marginTop: 8, alignSelf: 'flex-start' }}>
      {card}
    </GlassSurface>
  );
}
