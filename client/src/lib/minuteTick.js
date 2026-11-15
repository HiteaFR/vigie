// Wall display clock, one tick per minute aligned on the minute change (no render every
// second). Pure: the clock and the timers are injected (tests without waiting).

// delay (ms) until the start of the next minute; exactly on a minute → a whole minute
export function msToNextMinute(nowMs) {
  const r = ((nowMs % 60_000) + 60_000) % 60_000
  return 60_000 - r
}

// onTick() at the start of each minute: first tick at the next minute, then one per minute (the
// delay is recomputed on every tick: no drift); → stop function
export function startMinuteTicks(onTick, { now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let t = null
  let stopped = false
  const arm = () => {
    t = setTimer(() => {
      if (stopped) return
      onTick()
      arm()
    }, msToNextMinute(now()))
  }
  arm()
  return () => {
    stopped = true
    clearTimer(t)
  }
}
