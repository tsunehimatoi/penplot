# 原生路径与 G-code 计算

默认 GRBL Stepper（整数正进给、无首尾自定义指令、无停顿、无生成器旋转）
使用 Rust 一次完成指令格式化、舍入后运动统计。其他配置保留 Python 路径。
页面原点变换在调用前完成，不受此限制。

页面后处理使用连续 `float64` 坐标、操作数组和按点计数的路径偏移，直接借给原生核心。
整页旋转、原点平移、轴映射和包围盒计算使用独立的几何 ABI，支持纸张原点、
内容原点及信笺框原点。旧路径对象按需展开，已展开或不支持的数据保留兼容路线。
`PENPLOT_NATIVE_GEOMETRY=0` 可单独禁用几何加速；
`native_geometry.native_available()` 可检查加载状态。

预览与打印共享排版路径缓存，保留双精度坐标和完整路径操作，跨任务进程复用。
信笺在元素变换前缓存，因此临时预览文档与原项目也能共享结果；纯信笺文档仅写这一份缓存。
缓存位于元素缓存目录的 `layout-v1` 子目录，最多 16 项、256 MiB；命中后返回独立路径，
打印偏移与机器原点随后应用。文本、字体文件版本、纸张、变量、随机种子和配置改变会失效。
修改排版算法时需提升 `layout_cache.VERSION`，避免旧算法结果被继续复用。

开发环境启用：

```powershell
.venv\Scripts\python.exe -m penplot._native_generated.build
$env:PENPLOT_REQUIRE_NATIVE = '1'
.venv\Scripts\python.exe -m pytest tests/test_native_generated.py -q
```

构建需要 Rust/Cargo 和目标平台链接工具；Cargo 无第三方依赖，使用离线、锁定构建。
应用启动和打印时不会下载依赖或编译。`PENPLOT_NATIVE_GENERATION=0` 可禁用原生调用，
用于相同输入的基准对照。`native_generated.native_available()` 可检查当前进程状态。

`pip wheel .` 在构建机找到 Cargo 时会自动构建并包含原生库，生成平台 wheel。
发布时设置 `PENPLOT_BUILD_NATIVE=1`，缺少工具链会明确失败。
没有 Cargo 时可生成保留 Python 回退的包；`PENPLOT_BUILD_NATIVE=0` 禁用自动编译。
PyInstaller spec 会强制构建并收集动态库，缺少工具链时停止打包。
安装已构建的 wheel 或桌面发行包的最终用户不需要 Rust。

`ctypes.CDLL` 在整个原生调用期间释放 GIL，Rust 端没有 Python 回调或共享可变状态；
输入打包与结果解码仍在 Python 内执行。按页线程可以同时执行原生部分。
G-code 字符串逐字节对照；距离与时长采用顺序双精度累加，平台 libm 的 hypot
与 CPython 补偿 hypot 可能相差少量 ULP，测试容差为相对 2e-14、绝对 1e-10。
行数、笔状态、包围盒、安全信息等离散字段必须完全一致。
