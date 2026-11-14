/**
 * 分流生命周期实验域服务：所有业务判断只允许出现在这里，页面组件只负责渲染与触发。
 *
 * 关键不变量：
 * 1. 分流方案状态机单向：草稿 → 方案评审中 → 已生效 → 已下线，不可回退、不可跳跃、不可重复推进。
 * 2. 命中前置条件：方案必须「已生效」，且绑定的生命周期模型处于有资格（eligible）的阶段。
 * 3. 下线在一次提交内完成：方案置下线 + 白名单清空 + 在组命中全部置退出，历史命中记录不删除。
 * 4. 生命周期阶段推进在一次提交内完成：阶段更新 + 失去资格的在组命中退出；退出不可逆，不会再被拉回。
 * 5. 同一方案同一用户只允许一条 active 命中，重复/并发操作不会产生两组结果（version 乐观锁 + 状态复核）。
 * 6. 历史分组以命中时刻的方案版本、生命周期版本快照为准，后续推进不回写旧记录。
 */
import {
  AB_PLAN_ACTIONS,
  AB_PLAN_FLOW,
  ELIGIBLE_PLAN_STATUS,
} from '@/data/abtest-types'
import type {
  AbPlan,
  ActionResult,
  ExperimentHit,
  HitEligibility,
  LifecycleModel,
} from '@/data/abtest-types'
import { domainState, resetDomain, saveDomain } from '@/data/abtest-store'

