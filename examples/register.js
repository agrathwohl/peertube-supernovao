const RunnerClient = require('../lib/runner-client')
const config = require('../config.json')

const client = new RunnerClient(config.peertube)

client.register().then(data => {
  console.log('Registered:', data)
}).catch(err => {
  console.error('Failed:', err.message)
})
