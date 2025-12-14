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
      null: {
        type: 'null',
        title: 'Configure each engine path and engine hours will be persisted on NMEA even with engines off',
      },
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
        title: 'Discovery only - Results Appear on Dashboard (NO KEEPALIVE INJECTION!)',
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
                'Example: propulsion.port.runTime'
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

    if (options.discoverOnly) {
      app.debug('Discovery only mode enabled; no injection will occur')
      return
    }

    const discovered = discoverEngines()
    publishDiscovery(discovered)

    ;(options.engines || []).forEach(cfg => {
      const engine = createEngine(cfg)
      engines.push(engine)
      subscribe(engine)
    })
  app.setPluginStatus('Plugin Started - waiting for engines')
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
      const engine = {
        config,
        lastValue: null,
        timeout: null,
        interval: null,
        isInjecting: false,
        rpmAlive: false
      }
  
      // restore persisted value
      const restored = app.getSelfPath(config.path)
      if (typeof restored === 'number') {
        engine.lastValue = restored
        app.debug(
          `[${plugin.id}] Restored runtime from model for ${config.path}: ${restored}`
        )
      }
    
      subscribeRuntime(engine)
      subscribeRPM(engine)
    
      return engine
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

    app.debug(
      `[${plugin.id}] Runtime received from ${engine.config.path}: ${value}`
    ) 

    if (engine.isInjecting) {
      app.setPluginStatus('Engine active: ${engine.config.path}')
      app.debug(
        `[${plugin.id}] Engine resumed transmitting on ${engine.config.path}, stopping keepalive`
      )
    }
    
    stopInjection(engine)

    engine.timeout = setTimeout(() => {
      app.debug(
        `[${plugin.id}] No runtime seen for ${options.startDelaySeconds}s on ${engine.config.path}`
      )
    
      if (!engine.rpmAlive) {
        app.debug(
          `[${plugin.id}] Engine appears stopped, starting keepalive for ${engine.config.path}`
        )
        startInjection(engine)
      } else {
        app.debug(
          `[${plugin.id}] RPM still active on ${engine.config.path}, suppressing keepalive`
        )
      }
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

    app.debug(
      `[${plugin.id}] Keepalive started for ${engine.config.path} (interval ${options.transmitIntervalSeconds}s)`
    )
  }

  function stopInjection(engine) {
    if (engine.isInjecting) {
      app.debug(
        `[${plugin.id}] Engine started, keepalive stopped for ${engine.config.path}`
      )
    }
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
    app.debug(
    `[${plugin.id}] Emitting synthetic runtime delta for ${engine.config.path}: ${engine.lastValue}`
    )
    
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
    if (!propulsion || typeof propulsion !== 'object') return []
  
    const results = []
  
    Object.entries(propulsion).forEach(([key, obj]) => {
      if (!obj || typeof obj !== 'object') return
  
      Object.entries(obj).forEach(([field, value]) => {
        const fieldLower = field.toLowerCase()
        if (fieldLower === 'runtime' || field === 'runHhours') {
          results.push({
            path: `propulsion.${key}.${field}`,
            unit: fieldLower === 'runtime' ? 'seconds' : 'hours'
          })
        }
      })
    })
    
    results.forEach(e =>
      app.debug(`Discovered runtime path: ${e.path}`)
    )
  
      return results
    }

  function publishDiscovery(list) {
    if (!list.length) {
      app.setPluginStatus(
        'Auto-discovery ran, but no engine runtime paths were found.\n' +
        'Make sure engines have run and runtime data exists.'
      )
      return
    }
  
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
    const lower = path.toLowerCase()
    if (lower.endsWith('runtime')) return 'seconds'
    if (lower.endsWith('runhours')) return 'hours'

    return 'seconds'
  }

  return plugin
}
