export interface PetActivitySummary {
  startedAt: string
  endedAt: string
  keyboardPresses: number
  mouseClicks: number
  mouseMoveEvents: number
  mouseDistance: number
  active: boolean
  lastActivityAt?: string
}

interface CursorPoint {
  x: number
  y: number
}

const activity = {
  startedAt: new Date(),
  keyboardPresses: 0,
  mouseClicks: 0,
  mouseMoveEvents: 0,
  mouseDistance: 0,
  lastCursorPoint: undefined as CursorPoint | undefined,
  lastActivityAt: undefined as Date | undefined,
}

function markActive() {
  activity.lastActivityAt = new Date()
}

export function recordKeyboardActivity(kind: string) {
  if (kind !== 'KeyboardPress') return

  activity.keyboardPresses += 1
  markActive()
}

export function recordMouseButtonActivity(kind: string) {
  if (kind !== 'MousePress') return

  activity.mouseClicks += 1
  markActive()
}

export function recordMouseMoveActivity(point: CursorPoint) {
  activity.mouseMoveEvents += 1

  if (activity.lastCursorPoint) {
    activity.mouseDistance += Math.hypot(
      point.x - activity.lastCursorPoint.x,
      point.y - activity.lastCursorPoint.y,
    )
  }

  activity.lastCursorPoint = point
  markActive()
}

export function consumePetActivitySummary(): PetActivitySummary {
  const endedAt = new Date()
  const summary = {
    startedAt: activity.startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    keyboardPresses: activity.keyboardPresses,
    mouseClicks: activity.mouseClicks,
    mouseMoveEvents: activity.mouseMoveEvents,
    mouseDistance: Math.round(activity.mouseDistance),
    active: Boolean(activity.lastActivityAt),
    lastActivityAt: activity.lastActivityAt?.toISOString(),
  } satisfies PetActivitySummary

  activity.startedAt = endedAt
  activity.keyboardPresses = 0
  activity.mouseClicks = 0
  activity.mouseMoveEvents = 0
  activity.mouseDistance = 0
  activity.lastCursorPoint = undefined
  activity.lastActivityAt = undefined

  return summary
}

export function formatPetActivityForPrompt(summary: PetActivitySummary) {
  return [
    `统计开始：${summary.startedAt}`,
    `统计结束：${summary.endedAt}`,
    `是否有活动：${summary.active ? '是' : '否'}`,
    `键盘按下次数：${summary.keyboardPresses}`,
    `鼠标点击次数：${summary.mouseClicks}`,
    `鼠标移动事件数：${summary.mouseMoveEvents}`,
    `鼠标移动距离估计：${summary.mouseDistance}px`,
    `最后活动时间：${summary.lastActivityAt ?? '无'}`,
  ].join('\n')
}
