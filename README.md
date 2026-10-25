# RDMA 底层手册

一个交互式的 RDMA 学习站点，配合一份可查阅的 Markdown 笔记。把 RDMA 传输层拆到最底层：保护域与内存键如何授权一次远端写入，队列对怎样进入可发送状态，一个 WQE 如何变成 RoCEv2 报文，丢包之后由谁重传。

## 内容

站点共 15 个模块，每一节都能动手操作：

| # | 模块 | 交互 |
|---|---|---|
| 01 | 为什么是 RDMA | 内核 TCP 与 RDMA 两条路径逐跳对比，可播放 |
| 02 | 对象模型 | 七个对象点选说明 + PD 从属关系图 |
| 03 | 内存注册与 key | 勾选访问标志，选操作看网卡放行还是回 NAK |
| 04 | QP 状态机 | RESET→INIT→RTR→RTS 点击查看能力与必设属性 |
| 05 | 传输类型 | RC / UC / UD / RD / XRC / DC 对照 |
| 06 | 一次 post_send 的旅程 | 八步流水线，逐步或自动播放 |
| 07 | 四种操作语义 | SEND / WRITE / READ / ATOMIC 时序图 |
| 08 | 报文解剖 | 帧分段、BTH 按位拆解、opcode 按服务过滤 |
| 09 | 分片与 PMTU | 改消息长度实时算报文数与头部开销 |
| 10 | 可靠性与重传 | PSN 丢失现场重演 + NAK syndrome 表 |
| 11 | 拥塞控制 | 拖动队列深度看 ECN 标记、PFC 反压、丢包 |
| 12 | 性能心智模型 | 消息规模瓶颈表、调优清单、症状对照 |
| 13 | verbs 编程骨架 | 三段可编译的 C 代码 |
| 14 | 端到端 ring buffer | WRITE_WITH_IMM 生产者/消费者队列演示 |
| 15 | 术语与动手实验 | 可搜索术语表 + soft-RoCE 实验命令 |

`RDMA-notes.md` 是与站点内容对应的 Markdown 笔记，适合离线查阅和复习。

## 运行

站点是纯静态的，没有构建步骤、没有外部依赖。

```bash
python3 -m http.server 8000
```

打开 `http://localhost:8000`。

直接双击 `index.html` 也可以，外链脚本在 `file://` 下正常加载。

## 文件

```
index.html       页面结构与样式
app.js           全部交互逻辑（Vanilla JS，无框架）
RDMA-notes.md    学习笔记
```

## 说明

所有图示为示意，字段宽度与报文比例以 IBTA 规范 Vol.1 为准。性能数字随网卡代际、固件与配置变化，仅用于建立量级直觉。

参考资料：InfiniBand Architecture Specification Vol.1（传输层 BTH/AETH/RETH、QP 状态机、opcode 表）、Linux `include/rdma/ib_verbs.h`、rdma-core 手册页、RoCEv2 规范。
