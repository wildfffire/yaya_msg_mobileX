/**
 * 一条房间消息的整行（从 FollowedRoomsScreen 搬出的展示层 · 收尾第 2 步）。
 *
 * 与原实现逐字一致（含气泡染色常量、props 类型与那两条 memo 纪律注释）；
 * 只把「取样式」改为共享 roomStyles、三个媒体卡片改为从 RoomMediaCards 引入。
 */
import React from 'react';
import { Linking, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import MaterialCommunityIcons from 'react-native-vector-icons/MaterialCommunityIcons';
import { GlassSurface } from '../../components/GlassSurface';
import { NetworkImage } from '../../components/NetworkImage';
import { useI18n } from '../../i18n';
import { useSettingsStore } from '../../store';
import { usePalette } from '../../theme';
import type { Member } from '../../types';
import { formatTimestamp } from '../../utils/format';
import { AVATAR_THUMB_WIDTH } from '../../utils/imageThumb';
import { messagePayload, messageText } from '../../utils/data';
import { replaceEmojiText } from '../../utils/emoji';
import { extraInfo, isIdolMessage, messageRole, senderProfile, shortName } from './messageRules';
// 翻牌问答解析（用户 2026-09-30：房间里的翻牌显示不出来）—— 兼容多种字段写法与对象/JSON 形态
import { flipCardTexts } from '../../utils/flipCard';
// 引用（回复）消息的读回规则：嵌套（body/ext 的 replyInfo）+ 官方扁平口径（extInfo.messageType=REPLY）
// resolveRoomReply = 服务端数据优先 + 本机发出的兜底（自己刚发的引用必须立刻有卡）
import { replyBodyText, resolveRoomReply, type RoomReplyTarget } from '../../utils/roomReply';
import { roomGiftInfo, roomMedia, roomRedPacketInfo } from './mediaResolve';
import { avatarInitial } from './roomIdentity';
import { mediaLabel, type RoomMedia } from './mediaRules';
import { AudioMediaCard, LiveCoverImage, VideoCoverCard } from './RoomMediaCards';
import { styles } from './roomStyles';

/**
 * 一条房间消息的整行（头像 + 名字/时间 + 玻璃气泡 + 回复卡 + 礼物卡 + 媒体卡）。
 *
 * 为什么抽成组件（而不是留在主组件的 useCallback 里）：
 *   主组件状态极多，任何一次状态变化都会让列表的 renderItem 重新执行 → **整屏消息全部重画**。
 *   抽成 React.memo 后，只有 props 真的变了的行才重渲染。
 *
 * ⚠️ memo 生效的前提（改动这个组件时务必守住）：
 *   ① props 只传「值」或「稳定引用」—— 所以这里收的是 playingUrl / roomPlayerUrl 两个**字符串**，
 *      而不是 playingMedia / roomPlayer 两个对象（对象每次渲染都是新引用，memo 必失效）；
 *   ② 语言与主题由组件自己订阅（useI18n / usePalette），不走 props；
 *   ③ 回调必须稳定 —— 主组件那边用 chatRowProps 一次性 useMemo 打包。
 *
 * 本次只搬家：所有显示分支、样式 key、取值顺序都与原实现逐字一致。
 */
type RoomChatMessageRowProps = {
  /** 服务端原始消息对象（字段未归一，解析都在这行内部完成） */
  item: any;
  /** 是否「组首」：只有组首显示头像、发送者名字与时间（同一发送者的连排消息只显示一次） */
  groupStart: boolean;
  /** 当前房间（房主档案来源），与主组件里的 selectedRoom 同一语义 */
  room: Member;
  /** 「只看偶像」开关：影响角色判定 */
  showFanMessages: boolean;
  /** 我的身份 id（口袋数字 userId / 云信 accid，任一命中即「我发的」） */
  selfIds: string | string[];
  /** 我的昵称 key（normMemberName 归一化）：消息无发送者 id 时的兜底判定 */
  selfNameKeys?: Set<string>;
  /** 我自己的头像 URL（用户 2026-10-02：自己发言也要显示我的头像） */
  selfAvatar?: string;
  /** 房主/小房间的 id 集合（判定「偶像发的」） */
  memberIdSet: Set<string>;
  /** 成员库索引（O(1) 查发送者是否成员） */
  memberIndex: Map<string, any>;
  /** 正在播放的媒体 url（空串表示没有） */
  playingUrl: string;
  /** 房间内播放器当前 url（视频卡自己正在播放时要把卡片藏起来） */
  roomPlayerUrl: string;
  /** 时间胶囊的前景/背景色（房间底图花/亮时需要遮罩） */
  timeMaskFg: string;
  timeMaskBg: string;
  onOpenSenderProfile: (p: { id: string; name: string; avatar: string; member: Member | null; userIds: string[] }) => void;
  onDeleteMessage: (item: any) => void;
  /** 长按**别人的**消息 → 进入引用（回复）态（用户 2026-10-14） */
  onReplyMessage: (target: RoomReplyTarget) => void;
  onPlayMedia: (media: RoomMedia) => void;
  onDownloadMedia: (media: RoomMedia) => void;
  onOpenImage: (url: string) => void;
};

/** 自己气泡：随主题色走的中浓度染色（palette.tintMedium，见 theme/colors.ts） */
/** 别人气泡：去掉材质自带的厚白纱，只留极淡一层维持文字对比度 */
const OTHER_BUBBLE_TINT_LIGHT = 'rgba(255,255,255,0.10)';
const OTHER_BUBBLE_TINT_DARK = 'rgba(255,255,255,0.06)';
/**
 * 引用卡配色（用户 2026-10-14：「引用的遮罩不够颜色，加一层白底」）。
 *
 * 老配色按「自己/别人/偶像」分三套，自己的那套是**白字 + 18% 白底**——
 * 压在毛玻璃粉气泡上几乎读不出来（引用看起来像没显示）。
 * 现在统一成一层**白底 + 深色文字**（浅色主题）/ 低透明白底 + 浅色文字（深色主题），
 * 与自己、别人、偶像三种气泡的对比关系都成立，观感也和「正常的消息」一致。
 */
const QUOTE_BG_LIGHT = 'rgba(255,255,255,0.92)';
const QUOTE_BG_DARK = 'rgba(255,255,255,0.16)';
const QUOTE_TEXT_LIGHT = '#2C2C31';
const QUOTE_TEXT_DARK = 'rgba(255,255,255,0.90)';

export const RoomChatMessageRow = React.memo(function RoomChatMessageRow({
  item,
  groupStart,
  room,
  showFanMessages,
  selfIds,
  selfNameKeys,
  selfAvatar,
  memberIdSet,
  memberIndex,
  playingUrl,
  roomPlayerUrl,
  timeMaskFg,
  timeMaskBg,
  onOpenSenderProfile,
  onDeleteMessage,
  onReplyMessage,
  onPlayMedia,
  onDownloadMedia,
  onOpenImage,
}: RoomChatMessageRowProps) {
  const { t } = useI18n();
  const palette = usePalette();
  /**
   * 成员发言头像来源（设置页「房间 → 消息头像」可切，用户 2026-11-08）：
   * - `custom`（默认）：优先消息 API 携带的「偶像自己设置的头像」，取不到才回退公式照
   * - `official`：优先成员库里的系统公式照，取不到才回退自选头像
   * ⚠️ 必须放在下面 `if (!item) return` 之前：hook 不能条件调用。
   */
  const avatarSource = useSettingsStore((s) => s.settings.room_avatar_source || 'custom');
  // 气泡染色（毛玻璃）：主题取值放在这里，避免在 JSX 里写三元嵌套
  const isDarkBubble = palette.name === 'dark';
  const mineBubbleTint = palette.tintMedium;
  const otherBubbleTint = isDarkBubble ? OTHER_BUBBLE_TINT_DARK : OTHER_BUBBLE_TINT_LIGHT;
  // 引用卡：一层白底 + 对应主题的可读文字色（见上方 QUOTE_* 常量注释）
  const quoteBg = isDarkBubble ? QUOTE_BG_DARK : QUOTE_BG_LIGHT;
  const quoteTextColor = isDarkBubble ? QUOTE_TEXT_DARK : QUOTE_TEXT_LIGHT;
  // 最后一道防线：服务端偶发脏数据（undefined/null 元素）直接渲染空行，不崩
  if (!item) return <View />;
  const role = messageRole(item, room, showFanMessages, selfIds, memberIdSet, selfNameKeys);
  const mine = role === 'mine';
  const idol = role === 'idol';
  const msgProfile = senderProfile(item, room);
  // 发送者是否是「本房房主」：皇冠（房主标）只给房主（用户要求：别的成员不带皇冠）
  const isRoomOwner = isIdolMessage(item, room, showFanMessages);
  // 发送者若是「成员库里的成员」（**不一定是房主**），就用他自己的档案 + 他自己的队伍标签。
  // 此前非房主成员在别人房间发言，被 isIdolMessage 直接判成 fan
  //（只要 profile.id 存在且 ≠ 房主就 return false）→ 没名字/没头像/没队标。
  // ⚠️ senderMember 必须优先于「房主房间档案」：否则其他成员发言会套用房主的名字/头像。
  const senderId = String(msgProfile.id || '').trim();
  // O(1) 查表（原为 members.find 全库线性扫描，见 buildMemberIndex 注释）
  const senderMember = senderId ? (memberIndex.get(senderId) as Member | undefined) : undefined;
  const isMemberSender = !!senderMember
    // 兜底（桌面端语义 followed-chat-feature.js:4087）：ext.user.roleId > 1 即成员
    || (Number((extraInfo(item) as any)?.user?.roleId ?? 0) || 0) > 1;
  /** 当前消息的公式照来源（成员库 / 房主档案）；非成员（粉丝）没有公式照 */
  const officialAvatar = String((senderMember ? senderMember.avatar : isRoomOwner ? room.avatar : '') || '').trim();
  const chosenAvatar = String(msgProfile.avatar || '').trim();
  const pickedAvatar = avatarSource === 'official'
    ? (officialAvatar || chosenAvatar)
    : (chosenAvatar || officialAvatar);
  // 成员发言头像：按上面的来源设置取，另一张兜底
  const profile = senderMember
    ? { id: senderMember.id, name: (msgProfile.name || '').trim() || senderMember.ownerName, avatar: pickedAvatar }
    : (isRoomOwner
      ? { id: room.id, name: (msgProfile.name || '').trim() || shortName(room), avatar: pickedAvatar }
      : msgProfile);
  // 队伍标签：其他成员用他自己的档案，房主用房间档案（用户要求：放每条消息名字后面）
  const tagSource: any = senderMember || (isRoomOwner ? room : undefined);
  const teamName = String(tagSource?.team || '').trim();
  // 用户要求：队标「分团区分去掉」—— 只显示队伍（Team X），不再拼团名前缀
  const teamText = teamName || '';
  const teamLogo = String(tagSource?.teamLogo || '').trim();
  const media = roomMedia(item);
  const gift = roomGiftInfo(item);
  // 红包消息卡（用户 2026-11-09）：与礼物卡并列的一条独立支路
  const redPacket = roomRedPacketInfo(item);
  const payload = messagePayload(item) as any;
  /**
   * 引用（回复）信息：统一走 `utils/roomReply.roomReplyInfo`（用户 2026-10-14 加入引用功能）。
   *
   * 老实现只读 `payload.replyInfo / payload.giftReplyInfo`（= bodys 里的），
   * 而**官方 App 发出的引用消息把 replyName / replyText 放在 extInfo 上**
   * （历史消息口径：extInfo.messageType === 'REPLY'）→ 别人的引用在这边看不到引用卡。
   * 现在嵌套（body/ext 的 replyInfo）与扁平（extInfo.replyName/replyText）两种都认。
   */
  const reply = resolveRoomReply(item);
  const replyName = reply?.name || '';
  /**
   * ⚠️ 引用卡里「被回复的原文」、礼物回复文案、翻牌答案都**必须**过一遍表情替换。
   *
   * 用户反馈（2026-09-29）：「房间里还是有表情识别不出来，只显示 [示爱]」。
   * 根因就在这里 —— 气泡正文走 `messageText()`（内部会 replaceEmojiText），
   * 但同一份数据在这三条支路里是**自己拼出来的字符串**，直接进 <Text>：
   *   ① `replyInfo.replyText`（被回复的消息原文，成员常带表情）
   *   ② 礼物回复 `giftReplyInfo.text / payload.text / payload.body`
   *   ③ 翻牌答案 `answerContent`（**优先级高于正文**，成员翻牌里表情最多）
   * 于是同一条 `[示爱]` 在正文里显示成 💗、在引用卡/翻牌里却是一串代码。
   * 替换是幂等的（emoji 不再含方括号），重复调用无副作用。
   */
  /**
   * 翻牌问答（用户 2026-09-30：房间里的翻牌消息显示不出来）。
   *
   * 解析统一收口到 `utils/flipCard.ts` —— 兼容 flipCardInfo / filpCardInfo（官方历史上就
   * 把 flip 拼成了 filp）、语音与视频翻牌、以及 `answer` 是「对象 / JSON 字符串」的形态。
   * 老实现用 `pickText` 取 `answer`，对对象会 `String(obj)` → 气泡里真的显示 `[object Object]`
   *（同一 bug 的另一半），这里一并修掉。
   */
  const flip = flipCardTexts(item);
  // ⚠️ 写成「先取值再赋值替换」两行（而不是三元里调用）：
  // scripts/emoji-text.test.mjs 有静态收口断言 `flipAnswer = replaceEmojiText(`，
  // 那是防「新增渲染支路漏替换」的钉子，别为了少一行把它绕过去。
  let flipQuestion = flip.question || '';
  flipQuestion = replaceEmojiText(flipQuestion);
  let flipAnswer = flip.answer || '';
  flipAnswer = replaceEmojiText(flipAnswer);
  /**
   * 引用卡里的原文：优先 `replyInfo.replyText`（回复 / 礼物回复），
   * 没有时退到**翻牌提问** —— 翻牌就是「引用提问 + 气泡回答」，与官方形态一致。
   */
  const replyQuoted = replaceEmojiText(String(reply?.text || '')) || flipQuestion;
  /**
   * 正文：引用消息只显示**自身正文**。
   * `messageText()` 对 REPLY 类型会拼出 `回复 名字：正文` 前缀，而引用卡（上面 replyQuoted）
   * 已经显示了名字与原文 → 气泡里再带一遍前缀就是同一信息显示两遍（见 roomReply.replyBodyText）。
   */
  let body = messageText(item);
  if (reply) {
    const own = replaceEmojiText(replyBodyText(item));
    if (own) body = own;
  }
  let giftReplyText = '';
  if (gift) {
    const gr = payload?.giftReplyInfo || {};
    giftReplyText = gr.text || payload.text || payload.body || gr.replyName || gr.replyText || '';
    if (typeof giftReplyText === 'string') giftReplyText = replaceEmojiText(giftReplyText.trim());
    else giftReplyText = '';
  }
  const baseText = flipAnswer || body;
  const isMediaLabel = /^\[(语音|图片|视频|链接|直播)\]/.test(baseText);
  const looksLikeFile = !media && /^https?:\/\//i.test(String(baseText || '')) || /\.(amr|mp3|m4a|aac|mp4|mov|jpg|jpeg|png|gif|webp)(\?|$)/i.test(String(baseText || ''));
  // 红包卡片自带文案：正文不再重复一遍 jsonType/bless（否则卡片下面拖一串 JSON）
  const bubbleText = gift
    ? giftReplyText
    : redPacket
      ? ''
      : (media ? (!isMediaLabel ? baseText : '') : (looksLikeFile ? '' : baseText));
  // 点头像能打开什么：成员（房主 / 成员库里的其他成员）→ 资料卡（带成员信息）；否则按发送者 id 试用户资料
  const avatarMember: Member | null = senderMember || (isRoomOwner ? room : null);
  // 消息 ext.user.userId = 发送者的口袋 userId（官方 getChannelBaseParams 结构）→ 查资料最靠谱的 id
  const extUser: any = (extraInfo(item) as any)?.user || {};
  const extUserId = String(extUser?.userId ?? extUser?.user_id ?? extUser?.id ?? '').trim();
  const canOpenProfile = !!avatarMember || !!senderId || !!extUserId;
  /**
   * 长按行为（用户 2026-10-14）：
   *   自己的消息 → 撤回删除（老行为不变）；**别人的消息 → 进入引用（回复）态**。
   * 引用卡里的原文优先用气泡正文；纯媒体/礼物消息正文为空时退到「语音 / 图片 / 礼物：xxx」，
   * 避免引用卡是一片空白。
   */
  const quoteText = bubbleText
    || (redPacket ? `${t('红包')}：${redPacket.bless}` : '')
    || (media ? t(mediaLabel(media.type)) : '')
    || (gift ? `${t('礼物')}：${gift.name}` : '');
  const quoteMsgId = String(item?.msgIdClient || item?.uuid || item?.msgId || '');
  const onLongPressMessage = mine
    ? () => onDeleteMessage(item)
    : () => onReplyMessage({
        name: profile.name,
        text: quoteText,
        msgId: quoteMsgId,
        userId: senderId || extUserId,
      });

  return (
    <View style={[styles.chatRow, mine && styles.chatRowMine, !groupStart && styles.chatRowTight]}>
      {!mine ? (
        groupStart ? (
          /* 点头像 → 加载对方个人资料：成员进「成员档案」，非成员弹「用户资料卡」 */
          <TouchableOpacity
            activeOpacity={0.8}
            disabled={!canOpenProfile}
            onPress={() => onOpenSenderProfile({ id: senderId, name: profile.name, avatar: profile.avatar, member: avatarMember, userIds: [extUserId] })}
          >
            {profile.avatar ? (
              /* 头像走 NetworkImage（而非裸 Image）：缩略图服务失败会自动退回原图，
                 再失败给占位 —— 修「群聊里不显示头像」（裸 Image 一旦缩略图 404 就是空白）。 */
              <NetworkImage
                source={{ uri: profile.avatar }}
                style={styles.avatar}
                resizeMode="cover"
                thumbnail={AVATAR_THUMB_WIDTH}
              />
            ) : (
              <View style={[styles.avatarFallback, { backgroundColor: palette.fill2 }]}><Text style={[styles.avatarText, { color: palette.tint }]}>{avatarInitial(profile.name)}</Text></View>
            )}
          </TouchableOpacity>
        ) : (
          /* 组内连排：占位保持气泡左对齐 */
          <View style={styles.avatarPlaceholder} />
        )
      ) : null}
      <View style={[styles.msgBlock, mine && styles.msgBlockMine]}>
        {/* 组首显示名字 + HH:mm；组内不重复 */}
        {groupStart ? (
          <View style={[styles.msgMetaLine, mine && styles.msgMetaLineMine]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              {/* 皇冠 = 房主标：只给本房房主（用户要求：别的成员不带皇冠） */}
              {isRoomOwner ? <MaterialCommunityIcons name="crown" size={11} color={palette.tint} /> : null}
              <Text style={[styles.msgSender, { color: (isRoomOwner || isMemberSender) ? palette.tint : mine ? palette.tint : palette.labelSecondary }]} numberOfLines={1}>
                {profile.name}
              </Text>
              {/* 队伍标签：紧跟发送者名字（成员消息，**含其他成员在别人房间发言**）；有官方队标显示图，否则文字 */}
              {(isRoomOwner || isMemberSender) && (teamText || teamLogo) ? (
                <View style={[styles.msgTeamChip, { backgroundColor: palette.tintSoft }]}>
                  {teamLogo ? <NetworkImage source={{ uri: teamLogo }} style={styles.msgTeamLogo} resizeMode="contain" thumbnail={120} /> : null}
                  {teamText ? <Text style={[styles.msgTeamText, { color: palette.tint }]} numberOfLines={1}>{teamText}</Text> : null}
                </View>
              ) : null}
            </View>
            {/* 时间加遮罩：房间底图花/亮时「HH:mm」会糊掉。浅色主题用更轻的 timeMask（见上） */}
            <Text style={[styles.msgTime, styles.labelMaskPill, { color: timeMaskFg, backgroundColor: timeMaskBg }]}>
              {formatTimestamp(item.msgTime).slice(11, 16)}
            </Text>
          </View>
        ) : null}
        {/* 气泡 = 玻璃（内容进玻璃）。「自己」用 tint 染色玻璃（实心强调），
            主播/他人走默认白深纱玻璃 —— 与底栏同一套材质 */}
        <GlassSurface
          role="chip"
          radius={18}
          /* 消息气泡毛玻璃（用户 2026-11-09：「我说的是消息区的**消息**的毛玻璃」）：
             气泡本身走 frost 材质（intensity 60 / 纱层 0.18），压住房间背景图上的文字；
             底色仍由下面的 mineBubbleTint / otherBubbleTint 决定，不改变原有配色。 */
          frost
          onLongPress={onLongPressMessage}
          /* 用户要求（2026-09-28）：
             ① 自己的气泡改成「毛玻璃粉」：原先传的是**实心** tint（palette.tint），
                等于把玻璃材质整块盖掉，所以显得丑、且与被遮挡的模糊层边缘对不齐。
                现在传半透明粉，模糊与描边都透出来，与别人的气泡是同一套材质。
             ② 别人的气泡「去掉那层白纱」：原先不传 tintColor，用的是材质自带的厚叠加色
                （浅色约 40% 白），它会和下面的模糊层形成两块底色、边缘看着错位。
                现在只留极淡一层，保证文字对比度的同时不再有第二块底色。 */
          tintColor={mine ? mineBubbleTint : otherBubbleTint}
          /* 关掉顶部高光带：小气泡上它就是一条覆盖顶部 42% 的白色渐变，
             看起来像「一块对不齐的白边」（用户 2026-09-28 反馈）。 */
          noHighlight
          /* borderWidth: 0 → 关掉材质自带的 1px 白描边（浅色 rgba(255,255,255,0.66)）。
             同样是为了消掉那条「对不齐的白色边框」：气泡本来就压在底图上，
             白边在花哨背景上既跳又显脏。 */
          style={[styles.msgBubble, { borderWidth: 0 }]}
        >
          {replyName || replyQuoted ? (
            /* 引用卡：白底 + 深色文字（见 QUOTE_* 常量），再压一条品牌粉左边线作强调 */
            <View style={[styles.replyCard, { backgroundColor: quoteBg, borderLeftColor: palette.tint }]}>
              {replyName ? <Text style={[styles.replyName, { color: palette.tint }]} numberOfLines={1}>{replyName}</Text> : null}
              {replyQuoted ? <Text style={[styles.replyText, { color: quoteTextColor }]} numberOfLines={3}>{replyQuoted}</Text> : null}
            </View>
          ) : null}
          {bubbleText ? (
            <Text style={[styles.msgBody, (mine || idol) && styles.msgBodyHighlight, { color: mine ? palette.onTint : idol ? palette.label : palette.labelSecondary }]}>
              {bubbleText}
            </Text>
          ) : null}
          {redPacket ? (
            /* 红包卡（用户 2026-11-09）：粉红描边 + 封面图 + 祝福语 + 「发送人 · 成员」 */
            <View style={styles.redPacketCard}>
              {redPacket.image ? (
                <NetworkImage source={{ uri: redPacket.image }} style={styles.redPacketImage} thumbnail={180} />
              ) : (
                <View style={[styles.redPacketImage, styles.redPacketImageFallback]}>
                  <MaterialCommunityIcons name="gift-open-outline" size={18} color="#fff" />
                </View>
              )}
              <View style={styles.redPacketBody}>
                <Text style={styles.redPacketTitle} numberOfLines={2}>{redPacket.bless}</Text>
                <Text style={styles.redPacketMeta} numberOfLines={1}>
                  {[redPacket.creator, redPacket.star].filter(Boolean).join(' · ') || t('红包')}
                </Text>
              </View>
            </View>
          ) : null}
          {gift && !giftReplyText ? (
            <View style={[styles.giftCard, { backgroundColor: palette.fill2, borderColor: palette.tintSoft }, giftReplyText ? styles.giftCardCompact : null]}>
              {!giftReplyText ? (gift.image ? <NetworkImage source={{ uri: gift.image }} style={[styles.giftImage, { backgroundColor: palette.surfaceGlassStrong }]} thumbnail={180} /> : <View style={[styles.giftImageFallback, { backgroundColor: palette.tint }]}><MaterialCommunityIcons name="gift" size={16} color={palette.onTint} /></View>) : null}
              <View style={styles.giftTextWrap}>
                <Text style={[styles.giftName, { color: palette.label }]} numberOfLines={1}>{isRoomOwner ? t('感谢礼物') : t('送出礼物')}：{gift.name}</Text>
                <Text style={[styles.giftMeta, { color: palette.labelSecondary }]}>{t('数量')} x{gift.num}{gift.total ? ` · ${gift.total}` : ''}</Text>
              </View>
            </View>
          ) : null}
          {media ? (
            media.type === 'image' && media.url ? (
            <>
              <TouchableOpacity onPress={() => onOpenImage(media.url)} onLongPress={() => onDownloadMedia(media)} activeOpacity={0.9}>
                {/* ⚠️ 房间图片消息走缩略图：原图动辄 1-3MB/张（1080-3000px），显示仅 228dp。
                    缩略图失败自动退回原图（NetworkImage 两段兜底）；点开大图仍是原图。 */}
                <NetworkImage
                  source={{ uri: media.url }}
                  style={media.title === t('表情') ? styles.inlineSticker : styles.inlineImage}
                  resizeMode="cover"
                  thumbnail={media.title === t('表情') ? 400 : 700}
                  /* 有的图缩略图 + 原图都会被 Image 拒（能保存不能显示）→ 下载到本地再渲染 */
                  localFallback
                />
              </TouchableOpacity>
            </>
          ) : media.type === 'live' && media.cover ? (
            <TouchableOpacity style={styles.liveCardWrap} onPress={() => onPlayMedia(media)} onLongPress={() => onDownloadMedia(media)} activeOpacity={0.9}>
              <LiveCoverImage uri={media.cover} palette={palette} />
              <View style={styles.liveCardOverlay}>
                <View style={styles.livePlayCircle}>
                  <MaterialCommunityIcons name="play" size={22} color="#FFFFFF" style={{ marginLeft: 3 }} />
                </View>
              </View>
              <View style={styles.liveCardTitleBar}>
                <Text style={styles.liveCardTitle} numberOfLines={1}>{media.title}</Text>
              </View>
            </TouchableOpacity>
          ) : media.type === 'video' && media.url ? (
            (roomPlayerUrl === media.url || playingUrl === media.url) ? null : (
              <VideoCoverCard media={media} onPress={() => onPlayMedia(media)} onLongPress={() => onDownloadMedia(media)} />
            )
          ) : media.type === 'audio' ? (
            // 音频播放时不返回 null（否则整张卡片塌缩成小方块）：AudioMediaCard 自带播放中态（暂停按钮）。
            // 隐藏探测 Video 在 AudioMediaCard 内部，无需外部 inlineAudio 撑高。
            <AudioMediaCard
              media={media}
              palette={palette}
              playing={!!(playingUrl && media.url && playingUrl === media.url)}
              onPlay={() => onPlayMedia(media)}
              onLongPress={() => onDownloadMedia(media)}
            />
          ) : (
            <TouchableOpacity style={[styles.mediaCard, { backgroundColor: (idol || mine) ? palette.tint : palette.surfaceGlass, borderColor: (idol || mine) ? 'rgba(255,255,255,0.38)' : palette.innerStroke, borderWidth: StyleSheet.hairlineWidth }]} activeOpacity={0.92} onLongPress={() => onDownloadMedia(media)}>
              {media.cover ? (
                <NetworkImage source={{ uri: media.cover }} style={styles.liveCover} resizeMode="cover" thumbnail={700} />
              ) : null}
              <View style={styles.mediaMeta}>
                <Text style={[styles.mediaIcon, (idol || mine) ? { color: palette.onTint } : { color: palette.tint }]}>{t(mediaLabel(media.type))}</Text>
                {media.type !== 'video' && media.title ? (
                  <Text style={[styles.mediaTitle, (idol || mine) ? { color: palette.onTint } : { color: palette.label }]} numberOfLines={2}>{media.title}</Text>
                ) : null}
                {media.duration ? <Text style={[styles.mediaDuration, (idol || mine) ? { color: palette.onTint } : { color: palette.labelSecondary }]}>{media.duration}s</Text> : null}
              </View>
              <TouchableOpacity
                style={[styles.mediaPlayBtn, { backgroundColor: palette.tint, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 }]}
                onPress={() => onPlayMedia(media)}
                activeOpacity={0.85}
              >
                <MaterialCommunityIcons
                  name={playingUrl && media.url && playingUrl === media.url ? 'pause' : 'play'}
                  size={14}
                  color={palette.onTint}
                />
                <Text style={[styles.mediaPlayText, { color: palette.onTint }]}>
                  {playingUrl && media.url && playingUrl === media.url ? t('暂停') : media.duration ? `${media.duration}s` : t('播放')}
                </Text>
              </TouchableOpacity>
            </TouchableOpacity>
          )) : (!bubbleText && !gift) ? (
            <Text style={[styles.msgBody, (idol || mine) && styles.msgBodyHighlight, (idol || mine) ? { color: palette.onTint } : { color: palette.labelSecondary }]}>{t('[空消息]')}</Text>
          ) : null}
          {media?.url && playingUrl === media.url && media.type === 'link' ? (
            <TouchableOpacity style={styles.openLinkBtn} onPress={() => Linking.openURL(media.url).catch(() => {})} activeOpacity={0.85}>
              <Text style={[styles.openLinkText, { color: palette.tint }]} numberOfLines={1}>{media.url}</Text>
            </TouchableOpacity>
          ) : null}
        </GlassSurface>
      </View>
      {/* 自己发言的头像（用户 2026-10-02：大小房间都要显示我的头像）：贴在气泡右侧，
          与别人的左侧头像对称；没有头像 URL 时用昵称首字占位 */}
      {mine && groupStart ? (
        <View style={styles.avatarMineWrap}>
          {selfAvatar ? (
            <NetworkImage
              source={{ uri: selfAvatar }}
              style={[styles.avatar, styles.avatarMineImg]}
              resizeMode="cover"
              thumbnail={AVATAR_THUMB_WIDTH}
            />
          ) : (
            <View style={[styles.avatarFallback, styles.avatarMineImg, { backgroundColor: palette.fill2 }]}>
              <Text style={[styles.avatarText, { color: palette.tint }]}>{avatarInitial(profile.name)}</Text>
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
});
