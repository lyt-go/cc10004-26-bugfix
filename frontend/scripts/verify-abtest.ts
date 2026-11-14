/**
 * 验收用例：分流方案下线与白名单清理链路、生命周期阶段联动、并发与幂等。
 * 运行方式见 scripts/run-verify.mjs。
 */
import {
  advanceLifecycleStage,
  advancePlan,
  buildOfflineCheck,
  checkEligibility,
  listHits,
  listLifecycles,
  listPlans,
  recordHit,
  resetExperimentDomain,
} from '@/api/experiment-service'

type Assert = typeof import('node:assert/strict')

function heading(text: string) {
  console.log(`\n=== ${text} ===`)
}

export async function run({ assert }: { assert: Assert }): Promise<void> {
  // ---------------------------------------------------------------- 场景一：完整事故修复时间线
  resetExperimentDomain()
  heading('初始状态：ABGR-0002 评审中且白名单含 U-8842，LIFE-0002 引入期有资格')
  let plans = listPlans()
  const abgr2 = () => listPlans().find((p) => p.planCode === 'ABGR-0002')!
  assert.equal(abgr2().status, '方案评审中')
  assert.deepEqual(abgr2().whitelist, [{ userId: 'U-8842', groupKey: 'B' }])
  assert.equal(listHits().length, 0, '初始不应有任何命中')

  heading('命中前置闸①：未生效方案即使在白名单里也不能命中')
  const before = recordHit({ planId: abgr2().id, userId: 'U-8842', at: '2026-11-12 17:00' })
  assert.equal(before.ok, false)
  assert.match(before.message, /已生效/)
  assert.equal(listHits().length, 0, '被拦截的命中不得落盘')

  heading('状态机：禁止跳跃/回退，只能按 草稿→评审→生效→下线 推进')
  const abgr1 = listPlans().find((p) => p.planCode === 'ABGR-0001')!
  assert.equal(advancePlan(abgr1.id, '生效方案').ok, false, '草稿不能直接跳到已生效')
  assert.equal(advancePlan(abgr1.id, '下线方案').ok, false, '草稿不能直接跳到已下线')
  const toReview = advancePlan(abgr1.id, '提交方案评审')
  assert.equal(toReview.ok, true)
  assert.equal(listPlans().find((p) => p.id === abgr1.id)!.status, '方案评审中')

  heading('重复提交评审被拦截（当前已是目标态）')
  const duplicateReview = advancePlan(abgr2().id, '提交方案评审')
  assert.equal(duplicateReview.ok, false)
  assert.match(duplicateReview.message, /重复操作被拦截/)

  heading('ABGR-0002 生效（v1→v2），随后白名单用户 U-8842 命中分组 B')
  const effective = advancePlan(abgr2().id, '生效方案', { at: '2026-11-12 17:30' })
  assert.equal(effective.ok, true)
  assert.equal(abgr2().status, '已生效')
  assert.equal(abgr2().version, 2)
  assert.equal(abgr2().effectiveAt, '2026-11-12 17:30')

  const hit1 = recordHit({ planId: abgr2().id, userId: 'U-8842', at: '2026-11-12 17:45' })
  assert.equal(hit1.ok, true)
  assert.equal(hit1.data!.reused, false)
  assert.equal(hit1.data!.hit.groupKey, 'B', '白名单强制分组 B')
  assert.equal(hit1.data!.hit.hitSource, '白名单')
  assert.equal(hit1.data!.hit.planVersion, 2)
  assert.equal(hit1.data!.hit.lifecycleVersion, 1)
  assert.equal(hit1.data!.hit.lifecycleStage, '引入期')

  heading('命中幂等：同一用户重复命中只复用，不产生第二组结果')
  const hit1Again = recordHit({ planId: abgr2().id, userId: 'U-8842', at: '2026-11-12 17:46' })
  assert.equal(hit1Again.ok, true)
  assert.equal(hit1Again.data!.reused, true)
  const userHits = listHits().filter((h) => h.userId === 'U-8842' && h.planCode === 'ABGR-0002')
  assert.equal(userHits.length, 1, '同一方案同一用户只能有一条命中记录')

  heading('比例分流用户 U-9001 命中，结果可复现且分组合法')
  const hit2 = recordHit({ planId: abgr2().id, userId: 'U-9001', at: '2026-11-12 17:50' })
  assert.equal(hit2.ok, true)
  assert.equal(hit2.data!.hit.hitSource, '比例分流')
  assert.ok(['A', 'B'].includes(hit2.data!.hit.groupKey))

  heading('下线（2026-11-12 18:30）：一次提交完成 状态翻转+白名单清空+在组命中退出')
  const offline = advancePlan(abgr2().id, '下线方案', {
    expectedVersion: 2,
    at: '2026-11-12 18:30',
  })
  assert.equal(offline.ok, true)
  assert.equal(offline.data!.exitedHits, 2, '两个在组命中都应退出')
  assert.equal(abgr2().status, '已下线')
  assert.equal(abgr2().offlineAt, '2026-11-12 18:30')
  assert.deepEqual(abgr2().whitelist, [], '白名单必须清空，停止新的白名单命中')

  heading('历史分流结果保留：U-8842 旧记录仍标注原分组 B 与退出时间')
  const oldHit = listHits().find((h) => h.userId === 'U-8842')!
  assert.equal(oldHit.groupKey, 'B')
  assert.equal(oldHit.state, 'exited')
  assert.equal(oldHit.exitAt, '2026-11-12 18:30')
  assert.match(oldHit.exitReason ?? '', /下线/)
  assert.equal(listHits().length, 2, '退出不删除历史记录')

  heading('下线后新命中停止：直接命中与探针都被拦截')
  const afterOffline = recordHit({ planId: abgr2().id, userId: 'U-8842', at: '2026-11-12 18:31' })
  assert.equal(afterOffline.ok, false)
  assert.match(afterOffline.message, /已下线/)
  const probe = checkEligibility(abgr2().id, 'U-8842')
  assert.equal(probe.eligible, false)

  heading('重复下线被拦截，且不会再改动任何数据')
  const hitsBeforeRepeat = listHits().length
  const repeatOffline = advancePlan(abgr2().id, '下线方案', { at: '2026-11-12 18:35' })
  assert.equal(repeatOffline.ok, false)
  assert.match(repeatOffline.message, /重复操作被拦截/)
  assert.equal(abgr2().version, 3, '重复下线不得再增版本')
  assert.equal(listHits().length, hitsBeforeRepeat)

  heading('并发乐观锁：过期版本的方案推进整体失败、零写入')
  const abgr3 = listPlans().find((p) => p.planCode === 'ABGR-0003')!
  const stale = advancePlan(abgr3.id, '下线方案', { expectedVersion: 999 })
  assert.equal(stale.ok, false)
  assert.match(stale.message, /并发冲突/)
  assert.equal(listPlans().find((p) => p.id === abgr3.id)!.version, 3, '冲突时版本保持不变')

  heading('LIFE-0002 19:05 推进阶段：不得把已退出用户重新拉回旧方案')
  const life2Id = 2
  const stage1 = advanceLifecycleStage(life2Id, { expectedVersion: 1, at: '2026-11-12 19:05' })
  assert.equal(stage1.ok, true)
  assert.equal(stage1.data!.model.currentStage, '成长期')
  assert.equal(stage1.data!.model.version, 2)
  const stillExited = listHits().find((h) => h.userId === 'U-8842')!
  assert.equal(stillExited.state, 'exited', '退出为终态，阶段推进不得拉回')
  assert.equal(stillExited.groupKey, 'B', '原分组保留')
  const pullBack = recordHit({ planId: abgr2().id, userId: 'U-8842', at: '2026-11-12 19:06' })
  assert.equal(pullBack.ok, false, '退出终态 + 方案下线双重拦截回流')

  heading('LIFE-0002 再推进至无资格阶段（成熟期），版本快照与历史退出时间保持冻结')
  const stage2 = advanceLifecycleStage(life2Id, { expectedVersion: 2, at: '2026-11-12 19:20' })
  assert.equal(stage2.ok, true)
  assert.equal(stage2.data!.model.currentStage, '成熟期')
  assert.equal(stage2.data!.model.version, 3)
  const frozen = listHits().find((h) => h.userId === 'U-8842')!
  assert.equal(frozen.lifecycleVersion, 1, '历史命中的生命周期版本永远停在命中时刻')
  assert.equal(frozen.planVersion, 2, '历史命中的方案版本永远停在命中时刻')
  assert.equal(frozen.exitAt, '2026-11-12 18:30', '退出时间不被后续阶段推进覆盖')

  heading('并发阶段推进：第二次携带旧版本必须失败，阶段历史只允许一条新增')
  const historyLen = stage2.data!.model.stageHistory.length
  const staleStage = advanceLifecycleStage(life2Id, { expectedVersion: 2, at: '2026-11-12 19:25' })
  assert.equal(staleStage.ok, false)
  assert.match(staleStage.message, /并发冲突/)
  assert.equal(listLifecycles().find((m) => m.id === life2Id)!.version, 3)
  assert.equal(listLifecycles().find((m) => m.id === life2Id)!.stageHistory.length, historyLen)

  heading('下线核查报告：ABGR 四项配置 + LIFE 三项指标齐全')
  const report = buildOfflineCheck(abgr2().id, 'U-8842')
  assert.equal(report.ok, true)
  const r = report.data!
  assert.ok(r.plan.splitRatio.includes('50%'))
  assert.deepEqual(r.plan.groupKeys, ['A', 'B'])
  assert.ok(r.plan.mutexRule.length > 0)
  assert.equal(r.plan.effectivePages, '结算页')
  assert.equal(r.lifecycle!.currentStage, '成熟期')
  assert.equal(r.lifecycle!.stageStayThreshold, '5 天')
  assert.equal(r.lifecycle!.churnCycleDays, 14)
  assert.equal(r.probe.eligible, false, '探针确认新命中停止')
  assert.equal(r.hits.find((h) => h.userId === 'U-8842')!.groupKey, 'B', '核查页旧命中可查且原分组为 B')

  // ---------------------------------------------------------------- 场景二：生命周期阶段独立驱动分组退出
  resetExperimentDomain()
  heading('场景二：方案在线时，生命周期进入无资格阶段应在同一提交内退出在组分组')
  const plan2 = listPlans().find((p) => p.planCode === 'ABGR-0002')!
  assert.equal(advancePlan(plan2.id, '生效方案', { at: '2026-11-13 10:00' }).ok, true)
  const ratioHit = recordHit({ planId: plan2.id, userId: 'U-7000', at: '2026-11-13 10:05' })
  assert.equal(ratioHit.ok, true)
  assert.equal(ratioHit.data!.hit.state, 'active')

  // 引入期 → 成长期（仍有资格）：在组分组保留
  const grow = advanceLifecycleStage(2, { at: '2026-11-13 11:00' })
  assert.equal(grow.ok, true)
  assert.equal(grow.data!.exitedHits, 0)
  assert.equal(listHits().find((h) => h.userId === 'U-7000')!.state, 'active')

  // 成长期 → 成熟期（无资格）：同一次提交内退出
  const mature = advanceLifecycleStage(2, { at: '2026-11-13 12:00' })
  assert.equal(mature.ok, true)
  assert.equal(mature.data!.exitedHits, 1)
  const exitedHit = listHits().find((h) => h.userId === 'U-7000')!
  assert.equal(exitedHit.state, 'exited')
  assert.equal(exitedHit.exitAt, '2026-11-13 12:00')
  assert.match(exitedHit.exitReason ?? '', /无实验资格/)

  // 继续推进到流失期：已退出记录保持 exited，绝不回活
  const churn = advanceLifecycleStage(2, { at: '2026-11-13 13:00' })
  assert.equal(churn.ok, true)
  assert.equal(listHits().find((h) => h.userId === 'U-7000')!.state, 'exited')

  heading('未启用模型禁止推进阶段')
  const life1 = listLifecycles().find((m) => m.modelCode === 'LIFE-0001')!
  assert.equal(advanceLifecycleStage(life1.id).ok, false)

  heading('末阶段不可继续推进')
  assert.equal(advanceLifecycleStage(2).ok, false, 'LIFE-0002 已到流失期（末阶段）')

  console.log('\n全部验收用例通过 ✅')
}
