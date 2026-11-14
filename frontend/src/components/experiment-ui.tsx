import { AB_PLAN_FLOW } from '@/data/abtest-types'
import type { AbPlanStatus, LifecycleModel } from '@/data/abtest-types'

const PLAN_BADGE_CLASS: Record<AbPlanStatus, string> = {
  草稿: 'badge badge-draft',
  方案评审中: 'badge badge-review',
  已生效: 'badge badge-live',
  已下线: 'badge badge-offline',
}

const PLAN_NODE_DESC: Record<AbPlanStatus, string> = {
  草稿: '编辑配置',
  方案评审中: '等待评审',
  已生效: '唯一可命中态',
  已下线: '停新命中/留历史',
}

export function PlanStatusBadge({ status }: { status: AbPlanStatus }) {
  return <span className={PLAN_BADGE_CLASS[status]}>{status}</span>
}

export function HitStateBadge({ state }: { state: 'active' | 'exited' }) {
  return (
    <span className={state === 'active' ? 'badge badge-active' : 'badge badge-exited'}>
      {state === 'active' ? '在组' : '已退出'}
    </span>
  )
}

/** 方案生命周期单向流程图：高亮当前态，已下线节点用终止色。 */
export function PlanFlowDiagram({ currentStatus }: { currentStatus: AbPlanStatus }) {
  const currentIndex = AB_PLAN_FLOW.indexOf(currentStatus)
  return (
    <div className="flow-diagram" role="img" aria-label="分流方案状态流转图">
      {AB_PLAN_FLOW.map((status, index) => {
        const nodeClass = [
          'flow-node',
          index === currentIndex ? 'is-active' : '',
          status === '已下线' && index <= currentIndex ? 'is-terminal' : '',
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <div key={status} style={{ display: 'flex', alignItems: 'center' }}>
            <div className={nodeClass}>
              <span className="node-title">
                {index + 1}. {status}
                {index === currentIndex ? '（当前）' : ''}
              </span>
              <span className="node-desc">{PLAN_NODE_DESC[status]}</span>
            </div>
            {index < AB_PLAN_FLOW.length - 1 && <span className="flow-arrow">→</span>}
          </div>
        )
      })}
    </div>
  )
}

/** 生命周期阶段轨道：当前阶段高亮，无资格阶段加删除线标注。 */
export function LifecycleStageTrack({ model }: { model: LifecycleModel }) {
  return (
    <div className="stage-track">
      {model.stages.map((stage) => {
        const cls = [
          'stage-pill',
          stage.order === model.stageOrder ? 'is-current' : '',
          stage.eligible ? '' : 'is-ineligible',
        ]
          .filter(Boolean)
          .join(' ')
        return (
          <span key={stage.order} className={cls} title={stage.eligible ? '有实验资格' : '无实验资格'}>
            {stage.order}. {stage.name}
            {stage.eligible ? '' : '（无资格）'}
          </span>
        )
      })}
    </div>
  )
}
