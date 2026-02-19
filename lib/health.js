const { EventEmitter } = require('events')
const debug = require('debug')('ptsn:health')
const logger = require('pino')({ name: 'health' })

class JobWatchdog {
  constructor(timeoutMs) {
    this.timeoutMs = timeoutMs || 3600000
    this.jobs = new Map()
  }

  watch(jobUUID, onTimeout) {
    const timer = setTimeout(() => {
      debug('job %s timed out after %dms', jobUUID, this.timeoutMs)
      onTimeout(jobUUID)
    }, this.timeoutMs)
    this.jobs.set(jobUUID, { timer, onTimeout, startTime: Date.now() })
    debug('watching job %s timeout=%dms', jobUUID, this.timeoutMs)
  }

  kick(jobUUID) {
    const entry = this.jobs.get(jobUUID)
    if (!entry) return
    clearTimeout(entry.timer)
    const elapsed = Date.now() - entry.startTime
    entry.timer = setTimeout(() => {
      debug('job %s timed out after %dms', jobUUID, this.timeoutMs)
      entry.onTimeout(jobUUID)
    }, this.timeoutMs)
    debug('kicked watchdog for %s (elapsed=%dms)', jobUUID, elapsed)
  }

  clear(jobUUID) {
    const entry = this.jobs.get(jobUUID)
    if (!entry) return
    clearTimeout(entry.timer)
    this.jobs.delete(jobUUID)
    debug('cleared watchdog for %s', jobUUID)
  }

  clearAll() {
    for (const [uuid, entry] of this.jobs) {
      clearTimeout(entry.timer)
      debug('cleared watchdog for %s', uuid)
    }
    this.jobs.clear()
  }

  elapsed(jobUUID) {
    const entry = this.jobs.get(jobUUID)
    if (!entry) return -1
    return Date.now() - entry.startTime
  }
}

class HealthMonitor extends EventEmitter {
  constructor(runnerClient, poolManager, config) {
    super()
    this.runnerClient = runnerClient
    this.poolManager = poolManager
    this.peertubeUrl = runnerClient.config.url
    this.checkIntervalMs = (config && config.checkIntervalMs) || 30000
    this.jobTimeoutMs = (config && config.jobTimeoutMs) || 3600000
    this.maxConsecutiveFailures = (config && config.maxConsecutiveFailures) || 5
    this.consecutiveFailures = 0
    this.healthy = true
    this.interval = null
    this.log = logger.child({ component: 'health-monitor' })
  }

  start() {
    this.interval = setInterval(() => this._check(), this.checkIntervalMs)
    debug('health monitor started, interval=%dms', this.checkIntervalMs)
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
    debug('health monitor stopped')
  }

  isHealthy() {
    return this.healthy
  }

  async _check() {
    try {
      const url = this.peertubeUrl + '/api/v1/config'
      const res = await fetch(url)
      if (res.ok) {
        this.consecutiveFailures = 0
        this.healthy = true
        debug('health check passed')
      } else {
        this._recordFailure(`PeerTube returned ${res.status}`)
      }
    } catch (err) {
      this._recordFailure(err.message)
    }

    // Check for zombie jobs (running > 2x job timeout)
    for (const [uuid, job] of this.poolManager.activeJobs) {
      const elapsed = Date.now() - (job.startTime || 0)
      if (elapsed > this.jobTimeoutMs * 2) {
        this.log.warn({ jobUUID: uuid, elapsed }, 'Possible zombie job detected')
      }
    }
  }

  _recordFailure(reason) {
    this.consecutiveFailures++
    debug('health check failed (%d/%d): %s',
      this.consecutiveFailures, this.maxConsecutiveFailures, reason)

    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      this.healthy = false
      this.log.error({ consecutiveFailures: this.consecutiveFailures, reason },
        'PeerTube unreachable')
      this.emit('unhealthy', { reason, consecutiveFailures: this.consecutiveFailures })
    }
  }
}

async function gracefulShutdown(runnerClient, poolManager, watchdog, monitor) {
  const log = logger.child({ component: 'shutdown' })
  log.info('Graceful shutdown initiated')

  const hardTimeout = setTimeout(() => {
    log.error('Shutdown timed out after 30s, forcing exit')
    process.exit(1)
  }, 30000)

  try {
    // 1. Stop health monitor
    monitor.stop()
    log.info('Health monitor stopped')

    // 2. Abort all active jobs — only report if we have a job token
    for (const [uuid] of poolManager.activeJobs) {
      try {
        if (!runnerClient.jobTokens.has(uuid)) {
          debug('no job token for %s, skipping postError', uuid)
          continue
        }
        await runnerClient.postError(uuid, 'Runner shutting down')
      } catch (err) {
        debug('failed to report error for job %s: %s', uuid, err.message)
      }
    }
    await poolManager.destroy()
    log.info('Pool manager destroyed')

    // 3. Clear watchdog timers
    watchdog.clearAll()
    log.info('Watchdog timers cleared')

    // 4. Unregister from PeerTube
    try {
      await runnerClient.unregister()
      log.info('Unregistered from PeerTube')
    } catch (err) {
      debug('unregister failed: %s', err.message)
    }
  } finally {
    clearTimeout(hardTimeout)
  }

  log.info('Shutdown complete')
}

module.exports = { JobWatchdog, HealthMonitor, gracefulShutdown }
