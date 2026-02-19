# peertube-supernovao

PeerTube remote runner bridge that delegates transcoding jobs to supernovao's distributed encoding pools over Hyperswarm.

## How It Works

```
PeerTube Instance
    |
    | HTTP REST + Socket.IO
    |
+---v-----------------------+
|   peertube-supernovao      |
|                            |
|   runner-client.js         |  Registers, polls, accepts, reports
|   job-translator.js        |  PT payload -> supernovao workflow
|   pool-manager.js          |  segment -> pool launch -> monitor
|   result-assembler.js      |  concat -> mux -> upload to PT
+---------------------------+
         |
         | Hyperswarm P2P
         |
    +----v----+  +----v----+
    | Worker  |  | Worker  |
    | Node A  |  | Node B  |
    +---------+  +---------+
```

The bridge registers as a PeerTube remote runner, polls for transcoding jobs, segments the input video, launches a supernovao encoding pool over Hyperswarm, waits for workers to encode segments, then concatenates/muxes the result and uploads it back to PeerTube.

## Requirements

- Node.js >= 18
- ffmpeg / ffprobe on PATH
- A running PeerTube instance (v5.2+) with remote runners enabled
- supernovao workers available on the network

## Install

```sh
npm install
```

Uses a local file reference to `../supernovao`.

## Quick Start

```sh
# 1. Edit config.json with your PeerTube URL and registration token

# 2. Register the runner
node cli.js register

# 3. Start the bridge
node cli.js start
```

## Configuration

| Field | Default | Description |
|-------|---------|-------------|
| `peertube.url` | `http://localhost:9000` | PeerTube instance URL |
| `peertube.registrationToken` | `""` | Token from PeerTube admin panel |
| `peertube.runnerName` | `supernovao-bridge` | Runner display name |
| `peertube.runnerDescription` | `Supernovao distributed encoding bridge` | Runner description |
| `supernovao.storage` | `.supernovao` | Corestore storage path |
| `supernovao.dhtPort` | `49737` | Hyperswarm DHT port |
| `supernovao.bitrate` | `200000` | Encode bitrate |
| `supernovao.level` | `5.1` | H.264 level |
| `polling.intervalMs` | `5000` | Job poll interval (ms) |
| `polling.maxConcurrentJobs` | `2` | Max parallel jobs |
| `timeouts.jobTimeoutMs` | `3600000` | Job timeout (ms) |
| `timeouts.segmentTimeoutMs` | `600000` | Segment/pool timeout (ms) |

## Commands

| Command | Description |
|---------|-------------|
| `node cli.js start` | Start the bridge (default) |
| `node cli.js register` | Register with PeerTube, save token to config |
| `node cli.js unregister` | Unregister from PeerTube |
| `node cli.js status` | Check PeerTube connectivity |

Options: `-c, --config <path>` (default: `./config.json`), `-v, --version`, `-h, --help`

## Running Workers

Workers join the encoding pool using supernovao on separate machines:

```sh
supernovao join <pool_key>
# encode segment
supernovao send <pool_key>
```

Workers need ffmpeg installed. The bridge does not encode — it orchestrates.

## PeerTube Setup

1. Go to **Administration → System → Runners** in your PeerTube admin panel
2. Enable remote runners
3. Click **Generate registration token**
4. Paste the token into `config.json` under `peertube.registrationToken`

## Architecture

| Module | Role |
|--------|------|
| `lib/runner-client.js` | PeerTube runner REST API client |
| `lib/socket-listener.js` | Socket.IO listener for job notifications |
| `lib/job-translator.js` | Translates PT job payloads to supernovao workflows |
| `lib/pool-manager.js` | Orchestrates supernovao segment/pool/encode pipeline |
| `lib/result-assembler.js` | Validates output and uploads results to PeerTube |
| `lib/health.js` | Job watchdog, health monitoring, graceful shutdown |
| `lib/bridge.js` | Main orchestrator wiring all components together |
| `cli.js` | CLI entry point |

## Supported Job Types

| PeerTube Job Type | Action |
|-------------------|--------|
| `vod-web-video-transcoding` | segment → encode → concat → mux to MP4 |
| `vod-hls-transcoding` | segment → encode → concat → mux to HLS |
| `vod-audio-merge-transcoding` | merge audio + encode → output |

## Limitations

- Live transcoding (`live-rtmp-hls-transcoding`) is not supported
- Requires at least one supernovao worker on the network
- Workers must have ffmpeg installed
- Videos under 2 minutes are rejected by supernovao's segmenter

## License

ISC
