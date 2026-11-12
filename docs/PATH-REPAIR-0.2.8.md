# 漫画路径修复 · 0.2.8 · 2026-11-03

点击已不存在的漫画文件夹、ZIP/CBZ 等支持文件，会弹出“查找漫画新位置”，按原名称查询本机 Everything。修改关键词、查看候选完整路径、选择后点击“修正路径并打开”。不会自动认定同名结果；取消不改书库。没有结果或 Everything 不可用时，可手动选择目录或文件。

入口覆盖书库/最近阅读、侧栏、收藏、标签页、读后推荐及 AI 历史的“打开原漫画”。AI 历史仍保留原路径而书库记录已删除时，可以重建原漫画关联。已被删除且没有留存的元数据无法恢复。真正删除且没有其他副本的漫画，搜索也无法恢复文件。

## 数据处理

- 只修改本地 SQLite 记录，不复制、移动或删除原始漫画。保留现有标签、作者、阅读进度、收藏和评分；父目录改址时同步更新子条目。
- 目标已导入时合并重复条目、保留原选中漫画 ID、合并作者/标签、保留较远进度及较高收藏评分。修正页收藏时按原页面名称匹配，新根漫画进度限制在有效页码内。
- 保留 AI 输出文件，更新漫画关联和后续保存目录；已有另存路径仅在对应新位置确实存在时更新。相关 AI 任务仍生成时禁止修复。
- 候选结果有效期 10 分钟，绑定当前条目和原路径。确认时重新验证目标和可阅读页面；原路径恢复、候选消失、记录并发改变则阻止写入。事务写入并记录 `path_repairs` 审计快照。

## 实现文件

- `src/main/everything.ts`、`resources/everything/EverythingSearch.cs`：通过官方 x64 SDK 的本机 IPC 查询索引；独立辅助进程隐藏运行，最多返回 200 项，12 秒超时；不在正常启动时查询。随包 DLL 的 MIT 授权见 `resources/everything/LICENSE.txt`。
- `src/main/pathRepair.ts`：候选校验、手动选择、关联合并和路径修复；`worker.ts` 为事务增加快照前置检查。
- `src/contracts/index.ts`、`src/preload/index.ts`、`src/main/index.ts`：四个修复 IPC 接口。
- `src/renderer/PathRepair.tsx`、`main.tsx`、`SourceTree.tsx`、`Favorites.tsx`、`ReadingChoices.tsx`、`AiEdits.tsx`、`style.css`：对话框、缺失路径检查及打开入口。
- `tests/path-repair.test.cjs`、`tests/path-repair.cjs`：隔离数据库、生成素材的单元与真实 Everything/窗口集成测试。
- `package.json`/锁文件及 README、第三方授权、验收文档：版本、打包资源、说明。阅读推荐回归等待图片实际加载；阅读器失败诊断容忍测试窗口提前关闭，保留原始错误。

## 依赖与构建

需要本机 Everything 正在运行，且与 Mini Manga 权限相同。没有索引到的磁盘或刚变化尚未入索引的位置，可手动选择。不修改 Everything 索引设置、安全软件规则或系统权限。

辅助程序使用本机 .NET Framework 4.x 编译器，不增加 npm 原生 FFI 依赖。修改 C# 后在项目根目录执行：

```powershell
$sourceFilePath = (Resolve-Path 'resources/everything/EverythingSearch.cs').Path
$helperOutputPath = Join-Path (Split-Path $sourceFilePath) 'EverythingSearch.exe'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler '/nologo' '/target:exe' '/platform:x64' '/reference:System.Web.Extensions.dll' ('/out:' + $helperOutputPath) $sourceFilePath
```

`npm run test:repair` 包含真实 Everything 集成测试，要求正在运行的索引覆盖系统临时目录。常规 `npm test` 中的单元测试用隔离模拟搜索覆盖索引失败分支。

## 验证范围

使用生成的 Unicode 名称目录、SVG/JPEG/PNG 和 ZIP、隔离临时书库；不读取个人漫画、不修改正常书库。覆盖多个同名候选、不自动选择/取消、目录改址、关联保留、ZIP 候选消失与手动修正、候选过期/伪造/绑定、原路径恢复、事务回滚、生成中 AI 阻止修复，以及 AI 原漫画记录重建/目标重复合并、重启持久化。原始文件和 AI 输出的 SHA-256 保持不变。

类型检查、生产构建、17 项单元/Worker 检查及原有阅读、收藏、来源、推荐、侧栏、逐层加载、AI、性能回归通过。最终独立 EXE 的真实 Everything 路径修复、基础阅读、收藏/PDF、AI、性能通过；SSD 副本的真实 Everything 与基础阅读通过，99 个部署文件逐个 SHA-256 校验一致，桌面优化版快捷方式指向 0.2.8。旧版本保留。

未验证百万条库的修复速度、所有网络共享/断线场景、所有压缩编码与加密压缩包。离线盘或权限错误不会被当作可恢复文件；手动确认目标后仍需通过读取检查。
