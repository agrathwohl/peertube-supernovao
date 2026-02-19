const fs = require('fs')
const debug = require('debug')('ptsn:result-assembler')
const logger = require('pino')({ name: 'result-assembler' })
const ffmpeg = require('fluent-ffmpeg')

async function probeFile(filePath) {
  return new Promise((resolve, reject) => {
    debug('ffprobe %s', filePath)
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(new Error(`ffprobe failed on ${filePath}: ${err.message}`))
      if (!metadata || !metadata.streams || !metadata.streams.length) {
        return reject(new Error(`No media streams found in ${filePath}`))
      }
      resolve(metadata)
    })
  })
}

async function prepareResult(outputPath, workflow) {
  debug('preparing result: %s type=%s', outputPath, workflow.type)

  try {
    await fs.promises.access(outputPath, fs.constants.R_OK)
  } catch {
    throw new Error(`Output file missing: ${outputPath}`)
  }

  const stat = await fs.promises.stat(outputPath)
  if (stat.size === 0) {
    throw new Error(`Output file is empty: ${outputPath}`)
  }

  const metadata = await probeFile(outputPath)
  debug('probe ok: %d streams, duration=%s', metadata.streams.length, metadata.format.duration)

  if (workflow.type === 'vod-hls') {
    return { videoFilePath: outputPath, type: 'hls' }
  }

  return { videoFilePath: outputPath, type: 'web-video' }
}

async function uploadResult(runnerClient, jobUUID, result) {
  debug('uploading result for job %s: %s', jobUUID, result.videoFilePath)
  const res = await runnerClient.postSuccess(jobUUID, result.videoFilePath)
  logger.info({ jobUUID, type: result.type }, 'Result uploaded')
  return res
}

async function cleanupTemp(tempDir) {
  debug('cleaning up %s', tempDir)
  try {
    await fs.promises.rm(tempDir, { recursive: true, force: true })
    debug('cleaned %s', tempDir)
  } catch (err) {
    debug('cleanup failed (best-effort): %s', err.message)
  }
}

module.exports = { prepareResult, uploadResult, cleanupTemp, probeFile }
