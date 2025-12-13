'use strict'

module.exports = function (app) {
  const plugin = {}
  let options = {}
  let engines = []
  let unsubscribes = []

  plugin.id = 'signalk-engine-hours-keepalive'
  plugin.name = 'Engine Hours Keepalive'
  plugin.description =
    'Re-emits engine hours when engines stop transmitting so downstream devices retain latest hours.'

  // --------------------
  // Plugin schema
  // --------------------
  plugin.schema = {
    type: 'object',
    properties: {
      startDelaySeconds: {
        type: 'number',
        title: 'Silence delay before keepalive starts (seconds)',
        default: 20
      },
      transmitIntervalSeconds: {
        type: 'number',
        title: 'Transmit interval (seconds)',
        default: 3
      },
      discoverOnly: {
        type: 'boolean',
        title: 'Discovery only (do not inject)',
        default: false
      },
      engines: {
        type: 'array',
        title: 'Engines',
        maxItems: 6,
        items: {
          type: 'object',
          required: ['path'],
          properties: {
            name: {
              type: 'string',
              title: 'Engine name (optional)'
            },
            path: {
              type: 'string',
              title: 'Runtime path (Signal K)',
              description:
                'Example: propulsion.engine.port.runtime'
            }
          }
        }
      }
    }
  }

  // --------------------
  // Startup
  // --------------------
  plugin.start = function (opts) {
    options = opts || {}

    const discovered = discoverEngines()
    publishDiscovery(discovered)

    if (options.discoverOnly) {
      app.debug('Discovery-only mode enabled; no injection will occur')
      return
    }

    ;(options.engines || []).forEach(cfg => {
      const engine = createEngine(cfg)
      engines.push(engine)
      subscribe(engine)
    })
  }

  // --------------------
  // Shutdown
  // --------------------
  plugin.stop = function () {
    engines.forEach(stopInjection)
    unsubscribes.forEach(fn => fn())
    engines = []
    unsubscribes = []
  }

  // --------------------
  // Engine object
  // --------------------
  function createEngine(config) {
    const saved = app.getData(`engine.${config.path}`)
    const unit = detectUnit(config.path)

    return {
      config,
      unit,
      lastValue: typeof saved === 'number' ? saved : null,
      lastSeen: null,
      isInjecting: false,
      timeout: null,
      interval: null,
      rpmAlive: false
    }
  }

  // --------------------
  // Subscriptions
  // --------------------
  function subscribe(engine) {
    // Runtime subscription
    const unsubRuntime = app.streambundle
      .getSelfStream(engine.config.path)
      .onValue(value => handleRuntime(engine, value))

    unsubscribes.push(() => unsubRuntime.end(true))

    // RPM corroboration (best-effort)
    const rpmPath = engine.config.path
      .replace(/runtime|runHours$/, 'revolutions')

    const unsubRpm = app.streambundle
      .getSelfStream(rpmPath)
      .onValue(rpm => {
        engine.rpmAlive = typeof rpm === 'number' && rpm > 0
      })

    unsubscribes.push(() => unsubRpm.end(true))
  }

  // --------------------
  // Runtime handler
  // --------------------
  function handleRuntime(engine, value) {
    if (typeof value !== 'number') return

    engine.lastValue = value
    engine.lastSeen = Date.now()
    app.saveData(`engine.${engine.config.path}`, value)

    stopInjection(engine)

    engine.timeout = setTimeout(() => {
      if (!engine.rpmAlive) startInjection(engine)
    }, options.startDelaySeconds * 1000)
  }

  // --------------------
  // Injection control
  // --------------------
  function startInjection(engine) {
    if (engine.isInjecting || engine.lastValue === null) return

    engine.isInjecting = true
    engine.interval = setInterval(
      () => emitDelta(engine),
      options.transmitIntervalSeconds * 1000
    )

    app.debug(`Injecting runtime for ${engine.config.path}`)
  }

  function stopInjection(engine) {
    if (engine.interval) clearInterval(engine.interval)
    if (engine.timeout) clearTimeout(engine.timeout)

    engine.interval = null
    engine.timeout = null
    engine.isInjecting = false
  }

  // --------------------
  // Delta emission
  // --------------------
  function emitDelta(engine) {
    const delta = {
      context: 'vessels.self',
      updates: [
        {
          source: { label: plugin.id },
          timestamp: new Date().toISOString(),
          values: [
            {
              path: engine.config.path,
              value: engine.lastValue
            }
          ]
        }
      ]
    }

    app.handleMessage(plugin.id, delta)
  }

  // --------------------
  // Discovery
  // --------------------
  function discoverEngines() {
    const propulsion = app.getSelfPath('propulsion')
    if (!propulsion || !propulsion.engine) return []

    const results = []

    Object.entries(propulsion.engine).forEach(([key, obj]) => {
      if (!obj) return

      Object.keys(obj).forEach(field => {
        if (field === 'runtime' || field === 'runHours') {
          results.push({
            path: `propulsion.engine.${key}.${field}`,
            unit: field === 'runtime' ? 'seconds' : 'hours'
          })
        }
      })
    })

    return results
  }

  function publishDiscovery(list) {
    if (!list.length) return

    const text =
      'Discovered engine runtime paths:\n' +
      list.map(e => `• ${e.path} (${e.unit})`).join('\n')

    app.setPluginStatus(text)
  }

  // --------------------
  // Unit detection
  // --------------------
  function detectUnit(path) {
    const meta = app.getSelfPath(path + '.meta')
    if (meta && meta.units) {
      if (meta.units.includes('s')) return 'seconds'
      if (meta.units.includes('h')) return 'hours'
    }

    // Fallback heuristics
    if (path.endsWith('runtime')) return 'seconds'
    if (path.endsWith('runHours')) return 'hours'

    return 'seconds'
  }

  return plugin
}
