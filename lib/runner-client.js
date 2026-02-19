const fs = require('fs')
const path = require('path')
const debug = require('debug')('ptsn:runner-client')
const logger = require('pino')({ name: 'runner-client' })

class RunnerClient {
  constructor(config) {
    this.config = config
    this.runnerToken = null
    this.jobTokens = new Map()
    this.log = logger.child({ runnerName: config.runnerName })
  }

  _apiUrl(p) {
    return this.config.url + p
  }

  _headers() {
    return { 'Content-Type': 'application/json' }
  }

  _jobToken(jobUUID) {
    const token = this.jobTokens.get(jobUUID)
    if (!token) throw new Error(`No job token for job ${jobUUID}`)
    return token
  }

  async register() {
    const url = this._apiUrl('/api/v1/runners/register')
    const body = {
      registrationToken: this.config.registrationToken,
      name: this.config.runnerName,
      description: this.config.runnerDescription
    }
    debug('POST %s %o', url, body)

    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body)
    })

    const data = await res.json()
    debug('register response %d %o', res.status, data)

    if (!res.ok) {
      throw new Error(`Register failed: ${res.status} ${JSON.stringify(data)}`)
    }

    this.runnerToken = data.runnerToken
    this.log.info({ runnerToken: this.runnerToken }, 'Registered with PeerTube')
    return data
  }

  async unregister() {
    const url = this._apiUrl('/api/v1/runners/unregister')
    const body = { runnerToken: this.runnerToken }
    debug('POST %s %o', url, body)

    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body)
    })

    debug('unregister response %d', res.status)

    if (!res.ok) {
      const data = await res.text()
      throw new Error(`Unregister failed: ${res.status} ${data}`)
    }

    this.runnerToken = null
    this.log.info('Unregistered from PeerTube')
  }

  async requestJob() {
    const url = this._apiUrl('/api/v1/runners/jobs/request')
    const body = { runnerToken: this.runnerToken }
    debug('POST %s', url)

    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body)
    })

    const data = await res.json()
    debug('requestJob response %d, %d jobs available', res.status, data.availableJobs?.length ?? 0)

    if (!res.ok) {
      throw new Error(`Request job failed: ${res.status} ${JSON.stringify(data)}`)
    }

    return data
  }

  async acceptJob(jobUUID) {
    const url = this._apiUrl(`/api/v1/runners/jobs/${jobUUID}/accept`)
    const body = { runnerToken: this.runnerToken }
    debug('POST %s %o', url, body)

    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body)
    })

    const data = await res.json()
    debug('acceptJob response %d %o', res.status, data)

    if (!res.ok) {
      throw new Error(`Accept job failed: ${res.status} ${JSON.stringify(data)}`)
    }

    this.jobTokens.set(jobUUID, data.job.jobToken)
    this.log.info({ jobUUID }, 'Accepted job')
    return data
  }

  async updateJob(jobUUID, progress, payload) {
    const url = this._apiUrl(`/api/v1/runners/jobs/${jobUUID}/update`)
    const body = {
      runnerToken: this.runnerToken,
      jobToken: this._jobToken(jobUUID),
      progress,
      payload
    }
    debug('POST %s progress=%d', url, progress)

    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body)
    })

    debug('updateJob response %d', res.status)

    if (!res.ok) {
      const data = await res.text()
      throw new Error(`Update job failed: ${res.status} ${data}`)
    }
  }

  async postSuccess(jobUUID, outputFilePath) {
    const url = this._apiUrl(`/api/v1/runners/jobs/${jobUUID}/success`)
    const jobToken = this._jobToken(jobUUID)

    debug('POST %s (multipart) file=%s', url, outputFilePath)

    const form = new FormData()
    form.append('runnerToken', this.runnerToken)
    form.append('jobToken', jobToken)

    const fileBuffer = await fs.promises.readFile(outputFilePath)
    const fileName = path.basename(outputFilePath)
    const mime = fileName.endsWith('.webm') ? 'video/webm' : 'video/mp4'
    const blob = new Blob([fileBuffer], { type: mime })
    form.append('payload[videoFile]', blob, fileName)

    const res = await fetch(url, {
      method: 'POST',
      body: form
    })

    debug('postSuccess response %d', res.status)

    if (!res.ok) {
      const data = await res.text()
      throw new Error(`Post success failed: ${res.status} ${data}`)
    }

    this.jobTokens.delete(jobUUID)
    this.log.info({ jobUUID }, 'Posted success')
  }

  async postError(jobUUID, message) {
    const url = this._apiUrl(`/api/v1/runners/jobs/${jobUUID}/error`)
    const jobToken = this._jobToken(jobUUID)
    const body = {
      runnerToken: this.runnerToken,
      jobToken,
      message
    }
    debug('POST %s %o', url, body)

    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body)
    })

    debug('postError response %d', res.status)

    if (!res.ok) {
      const data = await res.text()
      throw new Error(`Post error failed: ${res.status} ${data}`)
    }

    this.jobTokens.delete(jobUUID)
    this.log.info({ jobUUID, message }, 'Posted error')
  }

  async abortJob(jobUUID) {
    const url = this._apiUrl(`/api/v1/runners/jobs/${jobUUID}/abort`)
    const jobToken = this._jobToken(jobUUID)
    const body = {
      runnerToken: this.runnerToken,
      jobToken
    }
    debug('POST %s %o', url, body)

    const res = await fetch(url, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(body)
    })

    debug('abortJob response %d', res.status)

    if (!res.ok) {
      const data = await res.text()
      throw new Error(`Abort job failed: ${res.status} ${data}`)
    }

    this.jobTokens.delete(jobUUID)
    this.log.info({ jobUUID }, 'Aborted job')
  }
}

module.exports = RunnerClient
