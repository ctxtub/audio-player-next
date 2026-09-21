# 作品集切曲与跨 Tab 播放连续性计划

状态：已实施；静态门与生产构建通过，浏览器旅程因 runner 的 clean-tree 门禁待提交后复验

## 目标

- 作品集详情内切换作品时，任一时刻只允许最新目标显示“准备语音”。
- 快速连续切换采用 latest-wins；旧请求不得起播或覆盖新目标的按钮状态。
- 离开当前 Work 前先真实暂停旧音频，避免旧声轨在新作品准备期间继续播放。
- 主导航 Tab 切换不得重新水合已有内存播放会话，不得把 Transport 标成暂停而让物理音频继续播放。

## 方案

1. 作品集详情为播放请求增加单调请求代；允许准备期间切到另一作品，仅最新请求可以清理本地 preparing 状态。
2. 卡片 preparing 映射以最新目标优先；存在不同目标时，旧 current Work 不消费全局 hydrating/synthesizing 状态。
3. `playStoryWork` 切换 source 前经正式 pause Flow 暂停旧 Transport，再 begin 新 Session。
4. `PlaybackSessionStore.init()` 在已存在有效内存 Session 时幂等返回；整页刷新仍从空内存状态正常水合为暂停态。

## 验收标准

- A 播放中点击 B，仅 B 显示“准备语音”；准备期间点回 A 后仅 A 显示准备中，最终只播放 A。
- 切曲开始后旧音频立即停止。
- 播放中通过底部主导航切换到创作 Tab，Mini 仍显示正在播放、按钮仍为暂停，进度继续推进。
- 整页刷新保持既有“恢复为暂停态”语义。
- `yarn test:fast`、`yarn build`、`git diff --check` 通过。
