const fs = require('fs')
const { pipeline } = require('stream/promises')
const debug = require('debug')('ptsn:job-translator')
const logger = require('pino')({ name: 'job-translator' })

const SUPPORTED_TYPES = new Set([
  'vod-web-video-transcoding',
  'vod-hls-transcoding',
  'vod-audio-merge-transcoding'
])

const TYPE_MAP = {
  'vod-web-video-transcoding': 'vod-web',
  'vod-hls-transcoding': 'vod-hls',
  'vod-audio-merge-transcoding': 'audio-merge'
}

const FORMAT_MAP = {
  'vod-web': 'mp4',
  'vod-hls': 'hls',
  'audio-merge': 'mp4'
}

function isSupported(jobType) {
  return SUPPORTED_TYPES.has(jobType)
}

function translateJob(jobType, payload, config) {
  if (!isSupported(jobType)) {
    throw new Error(`Unsupported job type: ${jobType}`)
  }

  if (!payload.input) {
    throw new Error(`payload.input missing for job type ${jobType}`)
  }
  if (!payload.output) {
    throw new Error(`payload.output missing for job type ${jobType}`)
  }

  const type = TYPE_MAP[jobType]
  let inputUrl

  if (jobType === 'vod-audio-merge-transcoding') {
    inputUrl = payload.input.audioFileUrl
  } else {
    inputUrl = payload.input.videoFileUrl
  }

  const workflow = {
    type,
    inputUrl,
    resolution: payload.output.resolution,
    fps: payload.output.fps,
    bitrate: config.bitrate || '200000',
    level: config.level || '5.1',
    outputFormat: FORMAT_MAP[type]
  }

  debug('translated %s -> %o', jobType, workflow)
  return workflow
}

async function downloadInput(inputUrl, destPath, runnerToken, jobToken) {
  debug('downloading %s -> %s', inputUrl, destPath)

  const res = await fetch(inputUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runnerToken, jobToken })
  })

  if (!res.ok) {
    logger.warn({ status: res.status, url: inputUrl }, 'Download failed')
    throw new Error(`Download failed: ${res.status} ${res.statusText} from ${inputUrl}`)
  }

  const fileStream = fs.createWriteStream(destPath)
  await pipeline(res.body, fileStream)

  debug('download complete: %s', destPath)
  return destPath
}

module.exports = { translateJob, downloadInput, isSupported }