function nowStamp(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fail<T>(message: string): ActionResult<T> {
  return { ok: false, message }
}

// ---------- 查询 ----------

export function listPlans(): AbPlan[] {
  return domainState().plans.map((plan) => ({ ...plan }))
}

export function getPlan(planId: number): AbPlan | undefined {
  const plan = domainState().plans.find((item) => item.id === planId)
  return plan ? { ...plan } : undefined
}

export function listLifecycles(): LifecycleModel[] {
  return domainState().lifecycles.map((model) => ({ ...model }))
}

export function listHits(): ExperimentHit[] {
  return domainState().hits.map((hit) => ({ ...hit }))
}

export function resetExperimentDomain(): ActionResult {
  resetDomain()
  return { ok: true, message: '实验域数据已重置为初始示例' }
}

// ---------- 资格判断（不落盘，供命中前校验与下线核查复用） ----------

function findLifecycle(domain: ReturnType<typeof domainState>, code: string): LifecycleModel | undefined {
  return domain.lifecycles.find((model) => model.modelCode === code)
}

/** 命中前的两道闸：方案已生效 + 生命周期当前阶段仍有资格。 */
export function checkEligibility(planId: number, userId: string): HitEligibility {
  const domain = domainState()
  const plan = domain.plans.find((item) => item.id === planId)
  if (!plan) {
    return { eligible: false, reason: '分流方案不存在' }
  }
  if (plan.status !== ELIGIBLE_PLAN_STATUS) {
    return { eligible: false, reason: `方案${plan.planCode}当前为「${plan.status}」，仅「${ELIGIBLE_PLAN_STATUS}」可承接命中` }
  }
  const lifecycle = findLifecycle(domain, plan.lifecycleCode)
  if (!lifecycle) {
    return { eligible: false, reason: `绑定的生命周期模型${plan.lifecycleCode}不存在` }
  }
  if (lifecycle.status !== '已启用') {
    return { eligible: false, reason: `生命周期模型${lifecycle.modelCode}状态为「${lifecycle.status}」，未启用` }
  }
  const stage = lifecycle.stages.find((item) => item.order === lifecycle.stageOrder)
  if (!stage || !stage.eligible) {
    return { eligible: false, reason: `生命周期阶段「${lifecycle.currentStage}」无实验资格，命中被拦截` }
  }
  // 已退出过的用户不允许借新命中回流：退出是终态。
  const exited = domain.hits.some(
    (hit) => hit.planId === planId && hit.userId === userId && hit.state === 'exited',
  )
  if (exited) {
    return { eligible: false, reason: `用户${userId}已从该方案退出，退出为终态，不能重新进入旧方案` }
  }
  return { eligible: true, reason: '' }
}

// ---------- 分流方案状态机 ----------

/**
 * 推进分流方案。expectedVersion 为乐观并发锁；at 用于演练时固定时间线。
 * 下线动作走级联：白名单清理 + 在组命中退出，与状态翻转在同一次 saveDomain 提交。
 */
export function advancePlan(
  planId: number,
  action: keyof typeof AB_PLAN_ACTIONS,
  options: { expectedVersion?: number; at?: string } = {},
): ActionResult<{ plan: AbPlan; exitedHits: number }> {
  const domain = domainState()
  const index = domain.plans.findIndex((item) => item.id === planId)
  if (index < 0) {
    return fail(`没有找到编号为 ${planId} 的分流方案`)
  }
  const target = AB_PLAN_ACTIONS[action]
  if (!target) {
    return fail(`分流方案没有登记「${String(action)}」这个动作`)
  }
  const plan = domain.plans[index]

  // 并发闸：版本不符说明已有别的提交先推进过，本次整体放弃，不产生第二组结果。
  if (options.expectedVersion !== undefined && options.expectedVersion !== plan.version) {
    return fail(`并发冲突：方案版本已变为 v${plan.version}，请刷新后重试（本次未写入任何数据）`)
  }

  const currentIndex = AB_PLAN_FLOW.indexOf(plan.status)
  const targetIndex = AB_PLAN_FLOW.indexOf(target)

  // 重复下线 / 重复推进：状态已在目标态，直接拒绝且不写入。
  if (plan.status === target) {
    return fail(`方案${plan.planCode}已经是「${target}」，重复操作被拦截，不会产生两组结果`)
  }
  // 单向状态机：只能推进到紧邻的下一态。
  if (targetIndex !== currentIndex + 1) {
    return fail(`非法流转：「${plan.status}」不能跳到「${target}」，只允许 ${AB_PLAN_FLOW.join(' → ')} 顺序推进`)
  }

  const at = options.at ?? nowStamp()
  const nextPlans = domain.plans.map((item) => ({ ...item, whitelist: item.whitelist.map((w) => ({ ...w })) }))
  const nextPlan = nextPlans[index]
  nextPlan.status = target
  nextPlan.version = plan.version + 1
  if (target === '已生效') {
    nextPlan.effectiveAt = at
  }

  let exitedHits = 0
  const nextHits = domain.hits.map((hit) => ({ ...hit, planSnapshot: { ...hit.planSnapshot } }))

  if (target === '已下线') {
    // 一次提交内的下线级联：
    // ① 记录下线时间；② 清空白名单，停止新的白名单命中；③ 在组命中全部置退出，历史记录保留。
    nextPlan.offlineAt = at
    nextPlan.whitelist = []
    for (const hit of nextHits) {
      if (hit.planId === planId && hit.state === 'active') {
        hit.state = 'exited'
        hit.exitAt = at
        hit.exitReason = `方案${plan.planCode}于 ${at} 下线，分组退出`
        exitedHits += 1
      }
    }
  }

  saveDomain({ ...domain, plans: nextPlans, hits: nextHits })
  return {
    ok: true,
    message:
      target === '已下线'
        ? `方案${plan.planCode}已下线：白名单已清空，${exitedHits} 个在组命中已退出，历史分流结果保留可追溯`
        : `方案${plan.planCode}已推进为「${target}」（版本 v${nextPlan.version}）`,
    data: { plan: { ...nextPlan }, exitedHits },
  }
}

// ---------- 生命周期阶段推进 ----------

/**
 * 阶段单向推进一次，并联动退出：绑定该模型且新阶段失去资格的方案，其在组命中在同一次提交内退出。
 * 已退出的命中保持 exited，绝不回 active —— 后续推进无法把用户重新拉回旧方案。
 */
export function advanceLifecycleStage(
  modelId: number,
  options: { expectedVersion?: number; at?: string } = {},
): ActionResult<{ model: LifecycleModel; exitedHits: number }> {
  const domain = domainState()
  const index = domain.lifecycles.findIndex((item) => item.id === modelId)
  if (index < 0) {
    return fail(`没有找到编号为 ${modelId} 的生命周期模型`)
  }
  const model = domain.lifecycles[index]
  if (options.expectedVersion !== undefined && options.expectedVersion !== model.version) {
    return fail(`并发冲突：生命周期版本已变为 v${model.version}，请刷新后重试（本次未写入任何数据）`)
  }
  if (model.status !== '已启用') {
    return fail(`模型${model.modelCode}当前为「${model.status}」，只有已启用模型可以推进阶段`)
  }
  if (model.stageOrder >= model.stages.length) {
    return fail(`模型${model.modelCode}已处于末阶段「${model.currentStage}」，不能继续推进`)
  }

  const at = options.at ?? nowStamp()
  const nextOrder = model.stageOrder + 1
  const nextStageDef = model.stages.find((item) => item.order === nextOrder)
  if (!nextStageDef) {
    return fail('下一阶段定义缺失，推进中止')
  }

  const nextModels = domain.lifecycles.map((item) => ({
    ...item,
    stages: item.stages.map((s) => ({ ...s })),
    stageHistory: item.stageHistory.map((h) => ({ ...h })),
  }))
  const nextModel = nextModels[index]
  nextModel.stageOrder = nextOrder
  nextModel.currentStage = nextStageDef.name
  nextModel.version = model.version + 1
  nextModel.stageHistory.push({
    order: nextOrder,
    stage: nextStageDef.name,
    advancedAt: at,
    version: nextModel.version,
  })

  // 联动退出：找绑定本模型的方案；新阶段无资格时，在组命中一次性退出。
  const boundPlanIds = domain.plans
    .filter((plan) => plan.lifecycleCode === model.modelCode)
    .map((plan) => plan.id)
  const nextHits = domain.hits.map((hit) => ({ ...hit, planSnapshot: { ...hit.planSnapshot } }))
  let exitedHits = 0
  if (!nextStageDef.eligible) {
    for (const hit of nextHits) {
      if (boundPlanIds.includes(hit.planId) && hit.state === 'active') {
        hit.state = 'exited'
        hit.exitAt = at
        hit.exitReason = `生命周期推进至「${nextStageDef.name}」，阶段无实验资格，分组退出`
        exitedHits += 1
      }
    }
  }

  saveDomain({ ...domain, lifecycles: nextModels, hits: nextHits })
  return {
    ok: true,
    message: nextStageDef.eligible
      ? `模型${model.modelCode}阶段推进为「${nextStageDef.name}」（仍有资格，在组分组保留，快照版本不变）`
      : `模型${model.modelCode}阶段推进为「${nextStageDef.name}」（无资格）：${exitedHits} 个在组命中已退出，历史结果保留`,
    data: { model: { ...nextModel }, exitedHits },
  }
}

// ---------- 实验命中 ----------

/** 基于用户与方案的稳定哈希做比例分流，同一用户同一方案结果可复现。 */
function pickRatioGroup(plan: AbPlan, userId: string): string {
  const text = `${plan.planCode}:${userId}`
  let hash = 0
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  }
  return plan.groupKeys[hash % plan.groupKeys.length]
}

