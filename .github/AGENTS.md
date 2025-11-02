# .github 目录说明

- 职责：存放 GitHub Actions 等平台自动化配置，驱动仓库的 CI/CD 流程。
- 子目录结构：
  - `workflows/`：GitHub Actions 工作流定义。
- 上下游依赖：
  - 上游依赖仓库根目录脚本与配置（如 `scripts/push-ghcr.sh`、`package.json#scripts`）。
- 下游为 GitHub 托管环境，负责根据工作流执行镜像构建与推送，并通过 Bark Webhook 发送成功/失败通知。
