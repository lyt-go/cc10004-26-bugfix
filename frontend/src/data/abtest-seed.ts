import type { AbPlan, ExperimentHit, LifecycleModel } from './abtest-types'

/**
 * 分流生命周期实验域的初始数据。
 * 刻意复现事故现场：ABGR-0002 白名单里有 U-8842，但方案处于「方案评审中」（未生效），
 * LIFE-0002 处于首个阶段。没有任何历史命中——命中要在生效后由演练显式产生，
 * 这样能完整验证「先生效命中、再下线、新命中停止、旧命中可查」的链路。
 */
export const SEED_AB_PLANS: AbPlan[] = [
  {
    id: 1,
    planCode: 'ABGR-0001',
    planName: '首页推荐位灰度分流',
    status: '草稿',
    splitType: 'A/B 实验',
    splitRatio: 'A:50% / B:50%',
    groupKeys: ['A', 'B'],
    mutexRule: '与 ABGR-0003 互斥（同一用户同页只命中其一）',
    effectivePages: '首页推荐位',
    whitelist: [],
    lifecycleCode: 'LIFE-0001',
    effectiveAt: null,
    offlineAt: null,
    version: 1,
  },
  {
    id: 2,
    planCode: 'ABGR-0002',
    planName: '结算页挽留弹窗分流实验',
    status: '方案评审中',
    splitType: 'A/B 实验',
    splitRatio: 'A:50% / B:50%',
    groupKeys: ['A', 'B'],
    mutexRule: '与 ABGR-0001 互斥；弹窗类实验同一生效页面仅允许一个在线',
    effectivePages: '结算页',
    // 事故现场：方案虽未生效（后又被标记下线），白名单仍在持续命中。
    whitelist: [{ userId: 'U-8842', groupKey: 'B' }],
    lifecycleCode: 'LIFE-0002',
    effectiveAt: null,
    offlineAt: null,
    version: 1,
  },
  {
    id: 3,
    planCode: 'ABGR-0003',
    planName: '会员中心入口分层分流',
    status: '已生效',
    splitType: '灰度发布',
    splitRatio: '灰度组:20% / 对照组:80%',
    groupKeys: ['灰度组', '对照组'],
    mutexRule: '与 ABGR-0001 互斥',
    effectivePages: '会员中心',
    whitelist: [],
    lifecycleCode: 'LIFE-0003',
    effectiveAt: '2026-11-10 09:00',
    offlineAt: null,
    version: 3,
  },
]

export const SEED_LIFECYCLE_MODELS: LifecycleModel[] = [
  {
    id: 1,
    modelCode: 'LIFE-0001',
    modelName: '新客引导生命周期',
    status: '草稿',
    stageOrder: 1,
    currentStage: '获客期',
    stages: [
      { order: 1, name: '获客期', eligible: true },
      { order: 2, name: '成长期', eligible: true },
      { order: 3, name: '成熟期', eligible: false },
    ],
    stageDefinitionEvent: '完成注册',
    stageStayThreshold: '7 天',
    transitionCondition: '触发关键行为 3 次',
    churnCycleDays: 30,
    regressionCondition: '流失后 7 天内回访',
    version: 1,
    stageHistory: [{ order: 1, stage: '获客期', advancedAt: '2026-11-01 09:00', version: 1 }],
  },
  {
    id: 2,
    modelCode: 'LIFE-0002',
    modelName: '结算转化生命周期',
    status: '已启用',
    stageOrder: 1,
    currentStage: '引入期',
    // 前两个阶段有实验资格，进入成熟期后失去资格（旧分组退出，且后续推进不得再拉回）。
    stages: [
      { order: 1, name: '引入期', eligible: true },
      { order: 2, name: '成长期', eligible: true },
      { order: 3, name: '成熟期', eligible: false },
      { order: 4, name: '流失期', eligible: false },
    ],
    stageDefinitionEvent: '进入结算页',
    stageStayThreshold: '5 天',
    transitionCondition: '阶段停留达阈值且发生转化事件',
    churnCycleDays: 14,
    regressionCondition: '流失周期内重新进入结算页',
    version: 1,
    stageHistory: [{ order: 1, stage: '引入期', advancedAt: '2026-11-05 10:00', version: 1 }],
  },
  {
    id: 3,
    modelCode: 'LIFE-0003',
    modelName: '会员留存生命周期',
    status: '已启用',
    stageOrder: 2,
    currentStage: '成长期',
    stages: [
      { order: 1, name: '获客期', eligible: true },
      { order: 2, name: '成长期', eligible: true },
      { order: 3, name: '成熟期', eligible: true },
    ],
    stageDefinitionEvent: '开通会员',
    stageStayThreshold: '10 天',
    transitionCondition: '连续两个周期活跃',
    churnCycleDays: 21,
    regressionCondition: '会员续费',
    version: 2,
    stageHistory: [
      { order: 1, stage: '获客期', advancedAt: '2026-10-20 09:00', version: 1 },
      { order: 2, stage: '成长期', advancedAt: '2026-11-01 09:00', version: 2 },
    ],
  },
]

/** 初始没有任何命中记录：所有命中都由演练流程显式产生，保证时间线可复现。 */
export const SEED_EXPERIMENT_HITS: ExperimentHit[] = []
