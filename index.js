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
      rpmTimeoutSeconds: {
        type: 'number',
        title: 'RPM timeout - delay before switching to keepalive mode (seconds)',
        default: 6
      },
      activeRepeatSeconds: {
        type: 'number',
        title: 'Active repeat interval - when RPM is present (seconds)',
        default: 1
      },
      keepaliveRepeatSeconds: {
        type: 'number',
        title: 'Keepalive repeat interval - when RPM is absent (seconds)',
        default: 3
      },
      discoverOnly: {
        type: 'boolean',
        title: 'Discovery only - Results Appear on the Dashboard and Debug Log(NO KEEPALIVE INJECTION!)',
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

    const discovered = discoverEngines()
    publishDiscovery(discovered)

    if (options.discoverOnly) {
      app.debug('Discovery only mode enabled; no injection will occur')
      return
    }

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
    engines.forEach(stopRepeat)
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
      lastRuntime: null,        // changed from lastValue
      rpmTimeout: null,         // changed from timeout
      repeatInterval: null,     // changed from interval
      isKeepaliveMode: false,   // NEW - tracks which mode we're in
      rpmPresent: false         // changed from rpmAlive
    }
  
     // restore persisted value
    const restored = app.getSelfPath(config.path)
    if (typeof restored === 'number') {
      engine.lastRuntime = restored
      app.debug(
        `[${plugin.id}] Restored runtime from model for ${config.path}: ${restored}`
      )
    }
    
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

    unsubscribes.push(unsubRuntime)

    // RPM corroboration (best-effort)
    const rpmPath = engine.config.path
      .replace(/runtime|runHours$/, 'revolutions')

    const unsubRpm = app.streambundle
      .getSelfStream(rpmPath)
      .onValue(rpm => handleRpm(engine, rpm))  // call handleRpm, not inline

    unsubscribes.push(unsubRpm)
  }

  // ---------------------
  // Handle Incoming RPM Messages
  //----------------------
  function handleRpm(engine, rpm) {
    const wasPresent = engine.rpmPresent
    engine.rpmPresent = typeof rpm === 'number' && rpm > 0
  
    if (engine.rpmPresent) {
      // RPM is active - clear any pending timeout
      if (engine.rpmTimeout) {
        clearTimeout(engine.rpmTimeout)
        engine.rpmTimeout = null
      }
    
      // If we were in keepalive mode, switch back to active mode
      if (engine.isKeepaliveMode) {
        app.debug(`[${plugin.id}] RPM detected on ${engine.config.path}, switching to active mode`)
        switchToActiveMode(engine)
      }
    } else if (wasPresent && !engine.rpmPresent) {
      // RPM just stopped - start timeout
      startRpmTimeout(engine)
    }
  }

  
  // --------------------
  // Runtime handler
  // --------------------
  function handleRuntime(engine, value) {
    if (typeof value !== 'number') return
  
    engine.lastRuntime = value
    app.debug(`[${plugin.id}] Runtime received from ${engine.config.path}: ${value}`)
  
    // Always emit immediately when we receive a new value
    emitDelta(engine)
  
    // Start repeating if not already doing so
    if (!engine.repeatInterval) {
      if (engine.rpmPresent) {
        startActiveMode(engine)
      } else {
        startKeepaliveMode(engine)
      }
    }
  }
  
  function startRpmTimeout(engine) {
    if (engine.rpmTimeout) clearTimeout(engine.rpmTimeout)
  
    engine.rpmTimeout = setTimeout(() => {
      app.debug(`[${plugin.id}] No RPM seen for ${options.rpmTimeoutSeconds}s on ${engine.config.path}, switching to keepalive mode`)
      switchToKeepaliveMode(engine)
    }, options.rpmTimeoutSeconds * 1000)
  }
  
  function startActiveMode(engine) {
    if (engine.repeatInterval) return

    engine.isKeepaliveMode = false
    engine.repeatInterval = setInterval(
      () => emitDelta(engine),
      options.activeRepeatSeconds * 1000
    )
    app.setPluginStatus(`Active mode: ${engine.config.path}`)
   app.debug(`[${plugin.id}] Active repeat started for ${engine.config.path} (${options.activeRepeatSeconds}s interval)`)
  }

  function startKeepaliveMode(engine) {
    if (engine.repeatInterval) return

    engine.isKeepaliveMode = true
    engine.repeatInterval = setInterval(
      () => emitDelta(engine),
      options.keepaliveRepeatSeconds * 1000
    )
    app.setPluginStatus(`Keepalive mode: ${engine.config.path}`)
    app.debug(`[${plugin.id}] Keepalive repeat started for ${engine.config.path} (${options.keepaliveRepeatSeconds}s interval)`)
  }

  function switchToActiveMode(engine) {
    if (engine.repeatInterval) {
      clearInterval(engine.repeatInterval)
     engine.repeatInterval = null
    }
    startActiveMode(engine)
  }

  function switchToKeepaliveMode(engine) {
    if (engine.repeatInterval) {
      clearInterval(engine.repeatInterval)
      engine.repeatInterval = null
    }
    startKeepaliveMode(engine)
  }

  // --------------------
  // Injection control
  // --------------------
  function stopRepeat(engine) {
    if (engine.repeatInterval) {
      clearInterval(engine.repeatInterval)
      engine.repeatInterval = null
    }
    if (engine.rpmTimeout) {
      clearTimeout(engine.rpmTimeout)
      engine.rpmTimeout = null
    }
    engine.isKeepaliveMode = false
  }

  // --------------------
  // Delta emission
  // --------------------
  function emitDelta(engine) {
    app.debug(
      `[${plugin.id}] Emitting runtime delta for ${engine.config.path}: ${engine.lastRuntime}`
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
              value: engine.lastRuntime
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
        if (fieldLower === 'runtime' || field === 'runhours') {
          results.push({
            path: `propulsion.${key}.${field}`,
            unit: fieldLower === 'runtime' ? 'seconds' : 'hours'
          })
        }
      })
    })
    
    results.forEach(e =>
      app.debug(`Engine found: ${e.path} `)
    )
  
      return results
    }

  function publishDiscovery(list) {
    if (!list.length) {
      app.setPluginStatus(
        'Auto-discovery ran, but no engine runtime paths were found. ' +
        'Make sure any engines are on.'
      )
      return
    }
  
    const text =
      'Engine found: ' +
      list.map(e => `• ${e.path} (${e.unit})`).join(', ')
  
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
