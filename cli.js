#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const { parseArgs } = require('util')

const USAGE = `
peertube-supernovao — PeerTube remote runner bridge for supernovao distributed encoding

USAGE
  peertube-supernovao [command] [options]

COMMANDS
  start                Start the bridge (default)
  register             Register with PeerTube and print runner token
  unregister           Unregister from PeerTube
  status               Check PeerTube connectivity

OPTIONS
  -c, --config <path>  Config file path (default: ./config.json)
  -v, --version        Print version
  -h, --help           Print this help
`

const { values, positionals } = parseArgs({
  options: {
    config: { type: 'string', short: 'c', default: './config.json' },
    version: { type: 'boolean', short: 'v', default: false },
    help: { type: 'boolean', short: 'h', default: false }
  },
  allowPositionals: true,
  strict: false
})

if (values.help) {
  console.log(USAGE.trim())
  process.exit(0)
}

if (values.version) {
  const pkg = require('./package.json')
  console.log(pkg.version)
  process.exit(0)
}

function loadConfig(configPath) {
  const resolved = path.resolve(configPath)
  if (!fs.existsSync(resolved)) {
    console.error('Config file not found: %s', resolved)
    process.exit(1)
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'))
}

const command = positionals[0] || 'start'

async function main() {
  const config = loadConfig(values.config)

  switch (command) {
    case 'start': {
      const Bridge = require('./lib/bridge')
      const bridge = new Bridge(config)
      await bridge.start()
      break
    }

    case 'register': {
      const RunnerClient = require('./lib/runner-client')
      const client = new RunnerClient(config.peertube)
      const data = await client.register()
      console.log('Runner token: %s', data.runnerToken)
      console.log('Runner ID: %s', data.id)

      // Write token back to config
      config.peertube.runnerToken = data.runnerToken
      const configPath = path.resolve(values.config)
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n')
      console.log('Token saved to %s', configPath)
      break
    }

    case 'unregister': {
      const RunnerClient = require('./lib/runner-client')
      const client = new RunnerClient(config.peertube)
      if (!config.peertube.runnerToken) {
        console.error('No runner token in config — register first')
        process.exit(1)
      }
      client.runnerToken = config.peertube.runnerToken
      await client.unregister()
      console.log('Unregistered from PeerTube')
      break
    }

    case 'status': {
      try {
        const url = config.peertube.url + '/api/v1/config'
        const res = await fetch(url)
        if (!res.ok) {
          console.log('PeerTube returned %d', res.status)
          process.exit(1)
        }
        const data = await res.json()
        console.log('PeerTube: %s', config.peertube.url)
        console.log('Version: %s', data.serverVersion || 'unknown')
        console.log('Runner registered: %s', config.peertube.runnerToken ? 'yes' : 'no')
      } catch (err) {
        console.error('Cannot reach PeerTube at %s: %s', config.peertube.url, err.message)
        process.exit(1)
      }
      break
    }

    default:
      console.error('Unknown command: %s', command)
      console.log(USAGE.trim())
      process.exit(1)
  }
}

main().catch(err => {
  console.error('Fatal: %s', err.message)
  process.exit(1)
})
