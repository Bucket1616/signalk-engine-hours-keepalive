'use strict'

module.exports = function (app) {
  const plugin = {}
  let options = {}
  let engines = []
  let unsubscribes = []
  let discoveryTimer = null

  plugin.id = 'signalk-engine-hours-keepalive'
  plugin.name = 'Engine Hours Keepalive'
  plugin.description = 'Re-emits engine hours and 0-RPM data when engines stop transmitting.'

  // --------------------
  // Plugin schema
  // --------------------
  plugin.schema = {
    type: 'object',
    properties: {
      startDelaySeconds: {
        type: 'number',
        title: 'Silence delay before keepalive starts (seconds)',
        default: 6
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
      keepaliveFields: {
        type: 'array',
        title: 'Optional fields to include with engine keepalive PGN',
        description:
          'These fields will be faked using 0 or last-known values to ensure N2K PGN emission when engine is off.',
        items: {
          type: 'string',
          enum: ['revolutions', 'oilPressure', 'oilTemperature', 'temperature', 'fuelRate']
        },
        default: ['revolutions', 'oilPressure', 'fuelRate']
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
            },
            engineSource: {
              type: 'string',
              title: 'Engine runtime source (label or src)',
              description:
                'Only runtime updates from this source indicate a real engine. Leave empty to auto-discover.'
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
  
    // Clear engines array and unsubscribes in case of restart
    engines = []
    unsubscribes = []
  
    app.debug(`[${plugin.id}] Plugin starting...`)
  
    // --------------------
    // 1. Run raw discovery
    // --------------------
    const discovered = discoverEngines()
    
    // --------------------
    // 2. Determine Configuration (Manual vs Auto)
    // --------------------
    let configsToMonitor = options.engines || []
    let isAutoConfig = false

    // If no manual config exists, try to use discovered engines
    if (configsToMonitor.length === 0) {
      if (discovered.length > 0) {
        app.debug(`[${plugin.id}] No manual config. Auto-configuring from discovery.`)
        isAutoConfig = true
        configsToMonitor = discovered.map(d => ({
          path: d.path,
          engineSource: '' // Default to loose source matching for auto-config
        }))
      }
    }

    // --------------------
    // 3. Handle "Discovery Only" Mode
    // --------------------
    if (options.discoverOnly) {
      let statusMsg = `Discovery Only Mode Active.\n`
      
      if (configsToMonitor.length === 0) {
        statusMsg += `State: No engines configured and none found via discovery.`
      } else {
        const mode = isAutoConfig ? "AUTO (Discovered)" : "MANUAL (Settings)"
        statusMsg += `Config Source: ${mode}.\n`
        statusMsg += `The following engines WOULD be monitored if this mode was off:\n`
        
        // Show the user exactly what we found
        configsToMonitor.forEach(c => {
          statusMsg += ` • ${c.path} `
          if(c.engineSource) statusMsg += `(Source required: ${c.engineSource})`
          statusMsg += `\n`
        })
      }
      
      // We publish the detailed status so the user can verify
      app.setPluginStatus(statusMsg)
      app.debug(`[${plugin.id}] ${statusMsg}`)
      
      // Stop here - do not create actual engine objects or subscribe
      return 
    }

    // --------------------
    // 4. Validate and Start (Real Mode)
    // --------------------
    if (configsToMonitor.length === 0) {
      app.setPluginStatus('Waiting: No engines configured and none discovered yet.')
      return
    }

    configsToMonitor.forEach(cfg => {
      // Create the engine object (validates path format internally)
      const engine = createEngine(cfg)
      if (engine) {
        engines.push(engine)
        subscribe(engine)
      }
    })
  
    app.setPluginStatus(`Running: Monitoring ${engines.length} engines.`)
  }

  plugin.stop = function () {
    engines.forEach(stopInjection)
    unsubscribes.forEach(unsub => unsub()) 
    engines = []
    unsubscribes = []
    if (discoveryTimer) clearTimeout(discoveryTimer)
  }

  // --------------------
  // Engine object
  // --------------------
  function createEngine(config) {
    // Validate path and extract ID (e.g. 'port', 'starboard')
    // Expected format: propulsion.<id>.runTime
    if (!config.path) return null
    
    const parts = config.path.split('.')
    // Basic validation: must be propulsion.something.something
    if (parts.length < 3 || parts[0] !== 'propulsion') {
      app.debug(`[${plugin.id}] Invalid path format: ${config.path}`)
      return null
    }

    const id = parts[1] // 'port', 'starboard', 'main', etc.

    const engine = {
      config,
      signalkId: id, // <--- CRITICAL for emitDelta
      basePath: `propulsion.${id}`, 
      lastValue: null,
      lastKnown: {},
      timeout: null,
      interval: null,
      isInjecting: false,
      seenSources: new Map()
    }

    // Restore persisted value (Important for Cold Start)
    const restored = app.getSelfPath(config.path)
    if (typeof restored === 'number') {
      engine.lastValue = restored
    }

    return engine
  }

  // --------------------
  // Subscriptions
  // --------------------
  function subscribe(engine) {
    // 1. Runtime Subscription
    const stream = app.streambundle.getSelfStream(engine.config.path)
    
    const unsubRuntime = stream.onValue((value) => {
      // Get the metadata for the *current* value to check source
      const meta = app.getSelfPath(engine.config.path + '.meta')
      handleRuntime(engine, value, meta)
    })
    unsubscribes.push(unsubRuntime)

    // 2. Keepalive Fields Subscription
    const fields = options.keepaliveFields || ['revolutions', 'oilPressure', 'fuelRate']
    
    fields.forEach(field => {
      let suffix = ''
      switch (field) {
        case 'revolutions': suffix = 'revolutions'; break
        case 'oilPressure': suffix = 'oilPressure'; break
        case 'oilTemperature': suffix = 'oilTemperature'; break
        case 'temperature': suffix = 'temperature'; break
        case 'fuelRate': suffix = 'fuel.rate'; break
        default: return
      }

      // We handle these fields differently (forced 0), so we don't need lastKnown values for them
      if (['revolutions', 'oilPressure', 'fuelRate'].includes(field)) return

      const fullPath = `${engine.basePath}.${suffix}`
      const unsub = app.streambundle.getSelfStream(fullPath).onValue(val => {
        engine.lastKnown[field] = val
      })
      unsubscribes.push(unsub)
    })

    // -----------------------------------------------------
    // Cold Start Handling: 
    // If the engine is OFF when the system boots, we have a value (restored) 
    // but no stream updates coming in. We must manually trigger the silence timer.
    // -----------------------------------------------------
    if (engine.lastValue !== null && engine.lastValue !== undefined) {
      app.debug(`[${plugin.id}] Initial value found for ${engine.config.path}. Starting silence timer...`)
      resetSilenceTimer(engine)
    }
  }

  // --------------------
  // Runtime Logic
  // --------------------
  function handleRuntime(engine, value, meta) {
    if (typeof value !== 'number') return

    const source = meta?.source
    recordSource(engine, source)

    // Loop prevention: If the update came from THIS plugin, ignore it.
    if (source && source.label === plugin.id) return
    
    // Check if real source
    if (!isRealEngineSource(engine, source)) return

    engine.lastValue = value
    
    // If we were injecting, stop immediately because the engine is back
    if (engine.isInjecting) {
      app.debug(`[${plugin.id}] Real data detected for ${engine.config.path}. Stopping Keepalive.`)
      stopInjection(engine)
    }

    // Reset the "Silence Detection" timer
    resetSilenceTimer(engine)
  }

  function resetSilenceTimer(engine) {
    if (engine.timeout) clearTimeout(engine.timeout)

    engine.timeout = setTimeout(() => {
      app.debug(`[${plugin.id}] Silence detected on ${engine.config.path}. Starting Keepalive.`)
      startInjection(engine)
    }, options.startDelaySeconds * 1000)
  }

  function startInjection(engine) {
    if (engine.isInjecting || engine.lastValue === null) return
    engine.isInjecting = true
    
    // Send one immediately
    emitDelta(engine)
    
    engine.interval = setInterval(
      () => emitDelta(engine),
      options.transmitIntervalSeconds * 1000
    )
    app.setPluginStatus(`Injecting keepalive for ${engine.signalkId}`)
  }

  function stopInjection(engine) {
    if (engine.interval) clearInterval(engine.interval)
    if (engine.timeout) clearTimeout(engine.timeout)
    engine.interval = null
    engine.timeout = null
    engine.isInjecting = false
    app.setPluginStatus(`Monitoring ${engines.length} engines`)
  }

  function emitDelta(engine) {
    // Prepare fake fields (RPM=0, Pressure=0, Temps=LastKnown)
    const values = []

    // 1. RunTime (The most important one)
    values.push({ path: engine.config.path, value: engine.lastValue })

    // 2. Extra fields
    const fields = options.keepaliveFields || ['revolutions', 'oilPressure', 'fuelRate']
    
    fields.forEach(field => {
      let val = null
      let suffix = ''

      // Force 0 for active properties
      if (field === 'revolutions') { val = 0; suffix = 'revolutions' }
      else if (field === 'oilPressure') { val = 0; suffix = 'oilPressure' }
      else if (field === 'fuelRate') { val = 0; suffix = 'fuel.rate' }
      // Use last known for passive properties (temps)
      else if (engine.lastKnown[field] !== undefined) {
        val = engine.lastKnown[field]
        if (field === 'oilTemperature') suffix = 'oilTemperature'
        if (field === 'temperature') suffix = 'temperature'
      }

      if (val !== null && suffix) {
        values.push({ path: `${engine.basePath}.${suffix}`, value: val })
      }
    })

    const delta = {
      context: 'vessels.self',
      updates: [
        {
          source: { label: plugin.id }, // Important: Identify as this plugin
          timestamp: new Date().toISOString(),
          values: values
        }
      ]
    }

    app.handleMessage(plugin.id, delta)
  }

  // --------------------
  // Helpers
  // --------------------
  function discoverEngines() {
    const propulsion = app.getSelfPath('propulsion')
    if (!propulsion || typeof propulsion !== 'object') {
      app.debug(`[${plugin.id}] No propulsion data found for discovery`)
      return []
    }
  
    const results = []
  
    Object.entries(propulsion).forEach(([key, obj]) => {
      if (!obj || typeof obj !== 'object') return
  
      Object.entries(obj).forEach(([field, value]) => {
        const fieldLower = field.toLowerCase()
        if (fieldLower === 'runtime' || fieldLower === 'runhours') {
          const path = `propulsion.${key}.${field}`
  
          // Try to get the source from metadata
          let sourceLabel = 'unknown'
          const meta = app.getSelfPath(`${path}.meta`)
          if (meta && meta.source && meta.source.label) {
            sourceLabel = meta.source.label
          }
  
          results.push({
            path,
            unit: fieldLower === 'runtime' ? 'seconds' : 'hours',
            source: sourceLabel
          })
  
          app.debug(`[${plugin.id}] Discovered engine: ${path}, source: ${sourceLabel}`)
        }
      })
    })
  
    return results
  }
  
  function recordSource(engine, source) {
    if (!source) return
    const key = source.label || source.src
    if (!engine.seenSources.has(key)) {
      engine.seenSources.set(key, source)
    }
  }
  
  function isRealEngineSource(engine, source) {
    if (!source) return true // Assume real if no source info (safer)
    if (source.label === plugin.id) return false // Ignore self
    
    const configured = engine.config.engineSource
    if (!configured) return true
    
    return (source.label === configured || String(source.src) === String(configured))
  }

  return plugin
}
