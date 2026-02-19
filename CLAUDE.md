# peertube-supernovao

PeerTube remote runner bridge that delegates transcoding jobs to supernovao's distributed encoding pools over Hyperswarm.

## Architecture

```
runner-client.js  ->  job-translator.js  ->  pool-manager.js  ->  result-assembler.js
(PeerTube API)        (payload mapping)      (supernovao pool)    (concat/mux/upload)
```

## Key Dependency

- `supernovao` (`file:../supernovao`) — provides segment, pool, concat, mux, store, metadata, and paths modules

## PeerTube API

- Base URL: configurable via `config.json`, default `http://localhost:9000`
- Protocol: REST + Socket.IO for job notifications

## Rules

- NO testing without permission
- NO commits
- NO builds
