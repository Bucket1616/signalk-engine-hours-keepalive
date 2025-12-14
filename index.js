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
        title: 'Discovery Mode (Check this first!)',
        description: 'If checked: The plugin will populate your settings with found engines but WILL NOT transmit data.',
        default: true
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
    // 2. Auto-Populate Configuration
    // --------------------
    // If the user has NO engines configured, and we found some, let's save them!
    const currentConfig = options.engines || []
    
    if (currentConfig.length === 0 && discovered.length > 0) {
      app.debug(`[${plugin.id}] No manual config found. Found ${discovered.length} engines.`)
      
      // Create the new config object
      const newEngineConfig = discovered.map(d => ({
        path: d.path,
        engineSource: '', // Leave empty so user can fill if needed, or default logic applies
        name: d.path.split('.')[1] || 'Engine' // Try to guess a name like 'port'
      }))

      // Update options locally
      options.engines = newEngineConfig

      app.debug(`[${plugin.id}] Saving discovered engines to plugin configuration...`)
      
      // SAVE TO DISK
      // This will trigger a plugin restart automatically by the server!
      app.savePluginOptions(options, (err) => {
        if (err) {
          app.error(`[${plugin.id}] FAILED to save configuration: ${err.message}`)
          app.setPluginStatus('Error: Could not save discovered engines to config.')
        } else {
          app.debug(`[${plugin.id}] Configuration saved successfully.`)
          app.setPluginStatus(`SUCCESS: Found ${discovered.length} engines and saved them to your settings. Please refresh the settings page to review them.`)
        }
      })

      // We return here. The savePluginOptions will trigger a restart, so we stop execution.
      return
    }

    // --------------------
    // 3. Handle "Discovery Only" Mode
    // --------------------
    if (options.discoverOnly) {
      let statusMsg = `Discovery Mode Active.\n`
      
      if (currentConfig.length === 0) {
        statusMsg += `State: No engines configured and none found currently.`
      } else {
        statusMsg += `Configuration Loaded: ${currentConfig.length} engines.\n`
        statusMsg += `Injection is DISABLED. Uncheck 'Discovery Mode' to begin keepalive.\n`
        statusMsg += `--------------------------------\n`
        statusMsg += `Monitoring the following paths:\n`
        
        currentConfig.forEach(c => {
          statusMsg += ` • ${c.path} `
          if(c.engineSource) statusMsg += `(Source limit: ${c.engineSource})`
          statusMsg += `\n`
        })
      }
      
      app.setPluginStatus(statusMsg)
      app.debug(`[${plugin.id}] ${statusMsg}`)
      return // Stop here
    }

    // --------------------
    // 4. Validate and Start (Real Mode)
    // --------------------
    if (currentConfig.length === 0) {
      app.setPluginStatus('Waiting: No engines configured and none discovered yet.')
      return
    }

    currentConfig.forEach(cfg => {
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
    if (!config.path) return null
    
    const parts = config.path.split('.')
    if (parts.length < 3 || parts[0] !== 'propulsion') {
      app.debug(`[${plugin.id}] Invalid path format: ${config.path}`)
      return null
    }

    const id = parts[1] 

    const engine = {
      config,
      signalkId: id,
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
    app.debug(`[${plugin.id}] Subscribing to engine: ${engine.config.path}`)
    
    // 1. Runtime Subscription
    const stream = app.streambundle.getSelfStream(engine.config.path)
    
    const unsubRuntime = stream.onValue((value) => {
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

      if (['revolutions', 'oilPressure', 'fuelRate'].includes(field)) return

      const fullPath = `${engine.basePath}.${suffix}`
      const unsub = app.streambundle.getSelfStream(fullPath).onValue(val => {
        engine.lastKnown[field] = val
      })
      unsubscribes.push(unsub)
    })

    // Cold Start Check
    if (engine.lastValue !== null && engine.lastValue !== undefined) {
      app.debug(`[${plugin.id}] Initial value found for ${engine.config.path} (${engine.lastValue}). Starting silence timer...`)
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

    if (source && source.label === plugin.id) return
    if (!isRealEngineSource(engine, source)) return

    engine.lastValue = value
    
    if (engine.isInjecting) {
      app.debug(`[${plugin.id}] Real data detected for ${engine.config.path}. Stopping Keepalive.`)
      stopInjection(engine)
    }

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
    const values = []
    values.push({ path: engine.config.path, value: engine.lastValue })

    const fields = options.keepaliveFields || ['revolutions', 'oilPressure', 'fuelRate']
    
    fields.forEach(field => {
      let val = null
      let suffix = ''

      if (field === 'revolutions') { val = 0; suffix = 'revolutions' }
      else if (field === 'oilPressure') { val = 0; suffix = 'oilPressure' }
      else if (field === 'fuelRate') { val = 0; suffix = 'fuel.rate' }
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
          source: { label: plugin.id }, 
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
  // --------------------
  // Discover engines using the Full Tree (to get Source info)
  // --------------------
/*  function discoverEngines() {
    const results = []

    // 1. Try to access the Full Tree (app.signalk.self)
    // This allows us to see the 'source' property which app.getSelfPath hides.
    let rootPropulsion = null
    let isFullTree = false

    if (app.signalk && app.signalk.self && app.signalk.self.propulsion) {
      rootPropulsion = app.signalk.self.propulsion
      isFullTree = true
    } else {
      // Fallback to simplified view (might lose source info)
      rootPropulsion = app.getSelfPath('propulsion')
    }

    if (!rootPropulsion || typeof rootPropulsion !== 'object') {
      app.debug(`[${plugin.id}] No propulsion data found in tree.`)
      return []
    }

    // Iterate Engines (port, starboard, etc.)
    Object.entries(rootPropulsion).forEach(([key, engineObj]) => {
      if (!engineObj || typeof engineObj !== 'object') return

      // Iterate Fields (runTime, etc.)
      Object.entries(engineObj).forEach(([field, node]) => {
        const fieldLower = field.toLowerCase()
        
        if (fieldLower === 'runtime' || fieldLower === 'runhours') {
          const path = `propulsion.${key}.${field}`
          let sourceLabel = 'unknown'

          if (isFullTree && node) {
            // In Full Tree, 'node' is an object: { value: X, source: 'can0', ... }
            const sourceId = node.source
            
            if (sourceId) {
              // Try to resolve the readable Label from the Source ID
              // The sources tree is at app.signalk.sources
              if (app.signalk.sources && app.signalk.sources[sourceId]) {
                 const srcDef = app.signalk.sources[sourceId]
                 // Combine Label + Src (e.g., "N2K" + "8" = "N2K.8") if available
                 if (srcDef.label && srcDef.src) {
                   sourceLabel = `${srcDef.label}.${srcDef.src}`
                 } else if (srcDef.label) {
                   sourceLabel = srcDef.label
                 } else {
                   sourceLabel = sourceId
                 }
              } else {
                sourceLabel = sourceId
              }
            }
          } else {
            // Fallback for simple view (rarely works for source)
            const meta = app.getSelfPath(`${path}.meta`)
            if (meta && meta.source && meta.source.label) {
              sourceLabel = meta.source.label
            }
          }

          results.push({
            path,
            unit: fieldLower === 'runtime' ? 'seconds' : 'hours',
            source: sourceLabel === 'unknown' ? '' : sourceLabel // Clean string for config
          })

          app.debug(`[${plugin.id}] Discovered: ${path} (Source: ${sourceLabel})`)
        }
      })
    })

    return results
  }
*/
  // --------------------
  // DIAGNOSTIC discoverEngines
  // --------------------
  function discoverEngines() {
    app.debug(`[${plugin.id}] --- STARTING DIAGNOSTIC DISCOVERY ---`)

    // 1. Dump the Sources Tree
    // We need to see how sources are defined (labels vs src vs IDs)
    if (app.signalk && app.signalk.sources) {
       app.debug(`[${plugin.id}] DUMP: app.signalk.sources keys: ${Object.keys(app.signalk.sources).join(', ')}`)
       // We log the first source to see its structure
       const firstKey = Object.keys(app.signalk.sources)[0]
       if (firstKey) {
         app.debug(`[${plugin.id}] DUMP: Sample Source (${firstKey}): ${JSON.stringify(app.signalk.sources[firstKey])}`)
       }
    } else {
       app.debug(`[${plugin.id}] ERROR: app.signalk.sources is undefined or empty`)
    }

    // 2. Dump the Propulsion Tree (Full Tree)
    // We need to see if the nodes actually have a .source property
    if (app.signalk && app.signalk.self && app.signalk.self.propulsion) {
       app.debug(`[${plugin.id}] DUMP: app.signalk.self.propulsion structure:`)
       app.debug(JSON.stringify(app.signalk.self.propulsion, null, 2))
    } else {
       app.debug(`[${plugin.id}] ERROR: app.signalk.self.propulsion is undefined`)
    }

    // ------------------------------------------------
    // Original Logic (Wrapped in logging)
    // ------------------------------------------------
    const results = []
    let rootPropulsion = app.signalk?.self?.propulsion

    if (!rootPropulsion) {
      // Fallback
      app.debug(`[${plugin.id}] Falling back to app.getSelfPath`)
      rootPropulsion = app.getSelfPath('propulsion')
    }

    if (!rootPropulsion) return []

    Object.entries(rootPropulsion).forEach(([key, engineObj]) => {
      // key = "port", "starboard"
      if (!engineObj || typeof engineObj !== 'object') return

      Object.entries(engineObj).forEach(([field, node]) => {
        const fieldLower = field.toLowerCase()
        
        if (fieldLower === 'runtime' || fieldLower === 'runhours') {
          const path = `propulsion.${key}.${field}`
          app.debug(`[${plugin.id}] INSPECTING NODE: ${path}`)
          app.debug(`[${plugin.id}] Node Data: ${JSON.stringify(node)}`)

          // Attempt Source Resolution
          let sourceLabel = 'unknown'
          
          // Check if node has .source (Full Tree)
          if (node && node.source) {
            const sourceId = node.source
            app.debug(`[${plugin.id}] -> Found source ID: "${sourceId}"`)
            
            // Look up in sources
            if (app.signalk.sources && app.signalk.sources[sourceId]) {
               const srcDef = app.signalk.sources[sourceId]
               app.debug(`[${plugin.id}] -> Found Source Def: ${JSON.stringify(srcDef)}`)
               
               if (srcDef.label && srcDef.src) {
                 sourceLabel = `${srcDef.label}.${srcDef.src}`
               } else if (srcDef.label) {
                 sourceLabel = srcDef.label
               } else {
                 sourceLabel = sourceId
               }
            } else {
               app.debug(`[${plugin.id}] -> Source ID "${sourceId}" NOT FOUND in app.signalk.sources`)
               sourceLabel = sourceId
            }
          } 
          // Check Metadata (Simplified View fallback)
          else {
             app.debug(`[${plugin.id}] -> No .source property on node. Checking Meta...`)
             const meta = app.getSelfPath(`${path}.meta`)
             app.debug(`[${plugin.id}] -> Meta: ${JSON.stringify(meta)}`)
             if (meta && meta.source && meta.source.label) {
               sourceLabel = meta.source.label
             }
          }

          results.push({
            path,
            unit: fieldLower === 'runtime' ? 'seconds' : 'hours',
            source: sourceLabel === 'unknown' ? '' : sourceLabel
          })
        }
      })
    })

    app.debug(`[${plugin.id}] --- END DIAGNOSTIC ---`)
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
    if (!source) return true 
    if (source.label === plugin.id) return false 
    
    const configured = engine.config.engineSource
    if (!configured) return true
    
    return (source.label === configured || String(source.src) === String(configured))
  }

  return plugin
}
