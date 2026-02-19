const os = require('os')
const fs = require('fs')
const path = require('path')
const debug = require('debug')('ptsn:pool-manager')
const logger = require('pino')({ name: 'pool-manager' })
const Hyperswarm = require('hyperswarm')

const store = require('supernovao/lib/store')
const segment = require('supernovao/lib/segment')
const metadata = require('supernovao/lib/metadata')
const mp4 = require('supernovao/lib/mp4')
const Pool = require('supernovao/lib/pool')
const PATHS = require('supernovao/lib/paths')

/**
 * Pipe a readable into a writable using manual chunk transfer.
 * Avoids Node stream/promises pipeline with streamx (Hyperdrive)
 * streams — see supernovao/lib/concat.js for precedent.
 */
function pipeStreams(reader, writer) {
  return new Promise((resolve, reject) => {
    writer.on('finish', resolve)
    writer.on('error', reject)
    reader.on('error', reject)
    reader.on('data', (chunk) => {
      if (!writer.write(chunk)) {
        reader.pause()
        writer.once('drain', () => reader.resume())
      }
    })
    reader.on('end', () => writer.end())
  })
}

class PoolManager {
  constructor(config) {
    this.config = config
    store.init(config.storage || '.supernovao')
    this.activeJobs = new Map()
    this.driveId = 'ptsn/bridge'
    this.swarm = null
    this.poolKey = null
    this.log = logger.child({ component: 'pool-manager' })
  }

  async start() {
    this.swarm = new Hyperswarm()
    this.log.info('Pool manager started')
  }

  async processJob(workflow, onProgress) {
    const jobKey = workflow.jobUUID
    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ptsn-'))

    let pool = null
    let progressInterval = null

    try {
      onProgress(0)

      // 1. Create pool and get its drive (single instance for all writes + reads)
      pool = new Pool(this.driveId, null, {})
      await pool.createPoolDrive()
      const drive = pool.drive
      this.poolKey = drive.key.toString('hex')
      this.log.info({ jobUUID: jobKey, poolKey: this.poolKey }, 'Pool key: %s', this.poolKey)

      // 2. Stream source into pool's drive
      await pipeStreams(
        fs.createReadStream(workflow.localInputPath),
        drive.createWriteStream(`${PATHS.SOURCES}/input.mp4`)
      )
      debug('source written to drive')

      // 3. Metadata extraction
      await metadata(workflow.localInputPath, drive)
      this.log.info({ jobUUID: jobKey }, 'Metadata extracted')
      onProgress(2)

      // 4. Segmentation
      const [segPaths] = await segment(workflow.localInputPath, drive, tempDir)
      this.log.info({ jobUUID: jobKey, segments: segPaths.length }, 'Segmented')
      onProgress(8)

      // 5. Demux tracks
      const trackPaths = await mp4.demux(drive, workflow.localInputPath, tempDir)
      this.log.info({ jobUUID: jobKey }, 'Demuxed tracks')
      onProgress(10)

      // 6. Write config so Pool.loadConfig() finds segments + tracks
      await drive.put(
        `${PATHS.CONFIG}/segments.json`,
        Buffer.from(JSON.stringify(segPaths))
      )
      await drive.put(
        `${PATHS.CONFIG}/tracks.json`,
        Buffer.from(JSON.stringify(trackPaths || []))
      )
      this.log.info({ jobUUID: jobKey }, 'Config written to drive')

      // 7. Load config from same drive instance, then launch
      await pool.loadConfig()
      this.log.info({ jobUUID: jobKey, ready: pool.ready, segments: pool.segments?.length }, 'Pool config loaded')

      if (!pool.ready) {
        throw new Error(`Pool not ready — no segments found in drive ${this.driveId}`)
      }

      await pool.launch(this.swarm)
      this.log.info({ jobUUID: jobKey, poolKey: this.poolKey, segments: segPaths.length }, 'Pool launched')

      this.activeJobs.set(jobKey, { pool, tempDir, startTime: Date.now() })

      // 9. Monitor encoding progress via segment completion
      const totalSegs = pool.segments.length
      progressInterval = setInterval(() => {
        if (totalSegs > 0) {
          const done = pool.segmentsComplete.length
          const pct = 10 + Math.floor((done / totalSegs) * 75)
          onProgress(Math.min(pct, 85))
        }
      }, 2000)

      // Wait for Pool to finish concat + mux
      const outputDrivePath = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error(
            `Job timed out after ${this.config.segmentTimeoutMs || 600000}ms`
          ))
        }, this.config.segmentTimeoutMs || 600000)

        pool.on('finalized', (result) => {
          clearTimeout(timeout)
          resolve(result)
        })
      })

      clearInterval(progressInterval)
      progressInterval = null
      onProgress(95)
      debug('finalized, drive path: %s', outputDrivePath)

      // 10. Extract muxed output from drive to local temp
      const outputPath = path.join(tempDir, 'output.mp4')
      await pipeStreams(
        drive.createReadStream(outputDrivePath),
        fs.createWriteStream(outputPath)
      )

      onProgress(100)
      this.log.info({ jobUUID: jobKey, outputPath }, 'Job complete')

      // Cleanup pool on success (temp kept for caller)
      await pool.destroy()
      pool = null

      return { outputPath, tempDir }
    } catch (err) {
      if (progressInterval) clearInterval(progressInterval)
      throw err
    } finally {
      if (pool) await pool.destroy().catch(() => {})
      this.activeJobs.delete(jobKey)
    }
  }

  async cancelJob(jobUUID) {
    const job = this.activeJobs.get(jobUUID)
    if (!job) return

    const { pool, tempDir } = job
    if (pool) await pool.destroy().catch(() => {})
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {})
    }
    this.activeJobs.delete(jobUUID)
    this.log.info({ jobUUID }, 'Cancelled')
  }

  async destroy() {
    for (const [uuid] of this.activeJobs) {
      await this.cancelJob(uuid)
    }
    if (this.swarm) await this.swarm.destroy()
    await store.close()
    this.log.info('Destroyed')
  }
}

module.exports = PoolManager