export type HitInput = { planId: number; userId: string; at?: string }

/**
 * 产生一次实验分流结果。
 * 白名单优先并强制分组；否则按比例分流。命中即冻结方案/生命周期快照。
 * 同一方案同一用户已有 active 命中时幂等返回，不新增记录；退出终态与资格闸拦截回流。
 */
export function recordHit(input: HitInput): ActionResult<{ hit: ExperimentHit; reused: boolean }> {
  const { planId, userId } = input
  const eligibility = checkEligibility(planId, userId)
  if (!eligibility.eligible) {
    return fail(eligibility.reason)
  }
  const domain = domainState()
  const plan = domain.plans.find((item) => item.id === planId)
  if (!plan) {
    return fail('分流方案不存在')
  }

  // 幂等：已有在组命中直接复用，绝不产生第二组结果。
  const existing = domain.hits.find(
    (hit) => hit.planId === planId && hit.userId === userId && hit.state === 'active',
  )
  if (existing) {
    return {
      ok: true,
      message: `用户${userId}已在方案${plan.planCode}的分组 ${existing.groupKey} 中，复用既有命中，未新增记录`,
      data: { hit: { ...existing }, reused: true },
    }
  }

  const lifecycle = findLifecycle(domain, plan.lifecycleCode)
  if (!lifecycle) {
    return fail(`绑定的生命周期模型${plan.lifecycleCode}不存在`)
  }

  const whitelisted = plan.whitelist.find((item) => item.userId === userId)
  const groupKey = whitelisted ? whitelisted.groupKey : pickRatioGroup(plan, userId)
  const at = input.at ?? nowStamp()

  const hit: ExperimentHit = {
    id: domain.hitSeq + 1,
    planId: plan.id,
    planCode: plan.planCode,
    userId,
    groupKey,
    hitSource: whitelisted ? '白名单' : '比例分流',
    hitAt: at,
    planVersion: plan.version,
    lifecycleStage: lifecycle.currentStage,
    lifecycleVersion: lifecycle.version,
    planSnapshot: {
      splitRatio: plan.splitRatio,
      groupKeys: [...plan.groupKeys],
      mutexRule: plan.mutexRule,
      effectivePages: plan.effectivePages,
    },
    state: 'active',
    exitAt: null,
    exitReason: null,
  }

  saveDomain({ ...domain, hits: [...domain.hits, hit], hitSeq: hit.id })
  return {
    ok: true,
    message: `用户${userId}命中方案${plan.planCode}分组 ${groupKey}（${hit.hitSource}），快照版本 v${plan.version}`,
    data: { hit, reused: false },
  }
}

/** 下线核查用：不写入数据，模拟一次命中尝试，返回被拦截原因。 */
export function probeHit(planId: number, userId: string): HitEligibility {
  return checkEligibility(planId, userId)
}

// ---------- 下线核查视图数据 ----------

export type OfflineCheckReport = {
  plan: AbPlan
  lifecycle: LifecycleModel | undefined
  hits: ExperimentHit[]
  probe: HitEligibility
  probeUserId: string
}

export function buildOfflineCheck(planId: number, probeUserId: string): ActionResult<OfflineCheckReport> {
  const plan = getPlan(planId)
  if (!plan) {
    return fail(`没有找到编号为 ${planId} 的分流方案`)
  }
  const domain = domainState()
  const lifecycle = findLifecycle(domain, plan.lifecycleCode)
  const hits = domain.hits
    .filter((hit) => hit.planId === planId)
    .map((hit) => ({ ...hit, planSnapshot: { ...hit.planSnapshot } }))
  return {
    ok: true,
    message: '核查数据已生成',
    data: {
      plan,
      lifecycle: lifecycle ? { ...lifecycle } : undefined,
      hits,
      probe: probeHit(planId, probeUserId),
      probeUserId,
    },
  }
}
