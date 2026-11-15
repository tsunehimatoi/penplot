# PenPlot

面向 GRBL / Marlin / EBB 写字机与笔式绘图仪的桌面工作台，基于 Electron + Python，支持本地排版、绘图和串口打印。

[下载最新版](https://github.com/tsunehimatoi/penplot/releases/latest) · [使用手册](docs/manual/README.md) · [English](README.en.md) · [API](docs/api.md)

<p align="center">
  <img src="docs/images/studio-richtext-desktop.jpg" width="49%" alt="Markdown 与 LaTeX 排版">
  <img src="docs/images/studio-chart-desktop.jpg" width="49%" alt="函数曲线与数据图表">
</p>

## 下载与使用

在 [Releases](https://github.com/tsunehimatoi/penplot/releases) 中选择系统和架构。桌面包内含后端、前端和开源字体，无需另装 Python 或 Node.js。

| 系统 | 架构 | 文件 |
|---|---|---|
| Windows | x64 / ARM64 | `.exe` 安装包、`.zip` 便携包 |
| macOS | Intel x64 / Apple Silicon ARM64 | `.dmg`、`.zip` |
| Linux | x64 / ARM64 | `.AppImage`、`.deb` |

Linux AppImage 需先赋予执行权限：`chmod +x Penplot-*.AppImage`。发布包暂未配置 Windows 代码签名和 Apple 公证，系统可能提示未验证的开发者。每次发布提供 `SHA256SUMS.txt` 校验文件。

连接机器后选择串口与控制器，抬笔并设置原点，先用「走边框」确认范围再打印。急停快捷键：`Ctrl/⌘ + .`。详见 [安全须知](docs/manual/10-safety.md)。

## 功能

- **排版与绘图**：Markdown、LaTeX 公式、表格、多页信笺、竖排、函数曲线与数据图表。
- **字体与手写**：内置中英文单线字体，支持分类选字、多字体加权混排、手写抖动和 TTF 转单线。
- **导入与导出**：图片描线、SVG / DXF / Excel 导入、G 代码预览与导出。
- **机器控制**：串口打印、点动、走边框、任务队列、断点续打与电传打字机。
- **工具接口**：CLI 与 MCP，支持自动化排版和打印。

## 本地开发

需要 Python 3.12、Node.js 22。构建原生计算核心或桌面包还需要 Rust/Cargo 和目标平台链接工具。

```bash
git clone https://github.com/tsunehimatoi/penplot.git
cd penplot
python -m venv .venv
# Windows: .venv\Scripts\activate
# macOS / Linux: source .venv/bin/activate
python -m pip install -e '.[all,dev]' pyinstaller
npm --prefix webui ci
npm --prefix desktop ci
npm --prefix desktop run dev
```

源码开发时运行 `python -m penplot._native_generated.build` 启用 Rust G-code 生成与运动统计。
较大的多页文档按页并行处理：受支持的原生配置使用释放 GIL 的线程调用，其余配置使用页进程；小文档和不支持派生进程的回退环境保持串行。
桌面打包会自动编译并包含原生库，最终用户无需安装 Rust。配置范围和基准开关见[原生核心说明](penplot/_native_generated/README.md)。

当前平台打包：

```bash
npm --prefix webui run build
python -m PyInstaller --noconfirm penplot-backend.spec
npm --prefix desktop run dist -- --publish never
```

安装包位于 `desktop/dist-electron/`。运行测试：`python -m pytest -q`。

## 发布

同步更新 `penplot/__init__.py`、`desktop/package.json` 和 `desktop/package-lock.json` 的版本，推送对应 `vX.Y.Z` 标签即可触发 [Release 工作流](.github/workflows/release.yml)。六个平台构建及后端冒烟检查全部通过后，统一发布安装包与校验文件。也可在 Actions 手动运行构建；从分支运行时只生成构建产物，不发布 Release。

## 来源与许可

基于 [jiangmuran/penplot](https://github.com/jiangmuran/penplot) 扩展桌面端、富文本排版、图表和字体混排功能。

代码采用 [AGPL-3.0-or-later](LICENSE)；随附字体许可见 [fonts/README.md](fonts/README.md)，第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
