const canboatjs = require('@canboat/canboatjs')

module.exports = function (app) {
  const plugin = {}
  let unsubscribes = []
  let engines = {}
  let options = {}

  plugin.id = 'engine-hours-keepalive'
  plugin.name = 'Engine Hours Keepalive'
  plugin.description = 'Repeats last known engine run hours when engines go silent'

  plugin.schema = {
    type: 'object',
    properties: {
      startDelaySeconds: { type: 'number', default: 120 },
      transmitIntervalSeconds: { type: 'number', default: 30 },
      maxEngines: { type: 'number', default: 10 }
    }
  }

  plugin.start = function (opts) {
    options = opts

    for (let i = 0; i < options.maxEngines; i++) {
      engines[i] = createEngineState(i)
      subscribeToEngine(i)
    }
  }

  plugin.stop = function () {
    unsubscribes.forEach(f => f())
    Object.values(engines).forEach(stopInjection)
  }

  return plugin

  function createEngineState(index) {
    return {
      index,
      lastRunHours: null,
      lastSeen: null,
      isInjecting: false,
      timeout: null,
      interval: null
    }
  }

  function subscribeToEngine(index) {
    const path = 'propulsion.engine.' + index + '.runHours'

    const unsub = app.streambundle
      .getSelfStream(path)
      .onValue(value => handleRunHours(index, value))

    unsubscribes.push(() => unsub.end(true))
  }

  function handleRunHours(index, value) {
    const engine = engines[index]

    engine.lastRunHours = value
    engine.lastSeen = Date.now()

    if (engine.isInjecting) {
      stopInjection(engine)
    }

    if (engine.timeout) {
      clearTimeout(engine.timeout)
    }

    engine.timeout = setTimeout(() => {
      startInjection(engine)
    }, options.startDelaySeconds * 1000)
  }

  function startInjection(engine) {
    if (engine.isInjecting || engine.lastRunHours === null) {
      return
    }

    engine.isInjecting = true

    engine.interval = setInterval(() => {
      sendRunHours(engine.index, engine.lastRunHours)
    }, options.transmitIntervalSeconds * 1000)

    app.debug('Injecting run hours for engine ' + engine.index)
  }

  function stopInjection(engine) {
    if (engine.interval) clearInterval(engine.interval)
    if (engine.timeout) clearTimeout(engine.timeout)

    engine.interval = null
    engine.timeout = null
    engine.isInjecting = false
  }

  function sendRunHours(engineIndex, hours) {
    const pgn = {
      pgn: 127489,
      engineInstance: engineIndex,
      engineHours: hours
    }

    const msg = canboatjs.pgnToActisenseSerialFormat(pgn)
    app.emit('nmea2000out', msg)
  }
}
