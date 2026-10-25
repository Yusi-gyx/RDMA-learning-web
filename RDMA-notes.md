# RDMA 底层学习笔记

> 以 IBTA 规范 Vol.1 传输层与 Linux rdma-core verbs 为准。性能数字为量级参考，随网卡代际、固件与配置变化。

## 目录

- [1. 为什么是 RDMA](#1-为什么是-rdma)
- [2. 对象模型](#2-对象模型)
- [3. 内存注册与 lkey/rkey](#3-内存注册与-lkeyrkey)
- [4. QP 状态机](#4-qp-状态机)
- [5. 传输服务类型](#5-传输服务类型)
- [6. 数据路径：一次 post_send](#6-数据路径一次-post_send)
- [7. 操作语义：双边与单边](#7-操作语义双边与单边)
- [8. 报文结构](#8-报文结构)
- [9. 分片与 PMTU](#9-分片与-pmtu)
- [10. 可靠性：PSN 与重传](#10-可靠性psn-与重传)
- [11. 拥塞控制与无损以太](#11-拥塞控制与无损以太)
- [12. 性能与调优](#12-性能与调优)
- [13. verbs 编程骨架](#13-verbs-编程骨架)
- [14. 端到端模式：WRITE_WITH_IMM ring buffer](#14-端到端模式write_with_imm-ring-buffer)
- [15. 排障速查](#15-排障速查)
- [16. 动手实验](#16-动手实验)
- [17. 术语表](#17-术语表)

---

## 1. 为什么是 RDMA

### 传统内核 TCP 的代价

一次 4 KB 发送，数据路径上至少：

| 步骤 | 代价 |
|---|---|
| `write()` 系统调用 | 用户态→内核态切换 |
| 数据拷入内核 sk_buff | 第 1 次拷贝 |
| 协议栈封装 | TCP 分段、校验和、IP 头 |
| 入队驱动、DMA 描述符 | 锁、中断 |
| 对端硬中断→软中断 | CPU 抢占 |
| 内核缓冲→用户缓冲 | 第 2 次拷贝 |
| 唤醒进程 | 调度延迟 |

成本随带宽**线性增长**：带宽翻倍，CPU 开销也翻倍。

### RDMA 的做法

把整个协议栈下沉进网卡（HCA / RNIC），CPU 只下指令和取结果：

- 应用在用户态写 WQE 到共享内存
- 写一次 doorbell 寄存器（MMIO，不陷入内核）
- 网卡自己取数据、组包、重传、DMA 写对端内存
- **对端 CPU 在数据路径上完全不参与**

三条基本事实：

1. **控制路径**可以慢、可以走内核（建连、注册内存、配置 QP）
2. **数据路径**必须快，所以在用户态、由硬件执行
3. **完成通知**是异步的：网卡写队列，应用自己 poll

### 三个关键量级

| 指标 | 量级 | 说明 |
|---|---|---|
| 小消息单跳延迟 | ~1 µs | 比内核 TCP 少一个数量级 |
| 数据拷贝次数 | 0 | 应用内存与网卡之间直接 DMA |
| 端口速率 | 100–400 Gb/s | IB / RoCE 主流代际 |

### 代价

内存必须注册并 pin 住；连接有状态；错误处理要自己写；拥塞控制依赖网络配置。

---

## 2. 对象模型

```
ibv_context（设备上下文）
├── PD 保护域
│   ├── MR 已注册内存（lkey / rkey / 访问权限）
│   ├── QP 队列对（QPN，SQ + RQ + 状态 + PSN 计数器）
│   ├── SRQ 共享接收队列
│   ├── AH 地址句柄（UD 目的地址）
│   └── MW 内存窗口（在 MR 上切出，独立 rkey）
└── CQ 完成队列（CQE：状态 / wr_id / 长度）
```

### 各对象职责

| 对象 | API | 作用 |
|---|---|---|
| `PD` | `ibv_alloc_pd(ctx)` | 隔离容器。**同一 PD 内的对象才能互访** |
| `MR` | `ibv_reg_mr(pd, addr, len, flags)` | 注册并 pin 住内存，返回 lkey/rkey |
| `QP` | `ibv_create_qp(pd, &init_attr)` | 一对 SQ/RQ 加连接状态 |
| `CQ` | `ibv_create_cq(ctx, cqe, ...)` | 完成事件队列，可被多 QP 共享 |
| `SRQ` | `ibv_create_srq(...)` | 多 QP 共享一个接收 WR 池 |
| `AH` | `ibv_create_ah(pd, &ah_attr)` | UD 的目的地址封装（GID/SL/端口） |
| `MW` | `ibv_alloc_mw(pd, IBV_MW_TYPE_2)` | 在 MR 上临时切一段，独立授权/吊销 |

### 铁律

**QP 只能访问同一个 PD 里的 MR。** 跨 PD 的 rkey 被网卡判为访问错误，返回 NAK syndrome `0x61`。

注意 PD 与 P_Key 是两套独立机制：

- **PD** 是本地对象的隔离边界
- **P_Key** 是网络上分区（租户）隔离，写入 BTH

---

## 3. 内存注册与 lkey/rkey

### 为什么需要注册

网卡不懂页表。注册时驱动：

1. 把这批页 **pin 住**（防止换出/迁移）
2. 把物理地址写进网卡自己的翻译表（**MPT / MTT**）
3. 把允许的操作权限和 key 一起登记
4. 返回 `lkey`（本地用）和 `rkey`（可交给对端）

### 两个 key 的分工

| key | 出现在哪 | 作用 |
|---|---|---|
| `lkey` | 本端 WQE 的 scatter/gather 项 | 告诉本端网卡「从这块内存读/写回这块内存」 |
| `rkey` | RETH / AtomicETH 头，随报文发到对端 | 告诉对端网卡「允许你读写我哪一块内存」 |

### 访问标志

| 标志 | 允许的操作 |
|---|---|
| `IBV_ACCESS_LOCAL_WRITE` | 对端 SEND 写入本端缓冲区 |
| `IBV_ACCESS_REMOTE_WRITE` | 对端 RDMA WRITE |
| `IBV_ACCESS_REMOTE_READ` | 对端 RDMA READ |
| `IBV_ACCESS_REMOTE_ATOMIC` | 对端 ATOMIC |
| `IBV_ACCESS_RELAXED_ORDERING` | 放宽 PCIe 顺序，提升吞吐 |
| `IBV_ACCESS_ON_DEMAND` | ODP，按需分页，不预先 pin |

权限不足时：对端网卡生成 AETH syndrome `0x61` 的 NAK，请求方 QP 进 ERROR，对应 CQE 状态 `IBV_WC_REM_ACCESS_ERR`。

### 注册的代价

一次 `ibv_reg_mr` 可能 pin 上万页，开销与页数成正比。**热路径上反复注册/注销是常见性能杀手。**

正确做法：
- 启动时注册、长期复用
- 动态缓冲区用**内存窗口（MW）**或 **ODP**

---

## 4. QP 状态机

新 QP 什么都不能做，必须按顺序迁移，每一步只能设置一组特定属性；跳步或漏设属性，`ibv_modify_qp` 返回 `EINVAL`。

```
RESET ──→ INIT ──→ RTR ──→ RTS
  │        │        │       │
  └────────┴────────┴───────┴──→ ERROR
```

### 各状态能力

| 状态 | 能做什么 |
|---|---|
| `RESET` | 队列清空，未完成 WR 作废；不可收发 |
| `INIT` | 可以 post_recv，但报文不会到达；不能发送 |
| `RTR` | 可以接收远端请求；不能主动发送 |
| `RTS` | 收发全开，可发起 READ / ATOMIC |
| `ERROR` | 所有未完成 WR 变成 `IBV_WC_WR_FLUSH_ERR` |

### 迁移必设属性

**INIT**

| 属性 | 说明 |
|---|---|
| `IBV_QP_PKEY_INDEX` | 分区键索引 |
| `IBV_QP_PORT` | 物理端口号 |
| `IBV_QP_ACCESS_FLAGS` | 远端允许的操作 |

**RTR**

| 属性 | 说明 |
|---|---|
| `IBV_QP_AV` | 目的 GID/LID、端口、SL |
| `IBV_QP_PATH_MTU` | **两端必须一致** |
| `IBV_QP_DEST_QPN` | 对端 QPN |
| `IBV_QP_RQ_PSN` | 接收起始 PSN |
| `IBV_QP_MAX_DEST_RD_ATOMIC` | 可接受的并发读请求数 |
| `IBV_QP_MIN_RNR_TIMER` | RNR 后等待时间 |

**RTS**

| 属性 | 说明 |
|---|---|
| `IBV_QP_SQ_PSN` | 发送起始 PSN |
| `IBV_QP_TIMEOUT` | 本地确认超时，`4.096 µs × 2^n` |
| `IBV_QP_RETRY_CNT` | 超时重试次数（7 = 无限） |
| `IBV_QP_RNR_RETRY` | RNR 重试次数（7 = 无限） |
| `IBV_QP_MAX_QP_RD_ATOMIC` | 单 QP 并发的读/原子请求数 |

### 三个最常见的坑

1. **进入 RTR 前没 post_recv** → 第一个包到达时接收队列为空，对端收到 RNR NAK，等待 `min_rnr_timer` 后重试。
2. **两端 `path_mtu` 不一致** → 大包被当成超长帧静默丢弃（一边 4096 一边 1024 是典型事故）。
3. **`rq_psn` 不一致** → 第一个包就 NAK `0x60`。

---

## 5. 传输服务类型

| 服务 | 连接模型 | 可靠性 | 支持的操作 | 典型用途 |
|---|---|---|---|---|
| **RC** | 一对一 | 可靠有序 | Send/Recv、Write、Read、Atomic、Write+Imm | 存储、RPC、MPI，绝大多数场景 |
| **UC** | 一对一 | 不可靠 | Send/Recv、Write（**无 Read / Atomic**） | 少见 |
| **UD** | 一对多，无连接 | 不可靠 | 仅 Send/Recv，单消息 ≤ PMTU | 建连前引导、多播、控制面 |
| **RD** | 可靠数据报 | 可靠 | 同 RC | 需 EEC，基本被淘汰 |
| **XRC** | 共享接收队列 | 可靠 | 同 RC | 接收侧 QP 数量爆炸的多进程服务 |
| **DC** | 动态连接 | 可靠 | 同 RC（+ DCT 号寻址） | 大规模 GPU 集群 |

### 关键点

- **UC 不支持 RDMA Read 和 Atomic**（读需要可靠应答）—— 很多资料写错。
- **RC 的 QP 数量按平方增长**：N 节点、每节点 p 进程两两通信 → `N·p²` 个 QP，每个都占网卡缓存与内存。
- **UD 用一条 QP 发往任意目的**，靠 DETH 头里的目的 QPN 寻址，接收端必须能从 GRH 解析来源。
- **DC** 发送时只写 DCT 号，硬件按需建连，应用看不到建连过程。

---

## 6. 数据路径：一次 post_send

```
应用写 WQE → 敲 doorbell → 网卡读 WQE → DMA 取数据 → 组包
   → 上线 → 对端网卡校验 → 直接 DMA 写内存 → 回 ACK → CQE
```

| # | 步骤 | 说明 |
|---|---|---|
| 1 | 准备 WQE | 填 wr_id、opcode、sg_list、remote_addr、rkey，拷进 SQ 环形缓冲 |
| 2 | 敲 doorbell | 对用户态寄存器做 64 位写，传 SQ 尾指针。MMIO，约几十 ns |
| 3 | 硬件读 WQE | 按 lkey 查 MTT，得到数据物理页 |
| 4 | DMA 取数据并组包 | 超 PMTU 则切片，逐片填 BTH，首片附 RETH |
| 5 | 上线 | 套 UDP(4791) / IP / Eth，尾部加 ICRC 与 FCS |
| 6 | 对端校验 | ICRC、P_Key、QPN、PSN、rkey 权限 |
| 7 | 直接写内存 | 按 RETH 地址与 rkey 查表，DMA 到应用缓冲；**对端 CPU/内核全程不参与** |
| 8 | 回 ACK，产生 CQE | 本端 CQ 写入 CQE，应用 `ibv_poll_cq` 取走 |

### 核心理解

- **WQE 写在应用自己的内存里**，SQ 是应用与网卡共享的环形缓冲区，libibverbs 只算偏移。
- **doorbell 就是一次 MMIO**，这就是 kernel bypass 的全部秘密：不陷入内核、不拷贝。
- 零拷贝的另一半是对端网卡按 rkey 直接 DMA。

---

## 7. 操作语义：双边与单边

### SEND / RECV（双边）

```
A: post_send(SEND)  ──→  B: post_recv 已就绪
                    ←──  ACK
```

- 发送方只保证数据到对端网卡接收队列，**不保证对端应用已读走**
- 对端必须事先 `post_recv`，否则 RNR NAK
- 消息长度不受 PMTU 限制，硬件自动分片

### RDMA WRITE（单边）

- 对端只需提前注册内存并交出 rkey
- **不需要 post_recv，不需要任何线程在跑**
- 对端应用要自己轮询或用 `WRITE_WITH_IMM` 才知道数据到了

### RDMA READ（单边）

- 发送 READ Request → 对端回 READ Response 携带数据 → 本端 ACK
- 会**占住发送队列**：同一批读必须等响应全部到齐
- 更依赖被读端的内存与网卡性能

### ATOMIC（单边）

- 支持 **Compare & Swap** 和 **Fetch & Add**
- 64 位读改写，在被访问网卡内部原子完成
- 要求远端地址 8 字节对齐

### WRITE_WITH_IMM（折中）

数据单边写入，额外带 32 位立即数，在对端产生 `IBV_WC_RECV_RDMA_WITH_IMM` 完成事件 ——「写完了，顺便敲一下门」。

**这是构建生产者/消费者队列最常用的原语。**

### 什么时候用哪种

真实系统总是配合使用：

- **控制面走 SEND**（交换地址、rkey、QPN 等元数据）
- **数据面走 WRITE / READ**（单边，延迟低）

---

## 8. 报文结构

### RoCEv2 帧格式

```
┌──────┬───────┬────────────┬───────┬───────┬─────────┬──────┬─────┐
│ Eth  │ IPv4  │  UDP:4791  │  BTH  │ RETH  │ Payload │ ICRC │ FCS │
│ 14 B │ 20 B  │    8 B     │ 12 B  │ 16 B  │ ≤ PMTU  │ 4 B  │ 4 B │
└──────┴───────┴────────────┴───────┴───────┴─────────┴──────┴─────┘
```

| 段 | 大小 | 说明 |
|---|---|---|
| Eth | 14 B | 目的/源 MAC + EtherType（`0x0800`） |
| IPv4 | 20 B | Protocol = 17 (UDP)，路由靠它，RoCE 能跨三层 |
| UDP | 8 B | 目的端口固定 **4791**，源端口由硬件按 QP 哈希（ECMP 熵） |
| BTH | 12 B | 每包都有 |
| RETH | 16 B | 仅 WRITE/READ 首包：远端地址 64b + rkey 32b + 长度 32b |
| Payload | ≤ PMTU | 纯数据 |
| ICRC | 4 B | 覆盖 BTH 到 payload，防头部被转发过程改写 |
| FCS | 4 B | 以太帧校验，由 PHY 计算 |

> **RoCE 同时有 FCS 和 ICRC**：前者防线路错误，后者防转发中头部被改。

### BTH 位布局（12 字节）

| 字 | 字段 | 位宽 | 说明 |
|---|---|---|---|
| 1 | opcode | 8 | 高 3 位选服务，低 5 位选操作 |
| | SE | 1 | Solicited Event |
| | M | 1 | Migration，正常恒 0 |
| | PadCnt | 2 | 补齐到 4 字节的字节数（0–3） |
| | TVer | 4 | 传输头版本，当前 0 |
| | P_Key | 16 | 分区键，租户隔离 |
| 2 | Reserved | 8 | 置 0 |
| | Dest QP | 24 | 目的 QPN，投递依据 |
| 3 | A | 1 | 请求确认 |
| | Reserved | 7 | 置 0 |
| | PSN | 24 | 包序号 |

### Opcode 编码规律

```
高 3 位：000 = RC, 001 = UC, 010 = RD, 011 = UD
低 5 位：具体操作 + 分片位置
```

基址：RC `0x00`、UC `0x20`、RD `0x40`、UD `0x60`。解析器只要看 `opcode >> 5` 就知道用哪种服务。

### RC Opcode 表（常用）

| Opcode | 操作 | 头 |
|---|---|---|
| `0x00` | SEND First | BTH |
| `0x01` | SEND Middle | BTH |
| `0x02` | SEND Last | BTH |
| `0x03` | SEND Last with Immediate | BTH + ImmDt |
| `0x04` | SEND Only | BTH |
| `0x05` | SEND Only with Immediate | BTH + ImmDt |
| `0x06` | RDMA WRITE First | BTH + RETH |
| `0x07` | RDMA WRITE Middle | BTH |
| `0x08` | RDMA WRITE Last | BTH |
| `0x09` | RDMA WRITE Last with Immediate | BTH + ImmDt |
| `0x0A` | RDMA WRITE Only | BTH + RETH |
| `0x0B` | RDMA WRITE Only with Immediate | BTH + RETH + ImmDt |
| `0x0C` | RDMA READ Request First | BTH + RETH |
| `0x0D` | RDMA READ Request Last | BTH |
| `0x0E` | RDMA READ Request Only | BTH + RETH |
| `0x0F` | RDMA READ Response First | BTH |
| `0x10` | RDMA READ Response Middle | BTH |
| `0x11` | RDMA READ Response Last | BTH |
| `0x12` | RDMA READ Response Only | BTH |
| `0x13` | ACKNOWLEDGE | BTH + AETH |
| `0x14` | ATOMIC Acknowledge | BTH + AETH |
| `0x15` | **COMPARE SWAP** | BTH + AtomicETH |
| `0x16` | **FETCH ADD** | BTH + AtomicETH |

> 注意 `0x15` / `0x16` 的顺序，很多博客把这三个写反。

### UC / RD / UD 常用

| Opcode | 操作 |
|---|---|
| `0x20`–`0x25` | UC SEND First / Middle / Last / Last-Imm / Only / Only-Imm |
| `0x26`–`0x29` | UC WRITE First / Middle / Last / Only |
| `0x4A` | RD WRITE Only |
| `0x4E` | RD READ Request Only |
| `0x53` | RD ACKNOWLEDGE |
| `0x64` | UD SEND Only（BTH + DETH） |
| `0x65` | UD SEND Only with Immediate（BTH + DETH + ImmDt） |

---

## 9. 分片与 PMTU

超过 PMTU 的消息被网卡切成首包、中间包、尾包：

```
消息 16 KB, PMTU 4096:
  First  (RETH) 4096 B
  Middle        4096 B
  Middle        4096 B
  Last          4096 B
```

### 头部开销

每包固定开销：

```
Eth 14 + IPv4 20 + UDP 8 + BTH 12 + ICRC 4 + FCS 4 = 62 B
```

| PMTU | 有效载荷占比 |
|---|---|
| 4096 | **98.5%**（开销 1.49%） |
| 1024 | 94.3% |
| 256 | 80.5% |

### PMTU 取值

`256 / 512 / 1024 / 2048 / 4096`，两端必须一致。RoCEv2 常配 9000 字节巨型帧（MTU 需整链路一致）。

### 权衡

- PMTU 越大 → 头部开销越小
- PMTU 越大 → 单包延迟与抖动越大、丢包代价越高

---

## 10. 可靠性：PSN 与重传

### 机制

- 每个报文有 24 位 PSN，递增
- 接收端发现跳号 → 回 NAK
- 发送端从缺口起重发

### 两种重传机制

| 机制 | 触发 | 参数 |
|---|---|---|
| 超时重传 | 本地确认超时 | `timeout`（4.096 µs × 2^n）、`retry_cnt` |
| NAK 重传 | 收到 NAK | 立即触发 |

### AETH syndrome

| 值 | 含义 | 场景 |
|---|---|---|
| `0x00` | ACK | 正常确认，MSN 表示最新完整消息 |
| `0x01` | RNR NAK | 接收队列无可用 RECV WR |
| `0x60` | 无效请求 / 序号错误 | PSN 跳号、opcode 与 QP 状态不符 |
| `0x61` | 远端访问错误 | rkey 无效、权限不足、地址越界 |
| `0x62` | 远端无效 RD 请求 | 不支持的 READ 组合 |
| `0x63` | 远端操作错误 | 对端内部错误 |
| `0x64` | 无效 RD 请求 | RD 服务下的非法请求 |

### go-back-N

**RC 用 go-back-N，不是选择重传。** 一个包丢了，它之后的包即使已经到达也会被丢弃并重发。

后果：高丢包率下 PMTU 太小会显著放大重传流量。

### 重试参数

- `timeout` 按 RTT 量级设置
- `retry_cnt = 7` 表示无限重试，调试期先用 7
- `rnr_retry = 7` 同上
- 三者都设太小 → 链路稍抖 QP 就进 ERROR，所有未完成 WR 变 `IBV_WC_WR_FLUSH_ERR`

---

## 11. 拥塞控制与无损以太

### IB vs RoCE 的根本差别

| | InfiniBand | RoCEv2 |
|---|---|---|
| 流控 | 逐跳**信用制** | 逐跳 **PFC 暂停** |
| 原理 | 接收方有多少缓冲就发多少信用 | 发 PAUSE 让上游停 |
| 结果 | 永远不会溢出 | 只能刹车，不能预约 |
| 配置复杂度 | 低 | 高 |

### PFC（802.1Qbb）

按优先级发 PAUSE 帧，把「丢包」换成「排队」。

**问题：**
- 反压会向上游传播 → 链式反压
- 配置成环 → **PFC 死锁**，整片网络停摆

**实践：** 把 PFC 限制在一个专用优先级上，只对 RoCE 流量开启。

### ECN + DCQCN

```
交换机队列超 Kmin → 按概率打 CE 标记
   → 接收端网卡看到 CE → 生成 CNP 回发
      → 发送端按 α 降速
         → 无 CNP 时按定时器慢慢升回
```

| 队列占用 | 行为 |
|---|---|
| < Kmin (30%) | 不标记，全速 |
| Kmin – Kmax (30–70%) | 按概率标记 CE |
| > Kmax (70%) | 全部打 CE |
| 接近满 + PFC | PAUSE 暂停 |
| 接近满 + 无 PFC | **丢包 → 重传风暴** |

α 随 CNP 密度增长，避免对单个标记反应过度。

---

## 12. 性能与调优

### 瓶颈随消息规模变化

| 消息规模 | 主导因素 | 现象 | 对策 |
|---|---|---|---|
| ≤ 256 B | 延迟 + 消息率 (Mpps) | 带宽远低于线速，CPU 单核打满 | inline 发送、减少 WR 数量、多 QP 分散多核 |
| 1–4 KB | 延迟与每包开销 | 刚好一个 PMTU，效率 98.5% | 确认 PMTU=4096；小消息合并 |
| 64 KB | 在途请求数 (window) | 单 QP 跑不满 | 增加 outstanding WR / `max_rd_atomic`，或多 QP |
| ≥ 1 MB | PCIe 与内存带宽 | 多流并发后总带宽不增长 | 看 PCIe 代际/通道、NUMA 亲和、DMA 写合并 |

### 调优清单

1. **预注册内存**，把 `ibv_reg_mr` 移出热路径；动态缓冲用 MW 或 ODP
2. **选择性 signaling**：只给需要确认的 WR 设 `IBV_SEND_SIGNALED`
3. **批量 poll**：`ibv_poll_cq` 一次取 16–32 条；专用轮询核绑核，关 C-state 与中断
4. **PMTU 拉到 4096**，确认交换机 MTU 与两端一致
5. **多 QP 打散**：单 QP 受发送窗口限制；注意 QP 到核的亲和性
6. **超时与重试**：`timeout` 按 RTT 设，调试期 `retry_cnt=7`、`rnr_retry=7`

### 症状对照

| 症状 | 先查什么 |
|---|---|
| `IBV_WC_WR_FLUSH_ERR` | QP 已进 ERROR，通常重试耗尽；看对端为何没回 ACK |
| `IBV_WC_REM_ACCESS_ERR` | rkey 不匹配、权限不足、地址越界、跨 PD |
| 吞吐只有预期一半 | 单 QP 窗口不足、PMTU 被协商成 1024、PCIe 不是 x16、跨 NUMA |
| 延迟周期性抖动 | 中断合并、CPU 降频、C-state、抢核 |
| 偶发 RNR 重传 | 接收端 post_recv 不及时，或 SRQ 深度不够 |

---

## 13. verbs 编程骨架

### 资源与内存

```c
#include <infiniband/verbs.h>

struct ibv_device **list = ibv_get_device_list(NULL);
struct ibv_context *ctx  = ibv_open_device(list[0]);
struct ibv_pd        *pd = ibv_alloc_pd(ctx);
struct ibv_cq        *cq = ibv_create_cq(ctx, 256, NULL, NULL, 0);

struct ibv_qp_init_attr qa = {
  .send_cq = cq, .recv_cq = cq,
  .cap = { .max_send_wr  = 128, .max_recv_wr  = 128,
           .max_send_sge = 1,   .max_recv_sge = 1 },
  .qp_type = IBV_QPT_RC,
};
struct ibv_qp *qp = ibv_create_qp(pd, &qa);

/* 注册一次，长期复用 */
struct ibv_mr *mr = ibv_reg_mr(pd, buf, len,
        IBV_ACCESS_LOCAL_WRITE  |
        IBV_ACCESS_REMOTE_WRITE |
        IBV_ACCESS_REMOTE_READ);
```

### QP 状态迁移

```c
struct ibv_qp_attr a = {0};
int mask;

/* INIT */
a.qp_state        = IBV_QPS_INIT;
a.pkey_index      = 0;
a.port_num        = 1;
a.qp_access_flags = IBV_ACCESS_REMOTE_WRITE | IBV_ACCESS_REMOTE_READ;
mask = IBV_QP_STATE | IBV_QP_PKEY_INDEX | IBV_QP_PORT | IBV_QP_ACCESS_FLAGS;
ibv_modify_qp(qp, &a, mask);

/* RTR */
memset(&a, 0, sizeof a);
a.qp_state           = IBV_QPS_RTR;
a.path_mtu           = IBV_MTU_4096;
a.dest_qp_num        = remote_qpn;
a.rq_psn             = 0;
a.max_dest_rd_atomic = 1;
a.min_rnr_timer      = 12;
a.ah_attr.is_global  = 1;
a.ah_attr.port_num   = 1;
a.ah_attr.grh.dgid   = remote_gid;
a.ah_attr.grh.sgid_index = gid_index;   /* 决定 RoCEv1 还是 v2 */
mask = IBV_QP_STATE | IBV_QP_AV | IBV_QP_PATH_MTU | IBV_QP_DEST_QPN |
       IBV_QP_RQ_PSN | IBV_QP_MAX_DEST_RD_ATOMIC | IBV_QP_MIN_RNR_TIMER;
ibv_modify_qp(qp, &a, mask);

/* RTS */
memset(&a, 0, sizeof a);
a.qp_state      = IBV_QPS_RTS;
a.sq_psn        = 0;
a.timeout       = 14;
a.retry_cnt     = 7;
a.rnr_retry     = 7;
a.max_rd_atomic = 1;
mask = IBV_QP_STATE | IBV_QP_SQ_PSN | IBV_QP_TIMEOUT |
       IBV_QP_RETRY_CNT | IBV_QP_RNR_RETRY | IBV_QP_MAX_QP_RD_ATOMIC;
ibv_modify_qp(qp, &a, mask);
```

### 投递与轮询

```c
struct ibv_sge sge = {
  .addr   = (uintptr_t)buf,
  .length = len,
  .lkey   = mr->lkey,
};

struct ibv_send_wr wr = {0}, *bad = NULL;
wr.wr_id      = 42;                    /* 原样回到 CQE */
wr.opcode     = IBV_WR_RDMA_WRITE;
wr.send_flags = IBV_SEND_SIGNALED;
wr.sg_list    = &sge;
wr.num_sge    = 1;
wr.wr.rdma.remote_addr = remote_addr;
wr.wr.rdma.rkey        = remote_rkey;

if (ibv_post_send(qp, &wr, &bad) != 0) { /* 检查 bad 指向哪条 WR */ }

struct ibv_wc wc;
while (ibv_poll_cq(cq, 1, &wc) == 0) { /* busy poll */ }

if (wc.status != IBV_WC_SUCCESS) {
  fprintf(stderr, "wr %lu failed: %s\n",
          (unsigned long)wc.wr_id, ibv_wc_status_str(wc.status));
}
```

---

## 14. 端到端模式：WRITE_WITH_IMM ring buffer

### 为什么普通 WRITE 不够

普通 RDMA WRITE 是**静默的**：数据写进对端内存，对端收不到任何事件，只能自己轮询标志位。

加 IMM 之后：网卡写完数据额外生成一条 CQE，把 32 位立即数送到消费者的完成队列。

**数据到达与通知到达是原子的** —— 不存在「数据没落盘就收到通知」的窗口。

### 设计要点

1. **环槽序号放在立即数里**，不放记录头 → 消费者不读内存就知道处理哪个槽
2. 立即数通常编码：索引 / 长度 / 标志位 —— 它是唯一能随完成事件一起送达的信息
3. 消费者**从没 post 过 recv WR**，只在 CQ 上等
4. 反向再开一条 QP 回传信用，构成完整闭环

### 消费者

```c
/* 启动时 post 一批 recv WR 接收 IMM 通知 */
for (int i = 0; i < DEPTH; i++) {
  struct ibv_recv_wr rwr = {0};
  struct ibv_sge rsge = { .addr = (uintptr_t)&cbuf[i], .length = 1,
                          .lkey = cmr->lkey };
  rwr.wr_id = i;
  rwr.sg_list = &rsge;
  rwr.num_sge = 1;
  ibv_post_recv(cqp, &rwr, &bad);
}

/* 主循环：唯一阻塞点是 CQ，不是内存 */
while (running) {
  struct ibv_wc wc;
  if (ibv_poll_cq(ccq, 1, &wc) == 0) continue;
  if (wc.opcode == IBV_WC_RECV_RDMA_WITH_IMM) {
    uint32_t slot = wc.imm_data;     /* 立即数 = 环槽序号 */
    process(&ring[slot]);
    head = (head + 1) % RING_SIZE;
  }
}
```

### 生产者

```c
struct ibv_send_wr w = {0};
w.wr_id      = slot;
w.opcode     = IBV_WR_RDMA_WRITE_WITH_IMM;
w.imm_data   = slot;                 /* 32 位，随完成事件送达 */
w.send_flags = IBV_SEND_SIGNALED;
w.sg_list    = &dsge;
w.num_sge    = 1;
w.wr.rdma.remote_addr = ring_addr + slot * RECORD_SIZE;
w.wr.rdma.rkey        = ring_rkey;
ibv_post_send(qp, &w, &bad);
```

### 流控

- 环深度 8，发送窗口 3 —— 窗口应小于环深度，让「窗口用尽」先于「环满」发生
- 窗口用尽 → `post_send` 返回 `ENOMEM`
- 环满 → 消费者必须先取走
- 真实系统：`max_send_wr` 通常远小于对端能容纳的消息数，**瓶颈在网卡在途请求表，不在内存**

---

## 15. 排障速查

| CQE status | 含义 | 常见原因 |
|---|---|---|
| `IBV_WC_SUCCESS` | 成功 | — |
| `IBV_WC_LOC_LEN_ERR` | 本地长度错误 | sge 长度超过 MR |
| `IBV_WC_LOC_ACCESS_ERR` | 本地访问错误 | lkey 无效 |
| `IBV_WC_REM_ACCESS_ERR` | 远端访问错误 | rkey 无效/权限不足/越界/跨 PD |
| `IBV_WC_REM_INV_REQ_ERR` | 远端无效请求 | opcode 与状态不符、PSN 跳号 |
| `IBV_WC_RNR_RETRY_EXC_ERR` | RNR 重试耗尽 | 对端一直没 post_recv |
| `IBV_WC_RETRY_EXC_ERR` | 重试耗尽 | 对端不可达、链路问题 |
| `IBV_WC_WR_FLUSH_ERR` | 队列冲刷 | QP 已进 ERROR |

### 诊断顺序

1. `ibv_devinfo -v` 确认端口状态 `PORT_ACTIVE`、GID 表正确
2. 两端 `path_mtu`、`rq_psn`、`sq_psn` 是否一致
3. 确认 RTR 前已 post_recv
4. `tcpdump -i <if> udp port 4791` 看报文是否真的发出
5. 检查 PFC/ECN 配置与 P_Key

---

## 16. 动手实验

### soft-RoCE（无硬件也能练）

```bash
# 创建软件 RDMA 设备（内核需 CONFIG_RDMA_RXE）
sudo rdma link add rxe0 type rxe netdev eth0

# 确认设备与 GID
ibv_devices
ibv_devinfo -d rxe0 -v
```

### 性能测试

```bash
# 双边 WRITE 带宽
ib_write_bw -d rxe0 -s 4096 -n 10000

# 延迟
ib_write_lat -d rxe0

# 对比双边 SEND（体会接收端 CPU 的作用）
ib_send_bw -d rxe0
ib_send_lat -d rxe0
```

### 抓包对照

```bash
tcpdump -i eth0 udp port 4791 -XX
```

对照第 8 节逐字节读 BTH。

---

## 17. 术语表

| 术语 | 说明 |
|---|---|
| **CTX** | `ibv_context`，设备句柄，所有资源的根 |
| **PD** | 保护域，对象隔离边界 |
| **MR** | 已注册内存，pin 住物理页并赋予 lkey/rkey |
| **MW** | 内存窗口，在 MR 上临时切出的一段 |
| **lkey** | 本地键，用在 WQE 的 sge 里 |
| **rkey** | 远端键，随 RETH 发到对端 |
| **QP** | 队列对，SQ + RQ + 连接状态 + PSN 计数器 |
| **QPN** | QP 号，24 位，BTH 用它寻址 |
| **SQ / RQ** | 发送队列 / 接收队列 |
| **WQE** | 工作队列元素，一条待执行请求 |
| **WR** | 工作请求，`post_send` / `post_recv` 提交的描述符 |
| **CQ / CQE** | 完成队列及其条目 |
| **SRQ** | 共享接收队列 |
| **AH** | 地址句柄，UD 目的地址封装 |
| **BTH** | 12 B 基础传输头：opcode、QPN、PSN |
| **RETH** | 16 B RDMA 扩展头：远端地址、rkey、长度 |
| **AETH** | 确认头，携带 syndrome 与 MSN |
| **DETH** | 数据报扩展头，UD 用 |
| **ImmDt** | 立即数头，4 字节 |
| **ICRC** | 不变 CRC，覆盖 IB 头与负载 |
| **PSN** | 包序号，24 位 |
| **MSN** | 消息序号，「已完整收到第几条消息」 |
| **NAK** | 否定确认，带 syndrome |
| **RNR** | Receiver Not Ready |
| **go-back-N** | 从缺失 PSN 起重发其后全部报文 |
| **PMTU** | 路径 MTU，256–4096 |
| **RC/UC/UD** | 可靠连接 / 不可靠连接 / 不可靠数据报 |
| **DC/DCT** | 动态连接及其目标号 |
| **XRC** | 扩展可靠连接，共享接收 QP |
| **RoCEv2** | RDMA over Converged Ethernet v2，UDP 4791 |
| **PFC** | 优先级流控（802.1Qbb） |
| **ECN / DCQCN** | 显式拥塞通知 / 数据中心量化拥塞通知 |
| **GID / LID** | 全局标识（IPv6 形式）/ 本地标识 |
| **ODP** | 按需分页 |
| **inline** | 小消息内联进 WQE，省一次 DMA 读 |

---

## 参考资料

- InfiniBand Architecture Specification Vol.1 — 传输层（BTH/AETH/RETH、QP 状态机、opcode 表）
- Linux 内核 `include/rdma/ib_verbs.h`
- rdma-core 手册页：`ibv_reg_mr`、`ibv_modify_qp`、`ibv_post_send`
- RoCEv2 规范：UDP 4791、无损以太、DCQCN
