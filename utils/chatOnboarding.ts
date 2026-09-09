/**
 * 聊天页新手引导弹窗的持久化键与判定逻辑。
 *
 * 持久化在 localStorage（跨标签页/重开浏览器不再重复弹窗）。
 * 键名带版本号：弹窗内容更新时将 v1 → v2 即可重新引导，
 * 各版本只看自己的键，旧键不迁移、不读取。
 */
export const CHAT_ONBOARDING_SEEN_KEY = 'chat_onboarding_seen_v1';

/**
 * 判断是否应展示引导弹窗。
 * @param storage 存储实现（生产传入 getSafeLocalStorage()，测试传入 stub）
 * @returns 无 v1 键时返回 true（应弹窗）
 */
export function shouldShowOnboarding(storage: Pick<Storage, 'getItem'>): boolean {
    return storage.getItem(CHAT_ONBOARDING_SEEN_KEY) === null;
}

/**
 * 确认引导后写入 v1 已读标记。
 * @param storage 存储实现（生产传入 getSafeLocalStorage()，测试传入 stub）
 */
export function markOnboardingSeen(storage: Pick<Storage, 'setItem'>): void {
    storage.setItem(CHAT_ONBOARDING_SEEN_KEY, 'true');
}
