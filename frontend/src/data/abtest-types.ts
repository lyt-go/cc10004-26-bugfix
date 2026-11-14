/**
 * 分流生命周期实验域的领域模型。
 * 与通用 EntryRow 不同：这里的状态机、命中、快照与并发版本都有明确语义，
 * 供 api/experiment-service 统一读写，页面组件不做业务判断。
 */

/** 分流方案只允许沿这条单向链路推进，不能回退、不能跳跃。 */
export const AB_PLAN_FLOW = ['草稿', '方案评审中', '已生效', '已下线'] as const
export type AbPlanStatus = (typeof AB_PLAN_FLOW)[number]

/** 方案动作与目标状态一一对应，顺序即合法推进顺序。 */
export const AB_PLAN_ACTIONS = {
  提交方案评审: '方案评审中',
  生效方案: '已生效',
  下线方案: '已下线',
} as const

/** 有资格承接实验命中的方案状态：只有「已生效」。 */
export const ELIGIBLE_PLAN_STATUS: AbPlanStatus = '已生效'

/** 分流方案：白名单是命中入口，version 做乐观并发控制。 */
export type AbPlan = {
  id: number
  planCode: string
  planName: string
  status: AbPlanStatus
  splitType: string
  /** 例如 A:50% / B:50%。 */
  splitRatio: string
  /** 分组标识，例如 A、B。 */
  groupKeys: string[]
  mutexRule: string
  effectivePages: string
  /** 白名单用户：userId -> 强制分组。 */
  whitelist: { userId: string; groupKey: string }[]
  /** 生命周期模型编号：命中前必须确认该模型当前阶段仍有资格。 */
  lifecycleCode: string
  /** 仅「已生效」阶段有意义；记录最近一次生效动作的时间。 */
  effectiveAt: string | null
  /** 下线时间：下线后停止新命中，但历史结果保留。 */
  offlineAt: string | null
  /** 单调递增版本：每次状态/内容变更 +1，用于并发阶段推进的乐观锁。 */
  version: number
}

/**
 * 实验分流结果（命中记录）。
 * 命中时对方案与生命周期做不可变快照；退出只写 exit* 字段，绝不删除记录，
 * 因此下线后历史命中仍可追溯，且旧分组永远以命中时刻的版本为准。
 */
export type ExperimentHit = {
  id: number
  planId: number
  planCode: string
  userId: string
  /** 命中分组，例如 B；退出后仍保留原分组。 */
  groupKey: string
  hitSource: '白名单' | '比例分流'
  hitAt: string
  /** 命中时刻的方案版本，历史分组以此版本为准（版本冻结）。 */
  planVersion: number
  /** 命中时刻的生命周期阶段快照。 */
  lifecycleStage: string
  /** 命中时刻的生命周期模型版本。 */
  lifecycleVersion: number
  /** 命中时刻的方案配置快照：下线核查与追溯直接读这里。 */
  planSnapshot: {
    splitRatio: string
    groupKeys: string[]
    mutexRule: string
    effectivePages: string
  }
  /** active=仍在分组内；exited=已退出（方案下线或生命周期阶段失去资格）。 */
  state: 'active' | 'exited'
  exitAt: string | null
  exitReason: string | null
}

/** 生命周期模型：阶段同样单向推进，版本用于并发控制。 */
export type LifecycleModel = {
  id: number
  modelCode: string
  modelName: string
  status: '草稿' | '模型评审中' | '已启用' | '已下线'
  /** 阶段序号（从 1 开始），单调递增，不允许回退。 */
  stageOrder: number
  /** 当前阶段名称。 */
  currentStage: string
  /** 有序阶段定义。 */
  stages: { order: number; name: string; eligible: boolean }[]
  stageDefinitionEvent: string
  /** 阶段停留阈值，例如 7 天。 */
  stageStayThreshold: string
  transitionCondition: string
  /** 流失周期天。 */
  churnCycleDays: number
  regressionCondition: string
  version: number
  /** 每次阶段推进的历史，供详情页展示版本轨迹。 */
  stageHistory: { order: number; stage: string; advancedAt: string; version: number }[]
}

export type HitEligibility =
  | { eligible: true; reason: '' }
  | { eligible: false; reason: string }

export type ActionResult<T = undefined> = {
  ok: boolean
  message: string
  data?: T
}
