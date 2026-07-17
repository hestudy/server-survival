# 0002. 放弃零构建:Vite + npm 依赖 + 平台适配层

日期:2026-07-17
状态:已接受

## 背景

上游把 "No build step required!" 作为项目卖点:20 个 `<script>` 标签按序加载、全局变量通信,Three.js r128 与 Tailwind 走 CDN,GitHub Pages 直接从分支根目录部署。

但本项目的定位是**微信小游戏的跳板**(见 ADR-0001 的项目独立化前提)。小游戏运行环境禁止加载远程脚本、要求模块化打包、没有 DOM,Three.js 必须经适配层(如 three-platformize)以 npm 依赖方式引入。零构建与这个目标不兼容。

## 决策

1. 源码全面改为 **ES modules**,以 **Vite** 构建;Three.js、Tailwind 从 CDN 改为 npm 依赖(Tailwind 构建时生成)。
2. 建立**平台适配层**:存储(localStorage → 可替换)、音频、输入事件源只允许出现在适配层内;仿真核心保持纯逻辑、注入 RNG(详见 CONTEXT.md 架构分层术语)。
3. GitHub Pages 部署改为 GitHub Actions workflow:构建产物发布,不再直接伺服源码。
4. "克隆即玩"(直接打开 index.html)不再是本仓库的承诺,以 `npm i && npm run dev` 取代。

## 备选方案

- **原生 ES modules、保持零构建**:被否决——小游戏阶段仍需再改一次依赖引入方式,等于付两次钱。
- **双模式(浏览器直跑 + Vite 生产构建)**:被否决——需要长期维护两套 import 约束,容易腐化。

## 后果

- 收益:小游戏阶段可直接复用模块图与适配层;获得依赖锁定、tree-shaking、Tailwind 产物瘦身。
- 代价:贡献门槛从"打开文件"提高到"Node 工具链";部署链路多了 CI 一环。
- 前期约多花 10–20% 的重构工夫在层间边界上,这是对小游戏阶段的预付投资。
