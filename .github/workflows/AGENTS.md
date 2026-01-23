# AGENTS

## 目录职责
- 定义 GitHub Actions CI/CD 工作流配置文件。

## 子目录结构
- `docker-push.yml`：构建 Docker 镜像并推送到镜像仓库的工作流。

## 关键协作与依赖
- 依赖仓库根目录的 `Dockerfile` 进行构建。
- 需要 GitHub Secrets 配置 Docker Hub 凭证。
