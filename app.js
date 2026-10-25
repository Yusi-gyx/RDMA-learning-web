/* RDMA 手册交互逻辑 —— 无外部依赖 */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  /* ---------------- 目录与进度 ---------------- */
  var tocBtn = $('#tocBtn'), toc = $('#toc');
  tocBtn.addEventListener('click', function () {
    var open = tocBtn.getAttribute('aria-expanded') === 'true';
    tocBtn.setAttribute('aria-expanded', String(!open));
    if (open) { toc.hidden = true; } else { toc.hidden = false; }
  });
  toc.addEventListener('click', function (e) {
    if (e.target.closest('a')) { toc.hidden = true; tocBtn.setAttribute('aria-expanded', 'false'); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !toc.hidden) { toc.hidden = true; tocBtn.setAttribute('aria-expanded', 'false'); tocBtn.focus(); }
  });
  var prog = $('#prog');
  function onScroll() {
    var h = document.documentElement.scrollHeight - window.innerHeight;
    prog.style.width = (h > 0 ? Math.min(100, (window.scrollY / h) * 100) : 0) + '%';
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------------- 01 旅程 ---------------- */
  var ROUTES = {
    tcp: [
      ['write() 系统调用', '陷入内核，检查参数与 socket 状态', '内核'],
      ['数据拷入内核 sk_buff', '用户缓冲区 → 内核发送缓冲区', '内存'],
      ['协议栈逐层封装', 'TCP 分段、IP 头、校验和计算', '内核'],
      ['入队网卡驱动，触发发送', 'DMA 描述符、锁、中断', '内核'],
      ['网卡 DMA 读取帧并发出', '内核缓冲区 → 线路', '硬件'],
      ['对端中断 → 软中断', '硬中断收包，软中断走协议栈', 'CPU'],
      ['内核缓冲区 → 用户缓冲区', '第二次拷贝，查表、重组', '内存'],
      ['唤醒阻塞的进程', '调度器把 CPU 交还给应用', '调度']
    ],
    rdma: [
      ['应用写 WQE 到共享内存', 'wr_id、opcode、remote_addr、rkey', '用户态'],
      ['写 doorbell 寄存器', '一次 MMIO，不陷入内核', '硬件'],
      ['网卡读 WQE，DMA 取数据', '按 lkey 查翻译表、取物理页', '硬件'],
      ['硬件封装 BTH / RETH', '填 QPN、PSN、远端地址', '硬件'],
      ['报文上线', 'Eth + IP + UDP 4791 + IB 头', '线路'],
      ['对端网卡校验 ICRC', '硬件检查帧完整性与 QP 上下文', '硬件'],
      ['按 rkey 直接 DMA 写入应用缓冲区', '对端 CPU 全程不参与', '硬件'],
      ['ACK 回传，CQE 出现在 CQ', '应用 poll_cq 取到完成', '硬件']
    ]
  };
  var journeyEl = $('#journey'), routeKey = 'tcp', playTimer = null, playIdx = 0;
  function renderJourney() {
    var rows = ROUTES[routeKey];
    journeyEl.innerHTML = rows.map(function (r, i) {
      var side = r[2];
      var cls = side === '硬件' || side === '线路' ? 'pill a' : (side === '用户态' ? 'pill b' : 'pill');
      return '<div class="jrow" data-i="' + i + '">' +
        '<span class="n">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="t"><b>' + esc(r[0]) + '</b> · ' + esc(r[1]) + '</span>' +
        '<span class="tags"><span class="' + cls + '">' + esc(side) + '</span></span>' +
        '</div>';
    }).join('');
  }
  function setRoute(k) {
    routeKey = k;
    $('#jmTcp').setAttribute('aria-pressed', String(k === 'tcp'));
    $('#jmRdma').setAttribute('aria-pressed', String(k === 'rdma'));
    renderJourney();
    if (playTimer) { stopPlay(); }
  }
  function stopPlay() {
    clearInterval(playTimer); playTimer = null; playIdx = 0;
    $('#jmPlay').textContent = '播放';
    $$('.jrow', journeyEl).forEach(function (r) { r.classList.remove('act'); });
  }
  $('#jmTcp').addEventListener('click', function () { setRoute('tcp'); });
  $('#jmRdma').addEventListener('click', function () { setRoute('rdma'); });
  $('#jmPlay').addEventListener('click', function () {
    if (playTimer) { stopPlay(); return; }
    var rows = $$('.jrow', journeyEl);
    playIdx = 0;
    this.textContent = '暂停';
    playTimer = setInterval(function () {
      rows.forEach(function (r) { r.classList.remove('act'); });
      if (playIdx >= rows.length) { stopPlay(); return; }
      rows[playIdx].classList.add('act');
      playIdx++;
    }, 620);
  });
  renderJourney();

  /* ---------------- 02 对象 ---------------- */
  var OBJS = [
    { k: 'PD', name: '保护域', sub: 'struct ibv_pd', d: '一个隔离容器：同一个 PD 里的对象才能互相访问。它的本质是网卡里的一张区域表条目，注册内存和创建 QP 都挂在它下面。', kv: [['创建', 'ibv_alloc_pd(ctx)'], ['粒度', '每个进程通常一个'], ['约束', '跨 PD 的 rkey 一律判访问错误']] },
    { k: 'MR', name: '内存区域', sub: 'struct ibv_mr', d: '被注册并 pin 住的虚拟内存。注册时驱动建立 MTT/MPT，把虚拟页映射成网卡可寻址的物理地址，并一次性写入允许的远端操作。', kv: [['创建', 'ibv_reg_mr(pd, addr, len, flags)'], ['返回', 'lkey（本端）· rkey（给对端）'], ['代价', '与页数成正比，别放在热路径']] },
    { k: 'QP', name: '队列对', sub: 'struct ibv_qp', d: '一对发送队列（SQ）与接收队列（RQ），加上一整套状态和计数器（PSN、重传、超时）。它是连接本身，硬件每次收发都按 QPN 找到这个上下文。', kv: [['标识', 'QPN，24 位'], ['状态', 'RESET → INIT → RTR → RTS → ERROR'], ['容量', '创建时确定 max_send_wr / max_recv_wr']] },
    { k: 'CQ', name: '完成队列', sub: 'struct ibv_cq', d: '完成事件队列。每个 WR 完成后放进一条 CQE：状态、长度、wr_id。一个 CQ 可以被多个 QP 共享，也是唯一的异步结果来源。', kv: [['创建', 'ibv_create_cq(ctx, cqe, ctx, channel, comp_vector)'], ['读取', 'ibv_poll_cq(cq, n, &wc)'], ['注意', '消费后必须归还（poll 即归还）']] },
    { k: 'SRQ', name: '共享接收队列', sub: 'struct ibv_srq', d: '多个 QP 共用一份接收 WR 池。为“服务端有几千个连接但不知道谁会先来消息”的场景准备，省掉每个 QP 各配一队接收缓冲的浪费。', kv: [['使用', 'QP 创建时 qp_type 配 IBV_QPT_RC + srq'], ['CQE', '带 qp_num 字段区分来源'], ['限制', 'UD 的接收也要靠 SRQ 才现实']] },
    { k: 'AH', name: '地址句柄', sub: 'struct ibv_ah', d: 'UD 传输的目的地址封装：GRH（全局路由头）里的 GID、服务级别、端口。因为 UD 无连接，每条消息都要靠它指明去哪。', kv: [['创建', 'ibv_create_ah(pd, &ah_attr)'], ['内容', 'dgid、sgid_index、flow_label、hop_limit'], ['用于', 'UD 发送与多播加入']] },
    { k: 'MW', name: '内存窗口', sub: 'struct ibv_mw', d: '在一块已注册的 MR 上临时切出一段，分配一个新的 rkey，用完销毁。用于把大块内存零拷贝地、按需授权给不同对端，而不必反复注册。', kv: [['创建', 'ibv_alloc_mw(pd, IBV_MW_TYPE_2)'], ['授权', 'ibv_bind_mw(qp, mw, &bind_info)'], ['收益', '避免重注册，权限可快速吊销']] }
  ];
  var chipsEl = $('#objChips'), panelEl = $('#objPanel');
  chipsEl.innerHTML = OBJS.map(function (o, i) {
    return '<button class="chip" data-o="' + i + '" aria-pressed="' + (i === 2 ? 'true' : 'false') + '">' + o.k + '</button>';
  }).join('');
  function showObj(i) {
    var o = OBJS[i];
    $$('.chip', chipsEl).forEach(function (c) {
      c.setAttribute('aria-pressed', String(Number(c.dataset.o) === i));
    });
    panelEl.innerHTML = '<h4>' + esc(o.name) + ' <span class="pill a">' + o.k + '</span></h4>' +
      '<div class="sub">' + esc(o.sub) + '</div>' +
      '<p>' + esc(o.d) + '</p>' +
      '<div class="kv">' + o.kv.map(function (kv) {
        return '<div><span class="k">' + esc(kv[0]) + '</span><span class="v">' + esc(kv[1]) + '</span></div>';
      }).join('') + '</div>';
  }
  chipsEl.addEventListener('click', function (e) {
    var b = e.target.closest('.chip'); if (b) showObj(Number(b.dataset.o));
  });
  showObj(2);

  /* ---------------- 03 权限 ---------------- */
  var FLAGS = [
    ['IBV_ACCESS_LOCAL_WRITE', '允许对端 SEND 写入本端缓冲区', false],
    ['IBV_ACCESS_REMOTE_WRITE', '允许对端 RDMA WRITE 写入', false],
    ['IBV_ACCESS_REMOTE_READ', '允许对端 RDMA READ 读取', false],
    ['IBV_ACCESS_REMOTE_ATOMIC', '允许对端 ATOMIC 操作', false],
    ['IBV_ACCESS_RELAXED_ORDERING', '放宽 PCIe 读写顺序，提升吞吐', false],
    ['IBV_ACCESS_ON_DEMAND', '按需分页（ODP），不预先 pin', false]
  ];
  var flagWrap = $('#flags');
  flagWrap.innerHTML = FLAGS.map(function (f, i) {
    return '<label class="flag"><input type="checkbox" data-f="' + i + '"><span>' + esc(f[1].replace(/（.*?）/g, '')) +
      '<code>' + esc(f[1]) + '</code></span></label>';
  }).join('');
  var OPS = {
    read: { need: 2, name: 'RDMA READ', detail: '对端网卡要读你内存里的数据' },
    write: { need: 1, name: 'RDMA WRITE', detail: '对端网卡要往你内存里写数据' },
    atomic: { need: 3, name: 'ATOMIC', detail: '对端要在你内存上做读改写' },
    send: { need: -1, name: '本地 SEND', detail: '数据从本端内存发出，不涉及远端权限' }
  };
  var flagResult = $('#flagResult');
  function checkFlags(op) {
    var on = $$('input', flagWrap).map(function (el) { return el.checked; });
    var o = OPS[op];
    refreshFlagPills();
    if (o.need === -1) {
      flagResult.className = 'result ok';
      flagResult.innerHTML = '<b>允许</b>' + o.name + ' 是本地发起，读取本端缓冲区不需要任何远端访问权限。但若对端要 SEND 数据<b style="display:inline">进</b>来，那一侧必须带 IBV_ACCESS_LOCAL_WRITE。';
      return;
    }
    if (on[o.need]) {
      flagResult.className = 'result ok';
      flagResult.innerHTML = '<b>允许 · HCA 放行</b>' + o.name + ' 通过：rkey 命中翻译表，权限位 ' + FLAGS[o.need][0] + ' 已置位。';
    } else {
      flagResult.className = 'result bad';
      flagResult.innerHTML = '<b>拒绝 · IBV_WC_REM_ACCESS_ERR</b>' + o.name + ' 需要 ' + FLAGS[o.need][0] + '，当前注册标志里没有。对端网卡生成 AETH syndrome 0x61 的 NAK，请求方 QP 进入 ERROR。';
    }
  }
  function refreshFlagPills() {
    $$('.flag', flagWrap).forEach(function (l, i) {
      var cb = $('input', l);
      l.style.borderColor = cb.checked ? 'var(--a)' : '';
      l.style.background = cb.checked ? 'var(--a-soft)' : '';
    });
  }
  flagWrap.addEventListener('change', refreshFlagPills);
  $('#opBtns').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-op]'); if (b) checkFlags(b.dataset.op);
  });

  /* ---------------- 04 状态机 ---------------- */
  var FSM = {
    RESET: {
      ops: ['队列被清空，所有未完成 WR 作废', '不可发送、不可接收', 'QPN 与资源仍然保留'],
      attrs: ['进入：ibv_modify_qp(qp, &a, IBV_QP_STATE)', '通常仅设置 qp_state 即可回到初始'],
      pit: '<b>注意</b>回到 RESET 常用于错误恢复，但连接参数会全部丢失，需要重新走 INIT → RTR → RTS。'
    },
    INIT: {
      ops: ['可以 post_recv，但报文不会到达', '仍不能发送'],
      attrs: ['IBV_QP_PKEY_INDEX', 'IBV_QP_PORT', 'IBV_QP_ACCESS_FLAGS（远端可做的操作）'],
      pit: '<b>第一个坑</b>不少驱动要求 INIT 之后、RTR 之前 post_recv，否则进入 RTR 时可能出现不可预期的 RNR。'
    },
    RTR: {
      ops: ['可以接收远端发来的请求', '仍不能主动发送'],
      attrs: ['IBV_QP_AV（目的 GID / LID、端口）', 'IBV_QP_PATH_MTU', 'IBV_QP_DEST_QPN', 'IBV_QP_RQ_PSN', 'IBV_QP_MAX_DEST_RD_ATOMIC', 'IBV_QP_MIN_RNR_TIMER'],
      pit: '<b>最贵的坑</b>path_mtu 两端不一致 → 大包被当成超长帧丢弃；rq_psn 不一致 → 第一个包就 NAK 0x60。'
    },
    RTS: {
      ops: ['收发全部可用', '可发起 RDMA READ / ATOMIC', '发送窗口按 max_send_wr 生效'],
      attrs: ['IBV_QP_SQ_PSN', 'IBV_QP_TIMEOUT', 'IBV_QP_RETRY_CNT', 'IBV_QP_RNR_RETRY', 'IBV_QP_MAX_QP_RD_ATOMIC'],
      pit: '<b>韧性参数</b>timeout 是 4.096 µs × 2^n；retry_cnt=7 为无限重试，调试期先用 7。'
    }
  };
  function showState(s) {
    $$('.fsm-node').forEach(function (n) { n.setAttribute('aria-pressed', String(n.dataset.state === s)); });
    var d = FSM[s];
    $('#fsmOps').innerHTML = d.ops.map(function (t) { return '<li>' + t + '</li>'; }).join('');
    $('#fsmAttrs').innerHTML = d.attrs.map(function (t) {
      return '<li><code>' + esc(t) + '</code></li>';
    }).join('');
    $('#fsmPit').className = 'result';
    $('#fsmPit').innerHTML = d.pit;
  }
  $('#fsm').addEventListener('click', function (e) {
    var n = e.target.closest('.fsm-node'); if (n) showState(n.dataset.state);
  });
  showState('RTS');

  /* ---------------- 05 传输服务 ---------------- */
  var TR = {
    RC: '<b>RC · 可靠连接</b>一个 QP 只对一条连接，硬件维护 PSN、ACK/NAK、重传与乱序重排。所有操作都支持，代价是每对通信双方都要一个 QP——在 N 节点 p 进程的集群里，QP 数量按 N·p² 增长，网卡缓存与连接表会先于带宽成为瓶颈。',
    UC: '<b>UC · 不可靠连接</b>同样一对一，但丢包就丢消息，没有 ACK、没有重传。只能 Send/Recv 与 RDMA Write，<b>不能 RDMA Read，也不能 Atomic</b>——因为读需要可靠的应答。实际部署很少见。',
    UD: '<b>UD · 不可靠数据报</b>一条 QP 可以发给任意目的地，靠 DETH 头里的目的 QPN 寻址；接收端靠 GRH 得知来源。代价：单条消息不能超过 PMTU，不能保证顺序，不能使用单边操作。典型用途是建连前的地址交换、多播与路由发现。',
    RD: '<b>RD · 可靠数据报</b>概念上把 RC 的可靠性带到数据报上，需要 EEC（扩展可靠连接）对象。实现复杂、厂商支持有限，市场上基本被 DC 取代。',
    XRC: '<b>XRC · 扩展可靠连接</b>把接收侧拆出来共享：一个进程可以发往多个进程，而所有连接共享同一个接收 QP。解决的是“服务端 QP 数量爆炸”，发送侧仍然每个连接一个。',
    DC: '<b>DC · 动态连接</b>发送时只写 DCT 号，由硬件在需要时建立连接上下文。应用面看不到建连过程，适合 GPU 集群里成千上万的通信对。需要 DC 能力的网卡与专门的 verbs 扩展。'
  };
  var trBody = $('#trBody'), trPanel = $('#trPanel');
  trBody.addEventListener('click', function (e) {
    var tr = e.target.closest('tr'); if (!tr) return;
    $$('tr', trBody).forEach(function (r) { r.setAttribute('aria-selected', String(r === tr)); });
    trPanel.className = 'result';
    trPanel.innerHTML = TR[tr.dataset.tr];
  });
  trBody.querySelector('tr').setAttribute('aria-selected', 'true');

  /* ---------------- 06 流水线 ---------------- */
  var STAGES = ['SQ', 'WQE', 'NIC', '线路', '对端', 'RQ', 'CQ'];
  var STEPS = [
    [1, '<b>准备 WQE。</b>把 wr_id、opcode、sg_list、remote_addr、rkey 填进工作请求结构。libibverbs 把它拷到你 mmap 出来的发送队列环形缓冲区的下一个槽位。'],
    [2, '<b>敲 doorbell。</b>对网卡的用户态寄存器做一次 64 位写，传入 SQ 的新尾指针。这是一次 MMIO，不陷入内核，约几十纳秒。'],
    [1, '<b>硬件读 WQE。</b>网卡 DMA 把描述符取进自己的缓存，按 lkey 查 MTT 翻译表，得到 sg_list 指向数据的物理页。'],
    [2, '<b>DMA 取数据并组包。</b>若消息超过 PMTU，硬件按 PMTU 切片，逐片填 BTH（QPN、PSN、opcode），首片附 RETH（remote_addr + rkey + 长度）。'],
    [3, '<b>上线。</b>RoCEv2 下依次套 UDP(4791)、IP、以太头，尾部加 ICRC 与 FCS。PSN 随包递增，写进网卡的发送计数器。'],
    [4, '<b>对端网卡校验。</b>检查 ICRC、P_Key、QPN 是否存在、PSN 是否连续、rkey 权限是否足够。任何一项不过就发 NAK。'],
    [5, '<b>直接写入内存。</b>按 RETH 的虚拟地址与 rkey 查对端翻译表，把负载 DMA 到应用缓冲区。对端 CPU、内核、页表全程不参与。'],
    [6, '<b>回 ACK，产生 CQE。</b>对端回 AETH 确认；本端网卡在本机 CQ 里写入一条 CQE（状态、长度、wr_id）。应用 poll_cq 取走。']
  ];
  var pipeEl = $('#pipe'), stepsEl = $('#steps'), curStep = -1, pipeTimer = null;
  pipeEl.innerHTML = STAGES.map(function (s, i) {
    return '<div class="stage" data-s="' + i + '"><b>' + esc(s) + '</b><span>' + ['发送队列', '工作请求', '本端网卡', '物理链路', '对端网卡', '接收队列', '完成队列'][i] + '</span></div>';
  }).join('');
  stepsEl.innerHTML = STEPS.map(function (s, i) {
    return '<div class="step" data-i="' + i + '"><span class="sn">' + String(i + 1).padStart(2, '0') + '</span><span>' + s[1] + '</span></div>';
  }).join('');
  function gotoStep(i) {
    var steps = $$('.step', stepsEl);
    curStep = Math.max(0, Math.min(STEPS.length - 1, i));
    steps.forEach(function (s, k) {
      s.classList.toggle('act', k === curStep);
      s.classList.toggle('dim', false);
    });
    var st = STEPS[curStep][0];
    $$('.stage', pipeEl).forEach(function (p, k) {
      p.classList.toggle('on', k === st);
      p.classList.toggle('dim', Math.abs(k - st) > 1);
    });
  }
  stepsEl.addEventListener('click', function (e) {
    var s = e.target.closest('.step'); if (s) { stopPipe(); gotoStep(Number(s.dataset.i)); }
  });
  function stopPipe() {
    if (pipeTimer) { clearInterval(pipeTimer); pipeTimer = null; $('#stPlay').textContent = '播放'; }
  }
  $('#stPlay').addEventListener('click', function () {
    if (pipeTimer) { stopPipe(); return; }
    this.textContent = '暂停';
    var i = curStep < 0 ? 0 : curStep;
    gotoStep(i);
    pipeTimer = setInterval(function () {
      i++;
      if (i >= STEPS.length) { stopPipe(); return; }
      gotoStep(i);
    }, 1500);
  });
  $('#stNext').addEventListener('click', function () { stopPipe(); gotoStep(curStep + 1); });
  $('#stPrev').addEventListener('click', function () { stopPipe(); gotoStep(curStep - 1); });
  gotoStep(0);

  /* ---------------- 07 时序图 ---------------- */
  var LADDER = {
    send: {
      items: [
        ['A2B', 'req', 'SEND 首包', 'BTH + 数据'],
        ['B2A', 'ack', 'ACK', ''],
        ['B2A', 'resp', '对端 post_recv 完成', '应用处理，可选回发'],
        ['A2B', 'ack', 'ACK', '']
      ],
      note: '<b>SEND 是双边操作。</b>发送方只能保证数据到了对端网卡的接收队列，<b>不保证对端应用已经读走</b>；对端必须事先 post_recv，否则收到 RNR NAK。消息长度不受 PMTU 限制，硬件自动分片。'
    },
    write: {
      items: [
        ['A2B', 'req', 'RDMA WRITE 首包', 'BTH + RETH + 数据'],
        ['B2A', 'ack', 'ACK', ''],
        ['A2B', 'req', '（中间包）', '只有 BTH'],
        ['B2A', 'ack', 'ACK（可合并）', '']
      ],
      note: '<b>RDMA WRITE 是单边操作。</b>对端只需提前注册好内存并交出 rkey，不需要 post_recv，也不需要任何线程在跑。对端网卡把数据直接写进缓冲区；对端的应用要自己通过轮询或 WRITE_WITH_IMM 才“知道”数据到了。'
    },
    read: {
      items: [
        ['A2B', 'req', 'RDMA READ Request', 'BTH + RETH'],
        ['B2A', 'resp', 'READ Response 首包', 'BTH + 数据'],
        ['B2A', 'resp', '（后续响应包）', ''],
        ['A2B', 'ack', 'ACK', '']
      ],
      note: '<b>RDMA READ 会占住发送队列。</b>读请求发出后，发送方必须等响应全部到齐才能继续用这条 QP 发起同一批读；在实际编程中，这通常意味着读比写更依赖被读端的内存与网卡性能。'
    },
    atomic: {
      items: [
        ['A2B', 'req', 'COMPARE SWAP / FETCH ADD', 'BTH + AtomicETH + 8B'],
        ['B2A', 'resp', 'Atomic Acknowledge', '旧值随响应返回'],
        ['A2B', 'ack', 'ACK', '']
      ],
      note: '<b>ATOMIC 是 64 位读改写。</b>支持 Compare &amp; Swap 与 Fetch &amp; Add，操作在被访问网卡内部原子完成。常用于分布式锁与计数器，开销与一次 READ 相近，但要求远端地址 8 字节对齐。'
    }
  };
  function ladderSVG(kind) {
    var d = LADDER[kind], items = d.items;
    var W = 620, top = 46, gap = 52, ax = 96, bx = 520;
    var H = top + items.length * gap + 26;
    var out = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" style="height:auto;display:block" role="img" aria-label="' + kind + ' 时序图">';
    out += '<defs>';
    [['req', 'var(--a)'], ['resp', 'var(--b)'], ['ack', 'var(--ink-3)']].forEach(function (m) {
      out += '<marker id="ah-' + m[0] + '" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">' +
        '<path d="M0 0 L10 5 L0 10 z" fill="' + m[1] + '"/></marker>';
    });
    out += '</defs>';
    out += '<line x1="' + ax + '" y1="30" x2="' + ax + '" y2="' + (H - 12) + '" class="ld-lane"/>';
    out += '<line x1="' + bx + '" y1="30" x2="' + bx + '" y2="' + (H - 12) + '" class="ld-lane"/>';
    out += '<text x="' + ax + '" y="20" text-anchor="middle" class="ld-lane-t">本端 · 发起方</text>';
    out += '<text x="' + bx + '" y="20" text-anchor="middle" class="ld-lane-t">对端 · 目标</text>';
    items.forEach(function (it, i) {
      var y = top + i * gap;
      var from = it[0] === 'A2B' ? ax : bx;
      var to = it[0] === 'A2B' ? bx : ax;
      var cls = it[1] === 'req' ? 'ld-req' : (it[1] === 'resp' ? 'ld-resp' : 'ld-ack');
      out += '<line x1="' + from + '" y1="' + y + '" x2="' + to + '" y2="' + y + '" class="ld-line ' + cls + '" marker-end="url(#ah-' + it[1] + ')"/>';
      var mid = (ax + bx) / 2;
      out += '<text x="' + mid + '" y="' + (y - 8) + '" text-anchor="middle" class="ld-t">' + esc(it[2]) + '</text>';
      if (it[3]) out += '<text x="' + mid + '" y="' + (y + 16) + '" text-anchor="middle" class="ld-s">' + esc(it[3]) + '</text>';
    });
    out += '</svg>';
    return out;
  }
  function showOp(kind) {
    $('#ladder').innerHTML = ladderSVG(kind);
    $('#opNote').innerHTML = LADDER[kind].note;
    $$('#opTabs .tab').forEach(function (t) {
      t.setAttribute('aria-selected', String(t.dataset.op === kind));
    });
  }
  $('#opTabs').addEventListener('click', function (e) {
    var t = e.target.closest('.tab'); if (t) showOp(t.dataset.op);
  });
  showOp('send');

  /* ---------------- 08 报文 ---------------- */
  var SEGS = [
    ['Eth', '14 B', '以太头', '目的/源 MAC 与 EtherType。RoCEv2 用 IPv4 时是 0x0800；VLAN 标签会让它变成 18 字节。'],
    ['IPv4', '20 B', 'IP 头', 'Protocol = 17（UDP）。RoCEv2 的路由完全依赖它——这也是 RoCE 能跨三层而 IB 不能的原因。'],
    ['UDP', '8 B', '目的端口 4791', '源端口由硬件按 QP 哈希，用于 ECMP 熵。4791 是 RoCEv2 的注册端口，防火墙必须放行。'],
    ['BTH', '12 B', 'Base Transport Header', '每个报文都有。opcode 说明做什么，QPN 说明发给谁，PSN 说明序号。'],
    ['RETH', '16 B', 'RDMA Extended Transport Header', '只在 WRITE / READ 的首包出现：64 位远端虚拟地址、32 位 rkey、32 位总长度。'],
    ['Payload', '≤ PMTU', '负载', '不含任何 RDMA 头的数据。最大长度由 path_mtu 协商，常用 1024 或 4096。'],
    ['ICRC', '4 B', 'Invariant CRC', '覆盖从 BTH 到负载的全部内容，以及 IP 头里不随时间变化的字段。硬件重算，不匹配直接静默丢弃。'],
    ['FCS', '4 B', '以太帧校验', '由以太网 PHY 计算。RoCE 同时有 FCS 和 ICRC，前者防线路错误，后者防止转发过程中头部被改写。']
  ];
  var psegEl = $('#psegs'), segPanel = $('#segPanel');
  psegEl.innerHTML = SEGS.map(function (s, i) {
    return '<button class="pseg" data-s="' + i + '" aria-pressed="' + (i === 3 ? 'true' : 'false') + '">' + esc(s[0]) + '<small>' + esc(s[1]) + '</small></button>';
  }).join('');
  function showSeg(i) {
    $$('.pseg', psegEl).forEach(function (p) { p.setAttribute('aria-pressed', String(Number(p.dataset.s) === i)); });
    segPanel.className = 'result';
    segPanel.innerHTML = '<b>' + esc(SEGS[i][2]) + ' · ' + esc(SEGS[i][1]) + '</b>' + esc(SEGS[i][3]);
  }
  psegEl.addEventListener('click', function (e) {
    var p = e.target.closest('.pseg'); if (p) showSeg(Number(p.dataset.s));
  });
  showSeg(3);

  var BTH_ROWS = [
    [
      ['opcode', 8, '操作码', '高 3 位选择传输服务（RC 0x00 / UC 0x20 / RD 0x40 / UD 0x60），低 5 位选择具体操作与分片位置。接收端靠它决定后续该解析哪个扩展头。'],
      ['SE', 1, 'Solicited Event', '请求接收端在完成时产生一个 solicited 事件，用于降低通知延迟。多数实现忽略它。'],
      ['M', 1, '迁移状态', 'Migration Request，用于连接迁移。正常数据路径恒为 0。'],
      ['PadCnt', 2, '填充字节数', '负载补齐到 4 字节边界的字节数，取值 0–3，接收端据此裁剪。'],
      ['TVer', 4, '传输头版本', '当前为 0。非 0 的报文会被当作不支持的版本丢弃。'],
      ['P_Key', 16, '分区键', '相当于租户隔离：只有 P_Key 匹配（含成员位）的两个 QP 才能通信。与 PD 是两套独立机制。']
    ],
    [
      ['Reserved', 8, '保留', '发送时置 0，接收时忽略。'],
      ['Dest QP', 24, '目的队列号', '整个报文的投递依据：网卡用它找到目标 QP 及其状态、PSN 计数器、接收队列。UD 下它与 DETH 里的 QPN 配合使用。']
    ],
    [
      ['A', 1, '确认请求', '置 1 表示要求接收端回 ACK。可靠性传输靠它触发确认，批量发送时网卡会按策略稀疏置位。'],
      ['Reserved', 7, '保留', '置 0。'],
      ['PSN', 24, '包序号', '可靠传输的核心。每个包递增，接收端发现跳号就回 NAK，发送端从缺口起重发。窗口大小与 PSN 空间共同决定在途报文上限。']
    ]
  ];
  var bthEl = $('#bth'), bitPanel = $('#bitPanel');
  var bitDesc = {};
  bthEl.innerHTML = BTH_ROWS.map(function (row, ri) {
    var html = '<div class="bitrow">';
    row.forEach(function (f, fi) {
      var pct = (f[1] / 32) * 100;
      var id = 'b' + ri + '-' + fi;
      bitDesc[id] = f;
      html += '<button class="bit" data-b="' + id + '" style="flex:0 0 ' + pct + '%;" aria-pressed="false">' +
        '<b>' + esc(f[0]) + '</b><span>' + f[1] + ' bit</span></button>';
    });
    html += '</div>';
    return html;
  }).join('');
  bthEl.addEventListener('click', function (e) {
    var b = e.target.closest('.bit'); if (!b) return;
    $$('.bit', bthEl).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    var f = bitDesc[b.dataset.b];
    bitPanel.className = 'result';
    bitPanel.innerHTML = '<b>' + esc(f[2]) + ' · ' + f[1] + ' 位</b>' + esc(f[3]);
  });

  var OPCODES = [
    [0x00, 'SEND First', 'BTH'], [0x01, 'SEND Middle', 'BTH'], [0x02, 'SEND Last', 'BTH'],
    [0x03, 'SEND Last with Immediate', 'BTH + ImmDt'], [0x04, 'SEND Only', 'BTH'],
    [0x05, 'SEND Only with Immediate', 'BTH + ImmDt'],
    [0x06, 'RDMA WRITE First', 'BTH + RETH'], [0x07, 'RDMA WRITE Middle', 'BTH'],
    [0x08, 'RDMA WRITE Last', 'BTH'], [0x09, 'RDMA WRITE Last with Immediate', 'BTH + ImmDt'],
    [0x0a, 'RDMA WRITE Only', 'BTH + RETH'], [0x0b, 'RDMA WRITE Only with Immediate', 'BTH + RETH + ImmDt'],
    [0x0c, 'RDMA READ Request First', 'BTH + RETH'], [0x0d, 'RDMA READ Request Last', 'BTH'],
    [0x0e, 'RDMA READ Request Only', 'BTH + RETH'],
    [0x0f, 'RDMA READ Response First', 'BTH'], [0x10, 'RDMA READ Response Middle', 'BTH'],
    [0x11, 'RDMA READ Response Last', 'BTH'], [0x12, 'RDMA READ Response Only', 'BTH'],
    [0x13, 'ACKNOWLEDGE', 'BTH + AETH'],
    [0x14, 'ATOMIC Acknowledge', 'BTH + AETH'],
    [0x15, 'COMPARE SWAP', 'BTH + AtomicETH'],
    [0x16, 'FETCH ADD', 'BTH + AtomicETH'],
    [0x20, 'UC SEND First', 'BTH'], [0x21, 'UC SEND Middle', 'BTH'], [0x22, 'UC SEND Last', 'BTH'],
    [0x23, 'UC SEND Last with Immediate', 'BTH + ImmDt'], [0x24, 'UC SEND Only', 'BTH'],
    [0x25, 'UC SEND Only with Immediate', 'BTH + ImmDt'],
    [0x26, 'UC WRITE First', 'BTH + RETH'], [0x27, 'UC WRITE Middle', 'BTH'],
    [0x28, 'UC WRITE Last', 'BTH'], [0x29, 'UC WRITE Only', 'BTH + RETH'],
    [0x40, 'RD SEND First', 'BTH'], [0x44, 'RD SEND Only', 'BTH'],
    [0x4a, 'RD WRITE Only', 'BTH + RETH'], [0x4e, 'RD READ Request Only', 'BTH + RETH'],
    [0x53, 'RD ACKNOWLEDGE', 'BTH + AETH'], [0x55, 'RD COMPARE SWAP', 'BTH + AtomicETH'],
    [0x64, 'UD SEND Only', 'BTH + DETH'], [0x65, 'UD SEND Only with Immediate', 'BTH + DETH + ImmDt']
  ];
  function prefixOf(op) {
    if (op < 0x20) return 'RC';
    if (op < 0x40) return 'UC';
    if (op < 0x60) return 'RD';
    return 'UD';
  }
  var opBody = $('#opBody');
  function renderOpcodes(sel) {
    var rows = OPCODES.filter(function (o) { return sel === 'ALL' || prefixOf(o[0]) === sel; });
    opBody.innerHTML = rows.map(function (o) {
      return '<tr><td class="num">0x' + o[0].toString(16).padStart(2, '0') + '</td>' +
        '<td class="num">' + o[0].toString(2).padStart(8, '0') + '</td>' +
        '<td>' + esc(o[1]) + '</td><td class="mono" style="font-size:12px">' + esc(o[2]) + '</td></tr>';
    }).join('') || '<tr><td colspan="4" style="color:var(--ink-3)">该服务没有列出的操作码</td></tr>';
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-ops]'); if (!b) return;
    $$('[data-ops]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
    renderOpcodes(b.dataset.ops);
  });
  renderOpcodes('RC');

  /* ---------------- 09 分片 ---------------- */
  var msgEl = $('#msgSize'), pmtuEl = $('#pmtu'), opSelEl = $('#opSel');
  function calcFragment() {
    var msg = Math.max(0, Math.min(1073741824, Number(msgEl.value) || 0));
    var pmtu = Number(pmtuEl.value);
    var op = opSelEl.value;
    var n = msg === 0 ? 0 : Math.ceil(msg / pmtu);
    var perPkt = 62;
    var reth = (op === 'send') ? 0 : 16;
    var wire = 0;
    if (n === 0) {
      wire = perPkt + reth;
    } else {
      wire = n * (pmtu + perPkt) - (n * pmtu - msg) + reth;
      if (op === 'writeImm' || op === 'sendImm') wire += 4;
    }
    var eff = wire > 0 ? (msg / wire) * 100 : 0;
    $('#outPkts').textContent = n === 0 ? '1（空）' : n;
    $('#outWire').textContent = wire.toLocaleString('en-US') + ' B';
    $('#outEff').textContent = eff.toFixed(2) + '%';
    var firstOp = op === 'send' ? (n <= 1 ? '0x04 SEND Only' : '0x00 SEND First')
      : op === 'write' ? (n <= 1 ? '0x0A WRITE Only' : '0x06 WRITE First')
        : (n <= 1 ? '0x0B WRITE Only+Imm' : '0x06 WRITE First');
    $('#outOp').textContent = firstOp;
    var strip = [], shown = Math.min(n, 14);
    for (var i = 0; i < shown; i++) {
      var size = Math.min(pmtu, msg - i * pmtu);
      var isFirst = i === 0, isLast = i === n - 1;
      var cls = 'pk' + (isFirst ? ' f' : '') + (isLast && n > 1 ? ' l' : '');
      var code = '';
      if (op === 'send') code = n === 1 ? (op === 'sendImm' ? '0x05' : '0x04') : (isFirst ? '0x00' : isLast ? '0x02' : '0x01');
      else code = n === 1 ? (op === 'writeImm' ? '0x0B' : '0x0A') : (isFirst ? '0x06' : isLast ? '0x08' : '0x07');
      strip.push('<span class="' + cls + '">' + code + ' · ' + size + 'B</span>');
    }
    if (n > shown) strip.push('<span class="pk ellipsis">… 还有 ' + (n - shown) + ' 个</span>');
    if (n === 0) strip = ['<span class="pk f">长度 0，不会产生数据包</span>'];
    $('#pktStrip').innerHTML = strip.join('');
  }
  [msgEl, pmtuEl, opSelEl].forEach(function (el) { el.addEventListener('input', calcFragment); });
  calcFragment();

  /* ---------------- 10 可靠性 ---------------- */
  var REL_STEPS = [
    { log: '发送端依次发出 PSN 0–5，设置 A 位要求确认。', state: ['tx', 'tx', 'drop', 'tx', 'tx', 'tx'] },
    { log: '对端收到 0、1、2，回 ACK，MSN 表示为最新完整消息。', state: ['ok', 'ok', 'drop', 'tx', 'tx', 'tx'] },
    { log: 'PSN 4 到达，接收端发现期望的是 3 → 回 NAK 0x60（序号错误）。', state: ['ok', 'ok', 'drop', 'ok', 'ok', 'ok'] },
    { log: 'RC 采用 go-back-N：4、5 已到达也被丢弃，不向上提交。', state: ['ok', 'ok', 'drop', 'drop', 'drop', 'drop'] },
    { log: '发送端从 PSN 3 起重传 3、4、5。', state: ['ok', 'ok', 'retx', 'retx', 'retx', 'ok'] },
    { log: '对端按序收下 3、4、5，回 ACK。消息完整，生成 CQE。', state: ['ok', 'ok', 'ok', 'ok', 'ok', 'ok'] }
  ];
  var relIdx = -1, framesEl = $('#frames'), rlLog = $('#rlLog');
  function renderRel() {
    var st = relIdx < 0 ? ['tx', 'tx', 'tx', 'tx', 'tx', 'tx'] : REL_STEPS[relIdx].state;
    framesEl.innerHTML = st.map(function (s, i) {
      var cls = s === 'ok' ? 'fr ok' : s === 'drop' ? 'fr drop' : s === 'retx' ? 'fr retx' : 'fr';
      var lab = s === 'drop' ? '丢失' : s === 'retx' ? '重传' : s === 'ok' ? '已收' : '在途';
      return '<div class="' + cls + '"><b>PSN ' + i + '</b><i>' + lab + '</i></div>';
    }).join('');
    var lines = [];
    for (var i = 0; i <= Math.min(relIdx, REL_STEPS.length - 1); i++) if (i >= 0) lines.push('<span>' + esc(REL_STEPS[i].log) + '</span>');
    rlLog.innerHTML = lines.length ? lines.join('') : '<span>点“下一步”，观察 PSN 3 丢失后发生什么。</span>';
  }
  $('#rlNext').addEventListener('click', function () {
    relIdx = relIdx >= REL_STEPS.length - 1 ? REL_STEPS.length - 1 : relIdx + 1;
    renderRel();
  });
  $('#rlReset').addEventListener('click', function () { relIdx = -1; renderRel(); });
  renderRel();

  /* ---------------- 11 ECN ---------------- */
  var qEl = $('#queue'), pfcEl = $('#pfcOn'), qFill = $('#qFill'), qVal = $('#qVal'), verdict = $('#ecnVerdict');
  function ecnUpdate() {
    var q = Number(qEl.value);
    qVal.textContent = q + '%';
    qFill.style.width = q + '%';
    var v;
    if (q < 30) {
      v = '队列低于 Kmin（30%），交换机不标记。发送端全速发送，链路利用率最优。';
      qFill.style.background = 'var(--ok)';
    } else if (q < 70) {
      var p = ((q - 30) / 40) * 100;
      v = '概率标记区：约 <b>' + p.toFixed(0) + '%</b> 的报文被标记 CE。接收端网卡每个标记生成一条 CNP，发送端按 α 降速，α 随标记密度上升。';
      qFill.style.background = 'var(--b)';
    } else if (q < 95) {
      v = '超过 Kmax（70%），<b>所有报文</b>都打 CE。发送端应迅速降速；若持续满标记，说明链路确实拥塞，而不是偶发抖动。';
      qFill.style.background = 'var(--bad)';
    } else if (pfcEl.checked) {
      v = '队列逼近满，交换机开始发 PFC PAUSE 让上游停发。<b>队列不再增长，但反压会向上游传播</b>——若上游交换机缓冲也被填满，它会给它的上游发 PAUSE，形成链式反压；配置成环时即 PFC 死锁，整片网络停摆。';
      qFill.style.background = 'var(--bad)';
    } else {
      v = '队列溢出，<b>报文被丢弃</b>。RC 触发 go-back-N 重传，重传又加剧拥塞——这就是 RoCE 里典型的“丢包风暴”，吞吐可能跌到线速的零头。';
      qFill.style.background = 'var(--bad)';
    }
    verdict.className = 'verdict';
    verdict.innerHTML = '<strong>' + (q < 30 ? '无标记' : q < 70 ? 'ECN 随机标记' : q < 95 ? 'ECN 全标记' : pfcEl.checked ? 'PFC 暂停' : '丢包') + '</strong>' + v;
  }
  qEl.addEventListener('input', ecnUpdate);
  pfcEl.addEventListener('change', ecnUpdate);
  ecnUpdate();

  /* ---------------- 13 代码标签 ---------------- */
  $('#codeTabs').addEventListener('click', function (e) {
    var t = e.target.closest('.tab'); if (!t) return;
    $$('#codeTabs .tab').forEach(function (x) { x.setAttribute('aria-selected', String(x === t)); });
    $$('.panel', $('.code-tabs')).forEach(function (p) {
      p.classList.toggle('on', p.dataset.panel === t.dataset.code);
    });
  });

  /* ---------------- 14 端到端 ring buffer ---------------- */
  var RING = 8, WIN = 3;
  var rb = {
    head: 0, tail: 0, seq: 0, inflight: 0,
    produced: 0, consumed: 0, lastImm: null,
    slots: [], log: [], autoTimer: null
  };
  var ringEl = $('#ring'), cqEl = $('#cq'), cqEmptyEl = $('#cqEmpty'), rbLogEl = $('#rbLog');

  function rbReset() {
    if (rb.autoTimer) { clearInterval(rb.autoTimer); rb.autoTimer = null; $('#rbAuto').textContent = '自动生产'; }
    rb.head = rb.tail = rb.seq = rb.inflight = rb.produced = rb.consumed = 0;
    rb.lastImm = null; rb.slots = []; rb.log = [];
    renderRing(); renderCQ(); renderRBLog(); rbMetrics();
  }
  function rbFill() {
    var n = 0;
    for (var i = 0; i < RING; i++) if (rb.slots[i] && rb.slots[i].state === 'fill') n++;
    return n;
  }
  function renderRing(pulseIdx) {
    var html = '';
    for (var i = 0; i < RING; i++) {
      var s = rb.slots[i];
      var cls = 'slot' + (s ? (s.state === 'fill' ? ' fill' : ' read') : '');
      if (i === pulseIdx) cls += ' pulse';
      html += '<div class="' + cls + '" role="listitem">' +
        '<span class="si">slot ' + i + (s ? ' · seq ' + s.seq : '') + '</span>' +
        '<span class="sd">' + (s ? (s.state === 'fill' ? 'seq ' + s.seq : '已消费') : '—') + '</span></div>';
    }
    ringEl.innerHTML = html;
    if (pulseIdx != null) {
      setTimeout(function () { var el = ringEl.children[pulseIdx]; if (el) el.classList.remove('pulse'); }, 230);
    }
    $('#rHead').textContent = rb.head;
    $('#rTail').textContent = rb.tail;
    $('#rUsed').textContent = rbFill() + '/' + RING;
  }
  function renderCQ() {
    if (rb.lastImm === null || rb.lastImm.consumed) {
      cqEl.innerHTML = '<div class="cq-empty" id="cqEmpty">CQ 为空 · polling</div>';
      cqEmptyEl = $('#cqEmpty');
      return;
    }
    var w = rb.lastImm;
    cqEl.innerHTML = '<div class="cqe"><b>IBV_WC_RECV_RDMA_WITH_IMM</b><br>' +
      'status = 0 SUCCESS<br>' +
      'imm_data = ' + w.imm + ' &nbsp;(slot)<br>' +
      'byte_len = 64<br>' +
      'wr_id = ' + w.wrId + '</div>';
    cqEmptyEl = null;
  }
  function renderRBLog() {
    rbLogEl.innerHTML = rb.log.length
      ? rb.log.slice(-6).map(function (l) { return '<span>' + esc(l) + '</span>'; }).join('')
      : '<span>先点“生产一条”，再看 CQ 里出现了什么。</span>';
    rbLogEl.scrollTop = rbLogEl.scrollHeight;
  }
  function rbMetrics() {
    $('#mProd').textContent = rb.produced;
    $('#mWin').textContent = rb.inflight + ' / ' + WIN;
    $('#mCons').textContent = rb.consumed;
    $('#mImm').textContent = rb.lastImm === null ? '—' : rb.lastImm.imm;
  }
  function logLine(s) { rb.log.push(s); renderRBLog(); }

  function rbProduce() {
    if (rb.inflight >= WIN) {
      logLine('post_send 返回 ENOMEM：发送窗口 ' + WIN + ' 已满，等 ACK 回收。');
      rbMetrics(); return;
    }
    if (rbFill() >= RING) {
      logLine('环已满（8/8）：消费者必须先把数据取走，生产者才继续。');
      rbMetrics(); return;
    }
    var slot = rb.tail;
    var seq = rb.seq++;
    rb.slots[slot] = { state: 'fill', seq: seq };
    rb.tail = (slot + 1) % RING;
    rb.inflight++;
    rb.produced++;
    rb.lastImm = { imm: slot, wrId: seq, consumed: false };
    logLine('post_send WRITE_WITH_IMM → remote_addr + ' + (slot * 64) + ', imm=' + slot + ', PSN ' + seq);
    renderRing(slot);
    renderCQ();
    rbMetrics();
  }
  function rbConsume() {
    if (rbFill() === 0) {
      logLine('poll_cq 为空：消费者在自旋，没有完成事件可取。');
      return;
    }
    var idx = -1;
    for (var k = 0; k < RING; k++) {
      var i = (rb.head + k) % RING;
      if (rb.slots[i] && rb.slots[i].state === 'fill') { idx = i; break; }
    }
    if (idx < 0) return;
    var s = rb.slots[idx];
    s.state = 'read';
    rb.head = (idx + 1) % RING;
    rb.consumed++;
    if (rb.inflight > 0) rb.inflight--;
    if (rb.lastImm) rb.lastImm.consumed = true;
    logLine('CQE: opcode=RECV_RDMA_WITH_IMM, imm=' + idx + ' → 处理 seq ' + s.seq + '，head→' + rb.head);
    renderRing(idx);
    renderCQ();
    rbMetrics();
  }
  $('#rbProd').addEventListener('click', rbProduce);
  $('#rbCons').addEventListener('click', rbConsume);
  $('#rbReset').addEventListener('click', rbReset);
  $('#rbAuto').addEventListener('click', function () {
    if (rb.autoTimer) {
      clearInterval(rb.autoTimer); rb.autoTimer = null; this.textContent = '自动生产'; return;
    }
    this.textContent = '停止';
    var self = this;
    rb.autoTimer = setInterval(function () {
      if (rb.inflight >= WIN) { rbConsume(); }
      else { rbProduce(); }
      if (rb.consumed > 200) { clearInterval(rb.autoTimer); rb.autoTimer = null; self.textContent = '自动生产'; }
    }, 700);
  });
  rbReset();

  /* ---------------- 15 术语 ---------------- */
  var GLOSS = [
    ['CTX', 'ibv_context，一个 RDMA 设备的句柄，所有资源的根。'],
    ['PD', '保护域。对象的隔离边界，跨 PD 访问一律失败。'],
    ['MR', '已注册内存，pin 住物理页并赋予 lkey / rkey。'],
    ['MW', '内存窗口，在 MR 上临时切出的一段，可独立授权与吊销。'],
    ['lkey', '本地键，用在 WQE 的 sge 里，让本端网卡找到缓冲区。'],
    ['rkey', '远端键，随 RETH 发到对端，授权对方读写指定内存。'],
    ['QP', '队列对，SQ + RQ + 连接状态 + PSN 计数器。'],
    ['QPN', 'QP 号，24 位，BTH 用它寻址目的 QP。'],
    ['SQ / RQ', '发送队列 / 接收队列，存 WQE 的环形缓冲区。'],
    ['WQE', '工作队列元素，一条待执行请求，由 WR 转换而来。'],
    ['WR', '工作请求，应用通过 post_send / post_recv 提交的描述符。'],
    ['CQ / CQE', '完成队列及其条目，记录状态、长度、wr_id。'],
    ['SRQ', '共享接收队列，多个 QP 共用一个接收 WR 池。'],
    ['AH', '地址句柄，UD 用的目的地址封装（GID、SL、端口）。'],
    ['BTH', '12 字节基础传输头：opcode、QPN、PSN。每包都有。'],
    ['RETH', '16 字节 RDMA 扩展头：远端地址、rkey、长度。'],
    ['AETH', '确认头，携带 syndrome（ACK/NAK 类型）与 MSN。'],
    ['DETH', '数据报扩展头，UD 用，携带目的 QPN 与源 QPN。'],
    ['ImmDt', '立即数头，4 字节，配合 SEND/WRITE with Immediate。'],
    ['ICRC', '不变 CRC，覆盖 IB 头与负载，防止头部被中途改写。'],
    ['PSN', '包序号，24 位，可靠传输的定序与重传依据。'],
    ['MSN', '消息序号，接收端用它告知“已完整收到第几条消息”。'],
    ['NAK', '否定确认，携带 syndrome 指明错误类型。'],
    ['RNR', 'Receiver Not Ready，接收队列没有可用 WR。'],
    ['go-back-N', 'RC 的重传方式：从缺失 PSN 起重发其后全部报文。'],
    ['PMTU', '路径最大传输单元，256 / 512 / 1024 / 2048 / 4096。'],
    ['RC / UC / UD', '可靠连接 / 不可靠连接 / 不可靠数据报，三种传输服务。'],
    ['DC / DCT', '动态连接及其目标号，硬件按需建连，面向大规模集群。'],
    ['XRC', '扩展可靠连接，多个连接共享一个接收 QP。'],
    ['RoCEv2', 'RDMA over Converged Ethernet v2，封装在 UDP 4791 上，可跨三层。'],
    ['PFC', '优先级流控（802.1Qbb），用 PAUSE 帧把丢包换成排队。'],
    ['ECN / DCQCN', '显式拥塞通知与数据中心量化拥塞通知，端到端降速机制。'],
    ['GID / LID', '全局标识（IPv6 形式）/ 本地标识（IB 子网内），用于寻址。'],
    ['ODP', '按需分页，注册时不 pin，缺页时由网卡触发缺页处理。'],
    ['inline', '把小消息直接内联进 WQE，省掉一次 DMA 读。']
  ];
  var glossEl = $('#gloss');
  function renderGloss(q) {
    var s = (q || '').trim().toLowerCase();
    var rows = GLOSS.filter(function (g) { return !s || (g[0] + g[1]).toLowerCase().indexOf(s) >= 0; });
    glossEl.innerHTML = rows.map(function (g) {
      return '<div class="gterm"><dt>' + esc(g[0]) + '</dt><dd>' + esc(g[1]) + '</dd></div>';
    }).join('') || '<div class="gterm"><dd>没有匹配的术语。</dd></div>';
  }
  $('#gq').addEventListener('input', function () { renderGloss(this.value); });
  renderGloss('');
})();
