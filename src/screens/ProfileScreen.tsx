/**
 * 成员档案页。
 *
 * 档案内容的**加载与渲染**已收口到 components/MemberArchiveView（唯一实现）——
 * 房间消息头像的资料卡里也内嵌同一份内容（用户 2026-10-02：点偶像头像后就地看到档案，
 * 不再需要跳到另一个页面）。本页只负责：成员选择器 + 头部（头像/名字/队伍）+ 整页滚动。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useRoute } from '@react-navigation/native';
import { View, Text, StyleSheet, ScrollView, Image } from 'react-native';
import { FadeInView } from '../components/Motion';
import ScreenHeader from '../components/ScreenHeader';
import { EmptyState } from '../components/StateViews';
import { Member } from '../types';
import MemberPicker from '../components/MemberPicker';
import { useI18n } from '../i18n';
import { usePalette } from '../theme';
import { useMemberStore } from '../store';
import {
  MemberArchiveContent,
  displayMemberName,
  firstText,
  memberArchiveStarInfo,
  useMemberArchive,
} from '../components/MemberArchiveView';

export default function ProfileScreen() {
  const palette = usePalette();
  const { t } = useI18n();
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);

  /**
   * 从房间/消息点头像进来：路由带 memberId（或 member 对象）→ 直接选中该成员，
   * 不需要用户再在 MemberPicker 里搜一遍。
   */
  const route = useRoute<any>();
  const members = useMemberStore((s) => s.members);
  const autoLoadedRef = useRef('');
  const routeParams = route?.params || {};
  const routeMemberId = String(routeParams.memberId || routeParams.member?.id || '').trim();
  const routeNonce = Number(routeParams.nonce) || 0;
  useEffect(() => {
    if (!routeMemberId) return;
    const key = `${routeMemberId}:${routeNonce}`;
    if (autoLoadedRef.current === key) return; // 同一参数只自动选中一次（避免每次重渲染覆盖用户的手动选择）
    autoLoadedRef.current = key;
    const found = (members as any[]).find((m) =>
      [m?.id, m?.userId, m?.memberId].some((v) => String(v ?? '').trim() === routeMemberId),
    );
    // 成员库还没加载完时用路由带来的对象兜底；都没有就用最小对象（档案接口只需要 id）
    setSelectedMember((found || routeParams.member || {
      id: routeMemberId,
      ownerName: String(routeParams.memberName || routeMemberId),
      avatar: String(routeParams.memberAvatar || ''),
    }) as Member);
  }, [routeMemberId, routeNonce, members]);

  // 档案数据：与房间资料卡同一份加载口径（切成员自动重载，带竞态防护）
  const { data, history, error, loading, reload } = useMemberArchive(selectedMember?.id);

  const starInfo = memberArchiveStarInfo(data);
  const avatar = firstText(starInfo?.starAvatar, starInfo?.avatar, selectedMember?.avatar);
  const name = displayMemberName(selectedMember, starInfo);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      <ScreenHeader title={t('成员档案')} />

      <FadeInView delay={80} duration={300}>
        <View style={styles.pickerWrap}>
          <MemberPicker selectedMember={selectedMember} onSelect={setSelectedMember} placeholder={t('搜索成员查看档案...')} />
        </View>

        {selectedMember ? (
          <MemberArchiveContent
            member={selectedMember}
            data={data}
            error={error}
            history={history}
            loading={loading}
            onRetry={reload}
            header={(
              <View style={styles.profileHead}>
                {avatar !== '-' ? (
                  <Image source={{ uri: avatar }} style={[styles.avatar, { backgroundColor: palette.fill2 }]} />
                ) : (
                  <View style={[styles.avatarFallback, { backgroundColor: palette.tintSoft }]} />
                )}
                <View style={styles.profileTitleWrap}>
                  <Text style={[styles.name, { color: palette.label }]} numberOfLines={1}>{name}</Text>
                  <Text style={[styles.subLine, { color: palette.labelSecondary }]} numberOfLines={1}>
                    {firstText(selectedMember.groupName)} · {firstText(selectedMember.team)}
                  </Text>
                </View>
              </View>
            )}
          />
        ) : (
          <View style={styles.emptyCard}>
            <EmptyState icon="account-search-outline" title={t('暂无数据')} hint={t('搜索成员查看档案')} />
          </View>
        )}
      </FadeInView>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: 'transparent' },
  content: { paddingBottom: 36 },
  pickerWrap: { paddingHorizontal: 16, marginBottom: 10 },
  emptyCard: { marginHorizontal: 16, marginVertical: 4, borderRadius: 20 },
  profileHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  avatar: { width: 68, height: 68, borderRadius: 36 },
  avatarFallback: { width: 68, height: 68, borderRadius: 36, alignItems: 'center', justifyContent: 'center' },
  profileTitleWrap: { flex: 1, marginLeft: 14 },
  name: { fontSize: 22, fontWeight: '800' },
  subLine: { marginTop: 5, fontSize: 13 },
});
