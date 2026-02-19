const os = require('os')
const fs = require('fs')
const path = require('path')
const debug = require('debug')('ptsn:bridge')
const logger = require('pino')({ name: 'bridge' })

const RunnerClient = require('./runner-client')
const createSocketListener = require('./socket-listener')
const { translateJob, downloadInput, isSupported } = require('./job-translator')
const PoolManager = require('./pool-manager')
const { prepareResult, uploadResult, cleanupTemp } = require('./result-assembler')
const { JobWatchdog, HealthMonitor, gracefulShutdown } = require('./health')

class Bridge {
  constructor(config) {
    this.config = config
    this.runnerClient = new RunnerClient(config.peertube)
    this.poolManager = new PoolManager(config.supernovao)
    this.watchdog = new JobWatchdog(config.timeouts.jobTimeoutMs)
    this.healthMonitor = new HealthMonitor(
      this.runnerClient, this.poolManager,
      {
        checkIntervalMs: 30000,
        maxConsecutiveFailures: 5,
        jobTimeoutMs: config.timeouts.jobTimeoutMs
      }
    )
    this.activeJobs = new Map()
    this.failedJobs = new Set()
    this.isRunning = false
    this.pollTimer = null
    this.socket = null
    this.log = logger.child({ component: 'bridge' })
  }

  async start() {
    // 1. Require runner token from config — register separately via `node cli.js register`
    if (!this.config.peertube.runnerToken) {
      throw new Error('No runnerToken in config — run `node cli.js register` first')
    }
    this.runnerClient.runnerToken = this.config.peertube.runnerToken
    this.log.info('Using runner token from config')

    // 2. Start pool (drive + swarm) and log pool key
    await this.poolManager.start()

    // 3. Connect Socket.IO for job notifications
    this.socket = createSocketListener(
      this.config.peertube.url,
      this.runnerClient.runnerToken,
      () => {
        debug('Socket.IO notified of available jobs')
        this.poll().catch(err => debug('poll error from socket trigger: %s', err.message))
      }
    )

    // 3. Start health monitor
    this.healthMonitor.start()
    this.healthMonitor.on('unhealthy', ({ reason }) => {
      this.log.error({ reason }, 'PeerTube unhealthy — pausing job acceptance')
    })

    // 4. Start poll loop
    this.isRunning = true
    this.pollTimer = setInterval(() => {
      this.poll().catch(err => debug('poll error: %s', err.message))
    }, this.config.polling.intervalMs)

    // 5. Signal handlers
    const shutdown = async () => {
      this.log.info('Shutdown signal received')
      await this.stop()
      process.exit(0)
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)

    this.log.info('Bridge started — polling every %dms, max %d concurrent jobs',
      this.config.polling.intervalMs, this.config.polling.maxConcurrentJobs)
  }

  async poll() {
    if (!this.isRunning) return
    if (!this.healthMonitor.isHealthy()) {
      debug('skipping poll — health check failing')
      return
    }
    if (this.activeJobs.size >= this.config.polling.maxConcurrentJobs) {
      debug('skipping poll — at concurrency limit (%d/%d)',
        this.activeJobs.size, this.config.polling.maxConcurrentJobs)
      return
    }

    try {
      const { availableJobs } = await this.runnerClient.requestJob()

      for (const job of availableJobs) {
        if (this.activeJobs.size >= this.config.polling.maxConcurrentJobs) break
        if (!isSupported(job.type)) {
          debug('skipping unsupported job type: %s', job.type)
          continue
        }
        if (this.failedJobs.has(job.uuid)) {
          debug('skipping previously failed job: %s', job.uuid)
          continue
        }

        await this.runnerClient.acceptJob(job.uuid)
        this.log.info({ jobUUID: job.uuid, type: job.type }, 'Accepted job')

        // Run concurrently — don't await
        this.processJob(job.uuid, job.type, job.payload)
          .catch(err => this.log.error({ jobUUID: job.uuid, err: err.message }, 'Job failed'))
      }
    } catch (err) {
      this.log.error({ err: err.message }, 'Poll error')
    }
  }

  async processJob(jobUUID, jobType, payload) {
    this.activeJobs.set(jobUUID, { type: jobType, startTime: Date.now() })
    let tempDir = null
    let poolTempDir = null

    try {
      // 1. Translate job
      const workflow = translateJob(jobType, payload, this.config.supernovao)
      workflow.jobUUID = jobUUID

      // 2. Create temp directory
      tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `ptsn-${jobUUID.slice(0, 8)}-`))

      // 3. Download input file (PT runner API requires POST with both tokens)
      const inputPath = path.join(tempDir, 'input.mp4')
      const jobToken = this.runnerClient.jobTokens.get(jobUUID)
      await downloadInput(workflow.inputUrl, inputPath, this.runnerClient.runnerToken, jobToken)
      workflow.localInputPath = inputPath
      this.log.info({ jobUUID }, 'Input downloaded')

      // 4. Start watchdog
      this.watchdog.watch(jobUUID, async (uuid) => {
        this.log.error({ jobUUID: uuid }, 'Job timed out')
        try {
          await this.runnerClient.postError(uuid, 'Job timed out')
          await this.poolManager.cancelJob(uuid)
        } catch (err) {
          debug('timeout cleanup error: %s', err.message)
        }
      })

      // 5. Process through pool
      const poolResult = await this.poolManager.processJob(
        workflow,
        (percent) => {
          this.watchdog.kick(jobUUID)
          this.runnerClient.updateJob(jobUUID, percent)
            .catch(err => debug('progress update error: %s', err.message))
        }
      )
      poolTempDir = poolResult.tempDir

      // 6. Prepare and upload result
      const result = await prepareResult(poolResult.outputPath, workflow)
      await uploadResult(this.runnerClient, jobUUID, result)
      this.log.info({ jobUUID, type: jobType }, 'Job completed successfully')

      // 7. Clear watchdog
      this.watchdog.clear(jobUUID)
    } catch (err) {
      // Report error to PeerTube
      this.log.error({ jobUUID, err: err.message }, 'Job failed')
      try {
        await this.runnerClient.postError(jobUUID, err.message)
      } catch (reportErr) {
        debug('failed to report error to PeerTube: %s', reportErr.message)
      }
      this.failedJobs.add(jobUUID)
      this.watchdog.clear(jobUUID)
      await this.poolManager.cancelJob(jobUUID).catch(() => {})
    } finally {
      this.activeJobs.delete(jobUUID)
      if (tempDir) await cleanupTemp(tempDir)
      if (poolTempDir) await cleanupTemp(poolTempDir)
    }
  }

  async stop() {
    this.isRunning = false
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
    await gracefulShutdown(
      this.runnerClient, this.poolManager, this.watchdog, this.healthMonitor
    )
  }
}

module.exports = Bridge
