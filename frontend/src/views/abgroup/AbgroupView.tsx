import { useCallback, useMemo, useState } from 'react'

import {
  advancePlan,
  buildOfflineCheck,
  listHits,
  listPlans,
  recordHit,
  resetExperimentDomain,
} from '@/api/experiment-service'
import type { AbPlan, ActionResult, ExperimentHit } from '@/data/abtest-types'
import { AB_PLAN_ACTIONS, AB_PLAN_FLOW } from '@/data/abtest-types'
import { HitStateBadge, PlanFlowDiagram, PlanStatusBadge } from '@/components/experiment-ui'

type Notice = { kind: 'info' | 'warn' | 'error' | 'success'; text: string }

/** 从当前状态推导唯一合法的下一步动作；已下线返回空（终态）。 */
function nextAction(status: AbPlan['status']): keyof typeof AB_PLAN_ACTIONS | null {
  const index = AB_PLAN_FLOW.indexOf(status)
  if (index < 0 || index >= AB_PLAN_FLOW.length - 1) {
    return null
  }
  const targetStatus = AB_PLAN_FLOW[index + 1]
  const entry = Object.entries(AB_PLAN_ACTIONS).find(([, target]) => target === targetStatus)
  return (entry?.[0] ?? null) as keyof typeof AB_PLAN_ACTIONS | null
}

const FLOW_DOC = [
  '状态机单向：草稿 → 方案评审中 → 已生效 → 已下线，跳跃/回退/重复推进一律拒绝。',
  '命中两道闸：方案必须「已生效」，且绑定的生命周期模型当前阶段仍有资格。',
  '下线一次提交：方案置下线 + 白名单清空（停新命中）+ 在组命中退出；历史分流结果保留可查。',
  '并发控制：携带版本号的乐观锁 + 命中幂等，重复下线或并发推进不会留下两组结果。',
]

