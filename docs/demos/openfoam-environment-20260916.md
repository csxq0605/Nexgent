# OpenFOAM 本机环境核查：2026-09-16

## 1. 结论与核查范围

本机已找到可读取的 **OpenFOAM Foundation 8** 安装，位于 WSL2 的 `Ubuntu-20.04` 发行版内。包版本为 `openfoam8 20210316`；加载安装自带环境脚本后，`foamVersion` 返回 `OpenFOAM-8`，基础工具路径可解析，原装 cavity 教程字典可读。

这证明安装位置、版本和教程存在，**尚不证明仿真、后处理、暂停恢复或 Nexgent 的 OpenFOAM 插件能够运行**。本轮只做环境和文件读取，没有运行 `blockMesh`、`checkMesh`、`icoFoam`、`postProcess` 或任何 case，没有安装、升级、修改 WSL 配置、启动 Docker 服务或调用模型。

Windows 沙箱内原先的 WSL 枚举出现 `E_ACCESSDENIED`；本次在允许的只读提升权限下完成枚举与发行版内读取。执行 WSL 内只读命令会按 WSL 自身机制启动发行版；这与启动 CFD 求解器不同。本轮没有执行 WSL 停止、重启或配置命令。

配套设计见 [OpenFOAM CFD demo 设计](openfoam-cfd-design.md)。OpenFOAM 是 Nexgent 的领域工具；Nexgent 的定位仍是通用、完整智能体软件的 RSI 框架。

## 2. 已核实的安装信息

| 项目 | 本次观察 |
| --- | --- |
| Windows 命令路径 | `wsl.exe`：`C:\WINDOWS\system32\wsl.exe` |
| Windows OpenFOAM 命令 | 本次 `Get-Command foamVersion,icoFoam,blockMesh` 未返回命令；这仅描述当前 Windows PATH，不证明磁盘其他位置没有安装 |
| WSL 发行版 | 默认 `Ubuntu-20.04`，WSL version 2；另列出 `docker-desktop`，version 2 |
| 首次枚举的状态 | 两发行版均为 `Stopped`；这是只读发行版命令执行前的瞬时状态 |
| Linux 发行版 | `/etc/os-release`：Ubuntu `20.04.6 LTS (Focal Fossa)` |
| 内核 | `5.15.167.4-microsoft-standard-WSL2` |
| 安装位置 | `/opt/openfoam8` |
| 环境脚本 | `/opt/openfoam8/etc/bashrc` |
| 软件识别 | `foamVersion` → `OpenFOAM-8`；`WM_PROJECT_VERSION=8` |
| 系统包 | `dpkg-query --show 'openfoam*'` → `openfoam8 20210316` |
| 构建标识 | `WM_OPTIONS=linux64GccDPInt32Opt`；这是构建标识，不是性能测量 |
| 教程根目录 | `FOAM_TUTORIALS=/opt/openfoam8/tutorials` |
| cavity 教程目录 | `/opt/openfoam8/tutorials/incompressible/icoFoam/cavity`，列出 `cavity`、`cavityClipped`、`cavityGrade`、`Allrun`、`Allclean` |
| 本设计的启动模板 | `/opt/openfoam8/tutorials/incompressible/icoFoam/cavity/cavity` |

在 `/bin/bash --noprofile --norc` 的初始环境内，OpenFOAM 命令未解析。仅在该只读 shell 内加载安装自带 `etc/bashrc` 后，以下命令均解析到 `/opt/openfoam8/platforms/linux64GccDPInt32Opt/bin/`：

- `blockMesh`
- `checkMesh`
- `icoFoam`
- `foamDictionary`
- `postProcess`

`ldd icoFoam` 的前 12 行显示 `libfiniteVolume`、`libmeshTools`、`libOpenFOAM`、`libPstream` 等指向该安装或系统库；**没有完成全部依赖和运行测试**，不能由这些行宣称完整环境验收。

Windows 也解析到 Docker CLI，但本轮没有调用 Docker 命令，没有检查 daemon、镜像或容器。CFD 设计不依赖启动 Docker。

## 3. 原装启动 case 的实读值

以下值来自本机上述 cavity 模板的七个字典，不是一次仿真输出。

| 项目 | 文件与值 |
| --- | --- |
| 尺寸与网格 | `system/blockMeshDict`：`convertToMeters 0.1`；物理尺寸 `0.1 × 0.1 × 0.01 m`；`(20 20 1)`，均匀网格 |
| 二维约束 | 网格 `frontAndBack` 为 `empty`；`0/U`、`0/p` 的同名边界也为 `empty` |
| 顶盖速度 | `0/U`：`movingWall` 为 `fixedValue uniform (1 0 0)` |
| 其余壁面 | `0/U`：`fixedWalls` 为 `noSlip`；内部初值 `(0 0 0)` |
| 压力 | `0/p`：运动学压力，量纲 `[0 2 -2 0 0 0 0]`；壁面 `zeroGradient`，内部初值 0 |
| 黏度 | `constant/transportProperties`：运动学黏度 `nu=0.01 m²/s` |
| 推导的雷诺数 | `Re=U_lid L/nu=1×0.1/0.01=10` |
| 求解器与时间 | `application icoFoam`，`startTime=0`，`endTime=0.5 s`，`deltaT=0.005 s` |
| 输出 | ASCII，`writePrecision=6`；每 20 时间步写出；`purgeWrite=0`；`runTimeModifiable=true` |
| 时间/空间离散 | 时间 `Euler`；速度对流 `Gauss linear`；正交 Laplacian 与面法向梯度 |
| 压力求解 | PCG/DIC；`tolerance=1e-6`，`relTol=0.05`；`pFinal relTol=0` |
| 速度求解 | `smoothSolver/symGaussSeidel`；`tolerance=1e-5`，`relTol=0` |
| PISO 与压力基准 | `nCorrectors=2`，`nNonOrthogonalCorrectors=0`，`pRefCell=0`，`pRefValue=0` |

