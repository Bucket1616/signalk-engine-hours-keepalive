'use strict'

module.exports = function (app) {
  const plugin = {}
  let options = {}
  let engines = []
  let unsubscribes = []
  let discoveryTimer = null

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
  
    if (options.discoverOnly) {
      app.debug('Discovery only mode enabled; no injection will occur')
    }
  
    // Create engine objects for all configured paths
    (options.engines || []).forEach(cfg => {
      const engine = createEngine(cfg)
      engines.push(engine)
      subscribe(engine)
    })
  
    app.setPluginStatus('Plugin Started - waiting for engines')
  
    // Report discovered sources after delay
    discoveryTimer = setTimeout(() => {
      if (!engines.length) return
      const text = engines.map(engine => {
        if (!engine.seenSources.size) return null
        const sources = [...engine.seenSources.values()]
          .map(s => s.label || s.src || 'unknown')
          .join(', ')
        return `${engine.config.path}: ${sources}`
      }).filter(Boolean).join('\n')
  
      if (text) {
        app.setPluginStatus('Discovered engine runtime sources:\n' + text)
        app.debug(`[${plugin.id}] Discovery results:\n${text}`)
      } else {
        app.setPluginStatus('No engine runtime sources discovered yet.')
        app.debug('No running engines found.')
      }
    }, 2000) // 2s delay to collect first events
  }

  // --------------------
  // Shutdown
  // --------------------
  plugin.stop = function () {
    engines.forEach(stopInjection)
    unsubscribes.forEach(fn => fn())
    engines = []
    unsubscribes = []

    if (discoveryTimer) {
      clearTimeout(discoveryTimer)
      discoveryTimer = null
    }

  }

  // --------------------
  // Engine object
  // --------------------
  function createEngine(config) {
    const engine = {
      config,
      lastValue: null,
      lastKnown: {},
      timeout: null,
      interval: null,
      isInjecting: false,
      rpmAlive: false,
      seenSources: new Map()
    }

    // restore persisted value
    const restored = app.getSelfPath(config.path)
    if (typeof restored === 'number') {
      engine.lastValue = restored
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
      .onValue((value, meta) => handleRuntime(engine, value, meta));

    unsubscribes.push(() => unsubRuntime.unsubscribe?.() || unsubRuntime.end?.(true));

    // Track last-known values for optional keepalive fields
    (options.keepaliveFields || []).forEach(field => {
      let path;

      switch (field) {
        case 'revolutions':
          path = engine.config.path.replace(/runtime|runHours$/i, 'revolutions');
          break;
        case 'oilPressure':
          path = engine.config.path.replace(/runtime|runHours$/i, 'oilPressure');
          break;
        case 'oilTemperature':
          path = engine.config.path.replace(/runtime|runHours$/i, 'oilTemperature');
          break;
        case 'temperature':
          path = engine.config.path.replace(/runtime|runHours$/i, 'temperature');
          break;
        case 'fuelRate':
          path = engine.config.path.replace(/runtime|runHours$/i, 'fuel.rate');
          break;
        default:
          return;
      }

      const unsub = app.streambundle
        .getSelfStream(path)
        .onValue(val => {
          if (!['revolutions', 'oilPressure', 'fuelRate'].includes(field)) {
            engine.lastKnown[field] = val;
          }
        });

      unsubscribes.push(() => unsub.unsubscribe?.() || unsub.end?.(true));
    });
  }

  // --------------------
  // Runtime handler
  // --------------------
function handleRuntime(engine, value, meta) {
  if (typeof value !== 'number') return

  const source = meta?.source
  recordSource(engine, source)

  if (!isRealEngineSource(engine, source)) {
    app.debug(
      `[${plugin.id}] Ignoring runtime from non-engine source ` +
      `(${source?.label || source?.src || 'unknown'}) on ${engine.config.path}`
    )
    return
  }

  engine.lastValue = value
  engine.lastSeen = Date.now()

  app.debug(
    `[${plugin.id}] Runtime received from REAL engine source ` +
    `(${source?.label || source?.src}): ${value} @ ${engine.config.path}`
  )

  if (engine.isInjecting) {
    app.setPluginStatus(`Engine active: ${engine.config.path}`)
    app.debug(
      `[${plugin.id}] Engine resumed transmitting, stopping keepalive for ${engine.config.path}`
    )
  }

  stopInjection(engine)

  engine.timeout = setTimeout(() => {
    app.debug(
      `[${plugin.id}] No runtime seen for ${options.startDelaySeconds}s on ${engine.config.path}`
    )

    app.debug(
      `[${plugin.id}] Engine appears stopped, starting keepalive for ${engine.config.path}`
    )
    startInjection(engine)
  }, options.startDelaySeconds * 1000)
}


  function recordSource(engine, source) {
    if (!source) return
    const key = source.label || source.src
    if (!engine.seenSources.has(key)) {
      engine.seenSources.set(key, source)
      app.debug(
        `[${plugin.id}] Discovered runtime source for ${engine.config.path}: ` +
        `label=${source.label || 'n/a'}, src=${source.src || 'n/a'}`
      )
    }
  }
  
  function isRealEngineSource(engine, source) {
    if (!source) return false
  
    const configured = engine.config.engineSource
    if (!configured) return true // permissive until configured
  
    return (
      source.label === configured ||
      String(source.src) === String(configured)
    )
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
    );

    const fakeFields = (options.keepaliveFields || []).reduce((acc, field) => {
      if (['revolutions', 'oilPressure', 'fuelRate'].includes(field)) {
        acc[field] = 0; // forced zero to indicate engine off
      } else if (engine.lastKnown[field] !== undefined) {
        acc[field] = engine.lastKnown[field];
      }
      return acc;
    }, {});

    const values = [
      {
        path: engine.config.path,
        value: engine.lastValue
      },
      ...Object.entries(fakeFields).map(([key, val]) => ({
        path: `propulsion.${engine.config.signalkId}.${key}`,
        value: val
      }))
    ];

    const delta = {
      context: 'vessels.self',
      updates: [
        {
          source: { label: plugin.id },
          timestamp: new Date().toISOString(),
          values
        }
      ]
    };

    app.handleMessage(plugin.id, delta);
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
        if (fieldLower === 'runtime' || fieldLower === 'runhours') {
          const path = `propulsion.${key}.${field}`
  
          // Try to get the source from the metadata
          let sourceLabel = 'unknown'
          const meta = app.getSelfPath(path + '.meta')
          if (meta && meta.source && meta.source.label) {
            sourceLabel = meta.source.label
          }
  
          results.push({
            path,
            unit: fieldLower === 'runtime' ? 'seconds' : 'hours',
            source: sourceLabel
          })
  
          // Log both path and source in the same entry
          app.debug(`[${plugin.id}] Discovered engine: ${path}, source: ${sourceLabel}`)
        }
      })
    })
  
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
      list.map(e => `• ${e.path} (${e.unit}), source: ${e.source}`).join('\n')

    app.setPluginStatus(text)
  }

  return plugin
}