export default function AbgroupView() {
  const [version, setVersion] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [hitUserId, setHitUserId] = useState('U-8842')
  const [hitAt, setHitAt] = useState('')
  const [checkPlanId, setCheckPlanId] = useState<number>(2)
  const [probeUserId, setProbeUserId] = useState('U-8842')

  const plans = useMemo(() => listPlans(), [version])
  const hits = useMemo(() => listHits(), [version])
  const refresh = useCallback(() => setVersion((v) => v + 1), [])

  function showResult(result: ActionResult<unknown>) {
    setNotice({ kind: result.ok ? 'success' : 'error', text: result.message })
    if (result.ok) {
      refresh()
    }
  }

  function handleAdvance(plan: AbPlan, action: keyof typeof AB_PLAN_ACTIONS) {
    const at = hitAt.trim() || undefined
    showResult(advancePlan(plan.id, action, { expectedVersion: plan.version, at }))
  }

  function handleHit(plan: AbPlan) {
    const userId = hitUserId.trim()
    if (!userId) {
      setNotice({ kind: 'warn', text: '请先填写要模拟命中的用户标识' })
      return
    }
    showResult(recordHit({ planId: plan.id, userId, at: hitAt.trim() || undefined }))
  }

  function handleReset() {
    showResult(resetExperimentDomain())
    setHitUserId('U-8842')
    setHitAt('')
  }

  const checkReport = useMemo(
    () => buildOfflineCheck(checkPlanId, probeUserId.trim() || 'U-8842'),
    // version 变化时重新计算；入参变化也重新计算。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, checkPlanId, probeUserId],
  )
  const report = checkReport.ok ? checkReport.data : undefined

  return (
    <section className="page" data-module="abgroup">
      <header className="page-head">
        <div>
          <h2>分流配置 · 生命周期实验台</h2>
          <p className="page-desc">
            管理 A/B 实验分流方案的状态机、白名单命中与下线联动；下线后停止新命中、保留历史分流结果。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={refresh}>刷新数据</button>
          <button className="btn ghost" type="button" onClick={handleReset}>重置实验域</button>
        </div>
      </header>

      {notice && <div className={`notice notice-${notice.kind}`}>{notice.text}</div>}

      <div className="domain-panel">
        <h3>调用链路与状态机（先梳理链路，再分步演练）</h3>
        <PlanFlowDiagram currentStatus={plans.find((p) => p.id === 2)?.status ?? '草稿'} />
        <ol className="panel-sub" style={{ paddingLeft: 18, lineHeight: 1.9 }}>
          {FLOW_DOC.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      </div>

      <div className="domain-panel">
        <h3>① 分流方案与白名单</h3>
        <p className="panel-sub">
          每行只暴露当前状态下唯一合法的下一步动作；已下线为终态，无动作按钮。白名单在方案下线时随级联清空。
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th>方案编号</th>
              <th>方案名称</th>
              <th>状态/版本</th>
              <th>白名单用户（下线即清空）</th>
              <th>绑定生命周期</th>
              <th>生效/下线时间</th>
              <th>状态机动作</th>
              <th>模拟命中</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => {
              const action = nextAction(plan.status)
              return (
                <tr key={plan.id}>
                  <td className="mono">{plan.planCode}</td>
                  <td>{plan.planName}</td>
                  <td>
                    <PlanStatusBadge status={plan.status} />
                    <div className="muted mono" style={{ fontSize: 12 }}>v{plan.version}</div>
                  </td>
                  <td>
                    {plan.whitelist.length === 0 ? (
                      <span className="whitelist-empty">已清空（无新白名单命中）</span>
                    ) : (
                      plan.whitelist.map((w) => (
                        <span key={w.userId} className="whitelist-chip">
                          {w.userId} → {w.groupKey}
                        </span>
                      ))
                    )}
                  </td>
                  <td className="mono">{plan.lifecycleCode}</td>
                  <td style={{ fontSize: 12 }}>
                    <div>生效：{plan.effectiveAt ?? '—'}</div>
                    <div>下线：{plan.offlineAt ?? '—'}</div>
                  </td>
                  <td className="row-actions">
                    {action ? (
                      <button
                        className="btn"
                        type="button"
                        onClick={() => handleAdvance(plan, action)}
                      >
                        {action}（v{plan.version}→v{plan.version + 1}）
                      </button>
                    ) : (
                      <span className="muted">终态，不可再推进</span>
                    )}
                  </td>
                  <td className="row-actions">
                    <button className="btn primary" type="button" onClick={() => handleHit(plan)}>
                      命中 {hitUserId || '（填用户）'}
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <div className="demo-bar" style={{ marginTop: 10 }}>
          <label className="kv-item" style={{ margin: 0 }}>
            <span className="kv-key">模拟用户标识</span>
            <input className="inline-input" value={hitUserId} onChange={(e) => setHitUserId(e.target.value)} />
          </label>
          <label className="kv-item" style={{ margin: 0 }}>
            <span className="kv-key">事件时间（留空取当前，格式 2026-11-12 18:30）</span>
            <input className="inline-input" value={hitAt} placeholder="2026-11-12 18:30" onChange={(e) => setHitAt(e.target.value)} />
          </label>
        </div>
      </div>

      <div className="domain-panel">
        <h3>② 实验分流结果（历史命中可查，新命中受控）</h3>
        <p className="panel-sub">
          命中时冻结方案版本与生命周期版本快照；退出只写退出时间与原因，记录不删除——旧分组永远以命中时刻版本为准。
        </p>
        <table className="data-table">
          <thead>
            <tr>
              <th>用户</th>
              <th>方案</th>
              <th>原分组</th>
              <th>来源</th>
              <th>命中时间</th>
              <th>快照版本</th>
              <th>生命周期阶段快照</th>
              <th>状态</th>
              <th>退出时间/原因</th>
            </tr>
          </thead>
          <tbody>
            {hits.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={9}>暂无命中记录：先把方案推进到「已生效」再模拟命中</td>
              </tr>
            )}
            {hits.map((hit: ExperimentHit) => (
              <tr key={hit.id}>
                <td className="mono">{hit.userId}</td>
                <td className="mono">{hit.planCode}</td>
                <td><strong>{hit.groupKey}</strong></td>
                <td>{hit.hitSource}</td>
                <td>{hit.hitAt}</td>
                <td className="mono">方案 v{hit.planVersion} / 生命周期 v{hit.lifecycleVersion}</td>
                <td>{hit.lifecycleStage}</td>
                <td><HitStateBadge state={hit.state} /></td>
                <td style={{ fontSize: 12 }}>
                  {hit.state === 'exited' ? (
                    <>
                      <div>{hit.exitAt}</div>
                      <div className="muted">{hit.exitReason}</div>
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="domain-panel">
        <h3>③ 下线核查（配置快照 + 新命中探针）</h3>
        <div className="demo-bar" style={{ marginBottom: 10 }}>
          <label className="kv-item" style={{ margin: 0 }}>
            <span className="kv-key">核查方案</span>
            <select
              className="inline-input"
              value={checkPlanId}
              onChange={(e) => setCheckPlanId(Number(e.target.value))}
            >
              {plans.map((plan) => (
                <option key={plan.id} value={plan.id}>{plan.planCode}（{plan.status}）</option>
              ))}
            </select>
          </label>
          <label className="kv-item" style={{ margin: 0 }}>
            <span className="kv-key">探针用户</span>
            <input
              className="inline-input"
              value={probeUserId}
              onChange={(e) => setProbeUserId(e.target.value)}
            />
          </label>
        </div>

        {report && (
          <>
            <h4>ABGR 方案配置（分流比例 / 分组标识 / 互斥规则 / 生效页面）</h4>
            <div className="kv-grid">
              <div className="kv-item"><span className="kv-key">方案编号 / 状态</span><span className="kv-val">{report.plan.planCode} <PlanStatusBadge status={report.plan.status} /></span></div>
              <div className="kv-item"><span className="kv-key">分流比例</span><span className="kv-val">{report.plan.splitRatio}</span></div>
              <div className="kv-item"><span className="kv-key">分组标识</span><span className="kv-val">{report.plan.groupKeys.join('、')}</span></div>
              <div className="kv-item"><span className="kv-key">互斥规则</span><span className="kv-val">{report.plan.mutexRule}</span></div>
              <div className="kv-item"><span className="kv-key">生效页面</span><span className="kv-val">{report.plan.effectivePages}</span></div>
              <div className="kv-item"><span className="kv-key">下线时间</span><span className="kv-val">{report.plan.offlineAt ?? '—'}</span></div>
            </div>

            {report.lifecycle && (
              <>
                <h4>绑定的 LIFE 生命周期（当前阶段 / 阶段停留阈值 / 流失周期天）</h4>
                <div className="kv-grid">
                  <div className="kv-item"><span className="kv-key">模型编号 / 状态</span><span className="kv-val mono">{report.lifecycle.modelCode}（{report.lifecycle.status} v{report.lifecycle.version}）</span></div>
                  <div className="kv-item"><span className="kv-key">当前阶段</span><span className="kv-val">{report.lifecycle.currentStage}（第 {report.lifecycle.stageOrder} 阶段）</span></div>
                  <div className="kv-item"><span className="kv-key">阶段停留阈值</span><span className="kv-val">{report.lifecycle.stageStayThreshold}</span></div>
                  <div className="kv-item"><span className="kv-key">流失周期天</span><span className="kv-val">{report.lifecycle.churnCycleDays} 天</span></div>
                </div>
              </>
            )}

            <h4>新命中探针（不落盘，验证“新命中停止”）</h4>
            {report.probe.eligible ? (
              <div className="notice notice-success">
                探针用户 {report.probeUserId} 仍可命中：{report.probe.reason || '方案已生效且生命周期阶段有资格'}
              </div>
            ) : (
              <div className="notice notice-error">
                新命中已拦截：用户 {report.probeUserId} —— {report.probe.reason}
              </div>
            )}

            <h4>该方案历史实验分流结果（旧命中可查）</h4>
            <table className="data-table">
              <thead>
                <tr><th>用户</th><th>原分组</th><th>来源</th><th>命中时间</th><th>状态</th><th>退出时间</th><th>退出原因</th></tr>
              </thead>
              <tbody>
                {report.hits.length === 0 && (
                  <tr><td className="empty-state" colSpan={7}>该方案尚无历史命中</td></tr>
                )}
                {report.hits.map((hit) => (
                  <tr key={hit.id}>
                    <td className="mono">{hit.userId}</td>
                    <td><strong>{hit.groupKey}</strong></td>
                    <td>{hit.hitSource}</td>
                    <td>{hit.hitAt}</td>
                    <td><HitStateBadge state={hit.state} /></td>
                    <td>{hit.exitAt ?? '—'}</td>
                    <td style={{ fontSize: 12 }}>{hit.exitReason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </section>
  )
}
