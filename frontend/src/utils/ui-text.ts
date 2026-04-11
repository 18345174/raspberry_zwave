export function translateDriverPhase(phase?: string): string {
  switch (phase) {
    case "idle":
      return "空闲";
    case "connecting":
      return "连接中";
    case "ready":
      return "已就绪";
    case "disconnecting":
      return "断开中";
    case "error":
      return "异常";
    default:
      return phase ?? "-";
  }
}

export function translateWsState(state?: string): string {
  switch (state) {
    case "idle":
      return "空闲";
    case "connecting":
      return "连接中";
    case "open":
      return "已连接";
    case "closed":
      return "已关闭";
    default:
      return state ?? "-";
  }
}

export function translateRunStatus(status?: string): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "running":
      return "执行中";
    case "passed":
      return "通过";
    case "failed":
      return "失败";
    case "cancelled":
      return "已取消";
    case "idle":
      return "空闲";
    default:
      return status ?? "-";
  }
}

export function translatePortKind(isCandidateController: boolean): string {
  return isCandidateController ? "控制器候选" : "串口设备";
}

export function translateChallengeType(type?: string): string {
  switch (type) {
    case "grant_security_classes":
      return "安全等级授权";
    case "validate_dsk":
      return "DSK 校验";
    default:
      return type ?? "-";
  }
}

export function translateBooleanState(active: boolean): string {
  return active ? "进行中" : "空闲";
}

export function translatePingResult(reachable: boolean): string {
  return reachable ? "可达" : "不可达";
}
