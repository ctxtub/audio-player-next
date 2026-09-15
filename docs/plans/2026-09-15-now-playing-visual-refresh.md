# Now Playing 视觉一致性刷新计划

状态：COMPLETE

1. 以真实浏览器记录桌面与移动端基线。
2. 补齐播放器尺寸 token，调整 Mini 与 Expanded presentation。
3. 在真实浏览器复核 1440×900、390×844，并保存确认截图。
4. 运行相关窄测与仓库完成门，记录实际结果。

## 实际验证

- Kimi WebBridge：1440×900、390×844 的 Mini / Expanded 真实浏览器截图通过人工视觉复核。
- `yarn test:catalog`：PASS。
- `yarn lint`：PASS。
- `yarn tsc --noEmit --incremental false`：PASS。
- `yarn test:unit`：66/66 PASS。
- Now Playing 相关窄测：PASS。
- `yarn build`：PASS（仅既有 Sass `@import` deprecation warning）。
- `git diff --check`：PASS。
- `yarn test:integration`：BLOCKED，Prisma schema engine 在 bootstrap migrate 阶段失败，重跑（含沙箱外）结果一致，0 个 suite 执行。
- Expanded 双浏览器 L3：BLOCKED，browser harness 按仓库规则拒绝 dirty tracked 工作树；未伪报 PASS。
