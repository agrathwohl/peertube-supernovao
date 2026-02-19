const { io } = require('socket.io-client')
const debug = require('debug')('ptsn:socket-listener')
const logger = require('pino')({ name: 'socket-listener' })

function createSocketListener(peertubeUrl, runnerToken, onJobsAvailable) {
  const socket = io(peertubeUrl, {
    auth: { runnerToken },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30000
  })

  socket.on('connect', () => {
    debug('Socket.IO connected to %s', peertubeUrl)
    logger.info({ url: peertubeUrl }, 'Socket.IO connected')
  })

  socket.on('available-jobs', (data) => {
    debug('available-jobs event received %o', data)
    onJobsAvailable(data)
  })

  socket.on('disconnect', (reason) => {
    debug('Socket.IO disconnected: %s', reason)
    logger.warn({ reason }, 'Socket.IO disconnected')
  })

  socket.on('connect_error', (err) => {
    debug('Socket.IO connection error: %s', err.message)
    logger.warn({ err: err.message }, 'Socket.IO connection error')
  })

  socket.on('reconnect', (attempt) => {
    debug('Socket.IO reconnected after %d attempts', attempt)
    logger.info({ attempt }, 'Socket.IO reconnected')
  })

  return socket
}

module.exports = createSocketListener