这些默认值适合作为教程身份；不能直接当作 Re=100 正式验证 case 的稳态时间、准确度阈值或资源预算。正式协议将复制模板至独立工作区后冻结；本轮未复制或修改模板。

## 4. 本次读取的内容摘要

| 对象 | SHA-256 |
| --- | --- |
| `platforms/linux64GccDPInt32Opt/bin/icoFoam` | `69a964c5500580c4e6b3b5cb0f18393a24a5c7a1608c600d3d9858016608f6d3` |
| `etc/bashrc` | `992dbee1d27e1af5a64f8aeb5c891c814b53650fbdac943e0ecc59abee7b4292` |
| cavity `0/U` | `b695b6e21142e9281e496e68471d692d690546c9c18436d4317fd14fbf4abbc4` |
| cavity `0/p` | `af4b5ed802930a14c5ac645c4f212a4028067610382396fcd44921e0c7db4227` |
| cavity `constant/transportProperties` | `56af43dc5ae3002b46e50b2589608d2471d29c57fbadd6ef86fef049f9077424` |
| cavity `system/blockMeshDict` | `3c52893aca5b4be4d7e5fa73ae4f4b17574e50c84d0b24ac512c7a6d2ffe21dc` |
| cavity `system/controlDict` | `da55915200f10d56053de05512478b3b0f72ef7a52b540f6c29ef5b26fc2b0a8` |
| cavity `system/fvSchemes` | `97b88adb0fa309336e9f71bb7e5b6c3d88766eb021e24970f4a75b58077a21e3` |
| cavity `system/fvSolution` | `6717d883c6f982c275a43da75aed052cb3dc2bace6bb43f20da48808879ee151` |

二进制摘要不能替代动态库、系统包和正式 case 的完整环境冻结；这里只保存实际读取过的对象。

## 5. 可重查的只读入口

以下命令用于解释本次核查方法，文档不会自动执行它们：

```powershell
wsl --list --verbose
wsl -d Ubuntu-20.04 --exec /bin/bash --noprofile --norc -c 'cat /etc/os-release; uname -r'
wsl -d Ubuntu-20.04 --exec /bin/bash --noprofile --norc -c '. /opt/openfoam8/etc/bashrc >/dev/null 2>&1; foamVersion; command -v icoFoam blockMesh checkMesh postProcess'
```

本次读取的是明确的 `/opt/openfoam8` 安装及 cavity 字典，未扫描用户 case 内容、环境密钥或全盘配置。曾查看 `E:/PKU/program/2026/Aug/work` 的第一层目录名；没有继续读取与 OpenFOAM 无关的项目。

## 6. 仍未知的事项与后续执行前条件

| 尚未知 | 正式执行前需落实的条件 |
| --- | --- |
| 求解器实际启动和退出状态 | 在单独登记的启动检查中运行最小 case，并保存 PID、命令、退出码、日志和文件摘要 |
| 20/40/80 网格的 CPU 时间、内存、步数、磁盘需求 | 先做独立预算校准；不能用教程说明或本次读取耗时替代测量 |
| 本轮任务可用的 CPU/RAM 配额及并发干扰 | 记录 WSL 配额与执行时资源快照；首轮优先单进程串行 case，避免把 MPI 性能作为另一个变量 |
| 中心线采样和压力修正通量输出的版本兼容性 | 用 Foundation 8 可用的后处理配置做单独验收，确认坐标、量纲、时间与缺失字段处理 |
| 可重启字段与数据完整性 | 明确完整检查点、幂等操作 ID 和重启一致性比较；不能仅凭目录名采用 `latestTime` |
| 独立参考数值及分发权限 | 冻结合法取得的本地参考文件及其来源/摘要；本轮没有下载、转录或打包 Ghia 数值表 |
| 正式阈值与可行预算 | 按设计中的误差分解校准并预注册，然后才评价候选；保持启动检查和正式研究的数据边界 |
| 完整 agent 软件与 OpenFOAM 能力适配 | 当前仓库尚未实现本设计的仿真插件、任务多智能体工作流和自动验收闭环 |
| 聚变相关环境/验证 | 用户说明没有聚变环境；本轮未进行全盘软件普查，不能由 cavity 推出聚变能力 |

上述是后续工作的进入条件，不是用户待填写的确认清单。本轮没有发起仿真、模型运行或安装。

## 7. 版本资料

- [Foundation 8 cavity 官方教程](https://doc.cfd.direct/openfoam/user-guide-v8/cavity)：与本机安装版本对应。
- [Foundation 8 补丁包说明](https://openfoam.org/news/v8-patch/)：包子版本按日期编号；本机 `20210316` 来自实读包元数据。
- [Foundation 模块化求解器说明](https://cfd.direct/openfoam/free-software/modular-solvers/)：较新版本的 `foamRun -solver incompressibleFluid` 不能直接代替本机 v8 的运行入口。
