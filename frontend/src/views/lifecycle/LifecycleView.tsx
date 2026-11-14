import { useCallback, useMemo, useState } from 'react'

import {
  advanceLifecycleStage,
  listHits,
  listLifecycles,
  listPlans,
  resetExperimentDomain,
} from '@/api/experiment-service'
import type { ActionResult, LifecycleModel } from '@/data/abtest-types'
import { HitStateBadge, LifecycleStageTrack } from '@/components/experiment-ui'

type Notice = { kind: 'info' | 'warn' | 'error' | 'success'; text: string }

export default function LifecycleView() {
  const [version, setVersion] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [advanceAt, setAdvanceAt] = useState('')

  const models = useMemo(() => listLifecycles(), [version])
  const plans = useMemo(() => listPlans(), [version])
  const hits = useMemo(() => listHits(), [version])
  const refresh = useCallback(() => setVersion((v) => v + 1), [])

  function showResult(result: ActionResult<unknown>) {
    setNotice({ kind: result.ok ? 'success' : 'error', text: result.message })
    if (result.ok) {
      refresh()
    }
  }

  function handleAdvance(model: LifecycleModel) {
    showResult(
      advanceLifecycleStage(model.id, {
        expectedVersion: model.version,
        at: advanceAt.trim() || undefined,
      }),
    )
  }

  function handleReset() {
    showResult(resetExperimentDomain())
    setAdvanceAt('')
  }

  return (
    <section className="page" data-module="lifecycle">
      <header className="page-head">
        <div>
          <h2>生命周期管理 · 实验资格联动</h2>
          <p className="page-desc">
            阶段单向推进；进入无资格阶段时，绑定方案的在组分组在同一次提交内退出。退出为终态，后续推进不会把用户拉回旧方案。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={refresh}>刷新数据</button>
          <button className="btn ghost" type="button" onClick={handleReset}>重置实验域</button>
        </div>
      </header>

      {notice && <div className={`notice notice-${notice.kind}`}>{notice.text}</div>}

      <div className="domain-panel">
        <h3>① 生命周期模型与阶段推进</h3>
        <div className="demo-bar" style={{ marginBottom: 10 }}>
          <label className="kv-item" style={{ margin: 0 }}>
            <span className="kv-key">推进时间（留空取当前，格式 2026-11-12 19:05）</span>
            <input
              className="inline-input"
              value={advanceAt}
              placeholder="2026-11-12 19:05"
              onChange={(e) => setAdvanceAt(e.target.value)}
            />
          </label>
        </div>

        {models.map((model) => {
          const atLast = model.stageOrder >= model.stages.length
          return (
            <article key={model.id} className="domain-panel" style={{ background: '#fbfdff' }}>
              <h4>
                <span className="mono">{model.modelCode}</span> · {model.modelName}
                <span className="badge badge-live" style={{ marginLeft: 8 }}>{model.status}</span>
                <span className="muted mono" style={{ marginLeft: 8, fontSize: 12 }}>v{model.version}</span>
              </h4>
              <LifecycleStageTrack model={model} />
              <div className="kv-grid">
                <div className="kv-item"><span className="kv-key">当前阶段</span><span className="kv-val">{model.currentStage}（第 {model.stageOrder}/{model.stages.length} 阶段）</span></div>
                <div className="kv-item"><span className="kv-key">阶段停留阈值</span><span className="kv-val">{model.stageStayThreshold}</span></div>
                <div className="kv-item"><span className="kv-key">流失周期天</span><span className="kv-val">{model.churnCycleDays} 天</span></div>
                <div className="kv-item"><span className="kv-key">流转条件</span><span className="kv-val">{model.transitionCondition}</span></div>
                <div className="kv-item"><span className="kv-key">阶段定义事件</span><span className="kv-val">{model.stageDefinitionEvent}</span></div>
                <div className="kv-item"><span className="kv-key">回归条件</span><span className="kv-val">{model.regressionCondition}</span></div>
              </div>
              <div style={{ marginTop: 10 }}>
                {model.status === '已启用' && !atLast ? (
                  <button className="btn primary" type="button" onClick={() => handleAdvance(model)}>
                    推进到「{model.stages.find((s) => s.order === model.stageOrder + 1)?.name}」（v{model.version}→v{model.version + 1}）
                  </button>
                ) : (
                  <span className="muted">{atLast ? '已到末阶段，不可继续推进' : '模型未启用，暂不能推进'}</span>
                )}
              </div>
              <h4>阶段推进历史（版本轨迹）</h4>
              <ul className="timeline">
                {model.stageHistory.map((record) => (
                  <li key={`${record.order}-${record.version}`}>
                    v{record.version} · 第 {record.order} 阶段「{record.stage}」 · {record.advancedAt}
                  </li>
                ))}
              </ul>
            </article>
          )
        })}
      </div>

      <div className="domain-panel">
        <h3>② 实验分组成员（退出前分组不再残留为“在组”）</h3>
        <p className="panel-sub">
          这里按生命周期模型聚合其绑定方案的命中：在组命中显示当前分组；已退出命中保留原分组与退出时间，且不会因后续阶段推进变回在组。
        </p>
        {models.map((model) => {
          const boundPlans = plans.filter((plan) => plan.lifecycleCode === model.modelCode)
          const boundPlanIds = new Set(boundPlans.map((plan) => plan.id))
          const modelHits = hits.filter((hit) => boundPlanIds.has(hit.planId))
          const activeCount = modelHits.filter((hit) => hit.state === 'active').length
          return (
            <article key={model.id} className="domain-panel" style={{ background: '#fbfdff' }}>
              <h4>
                <span className="mono">{model.modelCode}</span> · {model.currentStage}
                <span className="muted" style={{ marginLeft: 8, fontSize: 12 }}>
                  绑定 {boundPlans.map((p) => p.planCode).join('、') || '无方案'} · 在组 {activeCount} / 历史 {modelHits.length}
                </span>
              </h4>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>用户</th>
                    <th>方案</th>
                    <th>原分组（快照保留）</th>
                    <th>命中时生命周期阶段</th>
                    <th>快照版本</th>
                    <th>成员状态</th>
                    <th>退出时间</th>
                    <th>退出原因</th>
                  </tr>
                </thead>
                <tbody>
                  {modelHits.length === 0 && (
                    <tr><td className="empty-state" colSpan={8}>该生命周期下暂无实验命中</td></tr>
                  )}
                  {modelHits.map((hit) => (
                    <tr key={hit.id}>
                      <td className="mono">{hit.userId}</td>
                      <td className="mono">{hit.planCode}</td>
                      <td><strong>{hit.groupKey}</strong></td>
                      <td>{hit.lifecycleStage} <span className="muted">（命中时刻）</span></td>
                      <td className="mono">方案 v{hit.planVersion} / 生命周期 v{hit.lifecycleVersion}</td>
                      <td><HitStateBadge state={hit.state} /></td>
                      <td>{hit.exitAt ?? '—'}</td>
                      <td style={{ fontSize: 12 }}>{hit.exitReason ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>
          )
        })}
      </div>
    </section>
  )
}
