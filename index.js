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

  // Schema is fine, left out for brevity in review...
  plugin.schema = { /* ... keep your existing schema ... */ }

  plugin.start = function (opts) {
    options = opts || {}
    engines = []
    unsubscribes = []

    app.debug(`[${plugin.id}] Starting...`)

    // 1. Run Discovery (Best effort)
    const discovered = discoverEngines()
    publishDiscovery(discovered)

    if (options.discoverOnly) return

    // 2. Merge Discovery with Config? 
    // Currently you only use Config. If Config is empty, maybe use Discovered?
    let configsToLoad = options.engines || []
    
    // Fallback: If no config exists, try to use discovered engines
    if (configsToLoad.length === 0 && discovered.length > 0) {
      app.debug(`[${plugin.id}] No config found, using discovered engines.`)
      configsToLoad = discovered.map(d => ({ path: d.path }))
    }

    configsToLoad.forEach(cfg => {
      // Validate path before creating
      if (!cfg.path) return
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
    // FIX: Standard BaconJS unsubscribe is just calling the function
    unsubscribes.forEach(unsub => unsub()) 
    engines = []
    unsubscribes = []
    if (discoveryTimer) clearTimeout(discoveryTimer)
  }

  function createEngine(config) {
    // FIX: Logic to extract the ID (e.g., 'port', 'starboard') from 'propulsion.port.runTime'
    const parts = config.path.split('.')
    if (parts.length < 3 || parts[0] !== 'propulsion') {
      app.debug(`[${plugin.id}] Invalid path format: ${config.path}`)
      return null
    }

    // Usually propulsion.<id>.runTime
    const id = parts[1] 

    const engine = {
      config,
      signalkId: id, // FIX: Added this property
      basePath: `propulsion.${id}`, // Helper for building other paths
      lastValue: null,
      lastKnown: {},
      timeout: null,
      interval: null,
      isInjecting: false,
      seenSources: new Map()
    }

    // Try to restore initial value
    const restored = app.getSelfPath(config.path)
    if (typeof restored === 'number') {
      engine.lastValue = restored
    }
    return engine
  }

  function subscribe(engine) {
    // 1. Runtime Subscription
    const stream = app.streambundle.getSelfStream(engine.config.path)
    
    // FIX: Unsubscribe logic
    const unsubRuntime = stream.onValue((value) => {
      // Get the metadata for the *current* value to check source
      // Note: app.getSelfPath(path + '.meta') is safer than meta arg in some SK versions
      const meta = app.getSelfPath(engine.config.path + '.meta')
      handleRuntime(engine, value, meta)
    })
    unsubscribes.push(unsubRuntime)

    // 2. Keepalive Fields Subscription
    const fields = options.keepaliveFields || ['revolutions', 'oilPressure', 'fuelRate']
    
    fields.forEach(field => {
      // skip revolutions/oilPressure as we want to fake those to 0, 
      // but we still might want to subscribe to know they are alive?
      // Actually, we usually only need lastKnown for things like Temp.
      // 0-ing out RPM is handled in emitDelta.
      
      let suffix = ''
      switch (field) {
        case 'revolutions': suffix = 'revolutions'; break
        case 'oilPressure': suffix = 'oilPressure'; break
        case 'oilTemperature': suffix = 'oilTemperature'; break
        case 'temperature': suffix = 'temperature'; break
        case 'fuelRate': suffix = 'fuel.rate'; break
        default: return
      }

      const fullPath = `${engine.basePath}.${suffix}`

      // Store 'last known' for temperatures, but ignore RPM/Press (we force those to 0)
      if (['revolutions', 'oilPressure', 'fuelRate'].includes(field)) return

      const unsub = app.streambundle.getSelfStream(fullPath).onValue(val => {
        engine.lastKnown[field] = val
      })
      unsubscribes.push(unsub)
    })
  }

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

  // ... (Keep your discoverEngines and recordSource helpers, they looked fine) ...

  function isRealEngineSource(engine, source) {
    if (!source) return true // Assume real if no source info (safer)
    if (source.label === plugin.id) return false // Ignore self
    
    const configured = engine.config.engineSource
    if (!configured) return true
    
    return (source.label === configured || String(source.src) === String(configured))
  }

  return plugin
}
